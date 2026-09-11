/**
 * @file main.js -- Application coordinator for the FlyBrain garden.
 * @description Wires the world simulation (world-sim.js), the brain backend
 * (connectome worker or fallback), the renderer (WebGL garden or Canvas 2D
 * fallback), the inspector, and the existing brain displays and caretaker
 * integrations. It owns no simulation logic: every change to the garden goes
 * through FlyWorldApp.command(), which the Observe/Fruit/Web/Touch/Air tools,
 * experiments and the caretaker share.
 */

// Region-based neuron color map (built after BRAIN.setup)
var neuronColorMap = {};
// Cached dot element arrays per neuron group (built during DOM creation)
var neuronDotCache = {};
var regionColors = {
	sensory: '#3b82f6',
	central: '#8b5cf6',
	drives: '#f59e0b',
	motor: '#ef4444',
};

// Human-readable neuron descriptions for tooltips
var neuronDescriptions = {
	VIS_R1R6: 'R1-R6 motion photoreceptors',
	VIS_R7R8: 'R7/R8 color photoreceptors',
	VIS_ME: 'Medulla (visual processing)',
	VIS_LO: 'Lobula (pattern recognition)',
	VIS_LC: 'Lobula columnar (looming detection)',
	VIS_LPTC: 'Lobula plate tangential (optic flow)',
	OLF_ORN_FOOD: 'Olfactory receptor (food odors)',
	OLF_ORN_DANGER: 'Olfactory receptor (danger odors)',
	OLF_LN: 'Olfactory local interneurons',
	OLF_PN: 'Olfactory projection neurons',
	GUS_GRN_SWEET: 'Sweet taste receptors',
	GUS_GRN_BITTER: 'Bitter taste receptors',
	GUS_GRN_WATER: 'Water taste receptors',
	MECH_BRISTLE: 'Bristle neurons (touch)',
	MECH_JO: "Johnston's organ (wind/gravity)",
	MECH_CHORD: 'Chordotonal (proprioception)',
	THERMO_WARM: 'Warm thermosensors',
	THERMO_COOL: 'Cool thermosensors',
	NOCI: 'Nociceptors (pain)',
	MB_KC: 'Kenyon cells (odor memory)',
	MB_APL: 'APL inhibitory neuron',
	MB_MBON_APP: 'MB output (appetitive)',
	MB_MBON_AV: 'MB output (aversive)',
	MB_DAN_REW: 'Dopamine reward neurons',
	MB_DAN_PUN: 'Dopamine punishment neurons',
	LH_APP: 'Lateral horn (approach)',
	LH_AV: 'Lateral horn (avoidance)',
	CX_EPG: 'Compass neurons (heading)',
	CX_PFN: 'Path integration neurons',
	CX_FC: 'Fan-shaped body (locomotion)',
	CX_HDELTA: 'Heading change neurons',
	SEZ_FEED: 'Feeding command center',
	SEZ_GROOM: 'Grooming command center',
	SEZ_WATER: 'Water intake command',
	ANTENNAL_MECH: 'Antennal mechanosensory',
	GNG_DESC: 'Gnathal ganglia (arousal)',
	DN_WALK: 'Walk command',
	DN_FLIGHT: 'Flight command',
	DN_TURN: 'Turn command',
	DN_BACKUP: 'Backward walk command',
	DN_STARTLE: 'Startle/escape command',
	VNC_CPG: 'Central pattern generator (gait)',
	CLOCK_DN: 'Circadian clock',
	DRIVE_HUNGER: 'Hunger drive',
	DRIVE_FEAR: 'Fear drive',
	DRIVE_FATIGUE: 'Fatigue drive',
	DRIVE_CURIOSITY: 'Curiosity drive',
	DRIVE_GROOM: 'Grooming urge',
	MN_LEG_L1: 'Motor: front left leg',
	MN_LEG_R1: 'Motor: front right leg',
	MN_LEG_L2: 'Motor: middle left leg',
	MN_LEG_R2: 'Motor: middle right leg',
	MN_LEG_L3: 'Motor: rear left leg',
	MN_LEG_R3: 'Motor: rear right leg',
	MN_WING_L: 'Motor: left wing',
	MN_WING_R: 'Motor: right wing',
	MN_PROBOSCIS: 'Motor: proboscis',
	MN_HEAD: 'Motor: head',
	MN_ABDOMEN: 'Motor: abdomen',
};

// Approximate real neuron counts per functional group (FlyWire data)
var neuronPopulations = {
	VIS_R1R6: 6000,
	VIS_R7R8: 1600,
	VIS_ME: 39000,
	VIS_LO: 9000,
	VIS_LC: 3500,
	VIS_LPTC: 900,
	OLF_ORN_FOOD: 1100,
	OLF_ORN_DANGER: 700,
	OLF_LN: 400,
	OLF_PN: 400,
	GUS_GRN_SWEET: 800,
	GUS_GRN_BITTER: 600,
	GUS_GRN_WATER: 600,
	MECH_BRISTLE: 2200,
	MECH_JO: 480,
	MECH_CHORD: 500,
	ANTENNAL_MECH: 320,
	THERMO_WARM: 30,
	THERMO_COOL: 30,
	NOCI: 100,
	MB_KC: 2000,
	MB_APL: 1,
	MB_MBON_APP: 35,
	MB_MBON_AV: 35,
	MB_DAN_REW: 165,
	MB_DAN_PUN: 165,
	LH_APP: 700,
	LH_AV: 700,
	CX_EPG: 50,
	CX_PFN: 400,
	CX_FC: 2200,
	CX_HDELTA: 350,
	SEZ_FEED: 2500,
	SEZ_GROOM: 1800,
	SEZ_WATER: 700,
	GNG_DESC: 3000,
	DN_WALK: 50,
	DN_FLIGHT: 40,
	DN_TURN: 30,
	DN_BACKUP: 20,
	DN_STARTLE: 15,
	VNC_CPG: 14400,
	CLOCK_DN: 150,
	DRIVE_HUNGER: 200,
	DRIVE_FEAR: 150,
	DRIVE_FATIGUE: 100,
	DRIVE_CURIOSITY: 100,
	DRIVE_GROOM: 100,
	MN_LEG_L1: 50,
	MN_LEG_R1: 50,
	MN_LEG_L2: 50,
	MN_LEG_R2: 50,
	MN_LEG_L3: 50,
	MN_LEG_R3: 50,
	MN_WING_L: 45,
	MN_WING_R: 45,
	MN_PROBOSCIS: 30,
	MN_HEAD: 40,
	MN_ABDOMEN: 60
};

// --- Brain setup ---
BRAIN.setup();

// Build connectome grid grouped by region type
(function () {
	var holder = document.getElementById('nodeHolder');
	var regionOrder = ['sensory', 'central', 'drives', 'motor'];
	var regionLabels = { sensory: 'Sensory', central: 'Central', drives: 'Drives', motor: 'Motor' };
	var regionNeurons = {};
	for (var r = 0; r < regionOrder.length; r++) {
		regionNeurons[regionOrder[r]] = [];
	}
	// Sort neurons into regions
	for (var ps in BRAIN.connectome) {
		var assigned = false;
		for (var regionName in BRAIN.neuronRegions) {
			var list = BRAIN.neuronRegions[regionName];
			for (var ni = 0; ni < list.length; ni++) {
				if (list[ni] === ps) {
					regionNeurons[regionName].push(ps);
					assigned = true;
					break;
				}
			}
			if (assigned) break;
		}
		if (!assigned) regionNeurons['motor'].push(ps);
	}

	for (var ri = 0; ri < regionOrder.length; ri++) {
		var type = regionOrder[ri];
		var neurons = regionNeurons[type];
		if (neurons.length === 0) continue;

		var section = document.createElement('div');
		section.className = 'cg-section cg-section-' + type;

		var label = document.createElement('div');
		label.className = 'cg-label';
		label.textContent = regionLabels[type];
		section.appendChild(label);

		var grid = document.createElement('div');
		grid.className = 'cg-nodes';

		for (var n = 0; n < neurons.length; n++) {
			var node = document.createElement('div');
			node.className = 'cg-node';
			node.id = neurons[n];
			node.setAttribute('data-neuron', neurons[n]);

			var nameSpan = document.createElement('span');
			nameSpan.className = 'cg-name';
			nameSpan.textContent = neurons[n].replace(/_/g, ' ');
			node.appendChild(nameSpan);

			var cluster = document.createElement('span');
			cluster.className = 'cg-dot-cluster';
			var pop = neuronPopulations[neurons[n]] || 1;
			var dotCount = Math.max(1, Math.min(600, Math.round(pop / 100)));
			var dotArr = [];
			for (var d = 0; d < dotCount; d++) {
				var dot = document.createElement('span');
				dot.className = 'cg-dot';
				cluster.appendChild(dot);
				dotArr.push(dot);
			}
			neuronDotCache[neurons[n]] = dotArr;
			node.appendChild(cluster);

			grid.appendChild(node);
		}

		section.appendChild(grid);
		holder.appendChild(section);
	}
})();

// Build neuron -> color lookup from BRAIN.neuronRegions
for (var region in BRAIN.neuronRegions) {
	var neurons = BRAIN.neuronRegions[region];
	for (var i = 0; i < neurons.length; i++) {
		neuronColorMap[neurons[i]] = regionColors[region] || '#55FF55';
	}
}

// --- Neuron tooltip on hover ---
var neuronTooltip = document.getElementById('neuronTooltip');
document.getElementById('nodeHolder').addEventListener('mouseover', function (e) {
	var node = e.target.closest('.cg-node');
	if (!node) return;
	var id = node.getAttribute('data-neuron');
	var desc = neuronDescriptions[id] || id;
	var pop = neuronPopulations[id];
	var popText = pop ? ' -- represents ~' + pop.toLocaleString() + ' neurons' : '';
	if (BRAIN.workerGroupIdToName && BRAIN.workerGroupSizes) {
		var gid = BRAIN.workerGroupIdToName.indexOf(id);
		if (gid >= 0) {
			var n = BRAIN.workerGroupSizes[gid];
			popText = n > 0 ? ' -- ' + n.toLocaleString() + ' neurons in this export' : ' -- no neurons in this export; shows modeled state';
		}
	}
	neuronTooltip.textContent = desc + popText;
	neuronTooltip.style.display = 'block';
});
document.getElementById('nodeHolder').addEventListener('mousemove', function (e) {
	if (neuronTooltip.style.display === 'block') {
		neuronTooltip.style.left = (e.clientX + 10) + 'px';
		neuronTooltip.style.bottom = (window.innerHeight - e.clientY + 10) + 'px';
		neuronTooltip.style.top = 'auto';
	}
});
document.getElementById('nodeHolder').addEventListener('mouseout', function (e) {
	var node = e.target.closest('.cg-node');
	if (node) {
		neuronTooltip.style.display = 'none';
	}
});

// ============================================================
// GARDEN COORDINATOR
// ============================================================

var FlyWorldApp = window.FlyWorldApp = (function () {
	'use strict';

	var cfg = WorldConfig;
	var app = {
		config: cfg,
		sim: null,
		state: null,          // world state before the brain is ready
		renderer: null,
		backend: null,
		assets: null,
		brain: { kind: 'loading', label: 'Loading brain' },
		run: { scenario: 'free', seed: 1, mode: 'hybrid' },
		userPaused: false,
		hiddenPaused: false,
		stepLatency: 0,
		replayStatus: '',
		lastLog: null
	};

	// URL options (shareable, reproducible runs): ?seed=3&scenario=webPatch
	// &mode=connectome, plus ?renderer=2d and ?brain=legacy capability checks.
	var params = {};
	location.search.replace(/[?&]([^=&]+)=([^&]*)/g, function (m, k, v) { params[k] = decodeURIComponent(v); });
	if (params.seed && parseInt(params.seed, 10) > 0) app.run.seed = parseInt(params.seed, 10);
	if (params.scenario && cfg.scenarios[params.scenario]) app.run.scenario = params.scenario;
	if (params.mode === 'connectome' || params.mode === 'hybrid') app.run.mode = params.mode;
	app.forceCanvas2D = params.renderer === '2d';
	app.params = params;

	var worldCanvas = document.getElementById('world-canvas');
	var overlayCanvas = document.getElementById('canvas');
	var octx = overlayCanvas.getContext('2d');
	var labelsEl = document.getElementById('world-labels');
	var loadingEl = document.getElementById('world-loading');
	var badge = document.getElementById('brainModeBadge');
	var inputCanvas = worldCanvas;

	/* ---------- initial world (drawn while the connectome loads) ---------- */

	function scenarioOpts(run) {
		return FlyWorldSim.scenarioOptions(cfg, run.scenario);
	}

	app.state = WorldState.create(cfg, app.run.seed, scenarioOpts(app.run).stateOptions);

	function currentState() { return app.sim ? app.sim.state : app.state; }

	/* ---------- renderers ---------- */

	function createRenderer() {
		var r = null;
		if (!app.forceCanvas2D) {
			try {
				r = WorldRenderer.create(worldCanvas, cfg, currentState());
				worldCanvas.style.display = '';
				overlayCanvas.classList.add('overlay-only');
				inputCanvas = worldCanvas;
				r.onContextLost(function () {
					console.warn('WebGL context lost: switching to the 2D garden');
					app.forceCanvas2D = true;
					swapRenderer();
				}, function () {
					app.forceCanvas2D = false;
					swapRenderer();
				});
			} catch (e) {
				console.warn('WebGL garden unavailable, using the 2D renderer:', e.message);
				r = null;
			}
		}
		if (!r) {
			worldCanvas.style.display = 'none';
			overlayCanvas.classList.remove('overlay-only');
			r = WorldRenderer2D.create(overlayCanvas, cfg, currentState());
			inputCanvas = overlayCanvas;
		}
		attachInput(inputCanvas);
		if (r.setXray) r.setXray(xrayOn);
		if (r.setBrain && app.brainView) r.setBrain(app.brainView);
		return r;
	}

	function swapRenderer() {
		var overlays = app.renderer ? app.renderer.overlays() : null;
		if (app.renderer) app.renderer.dispose();
		app.renderer = createRenderer();
		if (overlays) for (var k in overlays) app.renderer.setOverlay(k, overlays[k]);
		setQuality();
		resize();
		syncViewUi();
	}

	// Spikes for the brain drawn inside the fly and for the 139K panel.
	// Asking for them never changes the worker's dynamics.
	function wantFireState() {
		return (typeof NeuroRenderer !== 'undefined' && NeuroRenderer.isActive()) ||
			!!(app.renderer && app.renderer.wantsFireState && app.renderer.wantsFireState());
	}

	function setQuality() {
		if (app.renderer && app.renderer.setQuality) app.renderer.setQuality(liteModeActive ? 'lite' : 'full');
	}

	/* ---------- brain ---------- */

	function setBadge() {
		if (!badge) return;
		var b = app.brain, mode = app.run.mode;
		badge.className = 'brain-mode-badge ' + (b.kind === 'connectome' ? (mode === 'connectome' ? 'mode-validated' : 'mode-hybrid') : b.kind === 'legacy' ? 'mode-fallback' : '');
		if (b.kind === 'connectome') {
			badge.textContent = 'Connectome · ' + (mode === 'connectome' ? 'readout only' : 'connectome + modeled steering');
			badge.title = b.label + '. ' + (mode === 'connectome' ? 'Only connectome readouts (plus the modeled VNC adapter and physical reflexes) steer the fly.' :
				'Connectome readouts plus a small, labeled modeled odor-steering circuit.') + (b.directional ? '' : ' Hemisphere sidecar missing: left/right populations unavailable.');
		} else if (b.kind === 'legacy') {
			badge.textContent = 'Fallback: 59-group approximation';
			badge.title = 'The connectome worker is unavailable; a hand-authored 59-group model drives the fly. Results are not connectome results.';
		} else {
			badge.textContent = 'Loading brain…';
		}
	}

	function wrapBackendTiming(backend) {
		var step = backend.step;
		backend.step = function (req, cb) {
			var t0 = performance.now();
			step(req, function (res) {
				var dt = performance.now() - t0;
				app.stepLatency = app.stepLatency ? app.stepLatency + (dt - app.stepLatency) * 0.1 : dt;
				cb(res);
			});
		};
		return backend;
	}

	function loadBrain() {
		if (params.brain === 'legacy') { useLegacyBrain('requested with ?brain=legacy'); return; }
		BRAIN.workerBridge.load().then(function (assets) {
			app.assets = assets;
			app.backend = wrapBackendTiming(WorldBrainAdapter.createConnectomeBackend({
				port: assets.worker, ready: assets.ready, meta: assets.meta,
				sidecar: assets.sidecar, manifest: assets.manifest,
				synapseWeight: cfg.brain.synapseWeight, ticksPerStep: cfg.brain.ticksPerStep
			}));
			app.brain = { kind: 'connectome', label: app.backend.label, directional: !!assets.sidecar, validation: assets.validation };
			if (assets.positions) {
				app.brainView = { positions: assets.positions, sortedToOriginal: assets.ready.sortedToOriginal, regionType: assets.ready.regionType };
				if (app.renderer && app.renderer.setBrain) app.renderer.setBrain(app.brainView);
			}
			if (inspector) inspector.renderValidation(validationInfo());
			setBadge();
			startRun(null, true);
			initNeuroRenderer();
		}).catch(function (err) {
			console.warn('Connectome unavailable, using the 59-group fallback:', err && err.message);
			useLegacyBrain('Connectome unavailable (' + (err && err.message) + ').');
		});
	}

	function validationInfo() {
		var v = app.assets && app.assets.validation;
		if (!v) return { checks: [], note: app.brain.kind === 'legacy' ? 'Fallback brain: no connectome assets loaded.' : '' };
		var pc = app.assets.positionsCheck;
		var positionsNote = app.assets.positions ? ' Neuron positions (display only) ' + pc.detail + '.' :
			' Neuron positions unavailable (' + (pc ? pc.detail : 'not loaded') + '): the X-ray fly shows no brain.';
		return { checks: v.checks, note: (app.assets.sidecar ? 'Hemisphere sidecar v' + app.assets.manifest.version + ' loaded (' + app.assets.manifest.populations.length + ' populations).' :
			'No neuron sidecar: directional populations are unavailable; see docs/world-model.md.') + positionsNote };
	}

	function useLegacyBrain(reason) {
		var legacy = WorldBrainAdapter.createLegacyBackend({ BRAIN: BRAIN, legacyUpdate: BRAIN.legacyUpdate });
		app.backend = wrapBackendTiming(legacy);
		app.brain = { kind: 'legacy', label: legacy.label };
		// the 59 groups have no neurons to place: an X-ray brain would sit silent
		app.brainView = null;
		if (app.renderer && app.renderer.setBrain) app.renderer.setBrain(null);
		setBadge();
		if (inspector) inspector.renderValidation(validationInfo());
		var sub = document.getElementById('connectomeSubtitle');
		if (sub) { sub.textContent = '59 neuron groups — hand-authored approximation (fallback)'; sub.classList.remove('loading'); }
		if (app.sim) {
			// Continue from the shared world state with the fallback brain.
			var st = app.sim.state;
			app.sim = null;
			startRun({ state: st }, false);
			if (inspector) inspector.note('Brain worker failed; continuing from the current garden with the 59-group fallback. ' + (reason || ''), 'world');
		} else {
			startRun(null, true);
		}
	}

	BRAIN.workerBridge.onFailure(function (err) { useLegacyBrain(err && err.message); });

	/* ---------- runs ---------- */

	// Starts a run. `first` keeps the pre-load world state (so anything placed
	// while loading stays); otherwise a fresh state is built from the seed and
	// scenario. The brain is always reset for a new run and then settled.
	function startRun(opts, first) {
		opts = opts || {};
		if (opts.scenario) app.run.scenario = opts.scenario;
		if (opts.seed) app.run.seed = opts.seed;
		if (opts.mode) app.run.mode = opts.mode;
		var sc = scenarioOpts(app.run);
		var state = opts.state || (first ? app.state : null);
		if (!state) {
			app.backend.reset();
		}
		var sim = FlyWorldSim.create({
			config: cfg, seed: app.run.seed, backend: app.backend, mode: app.run.mode,
			state: state || undefined, stateOptions: sc.stateOptions, scheduled: state && !first ? [] : sc.scheduled,
			triggers: state && !first ? [] : sc.triggers, scenario: app.run.scenario,
			dataVersion: app.assets && app.assets.manifest ? app.assets.manifest.hashes['connectome.bin.gz'] : null,
			wantFireState: wantFireState
		});
		app.sim = sim;
		app.replayStatus = '';
		sim.onNeural(onNeuralStep);
		sim.onEvents(function (evs) { if (inspector) inspector.onEvents(evs); handleEventsForUi(evs); });
		if (inspector) {
			inspector.reset();
			inspector.onEvents(sim.state.events.slice());
			inspector.syncControls(app.run);
		}
		if (app.renderer) { app.renderer.clearTrail(); app.renderer.select(null); }
		sim.clock.setSpeed(currentSpeed());
		if (app.userPaused) sim.clock.pause();
		setBadge();
		if (loadingEl) { loadingEl.textContent = 'Settling the brain…'; loadingEl.style.display = ''; }
		sim.settle(opts.state ? 0 : cfg.brain.settleSteps, function () {
			if (loadingEl) loadingEl.style.display = 'none';
		});
		return sim;
	}

	function currentSpeed() {
		var s = document.getElementById('wiSpeed');
		return s ? parseFloat(s.value) || 1 : 1;
	}

	app.newRun = function (opts) { if (app.backend) startRun(opts || {}, false); };
	app.setMode = function (m) {
		app.run.mode = m;
		if (app.sim) app.sim.setMode(m);
		setBadge();
	};
	app.setSpeed = function (s) { if (app.sim) app.sim.clock.setSpeed(s); };

	app.exportLog = function () {
		if (!app.sim) return;
		var log = app.sim.exportLog();
		var text = JSON.stringify(log, null, 1);
		try {
			var blob = new Blob([text], { type: 'application/json' });
			var a = document.createElement('a');
			a.href = URL.createObjectURL(blob);
			a.download = 'flybrain-run-seed' + log.seed + '-' + Math.round(app.sim.state.time) + 's.json';
			document.body.appendChild(a);
			a.click();
			setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
		} catch (e) {
			if (navigator.clipboard) navigator.clipboard.writeText(text);
		}
	};

	// Re-runs the current log from a reset brain at 4x and compares the final
	// fingerprint with the original at the same step.
	app.replay = function () {
		if (!app.sim || !app.backend) return;
		var log = app.sim.exportLog();
		var target = log.finalBodyStep;
		var original = log.finalFingerprint;
		app.replayStatus = 'Replaying ' + (target * cfg.clock.bodyDt).toFixed(1) + ' s from a reset brain…';
		var sim = FlyWorldSim.replay(log, app.backend, { config: cfg, wantFireState: wantFireState });
		sim.onNeural(onNeuralStep);
		sim.clock.setSpeed(4);
		app.sim = sim;
		if (inspector) { inspector.reset(); }
		if (app.renderer) app.renderer.clearTrail();
		sim.onEvents(function (evs) {
			if (inspector) inspector.onEvents(evs);
		});
		sim.stopAt = target;
		app.replayTarget = { step: target, fingerprint: original };
	};

	function checkReplay() {
		var t = app.replayTarget;
		if (!t || !app.sim) return;
		if (app.sim.state.bodyStep >= t.step) {
			var match = app.sim.fingerprint() === t.fingerprint;
			app.replayStatus = match ? 'Replay matched the original run exactly at step ' + t.step + '.' :
				'Replay diverged from the original at step ' + t.step + ' (see console).';
			if (!match) console.warn('replay mismatch', app.sim.fingerprint(), t.fingerprint);
			if (inspector) inspector.note(app.replayStatus, 'experiment');
			app.replayTarget = null;
			app.sim.stopAt = undefined;
			app.sim.clock.setSpeed(currentSpeed());
			if (!app.userPaused) app.sim.clock.resume();
		}
	}

	/* ---------- commands ---------- */

	// The validated world command API shared by tools, experiments and the
	// caretaker. Returns {ok, error?, id?}.
	app.command = function (cmd) {
		cmd.source = cmd.source || 'user';
		if (app.sim) {
			if (app.sim.clock.paused || !app.sim.settled) return app.sim.command(cmd);
			// validate now against a copy so the caller gets an answer, apply
			// at the next body step so replays see it at the same moment
			var probe = WorldState.applyCommand(WorldState.clone(app.sim.state), cfg, JSON.parse(JSON.stringify(cmd)));
			if (probe.ok) app.sim.enqueue(cmd);
			return probe;
		}
		return WorldState.applyCommand(app.state, cfg, cmd);
	};

	app.getState = function () { return currentState(); };
	app.worldToScreen = function (x, y, z) { return app.renderer ? app.renderer.worldToScreen(x, y, z) : null; };
	app.screenToGround = function (cx, cy) { return app.renderer ? app.renderer.screenToGround(cx, cy) : null; };

	/* ---------- neural step -> UI ---------- */

	var lastDotUpdate = 0;
	function onNeuralStep(rec) {
		var sim = app.sim;
		if (!sim) return;
		// keep BRAIN.drives current for panels that read it
		for (var k in sim.state.drives) BRAIN.drives[k] = sim.state.drives[k];
		BRAIN.stimulate.lightLevel = sim.state.env.lightLevel;
		BRAIN.stimulate.temperature = sim.state.env.temperature;
		if (sim.lastResult && sim.lastResult.groupSpikeCounts) {
			var m = sim.motorOut || {};
			var fl = sim.state.fly.mode === 'air' ? 1 : 0;
			var legL = (m.walkDrive || 0) * (1 - Math.min(0.5, Math.max(0, m.turn || 0) * 0.1));
			var legR = (m.walkDrive || 0) * (1 - Math.min(0.5, Math.max(0, -(m.turn || 0)) * 0.1));
			BRAIN.workerBridge.displayWorldStep(sim.lastResult, {
				DRIVE_FEAR: sim.state.drives.fear, DRIVE_CURIOSITY: sim.state.drives.curiosity, DRIVE_GROOM: sim.state.drives.groom,
				MN_LEG_L1: legL, MN_LEG_L2: legL, MN_LEG_L3: legL, MN_LEG_R1: legR, MN_LEG_R2: legR, MN_LEG_R3: legR,
				MN_WING_L: fl, MN_WING_R: fl, DN_STARTLE: m.escape || 0
			});
		}
		var now = performance.now();
		if (now - lastDotUpdate > 200) {
			lastDotUpdate = now;
			updateGroupDots();
			updateDriveMeters();
		}
	}

	function updateDriveMeters() {
		var d = currentState().drives;
		var set = function (id, v) { var el = document.getElementById(id); if (el) el.style.width = (v * 100) + '%'; };
		set('driveHunger', d.hunger); set('driveFear', d.fear); set('driveFatigue', d.fatigue);
		set('driveCuriosity', d.curiosity); set('driveGroom', d.groom);
		var be = document.getElementById('behaviorState');
		if (be) be.textContent = currentState().behavior.current;
		var clk = document.getElementById('simClock');
		if (clk) clk.textContent = currentState().time.toFixed(1) + ' s' + (app.sim && app.sim.clock.paused ? ' (paused)' : '');
	}

	function updateGroupDots() {
		if (typeof NeuroRenderer !== 'undefined' && NeuroRenderer.isActive()) return;
		for (var postSynaptic in BRAIN.connectome) {
			var psBox = document.getElementById(postSynaptic);
			if (!psBox) continue;
			var neuron = BRAIN.postSynaptic[postSynaptic][BRAIN.thisState];
			var color = neuronColorMap[postSynaptic] || '#55FF55';
			var baseOpacity = Math.min(1, neuron / 50);
			var dots = neuronDotCache[postSynaptic];
			if (!dots) continue;
			for (var di = 0; di < dots.length; di++) {
				// cosmetic flicker only; the level is the recorded group activity
				var variation = (Math.random() - 0.5) * 0.6;
				var dotOpacity = Math.max(0, Math.min(1, baseOpacity + variation * baseOpacity));
				dots[di].style.backgroundColor = color;
				dots[di].style.opacity = dotOpacity;
				dots[di].style.boxShadow = dotOpacity > 0.5 ? '0 0 ' + Math.round(dotOpacity * 4) + 'px ' + color : 'none';
			}
			psBox.classList.toggle('cg-active', baseOpacity > 0.15);
		}
	}

	function handleEventsForUi(evs) {
		for (var i = 0; i < evs.length; i++) {
			var e = evs[i];
			if (e.type === 'fruit-placed' || e.type === 'web-placed' || e.type === 'touch') {
				var p = e.type === 'touch' ? currentState().fly : e.data;
				addRipple(p.x, p.z, e.source === 'caretaker' ? 'caretaker' : 'user');
			}
		}
	}

	/* ---------- tools and input ---------- */

	var activeTool = 'fruit';
	var toolButtons = document.querySelectorAll('.tool-btn[data-tool]');
	for (var i = 0; i < toolButtons.length; i++) {
		(function (btn) {
			var tool = btn.getAttribute('data-tool');
			if (tool === 'light') btn.addEventListener('click', cycleLightLevel);
			else if (tool === 'temp') btn.addEventListener('click', cycleTempLevel);
			else btn.addEventListener('click', function () { setTool(tool); });
		})(toolButtons[i]);
	}

	function setTool(tool) {
		activeTool = tool;
		for (var j = 0; j < toolButtons.length; j++) {
			var t = toolButtons[j].getAttribute('data-tool');
			if (t !== 'light' && t !== 'temp') toolButtons[j].classList.toggle('active', t === tool);
		}
		document.body.setAttribute('data-tool', tool);
	}
	app.setTool = setTool;
	app.activeTool = function () { return activeTool; };

	var lightStates = [1, 0.5, 0], lightLabels = ['Bright', 'Dim', 'Dark'], lightStateIndex = 0;
	var tempStates = [0.5, 0.75, 0.25], tempLabels = ['Neutral', 'Warm', 'Cool'], tempStateIndex = 0;

	function cycleLightLevel() { setLightIndex((lightStateIndex + 1) % lightStates.length, 'user'); }
	function cycleTempLevel() { setTempIndex((tempStateIndex + 1) % tempStates.length, 'user'); }
	function setLightIndex(i, source) {
		lightStateIndex = i;
		app.command({ type: 'setLight', params: { level: lightStates[i] }, source: source });
		var btn = document.getElementById('lightBtn');
		if (btn) btn.textContent = 'Light: ' + lightLabels[i];
	}
	function setTempIndex(i, source) {
		tempStateIndex = i;
		app.command({ type: 'setTemperature', params: { level: tempStates[i] }, source: source });
		var btn = document.getElementById('tempBtn');
		if (btn) btn.textContent = 'Temp: ' + tempLabels[i];
	}
	app.setLightIndex = setLightIndex;
	app.setTempIndex = setTempIndex;
	app.lightIndex = function () { return lightStateIndex; };
	app.tempIndex = function () { return tempStateIndex; };

	var pointer = null;
	var windDrag = null;
	var attachedTo = null;

	function attachInput(el) {
		if (attachedTo === el) return;
		if (attachedTo) attachedTo.removeEventListener('pointerdown', onPointerDown);
		el.addEventListener('pointerdown', onPointerDown);
		attachedTo = el;
	}

	function onPointerDown(e) {
		if (e.button !== undefined && e.button !== 0) return;
		if (inPip(e.clientX, e.clientY)) return;
		pointer = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
		if (activeTool === 'air') {
			var g = app.renderer.screenToGround(e.clientX, e.clientY);
			if (g) {
				windDrag = { start: g, sx: e.clientX, sy: e.clientY, ex: e.clientX, ey: e.clientY };
				if (app.renderer.setPanEnabled) app.renderer.setPanEnabled(false);
			}
		}
	}

	window.addEventListener('pointermove', function (e) {
		if (windDrag && pointer && e.pointerId === pointer.id) { windDrag.ex = e.clientX; windDrag.ey = e.clientY; }
	});

	window.addEventListener('pointerup', function (e) {
		if (!pointer || e.pointerId !== pointer.id) return;
		var moved = Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y);
		var quick = performance.now() - pointer.t < 600;
		if (windDrag) {
			var end = app.renderer.screenToGround(e.clientX, e.clientY);
			var fly = currentState().fly;
			var dx, dz, strength;
			if (end && moved > 8) {
				dx = end.x - windDrag.start.x; dz = end.z - windDrag.start.z;
				strength = Math.min(1, Math.hypot(dx, dz) / 25);
			} else {
				dx = fly.x - windDrag.start.x; dz = fly.z - windDrag.start.z;
				strength = Math.max(0.15, Math.min(1, 1 - Math.hypot(dx, dz) / 60));
			}
			if (Math.hypot(dx, dz) > 1e-3) app.command({ type: 'wind', params: { dirX: dx, dirZ: dz, strength: strength, duration: 2 } });
			windDrag = null;
			if (app.renderer.setPanEnabled) app.renderer.setPanEnabled(true);
		} else if (moved < 7 && quick) {
			handleClick(e.clientX, e.clientY);
		}
		pointer = null;
	});

	function handleClick(cx, cy) {
		if (inPip(cx, cy)) return;
		var pick = app.renderer.pick(cx, cy);
		if (!pick) return;
		var st = currentState();
		switch (activeTool) {
		case 'observe':
			var sel = pick.type === 'fruit' || pick.type === 'web' || pick.type === 'fly' ? { type: pick.type, id: pick.id } : null;
			app.renderer.select(sel);
			if (inspector) inspector.select(sel);
			break;
		case 'fruit':
			if (pick.type === 'fruit') { app.renderer.select({ type: 'fruit', id: pick.id }); if (inspector) inspector.select({ type: 'fruit', id: pick.id }); break; }
			var r = app.command({ type: 'placeFruit', params: { x: pick.x, z: pick.z } });
			if (!r.ok) flash(r.error);
			break;
		case 'web':
			if (pick.type === 'web') app.command({ type: 'removeWeb', params: { id: pick.id } });
			else {
				var w = app.command({ type: 'placeWeb', params: { x: pick.x, z: pick.z } });
				if (!w.ok) flash(w.error);
			}
			break;
		case 'touch':
			var fly = st.fly;
			var dx = pick.x - fly.x, dz = pick.z - fly.z;
			if (pick.type !== 'fly' && Math.hypot(dx, dz) > 1.6) { flash('Click on the fly to touch it'); break; }
			var f = WorldState.forward(fly.heading), l = WorldState.left(fly.heading);
			var along = dx * f.x + dz * f.z, side = dx * l.x + dz * l.z;
			var location = Math.abs(side) > 0.25 && along > -0.3 && along < 0.25 ? 'leg' : along > 0.22 ? 'head' : along > -0.05 ? 'thorax' : 'abdomen';
			app.command({ type: 'touch', params: { location: location, side: Math.abs(side) < 0.12 ? 'both' : (side > 0 ? 'left' : 'right') } });
			break;
		}
	}

	var flashTimer = null;
	function flash(text) {
		var el = document.getElementById('explainLine');
		if (!el) return;
		el.textContent = text;
		el.classList.add('flash');
		clearTimeout(flashTimer);
		flashTimer = setTimeout(function () { el.classList.remove('flash'); }, 1600);
	}

	/* ---------- overlay canvas effects (screen space) ---------- */

	var ripples = [];
	function addRipple(x, z, kind) { ripples.push({ x: x, z: z, t0: performance.now(), kind: kind }); }

	function drawOverlay() {
		var w = overlayCanvas.clientWidth, h = overlayCanvas.clientHeight;
		var twoD = app.renderer && app.renderer.kind === 'canvas2d';
		if (!twoD) {
			octx.setTransform(overlayDpr, 0, 0, overlayDpr, 0, 0);
			octx.clearRect(0, 0, w, h);
		}
		var now = performance.now();
		for (var i = ripples.length - 1; i >= 0; i--) {
			var r = ripples[i], age = (now - r.t0) / 600;
			if (age > 1) { ripples.splice(i, 1); continue; }
			var p = app.renderer.worldToScreen(r.x, 0.2, r.z);
			octx.strokeStyle = r.kind === 'caretaker' ? 'rgba(227,115,75,' + (1 - age).toFixed(2) + ')' : 'rgba(255,255,255,' + (0.8 * (1 - age)).toFixed(2) + ')';
			octx.lineWidth = 2 * (1 - age);
			octx.beginPath(); octx.arc(p.x - overlayOffset.x, p.y - overlayOffset.y, 6 + age * 26, 0, Math.PI * 2); octx.stroke();
		}
		if (windDrag) {
			var dx = windDrag.ex - windDrag.sx, dy = windDrag.ey - windDrag.sy, len = Math.hypot(dx, dy);
			if (len > 5) {
				octx.strokeStyle = 'rgba(200,215,235,0.8)'; octx.lineWidth = 2;
				var sx = windDrag.sx - overlayOffset.x, sy = windDrag.sy - overlayOffset.y, ex = windDrag.ex - overlayOffset.x, ey = windDrag.ey - overlayOffset.y;
				octx.beginPath(); octx.moveTo(sx, sy); octx.lineTo(ex, ey); octx.stroke();
				var a = Math.atan2(dy, dx);
				octx.beginPath();
				octx.moveTo(ex, ey); octx.lineTo(ex - Math.cos(a - 0.4) * 11, ey - Math.sin(a - 0.4) * 11);
				octx.moveTo(ex, ey); octx.lineTo(ex - Math.cos(a + 0.4) * 11, ey - Math.sin(a + 0.4) * 11);
				octx.stroke();
			}
		}
		if (!twoD) drawPipLabel();
		if (typeof CaretakerRenderer !== 'undefined') CaretakerRenderer.drawOverlay(octx);
	}

	// Frame and captions for the eyes view's brain inset.
	function drawPipLabel() {
		var pr = app.renderer.pipRect && app.renderer.pipRect();
		var info = pr && app.renderer.brainInfo && app.renderer.brainInfo();
		if (!pr || !info) return;
		var cr = worldCanvas.getBoundingClientRect();
		var x = cr.left + pr.x - overlayOffset.x, y = cr.top + pr.y - overlayOffset.y;
		octx.strokeStyle = 'rgba(125, 150, 220, 0.5)';
		octx.lineWidth = 1;
		octx.strokeRect(x + 0.5, y + 0.5, pr.w - 1, pr.h - 1);
		octx.fillStyle = 'rgba(226, 232, 240, 0.9)';
		octx.font = '600 11px system-ui, -apple-system, sans-serif';
		octx.textAlign = 'left';
		octx.fillText('Brain, seen from behind', x + 8, y + 16);
		octx.fillStyle = 'rgba(148, 163, 184, 0.9)';
		octx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
		octx.fillText(info.spikes.toLocaleString() + (pr.w < 240 ? ' firing' : ' of ' + info.neurons.toLocaleString() + ' neurons firing'), x + 8, y + pr.h - 8);
		octx.textAlign = 'right';
		octx.fillText('L', x + 16, y + pr.h - 22);
		octx.fillText('R', x + pr.w - 8, y + pr.h - 22);
		octx.textAlign = 'left';
	}

	/* ---------- labels ---------- */

	var areaLabels = [];
	var flyLabel = null;
	(function buildLabels() {
		if (!labelsEl) return;
		cfg.areas.forEach(function (a) {
			var el = document.createElement('div');
			el.className = 'area-label';
			el.textContent = a.name;
			el.title = a.description;
			labelsEl.appendChild(el);
			areaLabels.push({ el: el, area: a });
		});
		flyLabel = document.createElement('div');
		flyLabel.className = 'fly-label';
		labelsEl.appendChild(flyLabel);
	})();

	var lastLabelUpdate = 0;
	function updateLabels(pose) {
		var now = performance.now();
		if (now - lastLabelUpdate < 50 || !app.renderer) return;
		lastLabelUpdate = now;
		var following = app.renderer.isFollowing && app.renderer.isFollowing();
		var zoom = app.renderer.camera ? app.renderer.camera.zoom : 1;
		var view = currentView();
		for (var i = 0; i < areaLabels.length; i++) {
			var L = areaLabels[i];
			var p = app.renderer.worldToScreen(L.area.x, 0.5, L.area.z);
			var show = view === 'garden' && !following && zoom < 2.2 && p.visible;
			L.el.style.display = show ? '' : 'none';
			if (show) L.el.style.transform = 'translate(' + Math.round(p.x) + 'px,' + Math.round(p.y) + 'px) translate(-50%, -50%)';
		}
		if (flyLabel) {
			// close-up sits right beside the fly, so its tag goes a little lower
			var fp = app.renderer.worldToScreen(pose.x, pose.y + (view === 'closeup' ? 0.6 : 1.2), pose.z);
			var b = currentState().behavior.current;
			flyLabel.textContent = b === 'walk' || view === 'eyes' ? '' : b;
			flyLabel.style.display = flyLabel.textContent && fp.visible ? '' : 'none';
			flyLabel.style.transform = 'translate(' + Math.round(fp.x) + 'px,' + Math.round(fp.y) + 'px) translate(-50%, -140%)';
		}
	}

	/* ---------- frame loop ---------- */

	var lastFrame = -1;
	var lastInspector = 0;
	var frameTimes = new Float32Array(600), frameIdx = 0, frameCount = 0;

	// Frame-time percentiles and brain timings for the performance record.
	app.perfStats = function () {
		var n = Math.min(frameCount, frameTimes.length);
		var arr = Array.prototype.slice.call(frameTimes, 0, n).sort(function (a, b) { return a - b; });
		var q = function (p) { return n ? arr[Math.min(n - 1, Math.floor(p * (n - 1)))] : null; };
		var r = app.renderer && app.renderer.stats ? app.renderer.stats() : {};
		return {
			frames: n, frameMsP50: q(0.5), frameMsP95: q(0.95), frameMsP99: q(0.99), fpsP50: n ? 1000 / q(0.5) : null,
			drawCalls: r.calls, triangles: r.triangles, geometries: r.geometries, textures: r.textures,
			brainStepMs: app.sim && app.sim.lastResult ? app.sim.lastResult.computeMs : null,
			roundTripMs: app.stepLatency, simWallRatio: app.sim ? app.sim.clock.stats.ratio : null,
			stalls: app.sim ? app.sim.clock.stats.stallEvents : null,
			jsHeapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null,
			renderer: app.renderer ? app.renderer.kind : null, pixelRatio: window.devicePixelRatio, userAgent: navigator.userAgent
		};
	};

	function frame(ts) {
		var dt = lastFrame < 0 ? 0 : Math.min(0.1, (ts - lastFrame) / 1000);
		if (lastFrame >= 0 && !document.hidden) { frameTimes[frameIdx] = ts - lastFrame; frameIdx = (frameIdx + 1) % frameTimes.length; frameCount++; }
		lastFrame = ts;
		var sim = app.sim;
		if (sim && sim.settled && !document.hidden) {
			sim.advance(dt);
			checkReplay();
		}
		var st = currentState();
		var pose = sim ? sim.renderPose() : st.fly;
		var obscured = typeof Brain3D !== 'undefined' && Brain3D.active;
		if (app.renderer) {
			app.renderer.sync(st, pose, sim ? { senses: sim.lastSenses, motor: sim.motorOut, fire: sim.lastResult && sim.lastResult.fireState } : null);
			app.renderer.suspend(obscured);
			app.renderer.render();
			drawOverlay();
			updateLabels(pose);
		}
		if (ts - lastInspector > 200) {
			lastInspector = ts;
			if (inspector) inspector.update();
			if (!sim) updateDriveMeters();
		}
		if (obscured) Brain3D.update();
		if (typeof CaretakerRenderer !== 'undefined') CaretakerRenderer.update(dt * 1000);
		requestAnimationFrame(frame);
	}

	/* ---------- pause, follow, reset, keyboard ---------- */

	function setPaused(p) {
		app.userPaused = p;
		if (app.sim) { if (p) app.sim.clock.pause(); else app.sim.clock.resume(); }
		var btn = document.getElementById('pauseBtn');
		if (btn) { btn.textContent = p ? 'Resume' : 'Pause'; btn.classList.toggle('active', p); btn.setAttribute('aria-pressed', p ? 'true' : 'false'); }
		updateDriveMeters();
	}
	app.setPaused = setPaused;

	function setFollow(on) {
		if (app.renderer) app.renderer.setFollow(on);
		syncViewUi();
	}

	/* ---------- views (garden, close-up, fly's eyes) and X-ray ---------- */

	var xrayOn = true;
	var viewBtns = document.querySelectorAll('.view-btn[data-view]');
	for (var vb = 0; vb < viewBtns.length; vb++) {
		viewBtns[vb].addEventListener('click', function () { setView(this.getAttribute('data-view')); });
	}

	function currentView() { return app.renderer && app.renderer.viewMode ? app.renderer.viewMode() : 'garden'; }

	function setView(mode) {
		if (!app.renderer || !app.renderer.setViewMode) return;
		app.renderer.setViewMode(mode);
		syncViewUi();
	}
	app.setView = setView;
	app.view = currentView;

	// Buttons follow the renderer, which can change view on its own (follow
	// and reset return to the garden; the 2D fallback has no close views).
	function syncViewUi() {
		var r = app.renderer, mode = currentView();
		var group = document.getElementById('view-modes');
		if (group) group.style.display = r && r.setViewMode ? '' : 'none';
		for (var i = 0; i < viewBtns.length; i++) {
			var on = viewBtns[i].getAttribute('data-view') === mode;
			viewBtns[i].classList.toggle('active', on);
			viewBtns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
		}
		var fb = document.getElementById('followBtn');
		var following = mode === 'garden' && !!(r && r.isFollowing());
		if (fb) { fb.classList.toggle('active', following); fb.setAttribute('aria-pressed', following ? 'true' : 'false'); }
		document.body.setAttribute('data-view', mode);
	}

	function setXray(on) {
		xrayOn = !!on;
		if (app.renderer && app.renderer.setXray) app.renderer.setXray(xrayOn);
		var btn = document.querySelector('.overlay-btn[data-overlay="xray"]');
		if (btn) { btn.classList.toggle('active', xrayOn); btn.setAttribute('aria-pressed', xrayOn ? 'true' : 'false'); }
	}
	app.setXray = setXray;

	// The eyes view's brain inset covers part of the garden; clicks there are
	// not garden clicks.
	function inPip(cx, cy) {
		var pr = app.renderer && app.renderer.pipRect && app.renderer.pipRect();
		if (!pr) return false;
		var cr = worldCanvas.getBoundingClientRect();
		var x = cx - cr.left, y = cy - cr.top;
		return x >= pr.x && x <= pr.x + pr.w && y >= pr.y && y <= pr.y + pr.h;
	}

	document.getElementById('pauseBtn').addEventListener('click', function () { setPaused(!app.userPaused); });
	document.getElementById('followBtn').addEventListener('click', function () {
		setFollow(!(app.renderer && app.renderer.isFollowing() && currentView() === 'garden'));
	});
	document.getElementById('resetBtn').addEventListener('click', function () { app.newRun({}); });
	document.getElementById('centerButton').onclick = function () { if (app.renderer) app.renderer.resetCamera(); setFollow(false); };
	document.getElementById('clearButton').onclick = function () { app.command({ type: 'clearFruit' }); };
	document.getElementById('zoomIn').onclick = function () { if (app.renderer) app.renderer.zoomBy(1.3); };
	document.getElementById('zoomOut').onclick = function () { if (app.renderer) app.renderer.zoomBy(1 / 1.3); };
	document.getElementById('inspectorBtn').addEventListener('click', function () { if (inspector) inspector.toggle(); });

	var overlayBtns = document.querySelectorAll('.overlay-btn');
	for (var ob = 0; ob < overlayBtns.length; ob++) {
		overlayBtns[ob].addEventListener('click', function () {
			var on = !this.classList.contains('active');
			var name = this.getAttribute('data-overlay');
			if (name === 'xray') { setXray(on); return; }
			this.classList.toggle('active', on);
			this.setAttribute('aria-pressed', on ? 'true' : 'false');
			if (app.renderer) app.renderer.setOverlay(name, on);
		});
	}

	document.addEventListener('keydown', function (e) {
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		var tag = e.target.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
		if (e.key === 'f' || e.key === 'F') setFollow(!(app.renderer && app.renderer.isFollowing() && currentView() === 'garden'));
		else if (e.key === 'r' || e.key === 'R' || e.key === 'Home') { if (app.renderer) app.renderer.resetCamera(); setFollow(false); }
		else if (e.key === 'c' || e.key === 'C') setView(currentView() === 'closeup' ? 'garden' : 'closeup');
		else if (e.key === 'e' || e.key === 'E') setView(currentView() === 'eyes' ? 'garden' : 'eyes');
		else if (e.key === 'x' || e.key === 'X') setXray(!xrayOn);
		else if (e.key === 'Escape' && currentView() !== 'garden') setView('garden');
		else if (e.key === ' ' && tag !== 'BUTTON') { e.preventDefault(); setPaused(!app.userPaused); }
		else if (e.key === 'i' || e.key === 'I') { if (inspector) inspector.toggle(); }
		else if (e.key === 'o' || e.key === 'O') setTool('observe');
		else if (e.key === 'v' && connectomeToggleBtn) connectomeToggleBtn.click();
		else if (e.key === '+' || e.key === '=') { if (app.renderer) app.renderer.zoomBy(1.2); }
		else if (e.key === '-') { if (app.renderer) app.renderer.zoomBy(1 / 1.2); }
	});

	// Pause world and brain together while hidden; resume the preserved state
	// (no neural reset).
	document.addEventListener('visibilitychange', function () {
		if (!app.sim) return;
		if (document.hidden) {
			app.hiddenPaused = !app.sim.clock.paused;
			app.sim.clock.pause();
		} else if (app.hiddenPaused && !app.userPaused) {
			app.hiddenPaused = false;
			app.sim.clock.resume();
			lastFrame = -1;
		}
	});

	/* ---------- resize ---------- */

	var overlayDpr = 1, overlayOffset = { x: 0, y: 0 };
	function resize() {
		overlayDpr = Math.min(window.devicePixelRatio || 1, cfg.render.maxPixelRatio);
		if (!app.renderer || app.renderer.kind !== 'canvas2d') {
			overlayCanvas.width = Math.round(overlayCanvas.clientWidth * overlayDpr);
			overlayCanvas.height = Math.round(overlayCanvas.clientHeight * overlayDpr);
		}
		var r = overlayCanvas.getBoundingClientRect();
		overlayOffset = { x: r.left, y: r.top };
		if (app.renderer) {
			var tb = document.getElementById('toolbar'), lp = document.getElementById('left-panel');
			var top = tb ? tb.getBoundingClientRect().bottom : 44;
			var lr = lp ? lp.getBoundingClientRect() : null;
			var bottom = lr && lr.width > window.innerWidth * 0.6 ? Math.max(0, window.innerHeight - lr.top) : 0;
			// the eyes view's brain inset sits bottom-left: on narrow screens
			// the overlay row reaches that corner, so the inset sits above it
			var ot = document.getElementById('overlay-toggles'), clear = bottom;
			if (ot) { var or = ot.getBoundingClientRect(); if (or.width && or.left < 340) clear = Math.max(bottom, window.innerHeight - or.top + 4); }
			if (app.renderer.setInsets) app.renderer.setInsets(top, bottom, clear);
			else app.renderer.resize();
		}
	}
	window.addEventListener('resize', resize);

	/* ---------- lite mode ---------- */

	var liteModeActive = false;
	var liteBtn = document.getElementById('liteBtn');
	if (liteBtn) {
		liteBtn.addEventListener('click', function () {
			liteModeActive = !liteModeActive;
			liteBtn.classList.toggle('active', liteModeActive);
			setQuality();
			if (typeof NeuroRenderer !== 'undefined') NeuroRenderer.setLiteMode(liteModeActive);
		});
	}

	/* ---------- neuron panel (139K view) ---------- */

	var connectomeToggleBtn = document.getElementById('connectomeToggleBtn');
	var nodeHolder = document.getElementById('nodeHolder');
	connectomeToggleBtn.addEventListener('click', function () {
		if (BRAIN.workerReady && typeof NeuroRenderer !== 'undefined') {
			if (NeuroRenderer.isActive()) {
				NeuroRenderer.destroy();
				connectomeToggleBtn.textContent = '139K View';
			} else if (NeuroRenderer.init()) {
				connectomeToggleBtn.textContent = 'Groups';
			}
		} else if (nodeHolder.classList.contains('hidden')) {
			nodeHolder.classList.remove('hidden');
			connectomeToggleBtn.textContent = 'Hide';
		} else {
			nodeHolder.classList.add('hidden');
			connectomeToggleBtn.textContent = 'Show';
		}
	});

	function initNeuroRenderer() {
		if (typeof NeuroRenderer !== 'undefined' && BRAIN.workerReady && NeuroRenderer.init()) {
			connectomeToggleBtn.textContent = 'Groups';
		}
	}

	/* ---------- start ---------- */

	var inspector = WorldInspector.create(app);
	app.inspector = inspector;
	app.renderer = createRenderer();
	setTool('fruit');
	resize();
	setBadge();
	syncViewUi();
	inspector.onEvents(app.state.events.slice());
	requestAnimationFrame(frame);
	loadBrain();

	return app;
})();

// ============================================================
// PANELS: Brain 3D, Learn, Help, drawer, activity sidebar
// ============================================================

var brain3dBtn = document.getElementById('brain3dBtn');
if (brain3dBtn) {
	brain3dBtn.addEventListener('click', function () {
		if (typeof Brain3D !== 'undefined') {
			Brain3D.toggle();
			var isActive = Brain3D.active;
			brain3dBtn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
			brain3dBtn.classList.toggle('active', isActive);
		}
	});
}

var learnBtn = document.getElementById('learnBtn');
if (learnBtn) {
	learnBtn.addEventListener('click', function () {
		if (typeof EducationPanel !== 'undefined') {
			EducationPanel.toggle();
			learnBtn.classList.toggle('active', EducationPanel.active);
		}
	});
}

var helpOverlay = document.getElementById('helpOverlay');
var helpBtn = document.getElementById('helpBtn');
helpBtn.addEventListener('click', function () {
	helpOverlay.style.display = helpOverlay.style.display !== 'none' ? 'none' : 'block';
});
document.getElementById('helpCloseBtn').addEventListener('click', function () { helpOverlay.style.display = 'none'; });
document.addEventListener('click', function (e) {
	if (helpOverlay.style.display !== 'none' && !helpOverlay.contains(e.target) && e.target !== helpBtn) {
		helpOverlay.style.display = 'none';
	}
});
document.addEventListener('click', function (e) {
	if (typeof EducationPanel !== 'undefined' && EducationPanel.active) {
		var panel = document.getElementById('education-panel');
		var learnBtnEl = document.getElementById('learnBtn');
		var brain3dOverlay = document.getElementById('brain3d-overlay');
		if (panel && !panel.contains(e.target) && e.target !== learnBtnEl && (!brain3dOverlay || !brain3dOverlay.contains(e.target))) {
			EducationPanel.hide();
			if (learnBtnEl) learnBtnEl.classList.remove('active');
		}
	}
});

function isMobile() { return window.innerWidth <= 768; }

var sidebarToggle = document.getElementById('sidebarToggle');
var leftPanel = document.getElementById('left-panel');
var drawerBackdrop = document.getElementById('drawer-backdrop');
function openDrawer() {
	if (leftPanel) leftPanel.classList.add('drawer-open');
	if (drawerBackdrop) drawerBackdrop.classList.add('visible');
	document.body.style.overflow = 'hidden';
}
function closeDrawer() {
	if (leftPanel) leftPanel.classList.remove('drawer-open');
	if (drawerBackdrop) drawerBackdrop.classList.remove('visible');
	document.body.style.overflow = '';
}
if (sidebarToggle) {
	sidebarToggle.addEventListener('click', function (e) {
		e.stopPropagation();
		if (isMobile()) {
			if (leftPanel && leftPanel.classList.contains('drawer-open')) closeDrawer(); else openDrawer();
		} else if (typeof CaretakerSidebar !== 'undefined') {
			var isOpen = CaretakerSidebar.toggle();
			var actBtn = document.getElementById('activityToggle');
			if (actBtn) actBtn.classList.toggle('active', isOpen);
		}
	});
}
var activityToggle = document.getElementById('activityToggle');
if (activityToggle) {
	activityToggle.addEventListener('click', function (e) {
		e.stopPropagation();
		if (typeof CaretakerSidebar !== 'undefined') activityToggle.classList.toggle('active', CaretakerSidebar.toggle());
	});
}
var activityCloseBtn = document.getElementById('caretaker-sidebar-close');
if (activityCloseBtn) {
	activityCloseBtn.addEventListener('click', function () {
		var sidebar = document.getElementById('caretaker-sidebar');
		if (sidebar) sidebar.classList.remove('sidebar-open');
		if (activityToggle) activityToggle.classList.remove('active');
	});
}
if (drawerBackdrop) drawerBackdrop.addEventListener('click', closeDrawer);
