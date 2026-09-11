/* world-state.js -- Entity state, fruit lifecycle, seeded randomness, and the
 * validated world command API.
 *
 * The state object is plain JSON-serializable data. Every mutation made by a
 * person, the caretaker, or the garden itself goes through applyCommand() or
 * the lifecycle update, and is recorded as a source-tagged event.
 *
 * Randomness: `state.rng` drives everything that affects the simulation.
 * Cosmetic randomness (leaf placement, strand wobble) must use a separate
 * generator created from `state.cosmeticSeed`, so drawing never perturbs a run.
 */
(function (root) {
	'use strict';

	/* ---------- seeded random numbers (mulberry32, serializable) ---------- */

	function createRng(seed) {
		return { s: (seed >>> 0) || 0x9e3779b9 };
	}

	function rngNext(rng) {
		var t = (rng.s = (rng.s + 0x6d2b79f5) >>> 0);
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}

	function rngRange(rng, a, b) {
		return a + (b - a) * rngNext(rng);
	}

	function rngNormal(rng) {
		var u = Math.max(1e-12, rngNext(rng));
		var v = rngNext(rng);
		return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
	}

	var WorldRandom = { create: createRng, next: rngNext, range: rngRange, normal: rngNormal };

	/* ---------- geometry helpers ---------- */

	function normalizeAngle(a) {
		a = a % (2 * Math.PI);
		if (a > Math.PI) a -= 2 * Math.PI;
		if (a < -Math.PI) a += 2 * Math.PI;
		return a;
	}

	function forward(h) { return { x: Math.cos(h), z: -Math.sin(h) }; }
	function left(h) { return { x: -Math.sin(h), z: -Math.cos(h) }; }

	// Bearing of a world vector relative to heading h: positive = to the fly's left.
	function bearing(h, dx, dz) {
		var f = forward(h), l = left(h);
		return Math.atan2(dx * l.x + dz * l.z, dx * f.x + dz * f.z);
	}

	// In-plane axes of a vertical web disk.
	function webFrame(web) {
		var nl = Math.hypot(web.normalX, web.normalZ) || 1;
		var nx = web.normalX / nl, nz = web.normalZ / nl;
		return {
			cx: web.x, cy: web.y, cz: web.z,
			nx: nx, nz: nz,
			// horizontal in-plane axis (perpendicular to the normal)
			ux: -nz, uz: nx
		};
	}

	/* ---------- enclosure ---------- */

	// Clamp a point into the rounded-rectangle interior inset by `margin`.
	// Returns {x, z, hit, nx, nz} where n is the inward push direction.
	function clampToEnclosure(cfg, x, z, margin) {
		var b = cfg.bounds;
		var r = cfg.enclosure.cornerRadius;
		var xMin = b.xMin + margin, xMax = b.xMax - margin;
		var zMin = b.zMin + margin, zMax = b.zMax - margin;
		var cr = Math.max(0, r - margin);
		var hit = false, nx = 0, nz = 0;
		var cx = Math.min(Math.max(x, xMin + cr), xMax - cr);
		var cz = Math.min(Math.max(z, zMin + cr), zMax - cr);
		var dx = x - cx, dz = z - cz;
		var inCornerX = x < xMin + cr || x > xMax - cr;
		var inCornerZ = z < zMin + cr || z > zMax - cr;
		if (inCornerX && inCornerZ && cr > 0) {
			var d = Math.hypot(dx, dz);
			if (d > cr) {
				x = cx + dx / d * cr;
				z = cz + dz / d * cr;
				hit = true;
				nx = -dx / d; nz = -dz / d;
			}
		} else {
			if (x < xMin) { x = xMin; hit = true; nx = 1; }
			else if (x > xMax) { x = xMax; hit = true; nx = -1; }
			if (z < zMin) { z = zMin; hit = true; nz = 1; }
			else if (z > zMax) { z = zMax; hit = true; nz = -1; }
		}
		return { x: x, z: z, hit: hit, nx: nx, nz: nz };
	}

	function insideEnclosure(cfg, x, z, margin) {
		var c = clampToEnclosure(cfg, x, z, margin);
		return !c.hit;
	}

	// True if a ground point is free of trunks, stones and trellis panels.
	function groundPointFree(cfg, x, z, clearance) {
		var i;
		for (i = 0; i < cfg.trees.length; i++) {
			var t = cfg.trees[i];
			if (Math.hypot(x - t.x, z - t.z) < t.trunkRadius + clearance) return false;
		}
		for (i = 0; i < cfg.stones.length; i++) {
			var s = cfg.stones[i];
			if (Math.hypot(x - s.x, z - s.z) < s.radius + clearance) return false;
		}
		for (i = 0; i < cfg.trellis.length; i++) {
			var p = cfg.trellis[i];
			if (pointSegmentDistance(x, z, p.x1, p.z1, p.x2, p.z2) < 0.3 + clearance) return false;
		}
		return true;
	}

	function pointSegmentDistance(px, pz, ax, az, bx, bz) {
		var vx = bx - ax, vz = bz - az;
		var len2 = vx * vx + vz * vz;
		var t = len2 > 0 ? ((px - ax) * vx + (pz - az) * vz) / len2 : 0;
		t = Math.max(0, Math.min(1, t));
		return Math.hypot(px - (ax + t * vx), pz - (az + t * vz));
	}

	/* ---------- state creation ---------- */

	function create(cfg, seed, options) {
		options = options || {};
		seed = (seed === undefined ? 1 : seed) >>> 0;
		var drives = {};
		var initDrives = options.drives || cfg.initialDrives;
		for (var k in cfg.initialDrives) drives[k] = initDrives[k] !== undefined ? initDrives[k] : cfg.initialDrives[k];

		var start = options.start || cfg.fly.start;
		var state = {
			configVersion: cfg.version,
			coordinateVersion: cfg.coordinateVersion,
			seed: seed,
			cosmeticSeed: (seed * 2654435761) >>> 0,
			rng: createRng(seed),
			time: 0,
			bodyStep: 0,
			neuralStep: 0,
			nextId: 1,
			fly: {
				x: start.x, y: 0, z: start.z,
				heading: start.heading,
				speed: 0, yawRate: 0, vy: 0,
				mode: 'ground',
				airTime: 0,
				snag: null,
				lastWallContact: -1
			},
			fruits: [],
			webs: [],
			env: {
				lightLevel: 1,
				temperature: 0.5,
				breeze: normalizedBreeze(cfg.breeze),
				gust: null
			},
			drives: drives,
			behavior: {
				current: 'idle',
				enterTime: 0,
				cooldowns: {},
				phase: 'none',
				phaseTime: 0,
				groomLocation: null,
				escapeSign: 0,
				flightEnd: 0
			},
			// Contact pulses latched by physics/commands until the next neural
			// step encodes them, so short contacts survive worker scheduling.
			pending: { touchL: 0, touchR: 0, silkL: 0, silkR: 0, touchLocation: null, nociception: false },
			intake: { total: 0, nutrition: 0, lastFruitId: null },
			events: [],
			eventSeq: 0,
			silenced: { foodInput: false, threatInput: false, motorOutput: false }
		};

		if (options.webs !== false) {
			for (var w = 0; w < cfg.webs.length; w++) {
				var def = cfg.webs[w];
				if (options.omitWebs && options.omitWebs.indexOf(def.id) !== -1) continue;
				addWeb(state, cfg, def, 'garden');
			}
		}
		if (options.fruit !== false) {
			for (var f = 0; f < cfg.initialFruit.length; f++) {
				var fd = cfg.initialFruit[f];
				if (options.fruitTrees && options.fruitTrees.indexOf(fd.tree) === -1) continue;
				addFruit(state, cfg, { species: fd.tree, tree: fd.tree, x: fd.x, z: fd.z, stage: fd.stage }, 'garden');
			}
		}
		if (options.fruit === false || options.canopyFruit === false) {
			// no replenishment in controlled scenarios
			for (var tj = 0; tj < cfg.trees.length; tj++) state.env['spawn-' + cfg.trees[tj].id] = 1e12;
		} else {
			for (var ti = 0; ti < cfg.trees.length; ti++) {
				var tree = cfg.trees[ti];
				var n = cfg.initialCanopyFruit[tree.id] || 0;
				for (var c = 0; c < n; c++) spawnCanopyFruit(state, cfg, tree, rngRange(state.rng, 0.1, 0.7));
			}
		}
		logEvent(state, 'run-start', { seed: seed }, 'world');
		return state;
	}

	function normalizedBreeze(b) {
		var l = Math.hypot(b.fromX, b.fromZ) || 1;
		// wind travels away from its source
		return { x: -b.fromX / l, z: -b.fromZ / l, speed: b.speed };
	}

	/* ---------- events ---------- */

	var MAX_EVENTS = 300;

	function logEvent(state, type, data, source) {
		var ev = { seq: ++state.eventSeq, t: state.time, step: state.bodyStep, type: type, source: source || 'world', data: data || {} };
		state.events.push(ev);
		if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
		return ev;
	}

	/* ---------- fruit ---------- */

	var EDIBLE = { fallen: true, fermenting: true };

	function isEdible(fruit) {
		return EDIBLE[fruit.stage] === true && fruit.amount > 0.001;
	}

	function speciesOf(cfg, fruit) {
		return cfg.species[fruit.species] || cfg.species.user;
	}

	function addFruit(state, cfg, opts, source) {
		var sp = cfg.species[opts.species] || cfg.species.user;
		var fruit = {
			id: 'fruit-' + (state.nextId++),
			species: opts.species || 'user',
			tree: opts.tree || null,
			stage: opts.stage || 'fallen',
			x: opts.x, y: opts.y || 0, z: opts.z,
			radius: sp.radius,
			ripeness: opts.stage === 'attached' ? (opts.ripeness || 0) : 1,
			amount: opts.amount !== undefined ? opts.amount : 1,
			stageTime: state.time,
			source: source || 'world',
			eatenBy: 0
		};
		state.fruits.push(fruit);
		return fruit;
	}

	function spawnCanopyFruit(state, cfg, tree, ripeness) {
		var a = rngRange(state.rng, 0, Math.PI * 2);
		var r = rngRange(state.rng, 0.3, 0.8) * tree.canopyRadius;
		return addFruit(state, cfg, {
			species: tree.species, tree: tree.id, stage: 'attached', ripeness: ripeness,
			x: tree.x + Math.cos(a) * r,
			y: tree.canopyY + rngRange(state.rng, -3, 2),
			z: tree.z + Math.sin(a) * r
		}, 'world');
	}

	function fruitOdor(cfg, fruit) {
		var sp = speciesOf(cfg, fruit);
		if (fruit.stage === 'attached') return cfg.fruit.unripeOdor * fruit.ripeness;
		if (fruit.stage === 'depleted') return 0;
		var base = fruit.stage === 'fermenting' ? sp.odorFerment : sp.odorRipe;
		// Exposed flesh emits; a nearly eaten fruit smells less.
		return base * (0.25 + 0.75 * Math.min(1, fruit.amount));
	}

	function fruitSugar(cfg, fruit) {
		if (!isEdible(fruit)) return 0;
		var sp = speciesOf(cfg, fruit);
		return sp.sugar * (fruit.stage === 'fermenting' ? 0.85 : 1);
	}

	function treeById(cfg, id) {
		for (var i = 0; i < cfg.trees.length; i++) if (cfg.trees[i].id === id) return cfg.trees[i];
		return null;
	}

	function countFruit(state, pred) {
		var n = 0;
		for (var i = 0; i < state.fruits.length; i++) if (pred(state.fruits[i])) n++;
		return n;
	}

	// Advances ripening, falling, fermentation, decay, removal and slow,
	// capped replenishment. All randomness comes from state.rng.
	function updateFruit(state, cfg, dt) {
		var fc = cfg.fruit;
		for (var i = state.fruits.length - 1; i >= 0; i--) {
			var f = state.fruits[i];
			if (f.stage === 'attached') {
				f.ripeness = Math.min(1, f.ripeness + fc.ripenRate * dt);
				var groundCount = countFruit(state, function (q) { return q.stage !== 'attached'; });
				if (f.ripeness >= 1 && groundCount < fc.maxGroundFruit) {
					var tree = treeById(cfg, f.tree);
					var drop = findDropPoint(state, cfg, tree);
					if (drop) {
						f.stage = 'fallen';
						f.x = drop.x; f.z = drop.z; f.y = 0;
						f.stageTime = state.time;
						logEvent(state, 'fruit-fell', { id: f.id, species: f.species, x: f.x, z: f.z }, 'world');
					}
				}
			} else if (f.stage === 'fallen') {
				if (state.time - f.stageTime >= fc.fermentDelay) {
					f.stage = 'fermenting';
					f.stageTime = state.time;
					logEvent(state, 'fruit-fermenting', { id: f.id }, 'world');
				}
			} else if (f.stage === 'fermenting') {
				f.amount = Math.max(0, f.amount - fc.decayRate * dt);
			}
			if ((f.stage === 'fallen' || f.stage === 'fermenting') && f.amount <= 0.001) {
				f.stage = 'depleted';
				f.amount = 0;
				f.stageTime = state.time;
				logEvent(state, 'fruit-depleted', { id: f.id }, 'world');
			}
			if (f.stage === 'depleted' && state.time - f.stageTime >= fc.depletedFade) {
				state.fruits.splice(i, 1);
			}
		}
		// Replenishment: each tree regrows canopy fruit slowly, capped.
		for (var t = 0; t < cfg.trees.length; t++) {
			var tr = cfg.trees[t];
			var key = 'spawn-' + tr.id;
			if (state.env[key] === undefined) state.env[key] = state.time + tr.fruitSpawnInterval * rngRange(state.rng, 0.5, 1.0);
			if (state.time >= state.env[key]) {
				state.env[key] = state.time + tr.fruitSpawnInterval * rngRange(state.rng, 0.8, 1.3);
				var onTree = countFruit(state, function (q) { return q.tree === tr.id && q.stage === 'attached'; });
				if (onTree < tr.canopyFruitCap && state.fruits.length < fc.maxFruit) {
					spawnCanopyFruit(state, cfg, tr, 0);
				}
			}
		}
	}

	function findDropPoint(state, cfg, tree) {
		if (!tree) return null;
		for (var attempt = 0; attempt < 12; attempt++) {
			var a = rngRange(state.rng, 0, Math.PI * 2);
			var r = tree.trunkRadius + 1.2 + rngRange(state.rng, 0, tree.dropRadius);
			var x = tree.x + Math.cos(a) * r, z = tree.z + Math.sin(a) * r;
			if (insideEnclosure(cfg, x, z, 1.5) && groundPointFree(cfg, x, z, 1.0)) return { x: x, z: z };
		}
		return null;
	}

	/* ---------- webs ---------- */

	function addWeb(state, cfg, def, source) {
		var web = {
			id: def.id || ('web-' + (state.nextId++)),
			label: def.label || 'Web',
			x: def.x, y: def.y, z: def.z,
			normalX: def.normalX, normalZ: def.normalZ,
			radius: def.radius, contrast: def.contrast,
			spokes: def.spokes || 14, spiralTurns: def.spiralTurns || 9,
			motion: def.motion !== undefined ? def.motion : 0.5,
			spider: !!def.spider,
			source: source || 'world',
			contacts: 0,
			lastContact: -1,
			sensed: 0
		};
		state.webs.push(web);
		return web;
	}

	/* ---------- command API ---------- */

	// Commands: { type, params, source } where source is 'user', 'caretaker',
	// 'experiment' or 'world'. Coordinates are world BL (coordinateVersion
	// world-bl-v1). Returns { ok, error?, id? }.
	function applyCommand(state, cfg, cmd) {
		var p = cmd.params || {};
		var source = cmd.source || 'user';
		var margin = 1.2;
		switch (cmd.type) {
		case 'placeFruit': {
			if (!isFinite(p.x) || !isFinite(p.z)) return fail('placeFruit needs numeric x and z');
			var c = clampToEnclosure(cfg, p.x, p.z, margin);
			if (!groundPointFree(cfg, c.x, c.z, 0.8)) return fail('that spot is inside an obstacle');
			var ground = countFruit(state, function (q) { return q.stage !== 'attached'; });
			if (ground >= cfg.fruit.maxGroundFruit || state.fruits.length >= cfg.fruit.maxFruit) return fail('fruit limit reached');
			var fr = addFruit(state, cfg, { species: p.species && cfg.species[p.species] ? p.species : 'user', x: c.x, z: c.z, stage: 'fallen' }, source);
			logEvent(state, 'fruit-placed', { id: fr.id, x: fr.x, z: fr.z, species: fr.species }, source);
			return { ok: true, id: fr.id };
		}
		case 'moveFruit': {
			var mf = findById(state.fruits, p.id);
			if (!mf || mf.stage === 'attached') return fail('no such ground fruit');
			var mc = clampToEnclosure(cfg, p.x, p.z, margin);
			if (!groundPointFree(cfg, mc.x, mc.z, 0.8)) return fail('that spot is inside an obstacle');
			mf.x = mc.x; mf.z = mc.z;
			logEvent(state, 'fruit-moved', { id: mf.id, x: mf.x, z: mf.z }, source);
			return { ok: true, id: mf.id };
		}
		case 'removeFruit': {
			var idx = indexById(state.fruits, p.id);
			if (idx < 0) return fail('no such fruit');
			state.fruits.splice(idx, 1);
			logEvent(state, 'fruit-removed', { id: p.id }, source);
			return { ok: true };
		}
		case 'clearFruit': {
			var before = state.fruits.length;
			state.fruits = state.fruits.filter(function (q) { return q.stage === 'attached'; });
			logEvent(state, 'fruit-cleared', { removed: before - state.fruits.length }, source);
			return { ok: true };
		}
		case 'placeWeb': {
			if (!isFinite(p.x) || !isFinite(p.z)) return fail('placeWeb needs numeric x and z');
			if (state.webs.length >= 4) return fail('web limit reached');
			var wc = clampToEnclosure(cfg, p.x, p.z, 5);
			var fly = state.fly;
			if (Math.hypot(wc.x - fly.x, wc.z - fly.z) < 5) return fail('too close to the fly');
			var h = isFinite(p.heading) ? p.heading : Math.atan2(-(fly.z - wc.z), fly.x - wc.x);
			var web = addWeb(state, cfg, {
				label: 'Placed web', x: wc.x, y: 3.0, z: wc.z,
				normalX: Math.cos(h), normalZ: -Math.sin(h),
				radius: p.radius || 4.0, contrast: p.contrast || 0.8, spokes: 14, spiralTurns: 9, motion: 0.5
			}, source);
			logEvent(state, 'web-placed', { id: web.id, x: web.x, z: web.z }, source);
			return { ok: true, id: web.id };
		}
		case 'removeWeb': {
			var wi = indexById(state.webs, p.id);
			if (wi < 0) return fail('no such web');
			if (state.fly.snag && state.fly.snag.webId === p.id) state.fly.snag = null;
			state.webs.splice(wi, 1);
			logEvent(state, 'web-removed', { id: p.id }, source);
			return { ok: true };
		}
		case 'setLight': {
			var lvl = Number(p.level);
			if (!isFinite(lvl)) return fail('setLight needs a level');
			state.env.lightLevel = Math.max(0, Math.min(1, lvl));
			logEvent(state, 'light', { level: state.env.lightLevel }, source);
			return { ok: true };
		}
		case 'setTemperature': {
			var tv = Number(p.level);
			if (!isFinite(tv)) return fail('setTemperature needs a level');
			state.env.temperature = Math.max(0, Math.min(1, tv));
			logEvent(state, 'temperature', { level: state.env.temperature }, source);
			return { ok: true };
		}
		case 'wind': {
			// Gust travelling along (dirX, dirZ) for `duration` seconds.
			var gl = Math.hypot(p.dirX, p.dirZ);
			if (!(gl > 0)) return fail('wind needs a direction');
			state.env.gust = {
				x: p.dirX / gl, z: p.dirZ / gl,
				strength: Math.max(0, Math.min(1, p.strength === undefined ? 0.5 : p.strength)),
				until: state.time + (p.duration || 2),
				source: source
			};
			logEvent(state, 'wind', { strength: state.env.gust.strength, dirX: state.env.gust.x, dirZ: state.env.gust.z }, source);
			return { ok: true };
		}
		case 'setBreeze': {
			state.env.breeze = normalizedBreeze({ fromX: p.fromX, fromZ: p.fromZ, speed: p.speed === undefined ? state.env.breeze.speed : p.speed });
			logEvent(state, 'breeze', { fromX: p.fromX, fromZ: p.fromZ, speed: state.env.breeze.speed }, source);
			return { ok: true };
		}
		case 'touch': {
			// location: head | thorax | abdomen | leg; side: 'left' | 'right' | 'both'
			var loc = p.location || 'thorax';
			var side = p.side || 'both';
			var amt = 1;
			// onset pulse plus a short sustained touch (legacy tool held ~2 s)
			if (side !== 'right') { state.pending.touchL = Math.max(state.pending.touchL, amt); state.pending.touchUntilL = state.time + 1.0; }
			if (side !== 'left') { state.pending.touchR = Math.max(state.pending.touchR, amt); state.pending.touchUntilR = state.time + 1.0; }
			state.pending.touchLocation = loc;
			state.pending.lastTouchLocation = loc;
			var recent = state.pending.touchTimes || [];
			recent = recent.filter(function (t) { return state.time - t < 4; });
			recent.push(state.time);
			if (recent.length >= 3) { state.pending.nociception = true; recent = []; }
			state.pending.touchTimes = recent;
			logEvent(state, 'touch', { location: loc, side: side }, source);
			return { ok: true };
		}
		case 'setDrive': {
			if (!(p.name in state.drives)) return fail('unknown drive');
			state.drives[p.name] = Math.max(0, Math.min(1, Number(p.value) || 0));
			logEvent(state, 'drive-set', { name: p.name, value: state.drives[p.name] }, source);
			return { ok: true };
		}
		case 'silence': {
			if (!(p.channel in state.silenced)) return fail('unknown channel');
			state.silenced[p.channel] = !!p.on;
			logEvent(state, 'silence', { channel: p.channel, on: !!p.on }, source);
			return { ok: true };
		}
		default:
			return fail('unknown command ' + cmd.type);
		}
	}

	function fail(msg) { return { ok: false, error: msg }; }

	function findById(list, id) {
		for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
		return null;
	}

	function indexById(list, id) {
		for (var i = 0; i < list.length; i++) if (list[i].id === id) return i;
		return -1;
	}

	/* ---------- serialization ---------- */

	function serialize(state) {
		return JSON.stringify(state);
	}

	function deserialize(json) {
		return typeof json === 'string' ? JSON.parse(json) : JSON.parse(JSON.stringify(json));
	}

	function clone(state) {
		return JSON.parse(JSON.stringify(state));
	}

	// Food the fly can actually reach and eat (for diagnostics and caretaker).
	function availableFood(state) {
		return state.fruits.filter(isEdible);
	}

	root.WorldRandom = WorldRandom;
	root.WorldState = {
		create: create,
		applyCommand: applyCommand,
		updateFruit: updateFruit,
		logEvent: logEvent,
		isEdible: isEdible,
		fruitOdor: fruitOdor,
		fruitSugar: fruitSugar,
		availableFood: availableFood,
		findById: findById,
		webFrame: webFrame,
		clampToEnclosure: clampToEnclosure,
		insideEnclosure: insideEnclosure,
		groundPointFree: groundPointFree,
		pointSegmentDistance: pointSegmentDistance,
		normalizeAngle: normalizeAngle,
		forward: forward,
		left: left,
		bearing: bearing,
		serialize: serialize,
		deserialize: deserialize,
		clone: clone
	};
})(typeof window !== 'undefined' ? window : globalThis);
