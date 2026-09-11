#!/usr/bin/env node
// Garden experiments (FLY-WORLD-PLAN, "Demonstrate emergence with experiments").
//
// Runs each experiment in the plan's table across repeated seeds with the
// production pipeline (world modules + real sim-worker.js + data/), and
// reports distributions (median and interquartile range), never a single
// chosen trajectory. These are measurements of this model, not claims about
// real flies.
//
// Usage: node tools/world-experiments.js [--seeds 10] [--out docs] [--only name,...]
// Writes <out>/world-experiments.md and <out>/world-experiments.json.
'use strict';

var fs = require('fs');
var path = require('path');
var W = require('../tests/load-world');
W.loadWorld();

var args = process.argv.slice(2);
function opt(name, dflt) { var i = args.indexOf('--' + name); return i === -1 ? dflt : args[i + 1]; }
var NSEEDS = parseInt(opt('seeds', '10'), 10);
var outDir = opt('out', path.join(W.ROOT, 'docs'));
var ONLY = opt('only', '') ? opt('only', '').split(',') : null;
var SEEDS = [];
for (var s = 1; s <= NSEEDS; s++) SEEDS.push(s);

if (!W.harness.hasConnectomeData() || !W.harness.loadSidecar()) {
	console.error('Requires data/connectome.bin.gz, data/neuron_meta.json and the neuron sidecar (scripts/build_neuron_sidecar.py).');
	process.exit(1);
}

var cfg = WorldConfig;
var worker = W.harness.createWorker();

/* ---------- running ---------- */

// Runs one simulation. opts: scenario, seed, mode, seconds, drives,
// stateOptions (merged over the scenario), setup(sim), perStep(sim, rec).
function run(opts) {
	var sc = FlyWorldSim.scenarioOptions(cfg, opts.scenario || 'free', { drives: opts.drives });
	if (opts.stateOptions) for (var k in opts.stateOptions) sc.stateOptions[k] = opts.stateOptions[k];
	var backend = W.connectomeBackend({ worker: worker });
	backend.reset();
	var sim = FlyWorldSim.create({ config: cfg, seed: opts.seed, backend: backend, mode: opts.mode || 'hybrid',
		stateOptions: sc.stateOptions, scheduled: sc.scheduled, triggers: sc.triggers, scenario: opts.scenario });
	if (opts.setup) opts.setup(sim);
	sim.settle();
	var m = { events: [], firstContact: -1, firstFeed: -1, startles: 0, flights: 0, silk: 0, interruptions: 0, nearFruit: 0, steps: 0, walkSteps: 0 };
	sim.onEvents(function (evs) {
		evs.forEach(function (e) {
			if (e.type === 'bump') return;
			m.events.push(e);
			if (e.type === 'behavior') {
				if (e.data.to === 'startle') m.startles++;
				if (e.data.to === 'fly') m.flights++;
				if (e.data.to === 'feed' && m.firstFeed < 0) m.firstFeed = e.t;
				if (e.data.from === 'feed' && /defensive|escape/.test(e.data.reason || '')) m.interruptions++;
				if (e.data.from === 'feed' && e.data.to === 'startle') m.interruptions++;
			}
			if (e.type === 'silk-contact') m.silk++;
		});
	});
	sim.onNeural(function (rec) {
		m.steps++;
		if (rec.sugar > 0 && m.firstContact < 0) m.firstContact = rec.t;
		if (rec.behavior === 'walk') m.walkSteps++;
		var st = sim.state;
		for (var i = 0; i < st.fruits.length; i++) {
			var f = st.fruits[i];
			if (WorldState.isEdible(f) && Math.hypot(f.x - st.fly.x, f.z - st.fly.z) < 3) { m.nearFruit++; break; }
		}
		if (opts.perStep) opts.perStep(sim, rec, m);
	});
	sim.runSeconds(opts.seconds || 60);
	m.intake = sim.state.intake.total;
	m.finalHunger = sim.state.drives.hunger;
	m.timeNearFruit = m.nearFruit * cfg.clock.neuralDt;
	m.sim = sim;
	return m;
}

/* ---------- statistics ---------- */

function quantile(sorted, q) {
	if (!sorted.length) return NaN;
	var pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function summarize(values) {
	var v = values.filter(function (x) { return x !== null && isFinite(x); }).sort(function (a, b) { return a - b; });
	return { n: values.length, valid: v.length, median: quantile(v, 0.5), q1: quantile(v, 0.25), q3: quantile(v, 0.75), values: values };
}
function fmtS(sm, d, unit) {
	d = d === undefined ? 2 : d;
	if (!sm.valid) return 'none (0/' + sm.n + ')';
	var s = sm.median.toFixed(d) + ' [' + sm.q1.toFixed(d) + '–' + sm.q3.toFixed(d) + ']' + (unit || '');
	if (sm.valid < sm.n) s += ' (' + sm.valid + '/' + sm.n + ')';
	return s;
}
function lat(x) { return x >= 0 ? x : null; }

var results = { generated: new Date().toISOString(), seeds: SEEDS, synapseWeight: cfg.brain.synapseWeight, experiments: {} };
var md = [];
function want(name) { return !ONLY || ONLY.indexOf(name) !== -1; }
function log(msg) { console.error(msg); }

/* ---------- 1. hungry versus satiated ---------- */

if (want('hunger')) {
	log('experiment: hungry vs satiated');
	var ex1 = { rows: [] };
	['hybrid', 'connectome'].forEach(function (mode) {
		['hungry', 'satiated'].forEach(function (scn) {
			var runs = SEEDS.map(function (seed) { return run({ scenario: scn, seed: seed, mode: mode, seconds: 60 }); });
			ex1.rows.push({ mode: mode, scenario: scn,
				contactLatency: summarize(runs.map(function (r) { return lat(r.firstContact); })),
				feedLatency: summarize(runs.map(function (r) { return lat(r.firstFeed); })),
				intake: summarize(runs.map(function (r) { return r.intake; })),
				nearFruit: summarize(runs.map(function (r) { return r.timeNearFruit; })),
				fed: runs.filter(function (r) { return r.firstFeed >= 0; }).length });
		});
	});
	results.experiments.hunger = ex1;
	md.push('## 1. Hungry versus satiated');
	md.push('');
	md.push('Same garden and seeds (' + SEEDS.length + '), starting hunger 0.9 vs 0.05, 60 s each. Hunger changes olfactory and gustatory gain in the encoder and drives the DRIVE_HUNGER neurons; nothing else differs.');
	md.push('');
	md.push('| Steering | Fly | Runs that fed | First sugar contact (s) | First feeding (s) | Intake (portions) | Time within 3 BL of fruit (s) |');
	md.push('|---|---|---:|---|---|---|---|');
	ex1.rows.forEach(function (r) {
		md.push('| ' + r.mode + ' | ' + r.scenario + ' | ' + r.fed + '/' + SEEDS.length + ' | ' + fmtS(r.contactLatency, 1) + ' | ' + fmtS(r.feedLatency, 1) + ' | ' + fmtS(r.intake) + ' | ' + fmtS(r.nearFruit, 1) + ' |');
	});
	md.push('');
}

/* ---------- 2. fruit beside a web ---------- */

if (want('web')) {
	log('experiment: fruit beside a web');
	var webA = cfg.webs.filter(function (w) { return w.id === 'web-a'; })[0];
	var ex2 = { rows: [] };
	[0.8, 0.4].forEach(function (hunger) {
		['webPatch', 'webPatchNoWeb'].forEach(function (scn) {
			var runs = SEEDS.map(function (seed) {
				var closest = 1e9, passedNear = false;
				var r = run({ scenario: scn, seed: seed, seconds: 60, drives: { hunger: hunger }, perStep: function (sim) {
					var d = Math.hypot(sim.state.fly.x - webA.x, sim.state.fly.z - webA.z);
					closest = Math.min(closest, d);
					if (d < 4) passedNear = true;
				} });
				r.closestWeb = closest; r.passedNear = passedNear;
				return r;
			});
			ex2.rows.push({ scenario: scn, hunger: hunger,
				closest: summarize(runs.map(function (r) { return r.closestWeb; })),
				startles: summarize(runs.map(function (r) { return r.startles; })),
				interruptions: summarize(runs.map(function (r) { return r.interruptions; })),
				silk: summarize(runs.map(function (r) { return r.silk; })),
				intake: summarize(runs.map(function (r) { return r.intake; })),
				fed: runs.filter(function (r) { return r.firstFeed >= 0; }).length,
				nearRoute: runs.filter(function (r) { return r.passedNear; }).length });
		});
	});
	results.experiments.web = ex2;
	md.push('## 2. Fruit beside a web');
	md.push('');
	md.push('Only the apple patch has fruit; web A hangs across the direct route from the clearing. "No webs" removes both webs. Distances are to web A\'s centre position, measured in both conditions.');
	md.push('');
	md.push('| Condition | Hunger | Runs that fed | Intake | Closest approach to web A (BL) | Came within 4 BL | Startles | Feeding interruptions | Silk contacts |');
	md.push('|---|---:|---:|---|---|---:|---|---|---|');
	ex2.rows.forEach(function (r) {
		md.push('| ' + (r.scenario === 'webPatch' ? 'web present' : 'no webs') + ' | ' + r.hunger + ' | ' + r.fed + '/' + SEEDS.length + ' | ' + fmtS(r.intake) + ' | ' + fmtS(r.closest, 1) + ' | ' +
			r.nearRoute + '/' + SEEDS.length + ' | ' + fmtS(r.startles, 0) + ' | ' + fmtS(r.interruptions, 0) + ' | ' + fmtS(r.silk, 0) + ' |');
	});
	md.push('');
}

/* ---------- 3. hidden versus visible web ---------- */

if (want('visibility')) {
	log('experiment: hidden vs visible web');
	var ex3 = { rows: [] };
	['visibleWeb', 'hiddenWeb'].forEach(function (scn) {
		var runs = SEEDS.map(function (seed) {
			var peak = { input: 0, vpn: 0, loom: 0, vis: 0 };
			var r = run({ scenario: scn, seed: seed, seconds: 3, perStep: function (sim, rec) {
				if (rec.t > 1.5) return;
				peak.input = Math.max(peak.input, rec.inThreatL + rec.inThreatR);
				peak.vpn = Math.max(peak.vpn, (rec.vpnL + rec.vpnR) * 50);
				peak.loom = Math.max(peak.loom, rec.mThreatL + rec.mThreatR);
				var w = sim.lastSenses.threat.webs.filter(function (x) { return x.id === 'web-b'; })[0];
				if (w) peak.vis = Math.max(peak.vis, w.visibility);
			} });
			r.peak = peak;
			return r;
		});
		ex3.rows.push({ scenario: scn,
			visibility: summarize(runs.map(function (r) { return r.peak.vis; })),
			input: summarize(runs.map(function (r) { return r.peak.input; })),
			vpn: summarize(runs.map(function (r) { return r.peak.vpn; })),
			loom: summarize(runs.map(function (r) { return r.peak.loom; })),
			startles: summarize(runs.map(function (r) { return r.startles; })) });
	});
	results.experiments.visibility = ex3;
	md.push('## 3. Hidden versus visible web');
	md.push('');
	md.push('Web B viewed from about 11 BL: from the north in the open, or from the west through vine leaves and the trellis. Peaks over the first 1.5 s.');
	md.push('');
	md.push('| View | Line of sight | Visual threat input (L+R) | LC/LPLC-proxy rate (%) | Loom-ranked DN readout (L+R) | Startles in 3 s |');
	md.push('|---|---|---|---|---|---|');
	ex3.rows.forEach(function (r) {
		md.push('| ' + (r.scenario === 'visibleWeb' ? 'open (north)' : 'behind vines (west)') + ' | ' + fmtS(r.visibility) + ' | ' + fmtS(r.input) + ' | ' + fmtS(r.vpn) + ' | ' + fmtS(r.loom) + ' | ' + fmtS(r.startles, 0) + ' |');
	});
	md.push('');
}

/* ---------- 4. recover after a threat ---------- */

if (want('recover')) {
	log('experiment: recover after a threat');
	var runs4 = SEEDS.map(function (seed) {
		var removal = -1, fearClear = -1, peakFear = 0, walkAfter = 0, stepsAfter = 0;
		var r = run({ scenario: 'recover', seed: seed, seconds: 60, perStep: function (sim, rec) {
			if (removal < 0) {
				var ev = sim.state.events.filter(function (e) { return e.type === 'web-removed'; })[0];
				if (ev) removal = ev.t;
			}
			peakFear = Math.max(peakFear, rec.fear);
			if (removal >= 0) {
				stepsAfter++;
				if (rec.behavior === 'walk' || rec.behavior === 'feed') walkAfter++;
				if (fearClear < 0 && rec.fear < 0.2 && rec.t > removal + 0.5) fearClear = rec.t - removal;
			}
		} });
		r.removal = removal; r.fearClear = fearClear; r.peakFear = peakFear;
		r.feedAfter = r.firstFeed >= 0 && removal >= 0 && r.firstFeed > removal ? r.firstFeed - removal : null;
		r.activeAfter = stepsAfter ? walkAfter / stepsAfter : null;
		return r;
	});
	var ex4 = {
		escaped: runs4.filter(function (r) { return r.removal >= 0; }).length,
		peakFear: summarize(runs4.map(function (r) { return r.peakFear; })),
		fearClear: summarize(runs4.map(function (r) { return r.removal >= 0 ? lat(r.fearClear) : null; })),
		feedAfter: summarize(runs4.map(function (r) { return r.feedAfter; })),
		activeAfter: summarize(runs4.map(function (r) { return r.activeAfter; })),
		startles: summarize(runs4.map(function (r) { return r.startles; }))
	};
	results.experiments.recover = ex4;
	md.push('## 4. Recover after a threat');
	md.push('');
	md.push('The fly starts facing web A; the first escape triggers a logged intervention that takes the web down. 60 s runs.');
	md.push('');
	md.push('| Measure | Median [IQR] |');
	md.push('|---|---|');
	md.push('| Runs with an escape (web removed) | ' + ex4.escaped + '/' + SEEDS.length + ' |');
	md.push('| Peak modeled fear | ' + fmtS(ex4.peakFear) + ' |');
	md.push('| Seconds from removal until fear < 0.2 | ' + fmtS(ex4.fearClear, 1) + ' |');
	md.push('| Seconds from removal to first feeding | ' + fmtS(ex4.feedAfter, 1) + ' |');
	md.push('| Fraction of time walking or feeding after removal | ' + fmtS(ex4.activeAfter) + ' |');
	md.push('| Startles per run | ' + fmtS(ex4.startles, 0) + ' |');
	md.push('');
}

/* ---------- 5. move fruit or change wind ---------- */

// Latency (s after t0) at which a series leaves its pre-intervention band
// (mean +- 3 SD of the 2 s before t0, with an absolute floor).
function makeDetector(t0, floorAbs) {
	var pre = [], at = -1;
	return {
		push: function (t, v) {
			if (t < t0 && t >= t0 - 2) { pre.push(v); return; }
			if (t < t0 || at >= 0 || pre.length < 5) return;
			var m = pre.reduce(function (a, b) { return a + b; }, 0) / pre.length;
			var sd = Math.sqrt(pre.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / pre.length);
			if (Math.abs(v - m) > Math.max(3 * sd, floorAbs)) at = t - t0;
		},
		latency: function () { return at >= 0 ? at : null; }
	};
}

if (want('intervention')) {
	log('experiment: change wind / drop fruit');
	var ex5 = { rows: [] };
	[['breeze', 'Breeze swings to blow from the west (scenario "Move fruit, change wind")'],
		['drop', 'A fig is dropped 4 BL ahead and to the left of the fly']].forEach(function (kind) {
		var runs = SEEDS.map(function (seed) {
			var t0 = 15, dOdor = makeDetector(t0, 0.02), dLH = makeDetector(t0, 0.004), dTurn = makeDetector(t0, 0.3);
			var dropped = false;
			var r = run({ scenario: kind[0] === 'breeze' ? 'moveFruit' : 'free', seed: seed, seconds: 22,
				stateOptions: kind[0] === 'drop' ? { fruit: false } : null,
				perStep: function (sim, rec) {
					if (kind[0] === 'drop' && !dropped && rec.t >= t0 - 0.05) {
						dropped = true;
						var fl = sim.state.fly, f = WorldState.forward(fl.heading), l = WorldState.left(fl.heading);
						sim.command({ type: 'placeFruit', params: { x: fl.x + f.x * 3 + l.x * 2.5, z: fl.z + f.z * 3 + l.z * 2.5, species: 'fig' }, source: 'experiment' });
					}
					dOdor.push(rec.t, rec.odorL + rec.odorR);
					dLH.push(rec.t, rec.lh);
					dTurn.push(rec.t, rec.turn);
				} });
			return { sensed: dOdor.latency(), neural: dLH.latency(), motor: dTurn.latency() };
		});
		ex5.rows.push({ intervention: kind[0], label: kind[1],
			sensed: summarize(runs.map(function (r) { return r.sensed; })),
			neural: summarize(runs.map(function (r) { return r.neural; })),
			motor: summarize(runs.map(function (r) { return r.motor; })),
			ordered: runs.filter(function (r) { return r.sensed !== null && r.neural !== null && r.neural >= r.sensed; }).length });
	});
	results.experiments.intervention = ex5;
	md.push('## 5. Move fruit or change the wind');
	md.push('');
	md.push('Logged interventions at 15 s during exploration. Latency until each series leaves its pre-intervention band (mean ± 3 SD over the preceding 2 s): antenna odor samples, the lateral-horn readout, and the turn command. The odor field has no transport delay (an explicit approximation), so samples change on the next neural step; the neural step itself adds one 100 ms step before motor output can respond.');
	md.push('');
	md.push('| Intervention | Odor samples (s) | Lateral-horn readout (s) | Turn command (s) | Runs with samples before neural change |');
	md.push('|---|---|---|---|---:|');
	ex5.rows.forEach(function (r) {
		md.push('| ' + r.label + ' | ' + fmtS(r.sensed) + ' | ' + fmtS(r.neural) + ' | ' + fmtS(r.motor) + ' | ' + r.ordered + '/' + SEEDS.length + ' |');
	});
	md.push('');
}

/* ---------- 6. neural controls ---------- */

if (want('controls')) {
	log('experiment: neural controls');
	var ex6 = { feeding: [], threat: [], motor: null };
	// (a) hungry fly 3 BL from a fig, facing it
	['none', 'foodInput', 'threatInput', 'motorOutput'].forEach(function (ch) {
		var runs = SEEDS.map(function (seed) {
			return run({ seed: seed, seconds: 15, stateOptions: { fruit: false, webs: false, drives: { hunger: 0.9 }, start: { x: 57, z: 45, heading: 0 } },
				setup: function (sim) {
					sim.command({ type: 'placeFruit', params: { x: 60, z: 45, species: 'fig' }, source: 'experiment' });
					sim.command({ type: 'setBreeze', params: { fromX: 1, fromZ: 0, speed: 0.35 }, source: 'experiment' });
					if (ch !== 'none') sim.command({ type: 'silence', params: { channel: ch, on: true }, source: 'experiment' });
				} });
		});
		ex6.feeding.push({ silenced: ch, fed: runs.filter(function (r) { return r.firstFeed >= 0; }).length, intake: summarize(runs.map(function (r) { return r.intake; })),
			contact: runs.filter(function (r) { return r.firstContact >= 0; }).length });
	});
	// (b) walking at web A from 9 BL, connectome-only steering
	var f = WorldState.webFrame(cfg.webs[0]);
	var start = { x: f.cx - f.nx * 9, z: f.cz - f.nz * 9, heading: Math.atan2(-f.nz, f.nx) };
	['none', 'threatInput', 'foodInput'].forEach(function (ch) {
		var runs = SEEDS.map(function (seed) {
			var peak = 0, closest = 1e9;
			var r = run({ seed: seed, mode: 'connectome', seconds: 8, stateOptions: { fruit: false, start: start, drives: { hunger: 0.3 } },
				setup: function (sim) { if (ch !== 'none') sim.command({ type: 'silence', params: { channel: ch, on: true }, source: 'experiment' }); },
				perStep: function (sim, rec, m) {
					if (m.silk === 0) peak = Math.max(peak, rec.threatOut);
					closest = Math.min(closest, Math.abs((sim.state.fly.x - f.cx) * f.nx + (sim.state.fly.z - f.cz) * f.nz));
				} });
			r.peak = peak; r.closest = closest;
			return r;
		});
		ex6.threat.push({ silenced: ch, peak: summarize(runs.map(function (r) { return r.peak; })), closest: summarize(runs.map(function (r) { return r.closest; })),
			silk: runs.filter(function (r) { return r.silk > 0; }).length, startles: summarize(runs.map(function (r) { return r.startles; })) });
	});
	// (c) broad motor-output silencing: residual scripted navigation
	var runsM = SEEDS.map(function (seed) {
		var r = run({ seed: seed, seconds: 20, setup: function (sim) { sim.command({ type: 'silence', params: { channel: 'motorOutput', on: true }, source: 'experiment' }); } });
		var st = r.sim.state, s0 = cfg.fly.start;
		r.displacement = Math.hypot(st.fly.x - s0.x, st.fly.z - s0.z);
		return r;
	});
	ex6.motor = { displacement: summarize(runsM.map(function (r) { return r.displacement; })), walking: summarize(runsM.map(function (r) { return r.walkSteps / Math.max(1, r.steps); })) };
	results.experiments.controls = ex6;
	md.push('## 6. Neural controls');
	md.push('');
	md.push('**(a) Feeding.** Hungry fly (0.9) three body lengths from a fig, facing it, breeze behind it, 15 s.');
	md.push('');
	md.push('| Silenced | Runs with sugar contact | Runs that fed | Intake |');
	md.push('|---|---:|---:|---|');
	ex6.feeding.forEach(function (r) { md.push('| ' + r.silenced + ' | ' + r.contact + '/' + SEEDS.length + ' | ' + r.fed + '/' + SEEDS.length + ' | ' + fmtS(r.intake) + ' |'); });
	md.push('');
	md.push('**(b) Threat.** Fly walking at web A from 9 BL with connectome-only steering, 8 s.');
	md.push('');
	md.push('| Silenced | Peak loom-ranked DN readout before contact | Closest approach to the web plane (BL) | Runs with silk contact | Startles |');
	md.push('|---|---|---|---:|---|');
	ex6.threat.forEach(function (r) { md.push('| ' + r.silenced + ' | ' + fmtS(r.peak) + ' | ' + fmtS(r.closest, 1) + ' | ' + r.silk + '/' + SEEDS.length + ' | ' + fmtS(r.startles, 0) + ' |'); });
	md.push('');
	md.push('**(c) Broad motor-output silencing.** All neural motor terms zeroed (free garden, 20 s): displacement from the start ' + fmtS(ex6.motor.displacement, 2) + ' BL; fraction of time walking ' + fmtS(ex6.motor.walking) + '. Any displacement here would be scripted navigation that bypasses the brain.');
	md.push('');
}

/* ---------- write ---------- */

var head = [];
head.push('# Garden experiments');
head.push('');
head.push('Generated by `node tools/world-experiments.js --seeds ' + NSEEDS + '` on ' + results.generated.slice(0, 10) + '. Production world modules, the real `sim-worker.js`, synapse weight ' + cfg.brain.synapseWeight + ', steering "hybrid" (connectome readouts plus the labeled modeled odor-steering circuit) unless noted. Values are median [interquartile range] across seeds 1–' + NSEEDS + '; "(k/n)" means only k of n runs produced a value.');
head.push('');
head.push('These are measurements of this model. They are hypotheses tests of the simulation, not claims about real flies; see docs/world-model.md for what is connectome-derived and what is modeled.');
head.push('');
for (var ek in results.experiments) {
	(function strip(o) { for (var k in o) { if (o[k] && typeof o[k] === 'object') { if (k === 'sim') delete o[k]; else strip(o[k]); } } })(results.experiments[ek]);
}
fs.mkdirSync(outDir, { recursive: true });
if (!ONLY) {
	fs.writeFileSync(path.join(outDir, 'world-experiments.json'), JSON.stringify(results, null, 1) + '\n');
	fs.writeFileSync(path.join(outDir, 'world-experiments.md'), head.concat(md).join('\n') + '\n');
	log('wrote ' + path.join(outDir, 'world-experiments.md'));
} else {
	console.log(head.concat(md).join('\n'));
}
