/* world-brain-adapter.js -- Sensory encoding, neural readout, the modeled
 * VNC motor adapter, brain backends, and pathway diagnostics.
 *
 * Signal path (one neural step = 100 ms of simulation time):
 *   senses --encode--> per-neuron stimulus (sidecar populations, by side)
 *          --worker step--> spike counts per readout population
 *          --readout--> smoothed rates and baseline-subtracted responses
 *          --motor adapter--> forward / turn / escape / feeding outputs
 *
 * What is connectome and what is modeled (see docs/world-model.md):
 *   - Every rate read here is produced by the LIF worker running the FlyWire
 *     connectome (or, in fallback, by the 59-group approximation).
 *   - FAFB contains no ventral nerve cord, so turning descending-neuron
 *     activity into leg movement is a modeled adapter. Its terms are listed
 *     in MOTOR_CHANNELS with an explicit `source` label.
 *   - Two steering terms are a small modeled sensorimotor circuit (odor
 *     bilateral comparison and odor-gated upwind turning). The baseline
 *     harness found no lateralized odor signal at the descending-neuron level,
 *     so they are labeled "modeled" and can be switched off (validated mode).
 */
(function (root) {
	'use strict';

	function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

	/* ================= assets: sidecar parsing and validation ================= */

	var SIDE_LEFT = 1, SIDE_RIGHT = 2;

	// Parses data/neuron_sidecar.bin (already decompressed).
	function parseSidecar(buffer) {
		var dv = new DataView(buffer);
		var magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
		if (magic !== 'FBSC') throw new Error('neuron sidecar: bad magic ' + magic);
		var version = dv.getUint32(4, true);
		var n = dv.getUint32(8, true);
		var expected = 12 + n * 8 + n + n * 4;
		if (buffer.byteLength !== expected) throw new Error('neuron sidecar: size ' + buffer.byteLength + ' != ' + expected);
		var side = new Uint8Array(buffer, 12 + n * 8, n);
		var mask = new Uint32Array(n);
		var off = 12 + n * 9;
		for (var i = 0; i < n; i++) mask[i] = dv.getUint32(off + i * 4, true);
		return { version: version, neuronCount: n, side: side, mask: mask, rootIdOffset: 12, dv: dv };
	}

	// Parses data/neuron_positions.bin (already decompressed): per-neuron
	// FAFB positions in nm, original index order. Display-only.
	function parsePositions(buffer) {
		var dv = new DataView(buffer);
		var magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
		if (magic !== 'FBNP') throw new Error('neuron positions: bad magic ' + magic);
		var version = dv.getUint32(4, true);
		var n = dv.getUint32(8, true);
		var expected = 36 + n * 6;
		if (buffer.byteLength !== expected) throw new Error('neuron positions: size ' + buffer.byteLength + ' != ' + expected);
		var min = [], max = [];
		for (var a = 0; a < 3; a++) { min.push(dv.getFloat32(12 + a * 4, true)); max.push(dv.getFloat32(24 + a * 4, true)); }
		var q = new Uint16Array(n * 3);
		for (var i = 0; i < n * 3; i++) q[i] = dv.getUint16(36 + i * 2, true);
		return { version: version, neuronCount: n, min: min, max: max, q: q };
	}

	// Position of neuron `o` (original index) in the fly's body frame, in
	// brain widths from the centre of the brain's bounds: [0] forward
	// (anterior), [1] up (dorsal), [2] toward the fly's right. FAFB image
	// space is mirrored, so neurons annotated side=left have smaller x; this
	// mapping puts them on the fly's left, matching the sensory sides.
	function brainFramePosition(p, o, out) {
		var q = p.q, w = p.max[0] - p.min[0];
		out[0] = -(q[o * 3 + 2] / 65535 - 0.5) * (p.max[2] - p.min[2]) / w;
		out[1] = -(q[o * 3 + 1] / 65535 - 0.5) * (p.max[1] - p.min[1]) / w;
		out[2] = q[o * 3] / 65535 - 0.5;
		return out;
	}

	// Positions are only drawn if they describe the loaded connectome's
	// neurons in its index order; a mismatch drops them (never guessed).
	function validatePositions(positions, manifest, ready, hashes) {
		if (!positions || !manifest) return { ok: false, detail: 'not provided' };
		if (positions.neuronCount !== ready.neuronCount || manifest.neuron_count !== ready.neuronCount) {
			return { ok: false, detail: 'neuron count ' + positions.neuronCount + ' vs ' + ready.neuronCount };
		}
		var have = hashes && hashes['connectome.bin.gz'];
		if (have && manifest.hashes && manifest.hashes['connectome.bin.gz'] !== have) {
			return { ok: false, detail: 'built from a different connectome.bin.gz' };
		}
		return { ok: true, detail: have ? 'matches connectome.bin.gz' : 'count matches (hashing unavailable)' };
	}

	function rootIdAt(parsed, i) {
		var lo = parsed.dv.getUint32(parsed.rootIdOffset + i * 8, true);
		var hi = parsed.dv.getUint32(parsed.rootIdOffset + i * 8 + 4, true);
		return (BigInt(hi) * BigInt(4294967296) + BigInt(lo)).toString();
	}

	// Checks that the connectome binary, group metadata, sidecar and worker
	// all describe the same neurons in the same order.
	function validateAssets(info) {
		var checks = [];
		function check(name, ok, detail) { checks.push({ name: name, ok: !!ok, detail: detail || '' }); }
		var meta = info.meta, ready = info.ready, manifest = info.manifest;
		check('binary neuron count matches neuron_meta.json', ready.neuronCount === meta.neuron_count,
			ready.neuronCount + ' vs ' + meta.neuron_count);
		check('binary edge count matches neuron_meta.json', ready.edgeCount === meta.edge_count,
			ready.edgeCount + ' vs ' + meta.edge_count);
		var counts = new Array(meta.group_count).fill(0);
		for (var i = 0; i < ready.groupId.length; i++) counts[ready.groupId[i]]++;
		var sizesOk = true;
		for (var g = 0; g < meta.group_count; g++) if (counts[g] !== meta.group_sizes[g]) sizesOk = false;
		check('group sizes match neuron_meta.json', sizesOk);
		if (manifest) {
			check('sidecar neuron count matches binary', manifest.neuron_count === ready.neuronCount &&
				(!info.sidecar || info.sidecar.neuronCount === ready.neuronCount));
			var mSizesOk = true;
			for (var g2 = 0; g2 < meta.group_count; g2++) if (manifest.group_sizes[g2] !== meta.group_sizes[g2]) mSizesOk = false;
			check('sidecar was built from these group sizes', mSizesOk);
			if (info.hashes && info.hashes['connectome.bin.gz']) {
				check('connectome.bin.gz hash matches sidecar manifest',
					info.hashes['connectome.bin.gz'] === manifest.hashes['connectome.bin.gz'], info.hashes['connectome.bin.gz'].slice(0, 12));
			} else {
				checks.push({ name: 'connectome.bin.gz hash', ok: true, skipped: true, detail: 'hashing unavailable in this context' });
			}
			if (info.sidecar) {
				// Index order: every sidecar population's recorded counts must be
				// reproduced after mapping through the worker order.
				var popOk = true;
				for (var p = 0; p < manifest.populations.length; p++) {
					var pd = manifest.populations[p];
					var c = 0, cl = 0, cr = 0;
					for (var n = 0; n < info.sidecar.neuronCount; n++) {
						if ((info.sidecar.mask[n] >>> pd.bit) & 1) {
							c++;
							if (info.sidecar.side[n] === SIDE_LEFT) cl++;
							else if (info.sidecar.side[n] === SIDE_RIGHT) cr++;
						}
					}
					if (c !== pd.count || cl !== pd.count_left || cr !== pd.count_right) popOk = false;
				}
				check('sidecar population counts reproduce', popOk);
			}
		}
		var ok = checks.every(function (c) { return c.ok; });
		return { ok: ok, checks: checks };
	}

	// Deterministic shuffle so graded recruitment always picks the same cells
	// for a given signal level. Seeded by the population name (a property of
	// the model, not of the run).
	function hashString(s) {
		var h = 2166136261;
		for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
		return h >>> 0;
	}

	function shuffled(arr, seed) {
		var out = Uint32Array.from(arr);
		var rng = { s: seed };
		for (var i = out.length - 1; i > 0; i--) {
			var j = Math.floor(root.WorldRandom.next(rng) * (i + 1));
			var t = out[i]; out[i] = out[j]; out[j] = t;
		}
		return out;
	}

	// Builds sorted-index-space neuron lists for every sidecar population (by
	// side) and every binary group.
	function buildPopulations(ready, meta, sidecar, manifest) {
		var N = ready.neuronCount;
		var s2o = ready.sortedToOriginal;
		var pops = {};
		var groups = {};
		var g, i;
		var groupLists = [];
		for (g = 0; g < meta.group_count; g++) groupLists.push([]);
		for (i = 0; i < N; i++) groupLists[ready.groupId[i]].push(i);
		for (g = 0; g < meta.groups.length; g++) {
			groups[meta.groups[g].name] = Uint32Array.from(groupLists[meta.groups[g].id]);
		}
		if (sidecar && manifest) {
			var lists = {};
			manifest.populations.forEach(function (p) { lists[p.name + '_L'] = []; lists[p.name + '_R'] = []; lists[p.name] = []; });
			for (var s = 0; s < N; s++) {
				var o = s2o[s];
				var m = sidecar.mask[o];
				if (!m) continue;
				var side = sidecar.side[o];
				for (var q = 0; q < manifest.populations.length; q++) {
					var pd = manifest.populations[q];
					if ((m >>> pd.bit) & 1) {
						lists[pd.name].push(s);
						if (side === SIDE_LEFT) lists[pd.name + '_L'].push(s);
						else if (side === SIDE_RIGHT) lists[pd.name + '_R'].push(s);
					}
				}
			}
			for (var name in lists) pops[name] = shuffled(lists[name], hashString(name));
		}
		return { pops: pops, groups: groups, hasSidecar: !!(sidecar && manifest) };
	}

	/* ================= readout populations ================= */

	// Populations whose spikes are counted every step (order = worker index).
	var READOUT_POPS = [
		'DN_L', 'DN_R',
		'DN_ODOR_RANKED_L', 'DN_ODOR_RANKED_R',
		'DN_LOOM_RANKED_L', 'DN_LOOM_RANKED_R',
		'DN_TOUCH_RANKED_L', 'DN_TOUCH_RANKED_R',
		'MN_PROBOSCIS',
		'LH_NEURON_L', 'LH_NEURON_R', 'ALPN_L', 'ALPN_R',
		'ORN_FOOD_L', 'ORN_FOOD_R',
		'VPN_LOOM_PROXY_L', 'VPN_LOOM_PROXY_R',
		'GRN_SUGAR', 'JO_WIND_L', 'JO_WIND_R', 'MECH_TOUCH_L', 'MECH_TOUCH_R'
	];

	/* ================= encoder ================= */

	// Input channels. `pop` names a sidecar population (sorted indices);
	// `group` names a binary group used when no sidecar population applies.
	function createEncoder(cfg, popsInfo) {
		var bc = cfg.brain;
		var pops = popsInfo.pops, groups = popsInfo.groups;
		var lastInputs = {};
		// Receptor adaptation: each antenna's odor drive is divided by a slow
		// running level, so sustained odor compresses and rising odor stands out.
		var adapt = { L: 0, R: 0 };

		// Graded recruitment: a larger signal recruits more of the (fixed,
		// shuffled) population and drives each recruited cell harder.
		function recruit(target, list, signal, intensityScale) {
			if (!list || list.length === 0 || !(signal > 0.01)) return 0;
			signal = clamp(signal, 0, 1);
			var n = Math.max(1, Math.round(list.length * Math.pow(signal, 0.8)));
			var intensity = (bc.stimMin + (bc.stimMax - bc.stimMin) * signal) * (intensityScale || 1);
			for (var k = 0; k < n; k++) { target.idx.push(list[k]); target.val.push(intensity); }
			return n;
		}

		function bulk(target, list, intensity) {
			if (!list || list.length === 0 || !(intensity > 0)) return 0;
			for (var k = 0; k < list.length; k++) { target.idx.push(list[k]); target.val.push(intensity); }
			return list.length;
		}

		function lerpGain(pair, h) { return pair[0] + (pair[1] - pair[0]) * clamp(h, 0, 1); }
		function sat(x, k) { return x > 0 ? x / (x + k) : 0; }

		// Returns {stimulus, pulses, inputs} for one neural step.
		function encode(senses, drives, silenced) {
			var sus = { idx: [], val: [] };
			var pul = { idx: [], val: [] };
			var inputs = {};
			var hunger = drives.hunger;
			var food = !silenced.foodInput, threat = !silenced.threatInput;

			// olfaction: graded, side-specific, hunger-modulated gain, adapting
			var og = lerpGain(bc.hungerOdorGain, hunger);
			var xL = senses.odor.left * og, xR = senses.odor.right * og;
			var aa = 1 - Math.exp(-bc.neuralDt / bc.odorAdaptTau);
			adapt.L += (xL - adapt.L) * aa;
			adapt.R += (xR - adapt.R) * aa;
			inputs.odorL = food ? sat(xL, bc.odorHalfSat + bc.odorAdaptGain * adapt.L) : 0;
			inputs.odorR = food ? sat(xR, bc.odorHalfSat + bc.odorAdaptGain * adapt.R) : 0;
			inputs.odorLRecruited = recruit(sus, pops.ORN_FOOD_L || groups.OLF_ORN_FOOD, inputs.odorL);
			inputs.odorRRecruited = recruit(sus, pops.ORN_FOOD_R, inputs.odorR);

			// taste: requires contact; hunger raises sugar sensitivity
			var tg = lerpGain(bc.hungerTasteGain, hunger);
			inputs.sugar = food ? clamp(senses.taste.sugar * tg, 0, 1) : 0;
			recruit(sus, pops.GRN_SUGAR || groups.GUS_GRN_SWEET, inputs.sugar);

			// visual web cue -> LC/LPLC-like proxy, per eye
			inputs.threatL = threat ? sat(senses.threat.left, 0.6) : 0;
			inputs.threatR = threat ? sat(senses.threat.right, 0.6) : 0;
			recruit(sus, pops.VPN_LOOM_PROXY_L, inputs.threatL);
			recruit(sus, pops.VPN_LOOM_PROXY_R, inputs.threatR);

			// touch and silk: sustained contact plus a one-shot pulse
			var t = senses.touch;
			inputs.touchL = clamp(Math.max(t.left, t.silkLeft), 0, 1);
			inputs.touchR = clamp(Math.max(t.right, t.silkRight), 0, 1);
			if (t.nociception) { inputs.touchL = 1; inputs.touchR = 1; }
			recruit(sus, pops.MECH_TOUCH_L || groups.MECH_BRISTLE, inputs.touchL);
			recruit(sus, pops.MECH_TOUCH_R, inputs.touchR);
			if (t.onsetL) recruit(pul, pops.MECH_TOUCH_L || groups.MECH_BRISTLE, 1, bc.contactPulse / bc.stimMax);
			if (t.onsetR) recruit(pul, pops.MECH_TOUCH_R, 1, bc.contactPulse / bc.stimMax);

			// wind at each antenna
			inputs.windL = senses.wind.left;
			inputs.windR = senses.wind.right;
			recruit(sus, pops.JO_WIND_L || groups.MECH_JO, inputs.windL);
			recruit(sus, pops.JO_WIND_R, inputs.windR);

			// light per eye (bulk photoreceptor drive, as in the legacy bridge)
			inputs.lightL = senses.light.left;
			inputs.lightR = senses.light.right;
			if (pops.PHOTORECEPTOR_L) {
				bulk(sus, pops.PHOTORECEPTOR_L, bc.lightStim * inputs.lightL);
				bulk(sus, pops.PHOTORECEPTOR_R, bc.lightStim * inputs.lightR);
			} else {
				bulk(sus, groups.VIS_R1R6, bc.lightStim * senses.light.level);
			}

			// temperature
			var temp = senses.temperature;
			if (temp > 0.65) bulk(sus, groups.THERMO_WARM, bc.lightStim * (temp - 0.5) * 2);
			else if (temp < 0.35) bulk(sus, groups.THERMO_COOL, bc.lightStim * (0.5 - temp) * 2);

			// internal state (populated drive groups only)
			if (hunger > 0.2) bulk(sus, groups.DRIVE_HUNGER, bc.hungerDriveStim * hunger);
			if (drives.fatigue > 0.3) bulk(sus, groups.DRIVE_FATIGUE, bc.hungerDriveStim * drives.fatigue);

			// tonic central complex activity, scaled by curiosity and light
			var tonic = bc.tonicCentral * (0.5 + drives.curiosity) * (senses.light.level < 0.05 ? 0.4 : 1);
			bulk(sus, groups.CX_FC, tonic);
			bulk(sus, groups.CX_EPG, tonic);
			bulk(sus, groups.CX_PFN, tonic);

			inputs.tonic = tonic;
			lastInputs = inputs;
			return {
				stimulus: { indices: Uint32Array.from(sus.idx), intensities: Float32Array.from(sus.val) },
				pulses: pul.idx.length ? { indices: Uint32Array.from(pul.idx), intensities: Float32Array.from(pul.val) } : null,
				inputs: inputs
			};
		}

		return {
			encode: encode,
			lastInputs: function () { return lastInputs; },
			snapshot: function () { return { L: adapt.L, R: adapt.R }; },
			restore: function (st) { adapt.L = st.L; adapt.R = st.R; }
		};
	}

	/* ================= readout ================= */

	// Smoothing time constants (s) per readout; the default suits fast
	// defensive signals, olfactory and walking readouts are slower.
	var READOUT_TAU = {
		DN_L: 1.0, DN_R: 1.0,
		LH_NEURON_L: 0.8, LH_NEURON_R: 0.8, ALPN_L: 0.8, ALPN_R: 0.8,
		DN_ODOR_RANKED_L: 0.8, DN_ODOR_RANKED_R: 0.8,
		MN_PROBOSCIS: 1.5          // 24 neurons, low rates: integrate ~1.5 s so single spikes cannot read as feeding
	};

	// Converts spike counts into smoothed rates and baseline-subtracted
	// responses. During settling the baseline equals the rate. Afterwards it
	// follows the rate down quickly and up slowly (adaptation over ~30 s), so
	// fixed anatomical left/right imbalances do not read as a turn command.
	// Baseline upward adaptation (s). Olfactory readouts adapt very slowly:
	// receptor adaptation is already modeled in the encoder, and in a garden
	// full of fruit a fast baseline would treat food odor as background.
	var FLOOR_UP_TAU = { LH_NEURON_L: 120, LH_NEURON_R: 120, ALPN_L: 120, ALPN_R: 120 };

	function createReadout(cfg, names, sizes) {
		var rates = {}, floor = {}, resp = {}, raw = {};
		names.forEach(function (n) { rates[n] = 0; floor[n] = 0; resp[n] = 0; raw[n] = 0; });

		function update(counts, ticks, dt, settling) {
			var down = 1 - Math.exp(-dt / 1.5);
			for (var i = 0; i < names.length; i++) {
				var n = names[i];
				var size = sizes[i] || 0;
				var r = size > 0 ? counts[i] / (size * Math.max(1, ticks)) : 0;
				var a = 1 - Math.exp(-dt / (READOUT_TAU[n] || cfg.brain.readoutTau));
				raw[n] = r;
				rates[n] += (r - rates[n]) * a;
				var up = 1 - Math.exp(-dt / (FLOOR_UP_TAU[n] || 30));
				if (settling) floor[n] = rates[n];
				else floor[n] += (rates[n] - floor[n]) * (rates[n] < floor[n] ? down : up);
				resp[n] = Math.max(0, rates[n] - floor[n]);
			}
		}

		function snapshot() { return { rates: copy(rates), floor: copy(floor), resp: copy(resp) }; }
		function restore(s) { copyInto(rates, s.rates); copyInto(floor, s.floor); copyInto(resp, s.resp); }
		function copy(o) { var c = {}; for (var k in o) c[k] = o[k]; return c; }
		function copyInto(t, s) { for (var k in s) t[k] = s[k]; }

		return { update: update, rates: rates, floor: floor, resp: resp, raw: raw, snapshot: snapshot, restore: restore };
	}

	/* ================= motor adapter (modeled VNC) ================= */

	// Every motor term, where its input comes from, and whether it is part of
	// the connectome-only ("validated") mode.
	var MOTOR_CHANNELS = {
		walkDrive:   { source: 'connectome', label: 'Descending-neuron activity sets walking drive' },
		odorSalience:{ source: 'connectome', label: 'Odor-evoked lateral horn activity (ORN -> PN -> LH) marks food odor' },
		threatTurn:  { source: 'connectome', label: 'Left/right loom-ranked DN response turns away from the stronger side' },
		touchTurn:   { source: 'connectome', label: 'Left/right touch-ranked DN response turns away from contact' },
		escape:      { source: 'connectome', label: 'Loom- and touch-ranked DN response above threshold triggers escape' },
		feeding:     { source: 'connectome', label: 'Proboscis motor neuron response permits feeding (with contact)' },
		odorSurge:   { source: 'connectome', label: 'Rising lateral horn odor response speeds walking (surge)' },
		klinokinesis:{ source: 'connectome', label: 'Falling lateral horn odor response increases turning; rising response straightens the path' },
		odorTurn:    { source: 'modeled', label: 'Modeled bilateral comparison: turn toward the antenna smelling more, gated by the lateral horn odor response' },
		upwindTurn:  { source: 'modeled', label: 'Modeled odor-gated upwind turning' },
		wander:      { source: 'modeled', label: 'Modeled VNC pattern generator: exploratory turning noise' },
		bouts:       { source: 'modeled', label: 'Modeled VNC pattern generator: walking bouts alternate with pauses' },
		groom:       { source: 'modeled', label: 'Grooming urge (SEZ_GROOM is empty in the export)' },
		brace:       { source: 'modeled', label: 'Johnston\'s organ response braces against gusts' }
	};

	// Gains (modeled VNC). Spans convert rate responses (fraction of a
	// population firing per tick) into unit outputs; they come from the
	// calibrated response ranges in docs/connectome-baseline.md. Dead zones
	// keep network fluctuations from reading as commands.
	var MOTOR = {
		dnQuiet: 0.008, dnSpan: 0.018,
		odorSpan: 0.04, loomSpan: 0.05, touchSpan: 0.02, probSpan: 0.008, joSpan: 0.03,
		threatGate: [0.15, 0.4], touchGate: [0.1, 0.3], odorGate: [0.1, 0.4], upwindGate: [0.3, 0.7],
		threatTurnGain: 4.0, touchTurnGain: 3.5,
		odorTurnGain: 60.0, upwindGain: 0.6,
		wanderSigma: 0.9, wanderTau: 0.7,
		escapeThreshold: 0.55, escapeSpan: 0.5, threatDeadZone: 0.2, touchDeadZone: 0.15, fearSensitization: 0.2,
		klinoGain: 1.2,
		surgeGain: 0.6,
		stopRate: 0.07, goRate: 0.45     // per s: bout switching of the modeled pattern generator
	};

	function smoothstep(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

	function createMotorAdapter(cfg, options) {
		options = options || {};
		var mode = options.mode || 'hybrid';
		var wander = 0;
		var odorPrev = 0, odorTrend = 0;
		var pausing = false;

		function setMode(m) { mode = m; }

		// ro: readout {rates, resp}; senses; drives; rng (simulation RNG)
		function compute(ro, senses, drives, rng, dt, silenced) {
			var r = ro.rates, p = ro.resp;
			var out = { contributions: {} };
			if (silenced.motorOutput) {
				// Broad output silencing: every neural term is zeroed, which
				// reveals any residual scripted navigation.
				r = zeroed(r); p = zeroed(p);
			}
			var dn = (r.DN_L || 0) + (r.DN_R || 0);
			out.walkDrive = clamp(((dn * 0.5) - MOTOR.dnQuiet) / MOTOR.dnSpan, 0, 1);
			out.odorResponse = clamp(((p.LH_NEURON_L || 0) + (p.LH_NEURON_R || 0)) * 0.5 / MOTOR.odorSpan, 0, 1.5);
			// Walking bouts: pauses start at a low rate when nothing is sensed
			// and end sooner when descending drive is high (simulation RNG).
			var calm = (1 - 0.6 * Math.min(1, out.odorResponse)) * (1 - Math.min(1, Math.max(p.DN_LOOM_RANKED_L || 0, p.DN_LOOM_RANKED_R || 0) / MOTOR.loomSpan));
			var u = root.WorldRandom.next(rng);
			if (pausing) { if (u < MOTOR.goRate * (0.3 + out.walkDrive) * dt) pausing = false; }
			else if (u < MOTOR.stopRate * calm * dt) pausing = true;
			out.pausing = pausing;
			if (pausing) out.walkDrive *= 0.1;
			var loomL = clamp((p.DN_LOOM_RANKED_L || 0) / MOTOR.loomSpan, 0, 2);
			var loomR = clamp((p.DN_LOOM_RANKED_R || 0) / MOTOR.loomSpan, 0, 2);
			var touchL = clamp((p.DN_TOUCH_RANKED_L || 0) / MOTOR.touchSpan, 0, 2);
			var touchR = clamp((p.DN_TOUCH_RANKED_R || 0) / MOTOR.touchSpan, 0, 2);
			out.threatL = loomL; out.threatR = loomR; out.touchL = touchL; out.touchR = touchR;
			out.proboscis = clamp((p.MN_PROBOSCIS || 0) / MOTOR.probSpan, 0, 1.5);
			out.jo = clamp(((p.JO_WIND_L || 0) + (p.JO_WIND_R || 0)) * 0.5 / MOTOR.joSpan, 0, 1.5);
			var threatMax = Math.max(loomL, loomR), touchMax = Math.max(touchL, touchR);

			// turning terms (rad/s, positive = left)
			var c = out.contributions;
			c.threatTurn = -MOTOR.threatTurnGain * (loomL - loomR) * smoothstep(MOTOR.threatGate[0], MOTOR.threatGate[1], threatMax);
			c.touchTurn = -MOTOR.touchTurnGain * (touchL - touchR) * smoothstep(MOTOR.touchGate[0], MOTOR.touchGate[1], touchMax);
			var modeled = mode !== 'connectome' && !silenced.motorOutput;
			var odorGate = smoothstep(MOTOR.odorGate[0], MOTOR.odorGate[1], out.odorResponse);
			var oL = senses.odor.left, oR = senses.odor.right;
			var lateral = (oL + oR) > 1e-6 ? (oL - oR) / (oL + oR) : 0;
			c.odorTurn = modeled ? MOTOR.odorTurnGain * odorGate * lateral : 0;
			c.upwindTurn = modeled ? MOTOR.upwindGain * smoothstep(MOTOR.upwindGate[0], MOTOR.upwindGate[1], out.odorResponse) *
				Math.sin(senses.wind.sourceBearing) * Math.min(1, senses.wind.strength * 4) : 0;
			// change in the neural odor response over time (smoothed ~0.5 s)
			var odorNow = out.odorResponse;
			var rising = (odorNow - odorPrev) / Math.max(dt, 1e-3);
			odorPrev = odorNow;
			odorTrend += (rising - odorTrend) * (1 - Math.exp(-dt / 0.5));
			out.odorRising = odorTrend;
			out.surge = clamp(odorTrend * MOTOR.surgeGain, -0.3, 0.5) * odorGate;

			// exploratory wander: Ornstein-Uhlenbeck noise from the simulation RNG,
			// scaled by klinokinesis (turn more while the odor response falls)
			var theta = dt / MOTOR.wanderTau;
			wander += -wander * theta + MOTOR.wanderSigma * Math.sqrt(2 * theta) * root.WorldRandom.normal(rng);
			var klino = clamp(1 - MOTOR.klinoGain * odorTrend * odorGate, 0.3, 2.5);
			c.wander = silenced.motorOutput ? 0 : wander * out.walkDrive * klino;
			out.klinokinesis = klino;

			out.turn = c.threatTurn + c.touchTurn + c.odorTurn + c.upwindTurn + c.wander;

			// urgent defensive output; fear lowers the threshold (sensitization)
			var drive = Math.max(0, threatMax - MOTOR.threatDeadZone) + 0.8 * Math.max(0, touchMax - MOTOR.touchDeadZone);
			var thr = MOTOR.escapeThreshold * (1 - MOTOR.fearSensitization * drives.fear);
			out.escape = clamp((drive - thr) / MOTOR.escapeSpan, 0, 1);
			out.escapeSign = (loomR + touchR) >= (loomL + touchL) ? 1 : -1;  // turn toward the quieter side
			out.threat = threatMax;
			out.touch = touchMax;
			out.takeoff = out.escape > 0.95 && drives.fear > 0.75 ? 1 : 0;
			out.groom = drives.groom;
			out.brace = senses.wind.gust ? clamp(out.jo * 0.5 + senses.wind.strength * 0.6, 0, 1) : 0;

			// dominant turning term, for explanations
			var best = 'none', bestMag = 0.25;
			for (var k in c) { if (Math.abs(c[k]) > bestMag) { bestMag = Math.abs(c[k]); best = k; } }
			out.dominantTurn = best;
			return out;
		}

		function zeroed(o) { var z = {}; for (var k in o) z[k] = 0; return z; }

		function snapshot() { return { wander: wander, odorPrev: odorPrev, odorTrend: odorTrend, mode: mode, pausing: pausing }; }
		function restore(s) { wander = s.wander; odorPrev = s.odorPrev; odorTrend = s.odorTrend || 0; mode = s.mode; pausing = !!s.pausing; }

		return { compute: compute, setMode: setMode, mode: function () { return mode; }, snapshot: snapshot, restore: restore };
	}

	/* ================= backends ================= */

	// Connectome backend: drives a sim-worker in step mode. `port` is either a
	// browser Worker or the Node harness ({post: fn} returning replies).
	function createConnectomeBackend(opts) {
		var port = opts.port;
		var ready = opts.ready, meta = opts.meta;
		var popsInfo = buildPopulations(ready, meta, opts.sidecar, opts.manifest);
		var available = READOUT_POPS.filter(function (n) { return popsInfo.pops[n] && popsInfo.pops[n].length > 0; });
		var sizes = available.map(function (n) { return popsInfo.pops[n].length; });
		var pending = {};
		var sync = typeof port.post === 'function';

		function send(msg, transfer) {
			if (sync) return port.post(msg);
			port.postMessage(msg, transfer || []);
			return null;
		}

		send({ type: 'setParams', synapseWeight: opts.synapseWeight });
		send({ type: 'definePopulations', populations: available.map(function (n) {
			return { name: n, indices: popsInfo.pops[n] };
		}) });

		if (!sync) {
			var prev = port.onmessage;
			port.onmessage = function (e) {
				var d = e.data;
				if (d && d.type === 'stepResult' && pending[d.stepId]) {
					var cb = pending[d.stepId];
					delete pending[d.stepId];
					cb(d);
				} else if (prev) {
					prev.call(port, e);
				}
			};
		}

		// request: {stepId, stimulus, pulses, wantFireState}; cb(result)
		function step(request, cb) {
			var msg = { type: 'step', stepId: request.stepId, ticks: opts.ticksPerStep || 1,
				stimulus: request.stimulus, pulses: request.pulses, wantFireState: !!request.wantFireState };
			if (sync) {
				cb(send(msg));
			} else {
				pending[request.stepId] = cb;
				var tr = [];
				if (request.stimulus) tr.push(request.stimulus.indices.buffer, request.stimulus.intensities.buffer);
				if (request.pulses) tr.push(request.pulses.indices.buffer, request.pulses.intensities.buffer);
				send(msg, tr);
			}
		}

		function reset() { send({ type: 'reset' }); }

		return {
			kind: 'connectome',
			label: ready.neuronCount.toLocaleString() + '-neuron FlyWire connectome',
			popsInfo: popsInfo,
			readoutNames: available,
			readoutSizes: sizes,
			groupNames: meta.groups.map(function (g) { return g.name; }),
			groupSizes: meta.group_sizes,
			step: step,
			reset: reset,
			synchronous: sync
		};
	}

	// Fallback backend: the 59-group hand-authored approximation (constants.js).
	// It has no hemispheres, so its left/right readouts are identical and any
	// steering comes from the modeled circuit; the UI labels this mode.
	function createLegacyBackend(opts) {
		var B = opts.BRAIN;
		var legacyUpdate = opts.legacyUpdate || B.update;
		var names = ['DN_L', 'DN_R', 'DN_ODOR_RANKED_L', 'DN_ODOR_RANKED_R', 'DN_LOOM_RANKED_L', 'DN_LOOM_RANKED_R',
			'DN_TOUCH_RANKED_L', 'DN_TOUCH_RANKED_R', 'MN_PROBOSCIS', 'JO_WIND_L', 'JO_WIND_R'];
		var sizes = names.map(function () { return 100; });

		function ps(n) { return B.postSynaptic[n] ? B.postSynaptic[n][B.thisState] : 0; }

		function step(request, cb) {
			var inp = request.inputs;
			B.stimulate.foodNearby = (inp.odorL + inp.odorR) > 0.2;
			B.stimulate.foodContact = inp.sugar > 0.05;
			B.stimulate.touch = (inp.touchL + inp.touchR) > 0.3;
			B.stimulate.touchLocation = B.stimulate.touch ? 'thorax' : null;
			B.stimulate.wind = (inp.windL + inp.windR) > 0.4;
			B.stimulate.windStrength = clamp(inp.windL + inp.windR, 0, 1);
			B.stimulate.lightLevel = (inp.lightL + inp.lightR) * 0.5;
			B.stimulate.temperature = request.temperature;
			// visual threat reaches the legacy VIS_LC group directly
			var savedDrives = {};
			for (var k in B.drives) { savedDrives[k] = B.drives[k]; B.drives[k] = request.drives[k]; }
			var visLC = (inp.threatL + inp.threatR) * 0.5;
			if (visLC > 0.05 && B.weights.VIS_LC) B.dendriteAccumulateScaled('VIS_LC', visLC * 3);
			legacyUpdate();
			for (var k2 in savedDrives) B.drives[k2] = savedDrives[k2];
			var walk = (B.accumWalkLeft + B.accumWalkRight) / 2;
			var odor = (ps('LH_APP') + ps('MB_MBON_APP')) / 2;
			var counts = [walk, walk, odor, odor, B.accumStartle * (0.5 + inp.threatL), B.accumStartle * (0.5 + inp.threatR),
				ps('MECH_BRISTLE') * inp.touchL, ps('MECH_BRISTLE') * inp.touchR, B.accumFeed, ps('MECH_JO'), ps('MECH_JO')];
			cb({ type: 'stepResult', stepId: request.stepId, ticks: 1, legacy: true,
				popSpikeCounts: counts.map(function (v) { return Math.max(0, v) * 0.1; }), firedNeurons: 0 });
		}

		return {
			kind: 'legacy',
			label: '59-group approximation (fallback)',
			readoutNames: names,
			readoutSizes: sizes,
			step: step,
			reset: function () { B.setup(); },
			synchronous: true
		};
	}

	root.WorldBrainAdapter = {
		parseSidecar: parseSidecar,
		parsePositions: parsePositions,
		validatePositions: validatePositions,
		brainFramePosition: brainFramePosition,
		rootIdAt: rootIdAt,
		validateAssets: validateAssets,
		buildPopulations: buildPopulations,
		createEncoder: createEncoder,
		createReadout: createReadout,
		createMotorAdapter: createMotorAdapter,
		createConnectomeBackend: createConnectomeBackend,
		createLegacyBackend: createLegacyBackend,
		READOUT_POPS: READOUT_POPS,
		MOTOR_CHANNELS: MOTOR_CHANNELS,
		MOTOR: MOTOR
	};
})(typeof window !== 'undefined' ? window : globalThis);
