/* LIF neuron simulator Web Worker — T7.3 + T7.7 (neuropil-gated) + world step mode
 *
 * Leaky integrate-and-fire simulation over the full Drosophila connectome.
 * Receives a binary connectome ArrayBuffer (optionally gzipped) on init.
 *
 * T7.7 optimizations:
 * - Neuropil-gated simulation: only tick neurons in active groups,
 *   lazy-activate groups when stimulation or synaptic input arrives.
 * - SIMD-friendly memory layout: neurons physically reordered by group
 *   so each group occupies a contiguous range in all typed arrays.
 *   CSR matrix remapped to match. (struct-of-arrays, group-sorted)
 * - Tick rate reduced to 10/sec; renderer interpolates brightness.
 *
 * World step mode (FLY-WORLD-PLAN phase 1/2):
 * - 'step' requests carry a stepId, the sustained stimulus for that step, and
 *   optional one-shot pulses. The worker runs exactly `ticks` ticks and replies
 *   with a 'stepResult' carrying the same stepId. No timers are involved, so a
 *   run is a pure function of (connectome, params, initial state, requests).
 * - 'definePopulations' registers named neuron index lists (sorted index space)
 *   whose spike counts are returned with every step result. This is how
 *   hemisphere-specific sidecar populations are read out without scanning all
 *   neurons on the main thread.
 * - 'ready' reports sortedToOriginal so callers can map original (binary/
 *   sidecar) neuron indices onto the worker's group-sorted order.
 * - 'snapshot' / 'restore' copy the full dynamic state for replay.
 *
 * Brains (one per fly): every array a tick changes (voltage, fire state,
 * refractory counters, group gating, the sustained stimulus) belongs to a
 * brain; the connectome, metadata and readout populations are shared.
 * Messages carry `brain` (default 0). 'stepBatch' steps several brains in
 * one message and replies with one 'stepBatchResult'. 'reset' with a brain
 * resets that brain; without one it resets brain 0 and releases the rest.
 * A brain that has never been stepped is a reset brain.
 *
 * Binary format (little-endian):
 *   Header:   2 x uint32  -- neuron_count, edge_count
 *   Edges:    edge_count x (uint32 pre, uint32 post, float32 weight), sorted by pre
 *   Metadata: neuron_count x (uint8 region_type, uint16 group_id)
 *
 * Weights in the binary are signed synapse counts. By default they are scaled
 * so the largest |weight| equals WEIGHT_SCALE (legacy). setParams can instead
 * set `synapseWeight`, the voltage contributed by one synapse (in threshold
 * units), which is the calibrated mode used by the garden simulation.
 *
 * Message protocol:
 *   Main -> Worker: init, start, stop, stimulate, setStimulusState, setParams,
 *                   reset, step, stepBatch, definePopulations, snapshot, restore
 *   Worker -> Main: ready, tick, stats, error, stepResult, stepBatchResult,
 *                   snapshot, restored
 */

/* ---------- constants ---------- */
var DEFAULT_LEAK_RATE = 0.95;
var DEFAULT_THRESHOLD = 1.0;
var DEFAULT_REFRACTORY_PERIOD = 3;
var WEIGHT_SCALE = 0.15;
var TARGET_TICK_RATE = 10;
var MIN_TICK_RATE = 5;
var COOLDOWN_TICKS = 20;
var STATS_INTERVAL = 20;

/* ---------- module-level state ---------- */
var N = 0;
var edgeCount = 0;
var V = null;               // Float32Array[N] voltage (group-sorted)
var fired = null;            // Uint8Array[N] fire state (group-sorted)
var refractory = null;       // Uint8Array[N] refractory counter (group-sorted)
var rowPtr = null;           // Uint32Array[N+1] CSR row pointers (group-sorted)
var colIdx = null;           // Uint32Array[edgeCount] CSR col indices (group-sorted)
var values = null;           // Float32Array[edgeCount] CSR edge weights
var regionType = null;       // Uint8Array[N] region per neuron (group-sorted)
var groupId = null;          // Uint16Array[N] group per neuron (group-sorted)
var sortedToOriginal = null; // Uint32Array[N] original binary index per sorted position
var maxAbsWeight = 0;        // largest |raw weight| (synapse count) in the binary
var currentWeightScale = 0;  // multiplier currently applied to raw weights
var leakRate = DEFAULT_LEAK_RATE;
var threshold = DEFAULT_THRESHOLD;
var refractoryPeriod = DEFAULT_REFRACTORY_PERIOD;
var running = false;
var sustainedIndices = null;
var sustainedIntensities = null;
var tickCount = 0;
var targetTickRate = TARGET_TICK_RATE;
var tickTimeSum = 0;
var tickTimeSamples = 0;
var activeNeuronCount = 0;
var cumulativeFiredCount = 0;

/* readout populations (sorted index space) */
var populations = [];        // [{name, indices: Uint32Array}]

/* neuropil-gated simulation structures (built by buildGroupStructures) */
var numGroups = 0;
var groupOffset = null;          // Uint32Array[numGroups+1] prefix sum
var groupActive = null;          // Uint8Array[numGroups]
var groupCooldown = null;        // Uint8Array[numGroups]
var groupRecvInput = null;       // Uint8Array[numGroups] per-tick scratch
var groupFiredThisTick = null;   // Uint8Array[numGroups] per-tick scratch
var groupStimulatedThisTick = null; // Uint8Array[numGroups] per-tick scratch

/* brains: the module-level arrays above are the selected brain's; the
 * others wait in `brains` until selected (a pointer swap, so the tick code
 * is the same for one brain or many) */
var brains = [];
var selectedBrain = 0;

function selectBrain(id) {
	id = id | 0;
	if (id === selectedBrain) return;
	brains[selectedBrain] = { V: V, fired: fired, refractory: refractory, groupActive: groupActive, groupCooldown: groupCooldown,
		sustainedIndices: sustainedIndices, sustainedIntensities: sustainedIntensities, tickCount: tickCount };
	var b = brains[id] || { V: new Float32Array(N), fired: new Uint8Array(N), refractory: new Uint8Array(N),
		groupActive: new Uint8Array(numGroups), groupCooldown: new Uint8Array(numGroups),
		sustainedIndices: null, sustainedIntensities: null, tickCount: 0 };
	brains[id] = null;
	V = b.V; fired = b.fired; refractory = b.refractory; groupActive = b.groupActive; groupCooldown = b.groupCooldown;
	sustainedIndices = b.sustainedIndices; sustainedIntensities = b.sustainedIntensities; tickCount = b.tickCount;
	selectedBrain = id;
}

/* ---------- decompressGzip ---------- */

async function decompressGzip(buffer) {
	var ds = new DecompressionStream('gzip');
	var writer = ds.writable.getWriter();
	writer.write(new Uint8Array(buffer));
	writer.close();
	var reader = ds.readable.getReader();
	var chunks = [];
	while (true) {
		var result = await reader.read();
		if (result.done) break;
		chunks.push(result.value);
	}
	var totalLen = 0;
	for (var c = 0; c < chunks.length; c++) {
		totalLen += chunks[c].byteLength;
	}
	var out = new Uint8Array(totalLen);
	var offset = 0;
	for (var c = 0; c < chunks.length; c++) {
		out.set(chunks[c], offset);
		offset += chunks[c].byteLength;
	}
	return out.buffer;
}

/* ---------- parseBinary ---------- */

function parseBinary(buffer) {
	var view = new DataView(buffer);
	N = view.getUint32(0, true);
	edgeCount = view.getUint32(4, true);

	var edgeOffset = 8;
	var metaOffset = edgeOffset + edgeCount * 12;
	var expectedBytes = metaOffset + N * 3;
	if (buffer.byteLength !== expectedBytes) {
		throw new Error('Connectome binary size mismatch: header implies ' + expectedBytes +
			' bytes, got ' + buffer.byteLength);
	}

	/* allocate CSR arrays (original index space, remapped later) */
	rowPtr = new Uint32Array(N + 1);
	colIdx = new Uint32Array(edgeCount);
	values = new Float32Array(edgeCount);

	/* first pass -- count outgoing edges per neuron */
	for (var e = 0; e < edgeCount; e++) {
		var pre = view.getUint32(edgeOffset + e * 12, true);
		rowPtr[pre + 1]++;
	}

	/* prefix sum -- convert counts to cumulative offsets */
	for (var i = 1; i <= N; i++) {
		rowPtr[i] += rowPtr[i - 1];
	}

	/* second pass -- fill colIdx, values, find maxAbsWeight */
	var maxAbsW = 0;
	for (var e = 0; e < edgeCount; e++) {
		var base = edgeOffset + e * 12;
		colIdx[e] = view.getUint32(base + 4, true);
		var rawW = view.getFloat32(base + 8, true);
		values[e] = rawW;
		var absW = rawW < 0 ? -rawW : rawW;
		if (absW > maxAbsW) maxAbsW = absW;
	}
	maxAbsWeight = maxAbsW;

	/* normalize weights (legacy scale; setParams.synapseWeight can rescale) */
	currentWeightScale = maxAbsW > 0 ? WEIGHT_SCALE / maxAbsW : 1;
	if (maxAbsW > 0) {
		for (var e = 0; e < edgeCount; e++) {
			values[e] = values[e] * currentWeightScale;
		}
	}

	/* read per-neuron metadata (original order) */
	regionType = new Uint8Array(N);
	groupId = new Uint16Array(N);
	for (var i = 0; i < N; i++) {
		regionType[i] = view.getUint8(metaOffset + i * 3);
		groupId[i] = view.getUint16(metaOffset + i * 3 + 1, true);
	}

	/* allocate simulation state (brain 0) */
	V = new Float32Array(N);
	fired = new Uint8Array(N);
	refractory = new Uint8Array(N);
	tickCount = 0;
	brains = [];
	selectedBrain = 0;
}

/* ---------- buildGroupStructures ---------- */
/* Reorders all per-neuron arrays and the CSR matrix so neurons within each
 * group occupy a contiguous range. Enables cache-friendly iteration over
 * only active groups (neuropil gating) and SIMD-friendly memory access.
 * The reorder is a stable counting sort, so sortedToOriginal is a pure
 * function of the binary's group_id column. */

function buildGroupStructures() {
	/* determine number of groups */
	numGroups = 0;
	for (var i = 0; i < N; i++) {
		if (groupId[i] >= numGroups) numGroups = groupId[i] + 1;
	}

	/* count neurons per group */
	var counts = new Uint32Array(numGroups);
	for (var i = 0; i < N; i++) {
		counts[groupId[i]]++;
	}

	/* build prefix-sum offsets */
	groupOffset = new Uint32Array(numGroups + 1);
	for (var g = 0; g < numGroups; g++) {
		groupOffset[g + 1] = groupOffset[g] + counts[g];
	}

	/* build sortedByGroup: sortedByGroup[sorted_pos] = original_index */
	var sortedByGroup = new Uint32Array(N);
	var writePos = new Uint32Array(numGroups);
	for (var g = 0; g < numGroups; g++) writePos[g] = groupOffset[g];
	for (var i = 0; i < N; i++) {
		var g = groupId[i];
		sortedByGroup[writePos[g]++] = i;
	}
	sortedToOriginal = sortedByGroup;

	/* reverse mapping: originalToSorted[original_index] = sorted_pos */
	var originalToSorted = new Uint32Array(N);
	for (var s = 0; s < N; s++) {
		originalToSorted[sortedByGroup[s]] = s;
	}

	/* remap CSR to sorted index space */
	var newRowPtr = new Uint32Array(N + 1);
	for (var s = 0; s < N; s++) {
		var o = sortedByGroup[s];
		newRowPtr[s + 1] = rowPtr[o + 1] - rowPtr[o];
	}
	for (var s = 1; s <= N; s++) {
		newRowPtr[s] += newRowPtr[s - 1];
	}
	var newColIdx = new Uint32Array(edgeCount);
	var newValues = new Float32Array(edgeCount);
	for (var s = 0; s < N; s++) {
		var o = sortedByGroup[s];
		var wp = newRowPtr[s];
		for (var j = rowPtr[o]; j < rowPtr[o + 1]; j++) {
			newColIdx[wp] = originalToSorted[colIdx[j]];
			newValues[wp] = values[j];
			wp++;
		}
	}
	rowPtr = newRowPtr;
	colIdx = newColIdx;
	values = newValues;

	/* remap per-neuron metadata to sorted order */
	var newGroupId = new Uint16Array(N);
	var newRegionType = new Uint8Array(N);
	for (var s = 0; s < N; s++) {
		newGroupId[s] = groupId[sortedByGroup[s]];
		newRegionType[s] = regionType[sortedByGroup[s]];
	}
	groupId = newGroupId;
	regionType = newRegionType;

	/* V, fired, refractory are zero-initialized -- no remap needed */

	/* allocate per-group activation state */
	groupActive = new Uint8Array(numGroups);
	groupCooldown = new Uint8Array(numGroups);
	groupRecvInput = new Uint8Array(numGroups);
	groupFiredThisTick = new Uint8Array(numGroups);
	groupStimulatedThisTick = new Uint8Array(numGroups);
}

/* ---------- runTick (neuropil-gated, no messaging) ---------- */
/* Advances the network by one tick using the current sustained stimulus.
 * Adds this tick's per-group spike counts into groupSpikeCounts and returns
 * the number of neurons that fired. */

function runTick(groupSpikeCounts) {
	var firedNeuronCount = 0;

	/* reset per-tick scratch */
	groupRecvInput.fill(0);
	groupFiredThisTick.fill(0);
	groupStimulatedThisTick.fill(0);
	activeNeuronCount = 0;

	/* activate groups with sustained stimulation */
	if (sustainedIndices) {
		for (var k = 0; k < sustainedIndices.length; k++) {
			var si = sustainedIndices[k];
			if (si < N) {
				var g = groupId[si];
				groupStimulatedThisTick[g] = 1;
				if (!groupActive[g]) {
					groupActive[g] = 1;
					groupCooldown[g] = COOLDOWN_TICKS;
				}
			}
		}
	}

	/* step 1 -- decay V and refractory for active groups (contiguous access) */
	for (var g = 0; g < numGroups; g++) {
		if (!groupActive[g]) continue;
		var start = groupOffset[g];
		var end = groupOffset[g + 1];
		activeNeuronCount += end - start;
		for (var i = start; i < end; i++) {
			if (refractory[i] > 0) {
				refractory[i]--;
				V[i] = 0;
			} else {
				V[i] *= leakRate;
			}
		}
	}

	/* step 1.5 -- apply sustained external stimulation */
	if (sustainedIndices) {
		for (var k = 0; k < sustainedIndices.length; k++) {
			var si = sustainedIndices[k];
			if (si < N && refractory[si] === 0) {
				V[si] += sustainedIntensities[k];
			}
		}
	}

	/* step 2 -- propagate from fired neurons in active groups */
	for (var g = 0; g < numGroups; g++) {
		if (!groupActive[g]) continue;
		for (var i = groupOffset[g]; i < groupOffset[g + 1]; i++) {
			if (fired[i] === 0) continue;
			for (var j = rowPtr[i]; j < rowPtr[i + 1]; j++) {
				var target = colIdx[j];
				V[target] += values[j];
				groupRecvInput[groupId[target]] = 1;
			}
		}
	}

	/* activate groups that received synaptic input */
	for (var g = 0; g < numGroups; g++) {
		if (groupRecvInput[g] && !groupActive[g]) {
			groupActive[g] = 1;
			groupCooldown[g] = COOLDOWN_TICKS;
		}
	}

	/* step 3 -- clear fired + threshold check for active groups */
	for (var g = 0; g < numGroups; g++) {
		if (!groupActive[g]) continue;
		var start = groupOffset[g];
		var end = groupOffset[g + 1];
		for (var i = start; i < end; i++) {
			fired[i] = 0;
			if (refractory[i] === 0 && V[i] >= threshold) {
				fired[i] = 1;
				V[i] = 0;
				refractory[i] = refractoryPeriod;
				groupFiredThisTick[g] = 1;
				groupSpikeCounts[g]++;
				firedNeuronCount++;
			}
		}
	}

	/* update group cooldowns -- deactivate idle groups */
	for (var g = 0; g < numGroups; g++) {
		if (!groupActive[g]) continue;
		if (groupFiredThisTick[g] || groupRecvInput[g] || groupStimulatedThisTick[g]) {
			groupCooldown[g] = COOLDOWN_TICKS;
		} else {
			groupCooldown[g]--;
			if (groupCooldown[g] <= 0) {
				groupActive[g] = 0;
				/* clear residual state for deactivated group */
				var start = groupOffset[g];
				var end = groupOffset[g + 1];
				V.fill(0, start, end);
				fired.fill(0, start, end);
				refractory.fill(0, start, end);
			}
		}
	}

	tickCount++;
	return firedNeuronCount;
}

/* ---------- tick (free-running legacy mode) ---------- */

function tick() {
	var t0 = performance.now();
	var groupSpikeCounts = new Uint16Array(numGroups);
	var firedNeuronCount = runTick(groupSpikeCounts);

	/* post fire state to main thread */
	self.postMessage({
		type: 'tick',
		fireState: fired,
		firedNeurons: firedNeuronCount,
		groupSpikeCounts: groupSpikeCounts,
		tickCount: tickCount - 1
	});

	recordStats(performance.now() - t0, firedNeuronCount);

	/* schedule next tick at target rate */
	if (running) {
		var interval = Math.max(0, Math.floor(1000 / targetTickRate - (performance.now() - t0)));
		setTimeout(tick, interval);
	}
}

/* ---------- performance stats ---------- */

function recordStats(elapsed, firedNeuronCount) {
	tickTimeSum += elapsed;
	tickTimeSamples++;
	cumulativeFiredCount += firedNeuronCount;

	if (tickTimeSamples >= STATS_INTERVAL) {
		var avgMs = tickTimeSum / tickTimeSamples;
		var avgFired = Math.round(cumulativeFiredCount / tickTimeSamples);
		var activeGroups = 0;
		for (var g = 0; g < numGroups; g++) {
			if (groupActive[g]) activeGroups++;
		}
		self.postMessage({
			type: 'stats',
			avgTickMs: avgMs,
			firedNeurons: avgFired,
			activeNeurons: activeNeuronCount,
			totalNeurons: N,
			activeGroups: activeGroups,
			totalGroups: numGroups,
			tickRate: targetTickRate
		});
		tickTimeSum = 0;
		tickTimeSamples = 0;
		cumulativeFiredCount = 0;
	}
}

/* ---------- one-shot voltage injection ---------- */

function applyPulses(indices, intensities) {
	if (!indices) return;
	for (var k = 0; k < indices.length; k++) {
		var idx = indices[k];
		if (idx < N) {
			V[idx] += intensities[k];
			/* activate target group for neuropil gating */
			if (groupActive && !groupActive[groupId[idx]]) {
				groupActive[groupId[idx]] = 1;
				groupCooldown[groupId[idx]] = COOLDOWN_TICKS;
			}
		}
	}
}

/* ---------- step mode ---------- */

function countPopulationSpikes(out) {
	for (var p = 0; p < populations.length; p++) {
		var idx = populations[p].indices;
		var c = 0;
		for (var k = 0; k < idx.length; k++) {
			if (fired[idx[k]]) c++;
		}
		out[p] += c;
	}
}

function runStep(msg) {
	var t0 = performance.now();
	var ticks = msg.ticks > 0 ? msg.ticks : 1;
	if (msg.stimulus !== undefined) {
		sustainedIndices = msg.stimulus ? msg.stimulus.indices : null;
		sustainedIntensities = msg.stimulus ? msg.stimulus.intensities : null;
	}
	if (msg.pulses) applyPulses(msg.pulses.indices, msg.pulses.intensities);

	var groupSpikeCounts = new Uint32Array(numGroups);
	var popSpikeCounts = new Uint32Array(populations.length);
	var firedTotal = 0;
	for (var t = 0; t < ticks; t++) {
		firedTotal += runTick(groupSpikeCounts);
		countPopulationSpikes(popSpikeCounts);
	}
	var elapsed = performance.now() - t0;
	recordStats(elapsed, firedTotal);

	var result = {
		type: 'stepResult',
		stepId: msg.stepId,
		brain: selectedBrain,
		ticks: ticks,
		tickCount: tickCount,
		firedNeurons: firedTotal,
		activeNeurons: activeNeuronCount,
		groupSpikeCounts: groupSpikeCounts,
		popSpikeCounts: popSpikeCounts,
		computeMs: elapsed
	};
	if (msg.wantFireState) result.fireState = fired.slice();
	return result;
}

/* ---------- snapshot / restore ---------- */

function snapshotState() {
	return {
		V: V.slice(),
		fired: fired.slice(),
		refractory: refractory.slice(),
		groupActive: groupActive.slice(),
		groupCooldown: groupCooldown.slice(),
		tickCount: tickCount,
		leakRate: leakRate,
		threshold: threshold,
		refractoryPeriod: refractoryPeriod,
		weightScale: currentWeightScale
	};
}

function restoreState(s) {
	V.set(s.V);
	fired.set(s.fired);
	refractory.set(s.refractory);
	groupActive.set(s.groupActive);
	groupCooldown.set(s.groupCooldown);
	tickCount = s.tickCount;
	leakRate = s.leakRate;
	threshold = s.threshold;
	refractoryPeriod = s.refractoryPeriod;
	if (s.weightScale && s.weightScale !== currentWeightScale) setWeightScale(s.weightScale);
}

function setWeightScale(scale) {
	var ratio = scale / currentWeightScale;
	for (var e = 0; e < edgeCount; e++) values[e] *= ratio;
	currentWeightScale = scale;
}

function resetState() {
	V.fill(0);
	fired.fill(0);
	refractory.fill(0);
	sustainedIndices = null;
	sustainedIntensities = null;
	if (groupActive) {
		groupActive.fill(0);
		groupCooldown.fill(0);
		groupRecvInput.fill(0);
		groupFiredThisTick.fill(0);
		groupStimulatedThisTick.fill(0);
	}
	tickCount = 0;
	tickTimeSum = 0;
	tickTimeSamples = 0;
	cumulativeFiredCount = 0;
	activeNeuronCount = 0;
}

/* ---------- message handler ---------- */

self.onmessage = function (e) {
	switch (e.data.type) {

	case 'init':
		try {
			var buffer = e.data.buffer;

			function postReady() {
				buildGroupStructures();
				self.postMessage({type: 'ready', neuronCount: N, edgeCount: edgeCount,
					groupId: groupId, regionType: regionType,
					sortedToOriginal: sortedToOriginal, maxAbsWeight: maxAbsWeight,
					weightScale: currentWeightScale});
			}

			var header = new Uint8Array(buffer, 0, 2);
			if (header[0] === 0x1f && header[1] === 0x8b) {
				decompressGzip(buffer).then(function (raw) {
					parseBinary(raw);
					postReady();
				}).catch(function (err) {
					self.postMessage({type: 'error', message: 'Decompression failed: ' + err.message});
				});
				return;
			}

			parseBinary(buffer);
			postReady();
		} catch (err) {
			self.postMessage({type: 'error', message: 'Init failed: ' + err.message});
		}
		break;

	case 'start':
		if (N === 0) {
			self.postMessage({type: 'error', message: 'Cannot start: not initialized'});
			return;
		}
		selectBrain(0);   /* free-running (legacy) mode runs brain 0 */
		running = true;
		setTimeout(tick, 0);
		break;

	case 'stop':
		running = false;
		break;

	case 'stimulate':
		selectBrain(e.data.brain || 0);
		applyPulses(e.data.indices, e.data.intensities);
		break;

	case 'setStimulusState':
		selectBrain(e.data.brain || 0);
		sustainedIndices = e.data.indices;
		sustainedIntensities = e.data.intensities;
		break;

	case 'reset':
		if (N === 0) break;
		if (e.data.brain !== undefined) {
			selectBrain(e.data.brain);
		} else {
			selectBrain(0);
			brains = [];
		}
		resetState();
		break;

	case 'setParams':
		if (e.data.leakRate !== undefined) leakRate = e.data.leakRate;
		if (e.data.threshold !== undefined) threshold = e.data.threshold;
		if (e.data.refractoryPeriod !== undefined) refractoryPeriod = e.data.refractoryPeriod;
		if (e.data.synapseWeight !== undefined && N > 0) setWeightScale(e.data.synapseWeight);
		break;

	case 'definePopulations':
		populations = [];
		var defs = e.data.populations || [];
		for (var p = 0; p < defs.length; p++) {
			populations.push({name: defs[p].name, indices: defs[p].indices});
		}
		break;

	case 'step':
		if (N === 0) {
			self.postMessage({type: 'error', message: 'Cannot step: not initialized', stepId: e.data.stepId});
			return;
		}
		running = false; /* step mode and free-running mode are exclusive */
		selectBrain(e.data.brain || 0);
		self.postMessage(runStep(e.data));
		break;

	case 'stepBatch':
		if (N === 0) {
			self.postMessage({type: 'error', message: 'Cannot step: not initialized', batchId: e.data.batchId});
			return;
		}
		running = false;
		var steps = e.data.steps || [], results = [], transfer = [];
		for (var s = 0; s < steps.length; s++) {
			selectBrain(steps[s].brain || 0);
			var r = runStep(steps[s]);
			if (r.fireState) transfer.push(r.fireState.buffer);
			results.push(r);
		}
		self.postMessage({type: 'stepBatchResult', batchId: e.data.batchId, results: results}, transfer);
		break;

	case 'snapshot':
		if (N === 0) break;
		selectBrain(e.data.brain || 0);
		self.postMessage({type: 'snapshot', requestId: e.data.requestId, state: snapshotState()});
		break;

	case 'restore':
		if (N === 0) break;
		selectBrain(e.data.brain || 0);
		restoreState(e.data.state);
		self.postMessage({type: 'restored', requestId: e.data.requestId});
		break;
	}
};
