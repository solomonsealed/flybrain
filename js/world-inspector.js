/* world-inspector.js -- Observation overlays, event timeline, live traces,
 * object inspection and experiment controls for the garden.
 *
 * Everything shown here is read from recorded simulation data: sensory
 * samples, encoder inputs, readout rates and motor outputs from each neural
 * step. Explanations say which signals rose and which motor term won; they
 * never invent intentions.
 */
(function (root) {
	'use strict';

	var WS = root.WorldState;

	function $(id) { return document.getElementById(id); }
	function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
	function fmt(v, d) { return (v === undefined || v === null || !isFinite(v)) ? '-' : Number(v).toFixed(d === undefined ? 2 : d); }
	function pct(v) { return Math.round(clamp(v, 0, 1) * 100) + '%'; }

	var BEHAVIOR_COLORS = {
		walk: '#8cc8ff', feed: '#ffcc40', startle: '#ff5a4d', fly: '#d88cff', groom: '#99ff99',
		rest: '#9999b3', idle: '#8a8a8a', brace: '#99e6e6', snagged: '#ff3399'
	};

	var BEHAVIOR_WORDS = {
		walk: 'walking', feed: 'feeding', startle: 'escaping', fly: 'flying', groom: 'grooming',
		rest: 'resting', idle: 'standing still', brace: 'bracing against the wind', snagged: 'caught in silk'
	};

	function create(app) {
		var cfg = app.config;
		var panel = $('world-inspector');
		var trace = $('wiTrace');
		var tctx = trace ? trace.getContext('2d') : null;
		var eventsEl = $('wiEvents');
		var selection = null;
		var activeTab = 'trace';
		var eventLog = [];
		var MAX_EVENTS = 150;

		/* ---------- tabs and visibility ---------- */

		var tabs = document.querySelectorAll('.wi-tab');
		for (var i = 0; i < tabs.length; i++) {
			tabs[i].addEventListener('click', function () {
				activeTab = this.getAttribute('data-tab');
				for (var j = 0; j < tabs.length; j++) tabs[j].classList.toggle('active', tabs[j] === this);
				var panels = document.querySelectorAll('.wi-panel');
				for (var k = 0; k < panels.length; k++) panels[k].style.display = panels[k].getAttribute('data-panel') === activeTab ? '' : 'none';
			});
		}
		function show(on) {
			if (!panel) return;
			panel.style.display = on ? '' : 'none';
			var btn = $('inspectorBtn');
			if (btn) { btn.classList.toggle('active', on); btn.setAttribute('aria-pressed', on ? 'true' : 'false'); }
		}
		function toggle() { show(panel.style.display === 'none'); return panel.style.display !== 'none'; }
		function showTab(name) {
			var t = document.querySelector('.wi-tab[data-tab="' + name + '"]');
			if (t) t.click();
		}
		if ($('wiClose')) $('wiClose').addEventListener('click', function () { show(false); });

		/* ---------- experiment controls ---------- */

		var scenarioSel = $('wiScenario');
		if (scenarioSel) {
			Object.keys(cfg.scenarios).forEach(function (k) {
				var o = document.createElement('option');
				o.value = k;
				o.textContent = cfg.scenarios[k].label;
				scenarioSel.appendChild(o);
			});
			var note = function () { $('wiScenarioNote').textContent = cfg.scenarios[scenarioSel.value].description; };
			scenarioSel.addEventListener('change', note);
			note();
		}
		function runOptions() {
			return {
				scenario: scenarioSel ? scenarioSel.value : 'free',
				seed: Math.max(1, parseInt($('wiSeed').value, 10) || 1),
				mode: $('wiMode').value
			};
		}
		if ($('wiRun')) $('wiRun').addEventListener('click', function () { app.newRun(runOptions()); });
		if ($('wiReplay')) $('wiReplay').addEventListener('click', function () { app.replay(); });
		if ($('wiExport')) $('wiExport').addEventListener('click', function () { app.exportLog(); });
		if ($('wiMode')) $('wiMode').addEventListener('change', function () { app.setMode(this.value); });
		if ($('wiSpeed')) $('wiSpeed').addEventListener('change', function () { app.setSpeed(parseFloat(this.value)); });
		var checks = document.querySelectorAll('[data-silence]');
		for (var c = 0; c < checks.length; c++) {
			checks[c].addEventListener('change', function () {
				app.command({ type: 'silence', params: { channel: this.getAttribute('data-silence'), on: this.checked }, source: 'experiment' });
			});
		}

		function syncControls(run) {
			if (!run) return;
			if (scenarioSel && run.scenario) { scenarioSel.value = run.scenario; $('wiScenarioNote').textContent = cfg.scenarios[run.scenario].description; }
			if ($('wiSeed')) $('wiSeed').value = run.seed;
			if ($('wiMode')) $('wiMode').value = run.mode;
			for (var k = 0; k < checks.length; k++) checks[k].checked = false;
		}

		/* ---------- events ---------- */

		function describe(ev) {
			var d = ev.data || {};
			switch (ev.type) {
			case 'behavior':
				if (d.to === 'feed') return 'Started feeding (' + d.reason + ')';
				if (d.from === 'feed') return 'Stopped feeding: ' + (d.reason || BEHAVIOR_WORDS[d.to]);
				if (d.to === 'startle') return 'Startle and escape: ' + d.reason;
				if (d.to === 'fly') return 'Took off';
				if (d.to === 'snagged') return 'Caught in silk';
				return 'Now ' + (BEHAVIOR_WORDS[d.to] || d.to) + (d.reason ? ' (' + d.reason + ')' : '');
			case 'silk-contact': return 'Touched silk of ' + webName(d.webId) + ' (' + d.side + ' side)';
			case 'silk-release': return 'Pulled free of ' + webName(d.webId) + ' after ' + fmt(d.held, 1) + ' s';
			case 'fruit-fell': return 'A ' + d.species + ' fell from its tree';
			case 'fruit-fermenting': return 'A fruit started fermenting (smells stronger)';
			case 'fruit-depleted': return 'A fruit was eaten up';
			case 'fruit-placed': return 'Fruit placed';
			case 'fruit-moved': return 'Fruit moved';
			case 'fruit-removed': return 'Fruit removed';
			case 'fruit-cleared': return 'Ground fruit cleared';
			case 'feeding': return 'Eating a ' + d.species;
			case 'web-placed': return 'Web hung';
			case 'web-removed': return 'Web taken down';
			case 'takeoff': return 'Wings out: takeoff';
			case 'landed': return 'Landed';
			case 'light': return 'Light set to ' + pct(d.level);
			case 'temperature': return 'Temperature set to ' + fmt(d.level);
			case 'wind': return 'Gust of air (strength ' + fmt(d.strength) + ')';
			case 'breeze': return 'The breeze changed direction';
			case 'touch': return 'Touched on the ' + d.location + ' (' + d.side + ')';
			case 'silence': return (d.on ? 'Silenced ' : 'Restored ') + d.channel.replace(/([A-Z])/g, ' $1').toLowerCase();
			case 'mode': return 'Steering mode: ' + d.mode;
			case 'drive-set': return d.name + ' set to ' + fmt(d.value);
			case 'run-start': return 'Run started (seed ' + d.seed + ')';
			case 'note': return d.text;
			default: return ev.type;
			}
		}

		function webName(id) {
			var w = app.sim ? WS.findById(app.sim.state.webs, id) : null;
			return w ? w.label : id;
		}

		function onEvents(events) {
			for (var i = 0; i < events.length; i++) {
				var ev = events[i];
				if (ev.type === 'bump') continue;
				eventLog.push({ t: ev.t, source: ev.source, text: describe(ev), type: ev.type });
			}
			if (eventLog.length > MAX_EVENTS) eventLog.splice(0, eventLog.length - MAX_EVENTS);
			eventsDirty = true;
		}
		var eventsDirty = false;

		function renderEvents() {
			if (!eventsEl || !eventsDirty) return;
			eventsDirty = false;
			var html = '';
			for (var i = eventLog.length - 1; i >= 0; i--) {
				var e = eventLog[i];
				html += '<div class="wi-event"><span class="wi-ev-t">' + fmt(e.t, 1) + 's</span><span class="wi-ev-src wi-src-' + e.source + '">' +
					e.source + '</span><span class="wi-ev-text">' + escapeHtml(e.text) + '</span></div>';
			}
			eventsEl.innerHTML = html || '<div class="wi-note">No events yet.</div>';
		}

		function escapeHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

		/* ---------- trace ---------- */

		var LANES = [
			{ title: 'Smell (antenna L / R)', series: [
				{ key: 'odorL', color: '#ffb432', log: true }, { key: 'odorR', color: '#ffb432', dash: true, log: true }] },
			{ title: 'Sight of webs (eye L / R)', series: [
				{ key: 'threatL', color: '#ff5a4d' }, { key: 'threatR', color: '#ff5a4d', dash: true }] },
			{ title: 'Neural readouts', series: [
				{ key: 'odorResponse', color: '#ffd166', label: 'lateral horn odor' },
				{ key: 'mThreatL', color: '#ff7b6b', label: 'loom DN L' }, { key: 'mThreatR', color: '#ff7b6b', dash: true, label: 'loom DN R' },
				{ key: 'proboscis', color: '#7ee787', label: 'proboscis MN' }] },
			{ title: 'Motor output', series: [
				{ key: 'walkDrive', color: '#8cc8ff', label: 'walk' },
				{ key: 'turn', color: '#c9a7ff', center: true, scale: 4, label: 'turn (+ left)' },
				{ key: 'escape', color: '#ff3b30', label: 'escape' }] }
		];

		function drawTrace() {
			if (!tctx || !app.sim) return;
			var W = trace.width, H = trace.height;
			tctx.clearRect(0, 0, W, H);
			var recs = app.sim.trace;
			if (!recs.length) return;
			var tEnd = recs[recs.length - 1].t, window = 30, tStart = tEnd - window;
			var laneH = (H - 34) / LANES.length;
			tctx.font = '10px system-ui, sans-serif';
			for (var l = 0; l < LANES.length; l++) {
				var lane = LANES[l], y0 = l * laneH + 2;
				tctx.fillStyle = 'rgba(255,255,255,0.04)';
				tctx.fillRect(0, y0, W, laneH - 4);
				tctx.fillStyle = '#8892a4';
				tctx.fillText(lane.title, 4, y0 + 11);
				for (var s = 0; s < lane.series.length; s++) {
					var se = lane.series[s];
					tctx.strokeStyle = se.color;
					tctx.lineWidth = 1.3;
					tctx.setLineDash(se.dash ? [4, 3] : []);
					tctx.beginPath();
					var started = false;
					for (var i = 0; i < recs.length; i++) {
						var r = recs[i];
						if (r.t < tStart) continue;
						var v = r[se.key] || 0;
						var yv;
						if (se.center) yv = 0.5 + clamp(v / (se.scale || 1), -1, 1) * 0.45;
						else if (se.log) yv = clamp(Math.log(1 + v * 2) / Math.log(13), 0, 1);
						else yv = clamp(v, 0, 1.2) / 1.2;
						var x = (r.t - tStart) / window * W;
						var y = y0 + laneH - 6 - yv * (laneH - 20);
						if (!started) { tctx.moveTo(x, y); started = true; } else tctx.lineTo(x, y);
					}
					tctx.stroke();
				}
				tctx.setLineDash([]);
			}
			// behavior band with contact ticks
			var by = LANES.length * laneH + 4;
			for (var j = 0; j < recs.length; j++) {
				var rr = recs[j];
				if (rr.t < tStart) continue;
				var x0 = (rr.t - tStart) / window * W;
				tctx.fillStyle = BEHAVIOR_COLORS[rr.behavior] || '#666';
				tctx.fillRect(x0, by, Math.ceil(W / (window * 10)) + 1, 10);
				if (rr.sugar > 0) { tctx.fillStyle = '#ffcc40'; tctx.fillRect(x0, by + 12, 2, 6); }
				if (rr.touch > 0.2) { tctx.fillStyle = '#ff3399'; tctx.fillRect(x0, by + 19, 2, 6); }
			}
			tctx.fillStyle = '#8892a4';
			tctx.fillText('behavior', W - 48, by + 9);
			tctx.fillText('-30 s', 2, H - 2);
			tctx.fillText('now', W - 22, H - 2);
		}

		(function legend() {
			var el = $('wiLegend');
			if (!el) return;
			var html = '';
			Object.keys(BEHAVIOR_COLORS).forEach(function (k) {
				html += '<span class="wi-leg"><i style="background:' + BEHAVIOR_COLORS[k] + '"></i>' + k + '</span>';
			});
			html += '<span class="wi-leg"><i style="background:#ffcc40"></i>taste contact</span><span class="wi-leg"><i style="background:#ff3399"></i>touch/silk</span>';
			el.innerHTML = html;
		})();

		function drawContributions() {
			var el = $('wiContrib');
			if (!el || !app.sim || !app.sim.motorOut) return;
			var c = app.sim.motorOut.contributions;
			var CH = root.WorldBrainAdapter.MOTOR_CHANNELS;
			var parts = Object.keys(c).map(function (k) {
				var src = CH[k] ? CH[k].source : 'modeled';
				return '<span class="wi-contrib wi-' + src + '" title="' + escapeHtml(CH[k] ? CH[k].label : k) + '">' + k + ' ' + (c[k] >= 0 ? '+' : '') + fmt(c[k], 2) + '</span>';
			});
			el.innerHTML = 'Turn command (rad/s) = ' + parts.join(' ') +
				'<br><span class="wi-contrib wi-connectome">connectome</span> terms come from worker readouts; <span class="wi-contrib wi-modeled">modeled</span> terms are the documented adapter.';
		}

		/* ---------- selection / inspect ---------- */

		function select(sel) {
			selection = sel;
			if (sel) { show(true); showTab('inspect'); }
			renderSelection();
		}

		function renderSelection() {
			var el = $('wiSelection');
			if (!el || !app.sim) return;
			var st = app.sim.state, sim = app.sim;
			if (!selection) { el.innerHTML = 'Choose <b>Observe</b>, then click a fruit, a web or the fly.'; return; }
			var html = '';
			if (selection.type === 'fruit') {
				var f = WS.findById(st.fruits, selection.id);
				if (!f) { el.textContent = 'That fruit is gone.'; return; }
				var edible = WS.isEdible(f);
				html = '<h4>' + cap(f.species) + ' fruit</h4>' + row('Stage', f.stage === 'attached' ? 'on the branch (not reachable)' : f.stage) +
					row('Ripeness', pct(f.ripeness)) + row('Food left', pct(f.amount)) + row('Smell strength', fmt(WS.fruitOdor(cfg, f))) +
					row('Sugar', fmt(WS.fruitSugar(cfg, f))) + row('Counts as available food', edible ? 'yes' : 'no') +
					row('Placed by', f.source) + row('Distance to fly', fmt(Math.hypot(f.x - st.fly.x, f.z - st.fly.z), 1) + ' BL');
			} else if (selection.type === 'web') {
				var w = WS.findById(st.webs, selection.id);
				if (!w) { el.textContent = 'That web is gone.'; return; }
				var sensed = null;
				if (sim.lastSenses) sim.lastSenses.threat.webs.forEach(function (x) { if (x.id === w.id) sensed = x; });
				html = '<h4>' + escapeHtml(w.label) + '</h4>' + row('Distance to fly', sensed ? fmt(sensed.distance, 1) + ' BL' : '-') +
					row('Seen by', sensed ? (sensed.left > 0 && sensed.right > 0 ? 'both eyes' : sensed.left > 0 ? 'left eye' : sensed.right > 0 ? 'right eye' : 'neither eye') : '-') +
					row('Apparent size', sensed ? fmt(sensed.angularSize * 180 / Math.PI, 0) + '°' : '-') +
					row('Looming (expansion)', sensed ? fmt(sensed.expansion * 180 / Math.PI, 0) + '°/s' : '-') +
					row('Line of sight', sensed ? pct(sensed.visibility) : '-') + row('Silk contrast', sensed ? fmt(sensed.contrast) : '-') +
					row('Visual threat input', sensed ? fmt(sensed.intensity) : '-') + row('Contacts so far', w.contacts) + row('Placed by', w.source) +
					'<p class="wi-note">Treating visible silk as aversive is a modeling assumption; flies have looming detectors, not a known web detector.</p>';
			} else if (selection.type === 'fly') {
				var s = sim.lastSenses, m = sim.motorOut, r = sim.readout.rates;
				html = '<h4>The fly</h4>' + row('Doing', BEHAVIOR_WORDS[st.behavior.current] || st.behavior.current) +
					row('Hunger / fear*', fmt(st.drives.hunger) + ' / ' + fmt(st.drives.fear)) +
					row('Smell L / R', s ? fmt(s.odor.left) + ' / ' + fmt(s.odor.right) : '-') +
					row('Web cue L / R', s ? fmt(s.threat.left) + ' / ' + fmt(s.threat.right) : '-') +
					row('Taste', s && s.taste.sugar > 0 ? 'sugar ' + fmt(s.taste.sugar) : 'nothing') +
					row('Lateral horn L / R', fmt((r.LH_NEURON_L || 0) * 100, 1) + '% / ' + fmt((r.LH_NEURON_R || 0) * 100, 1) + '%') +
					row('Loom DN L / R', fmt((r.DN_LOOM_RANKED_L || 0) * 100, 1) + '% / ' + fmt((r.DN_LOOM_RANKED_R || 0) * 100, 1) + '%') +
					row('Proboscis MN', fmt((r.MN_PROBOSCIS || 0) * 100, 1) + '%') +
					row('Walk / turn / escape', m ? fmt(m.walkDrive) + ' / ' + fmt(m.turn) + ' / ' + fmt(m.escape) : '-') +
					row('Eaten so far', fmt(st.intake.total) + ' portions') +
					'<p class="wi-note">Rates are the fraction of each population firing per tick. *Fear is a modeled defensive state driven by neural threat and touch readouts.</p>';
			}
			el.innerHTML = html;
		}

		function row(k, v) { return '<div class="wi-kv"><span>' + k + '</span><b>' + escapeHtml(v) + '</b></div>'; }
		function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

		/* ---------- explanation line ---------- */

		function explain() {
			var sim = app.sim;
			if (!sim || !sim.motorOut || !sim.lastSenses) return '';
			var st = sim.state, m = sim.motorOut, s = sim.lastSenses, b = st.behavior.current;
			var modeled = function (k) { var ch = root.WorldBrainAdapter.MOTOR_CHANNELS[k]; return ch && ch.source === 'modeled' ? ' (modeled)' : ''; };
			switch (b) {
			case 'feed': return 'Eating: sugar on the proboscis keeps proboscis motor neurons firing (output ' + fmt(m.proboscis) + '). Hunger ' + fmt(st.drives.hunger) + '.';
			case 'startle': return 'Escaping: the looming readout rose on the ' + (m.escapeSign > 0 ? 'right' : 'left') + ' side, so the escape output won (' + fmt(m.escape) + ').';
			case 'fly': return 'Flying away after a strong escape output.';
			case 'snagged': return 'Caught in silk: touch neurons fire; the fly struggles until it pulls free.';
			case 'rest': return 'Resting: fatigue ' + fmt(st.drives.fatigue) + ' is high and nothing alarming is in view.';
			case 'groom': return 'Grooming: the grooming urge peaked' + modeled('groom') + '.';
			case 'brace': return 'Bracing: Johnston\'s organ reports a gust.';
			case 'idle': return 'Standing: descending-neuron activity is too low to drive walking.';
			}
			switch (m.dominantTurn) {
			case 'odorTurn': return 'Smell is stronger on the ' + (s.odor.left > s.odor.right ? 'left' : 'right') + ' antenna and the lateral-horn odor response is ' + fmt(m.odorResponse) + ', so it turns ' + (m.turn > 0 ? 'left' : 'right') + modeled('odorTurn') + '.';
			case 'upwindTurn': return 'Food odor detected (lateral horn ' + fmt(m.odorResponse) + '); turning into the breeze' + modeled('upwindTurn') + '.';
			case 'threatTurn': return 'A web looms on the ' + (m.threatL > m.threatR ? 'left' : 'right') + '; loom-ranked descending neurons fire more on that side, so it turns away.';
			case 'touchTurn': return 'Touch on the ' + (m.touchL > m.touchR ? 'left' : 'right') + '; turning away from the contact.';
			case 'wander': return m.odorResponse > 0.3 ? 'Following the smell (lateral horn ' + fmt(m.odorResponse) + '), with exploratory turns' + modeled('wander') + '.' :
				'Exploring: no strong smell or threat; turns come from the pattern generator' + modeled('wander') + '.';
			default: return m.odorResponse > 0.3 ? 'Walking with food odor present (lateral horn ' + fmt(m.odorResponse) + ').' : 'Walking.';
			}
		}

		/* ---------- run info ---------- */

		function renderRunInfo() {
			var el = $('wiRunInfo');
			if (!el || !app.sim) return;
			var sim = app.sim, st = sim.clock.stats;
			var res = sim.lastResult;
			el.innerHTML = 'Run: <b>' + escapeHtml(cfg.scenarios[sim.log.scenario || 'free'].label) + '</b>, seed ' + sim.state.seed + ', ' + escapeHtml(sim.backend.label) +
				'<br>Sim time ' + fmt(sim.state.time, 1) + ' s · sim/wall ' + fmt(st.ratio, 2) + (sim.clock.stalled ? ' · <b>waiting for brain</b>' : '') +
				(res && res.computeMs !== undefined ? ' · brain step ' + fmt(res.computeMs, 1) + ' ms' : '') +
				(app.stepLatency ? ' · round trip ' + fmt(app.stepLatency, 1) + ' ms' : '') +
				perfLine() +
				(app.replayStatus ? '<br>' + app.replayStatus : '');
		}

		function perfLine() {
			if (!app.perfStats) return '';
			var p = app.perfStats();
			if (!p.frames) return '';
			return '<br>Frames p50 ' + fmt(p.frameMsP50, 1) + ' ms, p95 ' + fmt(p.frameMsP95, 1) + ' ms' +
				(p.drawCalls !== undefined ? ' · ' + p.drawCalls + ' draw calls' : '') + (p.jsHeapMB ? ' · heap ' + fmt(p.jsHeapMB, 0) + ' MB' : '');
		}

		function renderValidation(info) {
			var el = $('wiValidation');
			if (!el) return;
			if (!info) { el.innerHTML = ''; return; }
			var html = '<b>Brain assets</b>';
			(info.checks || []).forEach(function (c) {
				html += '<div class="wi-check ' + (c.skipped ? 'skip' : c.ok ? 'ok' : 'bad') + '">' + (c.skipped ? '–' : c.ok ? '✓' : '✗') + ' ' + escapeHtml(c.name) + (c.detail ? ' <span>' + escapeHtml(c.detail) + '</span>' : '') + '</div>';
			});
			if (info.note) html += '<div class="wi-note">' + escapeHtml(info.note) + '</div>';
			el.innerHTML = html;
		}

		/* ---------- update loop (called ~5 Hz by the coordinator) ---------- */

		var lastExplain = '';
		function update() {
			var line = explain();
			if (line !== lastExplain) {
				lastExplain = line;
				var el = $('explainLine');
				if (el) el.textContent = line;
			}
			if (!panel || panel.style.display === 'none') return;
			if (activeTab === 'trace') { drawTrace(); drawContributions(); }
			else if (activeTab === 'events') renderEvents();
			else if (activeTab === 'inspect') renderSelection();
			else if (activeTab === 'experiment') renderRunInfo();
		}

		function reset() {
			eventLog = [];
			eventsDirty = true;
			selection = null;
			renderEvents();
		}

		return {
			update: update,
			onEvents: onEvents,
			select: select,
			selection: function () { return selection; },
			toggle: toggle,
			show: show,
			reset: reset,
			syncControls: syncControls,
			renderValidation: renderValidation,
			note: function (text, source) { onEvents([{ t: app.sim ? app.sim.state.time : 0, type: 'note', source: source || 'world', data: { text: text } }]); }
		};
	}

	root.WorldInspector = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
