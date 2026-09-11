/* world-sim.js -- One garden run: world state, physics, senses, the brain
 * adapter and the behavior policy, scheduled by SimulationClock.
 *
 * Runs identically in the browser (asynchronous Worker backend) and in Node
 * (synchronous harness backend), which is how tests and experiments exercise
 * the production pipeline end to end.
 *
 * Every adult fly has its own brain (a slot in the worker over the shared
 * connectome) and its own encoder, readout and motor adapter; together they
 * are its agent. All flies' brains step together, in one batch, so there is
 * still one neural step outstanding however many flies live.
 *
 * Neural/body schedule for block k (body steps 6k .. 6k+5):
 *   1. apply the neural results of step k-1 (readout -> motor adapter), per fly
 *   2. update drives and choose a behavior (policy), per fly
 *   3. sample senses at time k, encode them, request neural step k for every
 *      fly (plus the settling brains of pupae about to emerge)
 *   4. run six body steps with the held motor outputs; after each, the life
 *      cycle (courtship contact, copulation, eggs, brood, emergence)
 * So motor output always lags its sensory input by one 100 ms step, and only
 * one neural batch is ever outstanding.
 */
(function (root) {
	'use strict';

	var WS = root.WorldState;
	var TRACE_LENGTH = 600;          // neural steps kept for the watched fly
	var TRACE_LENGTH_OTHERS = 150;   // and for every other fly

	function create(opts) {
		var cfg = opts.config || root.WorldConfig;
		var seed = opts.seed === undefined ? 1 : opts.seed;
		var backend = opts.backend;
		var state = opts.state ? WS.clone(opts.state) : WS.create(cfg, seed, opts.stateOptions || {});
		var A = root.WorldBrainAdapter;
		var L = root.WorldLife;
		var popsInfo = backend.popsInfo || { pops: {}, groups: {} };
		var clock = root.SimulationClock.create(cfg);
		var mode = opts.mode || 'hybrid';

		var sim = {
			config: cfg,
			state: state,
			backend: backend,
			clock: clock,
			agents: {},
			nextBrain: 0,
			// the fly the viewer watches: its brain returns spikes for display
			// when wantFireState() says so, and it keeps the longest trace
			focus: state.flies.length ? state.flies[0].id : null,
			results: {},
			batches: {},
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
				mode: mode,
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

		/* ---------- agents: each fly's brain slot and adapter ---------- */

		// A fly's encoder, readout and motor adapter, its brain slot and its
		// latest neural data. Created for founders at the start and for each
		// new adult when its brain starts settling in the pupa.
		function agentFor(rec) {
			var a = sim.agents[rec.id];
			if (a) return a;
			a = sim.agents[rec.id] = {
				id: rec.id,
				brain: sim.nextBrain++,
				encoder: A.createEncoder(cfg, popsInfo),
				readout: A.createReadout(cfg, backend.readoutNames, backend.readoutSizes),
				motor: A.createMotorAdapter(cfg, { mode: mode }),
				motorOut: null, lastSenses: null, lastInputs: null, lastResult: null, prevFly: null, trace: []
			};
			// a fresh slot is a reset brain; releasing the slot's history
			// matters only if a backend reuses slots
			if (a.brain > 0 && backend.resetBrain) backend.resetBrain(a.brain);
			a.motorOut = a.motor.compute(a.readout, emptySenses(), rec.drives, { s: 1 }, cfg.clock.neuralDt, state.silenced);
			return a;
		}
		state.flies.forEach(agentFor);

		function primary() { return state.flies[0]; }
		function primaryAgent() { return sim.agents[primary().id]; }

		// Single-fly accessors (the first adult), kept for tools and tests
		// written before the garden held several flies.
		Object.defineProperty(sim, 'encoder', { get: function () { return primaryAgent().encoder; } });
		Object.defineProperty(sim, 'readout', { get: function () { return primaryAgent().readout; } });
		Object.defineProperty(sim, 'motor', { get: function () { return primaryAgent().motor; } });
		Object.defineProperty(sim, 'motorOut', { get: function () { return primaryAgent().motorOut; } });
		Object.defineProperty(sim, 'lastSenses', { get: function () { return primaryAgent().lastSenses; } });
		Object.defineProperty(sim, 'lastInputs', { get: function () { return primaryAgent().lastInputs; } });
		Object.defineProperty(sim, 'lastResult', { get: function () { return primaryAgent().lastResult; } });
		Object.defineProperty(sim, 'trace', { get: function () { return primaryAgent().trace; } });

		sim.agent = function (id) { return sim.agents[id] || null; };
		sim.setFocus = function (id) { if (sim.agents[id]) sim.focus = id; };

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

		function stepAll(requests, cb) {
			if (backend.stepAll) { backend.stepAll(requests, cb); return; }
			// backends that step one brain at a time (test stand-ins)
			var out = new Array(requests.length), left = requests.length;
			if (!left) { cb(out); return; }
			requests.forEach(function (r, i) {
				backend.step(r, function (res) { out[i] = res; if (--left === 0) cb(out); });
			});
		}

		// A settling brain gets a clean-air sample: light, wind and internal
		// state only, as the founders' brains settle before t = 0.
		function settleRequest(rec, stepId) {
			var a = agentFor(rec);
			var senses = cleanAir(root.WorldSenses.sample(state, cfg));
			var enc = a.encoder.encode(senses, rec.drives, state.silenced);
			a.lastSenses = senses;
			return { brain: a.brain, stepId: stepId, stimulus: enc.stimulus, pulses: null, inputs: enc.inputs,
				drives: copyDrives(rec.drives), temperature: state.env.temperature, wantFireState: false };
		}

		// Settling: before t = 0 the brains run `n` neural steps while the
		// world stays frozen, so each network reaches its operating regime and
		// readout baselines start from settled rates. The flies settle in clean
		// air with nothing in view and are introduced into the garden at
		// t = 0, so odors and webs present at the start register as stimuli
		// rather than background. This is part of the logged initial brain state.
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
				var reqs = [], recs = state.flies.slice();
				WS.eachFly(state, function (rec) { reqs.push(settleRequest(rec, -1 - i)); });
				stepAll(reqs, function (res) {
					for (var j = 0; j < recs.length; j++) {
						var a = sim.agents[recs[j].id];
						a.readout.update(res[j].popSpikeCounts, res[j].ticks || 1, cfg.clock.neuralDt, true);
						a.lastResult = res[j];
					}
					i++;
					next();
				});
			}
			next();
		};

		function cleanAir(sn) {
			sn.odor = { left: 0, right: 0, mean: 0, trend: 0 };
			sn.taste = { sugar: 0, bitter: 0, fruitId: null, fermentingId: null };
			sn.threat = { left: 0, right: 0, webs: [] };
			sn.social = emptySocial();
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
			if (k > 0) applyResults(k - 1, dt);
			var requests = [], entries = [], records = {};
			WS.eachFly(state, function (rec) {
				var a = agentFor(rec);
				var senses = root.WorldSenses.sample(state, cfg);
				if (k > 0) FlyPolicy.decide(state, cfg, a.motorOut, senses);
				var enc = a.encoder.encode(senses, rec.drives, state.silenced);
				root.WorldSenses.consumePulses(state);
				a.lastSenses = senses;
				a.lastInputs = enc.inputs;
				if (rec === primary()) {
					for (var w = 0; w < senses.threat.webs.length; w++) {
						var ws = senses.threat.webs[w];
						var web = WS.findById(state.webs, ws.id);
						if (web) web.sensed = ws.intensity;
					}
				}
				var record = traceRecord(k, rec, a, senses, enc.inputs);
				a.trace.push(record);
				var cap = rec.id === sim.focus || rec === primary() ? TRACE_LENGTH : TRACE_LENGTH_OTHERS;
				if (a.trace.length > cap) a.trace.splice(0, a.trace.length - cap);
				records[rec.id] = record;
				requests.push({ brain: a.brain, stepId: k, stimulus: enc.stimulus, pulses: enc.pulses, inputs: enc.inputs,
					drives: copyDrives(rec.drives), temperature: state.env.temperature,
					wantFireState: rec.id === sim.focus && sim.wantFireState() });
				entries.push({ id: rec.id, settle: false });
			});
			// pupae about to emerge: their adult brains settle in clean air
			L.settlingPupae(state, cfg).forEach(function (pupa) {
				var prev = WS.focus(state, pupa.adult);
				requests.push(settleRequest(pupa.adult, k));
				entries.push({ id: pupa.adult.id, settle: true });
				WS.focus(state, prev);
			});
			state.neuralStep = k + 1;
			var rec0 = records[primary().id];
			for (var i = 0; i < sim.listeners.neural.length; i++) sim.listeners.neural[i](rec0);
			sim.batches[k] = entries;
			stepAll(requests, function (results) { sim.results[k] = results; });
		};

		function applyResults(kPrev, dt) {
			var results = sim.results[kPrev], entries = sim.batches[kPrev];
			delete sim.results[kPrev];
			delete sim.batches[kPrev];
			for (var j = 0; j < entries.length; j++) {
				var a = sim.agents[entries[j].id];
				if (!a) continue;
				a.lastResult = results[j];
				a.readout.update(results[j].popSpikeCounts, results[j].ticks || 1, dt, entries[j].settle);
			}
			WS.eachFly(state, function (rec) {
				var a = sim.agents[rec.id];
				a.motorOut = a.motor.compute(a.readout, a.lastSenses || emptySenses(), rec.drives, state.rng, dt, state.silenced);
				FlyPolicy.updateDrives(state, cfg, dt, a.motorOut, a.lastSenses || emptySenses());
			});
		}

		function traceRecord(k, rec, a, senses, inputs) {
			var m = a.motorOut, r = a.readout.rates, f = rec.fly;
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
				behavior: rec.behavior.current,
				hunger: rec.drives.hunger, fear: rec.drives.fear,
				x: f.x, z: f.z, y: f.y, heading: f.heading
			};
		}

		/* ---------- body step ---------- */

		// Commands apply before the neural boundary of the step they are logged
		// at, both live and in replay.
		sim.preStep = applyQueued;

		sim.bodyStep = function () {
			var dt = cfg.clock.bodyDt;
			WS.eachFly(state, function (rec) {
				var a = agentFor(rec), f = rec.fly;
				a.prevFly = { x: f.x, y: f.y, z: f.z, heading: f.heading };
				var cmd = FlyPolicy.bodyCommand(state, cfg, a.motorOut, a.lastSenses || emptySenses());
				var contacts = root.WorldPhysics.step(state, cfg, cmd, dt);
				handleContacts(contacts);
				FlyPolicy.feedStep(state, cfg, dt);
			});
			L.step(state, cfg, dt);
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

		// Contacts of the fly in focus (state.fly, state.pending).
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
				WS.logEvent(state, 'bump', { kind: s.kind, id: s.id, fly: state.current.id }, 'world');
			}
			if (c.tookOff) WS.logEvent(state, 'takeoff', { fly: state.current.id }, 'fly');
			if (c.landed) WS.logEvent(state, 'landed', { fly: state.current.id }, 'fly');
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
			mode = m;
			for (var id in sim.agents) sim.agents[id].motor.setMode(m);
			sim.log.mode = m;
			WS.logEvent(state, 'mode', { mode: m }, 'user');
		};

		// Interpolated pose of a fly (default: the first adult) for rendering.
		sim.renderPose = function (rec) {
			rec = rec || primary();
			var f = rec.fly, a = sim.agents[rec.id], p = (a && a.prevFly) || f, al = clock.alpha();
			var dh = WS.normalizeAngle(f.heading - p.heading);
			return { x: p.x + (f.x - p.x) * al, y: p.y + (f.y - p.y) * al, z: p.z + (f.z - p.z) * al, heading: p.heading + dh * al };
		};

		// Compact numeric fingerprint for determinism checks. With one fly and
		// no brood it has the same form as before the garden held several.
		sim.fingerprint = function () {
			var parts = [state.bodyStep];
			state.flies.forEach(function (r, i) {
				var f = r.fly;
				if (i > 0) parts.push(r.id);
				parts.push(f.x.toFixed(6), f.z.toFixed(6), f.y.toFixed(6), f.heading.toFixed(6), r.behavior.current,
					r.drives.hunger.toFixed(6), r.drives.fear.toFixed(6));
			});
			for (var b = 0; b < state.brood.length; b++) parts.push(state.brood[b].id + ':' + state.brood[b].stage);
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

	function emptySocial() { return { females: [], song: 0, suitor: null, target: null }; }

	function emptySenses() {
		return {
			odor: { left: 0, right: 0, mean: 0, trend: 0 },
			taste: { sugar: 0, bitter: 0, fruitId: null, fermentingId: null },
			threat: { left: 0, right: 0, webs: [] },
			touch: { left: 0, right: 0, silkLeft: 0, silkRight: 0, location: null, nociception: false },
			wind: { left: 0, right: 0, strength: 0, sourceBearing: 0, gust: false },
			light: { left: 1, right: 1, level: 1 },
			temperature: 0.5,
			social: emptySocial()
		};
	}

	// Re-runs a logged run: same seed, config, options and interventions at
	// the same body steps, from freshly reset brains.
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
		if (o.founders !== undefined) stateOptions.founders = o.founders;
		var scheduled = (sc.at || []).map(function (a) {
			var cmd = JSON.parse(JSON.stringify(a.cmd));
			cmd.source = 'experiment';
			return { bodyStep: Math.round(a.t / cfg.clock.bodyDt), cmd: cmd };
		});
		return { scenario: name, stateOptions: stateOptions, scheduled: scheduled, triggers: sc.triggers || [] };
	}

	root.FlyWorldSim = { create: create, replay: replay, emptySenses: emptySenses, scenarioOptions: scenarioOptions };
})(typeof window !== 'undefined' ? window : globalThis);
