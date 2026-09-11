/* world-sim.js -- One garden run: world state, physics, senses, the brain
 * adapter and the behavior policy, scheduled by SimulationClock.
 *
 * Runs identically in the browser (asynchronous Worker backend) and in Node
 * (synchronous harness backend), which is how tests and experiments exercise
 * the production pipeline end to end.
 *
 * Neural/body schedule for block k (body steps 6k .. 6k+5):
 *   1. apply the neural result of step k-1 (readout -> motor adapter)
 *   2. update drives and choose a behavior (policy)
 *   3. sample senses at time k, encode them, request neural step k
 *   4. run six body steps with the held motor output
 * So motor output always lags its sensory input by one 100 ms step, and only
 * one neural step is ever outstanding.
 */
(function (root) {
	'use strict';

	var WS = root.WorldState;
	var TRACE_LENGTH = 600;

	function create(opts) {
		var cfg = opts.config || root.WorldConfig;
		var seed = opts.seed === undefined ? 1 : opts.seed;
		var backend = opts.backend;
		var state = opts.state ? WS.clone(opts.state) : WS.create(cfg, seed, opts.stateOptions || {});
		var A = root.WorldBrainAdapter;
		var popsInfo = backend.popsInfo || { pops: {}, groups: {} };
		var encoder = A.createEncoder(cfg, popsInfo);
		var readout = A.createReadout(cfg, backend.readoutNames, backend.readoutSizes);
		var motor = A.createMotorAdapter(cfg, { mode: opts.mode || (backend.kind === 'legacy' ? 'hybrid' : 'hybrid') });
		var clock = root.SimulationClock.create(cfg);

		var sim = {
			config: cfg,
			state: state,
			backend: backend,
			clock: clock,
			encoder: encoder,
			readout: readout,
			motor: motor,
			results: {},
			lastResult: null,
			motorOut: null,
			lastSenses: null,
			lastInputs: null,
			trace: [],
			prevFly: null,
			queue: [],
			scheduled: opts.scheduled ? opts.scheduled.slice() : [],
			triggers: opts.triggers ? opts.triggers.map(function (t) { return { event: t.event, to: t.to, cmd: t.cmd, fired: false }; }) : [],
			listeners: { neural: [], event: [] },
			wantFireState: opts.wantFireState || function () { return false; },
			log: {
				format: 'flybrain-world-log',
				version: 1,
				configVersion: cfg.version,
				coordinateVersion: cfg.coordinateVersion,
				seed: state.seed,
				mode: opts.mode || 'hybrid',
				brain: backend.kind,
				dataVersion: opts.dataVersion || null,
				synapseWeight: cfg.brain.synapseWeight,
				initialBrain: { reset: true, settleSteps: 0 },
				stateOptions: opts.stateOptions || {},
				scenario: opts.scenario || null,
				initialState: WS.serialize(state),
				interventions: []
			},
			lastEventSeq: state.eventSeq
		};

		sim.motorOut = motor.compute(readout, emptySenses(), state.drives, { s: 1 }, cfg.clock.neuralDt, state.silenced);

		/* ---------- commands ---------- */

		// Queue a command; it is applied at the start of the next body step and
		// logged with that step index so replays apply it at the same moment.
		sim.enqueue = function (cmd) {
			return new Promise(function (resolve) { sim.queue.push({ cmd: cmd, resolve: resolve }); });
		};

		// Apply immediately (between steps) -- used when paused or headless.
		// Logged at the current step, which is equivalent to applying it at the
		// start of that step's preStep.
		sim.command = function (cmd) {
			var res = WS.applyCommand(state, cfg, cmd);
			sim.log.interventions.push({ bodyStep: state.bodyStep, cmd: cmd, ok: res.ok });
			return res;
		};

		function applyQueued() {
			while (sim.scheduled.length && sim.scheduled[0].bodyStep <= state.bodyStep) {
				var s = sim.scheduled.shift();
				var sr = WS.applyCommand(state, cfg, s.cmd);
				sim.log.interventions.push({ bodyStep: state.bodyStep, cmd: s.cmd, scheduled: true, ok: sr.ok });
			}
			while (sim.queue.length) {
				var q = sim.queue.shift();
				var res = WS.applyCommand(state, cfg, q.cmd);
				sim.log.interventions.push({ bodyStep: state.bodyStep, cmd: q.cmd, ok: res.ok });
				q.resolve(res);
			}
		}

		/* ---------- neural boundary ---------- */

		// Settling: before t = 0 the brain runs `n` neural steps while the world
		// stays frozen, so the network reaches its operating regime and readout
		// baselines start from settled rates. The fly settles in clean air with
		// nothing in view (light, wind and internal state only) and is
		// introduced into the garden at t = 0, so odors and webs present at the
		// start register as stimuli rather than background. This is part of the
		// logged initial brain state.
		sim.settled = false;
		sim.settle = function (n, done) {
			n = n === undefined ? cfg.brain.settleSteps : n;
			sim.log.initialBrain = { reset: true, settleSteps: n };
			var i = 0;
			function next() {
				if (i >= n) {
					sim.settled = true;
					if (done) done();
					return;
				}
				var senses = cleanAir(root.WorldSenses.sample(state, cfg));
				var enc = encoder.encode(senses, state.drives, state.silenced);
				backend.step({
					stepId: -1 - i, stimulus: enc.stimulus, pulses: null, inputs: enc.inputs,
					drives: copyDrives(state.drives), temperature: state.env.temperature, wantFireState: false
				}, function (res) {
					readout.update(res.popSpikeCounts, res.ticks || 1, cfg.clock.neuralDt, true);
					sim.lastResult = res;
					i++;
					next();
				});
			}
			next();
		};

		function cleanAir(sn) {
			sn.odor = { left: 0, right: 0, mean: 0, trend: 0 };
			sn.taste = { sugar: 0, bitter: 0, fruitId: null };
			sn.threat = { left: 0, right: 0, webs: [] };
			return sn;
		}

		sim.canStartBlock = function () {
			if (!sim.settled) return false;
			var k = state.bodyStep / clock.stepsPerBlock;
			return k === 0 || sim.results[k - 1] !== undefined;
		};

		sim.startBlock = function () {
			var k = state.bodyStep / clock.stepsPerBlock;
			var dt = cfg.clock.neuralDt;
			if (k > 0) {
				var res = sim.results[k - 1];
				delete sim.results[k - 1];
				sim.lastResult = res;
				readout.update(res.popSpikeCounts, res.ticks || 1, dt);
				sim.motorOut = motor.compute(readout, sim.lastSenses, state.drives, state.rng, dt, state.silenced);
				FlyPolicy.updateDrives(state, cfg, dt, sim.motorOut, sim.lastSenses);
			}
			var senses = root.WorldSenses.sample(state, cfg);
			if (k > 0) FlyPolicy.decide(state, cfg, sim.motorOut, senses);
			var enc = encoder.encode(senses, state.drives, state.silenced);
			root.WorldSenses.consumePulses(state);
			sim.lastSenses = senses;
			sim.lastInputs = enc.inputs;
			state.neuralStep = k + 1;
			for (var w = 0; w < senses.threat.webs.length; w++) {
				var ws = senses.threat.webs[w];
				var web = WS.findById(state.webs, ws.id);
				if (web) web.sensed = ws.intensity;
			}
			var record = traceRecord(k, senses, enc.inputs);
			sim.trace.push(record);
			if (sim.trace.length > TRACE_LENGTH) sim.trace.shift();
			for (var i = 0; i < sim.listeners.neural.length; i++) sim.listeners.neural[i](record);

			backend.step({
				stepId: k,
				stimulus: enc.stimulus,
				pulses: enc.pulses,
				inputs: enc.inputs,
				drives: copyDrives(state.drives),
				temperature: state.env.temperature,
				wantFireState: sim.wantFireState()
			}, function (result) { sim.results[k] = result; });
		};

		function traceRecord(k, senses, inputs) {
			var m = sim.motorOut, r = readout.rates;
			return {
				k: k, t: state.time,
				odorL: senses.odor.left, odorR: senses.odor.right,
				threatL: senses.threat.left, threatR: senses.threat.right,
				sugar: senses.taste.sugar, touch: Math.max(senses.touch.left, senses.touch.right, senses.touch.silkLeft, senses.touch.silkRight),
				inOdorL: inputs.odorL, inOdorR: inputs.odorR, inThreatL: inputs.threatL, inThreatR: inputs.threatR, inSugar: inputs.sugar,
				ornL: r.ORN_FOOD_L || 0, ornR: r.ORN_FOOD_R || 0,
				vpnL: r.VPN_LOOM_PROXY_L || 0, vpnR: r.VPN_LOOM_PROXY_R || 0,
				dnOdor: ((r.DN_ODOR_RANKED_L || 0) + (r.DN_ODOR_RANKED_R || 0)) * 0.5,
				dnLoomL: r.DN_LOOM_RANKED_L || 0, dnLoomR: r.DN_LOOM_RANKED_R || 0,
				prob: r.MN_PROBOSCIS || 0,
				walkDrive: m.walkDrive, turn: m.turn, escape: m.escape, proboscis: m.proboscis,
				odorResponse: m.odorResponse, threatOut: m.threat, mThreatL: m.threatL, mThreatR: m.threatR,
				lh: ((r.LH_NEURON_L || 0) + (r.LH_NEURON_R || 0)) * 0.5, dn: ((r.DN_L || 0) + (r.DN_R || 0)) * 0.5,
				contributions: m.contributions, dominantTurn: m.dominantTurn,
				behavior: state.behavior.current,
				hunger: state.drives.hunger, fear: state.drives.fear,
				x: state.fly.x, z: state.fly.z, y: state.fly.y, heading: state.fly.heading
			};
		}

		/* ---------- body step ---------- */

		// Commands apply before the neural boundary of the step they are logged
		// at, both live and in replay.
		sim.preStep = applyQueued;

		sim.bodyStep = function () {
			var dt = cfg.clock.bodyDt;
			var f = state.fly;
			sim.prevFly = { x: f.x, y: f.y, z: f.z, heading: f.heading };
			var cmd = FlyPolicy.bodyCommand(state, cfg, sim.motorOut, sim.lastSenses || emptySenses());
			var contacts = root.WorldPhysics.step(state, cfg, cmd, dt);
			handleContacts(contacts);
			FlyPolicy.feedStep(state, cfg, dt);
			WS.updateFruit(state, cfg, dt);
			if (state.env.gust && state.time >= state.env.gust.until) state.env.gust = null;
			state.time = Math.round((state.time + dt) * 1e9) / 1e9;
			state.bodyStep++;
			if (state.eventSeq !== sim.lastEventSeq) {
				var fresh = state.events.filter(function (e) { return e.seq > sim.lastEventSeq; });
				sim.lastEventSeq = state.eventSeq;
				checkTriggers(fresh);
				for (var i = 0; i < sim.listeners.event.length; i++) sim.listeners.event[i](fresh);
			}
		};

		// Scenario triggers: queue a logged intervention the first time a
		// matching event happens (replays apply it from the log instead).
		function checkTriggers(events) {
			for (var t = 0; t < sim.triggers.length; t++) {
				var tr = sim.triggers[t];
				if (tr.fired) continue;
				for (var e = 0; e < events.length; e++) {
					var ev = events[e];
					if (ev.type === tr.event && (!tr.to || ev.data.to === tr.to)) {
						tr.fired = true;
						var cmd = JSON.parse(JSON.stringify(tr.cmd));
						cmd.source = 'experiment';
						sim.queue.push({ cmd: cmd, resolve: function () {} });
						break;
					}
				}
			}
		}

		function handleContacts(c) {
			var p = state.pending, fly = state.fly;
			if (c.web) {
				if (c.web.side !== 'right') p.silkL = 1;
				if (c.web.side !== 'left') p.silkR = 1;
			}
			for (var i = 0; i < c.solid.length; i++) {
				var s = c.solid[i];
				if (s.kind === 'fruit' || fly.mode === 'air') continue;
				if (state.time - fly.lastWallContact < 0.5) continue;
				fly.lastWallContact = state.time;
				// antenna/leg bump on the side facing the obstacle
				var b = WS.bearing(fly.heading, -s.nx, -s.nz);
				if (b > 0.3) p.touchL = Math.max(p.touchL, 0.25);
				else if (b < -0.3) p.touchR = Math.max(p.touchR, 0.25);
				else { p.touchL = Math.max(p.touchL, 0.2); p.touchR = Math.max(p.touchR, 0.2); }
				WS.logEvent(state, 'bump', { kind: s.kind, id: s.id }, 'world');
			}
			if (c.tookOff) WS.logEvent(state, 'takeoff', {}, 'fly');
			if (c.landed) WS.logEvent(state, 'landed', {}, 'fly');
		}

		/* ---------- driving the run ---------- */

		sim.advance = function (realDt) { return clock.advance(realDt, sim); };

		// Headless helper: run for `seconds` of simulated time (sync backend).
		sim.runSeconds = function (seconds, onStep) {
			var n = Math.round(seconds / cfg.clock.bodyDt);
			for (var i = 0; i < n; i++) {
				clock.runSteps(1, sim);
				if (onStep) onStep(sim);
			}
		};

		sim.onNeural = function (fn) { sim.listeners.neural.push(fn); };
		sim.onEvents = function (fn) { sim.listeners.event.push(fn); };

		sim.setMode = function (m) {
			motor.setMode(m);
			sim.log.mode = m;
			WS.logEvent(state, 'mode', { mode: m }, 'user');
		};

		// Interpolated fly pose for rendering.
		sim.renderPose = function () {
			var f = state.fly, p = sim.prevFly || f, a = clock.alpha();
			var dh = WS.normalizeAngle(f.heading - p.heading);
			return { x: p.x + (f.x - p.x) * a, y: p.y + (f.y - p.y) * a, z: p.z + (f.z - p.z) * a, heading: p.heading + dh * a };
		};

		// Compact numeric fingerprint for determinism checks.
		sim.fingerprint = function () {
			var f = state.fly;
			var parts = [state.bodyStep, f.x.toFixed(6), f.z.toFixed(6), f.y.toFixed(6), f.heading.toFixed(6),
				state.behavior.current, state.drives.hunger.toFixed(6), state.drives.fear.toFixed(6)];
			for (var i = 0; i < state.fruits.length; i++) parts.push(state.fruits[i].id + ':' + state.fruits[i].amount.toFixed(6));
			return parts.join('|');
		};

		sim.exportLog = function () {
			var l = JSON.parse(JSON.stringify(sim.log));
			l.finalFingerprint = sim.fingerprint();
			l.finalBodyStep = state.bodyStep;
			return l;
		};

		return sim;
	}

	function copyDrives(d) { var c = {}; for (var k in d) c[k] = d[k]; return c; }

	function emptySenses() {
		return {
			odor: { left: 0, right: 0, mean: 0, trend: 0 },
			taste: { sugar: 0, bitter: 0, fruitId: null },
			threat: { left: 0, right: 0, webs: [] },
			touch: { left: 0, right: 0, silkLeft: 0, silkRight: 0, location: null, nociception: false },
			wind: { left: 0, right: 0, strength: 0, sourceBearing: 0, gust: false },
			light: { left: 1, right: 1, level: 1 },
			temperature: 0.5
		};
	}

	// Re-runs a logged run: same seed, config, options and interventions at
	// the same body steps, from a freshly reset brain.
	function replay(log, backend, extra) {
		extra = extra || {};
		var scheduled = log.interventions.filter(function (i) { return i.ok !== false; })
			.map(function (i) { return { bodyStep: i.bodyStep, cmd: i.cmd }; });
		backend.reset();
		var sim = create({
			config: extra.config, seed: log.seed, backend: backend, mode: log.mode,
			state: log.initialState ? root.WorldState.deserialize(log.initialState) : undefined,
			stateOptions: log.stateOptions, scheduled: scheduled, dataVersion: log.dataVersion, scenario: log.scenario,
			wantFireState: extra.wantFireState
		});
		sim.settle(log.initialBrain && log.initialBrain.settleSteps !== undefined ? log.initialBrain.settleSteps : 0, extra.onSettled);
		return sim;
	}

	// Expands a named scenario into create() options.
	function scenarioOptions(cfg, name, overrides) {
		var sc = cfg.scenarios[name] || cfg.scenarios.free;
		var o = overrides || {};
		var stateOptions = JSON.parse(JSON.stringify(sc.stateOptions || {}));
		if (o.drives) { stateOptions.drives = stateOptions.drives || {}; for (var k in o.drives) stateOptions.drives[k] = o.drives[k]; }
		var scheduled = (sc.at || []).map(function (a) {
			var cmd = JSON.parse(JSON.stringify(a.cmd));
			cmd.source = 'experiment';
			return { bodyStep: Math.round(a.t / cfg.clock.bodyDt), cmd: cmd };
		});
		return { scenario: name, stateOptions: stateOptions, scheduled: scheduled, triggers: sc.triggers || [] };
	}

	root.FlyWorldSim = { create: create, replay: replay, emptySenses: emptySenses, scenarioOptions: scenarioOptions };
})(typeof window !== 'undefined' ? window : globalThis);
