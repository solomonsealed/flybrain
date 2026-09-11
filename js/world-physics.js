/* world-physics.js -- Body integration, altitude limits, swept collisions,
 * contacts, web snag/release, and landing.
 *
 * The body receives a motor command {speed, yawRate, altitude, takeoff, land}
 * from the behavior policy. Physics never steers toward anything; it only
 * resolves collisions, so a poor controller choice can never push the body
 * through a wall, trunk, trellis panel or fruit.
 *
 * Collision strategy: horizontal moves are split into sub-moves no longer than
 * MAX_SUBSTEP. Every solid obstacle is convex and its inflated radius
 * (obstacle + fly radius) exceeds MAX_SUBSTEP, so a sub-move cannot tunnel;
 * circles additionally get an exact time-of-impact test. Webs are thin sheets
 * and use a segment/plane crossing test.
 */
(function (root) {
	'use strict';

	var WS = root.WorldState;
	var MAX_SUBSTEP = 0.25;

	function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

	/* ---------- obstacle queries ---------- */

	// Solid circular obstacles active at the fly's altitude.
	function circleObstacles(state, cfg, altitude) {
		var list = [];
		var i;
		for (i = 0; i < cfg.trees.length; i++) {
			var t = cfg.trees[i];
			if (altitude < t.trunkHeight) list.push({ kind: 'trunk', id: t.id, x: t.x, z: t.z, r: t.trunkRadius });
		}
		for (i = 0; i < cfg.stones.length; i++) {
			var s = cfg.stones[i];
			if (altitude < s.height) list.push({ kind: 'stone', id: 'stone-' + i, x: s.x, z: s.z, r: s.radius });
		}
		if (altitude < 1.2) {
			for (i = 0; i < state.fruits.length; i++) {
				var f = state.fruits[i];
				if (f.stage === 'attached' || f.stage === 'depleted') continue;
				list.push({ kind: 'fruit', id: f.id, x: f.x, z: f.z, r: f.radius * 0.8 * Math.max(0.35, Math.min(1, f.amount)) });
			}
		}
		return list;
	}

	function segmentObstacles(cfg, altitude) {
		var list = [];
		for (var i = 0; i < cfg.trellis.length; i++) {
			var p = cfg.trellis[i];
			if (altitude < p.height) list.push({ kind: 'trellis', id: 'trellis-' + i, x1: p.x1, z1: p.z1, x2: p.x2, z2: p.z2, r: 0.3 });
		}
		return list;
	}

	// Earliest time of impact t in [0,1] of a circle (radius rf) moving from
	// (px,pz) by (dx,dz) against a static circle; Infinity if none.
	function circleTOI(px, pz, dx, dz, cx, cz, R) {
		var fx = px - cx, fz = pz - cz;
		var a = dx * dx + dz * dz;
		var b = 2 * (fx * dx + fz * dz);
		var c = fx * fx + fz * fz - R * R;
		if (a < 1e-12 || b >= 0) return Infinity;   // not approaching
		var disc = b * b - 4 * a * c;
		if (disc < 0) return Infinity;
		var t = (-b - Math.sqrt(disc)) / (2 * a);
		return t >= 0 && t <= 1 ? t : Infinity;
	}

	// Push a point out of every solid obstacle; returns the last contact.
	function resolvePenetration(pos, circles, segments, rf) {
		var contact = null;
		for (var iter = 0; iter < 3; iter++) {
			var moved = false;
			var i;
			for (i = 0; i < circles.length; i++) {
				var o = circles[i];
				var dx = pos.x - o.x, dz = pos.z - o.z;
				var d = Math.hypot(dx, dz);
				var R = o.r + rf;
				if (d < R) {
					if (d < 1e-6) { dx = 1; dz = 0; d = 1; }
					pos.x = o.x + dx / d * (R + 1e-4);
					pos.z = o.z + dz / d * (R + 1e-4);
					contact = { kind: o.kind, id: o.id, nx: dx / d, nz: dz / d };
					moved = true;
				}
			}
			for (i = 0; i < segments.length; i++) {
				var s = segments[i];
				var vx = s.x2 - s.x1, vz = s.z2 - s.z1;
				var len2 = vx * vx + vz * vz;
				var t = clamp(((pos.x - s.x1) * vx + (pos.z - s.z1) * vz) / len2, 0, 1);
				var qx = s.x1 + t * vx, qz = s.z1 + t * vz;
				var ex = pos.x - qx, ez = pos.z - qz;
				var e = Math.hypot(ex, ez);
				var Rs = s.r + rf;
				if (e < Rs) {
					if (e < 1e-6) { ex = -vz; ez = vx; e = Math.hypot(ex, ez); }
					pos.x = qx + ex / e * (Rs + 1e-4);
					pos.z = qz + ez / e * (Rs + 1e-4);
					contact = { kind: s.kind, id: s.id, nx: ex / e, nz: ez / e };
					moved = true;
				}
			}
			if (!moved) break;
		}
		return contact;
	}

	// Moves the body horizontally by (dx, dz) with swept collision and sliding.
	function moveHorizontal(state, cfg, dx, dz, contacts) {
		var fly = state.fly;
		var rf = cfg.fly.collisionRadius;
		var circles = circleObstacles(state, cfg, fly.y);
		var segments = segmentObstacles(cfg, fly.y);
		var dist = Math.hypot(dx, dz);
		var n = Math.max(1, Math.ceil(dist / MAX_SUBSTEP));
		var sx = dx / n, sz = dz / n;
		var pos = { x: fly.x, z: fly.z };
		for (var k = 0; k < n; k++) {
			var mx = sx, mz = sz;
			// exact TOI against circles, then slide the remainder once
			var tBest = Infinity, hit = null;
			for (var i = 0; i < circles.length; i++) {
				var o = circles[i];
				var t = circleTOI(pos.x, pos.z, mx, mz, o.x, o.z, o.r + rf);
				if (t < tBest) { tBest = t; hit = o; }
			}
			if (hit) {
				pos.x += mx * tBest; pos.z += mz * tBest;
				var nx = pos.x - hit.x, nz = pos.z - hit.z, nl = Math.hypot(nx, nz) || 1;
				nx /= nl; nz /= nl;
				var rx = mx * (1 - tBest), rz = mz * (1 - tBest);
				var dot = rx * nx + rz * nz;
				if (dot < 0) { rx -= dot * nx; rz -= dot * nz; }
				pos.x += rx; pos.z += rz;
				recordContact(contacts, { kind: hit.kind, id: hit.id, nx: nx, nz: nz });
			} else {
				pos.x += mx; pos.z += mz;
			}
			var pc = resolvePenetration(pos, circles, segments, rf);
			if (pc) recordContact(contacts, pc);
			var wc = WS.clampToEnclosure(cfg, pos.x, pos.z, rf + cfg.fly.wallClearance);
			if (wc.hit) {
				pos.x = wc.x; pos.z = wc.z;
				recordContact(contacts, { kind: 'wall', id: 'wall', nx: wc.nx, nz: wc.nz });
			}
		}
		fly.x = pos.x; fly.z = pos.z;
	}

	function recordContact(contacts, c) {
		for (var i = 0; i < contacts.solid.length; i++) {
			if (contacts.solid[i].id === c.id) return;
		}
		contacts.solid.push(c);
	}

	/* ---------- webs ---------- */

	function checkWebCrossing(state, cfg, x0, y0, z0, contacts) {
		var fly = state.fly;
		var rf = cfg.fly.collisionRadius;
		for (var i = 0; i < state.webs.length; i++) {
			var web = state.webs[i];
			var f = WS.webFrame(web);
			var s0 = (x0 - f.cx) * f.nx + (z0 - f.cz) * f.nz;
			var s1 = (fly.x - f.cx) * f.nx + (fly.z - f.cz) * f.nz;
			var reach = rf * 0.7 + cfg.silk.thickness;
			var crossed = (s0 > 0) !== (s1 > 0) || Math.abs(s1) < reach;
			if (!crossed) continue;
			var t = Math.abs(s0 - s1) > 1e-9 ? clamp(s0 / (s0 - s1), 0, 1) : 1;
			var px = x0 + (fly.x - x0) * t, pz = z0 + (fly.z - z0) * t;
			var py = y0 + (fly.y - y0) * t + 0.25;
			var u = (px - f.cx) * f.ux + (pz - f.cz) * f.uz;
			var v = py - f.cy;
			if (u * u + v * v > web.radius * web.radius) continue;
			if (py < 0 || v < -web.radius) continue;
			if (fly.snagCooldown && fly.snagCooldown.webId === web.id && state.time < fly.snagCooldown.until) {
				// just released: the sheet still blocks, without a new snag
				var back = s0 !== 0 ? (s0 > 0 ? 1 : -1) : fly.snagCooldown.side;
				var sp = (fly.x - f.cx) * f.nx + (fly.z - f.cz) * f.nz;
				var push = back * reach - sp;
				fly.x += f.nx * push; fly.z += f.nz * push;
				continue;
			}
			// Snag: bounded drag, then release (environmental mechanic).
			var side = s0 !== 0 ? (s0 > 0 ? 1 : -1) : (s1 >= 0 ? 1 : -1);
			var impact = Math.abs(fly.speed);
			var hold = root.WorldRandom.range(state.rng, cfg.silk.snagMin, cfg.silk.snagMax) * (0.7 + 0.3 * clamp(impact / 5, 0, 1));
			fly.x = f.cx + f.nx * side * 0.3 + (px - f.cx - f.nx * ((px - f.cx) * f.nx + (pz - f.cz) * f.nz));
			fly.z = f.cz + f.nz * side * 0.3 + (pz - f.cz - f.nz * ((px - f.cx) * f.nx + (pz - f.cz) * f.nz));
			fly.speed *= cfg.silk.dragFactor;
			fly.snag = { webId: web.id, t: 0, hold: hold, side: side };
			web.contacts++;
			web.lastContact = state.time;
			// Which side of the body met the silk: component of the direction
			// toward the sheet along the fly's left axis (head-on = both).
			var lv = WS.left(fly.heading);
			var lateral = -side * (lv.x * f.nx + lv.z * f.nz);
			var bodySide = Math.abs(lateral) < 0.35 ? 'both' : (lateral > 0 ? 'left' : 'right');
			contacts.web = { id: web.id, side: bodySide };
			WS.logEvent(state, 'silk-contact', { webId: web.id, side: bodySide, speed: impact }, 'world');
			return;
		}
	}

	function updateSnag(state, cfg, cmd, dt, contacts) {
		var fly = state.fly;
		var snag = fly.snag;
		var web = WS.findById(state.webs, snag.webId);
		if (!web) { fly.snag = null; return; }
		// Struggling (escape effort) shortens the hold.
		var effort = cmd && cmd.struggle ? clamp(cmd.struggle, 0, 1) : 0;
		snag.t += dt * (1 + 1.5 * effort);
		fly.speed = 0;
		fly.yawRate *= 0.5;
		contacts.web = { id: web.id, side: 'both', sustained: true };
		if (snag.t >= snag.hold) {
			var f = WS.webFrame(web);
			fly.x += f.nx * snag.side * cfg.silk.releasePush;
			fly.z += f.nz * snag.side * cfg.silk.releasePush;
			var wc = WS.clampToEnclosure(cfg, fly.x, fly.z, cfg.fly.collisionRadius + cfg.fly.wallClearance);
			fly.x = wc.x; fly.z = wc.z;
			fly.snag = null;
			fly.snagCooldown = { webId: web.id, until: state.time + 1.0, side: snag.side };
			WS.logEvent(state, 'silk-release', { webId: web.id, held: snag.t }, 'world');
		}
	}

	/* ---------- body step ---------- */

	// cmd: { speed, yawRate, altitude, takeoff, land, struggle, maxYawRate }
	// Returns contacts { solid: [...], web, landed, tookOff }.
	function step(state, cfg, cmd, dt) {
		var fly = state.fly;
		var bc = cfg.body;
		var contacts = { solid: [], web: null, landed: false, tookOff: false };
		cmd = cmd || {};

		if (fly.snag) {
			updateSnag(state, cfg, cmd, dt, contacts);
			return contacts;
		}

		// forward speed with acceleration limits
		var target = clamp(cmd.speed || 0, 0, bc.maxEscapeSpeed);
		var dv = target - fly.speed;
		dv = clamp(dv, -bc.decel * dt, bc.accel * dt * (target > bc.walkSpeed * 1.5 ? 3 : 1));
		fly.speed = clamp(fly.speed + dv, 0, bc.maxEscapeSpeed);

		// yaw with a first-order lag
		var maxYaw = cmd.maxYawRate || bc.maxYawRate;
		var yawTarget = clamp(cmd.yawRate || 0, -maxYaw, maxYaw);
		fly.yawRate += (yawTarget - fly.yawRate) * (1 - Math.exp(-dt / bc.yawTau));
		fly.heading = WS.normalizeAngle(fly.heading + fly.yawRate * dt);

		// altitude
		var y0 = fly.y;
		if (fly.mode === 'ground' && cmd.takeoff) {
			fly.mode = 'air';
			fly.vy = bc.climbRate;
			fly.airTime = 0;
			contacts.tookOff = true;
		}
		if (fly.mode === 'air') {
			fly.airTime += dt;
			var maxAlt = cfg.enclosure.maxFlightAltitude;
			// Only a flight command holds altitude; anything else descends to land
			// (e.g. after being released from silk in mid-air).
			var landing = cmd.land || (cmd.altitude === undefined && !cmd.takeoff);
			var targetAlt = landing ? 0 : clamp(cmd.altitude, 0.5, maxAlt);
			var vyTarget = clamp((targetAlt - fly.y) * 2.5, -bc.landingDescent, bc.climbRate);
			if (landing) vyTarget = Math.min(vyTarget, -bc.landingDescent * 0.6);
			fly.vy += (vyTarget - fly.vy) * (1 - Math.exp(-dt / 0.15));
			fly.y = clamp(fly.y + fly.vy * dt, 0, maxAlt);
			if (fly.y <= 0 && fly.airTime > 0.3) {
				fly.mode = 'ground';
				fly.y = 0;
				fly.vy = 0;
				fly.speed = Math.min(fly.speed, bc.walkSpeed);
				contacts.landed = true;
			}
		}

		var x0 = fly.x, z0 = fly.z;
		var f = WS.forward(fly.heading);
		moveHorizontal(state, cfg, f.x * fly.speed * dt, f.z * fly.speed * dt, contacts);

		// Hitting something solid bleeds speed.
		if (contacts.solid.length) fly.speed *= 0.85;

		checkWebCrossing(state, cfg, x0, y0, z0, contacts);
		return contacts;
	}

	root.WorldPhysics = {
		step: step,
		circleTOI: circleTOI,
		MAX_SUBSTEP: MAX_SUBSTEP,
		_circleObstacles: circleObstacles,
		_segmentObstacles: segmentObstacles
	};
})(typeof window !== 'undefined' ? window : globalThis);
