#!/usr/bin/env node
// Connectome baseline (FLY-WORLD-PLAN phase 1).
//
// Runs the production sim-worker.js on the real data through the production
// sensory encoder, and records:
//   1. asset validation (counts, index order, hashes) and the group audit
//   2. a synaptic-weight calibration scan (stability and response size)
//   3. pathway evidence at the configured weight: effect sizes and laterality
//      for each sensory pathway the garden uses, or an explicit limitation
//
// Usage: node tools/connectome-baseline.js [--quick] [--out docs] [--weight w] [--no-scan]
// Writes <out>/connectome-baseline.md and <out>/connectome-baseline.json.
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var W = require('../tests/load-world');
W.loadWorld();
var H = W.harness;

var args = process.argv.slice(2);
var QUICK = args.indexOf('--quick') !== -1;
var outDir = args.indexOf('--out') !== -1 ? args[args.indexOf('--out') + 1] : path.join(W.ROOT, 'docs');
var SETTLE = QUICK ? 80 : 150;
var MEASURE = QUICK ? 80 : 200;

if (!H.hasConnectomeData()) {
	console.error('data/connectome.bin.gz and data/neuron_meta.json are required (see docs/world-model.md, "Data provisioning").');
	process.exit(1);
}

var assets = W.loadAssets();
var meta = assets.meta, manifest = assets.manifest;
var worker = H.createWorker();
var report = { generated: new Date().toISOString(), node: process.version, quick: QUICK };

/* ---------- 1. assets and audit ---------- */

var hashes = { 'connectome.bin.gz': H.sha256('connectome.bin.gz') };
var validation = WorldBrainAdapter.validateAssets({ meta: meta, ready: worker.ready, manifest: manifest, sidecar: assets.sidecar, hashes: hashes });
report.assets = {
	neurons: worker.ready.neuronCount, edges: worker.ready.edgeCount, maxAbsWeight: worker.ready.maxAbsWeight,
	hashes: { connectome: hashes['connectome.bin.gz'], neuronMeta: H.sha256('neuron_meta.json'),
		sidecar: fs.existsSync(H.dataPath('neuron_sidecar.bin.gz')) ? H.sha256('neuron_sidecar.bin.gz') : null },
	sidecarVersion: manifest ? manifest.version : null,
	validation: validation
};
report.groups = meta.groups.map(function (g) { return { name: g.name, region: g.region, neurons: g.neuron_count }; });
report.emptyGroups = meta.groups.filter(function (g) { return g.neuron_count === 0; }).map(function (g) { return g.name; });
report.populations = manifest ? manifest.populations.map(function (p) {
	return { name: p.name, count: p.count, left: p.count_left, right: p.count_right, provenance: p.provenance };
}) : [];
report.auditNotes = manifest ? manifest.audit.notes : [];

/* ---------- helpers ---------- */

function backend(weight) {
	var b = W.connectomeBackend({ worker: worker, synapseWeight: weight });
	b.reset();
	return b;
}

var DRIVES = { hunger: 0.6, fear: 0, fatigue: 0, curiosity: 0.5, groom: 0.1 };

function senses(cond) {
	var s = FlyWorldSim.emptySenses();
	s.wind.left = 0.14; s.wind.right = 0.09; s.wind.strength = 0.23;   // enclosure breeze
	s.light.left = s.light.right = s.light.level = 1;
	switch (cond) {
	case 'odor': s.odor.left = s.odor.right = 2.0; break;
	case 'odorL': s.odor.left = 2.0; break;
	case 'odorR': s.odor.right = 2.0; break;
	case 'sugar': s.taste.sugar = 0.9; s.taste.fruitId = 'probe'; break;
	case 'loomL': s.threat.left = 1.0; break;
	case 'loomR': s.threat.right = 1.0; break;
	case 'touchL': s.touch.left = 0.6; break;
	case 'touchR': s.touch.right = 0.6; break;
	case 'windL': s.wind.left = 0.9; s.wind.right = 0.1; s.wind.strength = 1; break;
	case 'windR': s.wind.left = 0.1; s.wind.right = 0.9; s.wind.strength = 1; break;
	case 'dark': s.light.left = s.light.right = s.light.level = 0; break;
	}
	return s;
}

// Settle on the idle senses, then present `cond`; returns per-readout mean
// and tick-to-tick sd of the population rate over the measurement window,
// plus mean compute time per tick.
function measure(b, cond) {
	b.reset();
	var enc = WorldBrainAdapter.createEncoder(WorldConfig, b.popsInfo);
	var names = b.readoutNames, sizes = b.readoutSizes;
	var sum = new Float64Array(names.length), sq = new Float64Array(names.length), ms = 0, fired = 0;
	var series = names.map(function () { return []; });
	var step = 0;
	function run(c, n, record) {
		for (var i = 0; i < n; i++) {
			var e = enc.encode(senses(c), DRIVES, {});
			var r = null;
			b.step({ stepId: step++, stimulus: e.stimulus, pulses: null }, function (x) { r = x; });
			if (record) {
				for (var k = 0; k < names.length; k++) { var v = r.popSpikeCounts[k] / sizes[k]; sum[k] += v; sq[k] += v * v; series[k].push(v); }
				ms += r.computeMs; fired += r.firedNeurons;
			}
		}
	}
	run('idle', SETTLE, false);
	run(cond, 20, false);
	run(cond, MEASURE, true);
	var out = { _ms: ms / MEASURE, _fired: fired / MEASURE / worker.ready.neuronCount };
	names.forEach(function (n, k) {
		var m = sum[k] / MEASURE;
		out[n] = { mean: m, sd: Math.sqrt(Math.max(0, sq[k] / MEASURE - m * m)), series: series[k] };
	});
	return out;
}

// Effect size on block means of `len` ticks: the variability a readout that
// integrates over that window actually sees.
function blockStats(values, len) {
	var means = [];
	for (var i = 0; i + len <= values.length; i += len) {
		var t = 0;
		for (var j = 0; j < len; j++) t += values[i + j];
		means.push(t / len);
	}
	var m = means.reduce(function (a, b) { return a + b; }, 0) / means.length;
	var sd = Math.sqrt(means.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / means.length);
	return { mean: m, sd: sd };
}
function effectBlock(stim, idle, key, len) {
	var a = blockStats(stim[key].series, len), b = blockStats(idle[key].series, len);
	return b.sd > 0 ? (a.mean - b.mean) / b.sd : (a.mean > b.mean ? Infinity : 0);
}

function pair(r, base) { return (r[base + '_L'] ? r[base + '_L'].mean : 0) + (r[base + '_R'] ? r[base + '_R'].mean : 0); }
function pairSd(r, base) { return Math.sqrt(Math.pow(r[base + '_L'] ? r[base + '_L'].sd : 0, 2) + Math.pow(r[base + '_R'] ? r[base + '_R'].sd : 0, 2)); }
function effect(stim, idle, key, isPair) {
	var a = isPair ? pair(stim, key) : stim[key].mean, b = isPair ? pair(idle, key) : idle[key].mean;
	var sd = isPair ? pairSd(idle, key) : idle[key].sd;
	return { idle: b, stim: a, delta: a - b, d: sd > 0 ? (a - b) / sd : (a > b ? Infinity : 0) };
}
function li(r, base) { var l = r[base + '_L'].mean, rr = r[base + '_R'].mean; return (l - rr) / Math.max(1e-9, l + rr); }

/* ---------- 2. calibration scan ---------- */

var legacyScale = 0.15 / worker.ready.maxAbsWeight;
var scanWeights = args.indexOf('--no-scan') !== -1 ? [] : (QUICK ? [legacyScale, 0.003, 0.004, 0.005] : [legacyScale, 0.0025, 0.003, 0.0035, 0.004, 0.0045, 0.005]);
report.calibration = scanWeights.map(function (w) {
	var b = backend(w);
	var idle = measure(b, 'idle'), odor = measure(b, 'odor'), loomL = measure(b, 'loomL'), sugar = measure(b, 'sugar');
	var row = {
		synapseWeight: w, legacy: w === legacyScale,
		firedFraction: idle._fired, msPerTick: idle._ms,
		dnRate: pair(idle, 'DN') / 2, dnSd: pairSd(idle, 'DN') / Math.SQRT2,
		lhIdle: pair(idle, 'LH_NEURON') / 2,
		odorLH_d: effect(odor, idle, 'LH_NEURON', true).d,
		loomDN_d: effect(loomL, idle, 'DN_LOOM_RANKED', true).d,
		loomLI: li(loomL, 'DN_LOOM_RANKED'),
		sugarProb_d: effect(sugar, idle, 'MN_PROBOSCIS', false).d
	};
	console.error('scan w=' + w.toExponential(2) + ' fired=' + (row.firedFraction * 100).toFixed(2) + '% DN=' + (row.dnRate * 100).toFixed(2) + '% odorLH d=' + row.odorLH_d.toFixed(1) +
		' loom d=' + row.loomDN_d.toFixed(1) + ' LI=' + row.loomLI.toFixed(2) + ' sugar d=' + row.sugarProb_d.toFixed(1));
	return row;
});

/* ---------- 3. pathway evidence at the configured weight ---------- */

var W0 = args.indexOf('--weight') !== -1 ? parseFloat(args[args.indexOf('--weight') + 1]) : WorldConfig.brain.synapseWeight;
var b0 = backend(W0);
var conds = ['idle', 'odor', 'odorL', 'odorR', 'sugar', 'loomL', 'loomR', 'touchL', 'touchR', 'windL', 'windR', 'dark'];
var R = {};
conds.forEach(function (c) { R[c] = measure(b0, c); console.error('measured ' + c); });

function status(ok) { return ok ? 'evidence' : 'limitation'; }
var odorLH = effect(R.odor, R.idle, 'LH_NEURON', true);
var odorPN = effect(R.odor, R.idle, 'ALPN', true);
var odorDN = effect(R.odor, R.idle, 'DN_ODOR_RANKED', true);
var odorLatLH = li(R.odorL, 'LH_NEURON') - li(R.odorR, 'LH_NEURON');
var odorLatDN = li(R.odorL, 'DN_ODOR_RANKED') - li(R.odorR, 'DN_ODOR_RANKED');
var sugar = effect(R.sugar, R.idle, 'MN_PROBOSCIS', false);
var sugarBlock = effectBlock(R.sugar, R.idle, 'MN_PROBOSCIS', 15);
var loom = effect(R.loomL, R.idle, 'DN_LOOM_RANKED', true);
var loomLat = li(R.loomL, 'DN_LOOM_RANKED') - li(R.loomR, 'DN_LOOM_RANKED');
var touch = effect(R.touchL, R.idle, 'DN_TOUCH_RANKED', true);
var touchLat = li(R.touchL, 'DN_TOUCH_RANKED') - li(R.touchR, 'DN_TOUCH_RANKED');
var wind = effect(R.windL, R.idle, 'JO_WIND', true);
var windDN = effect(R.windL, R.idle, 'DN', true);
var windLat = li(R.windL, 'DN') - li(R.windR, 'DN');
var dark = effect(R.dark, R.idle, 'DN', true);

report.evidence = [
	{ pathway: 'Food odor -> projection neurons (ORN_FOOD -> ALPN)', metric: 'effect size d', value: odorPN.d, status: status(odorPN.d > 3),
		detail: 'ALPN rate ' + pct(odorPN.idle / 2) + ' -> ' + pct(odorPN.stim / 2) },
	{ pathway: 'Food odor -> lateral horn (ORN_FOOD -> LH_NEURON)', metric: 'effect size d', value: odorLH.d, status: status(odorLH.d > 3),
		detail: 'used as the connectome odor-salience readout; LH rate ' + pct(odorLH.idle / 2) + ' -> ' + pct(odorLH.stim / 2) },
	{ pathway: 'Food odor -> descending neurons (DN_ODOR_RANKED)', metric: 'effect size d', value: odorDN.d, status: status(odorDN.d > 3),
		detail: 'weak at the motor level; not used for steering' },
	{ pathway: 'Odor side (left-only vs right-only antenna) at the lateral horn', metric: 'laterality difference', value: odorLatLH, status: status(Math.abs(odorLatLH) > 0.1),
		detail: 'bilateral receptor projections; left/right odor steering is therefore a labeled modeled circuit' },
	{ pathway: 'Odor side at descending neurons', metric: 'laterality difference', value: odorLatDN, status: status(Math.abs(odorLatDN) > 0.1), detail: '' },
	{ pathway: 'Sweet contact -> proboscis motor neurons (GRN_SUGAR -> MN_PROBOSCIS), per tick', metric: 'effect size d', value: sugar.d, status: status(sugar.d > 3),
		detail: 'MN_PROBOSCIS rate ' + pct(sugar.idle) + ' -> ' + pct(sugar.stim) + '; only 24 neurons, so single ticks are noisy' },
	{ pathway: 'Sweet contact -> proboscis motor neurons, 1.5 s blocks (the feeding readout window)', metric: 'effect size d', value: sugarBlock, status: status(sugarBlock > 3),
		detail: 'the adapter integrates MN_PROBOSCIS over ~1.5 s before feeding is permitted' },
	{ pathway: 'Web cue -> LC/LPLC-like proxy -> loom-ranked DNs', metric: 'effect size d', value: loom.d, status: status(loom.d > 3),
		detail: 'proxy population selected by neuropil connectivity, not verified cell types (VIS_LC is empty)' },
	{ pathway: 'Web cue side (left vs right eye) at loom-ranked DNs', metric: 'laterality difference', value: loomLat, status: status(loomLat > 0.1),
		detail: 'ipsilateral bias; the motor adapter turns away from the stronger side (adapter assumption)' },
	{ pathway: 'Silk/touch -> touch-ranked DNs (MECH_TOUCH -> DN_TOUCH_RANKED)', metric: 'effect size d', value: touch.d, status: status(touch.d > 3), detail: '' },
	{ pathway: 'Touch side at touch-ranked DNs', metric: 'laterality difference', value: touchLat, status: status(touchLat > 0.1), detail: '' },
	{ pathway: 'Wind -> Johnston\'s organ (JO_WIND)', metric: 'effect size d', value: wind.d, status: status(wind.d > 3), detail: 'sensory population; bracing uses this plus gust strength' },
	{ pathway: 'Wind side at descending neurons', metric: 'laterality difference', value: windLat, status: status(Math.abs(windLat) > 0.1),
		detail: 'upwind turning is a labeled modeled term' },
	{ pathway: 'Light -> descending-neuron activity (walking drive)', metric: 'effect size d (dark vs light)', value: dark.d, status: status(Math.abs(dark.d) > 1),
		detail: 'DN rate ' + pct(dark.idle / 2) + ' (light) vs ' + pct(dark.stim / 2) + ' (dark)' },
	{ pathway: 'Nociception', metric: '-', value: null, status: 'limitation', detail: 'NOCI group is empty; repeated touch is encoded as strong bristle input' }
];
report.readouts = {};
conds.forEach(function (c) {
	report.readouts[c] = {};
	b0.readoutNames.forEach(function (n) { report.readouts[c][n] = { mean: R[c][n].mean, sd: R[c][n].sd }; });
	report.readouts[c]._msPerTick = R[c]._ms;
});
report.configuredWeight = W0;

function pct(x) { return (x * 100).toFixed(2) + '%'; }
function num(x, d) { return x === null || x === undefined ? '-' : (isFinite(x) ? x.toFixed(d === undefined ? 2 : d) : 'inf'); }

/* ---------- write ---------- */

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'connectome-baseline.json'), JSON.stringify(report, null, 1) + '\n');

var md = [];
md.push('# Connectome baseline');
md.push('');
md.push('Generated by `node tools/connectome-baseline.js` on ' + report.generated.slice(0, 10) + ' (Node ' + report.node + (QUICK ? ', quick mode' : '') + ').');
md.push('Every number below comes from the production `js/sim-worker.js` running the local FlyWire export, driven through the production sensory encoder (`js/world-brain-adapter.js`). Rerun the tool after changing data, weights or the encoder.');
md.push('');
md.push('## Assets');
md.push('');
md.push('- ' + report.assets.neurons.toLocaleString('en-US') + ' neurons, ' + report.assets.edges.toLocaleString('en-US') + ' edges; largest |weight| ' + report.assets.maxAbsWeight + ' synapses.');
md.push('- connectome.bin.gz sha256 `' + report.assets.hashes.connectome + '`');
md.push('- neuron_sidecar.bin.gz sha256 `' + report.assets.hashes.sidecar + '` (format v' + report.assets.sidecarVersion + ')');
md.push('');
md.push('| Check | Result |');
md.push('|---|---|');
validation.checks.forEach(function (c) { md.push('| ' + c.name + ' | ' + (c.skipped ? 'skipped' : c.ok ? 'pass' : '**fail**') + ' |'); });
md.push('');
md.push('**Empty groups (' + report.emptyGroups.length + ' of ' + meta.group_count + '):** ' + report.emptyGroups.join(', ') + '. None are filled by assignment.');
md.push('');
md.push('### Sidecar populations');
md.push('');
md.push('| Population | Neurons | Left | Right | Provenance |');
md.push('|---|---:|---:|---:|---|');
report.populations.forEach(function (p) { md.push('| ' + p.name + ' | ' + p.count + ' | ' + p.left + ' | ' + p.right + ' | ' + p.provenance + ' |'); });
md.push('');
md.push('### Audit notes');
md.push('');
report.auditNotes.forEach(function (n) { md.push('- ' + n); });
md.push('');
md.push('## Weight calibration');
md.push('');
md.push('The legacy normalization scales the largest edge to 0.15, so one synapse contributes ' + legacyScale.toExponential(2) + ' of threshold: even a neuron receiving from all of its partners at once stays far below threshold, and nothing propagates past directly stimulated cells. The scan below uses the garden encoder on the idle senses and on single stimuli. `d` is the change in rate divided by the tick-to-tick SD of the unstimulated network.');
md.push('');
md.push('| Synapse weight | Neurons firing | DN rate (SD) | LH idle | Odor→LH d | Loom→DN d | Loom LI | Sugar→MN d | ms/tick (Node) |');
md.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
report.calibration.forEach(function (r) {
	md.push('| ' + (r.legacy ? 'legacy ' : '') + r.synapseWeight.toExponential(2) + (r.synapseWeight === W0 ? ' **(configured)**' : '') + ' | ' + pct(r.firedFraction) + ' | ' + pct(r.dnRate) + ' (' + pct(r.dnSd) + ') | ' + pct(r.lhIdle) + ' | ' +
		num(r.odorLH_d, 1) + ' | ' + num(r.loomDN_d, 1) + ' | ' + num(r.loomLI) + ' | ' + num(r.sugarProb_d, 1) + ' | ' + num(r.msPerTick, 2) + ' |');
});
md.push('');
md.push('Above about 0.005 recurrent activity rises and stimulus responses shrink relative to background; below about 0.0035 responses are small. The garden uses ' + W0 + '.');
md.push('');
md.push('## Pathway evidence (synapse weight ' + W0 + ')');
md.push('');
md.push('| Pathway | Metric | Value | Status | Notes |');
md.push('|---|---|---:|---|---|');
report.evidence.forEach(function (e) { md.push('| ' + e.pathway + ' | ' + e.metric + ' | ' + num(e.value) + ' | ' + e.status + ' | ' + e.detail + ' |'); });
md.push('');
md.push('Laterality difference = LI(left stimulus) - LI(right stimulus), where LI = (L - R) / (L + R) of the readout pair. Positive means ipsilateral.');
md.push('');
md.push('## Readout ranges');
md.push('');
md.push('Mean rate (fraction of the population firing per tick) at the configured weight.');
md.push('');
var cols = ['LH_NEURON_L', 'LH_NEURON_R', 'DN_L', 'DN_R', 'DN_LOOM_RANKED_L', 'DN_LOOM_RANKED_R', 'DN_TOUCH_RANKED_L', 'DN_TOUCH_RANKED_R', 'MN_PROBOSCIS'];
md.push('| Condition | ' + cols.join(' | ') + ' |');
md.push('|---|' + cols.map(function () { return '---:'; }).join('|') + '|');
conds.forEach(function (c) { md.push('| ' + c + ' | ' + cols.map(function (k) { return report.readouts[c][k] ? pct(report.readouts[c][k].mean) : '-'; }).join(' | ') + ' |'); });
md.push('');
fs.writeFileSync(path.join(outDir, 'connectome-baseline.md'), md.join('\n') + '\n');
console.error('wrote ' + path.join(outDir, 'connectome-baseline.md'));
