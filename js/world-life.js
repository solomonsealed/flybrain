/* world-life.js -- Reproduction and the life cycle (modeled).
 *
 * FlyWire's brain is female. Both sexes run it; courtship, mating and
 * egg-laying are modeled programs layered on the connectome-driven fly and
 * are labeled as modeled (docs/world-model.md):
 *   - A mature male who sees a female who has not recently mated courts her:
 *     he turns toward her, follows and sings (FlyPolicy 'court').
 *   - A mature, receptive female who hears the song while her connectome
 *     escape and threat outputs are low stands for him (FlyPolicy 'accept').
 *     When he reaches her, the pair copulates for a fixed time.
 *   - Each mating gives exactly cfg.reproduction.offspringPerMating eggs (1:
 *     deliberately unrealistic; a real female lays dozens of eggs a day). A
 *     mated female carries the male pheromone cVA and does not accept again
 *     until her refractory period is over and her eggs are laid.
 *   - A gravid female lays when her head touches fermenting fruit
 *     (FlyPolicy 'oviposit'), as real females choose fermenting fruit. After
 *     carrying her egg for a while (egg urge above layAnyFruitUrge) she lays
 *     on ripe fruit too, as females that retain eggs accept poorer sites.
 *   - Eggs hatch into larvae, larvae pupate beside the fruit, and adults
 *     emerge after compressed durations. A new adult's brain settles during
 *     the end of the pupal stage (world-sim.js), as the founders' brains
 *     settle before t = 0.
 *   - At most cfg.population.max flies exist, counting every stage, so each
 *     egg laid has room to become an adult; a female holds her egg while the
 *     garden is full.
 * All randomness comes from state.rng. step() runs once per body step,
 * after every adult has moved.
 */
(function (root) {
	'use strict';

	var WS = root.WorldState;

	function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

	/* ---------- who can do what ---------- */

	function isMature(state, cfg, rec) {
		return rec.born === null || state.time - rec.born >= cfg.lifecycle.maturation[rec.sex];
	}

	// A mated female carries cVA until her refractory period is over and she
	// has laid her eggs.
	function recentlyMated(state, rec) {
		var rp = rec.repro;
		return rp.matings > 0 && (state.time < rp.receptiveFrom || rp.eggs > 0);
	}

	function isReceptive(state, cfg, rec) {
		return rec.sex === 'female' && isMature(state, cfg, rec) && !recentlyMated(state, rec) && !rec.repro.partner;
	}

	function population(state) { return state.flies.length + state.brood.length; }

	function dist(a, b) { return Math.hypot(a.fly.x - b.fly.x, a.fly.z - b.fly.z); }

	/* ---------- one body step ---------- */

	function step(state, cfg, dt) {
		var rc = cfg.reproduction, flies = state.flies, i;
		var prev = state.current;
		var full = population(state) >= cfg.population.max;
		for (i = 0; i < flies.length; i++) {
			var rec = flies[i], rp = rec.repro, cur = rec.behavior.current;
			rp.layBlocked = rp.eggs > 0 && full;
			if (rec.sex !== 'male') continue;
			var target = rp.courtTarget ? WS.findFly(state, rp.courtTarget) : null;
			rp.singing = cur === 'court' && !!target && dist(rec, target) <= rc.songRange;
			// an accepting female within reach is mounted
			if (cur === 'court' && target && target.behavior.current === 'accept' && !target.repro.partner &&
				rec.fly.mode === 'ground' && target.fly.mode === 'ground' && dist(rec, target) <= rc.mountRange) {
				mount(state, cfg, rec, target);
			}
		}
		for (i = 0; i < flies.length; i++) {
			var f = flies[i];
			if (f.behavior.current === 'copulate' && f.sex === 'female') copulating(state, cfg, f);
			else if (f.behavior.current === 'oviposit' && state.time - f.behavior.enterTime >= rc.ovipositDuration) layEgg(state, cfg, f);
		}
		develop(state, cfg);
		WS.focus(state, prev && flies.indexOf(prev) !== -1 ? prev : flies[0]);
	}

	function enter(state, cfg, rec, next, reason) {
		WS.focus(state, rec);
		FlyPolicy.enter(state, cfg, next, reason);
	}

	function mount(state, cfg, male, female) {
		var until = state.time + cfg.reproduction.copulationDuration;
		male.repro.partner = female.id;
		female.repro.partner = male.id;
		female.repro.copulaUntil = until;
		male.repro.copulaUntil = until;
		enter(state, cfg, male, 'copulate', 'mounted ' + female.id);
		enter(state, cfg, female, 'copulate', 'mounted by ' + male.id);
		WS.logEvent(state, 'mating', { female: female.id, male: male.id }, 'fly');
		ride(male, female);
	}

	// The male rides on the female's back, facing the way she faces.
	function ride(male, female) {
		var m = male.fly, f = female.fly, fwd = WS.forward(f.heading);
		m.x = f.x - fwd.x * 0.12;
		m.z = f.z - fwd.z * 0.12;
		m.y = f.y + 0.14;
		m.heading = f.heading;
		m.speed = 0;
		m.yawRate = 0;
	}

	function copulating(state, cfg, female) {
		var male = WS.findFly(state, female.repro.partner);
		if (!male) { female.repro.partner = null; enter(state, cfg, female, 'idle', 'partner gone'); return; }
		if (state.time < female.repro.copulaUntil) { ride(male, female); return; }
		var rc = cfg.reproduction, fr = female.repro;
		fr.matings++;
		fr.eggs += rc.offspringPerMating;
		fr.sire = male.id;
		fr.receptiveFrom = state.time + rc.femaleRefractory;
		fr.partner = null;
		male.repro.partner = null;
		male.repro.matings++;
		// he slides off behind her, just clear of her body
		var fwd = WS.forward(female.fly.heading), back = 2 * cfg.fly.collisionRadius + 0.05;
		var c = WS.clampToEnclosure(cfg, female.fly.x - fwd.x * back, female.fly.z - fwd.z * back, cfg.fly.collisionRadius + cfg.fly.wallClearance);
		male.fly.x = c.x; male.fly.z = c.z; male.fly.y = 0;
		enter(state, cfg, male, 'idle', 'copulation ended');
		male.behavior.cooldowns.court = state.time + rc.maleRefractory;
		enter(state, cfg, female, 'idle', 'copulation ended');
		WS.logEvent(state, 'mated', { female: female.id, male: male.id, eggs: rc.offspringPerMating }, 'fly');
	}

	/* ---------- eggs ---------- */

	// The fruit at the female's head she would lay on (as FlyPolicy.feedStep
	// finds the fruit she eats): fermenting fruit, or once her egg urge is
	// high enough, any ripe fruit.
	function layingSite(state, cfg, rec) {
		var fly = rec.fly, fwd = WS.forward(fly.heading), best = null;
		var anyFruit = (rec.drives.egg || 0) >= cfg.reproduction.layAnyFruitUrge;
		var hx = fly.x + fwd.x * cfg.fly.headOffset, hz = fly.z + fwd.z * cfg.fly.headOffset;
		for (var i = 0; i < state.fruits.length; i++) {
			var f = state.fruits[i];
			if (!WS.isEdible(f) || (f.stage !== 'fermenting' && !anyFruit)) continue;
			var reach = f.radius * Math.max(0.35, Math.min(1, f.amount)) + cfg.fly.biteRange;
			if (Math.hypot(hx - f.x, hz - f.z) <= reach && (!best || f.stage === 'fermenting')) best = f;
		}
		return best;
	}

	function layEgg(state, cfg, mother) {
		var fruit = layingSite(state, cfg, mother), rp = mother.repro;
		if (!fruit || rp.eggs <= 0 || population(state) >= cfg.population.max) {
			enter(state, cfg, mother, 'idle', fruit ? 'holding her egg: the garden is full' : 'lost the egg-laying site');
			return;
		}
		var fermenting = fruit.stage === 'fermenting';
		// on the fruit's surface, on the side she is standing
		var dx = mother.fly.x - fruit.x, dz = mother.fly.z - fruit.z, dl = Math.hypot(dx, dz) || 1;
		var r = fruit.radius * Math.max(0.35, Math.cbrt(Math.max(0.05, fruit.amount))) * 0.9;
		var egg = {
			id: 'fly-' + (state.nextFlyId++),
			sex: WorldRandom.next(state.rng) < 0.5 ? 'female' : 'male',
			stage: 'egg',
			stageTime: state.time,
			laid: state.time,
			x: fruit.x + dx / dl * r, z: fruit.z + dz / dl * r,
			dirX: dx / dl, dirZ: dz / dl,
			heading: WorldRandom.range(state.rng, -Math.PI, Math.PI),
			fruitId: fruit.id,
			parents: [mother.id, rp.sire],
			adult: null
		};
		state.brood.push(egg);
		rp.eggs--;
		rp.laid++;
		WS.logEvent(state, 'egg-laid', { fly: mother.id, egg: egg.id, fruitId: fruit.id, fermenting: fermenting }, 'fly');
		enter(state, cfg, mother, 'idle', 'egg laid');
	}

	/* ---------- development ---------- */

	function develop(state, cfg) {
		var lc = cfg.lifecycle;
		for (var i = state.brood.length - 1; i >= 0; i--) {
			var e = state.brood[i], age = state.time - e.stageTime;
			if (e.stage === 'egg' && age >= lc.eggDuration) {
				e.stage = 'larva';
				e.stageTime = state.time;
				WS.logEvent(state, 'hatched', { id: e.id }, 'world');
			} else if (e.stage === 'larva' && age >= lc.larvaDuration) {
				pupate(state, cfg, e);
			} else if (e.stage === 'pupa' && age >= lc.pupaDuration) {
				state.brood.splice(i, 1);
				eclose(state, cfg, e);
			}
		}
	}

	// A feeding larva leaves the fruit to pupate on the ground beside it.
	// The adult it will become is created now, so its brain can settle
	// during the end of the pupal stage (world-sim.js).
	function pupate(state, cfg, e) {
		var d = cfg.lifecycle.pupaWander;
		var x = e.x + e.dirX * d, z = e.z + e.dirZ * d;
		var c = WS.clampToEnclosure(cfg, x, z, cfg.fly.collisionRadius + cfg.fly.wallClearance);
		if (WS.groundPointFree(cfg, c.x, c.z, cfg.fly.collisionRadius)) { e.x = c.x; e.z = c.z; }
		e.stage = 'pupa';
		e.stageTime = state.time;
		e.adult = WS.newFly(state, cfg, { id: e.id, sex: e.sex, x: e.x, z: e.z, heading: e.heading, parents: e.parents, born: null });
		WS.logEvent(state, 'pupated', { id: e.id }, 'world');
	}

	function eclose(state, cfg, e) {
		var rec = e.adult || WS.newFly(state, cfg, { id: e.id, sex: e.sex, x: e.x, z: e.z, heading: e.heading, parents: e.parents });
		rec.born = state.time;
		rec.fly.x = e.x; rec.fly.z = e.z; rec.fly.y = 0;
		rec.behavior.enterTime = state.time;
		rec.behavior.phaseTime = state.time;
		state.flies.push(rec);
		WS.logEvent(state, 'eclosed', { fly: rec.id, sex: rec.sex, parents: rec.parents }, 'world');
	}

	// The pupa whose adult brain should be settling now (world-sim.js).
	function settlingPupae(state, cfg) {
		var window = cfg.brain.settleSteps * cfg.clock.neuralDt, out = [];
		for (var i = 0; i < state.brood.length; i++) {
			var e = state.brood[i];
			if (e.stage === 'pupa' && e.adult && state.time - e.stageTime >= cfg.lifecycle.pupaDuration - window) out.push(e);
		}
		return out;
	}

	// Counts for displays: adults by sex and the brood by stage.
	function census(state) {
		var c = { adults: state.flies.length, females: 0, males: 0, eggs: 0, larvae: 0, pupae: 0, total: population(state) };
		state.flies.forEach(function (r) { if (r.sex === 'male') c.males++; else c.females++; });
		state.brood.forEach(function (e) { if (e.stage === 'egg') c.eggs++; else if (e.stage === 'larva') c.larvae++; else c.pupae++; });
		return c;
	}

	// Seconds until a brood item reaches its next stage.
	function timeToNextStage(state, cfg, e) {
		var lc = cfg.lifecycle;
		var d = e.stage === 'egg' ? lc.eggDuration : e.stage === 'larva' ? lc.larvaDuration : lc.pupaDuration;
		return clamp(d - (state.time - e.stageTime), 0, d);
	}

	root.WorldLife = {
		step: step,
		isMature: isMature,
		isReceptive: isReceptive,
		recentlyMated: recentlyMated,
		population: population,
		census: census,
		settlingPupae: settlingPupae,
		timeToNextStage: timeToNextStage,
		layingSite: layingSite
	};
})(typeof window !== 'undefined' ? window : globalThis);
