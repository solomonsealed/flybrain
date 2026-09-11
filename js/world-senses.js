/* world-senses.js -- Local sensory samples taken at the fly's body.
 *
 * Everything the brain receives about the garden is computed here from the
 * fly's own position, heading and contacts:
 *   odor    two antenna samples of a summed, wind-stretched odor field
 *   taste   sugar only while the head touches exposed edible fruit
 *   threat  a visual web cue per eye (apparent size, expansion, contrast,
 *           line of sight) -- an explicit design assumption, see docs
 *   touch   latched contact pulses (silk, walls, the Touch tool)
 *   wind    per-antenna deflection from breeze and gusts
 *   light   local illumination per eye
 *   social  other flies (modeled cues for courtship; they do not reach the
 *           connectome): a male sees females, a female hears a male's song
 * No destination, fruit coordinate or area label is exported to the brain.
 */
(function (root) {
	'use strict';

	var WS = root.WorldState;

	function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
	function smoothstep(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

	/* ---------- wind ---------- */

	// Air velocity (BL/s) at the fly: slow enclosure breeze plus user gusts.
	function windAt(state) {
		var b = state.env.breeze;
		var vx = b.x * b.speed, vz = b.z * b.speed;
		var g = state.env.gust;
		if (g && state.time < g.until) {
			vx += g.x * g.strength * 1.5;
			vz += g.z * g.strength * 1.5;
		}
		return { x: vx, z: vz, speed: Math.hypot(vx, vz) };
	}

	/* ---------- odor ---------- */

	// Approximation: each exposed fruit is a steady point source whose
	// contribution decays exponentially with an effective distance that is
	// stretched downwind and compressed upwind. There is no fluid simulation,
	// no plume intermittency and no occlusion (odor flows around obstacles).
	function odorAt(state, cfg, px, py, pz, wind) {
		var oc = cfg.odor;
		var L = oc.lengthScale;
		var ws = wind.speed;
		var wx = ws > 1e-6 ? wind.x / ws : 0, wz = ws > 1e-6 ? wind.z / ws : 0;
		var wf = clamp(ws / 0.35, 0, 2.5);
		var down = 1 + (oc.downwindStretch - 1) * wf;
		var up = 1 + (oc.upwindCompress - 1) * wf;
		var total = 0;
		for (var i = 0; i < state.fruits.length; i++) {
			var f = state.fruits[i];
			var e = WS.fruitOdor(cfg, f);
			if (e <= 0) continue;
			var dx = px - f.x, dz = pz - f.z, dy = py - f.y;
			var along = dx * wx + dz * wz;
			var cross2 = dx * dx + dz * dz - along * along;
			var a = along > 0 ? along / down : along * up;
			var d = Math.sqrt(a * a + Math.max(0, cross2) + dy * dy);
			total += e * Math.exp(-d / L);
		}
		return total;
	}

	/* ---------- line of sight ---------- */

	// Transmission (0..1) along the segment E->T through trunks, stones,
	// trellis lattice, vine foliage and canopies.
	function transmission(cfg, ex, ey, ez, tx, ty, tz) {
		var tr = 1;
		var dx = tx - ex, dz = tz - ez, dy = ty - ey;
		var len2 = dx * dx + dz * dz;
		var i;
		// vertical cylinders
		var cyl = [];
		for (i = 0; i < cfg.trees.length; i++) cyl.push([cfg.trees[i].x, cfg.trees[i].z, cfg.trees[i].trunkRadius, cfg.trees[i].trunkHeight]);
		for (i = 0; i < cfg.stones.length; i++) cyl.push([cfg.stones[i].x, cfg.stones[i].z, cfg.stones[i].radius, cfg.stones[i].height]);
		for (i = 0; i < cyl.length; i++) {
			var c = cyl[i];
			if (len2 < 1e-9) break;
			var t = ((c[0] - ex) * dx + (c[1] - ez) * dz) / len2;
			if (t <= 0 || t >= 1) continue;
			var qx = ex + t * dx, qz = ez + t * dz;
			if (Math.hypot(qx - c[0], qz - c[1]) < c[2] && ey + t * dy < c[3]) return 0;
		}
		// trellis panels (lattice passes some light)
		for (i = 0; i < cfg.trellis.length; i++) {
			var p = cfg.trellis[i];
			var s = segmentIntersect(ex, ez, tx, tz, p.x1, p.z1, p.x2, p.z2);
			if (s >= 0 && ey + s * dy < p.height) tr *= p.transmission;
		}
		// foliage ellipsoids
		for (i = 0; i < cfg.foliage.length; i++) {
			var fo = cfg.foliage[i];
			if (rayHitsEllipsoid(ex, ey, ez, dx, dy, dz, fo)) tr *= (1 - fo.opacity);
		}
		// canopies
		for (i = 0; i < cfg.trees.length; i++) {
			var tree = cfg.trees[i];
			var cano = { x: tree.x, y: tree.canopyY, z: tree.z, rx: tree.canopyRadius * 0.8, ry: tree.canopyRadius * 0.45, rz: tree.canopyRadius * 0.8 };
			if (rayHitsEllipsoid(ex, ey, ez, dx, dy, dz, cano)) tr *= 0.35;
		}
		return tr;
	}

	// Parameter s in [0,1] along A->B where it crosses segment C->D, or -1.
	function segmentIntersect(ax, az, bx, bz, cx, cz, dx, dz) {
		var rX = bx - ax, rZ = bz - az, sX = dx - cx, sZ = dz - cz;
		var den = rX * sZ - rZ * sX;
		if (Math.abs(den) < 1e-12) return -1;
		var t = ((cx - ax) * sZ - (cz - az) * sX) / den;
		var u = ((cx - ax) * rZ - (cz - az) * rX) / den;
		return (t > 0 && t < 1 && u >= 0 && u <= 1) ? t : -1;
	}

	function rayHitsEllipsoid(ex, ey, ez, dx, dy, dz, e) {
		// scale into the unit sphere frame; segment parameter in (0,1)
		var ox = (ex - e.x) / e.rx, oy = (ey - e.y) / e.ry, oz = (ez - e.z) / e.rz;
		var vx = dx / e.rx, vy = dy / e.ry, vz = dz / e.rz;
		var a = vx * vx + vy * vy + vz * vz;
		var b = 2 * (ox * vx + oy * vy + oz * vz);
		var c = ox * ox + oy * oy + oz * oz - 1;
		var disc = b * b - 4 * a * c;
		if (disc <= 0 || a < 1e-12) return false;
		var sq = Math.sqrt(disc);
		var t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a);
		return t2 > 0 && t1 < 1;
	}

	/* ---------- light ---------- */

	function localLightFactor(cfg, x, z) {
		var factor = 1;
		for (var i = 0; i < cfg.shade.length; i++) {
			var s = cfg.shade[i];
			var d = Math.hypot(x - s.x, z - s.z);
			var inside = 1 - smoothstep(s.radius * 0.7, s.radius * 1.1, d);
			factor = Math.min(factor, 1 - (1 - s.light) * inside);
		}
		return factor;
	}

	function lightAt(state, cfg, x, z) {
		return state.env.lightLevel * localLightFactor(cfg, x, z);
	}

	/* ---------- visual threat (webs) ---------- */

	// Weight with which each eye sees a bearing (positive bearing = left).
	function eyeWeights(tc, b) {
		var rearEdge = Math.PI - tc.rearBlind;
		var wL = b >= -tc.binocularOverlap && b <= rearEdge ? 1 : 0;
		var wR = b <= tc.binocularOverlap && b >= -rearEdge ? 1 : 0;
		// soften the edges so bearings crossing the midline change smoothly
		if (wL && b < tc.binocularOverlap) wL = 0.5 + 0.5 * (b + tc.binocularOverlap) / (2 * tc.binocularOverlap);
		if (wR && b > -tc.binocularOverlap) wR = 0.5 + 0.5 * (tc.binocularOverlap - b) / (2 * tc.binocularOverlap);
		return { left: wL, right: wR };
	}

	function webThreat(state, cfg, web, eye, memory, dtSinceLast) {
		var tc = cfg.threat;
		var fly = state.fly;
		var f = WS.webFrame(web);
		var dx = f.cx - eye.x, dy = f.cy - eye.y, dz = f.cz - eye.z;
		var dh = Math.hypot(dx, dz);
		var dist = Math.hypot(dh, dy);
		var out = { id: web.id, distance: dist, bearing: 0, angularSize: 0, expansion: 0, visibility: 0,
			contrast: 0, intensity: 0, left: 0, right: 0 };
		if (dist > tc.maxRange) {
			memory[web.id] = null;
			return out;
		}
		var b = WS.bearing(fly.heading, dx, dz);
		out.bearing = b;
		var cosPhi = dh > 1e-6 ? Math.abs(dx * f.nx + dz * f.nz) / dh : 1;
		var projected = tc.edgeOnFloor + (1 - tc.edgeOnFloor) * cosPhi;
		var theta = 2 * Math.atan(web.radius * Math.sqrt(projected) / Math.max(dist, 0.3));
		out.angularSize = theta;
		var prev = memory[web.id];
		var expansion = 0;
		if (prev && dtSinceLast > 0) expansion = Math.max(0, (theta - prev.theta) / dtSinceLast);
		memory[web.id] = { theta: theta };
		out.expansion = expansion;

		// line of sight: centre plus four in-plane points
		var pts = [[0, 0], [0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.45]];
		var vis = 0;
		for (var i = 0; i < pts.length; i++) {
			var px = f.cx + f.ux * pts[i][0] * web.radius;
			var pz = f.cz + f.uz * pts[i][0] * web.radius;
			var py = Math.max(0.05, f.cy + pts[i][1] * web.radius);
			vis += transmission(cfg, eye.x, eye.y, eye.z, px, py, pz);
		}
		vis /= pts.length;
		out.visibility = vis;

		// Silk is visible when lit; darkness removes the cue.
		var contrast = web.contrast * lightAt(state, cfg, web.x, web.z);
		out.contrast = contrast;
		var motionTerm = web.motion * (0.5 + 0.5 * Math.sin(state.time * 2.3 + web.x * 0.7)) + (web.spider ? 0.6 : 0);
		var sizeTerm = theta / tc.sizeRef;
		var feature = tc.sizeWeight * Math.min(tc.sizeCap, sizeTerm * sizeTerm) +
			tc.expansionWeight * Math.min(2, expansion / tc.expansionRef) +
			tc.motionWeight * motionTerm;
		var rangeFade = 1 - smoothstep(tc.maxRange * 0.7, tc.maxRange, dist);
		var intensity = vis * contrast * feature * rangeFade;
		var w = eyeWeights(tc, b);
		out.left = intensity * w.left;
		out.right = intensity * w.right;
		out.intensity = intensity * Math.max(w.left, w.right);
		return out;
	}

	/* ---------- other flies (modeled social cues) ---------- */

	// A male sees females in his visual field within courtRange with a clear
	// line of sight, and reads from their appearance and cuticular pheromones
	// whether each is mature and whether she has recently mated (a mated
	// female carries the male pheromone cVA). A female hears courtship song
	// from a male singing within songRange, from any direction. `target` is
	// the female a courting male is pursuing, if he can see her. None of this
	// is sent to the connectome: courtship is a modeled program.
	function socialCues(state, cfg, fly, eye) {
		var out = { females: [], song: 0, suitor: null, target: null };
		var me = state.current, flies = state.flies, L = root.WorldLife;
		if (!me || !flies || flies.length < 2 || !L) return out;
		var rc = cfg.reproduction;
		for (var i = 0; i < flies.length; i++) {
			var o = flies[i];
			if (o === me) continue;
			var dx = o.fly.x - eye.x, dz = o.fly.z - eye.z, d = Math.hypot(dx, dz);
			if (me.sex === 'female') {
				if (o.sex === 'male' && o.repro.singing && d < rc.songRange) {
					var loud = 1 - d / rc.songRange;
					if (loud > out.song) { out.song = loud; out.suitor = o.id; }
				}
				continue;
			}
			if (o.sex !== 'female' || d > rc.courtRange) continue;
			var b = WS.bearing(fly.heading, dx, dz);
			var w = eyeWeights(cfg.threat, b);
			if (!(w.left > 0 || w.right > 0)) continue;
			if (d > 1.5 && transmission(cfg, eye.x, eye.y, eye.z, o.fly.x, o.fly.y + 0.3, o.fly.z) < 0.3) continue;
			var seen = { id: o.id, bearing: b, distance: d, mature: L.isMature(state, cfg, o), mated: L.recentlyMated(state, o),
				busy: !!o.repro.partner, accepting: o.behavior.current === 'accept' };
			out.females.push(seen);
			if (o.id === me.repro.courtTarget) out.target = seen;
		}
		return out;
	}

	/* ---------- sample ---------- */

	// Takes one sensory sample. `memory` persists between samples (odor
	// history, per-web apparent size) and is stored on state for replay.
	function sample(state, cfg, contacts) {
		var fly = state.fly;
		var fc = cfg.fly;
		var memory = state.senseMemory || (state.senseMemory = { odor: [], webs: {}, lastTime: -1 });
		var dtSince = memory.lastTime >= 0 ? state.time - memory.lastTime : 0;
		memory.lastTime = state.time;

		var fwd = WS.forward(fly.heading), lft = WS.left(fly.heading);
		var head = { x: fly.x + fwd.x * fc.headOffset, z: fly.z + fwd.z * fc.headOffset };
		var eye = { x: head.x, y: fly.y + fc.eyeHeight, z: head.z };
		var wind = windAt(state);

		// odor at two antennae
		var ax = fly.x + fwd.x * fc.antennaForward, az = fly.z + fwd.z * fc.antennaForward;
		var ay = fly.y + fc.eyeHeight;
		var odorL = odorAt(state, cfg, ax + lft.x * fc.antennaSeparation, ay, az + lft.z * fc.antennaSeparation, wind);
		var odorR = odorAt(state, cfg, ax - lft.x * fc.antennaSeparation, ay, az - lft.z * fc.antennaSeparation, wind);
		var odorMean = 0.5 * (odorL + odorR);
		memory.odor.push(odorMean);
		if (memory.odor.length > cfg.odor.historyLength) memory.odor.shift();
		var hist = memory.odor;
		var lag = Math.min(3, hist.length - 1);
		var odorTrend = lag > 0 && dtSince > 0 ? (odorMean - hist[hist.length - 1 - lag]) / (lag * dtSince) : 0;

		// taste: only with head contact on exposed edible fruit, on the ground.
		// Fermentation (acetic acid) on a contacted fruit marks an egg-laying site.
		var taste = { sugar: 0, bitter: 0, fruitId: null, fermentingId: null };
		if (fly.mode === 'ground') {
			for (var i = 0; i < state.fruits.length; i++) {
				var fr = state.fruits[i];
				if (!WS.isEdible(fr)) continue;
				var reach = fr.radius * Math.max(0.35, Math.min(1, fr.amount)) + fc.biteRange;
				if (Math.hypot(head.x - fr.x, head.z - fr.z) <= reach) {
					var sugar = WS.fruitSugar(cfg, fr);
					if (sugar > taste.sugar) { taste.sugar = sugar; taste.fruitId = fr.id; }
					if (fr.stage === 'fermenting' && !taste.fermentingId) taste.fermentingId = fr.id;
				}
			}
		}

		// visual threat from webs
		var threat = { left: 0, right: 0, webs: [] };
		for (var w = 0; w < state.webs.length; w++) {
			var wt = webThreat(state, cfg, state.webs[w], eye, memory.webs, dtSince);
			threat.left += wt.left;
			threat.right += wt.right;
			threat.webs.push(wt);
		}

		// touch: latched pulses plus sustained silk contact
		var p = state.pending;
		var heldL = state.time < (p.touchUntilL || -1) ? 0.6 : 0;
		var heldR = state.time < (p.touchUntilR || -1) ? 0.6 : 0;
		var touch = { left: Math.max(p.touchL, heldL), right: Math.max(p.touchR, heldR), silkLeft: p.silkL, silkRight: p.silkR,
			// strong contacts (Touch tool, silk) start with a one-shot pulse;
			// light bumps against walls or trunks do not
			onsetL: p.touchL >= 0.9 || p.silkL > 0, onsetR: p.touchR >= 0.9 || p.silkR > 0,
			location: p.touchLocation, nociception: p.nociception, snagged: !!fly.snag };
		if (fly.snag) { touch.silkLeft = Math.max(touch.silkLeft, 0.5); touch.silkRight = Math.max(touch.silkRight, 0.5); }

		// wind at the antennae: deflection toward the side the air comes from
		var windStrength = clamp(wind.speed / 1.5, 0, 1);
		var srcBearing = wind.speed > 1e-6 ? WS.bearing(fly.heading, -wind.x, -wind.z) : 0;
		var windL = windStrength * (0.5 + 0.5 * Math.sin(srcBearing));
		var windR = windStrength * (0.5 - 0.5 * Math.sin(srcBearing));

		// light per eye
		var level = lightAt(state, cfg, fly.x, fly.z);
		var sunB = WS.bearing(fly.heading, cfg.sun.dirX, cfg.sun.dirZ);
		var lightL = level * (0.85 + 0.15 * Math.sin(sunB));
		var lightR = level * (0.85 - 0.15 * Math.sin(sunB));

		return {
			time: state.time,
			odor: { left: odorL, right: odorR, mean: odorMean, trend: odorTrend },
			taste: taste,
			threat: threat,
			touch: touch,
			wind: { left: windL, right: windR, strength: windStrength, sourceBearing: srcBearing,
				gust: !!(state.env.gust && state.time < state.env.gust.until) },
			light: { left: lightL, right: lightR, level: level },
			temperature: state.env.temperature,
			airborne: fly.mode === 'air',
			social: socialCues(state, cfg, fly, eye)
		};
	}

	// Clears latched pulses once the encoder has consumed them.
	function consumePulses(state) {
		var p = state.pending;
		p.touchL = 0; p.touchR = 0; p.silkL = 0; p.silkR = 0;
		p.touchLocation = null;
		p.nociception = false;
	}

	root.WorldSenses = {
		sample: sample,
		consumePulses: consumePulses,
		odorAt: odorAt,
		windAt: windAt,
		lightAt: lightAt,
		transmission: transmission,
		eyeWeights: eyeWeights
	};
})(typeof window !== 'undefined' ? window : globalThis);
