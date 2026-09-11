// ============================================================
// Garden world tests (FLY-WORLD-PLAN)
//
// Section W1 exercises the world modules directly (no connectome needed).
// Section W2 runs the production pipeline against the real sim-worker.js and
// data/ assets through tests/worker-harness.js; it is skipped when the
// connectome data or the Node harness is unavailable (e.g. in run.html).
// ============================================================

var WT = (function () {
	function cfg() { return WorldConfig; }
	function state(seed, opts) { return WorldState.create(WorldConfig, seed || 1, opts || {}); }
	function senses(overrides) { return FlyWorldSim.emptySenses(); }
	function neutralMotor(extra) {
		var m = { walkDrive: 0, turn: 0, escape: 0, escapeSign: 1, proboscis: 0, odorResponse: 0, threat: 0, touch: 0,
			threatL: 0, threatR: 0, touchL: 0, touchR: 0, takeoff: 0, groom: 0, brace: 0, surge: 0,
			contributions: { threatTurn: 0, touchTurn: 0, odorTurn: 0, upwindTurn: 0, wander: 0 } };
		for (var k in extra || {}) m[k] = extra[k];
		return m;
	}
	// Synchronous stand-in backend with fixed population rates, for testing
	// scheduling and policy logic without the connectome.
	function fakeBackend(rates, opts) {
		opts = opts || {};
		var names = Object.keys(rates);
		var calls = [];
		return {
			kind: 'fake', label: 'fake', readoutNames: names, readoutSizes: names.map(function () { return 100; }),
			popsInfo: { pops: {}, groups: {} },
			synchronous: !opts.async,
			calls: calls,
			pending: [],
			reset: function () {},
			step: function (req, cb) {
				calls.push(req.stepId);
				var res = { type: 'stepResult', stepId: req.stepId, ticks: 1, popSpikeCounts: names.map(function (n) { return rates[n] * 100; }) };
				if (opts.async) this.pending.push(function () { cb(res); }); else cb(res);
			}
		};
	}
	return { cfg: cfg, state: state, senses: senses, neutralMotor: neutralMotor, fakeBackend: fakeBackend };
})();

// ------------------------------------------------------------
// Section W1: world modules
// ------------------------------------------------------------

function test_world_rng_is_seeded_and_serializable() {
	var a = WorldRandom.create(42), b = WorldRandom.create(42);
	for (var i = 0; i < 50; i++) assertEqual(WorldRandom.next(a), WorldRandom.next(b), 'same seed, same sequence');
	var copy = JSON.parse(JSON.stringify(a));
	assertEqual(WorldRandom.next(copy), WorldRandom.next(a), 'serialized generator continues identically');
}

function test_world_state_same_seed_same_garden() {
	var s1 = WT.state(7), s2 = WT.state(7), s3 = WT.state(8);
	assertEqual(WorldState.serialize(s1), WorldState.serialize(s2), 'same seed builds an identical garden');
	assertTrue(WorldState.serialize(s1) !== WorldState.serialize(s3), 'different seeds differ (canopy fruit placement)');
	var round = WorldState.deserialize(WorldState.serialize(s1));
	assertEqual(WorldState.serialize(round), WorldState.serialize(s1), 'state round-trips through JSON');
}

function test_world_named_areas_not_used_by_fly_modules() {
	// The fly may only receive local senses: no simulation module may read
	// the viewer-facing area labels.
	if (typeof require === 'undefined' && typeof WorldTestHarness === 'undefined') return;
	var fs = WorldTestHarness.fs, path = WorldTestHarness.path, root = WorldTestHarness.ROOT;
	['js/world-physics.js', 'js/world-senses.js', 'js/world-brain-adapter.js', 'js/fly-logic.js', 'js/world-sim.js', 'js/world-life.js'].forEach(function (f) {
		var src = fs.readFileSync(path.join(root, f), 'utf8');
		assertTrue(src.indexOf('.areas') === -1, f + ' does not read named areas');
		assertTrue(!/initialFruit|cfg\.webs\b/.test(src), f + ' does not read authored fruit/web layout');
	});
	// The legacy coordinate-steering shortcuts must not be reachable from the garden.
	['js/main.js', 'js/world-sim.js', 'js/world-brain-adapter.js', 'js/world-physics.js', 'js/world-senses.js'].forEach(function (f) {
		var src = fs.readFileSync(path.join(root, f), 'utf8');
		['computeFoodSeekDir', 'hasNearbyFood', 'evaluateBehaviorEntry', 'nearestFood'].forEach(function (fn) {
			assertTrue(src.indexOf(fn) === -1, f + ' does not call the legacy ' + fn);
		});
	});
	// FlyPolicy may test head contact with fruit (a local contact), but must
	// not use the legacy helpers or look at webs.
	var policy = fs.readFileSync(path.join(root, 'js/fly-logic.js'), 'utf8');
	policy = policy.slice(policy.indexOf('var FlyPolicy'));
	['computeFoodSeekDir', 'hasNearbyFood', 'evaluateBehaviorEntry', 'state.webs'].forEach(function (fn) {
		assertTrue(policy.indexOf(fn) === -1, 'FlyPolicy does not use ' + fn);
	});
}

function test_world_fruit_ripens_falls_ferments_and_stays_capped() {
	var cfg = WT.cfg(), st = WT.state(3);
	var attached = st.fruits.filter(function (f) { return f.stage === 'attached'; }).length;
	assertTrue(attached > 0, 'garden starts with canopy fruit');
	var fell = 0, maxTotal = 0, maxGround = 0;
	var dt = 0.1;
	for (var i = 0; i < 6000; i++) {  // 600 s
		st.time += dt;
		WorldState.updateFruit(st, cfg, dt);
		maxTotal = Math.max(maxTotal, st.fruits.length);
		maxGround = Math.max(maxGround, st.fruits.filter(function (f) { return f.stage !== 'attached'; }).length);
	}
	st.events.forEach(function (e) { if (e.type === 'fruit-fell') fell++; });
	assertTrue(fell > 0, 'ripe canopy fruit falls');
	assertTrue(st.events.some(function (e) { return e.type === 'fruit-fermenting'; }), 'fallen fruit ferments');
	assertTrue(maxTotal <= cfg.fruit.maxFruit, 'total fruit stays under the cap (' + maxTotal + ')');
	assertTrue(maxGround <= cfg.fruit.maxGroundFruit, 'ground fruit stays under the cap (' + maxGround + ')');
	st.fruits.forEach(function (f) {
		if (f.stage !== 'attached') assertTrue(WorldState.groundPointFree(cfg, f.x, f.z, 0.5), 'fruit never lands inside an obstacle');
	});
}

function test_world_commands_validate_and_tag_source() {
	var cfg = WT.cfg(), st = WT.state(1);
	var tree = cfg.trees[0];
	var bad = WorldState.applyCommand(st, cfg, { type: 'placeFruit', params: { x: tree.x, z: tree.z }, source: 'user' });
	assertTrue(!bad.ok, 'cannot place fruit inside a trunk');
	var out = WorldState.applyCommand(st, cfg, { type: 'placeFruit', params: { x: -50, z: 45 }, source: 'caretaker' });
	assertTrue(out.ok, 'out-of-bounds placement is clamped into the garden');
	var f = WorldState.findById(st.fruits, out.id);
	assertTrue(f.x >= cfg.bounds.xMin && f.x <= cfg.bounds.xMax, 'clamped x inside the enclosure');
	var ev = st.events[st.events.length - 1];
	assertEqual(ev.source, 'caretaker', 'events carry their source');
	assertTrue(!WorldState.applyCommand(st, cfg, { type: 'removeWeb', params: { id: 'nope' } }).ok, 'unknown web rejected');
	assertTrue(!WorldState.applyCommand(st, cfg, { type: 'bogus' }).ok, 'unknown command rejected');
	for (var i = 0; i < 40; i++) WorldState.applyCommand(st, cfg, { type: 'placeFruit', params: { x: 50 + (i % 10) * 2, z: 50 + Math.floor(i / 10) * 2 } });
	assertTrue(st.fruits.filter(function (q) { return q.stage !== 'attached'; }).length <= cfg.fruit.maxGroundFruit, 'placement respects the fruit cap');
}

function test_world_available_food_excludes_canopy_fruit() {
	var st = WT.state(1);
	var avail = WorldState.availableFood(st);
	assertTrue(avail.length > 0, 'fallen fruit is available');
	assertTrue(avail.every(function (f) { return f.stage !== 'attached'; }), 'canopy fruit never counts as available food');
}

function test_physics_contains_body_at_max_escape_speed() {
	var cfg = WT.cfg(), st = WT.state(5, { fruit: false });
	var rng = WorldRandom.create(99);
	var rf = cfg.fly.collisionRadius;
	for (var i = 0; i < 20000; i++) {
		if (i % 40 === 0) st.fly.heading = WorldRandom.range(rng, -Math.PI, Math.PI);
		st.fly.snag = null;
		st.fly.speed = cfg.body.maxEscapeSpeed;
		WorldPhysics.step(st, cfg, { speed: cfg.body.maxEscapeSpeed, yawRate: 0 }, cfg.clock.bodyDt);
		var f = st.fly;
		assertTrue(WorldState.insideEnclosure(cfg, f.x, f.z, rf + cfg.fly.wallClearance - 1e-6), 'inside walls at step ' + i + ' (' + f.x.toFixed(2) + ',' + f.z.toFixed(2) + ')');
		cfg.trees.forEach(function (t) { assertTrue(Math.hypot(f.x - t.x, f.z - t.z) >= t.trunkRadius + rf - 1e-3, 'outside trunk ' + t.id); });
		cfg.stones.forEach(function (s) { assertTrue(Math.hypot(f.x - s.x, f.z - s.z) >= s.radius + rf - 1e-3, 'outside stone'); });
		cfg.trellis.forEach(function (p) { assertTrue(WorldState.pointSegmentDistance(f.x, f.z, p.x1, p.z1, p.x2, p.z2) >= 0.3 + rf - 1e-3, 'outside trellis'); });
	}
}

function test_physics_trunk_stops_head_on_run() {
	var cfg = WT.cfg(), t = cfg.trees[0];
	var st = WT.state(1, { fruit: false, webs: false, start: { x: t.x + 10, z: t.z, heading: Math.PI } });
	for (var i = 0; i < 120; i++) WorldPhysics.step(st, cfg, { speed: cfg.body.maxEscapeSpeed, yawRate: 0 }, cfg.clock.bodyDt);
	var d = Math.hypot(st.fly.x - t.x, st.fly.z - t.z);
	assertClose(d, t.trunkRadius + cfg.fly.collisionRadius, 0.05, 'body rests against the trunk surface');
}

function test_physics_web_snags_then_releases() {
	var cfg = WT.cfg();
	var web = cfg.webs[0];
	var f = WorldState.webFrame(web);
	// start 4 BL in front of web A, heading straight into it
	var start = { x: f.cx + f.nx * -4, z: f.cz + f.nz * -4, heading: Math.atan2(-f.nz, f.nx) };
	var st = WT.state(1, { fruit: false, start: start });
	var snaggedAt = -1, released = -1;
	for (var i = 0; i < 600; i++) {
		var c = WorldPhysics.step(st, cfg, { speed: 3, yawRate: 0 }, cfg.clock.bodyDt);
		st.time += cfg.clock.bodyDt;
		if (c.web && snaggedAt < 0) snaggedAt = st.time;
		if (snaggedAt >= 0 && !st.fly.snag && released < 0) released = st.time;
	}
	assertTrue(snaggedAt > 0, 'walking into silk snags the fly');
	assertTrue(released > snaggedAt, 'the snag releases');
	assertTrue(released - snaggedAt <= cfg.silk.snagMax + 0.1, 'snag duration is bounded (' + (released - snaggedAt).toFixed(2) + ' s)');
	var side = (st.fly.x - f.cx) * f.nx + (st.fly.z - f.cz) * f.nz;
	assertTrue(side < 0, 'released on the side it came from');
	assertTrue(st.events.some(function (e) { return e.type === 'silk-contact' && e.source === 'world'; }), 'silk contact is a world-sourced event');
}

function test_physics_non_flight_commands_land_an_airborne_fly() {
	var cfg = WT.cfg();
	var st = WT.state(1, { fruit: false, webs: false });
	WorldPhysics.step(st, cfg, { speed: 5, yawRate: 0, takeoff: true, altitude: 6 }, cfg.clock.bodyDt);
	for (var i = 0; i < 120; i++) WorldPhysics.step(st, cfg, { speed: 5, yawRate: 0, altitude: 6 }, cfg.clock.bodyDt);
	assertTrue(st.fly.mode === 'air' && st.fly.y > 3, 'flight command climbs and holds altitude');
	var landed = false;
	for (var j = 0; j < 600 && !landed; j++) landed = WorldPhysics.step(st, cfg, { speed: 2, yawRate: 0 }, cfg.clock.bodyDt).landed;
	assertTrue(landed && st.fly.mode === 'ground' && st.fly.y === 0, 'a walking command in the air descends and lands');
}

function test_senses_occlusion_reduces_web_visibility() {
	var cfg = WT.cfg();
	var vis = function (scenario) {
		var st = WorldState.create(cfg, 1, cfg.scenarios[scenario].stateOptions);
		var s = WorldSenses.sample(st, cfg);
		return s.threat.webs.filter(function (w) { return w.id === 'web-b'; })[0];
	};
	var open = vis('visibleWeb'), hidden = vis('hiddenWeb');
	assertClose(open.distance, hidden.distance, 1.5, 'both scenarios view web B from a similar distance');
	assertTrue(open.visibility > 0.9, 'clear line of sight from the north (' + open.visibility.toFixed(2) + ')');
	assertTrue(hidden.visibility < open.visibility * 0.5, 'vines and trellis block most of the view from the west (' + hidden.visibility.toFixed(2) + ')');
	assertTrue(hidden.intensity < open.intensity, 'occlusion lowers the visual threat input');
}

function test_senses_cues_are_side_specific() {
	var cfg = WT.cfg();
	// fruit ahead-left of the fly (heading east: left = north)
	var st = WT.state(1, { fruit: false, webs: false, start: { x: 60, z: 45, heading: 0 } });
	st.env.breeze.speed = 0;
	WorldState.applyCommand(st, cfg, { type: 'placeFruit', params: { x: 63, z: 42 } });
	var s = WorldSenses.sample(st, cfg);
	assertTrue(s.odor.left > s.odor.right, 'odor is stronger at the antenna nearer the fruit');
	// web to the right (south)
	var st2 = WT.state(1, { fruit: false, webs: false, start: { x: 60, z: 45, heading: 0 } });
	WorldState.applyCommand(st2, cfg, { type: 'placeWeb', params: { x: 66, z: 52, heading: Math.PI * 0.75 } });
	var s2 = WorldSenses.sample(st2, cfg);
	assertTrue(s2.threat.right > s2.threat.left, 'a web on the right is seen by the right eye');
	// gust from the left (north), travelling south
	WorldState.applyCommand(st2, cfg, { type: 'wind', params: { dirX: 0, dirZ: 1, strength: 1 } });
	var s3 = WorldSenses.sample(st2, cfg);
	assertTrue(s3.wind.left > s3.wind.right, 'wind from the left deflects the left antenna more');
}

function test_senses_taste_requires_contact() {
	var cfg = WT.cfg();
	var st = WT.state(1, { fruit: false, webs: false, start: { x: 60, z: 45, heading: 0 } });
	WorldState.applyCommand(st, cfg, { type: 'placeFruit', params: { x: 63, z: 45 } });
	assertEqual(WorldSenses.sample(st, cfg).taste.sugar, 0, 'no taste at a distance, however strong the smell');
	st.fly.x = 63 - 0.8 - cfg.fly.headOffset - 0.1;
	var s = WorldSenses.sample(st, cfg);
	assertTrue(s.taste.sugar > 0 && s.taste.fruitId, 'head contact tastes sugar');
}

function test_policy_no_intake_without_contact() {
	var cfg = WT.cfg();
	var st = WT.state(1, { fruit: false, webs: false, drives: { hunger: 0.9 } });
	WorldState.applyCommand(st, cfg, { type: 'placeFruit', params: { x: st.fly.x + 5, z: st.fly.z } });
	st.behavior.current = 'feed';
	var before = st.drives.hunger;
	var ate = FlyPolicy.feedStep(st, cfg, cfg.clock.bodyDt);
	assertEqual(ate, 0, 'nothing is eaten without contact');
	assertEqual(st.drives.hunger, before, 'hunger unchanged without intake');
	assertTrue(st.behavior.current !== 'feed', 'feeding stops at once when contact is missing');
}

function test_policy_only_consumed_nutrition_reduces_hunger() {
	var cfg = WT.cfg();
	var st = WT.state(1, { fruit: false, webs: false, drives: { hunger: 0.9 }, start: { x: 60, z: 45, heading: 0 } });
	var r = WorldState.applyCommand(st, cfg, { type: 'placeFruit', params: { x: 61.4, z: 45 } });
	var fruit = WorldState.findById(st.fruits, r.id);
	st.behavior.current = 'feed';
	var eaten = 0;
	for (var i = 0; i < 60; i++) eaten += FlyPolicy.feedStep(st, cfg, cfg.clock.bodyDt);
	var sp = cfg.species[fruit.species];
	assertTrue(eaten > 0, 'contact feeding consumes fruit');
	assertClose(0.9 - st.drives.hunger, eaten * sp.nutrition * cfg.drives.hungerPerNutrition, 1e-9, 'hunger drop equals consumed nutrition');
	assertClose(fruit.amount, 1 - eaten, 1e-9, 'fruit keeps its partly eaten amount');
}

function test_policy_defense_interrupts_feeding_and_rest() {
	var cfg = WT.cfg();
	['feed', 'rest', 'groom'].forEach(function (b) {
		var st = WT.state(1, { fruit: false, webs: false });
		st.behavior.current = b;
		st.behavior.enterTime = 0;
		st.time = 0.05;   // well inside every minimum duration
		var s = WT.senses();
		s.taste = { sugar: 0.9, fruitId: 'x' };
		FlyPolicy.decide(st, cfg, WT.neutralMotor({ escape: 0.9, escapeSign: -1 }), s);
		assertEqual(st.behavior.current, 'startle', 'urgent escape interrupts ' + b);
	});
}

function test_policy_moderate_threat_does_not_force_escape() {
	var cfg = WT.cfg();
	var st = WT.state(1, { fruit: false, webs: false });
	st.behavior.current = 'walk';
	st.time = 5;
	FlyPolicy.decide(st, cfg, WT.neutralMotor({ escape: 0.3, walkDrive: 0.6 }), WT.senses());
	assertEqual(st.behavior.current, 'walk', 'moderate defensive output leaves walking in place');
}

function test_drive_rates_preserve_legacy_timescales() {
	var cfg = WT.cfg();
	var st = WT.state(1, { fruit: false, webs: false, drives: { hunger: 0.2, fear: 0.8, fatigue: 0, curiosity: 0.5, groom: 0 } });
	st.behavior.current = 'idle';
	var m = WT.neutralMotor(), s = WT.senses();
	for (var i = 0; i < 5; i++) FlyPolicy.updateDrives(st, cfg, 0.1, m, s);
	assertClose(st.drives.fear, 0.8 * 0.85, 1e-9, 'fear retention 0.85 per 0.5 s regardless of step size');
	assertClose(st.drives.hunger, 0.2 + 0.005, 1e-9, 'hunger +0.005 per 0.5 s');
}

function test_clock_waits_for_neural_result_with_one_outstanding_step() {
	var cfg = WT.cfg();
	var be = WT.fakeBackend({ DN_L: 0.03, DN_R: 0.03 }, { async: true });
	var sim = FlyWorldSim.create({ config: cfg, seed: 1, backend: be, stateOptions: { fruit: false, webs: false } });
	sim.settle(2);
	be.pending.splice(0).forEach(function (f) { f(); });   // settle step 1
	be.pending.splice(0).forEach(function (f) { f(); });   // settle step 2
	assertTrue(sim.settled, 'settling completes once results arrive');
	sim.advance(0.1);   // block 0 needs no prior result
	var stepsAfterFirst = sim.state.bodyStep;
	assertEqual(stepsAfterFirst, 6, 'one block of six body steps runs');
	var before = sim.state.bodyStep;
	sim.advance(0.2);
	assertEqual(sim.state.bodyStep, before, 'no body steps run while neural step 0 is outstanding');
	assertTrue(sim.clock.stalled, 'the clock reports that it is waiting');
	assertEqual(be.pending.length, 1, 'only one neural step is outstanding');
	be.pending.splice(0).forEach(function (f) { f(); });
	sim.advance(0.1);
	assertTrue(sim.state.bodyStep > before, 'time resumes when the result arrives');
	assertEqual(be.pending.length, 1, 'still one outstanding step');
}

function test_clock_pause_preserves_state() {
	var cfg = WT.cfg();
	var be = WT.fakeBackend({ DN_L: 0.03, DN_R: 0.03 });
	var sim = FlyWorldSim.create({ config: cfg, seed: 1, backend: be });
	sim.settle(1);
	sim.advance(0.5);
	var fp = sim.fingerprint(), calls = be.calls.length;
	sim.clock.pause();
	for (var i = 0; i < 10; i++) sim.advance(0.1);
	assertEqual(sim.fingerprint(), fp, 'paused world does not change');
	assertEqual(be.calls.length, calls, 'paused brain is not stepped');
	sim.clock.resume();
	sim.advance(0.1);
	assertTrue(sim.fingerprint() !== fp, 'resuming continues the run');
}

function test_camera_independent_simulation() {
	// Renderer-facing calls (render pose interpolation) must not alter state.
	var cfg = WT.cfg();
	var be = WT.fakeBackend({ DN_L: 0.03, DN_R: 0.03 });
	var sim = FlyWorldSim.create({ config: cfg, seed: 4, backend: be });
	sim.settle(1);
	sim.runSeconds(1);
	var fp = sim.fingerprint();
	for (var i = 0; i < 20; i++) sim.renderPose();
	assertEqual(sim.fingerprint(), fp, 'reading the render pose leaves the world unchanged');
}

function test_adapter_turns_away_from_stronger_threat_side() {
	var cfg = WT.cfg();
	var motor = WorldBrainAdapter.createMotorAdapter(cfg, { mode: 'connectome' });
	var ro = { rates: { DN_L: 0.03, DN_R: 0.03 }, resp: { DN_LOOM_RANKED_L: 0.06, DN_LOOM_RANKED_R: 0.0 } };
	var out = motor.compute(ro, FlyWorldSim.emptySenses(), { fear: 0 }, WorldRandom.create(1), 0.1, {});
	assertTrue(out.contributions.threatTurn < 0, 'stronger left loom response turns right (negative yaw)');
	assertEqual(out.escapeSign, -1, 'escape turns toward the quieter (right) side');
	assertEqual(out.contributions.odorTurn, 0, 'connectome-only mode has no modeled odor steering');
}

function test_adapter_motor_silencing_removes_neural_terms() {
	var cfg = WT.cfg();
	var motor = WorldBrainAdapter.createMotorAdapter(cfg, { mode: 'hybrid' });
	var ro = { rates: { DN_L: 0.05, DN_R: 0.05 }, resp: { DN_LOOM_RANKED_L: 0.06, LH_NEURON_L: 0.05, LH_NEURON_R: 0.05, MN_PROBOSCIS: 0.05 } };
	var s = FlyWorldSim.emptySenses();
	s.odor.left = 2; s.odor.right = 1;
	var out = motor.compute(ro, s, { fear: 0 }, WorldRandom.create(1), 0.1, { motorOutput: true });
	assertEqual(out.walkDrive, 0, 'no walking drive');
	assertEqual(out.escape, 0, 'no escape');
	assertEqual(out.turn, 0, 'no steering of any kind (no residual scripted navigation)');
	assertEqual(out.proboscis, 0, 'no feeding output');
}

function test_encoder_grades_and_silences_inputs() {
	var cfg = WT.cfg();
	var mk = function (n, base) { var a = new Uint32Array(n); for (var i = 0; i < n; i++) a[i] = base + i; return a; };
	var pops = { ORN_FOOD_L: mk(100, 0), ORN_FOOD_R: mk(100, 100), VPN_LOOM_PROXY_L: mk(100, 200), VPN_LOOM_PROXY_R: mk(100, 300), GRN_SUGAR: mk(20, 400) };
	var enc = WorldBrainAdapter.createEncoder(cfg, { pops: pops, groups: {} });
	var count = function (e, lo, hi) { var c = 0; for (var i = 0; i < e.stimulus.indices.length; i++) { var x = e.stimulus.indices[i]; if (x >= lo && x < hi) c++; } return c; };
	var s = FlyWorldSim.emptySenses();
	s.odor.left = 0.3; s.odor.right = 3;
	var e1 = enc.encode(s, { hunger: 0.8, fatigue: 0, curiosity: 0.5 }, {});
	assertTrue(count(e1, 100, 200) > count(e1, 0, 100), 'stronger odor recruits more receptor neurons on that side');
	var e2 = enc.encode(s, { hunger: 0.8, fatigue: 0, curiosity: 0.5 }, { foodInput: true });
	assertEqual(count(e2, 0, 200), 0, 'silenced food input stimulates no receptor neurons');
	var hungry = WorldBrainAdapter.createEncoder(cfg, { pops: pops, groups: {} }).encode(s, { hunger: 1, fatigue: 0, curiosity: 0.5 }, {});
	var sated = WorldBrainAdapter.createEncoder(cfg, { pops: pops, groups: {} }).encode(s, { hunger: 0, fatigue: 0, curiosity: 0.5 }, {});
	assertTrue(count(hungry, 0, 200) > count(sated, 0, 200), 'hunger raises olfactory gain');
}

// ------------------------------------------------------------
// Several flies, courtship and the life cycle (no connectome)
// ------------------------------------------------------------

// A pair on open ground: female at (60, 45) facing east, male 3 BL behind her.
function pairState(extra) {
	var o = { fruit: false, webs: false, founders: [
		{ sex: 'female', x: 60, z: 45, heading: 0 },
		{ sex: 'male', x: 57, z: 45, heading: 0 }] };
	for (var k in extra || {}) o[k] = extra[k];
	return WT.state(1, o);
}

function lifeSteps(st, seconds) {
	var cfg = WT.cfg(), dt = cfg.clock.bodyDt, n = Math.round(seconds / dt);
	for (var i = 0; i < n; i++) {
		WorldLife.step(st, cfg, dt);
		st.time = Math.round((st.time + dt) * 1e9) / 1e9;
	}
}

function test_world_founders_single_by_default_pair_or_many_by_option() {
	var cfg = WT.cfg();
	var one = WT.state(1);
	assertEqual(one.flies.length, 1, 'a state without founders options holds one fly (the documented experiments)');
	assertEqual(one.flies[0].sex, 'female', 'the single fly is female (FlyWire\'s brain is female)');
	assertTrue(one.fly === one.flies[0].fly && one.drives === one.flies[0].drives, 'state.fly and state.drives are the first fly\'s');
	var pair = WorldState.create(cfg, 1, cfg.scenarios.free.stateOptions);
	assertEqual(pair.flies.map(function (r) { return r.sex; }).join(','), 'female,male', 'the default garden starts with a female and a male');
	var many = WorldState.create(cfg, 1, { founders: 60 });
	assertEqual(many.flies.length, cfg.population.max, 'founders are capped at the population maximum');
	assertEqual(many.flies.filter(function (r) { return r.sex === 'male'; }).length, cfg.population.max / 2, 'alternating sexes');
	many.flies.forEach(function (r) {
		assertTrue(WorldState.insideEnclosure(cfg, r.fly.x, r.fly.z, 1) && WorldState.groundPointFree(cfg, r.fly.x, r.fly.z, 0.5), 'founder placed on free ground');
	});
	assertEqual(WorldState.serialize(WorldState.create(cfg, 1, {})), WorldState.serialize(one), 'founder scatter never touches the garden\'s random sequence');
}

function test_world_serialization_stores_each_fly_once_and_refocuses() {
	var st = pairState();
	var json = WorldState.serialize(st);
	var raw = JSON.parse(json);
	assertTrue(!('fly' in raw) && !('drives' in raw) && raw.flies.length === 2, 'per-fly aliases are not serialized');
	var back = WorldState.deserialize(json);
	assertEqual(WorldState.serialize(back), json, 'round trip');
	assertTrue(back.fly === back.flies[0].fly && back.current === back.flies[0], 'deserialize focuses the first adult');
	WorldState.focus(st, st.flies[1]);
	var c = WorldState.clone(st);
	assertEqual(c.current.id, st.flies[1].id, 'clone keeps the focused fly');
	// a state saved before the garden held several flies
	var old = JSON.parse(WorldState.serialize(WT.state(2)));
	var f = old.flies[0];
	delete old.flies; delete old.brood; delete old.nextFlyId;
	old.fly = f.fly; old.drives = f.drives; old.behavior = f.behavior; old.pending = f.pending; old.intake = f.intake;
	delete old.drives.egg;
	var up = WorldState.deserialize(old);
	assertEqual(up.flies.length, 1, 'old single-fly state upgrades to one adult');
	assertTrue(up.fly === up.flies[0].fly && up.drives.egg === 0 && up.brood.length === 0, 'upgraded fields in place');
}

function test_world_focus_runs_single_fly_modules_on_each_fly() {
	var cfg = WT.cfg(), st = pairState();
	var seen = [];
	WorldState.focus(st, st.flies[0]);
	WorldState.eachFly(st, function (rec) { seen.push(rec.id + ':' + (st.fly === rec.fly && st.pending === rec.pending && st.repro === rec.repro)); });
	assertEqual(seen.join(','), 'fly-1:true,fly-2:true', 'each adult in turn, with every alias pointed at it');
	assertEqual(st.current.id, 'fly-1', 'focus restored');
	WorldState.applyCommand(st, cfg, { type: 'touch', params: { fly: 'fly-2', side: 'left' } });
	assertEqual(st.flies[1].pending.touchL, 1, 'touch reaches the named fly');
	assertEqual(st.flies[0].pending.touchL, 0, 'and no other');
	assertTrue(!WorldState.applyCommand(st, cfg, { type: 'touch', params: { fly: 'nope' } }).ok, 'unknown fly rejected');
	assertTrue(!WorldState.applyCommand(st, cfg, { type: 'placeWeb', params: { x: 56, z: 47 } }).ok, 'no web within 5 BL of any fly');
}

function test_physics_flies_do_not_pass_through_each_other() {
	var cfg = WT.cfg();
	var st = WT.state(1, { fruit: false, webs: false, founders: [
		{ sex: 'female', x: 55, z: 45, heading: 0 }, { sex: 'male', x: 65, z: 45, heading: Math.PI }] });
	var minD = Infinity;
	for (var i = 0; i < 240; i++) {
		WorldState.eachFly(st, function () { WorldPhysics.step(st, cfg, { speed: 4, yawRate: 0 }, cfg.clock.bodyDt); });
		minD = Math.min(minD, Math.hypot(st.flies[0].fly.x - st.flies[1].fly.x, st.flies[0].fly.z - st.flies[1].fly.z));
	}
	assertTrue(minD >= 2 * cfg.fly.collisionRadius - 0.02, 'bodies stay apart (closest ' + minD.toFixed(3) + ' BL)');
	// a copulating pair is not solid to itself
	st.flies[0].repro.partner = 'fly-2';
	WorldState.focus(st, st.flies[0]);
	var obstacles = WorldPhysics._circleObstacles(st, cfg, 0);
	assertTrue(!obstacles.some(function (o) { return o.kind === 'fly'; }), 'the partner is not an obstacle');
}

function test_senses_male_sees_females_and_females_hear_song() {
	var cfg = WT.cfg(), st = pairState();
	var F = st.flies[0], M = st.flies[1];
	WorldState.focus(st, M);
	var s = WorldSenses.sample(st, cfg);
	assertEqual(s.social.females.length, 1, 'the male sees the female ahead of him');
	var seen = s.social.females[0];
	assertTrue(seen.mature && !seen.mated && Math.abs(seen.bearing) < 0.2, 'mature, unmated, straight ahead');
	M.fly.heading = Math.PI;
	assertEqual(WorldSenses.sample(st, cfg).social.females.length, 0, 'not when she is in his rear blind sector');
	M.fly.heading = 0;
	F.repro.matings = 1; F.repro.receptiveFrom = st.time + 50;
	assertTrue(WorldSenses.sample(st, cfg).social.females[0].mated, 'a recently mated female reads as mated (cVA)');
	WorldState.focus(st, F);
	M.fly.x = 58.5;   // singing distance: he sings close behind her
	assertEqual(WorldSenses.sample(st, cfg).social.song, 0, 'a silent male is not heard');
	M.repro.singing = true;
	var h = WorldSenses.sample(st, cfg).social;
	assertTrue(h.song > 0 && h.suitor === M.id, 'she hears his song from behind her');
	assertEqual(h.females.length, 0, 'females do not look for mates');
	M.fly.x = 50;
	assertEqual(WorldSenses.sample(st, cfg).social.song, 0, 'song fades beyond songRange');
}

function test_policy_courtship_needs_an_unmated_female_and_a_calm_brain() {
	var cfg = WT.cfg(), st = pairState();
	var F = st.flies[0], M = st.flies[1];
	st.time = 5;
	var senses = function (social) { var s = WT.senses(); s.social = social; return s; };
	var female = { id: F.id, mature: true, mated: false, busy: false, accepting: false, distance: 3, bearing: 0.1 };
	WorldState.focus(st, M);
	M.behavior.current = 'walk'; M.behavior.enterTime = 0;
	FlyPolicy.decide(st, cfg, WT.neutralMotor({ walkDrive: 0.5 }), senses({ females: [female], song: 0, suitor: null, target: null }));
	assertEqual(M.behavior.current, 'court', 'a male who sees an unmated female courts her');
	assertEqual(M.repro.courtTarget, F.id, 'and remembers whom');
	M.behavior.current = 'walk'; M.behavior.cooldowns = {};
	FlyPolicy.decide(st, cfg, WT.neutralMotor({ walkDrive: 0.5 }), senses({ females: [{ id: F.id, mature: true, mated: true, busy: false, distance: 3, bearing: 0 }], song: 0, suitor: null, target: null }));
	assertEqual(M.behavior.current, 'walk', 'not a recently mated one');
	WorldState.focus(st, F);
	F.behavior.current = 'walk'; F.behavior.enterTime = 0;
	FlyPolicy.decide(st, cfg, WT.neutralMotor({ walkDrive: 0.5, escape: 0.3 }), senses({ females: [], song: 0.6, suitor: M.id, target: null }));
	assertEqual(F.behavior.current, 'walk', 'a female with defensive output does not accept');
	FlyPolicy.decide(st, cfg, WT.neutralMotor({ walkDrive: 0.5 }), senses({ females: [], song: 0.6, suitor: M.id, target: null }));
	assertEqual(F.behavior.current, 'accept', 'a calm, receptive female who hears song stands for him');
}

function test_life_one_mating_gives_exactly_one_egg_laid_on_fermenting_fruit() {
	var cfg = WT.cfg(), st = pairState();
	var F = st.flies[0], M = st.flies[1];
	assertEqual(cfg.reproduction.offspringPerMating, 1, 'one offspring per mating');
	// courtship at mounting range
	M.fly.x = F.fly.x - 1.0;
	WorldState.focus(st, M); FlyPolicy.enter(st, cfg, 'court', 'test'); M.repro.courtTarget = F.id;
	WorldState.focus(st, F); FlyPolicy.enter(st, cfg, 'accept', 'test');
	lifeSteps(st, 0.05);
	assertTrue(F.behavior.current === 'copulate' && M.behavior.current === 'copulate', 'an accepting female within reach is mounted');
	assertTrue(st.events.some(function (e) { return e.type === 'mating'; }), 'mating event');
	lifeSteps(st, cfg.reproduction.copulationDuration + 0.2);
	assertEqual(F.repro.eggs, 1, 'one egg from one mating');
	assertTrue(F.behavior.current === 'idle' && M.behavior.current === 'idle' && !F.repro.partner && !M.repro.partner, 'the pair separates');
	assertTrue(Math.hypot(M.fly.x - F.fly.x, M.fly.z - F.fly.z) >= 2 * cfg.fly.collisionRadius && M.fly.y === 0, 'he dismounts clear of her');
	assertTrue(!WorldLife.isReceptive(st, cfg, F) && WorldLife.recentlyMated(st, F), 'she is not receptive after mating');
	// she lays on fermenting fruit under her head
	var r = WorldState.applyCommand(st, cfg, { type: 'placeFruit', params: { x: F.fly.x + 1.2, z: F.fly.z } });
	var fruit = WorldState.findById(st.fruits, r.id);
	fruit.stage = 'fermenting';
	WorldState.focus(st, F); FlyPolicy.enter(st, cfg, 'oviposit', 'test');
	lifeSteps(st, cfg.reproduction.ovipositDuration + 0.1);
	assertEqual(st.brood.length, 1, 'one egg laid');
	var egg = st.brood[0];
	assertTrue(egg.stage === 'egg' && egg.fruitId === fruit.id && egg.parents[0] === F.id && egg.parents[1] === M.id, 'on that fruit, with both parents');
	assertEqual(F.repro.eggs, 0, 'she has no more eggs');
	WorldState.focus(st, F); FlyPolicy.enter(st, cfg, 'oviposit', 'test');
	lifeSteps(st, cfg.reproduction.ovipositDuration + 0.1);
	assertEqual(st.brood.length, 1, 'no second egg from the same mating');
}

function test_life_brood_develops_and_emerges_as_an_adult() {
	var cfg = WT.cfg(), lc = cfg.lifecycle, st = pairState();
	st.brood.push({ id: 'fly-3', sex: 'male', stage: 'egg', stageTime: 0, laid: 0, x: 70, z: 50, dirX: 1, dirZ: 0, heading: 0, fruitId: null, parents: ['fly-1', 'fly-2'], adult: null });
	st.nextFlyId = 4;
	lifeSteps(st, lc.eggDuration + 0.1);
	assertEqual(st.brood[0].stage, 'larva', 'the egg hatches');
	lifeSteps(st, lc.larvaDuration);
	var pupa = st.brood[0];
	assertTrue(pupa.stage === 'pupa' && pupa.adult && pupa.adult.id === 'fly-3', 'the larva pupates, and its adult is prepared');
	assertTrue(Math.abs(pupa.x - (70 + lc.pupaWander)) < 1e-9, 'beside where it fed');
	assertEqual(WorldLife.settlingPupae(st, cfg).length, 0, 'its brain does not settle yet');
	lifeSteps(st, lc.pupaDuration - cfg.brain.settleSteps * cfg.clock.neuralDt + 0.1);
	assertEqual(WorldLife.settlingPupae(st, cfg).length, 1, 'its brain settles in the last part of the pupal stage');
	lifeSteps(st, cfg.brain.settleSteps * cfg.clock.neuralDt);
	assertEqual(st.brood.length, 0, 'the pupa is gone');
	var adult = WorldState.findFly(st, 'fly-3');
	assertTrue(adult && adult.sex === 'male' && adult.born !== null && adult.parents[0] === 'fly-1', 'a new male emerged');
	assertTrue(!WorldLife.isMature(st, cfg, adult), 'not yet mature');
	lifeSteps(st, lc.maturation.male + 0.1);
	assertTrue(WorldLife.isMature(st, cfg, adult), 'mature after maturation');
	assertTrue(st.events.some(function (e) { return e.type === 'eclosed' && e.data.fly === 'fly-3'; }), 'eclosion event');
}

function test_life_population_never_exceeds_the_cap() {
	var cfg = WT.cfg(), max = cfg.population.max;
	var st = WT.state(1, { fruit: false, webs: false, founders: max - 1 });
	var r = WorldState.applyCommand(st, cfg, { type: 'placeFruit', params: { x: 60, z: 45 } });
	WorldState.findById(st.fruits, r.id).stage = 'fermenting';
	function gravidOnFruit(rec) {
		rec.repro.eggs = 1; rec.repro.matings = 1; rec.repro.sire = 'fly-2';
		rec.fly.x = 60 + 0.8 + cfg.fly.headOffset; rec.fly.z = 45; rec.fly.heading = Math.PI;
		WorldState.focus(st, rec); FlyPolicy.enter(st, cfg, 'oviposit', 'test');
	}
	var females = st.flies.filter(function (f) { return f.sex === 'female'; });
	gravidOnFruit(females[0]);
	lifeSteps(st, cfg.reproduction.ovipositDuration + 0.1);
	assertEqual(WorldLife.population(st), max, 'the last free place is taken by an egg');
	gravidOnFruit(females[1]);
	lifeSteps(st, cfg.reproduction.ovipositDuration + 0.1);
	assertEqual(WorldLife.population(st), max, 'a full garden takes no more eggs');
	assertTrue(females[1].repro.eggs === 1 && females[1].repro.layBlocked, 'she holds her egg');
	var s = WT.senses();
	s.taste = { sugar: 0.9, bitter: 0, fruitId: r.id, fermentingId: r.id };
	WorldState.focus(st, females[1]);
	females[1].behavior.cooldowns = {};
	FlyPolicy.decide(st, cfg, WT.neutralMotor(), s);
	assertTrue(females[1].behavior.current !== 'oviposit', 'and does not try to lay while the garden is full');
}

// Neuron positions asset (display-only): format, validation, orientation.
function positionsBuffer(n, min, max, qs, magic) {
	var buf = new ArrayBuffer(36 + n * 6), dv = new DataView(buf);
	(magic || 'FBNP').split('').forEach(function (ch, i) { dv.setUint8(i, ch.charCodeAt(0)); });
	dv.setUint32(4, 1, true);
	dv.setUint32(8, n, true);
	for (var a = 0; a < 3; a++) { dv.setFloat32(12 + a * 4, min[a], true); dv.setFloat32(24 + a * 4, max[a], true); }
	for (var i = 0; i < qs.length; i++) dv.setUint16(36 + i * 2, qs[i], true);
	return buf;
}

var test_world_neuron_positions_parse_and_validate = function () {
	var buf = positionsBuffer(2, [0, 0, 0], [800, 400, 200], [0, 0, 0, 65535, 32768, 65535]);
	var p = WorldBrainAdapter.parsePositions(buf);
	assertEqual(p.neuronCount, 2, 'neuron count');
	assertEqual(p.q[3], 65535, 'second neuron x');
	assertEqual(p.max[1], 400, 'bounds');
	var threw = false;
	try { WorldBrainAdapter.parsePositions(positionsBuffer(2, [0, 0, 0], [1, 1, 1], [0, 0, 0, 0, 0, 0], 'XXXX')); } catch (e) { threw = true; }
	assertTrue(threw, 'bad magic is rejected');
	threw = false;
	try { WorldBrainAdapter.parsePositions(buf.slice(0, buf.byteLength - 2)); } catch (e) { threw = true; }
	assertTrue(threw, 'truncated file is rejected');
	var manifest = { neuron_count: 2, hashes: { 'connectome.bin.gz': 'abc' } };
	assertTrue(WorldBrainAdapter.validatePositions(p, manifest, { neuronCount: 2 }, { 'connectome.bin.gz': 'abc' }).ok, 'matching pair accepted');
	assertTrue(!WorldBrainAdapter.validatePositions(p, manifest, { neuronCount: 3 }, {}).ok, 'count mismatch dropped');
	assertTrue(!WorldBrainAdapter.validatePositions(p, manifest, { neuronCount: 2 }, { 'connectome.bin.gz': 'def' }).ok, 'other connectome dropped');
	assertTrue(!WorldBrainAdapter.validatePositions(null, null, { neuronCount: 2 }, {}).ok, 'missing file reported');
};

var test_world_brain_frame_maps_fafb_axes_onto_the_fly = function () {
	// FAFB: x toward the fly's right (mirrored image), y ventral, z posterior.
	var p = WorldBrainAdapter.parsePositions(positionsBuffer(3, [0, 0, 0], [800, 400, 200],
		[0, 32768, 32768,         // smallest x: the fly's left
			32768, 0, 32768,      // smallest y: dorsal
			32768, 32768, 0]));   // smallest z: anterior
	var f = WorldBrainAdapter.brainFramePosition(p, 0, [0, 0, 0]);
	assertClose(f[2], -0.5, 1e-9, 'smallest x is on the left (-z) edge');
	f = WorldBrainAdapter.brainFramePosition(p, 1, [0, 0, 0]);
	assertClose(f[1], 0.25, 1e-4, 'dorsal is up, scaled by brain width (400/800 / 2)');
	f = WorldBrainAdapter.brainFramePosition(p, 2, [0, 0, 0]);
	assertClose(f[0], 0.125, 1e-4, 'anterior is forward (200/800 / 2)');
};

// ------------------------------------------------------------
// Section W2: production pipeline on the real worker and data
// ------------------------------------------------------------

var WorldIntegration = (function () {
	var H = typeof WorldTestHarness !== 'undefined' ? WorldTestHarness : null;
	var available = !!(H && H.harness.hasConnectomeData() && H.harness.loadSidecar());
	var worker = null;
	function backend() {
		if (!worker) worker = H.harness.createWorker();
		var b = H.connectomeBackend({ worker: worker });
		b.reset();
		return b;
	}
	function sim(opts) {
		var s = FlyWorldSim.create(Object.assign({ config: WorldConfig, backend: backend() }, opts));
		s.settle();
		return s;
	}
	function meanRates(b, stimFn, steps) {
		var names = b.readoutNames, sizes = b.readoutSizes, acc = {};
		names.forEach(function (n) { acc[n] = 0; });
		for (var k = 0; k < steps; k++) {
			var r; b.step({ stepId: k, stimulus: stimFn(k) }, function (x) { r = x; });
			if (k >= steps / 3) names.forEach(function (n, i) { acc[n] += r.popSpikeCounts[i] / sizes[i]; });
		}
		names.forEach(function (n) { acc[n] /= steps - Math.floor(steps / 3); });
		return acc;
	}
	function stim(lists) {
		var idx = [], val = [];
		lists.forEach(function (l) { for (var i = 0; i < l[0].length; i++) { idx.push(l[0][i]); val.push(l[1]); } });
		return { indices: Uint32Array.from(idx), intensities: Float32Array.from(val) };
	}
	function baseline(b) {
		var p = b.popsInfo.pops, g = b.popsInfo.groups;
		return [[p.PHOTORECEPTOR_L, 0.14], [p.PHOTORECEPTOR_R, 0.14], [g.CX_FC, 0.08], [g.CX_EPG, 0.08], [g.CX_PFN, 0.08]];
	}
	return { available: available, backend: backend, sim: sim, meanRates: meanRates, stim: stim, baseline: baseline, H: H };
})();

if (WorldIntegration.available) {

var test_worker_step_protocol_is_deterministic = function () {
	var b = WorldIntegration.backend();
	var s = WorldIntegration.stim(WorldIntegration.baseline(b));
	var run = function () {
		b.reset();
		var out = [];
		for (var k = 0; k < 25; k++) b.step({ stepId: 100 + k, stimulus: s }, function (r) { assertEqual(r.stepId, 100 + k, 'stepId echoed'); out.push(r.firedNeurons); });
		return out.join(',');
	};
	assertEqual(run(), run(), 'identical requests from a reset brain give identical spikes');
	var w = b.worker;
	w.post({ type: 'reset' });
	for (var k = 0; k < 10; k++) w.post({ type: 'step', stepId: k, stimulus: s });
	var snap = w.post({ type: 'snapshot', requestId: 1 }).state;
	var a = [];
	for (k = 0; k < 10; k++) a.push(w.post({ type: 'step', stepId: k, stimulus: s }).firedNeurons);
	w.post({ type: 'restore', state: snap, requestId: 2 });
	var c = [];
	for (k = 0; k < 10; k++) c.push(w.post({ type: 'step', stepId: k, stimulus: s }).firedNeurons);
	assertEqual(a.join(','), c.join(','), 'snapshot/restore reproduces the continuation');
};

var test_worker_sidecar_mapping_matches_worker_order = function () {
	var b = WorldIntegration.backend();
	var meta = WorldIntegration.H.loadAssets().meta;
	var gid = {};
	meta.groups.forEach(function (g) { gid[g.name] = g.id; });
	var groupOf = b.worker.ready.groupId;
	var check = function (pop, group) {
		var list = b.popsInfo.pops[pop];
		assertTrue(list.length > 0, pop + ' is populated');
		for (var i = 0; i < list.length; i++) assertEqual(groupOf[list[i]], gid[group], pop + ' neuron maps into ' + group);
	};
	check('ORN_FOOD_L', 'OLF_ORN_FOOD');
	check('ORN_FOOD_R', 'OLF_ORN_FOOD');
	// Audit finding: build_connectome.py sends sub_class "sugar/water" to
	// GUS_GRN_WATER, so the sugar receptors are not in GUS_GRN_SWEET.
	check('GRN_SUGAR', 'GUS_GRN_WATER');
	check('PHOTORECEPTOR_R', 'VIS_R1R6');
	check('MN_PROBOSCIS', 'MN_PROBOSCIS');
	var manifest = WorldIntegration.H.loadAssets().manifest;
	manifest.populations.forEach(function (p) {
		assertEqual(b.popsInfo.pops[p.name].length, p.count, p.name + ' count survives the worker reorder');
		assertEqual(b.popsInfo.pops[p.name + '_L'].length, p.count_left, p.name + ' left count');
	});
	assertEqual(b.popsInfo.pops.VPN_LOOM_PROXY.length + 0, manifest.populations.filter(function (p) { return p.name === 'VPN_LOOM_PROXY'; })[0].count, 'loom proxy intact');
	assertEqual(b.popsInfo.groups.VIS_LC.length, 0, 'VIS_LC stays empty (never filled by assignment)');
};

var test_integration_odor_drives_lateral_horn = function () {
	var b = WorldIntegration.backend(), p = b.popsInfo.pops;
	var base = WorldIntegration.baseline(b);
	var none = WorldIntegration.meanRates(b, function () { return WorldIntegration.stim(base); }, 90);
	b.reset();
	var odor = WorldIntegration.meanRates(b, function () { return WorldIntegration.stim(base.concat([[p.ORN_FOOD_L, 0.2], [p.ORN_FOOD_R, 0.2]])); }, 90);
	var lh0 = none.LH_NEURON_L + none.LH_NEURON_R, lh1 = odor.LH_NEURON_L + odor.LH_NEURON_R;
	assertTrue(lh1 > lh0 * 1.3, 'food odor raises lateral horn activity (' + lh0.toFixed(4) + ' -> ' + lh1.toFixed(4) + ')');
	assertTrue(odor.ALPN_L + odor.ALPN_R > none.ALPN_L + none.ALPN_R, 'and projection neuron activity');
};

var test_integration_loom_proxy_is_lateralized = function () {
	var b = WorldIntegration.backend(), p = b.popsInfo.pops;
	var base = WorldIntegration.baseline(b);
	var left = WorldIntegration.meanRates(b, function () { return WorldIntegration.stim(base.concat([[p.VPN_LOOM_PROXY_L, 0.25]])); }, 90);
	b.reset();
	var right = WorldIntegration.meanRates(b, function () { return WorldIntegration.stim(base.concat([[p.VPN_LOOM_PROXY_R, 0.25]])); }, 90);
	assertTrue(left.DN_LOOM_RANKED_L > left.DN_LOOM_RANKED_R, 'left proxy input favors left loom-ranked DNs');
	assertTrue(right.DN_LOOM_RANKED_R > right.DN_LOOM_RANKED_L, 'right proxy input favors right loom-ranked DNs');
};

var test_integration_sugar_drives_proboscis_motor_neurons = function () {
	var b = WorldIntegration.backend(), p = b.popsInfo.pops;
	var base = WorldIntegration.baseline(b);
	var none = WorldIntegration.meanRates(b, function () { return WorldIntegration.stim(base); }, 90);
	b.reset();
	var sugar = WorldIntegration.meanRates(b, function () { return WorldIntegration.stim(base.concat([[p.GRN_SUGAR, 0.3]])); }, 90);
	assertTrue(sugar.MN_PROBOSCIS > none.MN_PROBOSCIS + 0.005, 'sugar receptor input raises proboscis motor neuron firing');
};

var test_integration_replay_reproduces_run_exactly = function () {
	var sim = WorldIntegration.sim({ seed: 11 });
	sim.runSeconds(3);
	sim.command({ type: 'placeFruit', params: { x: 64, z: 40 }, source: 'user' });
	sim.runSeconds(2);
	sim.command({ type: 'wind', params: { dirX: 1, dirZ: 0, strength: 0.8, duration: 1 }, source: 'user' });
	sim.runSeconds(3);
	var log = sim.exportLog();
	var rep = FlyWorldSim.replay(log, sim.backend, { config: WorldConfig });
	rep.runSeconds(8);
	assertEqual(rep.state.bodyStep, log.finalBodyStep, 'replay reached the same step');
	assertEqual(rep.fingerprint(), log.finalFingerprint, 'replay matches the original run exactly');
};

var test_integration_pause_resume_matches_uninterrupted_run = function () {
	var a = WorldIntegration.sim({ seed: 5 });
	a.runSeconds(6);
	var fpA = a.fingerprint();
	var b = WorldIntegration.sim({ seed: 5 });
	b.runSeconds(3);
	b.clock.pause();
	for (var i = 0; i < 30; i++) b.advance(0.1);
	b.clock.resume();
	b.runSeconds(3);
	assertEqual(b.fingerprint(), fpA, 'a paused and resumed run continues exactly where it stopped');
};

// Hungry fly two body lengths from a fig, facing it.
function nearFruitRun(hunger, silenced, seconds) {
	var sim = WorldIntegration.sim({ seed: 3, stateOptions: { fruit: false, webs: false, drives: { hunger: hunger }, start: { x: 57, z: 45, heading: 0 } } });
	sim.command({ type: 'placeFruit', params: { x: 60, z: 45, species: 'fig' }, source: 'experiment' });
	if (silenced) sim.command({ type: 'silence', params: { channel: silenced, on: true }, source: 'experiment' });
	sim.state.env.breeze.speed = 0;
	var fed = -1;
	sim.onEvents(function (evs) { evs.forEach(function (e) { if (e.type === 'behavior' && e.data.to === 'feed' && fed < 0) fed = e.t; }); });
	sim.runSeconds(seconds);
	return { fed: fed, intake: sim.state.intake.total, hunger: sim.state.drives.hunger };
}

var test_integration_hungry_fly_feeds_satiated_fly_does_not = function () {
	var hungry = nearFruitRun(0.9, null, 12);
	var sated = nearFruitRun(0.02, null, 12);
	assertTrue(hungry.fed >= 0 && hungry.intake > 0.1, 'hungry fly finds and eats the fruit (intake ' + hungry.intake.toFixed(2) + ')');
	assertTrue(sated.intake < hungry.intake * 0.5, 'satiated fly eats much less (' + sated.intake.toFixed(2) + ')');
};

var test_integration_silencing_food_input_blocks_feeding = function () {
	var silenced = nearFruitRun(0.9, 'foodInput', 12);
	assertEqual(silenced.intake, 0, 'without olfactory/gustatory input the proboscis never engages');
};

var test_integration_visible_web_evokes_defense_and_silencing_removes_it = function () {
	var cfg = WorldConfig;
	var f = WorldState.webFrame(cfg.webs[0]);
	var start = { x: f.cx - f.nx * 9, z: f.cz - f.nz * 9, heading: Math.atan2(-f.nz, f.nx) };
	var run = function (silence, seed) {
		var sim = WorldIntegration.sim({ seed: seed, mode: 'connectome', stateOptions: { fruit: false, start: start, drives: { hunger: 0.3 } } });
		if (silence) sim.command({ type: 'silence', params: { channel: 'threatInput', on: true }, source: 'experiment' });
		var silk = -1, closest = 1e9, peakThreat = 0, peakVpn = 0;
		sim.onEvents(function (evs) { evs.forEach(function (e) { if (e.type === 'silk-contact' && silk < 0) silk = e.t; }); });
		for (var i = 0; i < 60; i++) {
			sim.runSeconds(0.1);
			var d = Math.abs((sim.state.fly.x - f.cx) * f.nx + (sim.state.fly.z - f.cz) * f.nz);
			closest = Math.min(closest, d);
			var r = sim.trace[sim.trace.length - 1];
			if (silk < 0) { peakThreat = Math.max(peakThreat, r.threatOut); peakVpn = Math.max(peakVpn, r.vpnL + r.vpnR); }
		}
		return { silk: silk, closest: closest, peakThreat: peakThreat, peakVpn: peakVpn };
	};
	var seen = [], blind = [];
	[2, 3, 4].forEach(function (seed) { seen.push(run(false, seed)); blind.push(run(true, seed)); });
	var sum = function (a, k) { return a.reduce(function (t, x) { return t + x[k]; }, 0); };
	assertTrue(sum(seen, 'peakThreat') > sum(blind, 'peakThreat') + 0.5, 'visible web raises the loom-ranked DN readout before contact');
	assertTrue(sum(seen, 'peakVpn') > sum(blind, 'peakVpn'), 'loom proxy activity depends on the visual input');
	var contacts = function (a) { return a.filter(function (x) { return x.silk >= 0; }).length; };
	assertTrue(contacts(seen) < contacts(blind) || sum(seen, 'closest') > sum(blind, 'closest'),
		'seeing the web keeps the fly farther from it (contacts ' + contacts(seen) + ' vs ' + contacts(blind) + ')');
};

// The brain drawn inside the fly asks the worker for its fire state. That
// must never change what the brain does.
var test_integration_fire_state_is_display_only = function () {
	var watched = WorldIntegration.sim({ seed: 7, wantFireState: function () { return true; } });
	watched.runSeconds(4);
	var plain = WorldIntegration.sim({ seed: 7 });
	plain.runSeconds(4);
	assertEqual(watched.fingerprint(), plain.fingerprint(), 'requesting spikes leaves the run unchanged');
	var r = watched.lastResult, fired = 0;
	assertTrue(r.fireState && r.fireState.length === watched.backend.worker.ready.neuronCount, 'fire state covers every neuron');
	for (var i = 0; i < r.fireState.length; i++) fired += r.fireState[i];
	assertEqual(fired, r.firedNeurons, 'fire state holds exactly the step\'s spikes (one tick per step)');
	assertTrue(!plain.lastResult.fireState, 'no fire state unless requested');
};

var test_integration_neuron_positions_match_the_connectome_and_anatomy = function () {
	var H = WorldIntegration.H.harness;
	var loaded = H.loadPositions();
	assertTrue(loaded, 'data/neuron_positions.* present (python3 scripts/build_neuron_positions.py)');
	var p = WorldBrainAdapter.parsePositions(loaded.buffer);
	var b = WorldIntegration.backend(), ready = b.worker.ready;
	var check = WorldBrainAdapter.validatePositions(p, loaded.manifest, ready, { 'connectome.bin.gz': H.sha256('connectome.bin.gz') });
	assertTrue(check.ok, 'positions were built from this connectome: ' + check.detail);
	var sidecar = WorldIntegration.H.loadAssets().sidecar;
	var meta = WorldIntegration.H.loadAssets().meta;
	var gid = {};
	meta.groups.forEach(function (g) { gid[g.name] = g.id; });
	var s2o = ready.sortedToOriginal, f = [0, 0, 0];
	// mean body-frame position of a list of sorted indices
	function mean(list) {
		var m = [0, 0, 0];
		for (var i = 0; i < list.length; i++) {
			WorldBrainAdapter.brainFramePosition(p, s2o[list[i]], f);
			m[0] += f[0]; m[1] += f[1]; m[2] += f[2];
		}
		return m.map(function (v) { return v / list.length; });
	}
	function sideList(code) {
		var out = [];
		for (var s = 0; s < ready.neuronCount; s++) if (sidecar.side[s2o[s]] === code) out.push(s);
		return out;
	}
	var pops = b.popsInfo.pops, groups = b.popsInfo.groups;
	assertTrue(mean(sideList(1))[2] < -0.1 && mean(sideList(2))[2] > 0.1, 'neurons annotated left sit on the fly\'s left');
	assertTrue(mean(pops.PHOTORECEPTOR_L)[2] < -0.3 && mean(pops.PHOTORECEPTOR_R)[2] > 0.3, 'photoreceptors sit out at the eyes, on their own side');
	assertTrue(mean(pops.ORN_FOOD_L)[2] < mean(pops.ORN_FOOD_R)[2], 'left antennal lobe input is left of the right one');
	assertTrue(groups.MB_KC.length > 0 && groups.GNG_DESC.length > 0, 'reference groups populated');
	assertTrue(mean(groups.MB_KC)[1] > mean(groups.GNG_DESC)[1], 'mushroom bodies are dorsal to the gnathal ganglia');
	assertTrue(mean(groups.OLF_ORN_FOOD)[0] > mean(groups.MB_KC)[0], 'antennal lobes are anterior to the Kenyon cells');
};

// One worker holds a brain per fly over one connectome: a brain stepped
// alongside another, in batches, follows exactly the course it takes alone.
var test_worker_brains_are_independent_and_batches_match_single_steps = function () {
	var b = WorldIntegration.backend(), p = b.popsInfo.pops;
	var base = WorldIntegration.baseline(b);
	var stimA = function () { return WorldIntegration.stim(base.concat([[p.ORN_FOOD_L, 0.2]])); };
	var stimB = function () { return WorldIntegration.stim(base.concat([[p.VPN_LOOM_PROXY_R, 0.25]])); };
	function solo(stimFn) {
		b.reset();
		var out = [];
		for (var k = 0; k < 20; k++) b.step({ brain: 0, stepId: k, stimulus: stimFn() }, function (r) { out.push(r.firedNeurons); });
		return out.join(',');
	}
	var a = solo(stimA), c = solo(stimB);
	b.reset();
	var ab = [], cb = [];
	for (var k = 0; k < 20; k++) {
		b.stepAll([{ brain: 0, stepId: k, stimulus: stimA() }, { brain: 1, stepId: k, stimulus: stimB() }], function (rs) {
			ab.push(rs[0].firedNeurons); cb.push(rs[1].firedNeurons);
			assertTrue(rs[0].brain === 0 && rs[1].brain === 1, 'results in request order');
		});
	}
	assertEqual(ab.join(','), a, 'brain 0 in a batch matches brain 0 alone');
	assertEqual(cb.join(','), c, 'brain 1 in a batch matches the same stimulus alone');
	b.resetBrain(1);
	var again = [];
	for (k = 0; k < 20; k++) b.step({ brain: 1, stepId: k, stimulus: stimB() }, function (r) { again.push(r.firedNeurons); });
	assertEqual(again.join(','), c, 'resetBrain returns one brain to rest');
	b.reset();
};

var test_integration_pair_garden_replays_exactly = function () {
	var sc = FlyWorldSim.scenarioOptions(WorldConfig, 'free');
	var sim = WorldIntegration.sim({ seed: 1, stateOptions: sc.stateOptions });
	assertEqual(sim.state.flies.length, 2, 'the default garden has two flies');
	sim.runSeconds(4);
	sim.command({ type: 'touch', params: { fly: 'fly-2', location: 'thorax' }, source: 'user' });
	sim.runSeconds(6);
	var log = sim.exportLog();
	var rep = FlyWorldSim.replay(log, sim.backend, { config: WorldConfig });
	rep.runSeconds(10);
	assertEqual(rep.fingerprint(), log.finalFingerprint, 'a two-fly run (two brains, courtship) replays exactly');
};

// The default garden, seed 1: the male courts the female, they mate, and
// she lays a single egg on fermenting fruit.
var test_integration_pair_courts_mates_and_lays_one_egg = function () {
	var sc = FlyWorldSim.scenarioOptions(WorldConfig, 'free');
	var sim = WorldIntegration.sim({ seed: 1, stateOptions: sc.stateOptions });
	var ev = [];
	sim.onEvents(function (es) { es.forEach(function (e) { if (/^(mating|mated|egg-laid)$/.test(e.type)) ev.push(e); }); });
	sim.runSeconds(60);
	var mated = ev.filter(function (e) { return e.type === 'mated'; }), laid = ev.filter(function (e) { return e.type === 'egg-laid'; });
	assertTrue(mated.length >= 1, 'they mated (' + mated.length + ')');
	assertEqual(laid.length, mated.length, 'one egg per mating');
	assertEqual(sim.state.brood.length, 1, 'the egg (or larva) is in the garden');
	var e = sim.state.brood[0], f = WorldState.findById(sim.state.fruits, e.fruitId);
	assertTrue(e.parents[0] === 'fly-1' && e.parents[1] === 'fly-2', 'daughter or son of the pair');
	assertTrue(laid[0].data.fermenting && (!f || f.species), 'laid on fermenting fruit');
	var court = sim.agent('fly-2').trace.some(function (r) { return r.behavior === 'court'; });
	assertTrue(court || ev[0].t < 15, 'the male courted');
};

// A new adult's brain settles during the end of the pupal stage, so it
// emerges with settled readouts and joins the batch.
var test_integration_newborn_brain_settles_in_the_pupa = function () {
	var cfg = WorldConfig;
	var sim = WorldIntegration.sim({ seed: 4, stateOptions: { fruit: false, webs: false, founders: 'pair' } });
	var st = sim.state, lc = cfg.lifecycle;
	var adult = WorldState.newFly(st, cfg, { id: 'fly-3', sex: 'female', x: 40, z: 40, heading: 1, parents: ['fly-1', 'fly-2'] });
	st.nextFlyId = 4;
	st.brood.push({ id: 'fly-3', sex: 'female', stage: 'pupa', stageTime: st.time - (lc.pupaDuration - 18), laid: st.time - 80,
		x: 40, z: 40, dirX: 1, dirZ: 0, heading: 1, fruitId: null, parents: ['fly-1', 'fly-2'], adult: adult });
	sim.runSeconds(3);
	assertTrue(!sim.agent('fly-3'), 'no brain before the settling window');
	sim.runSeconds(2);
	var ag = sim.agent('fly-3');
	assertTrue(ag && ag.brain === 2 && ag.lastResult, 'the pupa\'s brain is stepping (slot ' + (ag && ag.brain) + ')');
	sim.runSeconds(14);
	var rec = WorldState.findFly(st, 'fly-3');
	assertTrue(rec && rec.born !== null, 'she emerged');
	var names = sim.backend.readoutNames, floorSet = names.some(function (n) { return ag.readout.floor[n] > 0; });
	assertTrue(floorSet, 'with settled readout baselines');
	var x0 = rec.fly.x, z0 = rec.fly.z;
	sim.runSeconds(6);
	assertTrue(st.flies.length === 3 && sim.agent('fly-3').lastResult.stepId > 0, 'and runs in the garden with her own brain');
	assertTrue(isFinite(rec.fly.x + rec.fly.z) && (Math.hypot(rec.fly.x - x0, rec.fly.z - z0) > 0 || rec.behavior.current !== 'idle'), 'she behaves');
};
}
