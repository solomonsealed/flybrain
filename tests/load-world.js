// Loads the production world modules into the Node global scope (as browser
// <script> tags would) and builds brain backends for headless runs.
//
//   var W = require('./load-world');
//   W.loadWorld();
//   var backend = W.connectomeBackend();   // real sim-worker.js + data/
//   var sim = FlyWorldSim.create({ seed: 3, backend: backend });
//   sim.runSeconds(20);
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var H = require('./worker-harness');

var ROOT = path.join(__dirname, '..');

var WORLD_FILES = [
	'js/world-config.js',
	'js/world-state.js',
	'js/world-physics.js',
	'js/world-senses.js',
	'js/world-life.js',
	'js/world-brain-adapter.js',
	'js/simulation-clock.js',
	'js/world-sim.js',
];

var loaded = {};

function loadScript(rel) {
	if (loaded[rel]) return;
	vm.runInThisContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { filename: rel });
	loaded[rel] = true;
}

function loadWorld() {
	if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
	WORLD_FILES.forEach(loadScript);
	// fly-logic.js holds FlyPolicy (and legacy helpers used by tests.js)
	loadScript('js/fly-logic.js');
}

var cachedAssets = null;
function loadAssets() {
	if (cachedAssets) return cachedAssets;
	var meta = H.loadMeta();
	var sc = H.loadSidecar();
	var parsed = sc ? WorldBrainAdapter.parseSidecar(sc.buffer) : null;
	cachedAssets = { meta: meta, manifest: sc ? sc.manifest : null, sidecar: parsed };
	return cachedAssets;
}

// A fresh real worker (reset state) wrapped as a synchronous backend.
function connectomeBackend(options) {
	options = options || {};
	loadWorld();
	var assets = loadAssets();
	var w = options.worker || H.createWorker();
	var backend = WorldBrainAdapter.createConnectomeBackend({
		port: w,
		ready: w.ready,
		meta: assets.meta,
		sidecar: options.noSidecar ? null : assets.sidecar,
		manifest: options.noSidecar ? null : assets.manifest,
		synapseWeight: options.synapseWeight !== undefined ? options.synapseWeight : WorldConfig.brain.synapseWeight,
		ticksPerStep: WorldConfig.brain.ticksPerStep
	});
	backend.worker = w;
	return backend;
}

function legacyBackend() {
	loadWorld();
	if (typeof BRAIN === 'undefined') {
		loadScript('js/constants.js');
		loadScript('js/connectome.js');
	}
	BRAIN.setup();
	return WorldBrainAdapter.createLegacyBackend({ BRAIN: BRAIN, legacyUpdate: BRAIN.legacyUpdate || BRAIN.update });
}

module.exports = {
	ROOT: ROOT,
	WORLD_FILES: WORLD_FILES,
	loadWorld: loadWorld,
	loadScript: loadScript,
	loadAssets: loadAssets,
	connectomeBackend: connectomeBackend,
	legacyBackend: legacyBackend,
	harness: H,
};
