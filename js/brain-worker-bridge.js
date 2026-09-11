/* brain-worker-bridge.js — T7.4 + garden world loader
 *
 * Bridges the main-thread behavioral layer (connectome.js, fly-logic.js, main.js)
 * to the LIF Web Worker (sim-worker.js).
 *
 * Garden mode (default): BRAIN.workerBridge.load() fetches and validates the
 * paired connectome assets (binary, group metadata, neuron sidecar), starts
 * the worker in step mode, and resolves with everything the world brain
 * adapter needs. The garden simulation then drives the worker one step at a
 * time; displayWorldStep() mirrors each step into BRAIN.postSynaptic so the
 * neuron panel and Brain 3D show recorded activity.
 *
 * Legacy free-running mode (initBridge/workerUpdate) is kept for the test
 * suite and as documentation of the earlier pipeline.
 *
 * Loaded after connectome.js, before fly-logic.js and main.js.
 */

(function () {
	'use strict';

	/* ---- constants (tunable, may need adjustment in T7.7) ---- */

	// Intensity applied per worker tick for sustained stimulation.
	// With leak=0.95 and threshold=1.0, V_steady = intensity / (1 - leak).
	// At 0.15: V_steady = 3.0 → fires after ~8 ticks.
	var STIM_INTENSITY = 0.15;

	// Scale factor mapping (fired_fraction_per_group) to BRAIN.postSynaptic values.
	// The behavioral state machine reads accumulators derived from postSynaptic.
	// Motor neuron values of ~5-30 are needed to exceed behavior thresholds.
	var FIRE_STATE_SCALE = 100;

	/* ---- binary fetch with progress ---- */

	function fetchBinaryWithProgress(url, onProgress) {
		return new Promise(function (resolve, reject) {
			var xhr = new XMLHttpRequest();
			xhr.open('GET', url, true);
			xhr.responseType = 'arraybuffer';
			xhr.onprogress = function (e) {
				if (e.lengthComputable) {
					onProgress(e.loaded, e.total);
				} else {
					onProgress(e.loaded, 0);
				}
			};
			xhr.onload = function () {
				// status 0 with a body: file:// load in the iOS WKWebView
				if ((xhr.status >= 200 && xhr.status < 300) || (xhr.status === 0 && xhr.response && xhr.response.byteLength)) {
					resolve(xhr.response);
				} else {
					reject(new Error('HTTP ' + xhr.status + ' fetching ' + url));
				}
			};
			xhr.onerror = function () {
				reject(new Error('Network error fetching ' + url));
			};
			xhr.send();
		});
	}

	function updateLoadingProgress(loaded, total) {
		var subtitle = document.getElementById('connectomeSubtitle');
		if (!subtitle) return;
		var loadedMB = (loaded / (1024 * 1024)).toFixed(1);
		if (total > 0) {
			var totalMB = (total / (1024 * 1024)).toFixed(1);
			subtitle.textContent = 'Loading connectome... ' + loadedMB + ' / ' + totalMB + ' MB';
		} else {
			subtitle.textContent = 'Loading connectome... ' + loadedMB + ' MB';
		}
		subtitle.classList.add('loading');
	}

	/* ---- saved legacy reference ---- */

	var legacyUpdate = BRAIN.update;
	BRAIN.legacyUpdate = legacyUpdate;

	/* ---- module state ---- */

	var worker = null;
	var workerReady = false;
	var latestFireState = null;
	var neuronCount = 0;
	var groupCount = 0;
	var groupIdArr = null;       // Uint16Array[neuronCount] from worker
	var regionTypeArr = null;    // Uint8Array[neuronCount] from worker
	var groupIndices = null;     // Array of Uint32Array per group_id
	var groupSizes = null;       // Array[groupCount] of int from neuron_meta.json
	var groupNameToId = {};      // e.g. {'VIS_R1R6': 0, ...}
	var groupIdToName = [];      // e.g. [0: 'VIS_R1R6', ...]
	var pendingGroupSpikes = null; // Float32Array[groupCount] accumulated since last brain tick
	var pendingWorkerTicks = 0;
	var pendingDriveFrames = 0;  // brain ticks since last updateDrives (for batched catch-up)

	/* ---- initialization ---- */

	function initBridge() {
		var metaUrl = 'data/neuron_meta.json';
		var binUrl = 'data/connectome.bin.gz';
		var subtitle = document.getElementById('connectomeSubtitle');
		if (subtitle) {
			subtitle.textContent = 'Loading connectome...';
			subtitle.classList.add('loading');
		}

		fetch(metaUrl)
			.then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching ' + metaUrl);
				return res.json();
			})
			.then(function (meta) {
				groupCount = meta.group_count;
				groupSizes = meta.group_sizes;
				for (var i = 0; i < meta.groups.length; i++) {
					var g = meta.groups[i];
					groupNameToId[g.name] = g.id;
					groupIdToName[g.id] = g.name;
				}
				return fetchBinaryWithProgress(binUrl, updateLoadingProgress);
			})
			.then(function (buffer) {
				if (subtitle) {
					subtitle.textContent = 'Parsing connectome...';
				}
				worker = new Worker('js/sim-worker.js');
				worker.onmessage = handleWorkerMessage;
				worker.onerror = handleWorkerError;
				worker.postMessage({type: 'init', buffer: buffer}, [buffer]);
			})
			.catch(function (err) {
				console.warn('connectome.bin.gz load failed, using 59-group BRAIN.update():', err);
				BRAIN.update = legacyUpdate;
				if (subtitle) {
					subtitle.textContent = '59 neuron groups \u2014 FlyWire approximation (fallback)';
					subtitle.classList.remove('loading');
				}
			});
	}

	/* ---- worker message handling ---- */

	function handleWorkerMessage(e) {
		switch (e.data.type) {
		case 'ready':
			neuronCount = e.data.neuronCount;
			groupIdArr = new Uint16Array(e.data.groupId.buffer
				? e.data.groupId.buffer : e.data.groupId);
			regionTypeArr = new Uint8Array(e.data.regionType.buffer
				? e.data.regionType.buffer : e.data.regionType);
			pendingGroupSpikes = new Float32Array(groupCount);
			pendingWorkerTicks = 0;
			buildGroupIndices();
			workerReady = true;
			BRAIN.workerReady = true;
			BRAIN.workerNeuronCount = neuronCount;
			BRAIN.workerRegionType = regionTypeArr;
			BRAIN.workerGroupIdArr = groupIdArr;
			BRAIN.workerGroupIdToName = groupIdToName;
			BRAIN.workerGroupSizes = groupSizes;
			BRAIN.workerEdgeCount = e.data.edgeCount;

			// Reset postSynaptic to avoid stale legacy values
			for (var ps in BRAIN.postSynaptic) {
				BRAIN.postSynaptic[ps][0] = 0;
				BRAIN.postSynaptic[ps][1] = 0;
			}

			// Switch to worker-driven update
			BRAIN.update = workerUpdate;
			worker.postMessage({type: 'start'});
			console.log('Connectome worker ready: ' + neuronCount + ' neurons, ' +
				e.data.edgeCount + ' edges');
			// Update subtitle with actual counts
			var subtitle = document.getElementById('connectomeSubtitle');
			if (subtitle) {
				subtitle.textContent = neuronCount.toLocaleString() + ' neurons / ' +
					e.data.edgeCount.toLocaleString() + ' connections \u2014 FlyWire FAFB v783';
				subtitle.classList.remove('loading');
			}
			// Update header scale indicator
			var scaleEl = document.getElementById('scaleIndicator');
			if (scaleEl) {
				scaleEl.textContent = neuronCount.toLocaleString() + ' neurons / ' +
					e.data.edgeCount.toLocaleString() + ' connections \u2014 FlyWire FAFB v783';
				scaleEl.style.display = '';
			}
			break;

		case 'tick':
			latestFireState = e.data.fireState;
			BRAIN.latestFireState = e.data.fireState;
			BRAIN.workerFiredNeurons = e.data.firedNeurons || 0;
			if (pendingGroupSpikes && e.data.groupSpikeCounts) {
				for (var g = 0; g < groupCount; g++) {
					pendingGroupSpikes[g] += e.data.groupSpikeCounts[g] || 0;
				}
				pendingWorkerTicks++;
			}
			break;

		case 'stats':
			/* Display performance info in the connectome subtitle */
			var statsSubtitle = document.getElementById('connectomeSubtitle');
			if (statsSubtitle && !statsSubtitle.classList.contains('loading')) {
				var firedPct = Math.round((e.data.firedNeurons || 0) / e.data.totalNeurons * 100);
				var activePct = Math.round(e.data.activeNeurons / e.data.totalNeurons * 100);
				statsSubtitle.textContent = neuronCount.toLocaleString() + ' neurons (' +
					firedPct + '% firing, ' + activePct + '% active groups, ' +
					e.data.avgTickMs.toFixed(1) + 'ms/tick) \u2014 FlyWire FAFB v783';
			}
			break;

		case 'error':
			console.warn('Worker error: ' + e.data.message);
			if (workerReady) {
				console.warn('Falling back to 59-group BRAIN.update()');
				workerReady = false;
				BRAIN.workerReady = false;
				BRAIN.update = legacyUpdate;
			}
			break;
		}
	}

	function handleWorkerError(err) {
		console.warn('Worker crashed, falling back to 59-group BRAIN.update():', err.message || err);
		workerReady = false;
		BRAIN.workerReady = false;
		BRAIN.update = legacyUpdate;
		var subtitle = document.getElementById('connectomeSubtitle');
		if (subtitle) {
			subtitle.textContent = '59 neuron groups \u2014 FlyWire approximation (fallback)';
			subtitle.classList.remove('loading');
		}
	}

	/* ---- build group-to-neuron-indices lookup ---- */

	function buildGroupIndices() {
		// Count neurons per group
		var counts = new Uint32Array(groupCount);
		for (var i = 0; i < neuronCount; i++) {
			counts[groupIdArr[i]]++;
		}
		// Allocate typed arrays per group
		groupIndices = new Array(groupCount);
		for (var g = 0; g < groupCount; g++) {
			groupIndices[g] = new Uint32Array(counts[g]);
			counts[g] = 0; // reuse as write offset
		}
		// Fill indices
		for (var i = 0; i < neuronCount; i++) {
			var gid = groupIdArr[i];
			groupIndices[gid][counts[gid]++] = i;
		}
	}

	/* ---- virtual VNC motor layer ---- */
	// FlyWire FAFB covers the brain only. Leg and wing motor neurons live in
	// the ventral nerve cord (VNC), which is a separate dataset. Descending
	// neurons (GNG_DESC) are the brain's motor output to the VNC. This function
	// synthesizes what the VNC would produce by distributing descending neuron
	// activation across the motor groups that BRAIN.motorcontrol() reads.
	// Context from central circuits biases the distribution toward the
	// appropriate motor pattern (walk vs flight vs groom vs feed).

	var MOTOR_SCALE = 0.6; // overall gain from descending -> motor groups

	function readPS(name) {
		if (!BRAIN.postSynaptic[name]) return 0;
		return BRAIN.postSynaptic[name][BRAIN.nextState] || 0;
	}

	function addPS(name, val) {
		if (!BRAIN.postSynaptic[name]) return;
		BRAIN.postSynaptic[name][BRAIN.nextState] += val;
	}

	function synthesizeMotorOutputs() {
		var desc = readPS('GNG_DESC');
		var vcpg = readPS('VNC_CPG');

		// Read central circuit activations to infer motor intent
		var cxPfn = readPS('CX_PFN');    // path integration -> locomotion
		var cxFc = readPS('CX_FC');       // fan-shaped body -> locomotion
		var cxEpg = readPS('CX_EPG');     // heading -> steering
		var cxHd = readPS('CX_HDELTA');   // heading delta -> turning
		var sezFeed = readPS('SEZ_FEED');
		var sezGroom = readPS('SEZ_GROOM');
		var mbApp = readPS('MB_MBON_APP'); // approach
		var mbAv = readPS('MB_MBON_AV');   // avoidance
		var lhApp = readPS('LH_APP');      // lateral horn approach
		var lhAv = readPS('LH_AV');        // lateral horn avoidance
		var dFear = readPS('DRIVE_FEAR');
		var dGroom = readPS('DRIVE_GROOM');
		var prob = readPS('MN_PROBOSCIS');
		var head = readPS('MN_HEAD');
		var dnStartle = readPS('DN_STARTLE');
		var noci = readPS('NOCI');

		// Compute motor intent weights (unnormalized, then used proportionally)
		var walkIntent = (cxPfn + cxFc + cxEpg) * 0.3 + (mbApp + lhApp) * 0.5 + (desc + vcpg) * 0.2;
		var flightIntent = dFear * 2.0 + (mbAv + lhAv) * 0.8 + dnStartle * 1.5 + noci * 1.0;
		var groomIntent = dGroom * 1.5 + sezGroom * 1.0;
		var feedIntent = sezFeed * 1.0 + prob * 0.5;
		var descProxy = Math.max(
			walkIntent * 0.45,
			flightIntent * 0.35,
			groomIntent * 0.3,
			feedIntent * 0.25
		);
		if (descProxy > desc) {
			desc = descProxy;
			if (BRAIN.postSynaptic.GNG_DESC) {
				BRAIN.postSynaptic.GNG_DESC[BRAIN.nextState] = desc;
			}
		}
		var total = desc + vcpg;
		if (total < 0.5) return;

		// Baseline: descending activity drives walking (the default motor program)
		var baseWalk = total * MOTOR_SCALE;

		// Scale walk by locomotor intent from CX
		var walkDrive = baseWalk * (1.0 + walkIntent * 0.1);

		// Symmetric left/right walk output. Steering is handled by the behavioral
		// layer (computeMovementForBehavior) using targetDir, not by leg asymmetry.
		// A small random jitter prevents perfectly straight lines.
		var jitter = (Math.random() - 0.5) * 0.04;
		var walkL = walkDrive * (1.0 + jitter) / 3.0;
		var walkR = walkDrive * (1.0 - jitter) / 3.0;

		// Distribute to 3 leg pairs per side
		addPS('MN_LEG_L1', walkL);
		addPS('MN_LEG_L2', walkL);
		addPS('MN_LEG_L3', walkL);
		addPS('MN_LEG_R1', walkR);
		addPS('MN_LEG_R2', walkR);
		addPS('MN_LEG_R3', walkR);

		// Flight: strong avoidance/fear/startle -> wing activation
		if (flightIntent > 1.0) {
			var flightDrive = flightIntent * MOTOR_SCALE * 0.7;
			addPS('MN_WING_L', flightDrive);
			addPS('MN_WING_R', flightDrive);
		}

		// Startle: fear burst -> DN_STARTLE equivalent
		if (dFear > 3.0) {
			addPS('DN_STARTLE', dFear * MOTOR_SCALE);
		}

		// Grooming: groom intent -> abdomen + front legs (motorcontrol reads these)
		if (groomIntent > 1.0) {
			addPS('MN_ABDOMEN', groomIntent * MOTOR_SCALE * 0.3);
		}

		// Feed intent: boost proboscis (already has real neurons, just amplify)
		if (feedIntent > 0.5) {
			addPS('MN_PROBOSCIS', feedIntent * MOTOR_SCALE * 0.3);
		}
	}

	/* ---- worker-driven BRAIN.update replacement ---- */

	function workerUpdate() {
		pendingDriveFrames = Math.min(pendingDriveFrames + 1, 20);

		// One-shot stimuli (e.g. NOCI pain) are sent immediately via the worker
		// 'stimulate' message for direct V injection, not gated on worker ticks.
		// This prevents overwrite by subsequent setStimulusState replacements.
		sendOneShotStimuli();

		// Only run the full pipeline when new worker tick data is available.
		// updateDrives and sendStimulation are throttled to match motor pipeline
		// frequency, preventing drive decay from attenuating transient signals
		// (e.g. fear spikes) before the motor pipeline processes them.
		if (latestFireState || pendingWorkerTicks > 0) {
			// Batch-run drive updates for all elapsed frames since last pipeline run.
			// Calling updateDrives N times preserves per-frame accumulation/decay
			// rates (e.g. fear *= 0.85 runs N times giving 0.85^N total decay).
			for (var i = 0; i < pendingDriveFrames; i++) {
				BRAIN.updateDrives();
			}
			pendingDriveFrames = 0;

			// Send sustained stimulation state to worker
			sendStimulation();

			// Aggregate worker spikes into BRAIN.postSynaptic
			aggregateFireState();

			// Virtual group bypass: groups with 0 real neurons
			var vd = BRAIN.drives;
			if (BRAIN.postSynaptic['DRIVE_FEAR'])
				BRAIN.postSynaptic['DRIVE_FEAR'][BRAIN.nextState] = vd.fear * FIRE_STATE_SCALE;
			if (BRAIN.postSynaptic['DRIVE_CURIOSITY'])
				BRAIN.postSynaptic['DRIVE_CURIOSITY'][BRAIN.nextState] = vd.curiosity * FIRE_STATE_SCALE;
			if (BRAIN.postSynaptic['DRIVE_GROOM'])
				BRAIN.postSynaptic['DRIVE_GROOM'][BRAIN.nextState] = vd.groom * FIRE_STATE_SCALE;

			// Synthesize VNC motor outputs from descending neuron activity
			synthesizeMotorOutputs();

			// Motor control
			BRAIN.motorcontrol();

			// State swap
			for (var ps in BRAIN.postSynaptic) {
				BRAIN.postSynaptic[ps][BRAIN.thisState] =
					BRAIN.postSynaptic[ps][BRAIN.nextState];
			}
			var temp = BRAIN.thisState;
			BRAIN.thisState = BRAIN.nextState;
			BRAIN.nextState = temp;
		}
	}

	/* ---- translate BRAIN.stimulate + BRAIN.drives to worker stimulation ---- */

	function collectOneShotSegments() {
		var segs = [];
		if (BRAIN.stimulate.nociception) {
			segs.push({name: 'NOCI', intensity: STIM_INTENSITY * 5});
			BRAIN.stimulate.nociception = false;
		}
		return segs;
	}

	function collectStimulationSegments() {
		var segs = [];
		var d = BRAIN.drives;

		// Drive stimulation
		if (d.hunger > 0.2) {
			var pulses = d.hunger > 0.6 ? 3 : (d.hunger > 0.4 ? 2 : 1);
			segs.push({name: 'DRIVE_HUNGER', intensity: STIM_INTENSITY * d.hunger * pulses});
		}
		if (d.fear > 0.05) {
			var pulses = d.fear > 0.5 ? 3 : (d.fear > 0.2 ? 2 : 1);
			segs.push({name: 'DRIVE_FEAR', intensity: STIM_INTENSITY * d.fear * pulses});
		}
		if (d.fatigue > 0.3) {
			segs.push({name: 'DRIVE_FATIGUE', intensity: STIM_INTENSITY * d.fatigue});
		}
		if (d.curiosity > 0.2) {
			var pulses = d.curiosity > 0.5 ? 2 : 1;
			segs.push({name: 'DRIVE_CURIOSITY', intensity: STIM_INTENSITY * d.curiosity * pulses});
		}
		if (d.groom > 0.3) {
			segs.push({name: 'DRIVE_GROOM', intensity: STIM_INTENSITY * d.groom});
		}

		// Sensory stimulation
		if (BRAIN.stimulate.touch) {
			segs.push({name: 'MECH_BRISTLE', intensity: STIM_INTENSITY});
			if (BRAIN.stimulate.touchLocation === 'head' ||
				BRAIN.stimulate.touchLocation === 'thorax') {
				segs.push({name: 'MECH_BRISTLE', intensity: STIM_INTENSITY});
			}
		}
		if (BRAIN.stimulate.foodNearby) {
			segs.push({name: 'OLF_ORN_FOOD', intensity: STIM_INTENSITY});
		}
		if (BRAIN.stimulate.foodContact) {
			segs.push({name: 'GUS_GRN_SWEET', intensity: STIM_INTENSITY});
		}
		if (BRAIN.stimulate.dangerOdor) {
			segs.push({name: 'OLF_ORN_DANGER', intensity: STIM_INTENSITY});
		}
		if (BRAIN.stimulate.wind) {
			segs.push({name: 'MECH_JO', intensity: STIM_INTENSITY * BRAIN.stimulate.windStrength});
		}
		if (BRAIN.stimulate.lightLevel > 0.2) {
			segs.push({name: 'VIS_R1R6', intensity: STIM_INTENSITY * BRAIN.stimulate.lightLevel});
			segs.push({name: 'VIS_R7R8', intensity: STIM_INTENSITY * BRAIN.stimulate.lightLevel * 0.7});
		}
		if (BRAIN.stimulate.temperature > 0.65) {
			var warmIntensity = (BRAIN.stimulate.temperature - 0.5) * 2;
			segs.push({name: 'THERMO_WARM', intensity: STIM_INTENSITY * warmIntensity});
		} else if (BRAIN.stimulate.temperature < 0.35) {
			var coolIntensity = (0.5 - BRAIN.stimulate.temperature) * 2;
			segs.push({name: 'THERMO_COOL', intensity: STIM_INTENSITY * coolIntensity});
		}
		if (BRAIN._isMoving) {
			segs.push({name: 'MECH_CHORD', intensity: STIM_INTENSITY});
		}
		if (BRAIN.stimulate.lightLevel > 0.1 && BRAIN._isMoving) {
			segs.push({name: 'VIS_LPTC', intensity: STIM_INTENSITY * 0.3});
		}

		// Tonic background activity
		var tonicIntensity = BRAIN.stimulate.lightLevel === 0 ? 0.03 : 0.08;
		segs.push({name: 'CX_FC', intensity: tonicIntensity});
		segs.push({name: 'CX_EPG', intensity: tonicIntensity});
		segs.push({name: 'CX_PFN', intensity: tonicIntensity});

		return segs;
	}

	function sendOneShotStimuli() {
		var segs = collectOneShotSegments();
		if (!worker || segs.length === 0) return;
		for (var s = 0; s < segs.length; s++) {
			var gid = groupNameToId[segs[s].name];
			if (gid === undefined) continue;
			var idx = groupIndices[gid];
			if (!idx || idx.length === 0) continue;
			var intensities = new Float32Array(idx.length);
			for (var k = 0; k < idx.length; k++) {
				intensities[k] = segs[s].intensity;
			}
			worker.postMessage({type: 'stimulate', indices: idx, intensities: intensities});
		}
	}

	function sendStimulation() {
		if (!worker) return;

		var segs = collectStimulationSegments();

		// Translate named segments to indexed segments using closure state
		var totalLen = 0;
		var indexedSegs = [];
		for (var i = 0; i < segs.length; i++) {
			var gid = groupNameToId[segs[i].name];
			if (gid === undefined) continue;
			var idx = groupIndices[gid];
			if (!idx || idx.length === 0) continue;
			indexedSegs.push({indices: idx, intensity: segs[i].intensity});
			totalLen += idx.length;
		}

		if (totalLen === 0) {
			worker.postMessage({type: 'setStimulusState', indices: null, intensities: null});
			return;
		}

		var allIndices = new Uint32Array(totalLen);
		var allIntensities = new Float32Array(totalLen);
		var offset = 0;
		for (var s = 0; s < indexedSegs.length; s++) {
			var seg = indexedSegs[s];
			allIndices.set(seg.indices, offset);
			for (var k = 0; k < seg.indices.length; k++) {
				allIntensities[offset + k] = seg.intensity;
			}
			offset += seg.indices.length;
		}

		worker.postMessage({type: 'setStimulusState', indices: allIndices, intensities: allIntensities});
	}

	/* ---- aggregate fire state into BRAIN.postSynaptic ---- */

	function aggregateFireState() {
		var groupFires = new Float32Array(groupCount);
		var tickWindow = pendingWorkerTicks;

		if (pendingGroupSpikes && pendingWorkerTicks > 0) {
			groupFires.set(pendingGroupSpikes);
		} else if (latestFireState) {
			var fire = latestFireState;
			tickWindow = 1;
			for (var i = 0; i < neuronCount; i++) {
				if (fire[i]) {
					groupFires[groupIdArr[i]]++;
				}
			}
		}

		if (tickWindow < 1) tickWindow = 1;

		// Normalize by group size, scale, and write to BRAIN.postSynaptic[nextState]
		for (var g = 0; g < groupCount; g++) {
			var name = groupIdToName[g];
			if (!name || !BRAIN.postSynaptic[name]) continue;
			var size = groupSizes[g];
			var windowActivation = size > 0
				? (groupFires[g] / (size * tickWindow)) * FIRE_STATE_SCALE
				: 0;
			var prevActivation = BRAIN.postSynaptic[name][BRAIN.thisState] || 0;
			var activation = Math.max(windowActivation, prevActivation * 0.75);
			BRAIN.postSynaptic[name][BRAIN.nextState] = activation;
		}

		if (pendingGroupSpikes) pendingGroupSpikes.fill(0);
		pendingWorkerTicks = 0;
		latestFireState = null;
	}

	/* ---- pause / resume API for visibilitychange ---- */

	function stopWorker() {
		if (!workerReady || !worker) return;
		worker.postMessage({type: 'stop'});
		worker.postMessage({type: 'setStimulusState', indices: null, intensities: null});
		latestFireState = null;
		if (pendingGroupSpikes) pendingGroupSpikes.fill(0);
		pendingWorkerTicks = 0;
		BRAIN.latestFireState = null;
		pendingDriveFrames = 0;
	}

	function startWorker() {
		if (!workerReady || !worker) return;
		worker.postMessage({type: 'reset'});
		if (pendingGroupSpikes) pendingGroupSpikes.fill(0);
		pendingWorkerTicks = 0;
		pendingDriveFrames = 0;
		worker.postMessage({type: 'start'});
	}

	BRAIN.stopWorker = stopWorker;
	BRAIN.startWorker = startWorker;

	/* ---- garden world: asset loading and validation ---- */

	// XHR rather than fetch: the iOS app loads the site from file:// URLs,
	// where WKWebView's fetch is unreliable but XHR works.
	function fetchJson(url) {
		return new Promise(function (resolve, reject) {
			var xhr = new XMLHttpRequest();
			xhr.open('GET', url, true);
			xhr.onload = function () {
				var okStatus = (xhr.status >= 200 && xhr.status < 300) || (xhr.status === 0 && xhr.responseText);
				if (!okStatus) { reject(new Error('HTTP ' + xhr.status + ' fetching ' + url)); return; }
				try { resolve(JSON.parse(xhr.responseText)); } catch (e) { reject(e); }
			};
			xhr.onerror = function () { reject(new Error('Network error fetching ' + url)); };
			xhr.send();
		});
	}

	function fetchOptionalBinary(url) {
		return fetchBinaryWithProgress(url, function () {}).then(null, function () { return null; });
	}

	function gunzip(buffer) {
		var ds = new DecompressionStream('gzip');
		return new Response(new Blob([buffer]).stream().pipeThrough(ds)).arrayBuffer();
	}

	function sha256Hex(buffer) {
		if (typeof crypto === 'undefined' || !crypto.subtle || !crypto.subtle.digest) return Promise.resolve(null);
		return crypto.subtle.digest('SHA-256', buffer).then(function (h) {
			var b = new Uint8Array(h), out = '';
			for (var i = 0; i < b.length; i++) out += (b[i] < 16 ? '0' : '') + b[i].toString(16);
			return out;
		}, function () { return null; });
	}

	// Loads connectome.bin.gz, neuron_meta.json and (optionally) the neuron
	// sidecar, validates that they describe the same neurons, and starts the
	// worker in step mode. Resolves with
	//   { worker, ready, meta, manifest, sidecar, hashes, validation }
	function loadWorldAssets(opts) {
		opts = opts || {};
		var base = opts.base || 'data/';
		var onProgress = opts.onProgress || updateLoadingProgress;
		var out = { hashes: {} };
		return fetchJson(base + 'neuron_meta.json').then(function (meta) {
			out.meta = meta;
			groupCount = meta.group_count;
			groupSizes = meta.group_sizes;
			for (var i = 0; i < meta.groups.length; i++) {
				groupNameToId[meta.groups[i].name] = meta.groups[i].id;
				groupIdToName[meta.groups[i].id] = meta.groups[i].name;
			}
			return Promise.all([
				fetchBinaryWithProgress(base + 'connectome.bin.gz', onProgress),
				fetchJson(base + 'neuron_sidecar.json').then(null, function () { return null; }),
				fetchOptionalBinary(base + 'neuron_sidecar.bin.gz')
			]);
		}).then(function (parts) {
			var bin = parts[0];
			out.manifest = parts[1];
			return sha256Hex(bin).then(function (hash) {
				if (hash) out.hashes['connectome.bin.gz'] = hash;
				var sidecarPromise = parts[2] && out.manifest ? gunzip(parts[2]) : Promise.resolve(null);
				return sidecarPromise.then(function (sidecarRaw) {
					if (sidecarRaw && typeof WorldBrainAdapter !== 'undefined') {
						try { out.sidecar = WorldBrainAdapter.parseSidecar(sidecarRaw); }
						catch (e) { console.warn('Neuron sidecar rejected:', e.message); out.sidecar = null; }
					}
					return startStepWorker(bin);
				});
			});
		}).then(function (w) {
			out.worker = w.worker;
			out.ready = w.ready;
			if (typeof WorldBrainAdapter !== 'undefined') {
				out.validation = WorldBrainAdapter.validateAssets(out);
				if (!out.validation.ok) console.warn('Connectome asset validation failed', out.validation.checks);
				if (out.sidecar && !out.validation.ok) {
					// Never guess an index mapping: drop directional populations.
					out.sidecar = null;
					out.manifest = null;
				}
			}
			var subtitle = document.getElementById('connectomeSubtitle');
			if (subtitle) {
				subtitle.textContent = out.ready.neuronCount.toLocaleString() + ' neurons / ' +
					out.ready.edgeCount.toLocaleString() + ' connections \u2014 FlyWire FAFB v783';
				subtitle.classList.remove('loading');
			}
			return out;
		});
	}

	function startStepWorker(buffer) {
		return new Promise(function (resolve, reject) {
			var subtitle = document.getElementById('connectomeSubtitle');
			if (subtitle) subtitle.textContent = 'Parsing connectome...';
			var w = new Worker('js/sim-worker.js');
			worker = w;
			w.onmessage = function (e) {
				if (e.data.type === 'ready') {
					neuronCount = e.data.neuronCount;
					groupIdArr = new Uint16Array(e.data.groupId);
					regionTypeArr = new Uint8Array(e.data.regionType);
					pendingGroupSpikes = new Float32Array(groupCount);
					pendingWorkerTicks = 0;
					buildGroupIndices();
					workerReady = true;
					BRAIN.workerReady = true;
					BRAIN.workerNeuronCount = neuronCount;
					BRAIN.workerRegionType = regionTypeArr;
					BRAIN.workerGroupIdArr = groupIdArr;
					BRAIN.workerGroupIdToName = groupIdToName;
					BRAIN.workerGroupSizes = groupSizes;
					BRAIN.workerEdgeCount = e.data.edgeCount;
					for (var ps in BRAIN.postSynaptic) {
						BRAIN.postSynaptic[ps][0] = 0;
						BRAIN.postSynaptic[ps][1] = 0;
					}
					w.onmessage = routeWorkerMessage;
					w.onerror = function (err) { handleStepWorkerFailure(new Error(err.message || 'worker crashed')); };
					resolve({ worker: w, ready: e.data });
				} else if (e.data.type === 'error') {
					reject(new Error(e.data.message));
				}
			};
			w.onerror = function (err) { reject(new Error(err.message || 'worker failed to start')); };
			w.postMessage({ type: 'init', buffer: buffer }, [buffer]);
		});
	}

	// After startup, stats go to the subtitle; step results are routed by the
	// world adapter (which wraps onmessage); errors mark the worker failed.
	function routeWorkerMessage(e) {
		if (e.data.type === 'stats') {
			BRAIN.workerStats = e.data;
		} else if (e.data.type === 'error') {
			handleStepWorkerFailure(new Error(e.data.message));
		}
	}

	var failureListeners = [];
	function handleStepWorkerFailure(err) {
		console.warn('Connectome worker failed:', err.message || err);
		workerReady = false;
		BRAIN.workerReady = false;
		for (var i = 0; i < failureListeners.length; i++) failureListeners[i](err);
	}

	// Mirrors one garden neural step into BRAIN.postSynaptic for displays.
	// `virtual` fills groups with no neurons in the export (drives, VNC motor
	// groups) from the modeled state, which the UI labels as modeled.
	function displayWorldStep(result, virtual) {
		if (!result || !result.groupSpikeCounts) return;
		pendingGroupSpikes = pendingGroupSpikes || new Float32Array(groupCount);
		for (var g = 0; g < groupCount; g++) pendingGroupSpikes[g] = result.groupSpikeCounts[g] || 0;
		pendingWorkerTicks = result.ticks || 1;
		latestFireState = null;
		aggregateFireState();
		if (virtual) {
			for (var name in virtual) {
				if (BRAIN.postSynaptic[name]) BRAIN.postSynaptic[name][BRAIN.nextState] = virtual[name] * FIRE_STATE_SCALE;
			}
		}
		for (var ps in BRAIN.postSynaptic) {
			BRAIN.postSynaptic[ps][BRAIN.thisState] = BRAIN.postSynaptic[ps][BRAIN.nextState];
		}
		var temp = BRAIN.thisState;
		BRAIN.thisState = BRAIN.nextState;
		BRAIN.nextState = temp;
		if (result.fireState) BRAIN.latestFireState = result.fireState;
		BRAIN.workerFiredNeurons = result.firedNeurons || 0;
	}

	BRAIN.workerBridge = {
		load: loadWorldAssets,
		displayWorldStep: displayWorldStep,
		onFailure: function (fn) { failureListeners.push(fn); },
		fail: handleStepWorkerFailure,
		worker: function () { return worker; }
	};

	/* ---- start / test mode ---- */

	if (BRAIN._testMode) {
		BRAIN._bridge = {
			synthesizeMotorOutputs: synthesizeMotorOutputs,
			aggregateFireState: aggregateFireState,
			buildGroupIndices: buildGroupIndices,
			collectStimulationSegments: collectStimulationSegments,
			collectOneShotSegments: collectOneShotSegments,
			workerUpdate: workerUpdate,
			FIRE_STATE_SCALE: FIRE_STATE_SCALE,
			MOTOR_SCALE: MOTOR_SCALE,
			STIM_INTENSITY: STIM_INTENSITY,
			_setGroupState: function (gc, nc, gIdArr, gSizes, gIdToNameArr) {
				groupCount = gc;
				neuronCount = nc;
				groupIdArr = gIdArr;
				groupSizes = gSizes;
				groupIdToName = gIdToNameArr;
				groupNameToId = {};
				for (var i = 0; i < gIdToNameArr.length; i++) {
					if (gIdToNameArr[i]) groupNameToId[gIdToNameArr[i]] = i;
				}
				pendingGroupSpikes = new Float32Array(gc);
				pendingWorkerTicks = 0;
				pendingDriveFrames = 0;
			},
			_setFireState: function (fireState, spikes, ticks) {
				latestFireState = fireState;
				if (spikes) pendingGroupSpikes = spikes;
				pendingWorkerTicks = ticks;
			},
			_getGroupIndices: function () {
				return groupIndices;
			},
		};
	}
	// Non-test pages call BRAIN.workerBridge.load() (garden) themselves.

})();
