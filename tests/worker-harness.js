// Real-worker harness for Node.
//
// Loads the production js/sim-worker.js into an isolated vm context with a
// `self` shim, feeds it the real connectome binary, and exposes the worker's
// message protocol as synchronous calls. Nothing here re-implements neural
// arithmetic: every spike comes from the worker code that ships to browsers.
//
// Usage:
//   var H = require('./worker-harness');
//   var w = H.createWorker();            // loads data/connectome.bin.gz
//   w.post({type: 'step', stepId: 1});   // returns the worker's reply
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var zlib = require('zlib');

var ROOT = path.join(__dirname, '..');

function dataPath(name) {
	return path.join(ROOT, 'data', name);
}

function hasConnectomeData() {
	return fs.existsSync(dataPath('connectome.bin.gz')) && fs.existsSync(dataPath('neuron_meta.json'));
}

var cachedRaw = null;
function loadRawConnectome() {
	if (!cachedRaw) {
		var gz = fs.readFileSync(dataPath('connectome.bin.gz'));
		var raw = zlib.gunzipSync(gz);
		cachedRaw = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
	}
	// The worker keeps views into the buffer it parses; hand each instance a copy.
	return cachedRaw.slice(0);
}

function createWorker(options) {
	options = options || {};
	var outbox = [];
	var self = {
		postMessage: function (msg) { outbox.push(msg); },
		onmessage: null
	};
	var perf = { now: function () { var t = process.hrtime(); return t[0] * 1e3 + t[1] / 1e6; } };
	var noTimers = function () { /* free-running mode is not used by the harness */ };
	// The worker source is wrapped in a function so its top-level vars are
	// locals, as fast as they are in a real WorkerGlobalScope (vm context
	// globals go through interceptors and would distort tick timings).
	var code = fs.readFileSync(path.join(ROOT, 'js/sim-worker.js'), 'utf8');
	var wrapped = '(function (self, performance, setTimeout, DecompressionStream) {\n' + code + '\n})';
	var factory = vm.runInThisContext(wrapped, { filename: 'js/sim-worker.js', lineOffset: -1 });
	factory(self, perf, noTimers, undefined);

	var REPLY_TYPES = { ready: 1, stepResult: 1, stepBatchResult: 1, snapshot: 1, restored: 1, error: 1 };
	var lastStats = null;

	// Delivers one message and returns the worker's direct reply (if any).
	// Periodic 'stats' messages are kept aside in lastStats.
	function post(msg) {
		outbox.length = 0;
		self.onmessage({ data: msg });
		var reply = null;
		for (var i = 0; i < outbox.length; i++) {
			if (outbox[i].type === 'stats') lastStats = outbox[i];
			else if (REPLY_TYPES[outbox[i].type]) reply = outbox[i];
		}
		return reply;
	}

	var buffer = options.buffer || loadRawConnectome();
	var ready = post({ type: 'init', buffer: buffer });
	if (!ready || ready.type !== 'ready') {
		throw new Error('worker init failed: ' + JSON.stringify(ready && ready.message));
	}
	return { post: post, ready: ready, stats: function () { return lastStats; } };
}

function loadMeta() {
	return JSON.parse(fs.readFileSync(dataPath('neuron_meta.json'), 'utf8'));
}

function loadSidecar() {
	var jsonPath = dataPath('neuron_sidecar.json');
	var binPath = dataPath('neuron_sidecar.bin.gz');
	if (!fs.existsSync(jsonPath) || !fs.existsSync(binPath)) return null;
	var manifest = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
	var raw = zlib.gunzipSync(fs.readFileSync(binPath));
	var buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
	return { manifest: manifest, buffer: buf };
}

function loadPositions() {
	var jsonPath = dataPath('neuron_positions.json');
	var binPath = dataPath('neuron_positions.bin.gz');
	if (!fs.existsSync(jsonPath) || !fs.existsSync(binPath)) return null;
	var manifest = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
	var raw = zlib.gunzipSync(fs.readFileSync(binPath));
	var buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
	return { manifest: manifest, buffer: buf };
}

function sha256(name) {
	return require('crypto').createHash('sha256').update(fs.readFileSync(dataPath(name))).digest('hex');
}

module.exports = {
	ROOT: ROOT,
	dataPath: dataPath,
	hasConnectomeData: hasConnectomeData,
	createWorker: createWorker,
	loadMeta: loadMeta,
	loadSidecar: loadSidecar,
	loadPositions: loadPositions,
	sha256: sha256,
};
