// ============================================================
// fly-logic.js
//
// FlyPolicy (bottom of this file) is the garden's body/behavior policy.
//
// The functions above it are the LEGACY screen-canvas behavior helpers
// (accumulator thresholds, nearest-food steering, pixel-distance feeding).
// The garden does not call them -- world-tests.js checks this -- and they
// remain only for the original regression tests in tests.js. They reference
// globals (BRAIN, behavior, food, fly) that tests.js defines.
// ============================================================

// Normalize angle to [-PI, PI] range
function normalizeAngle(a) {
	a = a % (2 * Math.PI);
	if (a > Math.PI) a -= 2 * Math.PI;
	if (a < -Math.PI) a += 2 * Math.PI;
	return a;
}

// Accumulator thresholds for entering each behavior state
var BEHAVIOR_THRESHOLDS = {
	startle: 30,
	fly: 15,
	feed: 8,
	groom: 8,
	walk: 5,
	restFatigue: 0.7,
	exploreCuriosity: 0.4,
	phototaxisLight: 0.5,
};

/**
 * Returns true if the given behavior state is in its cooldown period.
 * Requires global `behavior` object with a `cooldowns` map.
 */
function isCoolingDown(state, now) {
	return behavior.cooldowns[state] !== undefined && now < behavior.cooldowns[state];
}

/**
 * Returns true if any food item is within 50px of the fly.
 * Requires globals `food` (array) and `fly` (object with x, y).
 */
function hasNearbyFood() {
	for (var i = 0; i < food.length; i++) {
		if (Math.hypot(fly.x - food[i].x, fly.y - food[i].y) <= 50) return true;
	}
	return false;
}

/**
 * Evaluates accumulator outputs and drives to determine which behavior
 * state should be active. Returns the state name string.
 * Priority order (highest first): startle, fly, feed, groom, brace, rest, phototaxis, explore, walk, idle.
 * Requires globals `BRAIN`, `behavior`, `food`, `fly`.
 */
function evaluateBehaviorEntry() {
	var now = Date.now();
	var totalWalk = BRAIN.accumWalkLeft + BRAIN.accumWalkRight;

	if (BRAIN.accumStartle > BEHAVIOR_THRESHOLDS.startle && !isCoolingDown('startle', now)) {
		return 'startle';
	}
	if (BRAIN.accumFlight > BEHAVIOR_THRESHOLDS.fly && !isCoolingDown('fly', now)) {
		return 'fly';
	}
	var feedReady = BRAIN.accumFeed > BEHAVIOR_THRESHOLDS.feed ||
		(BRAIN.drives.hunger > 0.7 && BRAIN.stimulate.foodNearby);
	if (feedReady && hasNearbyFood() && !isCoolingDown('feed', now)) {
		return 'feed';
	}
	if (BRAIN.accumGroom > BEHAVIOR_THRESHOLDS.groom && !isCoolingDown('groom', now)) {
		return 'groom';
	}
	if (BRAIN.stimulate.wind && BRAIN.stimulate.windStrength < 0.5 &&
		BRAIN.accumStartle < BEHAVIOR_THRESHOLDS.startle && !isCoolingDown('brace', now)) {
		return 'brace';
	}
	var restThreshold = BRAIN.stimulate.lightLevel === 0 ? 0.4 : BEHAVIOR_THRESHOLDS.restFatigue;
	if (BRAIN.drives.fatigue > restThreshold) {
		return 'rest';
	}
	if (BRAIN.stimulate.lightLevel > BEHAVIOR_THRESHOLDS.phototaxisLight &&
		BRAIN.drives.curiosity > 0.2 && totalWalk > 3) {
		return 'phototaxis';
	}
	if (totalWalk > BEHAVIOR_THRESHOLDS.walk &&
		BRAIN.drives.curiosity > BEHAVIOR_THRESHOLDS.exploreCuriosity) {
		return 'explore';
	}
	if (totalWalk > BEHAVIOR_THRESHOLDS.walk) {
		return 'walk';
	}
	return 'idle';
}

// ============================================================
// Extracted Pure Functions for Testing (D68.2)
// These mirror inline logic from main.js and sim-worker.js
// so it can be exercised without DOM/Worker dependencies.
// ============================================================

var FEED_APPROACH_SPEED = 0.25;

/**
 * Pure extraction of food-seeking steering logic (main.js ~lines 859-862).
 * Returns the computed targetDir and seekStrength.
 */
function computeFoodSeekDir(flyX, flyY, foodX, foodY, hunger, facingDirVal) {
	var foodAngle = Math.atan2(-(foodY - flyY), foodX - flyX);
	var seekStrength = Math.min(1, hunger);
	var angleDiffToFood = normalizeAngle(foodAngle - facingDirVal);
	var targetDir = facingDirVal + angleDiffToFood * seekStrength;
	return { targetDir: targetDir, seekStrength: seekStrength };
}

/**
 * Pure extraction of food consumption progress (main.js ~lines 1760-1761).
 * Returns progress value clamped to [0, 1].
 */
function computeFoodProgress(foodItem, now) {
	var elapsed = now - foodItem.feedStart;
	var progress = Math.min(1, (foodItem.eaten || 0) + elapsed / foodItem.feedDuration);
	return progress;
}

/**
 * Pure extraction of pause-feeding logic (main.js ~lines 1773-1776).
 * Mutates foodItem in place: accumulates eaten progress and resets feedStart to 0.
 */
function pauseFeeding(foodItem, now) {
	if (foodItem.feedStart === 0) return;
	var ate = now - foodItem.feedStart;
	foodItem.eaten = Math.min(1, (foodItem.eaten || 0) + ate / foodItem.feedDuration);
	foodItem.feedStart = 0;
}

// ============================================================
// Garden body/behavior policy (FLY-WORLD-PLAN)
//
// Consumes motor-adapter outputs, local senses and body contacts. It never
// receives fruit, tree or web coordinates and contains no route planner.
// All durations, cooldowns and drive rates are in simulation seconds.
//
// Courtship and egg-laying (modeled, see world-life.js): a mature male who
// sees an unmated female courts her ('court'); a receptive female who hears
// his song and is calm stops for him ('accept'); a mounted pair copulates
// ('copulate', ended by world-life.js); a gravid female whose head touches
// fermenting fruit lays ('oviposit'). The policy acts on the fly in focus
// (state.fly, state.repro, state.current: see world-state.js).
// ============================================================

var FlyPolicy = (function () {
	'use strict';

	function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

	var ENTER = { escape: 0.6, walk: 0.18, feedProb: 0.55, groom: 0.75, brace: 0.45, song: 0.25, calm: 0.05 };
	var EXIT = { walk: 0.08, feedProb: 0.15, feedEscape: 0.25, startle: 0.2, rest: 0.25, song: 0.05 };
	var FREEZE = 0.15;       // s of freezing before an escape run
	var TURN_AWAY = 0.35;    // s of maximal turning at escape onset
	var LOST_SIGHT = 1.0;    // s a courting male keeps going without seeing the female

	function cooling(b, name, now) {
		return b.cooldowns[name] !== undefined && now < b.cooldowns[name];
	}

	function flyId(state) { return state.current ? state.current.id : undefined; }

	function transition(state, cfg, next, reason, motor) {
		var b = state.behavior;
		var now = state.time;
		if (next === b.current) return;
		var prev = b.current;
		if (cfg.policy.cooldown[prev]) b.cooldowns[prev] = now + cfg.policy.cooldown[prev];
		if (prev === 'court' && state.repro) { state.repro.courtTarget = null; state.repro.singing = false; }
		b.current = next;
		b.enterTime = now;
		b.phase = 'none';
		b.phaseTime = now;
		if (next === 'startle') {
			b.phase = 'freeze';
			b.escapeSign = motor ? motor.escapeSign : 1;
		} else if (next === 'fly') {
			var bc = cfg.body;
			b.flightEnd = now + root_range(state, bc.flightMinDuration, bc.flightMaxDuration);
			b.escapeSign = motor ? motor.escapeSign : b.escapeSign;
			b.phase = 'takeoff';
		} else if (next === 'groom') {
			b.groomLocation = state.pending.lastTouchLocation || 'thorax';
		}
		WorldState.logEvent(state, 'behavior', { from: prev, to: next, reason: reason || '', fly: flyId(state) }, 'fly');
	}

	function root_range(state, a, b) { return WorldRandom.range(state.rng, a, b); }

	// Chooses the behavior state at a neural-step boundary.
	function decide(state, cfg, motor, senses) {
		var b = state.behavior;
		var now = state.time;
		var cur = b.current;
		var elapsed = now - b.enterTime;
		var minDur = cfg.policy.minDuration[cur] || 0;

		if (state.fly.snag) {
			if (cur !== 'snagged') transition(state, cfg, 'snagged', 'caught in silk', motor);
			return;
		}
		if (cur === 'snagged') {
			transition(state, cfg, motor.escape > 0.3 ? 'startle' : 'walk', 'released from silk', motor);
			return;
		}
		if (cur === 'fly') return;  // flight ends on landing (see bodyCommand)
		if (cur === 'copulate') return;  // the pair stays joined until copulation ends (world-life.js)

		// Urgent defensive output interrupts any minimum duration.
		if (motor.escape > ENTER.escape && cur !== 'startle' && !cooling(b, 'startle', now)) {
			transition(state, cfg, 'startle', 'escape output ' + motor.escape.toFixed(2) + ' (' +
				(motor.escapeSign > 0 ? 'threat on right' : 'threat on left') + ')', motor);
			return;
		}
		// Feeding stops at once when contact is lost or defense rises.
		if (cur === 'feed') {
			if (!senses.taste.fruitId) { transition(state, cfg, evaluate(state, cfg, motor, senses, true), 'contact lost', motor); return; }
			if (motor.escape > EXIT.feedEscape) { transition(state, cfg, evaluate(state, cfg, motor, senses, true), 'defensive output interrupted feeding', motor); return; }
		}
		// Egg-laying lasts until world-life.js places the egg, unless contact
		// with the fruit is lost or defense rises.
		if (cur === 'oviposit') {
			if (!layingSite(state, cfg, senses)) { transition(state, cfg, evaluate(state, cfg, motor, senses, true), 'lost the egg-laying site', motor); return; }
			if (motor.escape > EXIT.feedEscape) { transition(state, cfg, evaluate(state, cfg, motor, senses, true), 'defensive output interrupted egg-laying', motor); return; }
			return;
		}
		// Courtship lasts until the pair mounts (world-life.js) or it ends.
		if (cur === 'court') {
			var why = courtshipEnds(state, cfg, motor, senses);
			if (why) transition(state, cfg, evaluate(state, cfg, motor, senses, false, true), why, motor);
			return;
		}
		if (cur === 'accept' && elapsed >= minDur) {
			var social = senses.social || {};
			var rec = state.current;
			var gone = !(social.song > EXIT.song) ? 'the song stopped' : motor.escape > 0.2 ? 'defensive output' :
				!(rec && WorldLife.isReceptive(state, cfg, rec)) ? 'no longer receptive' : '';
			if (gone) transition(state, cfg, evaluate(state, cfg, motor, senses, false, true), gone, motor);
			return;
		}
		if (elapsed < minDur) return;
		var next = evaluate(state, cfg, motor, senses, false);
		if (next === cur) return;
		transition(state, cfg, next, reasonFor(next, motor, senses), motor);
		if (next === 'court') {
			var t = courtTarget(state, cfg, senses);
			state.repro.courtTarget = t.id;
			state.repro.courtStart = now;
			state.repro.courtSeen = now;
		}
	}

	// The female a free, mature male would court: the nearest mature female
	// in view who has not recently mated and is not already paired.
	function courtTarget(state, cfg, senses) {
		var rec = state.current, social = senses.social;
		if (!rec || rec.sex !== 'male' || !social || !WorldLife.isMature(state, cfg, rec)) return null;
		var best = null;
		for (var i = 0; i < social.females.length; i++) {
			var f = social.females[i];
			if (f.mature && !f.mated && !f.busy && (!best || f.distance < best.distance)) best = f;
		}
		return best;
	}

	// The fruit a gravid female would lay on: fermenting fruit at her head or,
	// once her egg urge is high, any ripe fruit (as WorldLife.layingSite).
	function layingSite(state, cfg, senses) {
		return senses.taste.fermentingId || ((state.drives.egg || 0) >= cfg.reproduction.layAnyFruitUrge ? senses.taste.fruitId : null);
	}

	function courtshipEnds(state, cfg, motor, senses) {
		var rp = state.repro, now = state.time;
		var t = senses.social && senses.social.target;
		if (t) rp.courtSeen = now;
		if (!t && now - rp.courtSeen > LOST_SIGHT) return 'lost sight of the female';
		if (t && (t.mated || (t.busy && !t.accepting))) return 'she has mated';
		if (now - rp.courtStart > cfg.reproduction.courtMaxDuration) return 'gave up: she did not accept';
		if (motor.escape > EXIT.feedEscape) return 'defensive output interrupted courtship';
		return '';
	}

	function evaluate(state, cfg, motor, senses, noFeed, noCourt) {
		var b = state.behavior, now = state.time, cur = b.current, d = state.drives, rec = state.current;
		if (cur === 'startle') {
			if (motor.takeoff && !cooling(b, 'fly', now)) return 'fly';
			if (motor.escape > EXIT.startle) return 'startle';
		}
		// a gravid female lays on fermenting fruit she touches, when calm
		if (rec && rec.repro.eggs > 0 && !rec.repro.layBlocked && layingSite(state, cfg, senses) &&
			motor.escape < 0.2 && !cooling(b, 'oviposit', now)) return 'oviposit';
		if (!noFeed && senses.taste.fruitId && !cooling(b, 'feed', now) && motor.escape < 0.2 &&
			motor.proboscis > (cur === 'feed' ? EXIT.feedProb : ENTER.feedProb)) return 'feed';
		// Courtship and acceptance need a quiet connectome escape output (the
		// loom readout itself runs well above zero while walking).
		if (!noCourt && rec && senses.social && motor.escape < ENTER.calm) {
			if (rec.sex === 'male' && d.fatigue < 0.7 && !cooling(b, 'court', now) && courtTarget(state, cfg, senses)) return 'court';
			if (rec.sex === 'female' && senses.social.song > ENTER.song && WorldLife.isReceptive(state, cfg, rec)) return 'accept';
		}
		if (motor.brace > ENTER.brace && !cooling(b, 'brace', now)) return 'brace';
		if ((motor.groom > ENTER.groom || (cur === 'groom' && motor.groom > 0.3)) && motor.threat < 0.2 && !cooling(b, 'groom', now)) return 'groom';
		var restThr = senses.light.level < 0.1 ? 0.4 : 0.7;
		if (motor.threat < 0.2 && (d.fatigue > restThr || (cur === 'rest' && d.fatigue > EXIT.rest))) return 'rest';
		var walkThr = cur === 'walk' ? EXIT.walk : ENTER.walk;
		if (motor.walkDrive > walkThr || (motor.odorResponse > 0.3 && !motor.pausing)) return 'walk';
		return 'idle';
	}

	function reasonFor(next, motor, senses) {
		switch (next) {
		case 'feed': return 'sugar contact; proboscis output ' + motor.proboscis.toFixed(2);
		case 'walk': return motor.odorResponse > 0.3 ? 'odor response ' + motor.odorResponse.toFixed(2) : 'walking drive ' + motor.walkDrive.toFixed(2);
		case 'rest': return 'fatigue';
		case 'groom': return 'grooming urge';
		case 'brace': return 'gust on the antennae';
		case 'fly': return 'takeoff output';
		case 'idle': return 'low walking drive';
		case 'court': return 'sees an unmated female';
		case 'accept': return 'hears courtship song';
		case 'oviposit': return 'carrying an egg; fermenting fruit under her';
		default: return '';
		}
	}

	// Motor command for one body step (60 Hz) from the held motor output.
	function bodyCommand(state, cfg, motor, senses) {
		var b = state.behavior, bc = cfg.body, now = state.time;
		var cmd = { speed: 0, yawRate: 0 };
		switch (b.current) {
		case 'walk':
			cmd.speed = bc.walkSpeed * clamp(0.35 + 0.65 * motor.walkDrive + motor.surge, 0.2, 1.4);
			cmd.yawRate = motor.turn;
			// Local contact reflex: sugar under the legs/proboscis slows walking
			// so taste has time to act (uses contact only, never a location).
			if (senses.taste.sugar > 0) { cmd.speed *= 0.15; cmd.yawRate *= 0.3; }
			break;
		case 'startle':
			if (b.phase === 'freeze') {
				if (now - b.phaseTime >= FREEZE) { b.phase = 'run'; b.phaseTime = now; }
				break;
			}
			cmd.maxYawRate = bc.maxYawRateEscape;
			cmd.speed = bc.escapeRunSpeed * (0.6 + 0.4 * motor.escape);
			cmd.yawRate = (now - b.phaseTime < TURN_AWAY ? b.escapeSign * bc.maxYawRateEscape : 0) +
				motor.contributions.threatTurn + motor.contributions.touchTurn;
			break;
		case 'fly':
			cmd.takeoff = state.fly.mode === 'ground' && b.phase === 'takeoff';
			if (state.fly.mode === 'air') b.phase = 'air';
			else if (b.phase === 'air') { transition(state, cfg, 'walk', 'landed', motor); break; }
			cmd.speed = bc.flightSpeed;
			cmd.maxYawRate = bc.maxYawRateEscape;
			cmd.yawRate = (now - b.enterTime < TURN_AWAY ? b.escapeSign * bc.maxYawRateEscape * 0.7 : 0) + motor.turn * 0.5;
			cmd.altitude = bc.cruiseAltitude;
			cmd.land = now >= b.flightEnd && (motor.escape < 0.3 || now >= b.flightEnd + 2);
			if (cmd.land) cmd.speed = bc.walkSpeed * 1.5;
			break;
		case 'snagged':
			cmd.struggle = clamp(motor.escape + 0.3, 0, 1);
			break;
		case 'brace':
			cmd.yawRate = 2.0 * Math.sin(senses.wind.sourceBearing);
			break;
		case 'court':
			// modeled pursuit: keep followDistance behind her, turning toward
			// her (courtTurn) and away from threats and touch
			var tg = senses.social && senses.social.target;
			if (!tg) break;
			var c = motor.contributions;
			cmd.speed = clamp((tg.distance - cfg.reproduction.followDistance) * 2.5, 0, bc.walkSpeed * 1.3);
			cmd.yawRate = (c.courtTurn || 0) + (c.threatTurn || 0) + (c.touchTurn || 0);
			break;
		default:
			// idle, feed, groom, rest, accept, copulate, oviposit: standing
			break;
		}
		return cmd;
	}

	// Intake while feeding: only consumed nutrition reduces hunger. Returns the
	// portion eaten this body step (0 without head contact).
	function feedStep(state, cfg, dt) {
		var b = state.behavior;
		if (b.current !== 'feed') return 0;
		var fly = state.fly;
		var fwd = WorldState.forward(fly.heading);
		var hx = fly.x + fwd.x * cfg.fly.headOffset, hz = fly.z + fwd.z * cfg.fly.headOffset;
		var best = null;
		for (var i = 0; i < state.fruits.length; i++) {
			var f = state.fruits[i];
			if (!WorldState.isEdible(f)) continue;
			var reach = f.radius * Math.max(0.35, Math.min(1, f.amount)) + cfg.fly.biteRange;
			if (Math.hypot(hx - f.x, hz - f.z) <= reach) { best = f; break; }
		}
		if (!best || fly.mode !== 'ground') {
			transition(state, cfg, 'idle', 'contact lost', null);
			return 0;
		}
		var sp = cfg.species[best.species] || cfg.species.user;
		var eaten = Math.min(best.amount, cfg.fruit.intakeRate * dt);
		best.amount -= eaten;
		best.eatenBy += eaten;
		var nutrition = eaten * sp.nutrition;
		state.drives.hunger = clamp(state.drives.hunger - nutrition * cfg.drives.hungerPerNutrition, 0, 1);
		state.intake.total += eaten;
		state.intake.nutrition += nutrition;
		if (state.intake.lastFruitId !== best.id) {
			state.intake.lastFruitId = best.id;
			WorldState.logEvent(state, 'feeding', { fruitId: best.id, species: best.species, fly: flyId(state) }, 'fly');
		}
		return eaten;
	}

	// Drives in simulation time. Legacy per-tick constants were converted so
	// intended timescales hold (e.g. fear retention 0.85 per 0.5 s).
	function updateDrives(state, cfg, dt, motor, senses) {
		var d = state.drives, dc = cfg.drives, cur = state.behavior.current;
		var moving = cur === 'walk' || cur === 'startle' || cur === 'court';
		// modeled: a gravid female's urge to lay rises until she lays
		if (d.egg !== undefined) d.egg = state.repro && state.repro.eggs > 0 ? d.egg + cfg.reproduction.eggDriveRate * dt : 0;
		var flying = cur === 'fly';
		var dark = senses.light.level < 0.3;
		d.hunger += dc.hungerRate * dt;
		// Modeled defensive state, driven by the neural threat/touch readouts
		// above their noise floors (not by web proximity).
		var threatIn = 0.8 * Math.max(0, motor.threat - 0.25) + 0.6 * Math.max(0, motor.touch - 0.2) +
			(state.fly.snag ? 0.8 : 0) + (senses.touch.nociception ? 2.5 : 0);
		d.fear = d.fear * Math.pow(dc.fearRetentionPerHalfSecond, dt / 0.5) + threatIn * dt;
		if (flying) d.fatigue += dc.fatigueGainFlying * dt;
		else if (moving) d.fatigue += (dark ? dc.fatigueGainMovingDark : dc.fatigueGainMoving) * dt;
		else d.fatigue -= dc.fatigueRecovery * dt;
		var range = (dark ? dc.curiosityStepDark : dc.curiosityStep) * Math.sqrt(dt / 0.5);
		d.curiosity += (WorldRandom.next(state.rng) - 0.5) * range;
		d.groom += dc.groomRate * dt;
		var touching = Math.max(senses.touch.left, senses.touch.right);
		d.groom += dc.groomTouchGain * touching * dt;
		if (cur === 'groom') d.groom -= dc.groomRelief * dt;
		for (var k in d) d[k] = clamp(d[k], 0, 1);
	}

	return {
		decide: decide,
		bodyCommand: bodyCommand,
		feedStep: feedStep,
		updateDrives: updateDrives,
		// world-life.js moves the focused fly between states (mounting,
		// the end of copulation, a laid egg)
		enter: function (state, cfg, next, reason) { transition(state, cfg, next, reason, null); },
		ENTER: ENTER,
		EXIT: EXIT
	};
})();
