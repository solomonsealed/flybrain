#!/usr/bin/env node
// Browser scenarios for the garden (rendering and input).
//
// Serves the repository, launches headless Chrome (CHROME_PATH or the
// default install), and drives the real page over the DevTools protocol.
//
// Usage: node tests/browser/run-browser-tests.js [--perf docs] [--only name]
//   --perf <dir>  also record a performance sample to <dir>/browser-performance.json
'use strict';

var path = require('path');
var fs = require('fs');
var cdp = require('./cdp');

var ROOT = path.join(__dirname, '..', '..');
var args = process.argv.slice(2);
var perfDir = args.indexOf('--perf') !== -1 ? args[args.indexOf('--perf') + 1] : null;
var only = args.indexOf('--only') !== -1 ? args[args.indexOf('--only') + 1] : null;
var HTTP_PORT = 8791;
var BASE = 'http://127.0.0.1:' + HTTP_PORT + '/index.html';

var results = [];

function assert(cond, msg) { if (!cond) throw new Error(msg); }

function ready(page, url) {
	return page.goto(url || BASE).then(function () {
		return page.waitFor('window.FlyWorldApp && FlyWorldApp.sim && FlyWorldApp.sim.settled && FlyWorldApp.sim.state.time > 0.5', 60000);
	});
}

var scenarios = [
	['loads with the connectome and valid assets', function (page) {
		return ready(page).then(function () {
			return page.eval('({ brain: FlyWorldApp.brain.kind, renderer: FlyWorldApp.renderer.kind, checks: FlyWorldApp.brain.validation.checks, directional: FlyWorldApp.brain.directional })');
		}).then(function (r) {
			assert(r.brain === 'connectome', 'brain is ' + r.brain);
			assert(r.renderer === 'webgl', 'renderer is ' + r.renderer);
			assert(r.directional, 'hemisphere sidecar loaded');
			r.checks.forEach(function (c) { assert(c.ok, 'asset check failed: ' + c.name); });
		});
	}],
	['keeps simulated time close to wall time', function (page) {
		var t0;
		return ready(page).then(function () { return page.eval('FlyWorldApp.sim.state.time'); })
			.then(function (t) { t0 = t; return cdp.sleep(4000); })
			.then(function () { return page.eval('({ t: FlyWorldApp.sim.state.time, stalls: FlyWorldApp.sim.clock.stats.stallEvents })'); })
			.then(function (r) { assert(r.t - t0 > 3.2 && r.t - t0 < 4.8, 'advanced ' + (r.t - t0).toFixed(2) + ' s in 4 s'); });
	}],
	['camera pan, zoom, orbit and resize never move the world', function (page) {
		var fp;
		return ready(page).then(function () { return page.eval('FlyWorldApp.setPaused(true), FlyWorldApp.sim.fingerprint()'); })
			.then(function (f) { fp = f; return page.drag(700, 400, 500, 300); })
			.then(function () { return page.eval('FlyWorldApp.renderer.zoomBy(2.5); FlyWorldApp.renderer.setFollow(true); true'); })
			.then(function () { return page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 400, deltaX: 0, deltaY: -300 }); })
			.then(function () { return page.setViewport({ width: 900, height: 700 }); })
			.then(function () { return cdp.sleep(500); })
			.then(function () { return page.eval('FlyWorldApp.renderer.resetCamera(); FlyWorldApp.sim.fingerprint()'); })
			.then(function (f2) { assert(f2 === fp, 'fingerprint changed while only the camera moved'); return page.setViewport({ width: 1400, height: 900 }); })
			.then(function () { return page.eval('FlyWorldApp.setPaused(false)'); });
	}],
	['a fruit-tool click places fruit where the ground was clicked', function (page) {
		var target = { x: 53, z: 70 };
		return ready(page).then(function () { return page.eval('FlyWorldApp.setTool("fruit"); FlyWorldApp.renderer.resetCamera(); FlyWorldApp.setPaused(true); true'); })
			.then(function () { return cdp.sleep(300); })
			.then(function () { return page.eval('FlyWorldApp.renderer.worldToScreen(' + target.x + ', 0, ' + target.z + ')'); })
			.then(function (p) { return page.click(p.x, p.y); })
			.then(function () { return cdp.sleep(200); })
			.then(function () { return page.eval('FlyWorldApp.getState().fruits.filter(function (f) { return f.source === "user"; })'); })
			.then(function (fr) {
				assert(fr.length === 1, 'expected one user fruit, got ' + fr.length);
				assert(Math.hypot(fr[0].x - target.x, fr[0].z - target.z) < 1, 'fruit placed at ' + fr[0].x.toFixed(1) + ',' + fr[0].z.toFixed(1));
				return page.eval('FlyWorldApp.setPaused(false)');
			});
	}],
	['an air-tool drag blows a gust along the drag direction', function (page) {
		return ready(page).then(function () { return page.eval('FlyWorldApp.setTool("air"); FlyWorldApp.renderer.resetCamera(); true'); })
			.then(function () { return cdp.sleep(300); })
			.then(function () { return page.eval('[FlyWorldApp.renderer.worldToScreen(40, 0, 45), FlyWorldApp.renderer.worldToScreen(60, 0, 45)]'); })
			.then(function (p) { return page.drag(p[0].x, p[0].y, p[1].x, p[1].y); })
			.then(function () { return cdp.sleep(200); })
			.then(function () { return page.eval('FlyWorldApp.getState().events.filter(function (e) { return e.type === "wind"; }).pop()'); })
			.then(function (ev) {
				assert(ev && ev.source === 'user', 'wind event from the user');
				assert(ev.data.dirX > 0.9, 'gust travels east (dirX ' + ev.data.dirX + ')');
			});
	}],
	['observe selects the fly and shows what it senses', function (page) {
		return ready(page).then(function () { return page.eval('FlyWorldApp.setTool("observe"); FlyWorldApp.renderer.setFollow(true); FlyWorldApp.setPaused(true); true'); })
			.then(function () { return cdp.sleep(1200); })
			.then(function () { return page.eval('(function(){ var f = FlyWorldApp.getState().fly; return FlyWorldApp.renderer.worldToScreen(f.x, 0.3, f.z); })()'); })
			.then(function (p) { return page.click(p.x, p.y); })
			.then(function () { return cdp.sleep(400); })
			.then(function () { return page.eval('document.getElementById("wiSelection").textContent'); })
			.then(function (txt) { assert(/The fly/.test(txt) && /Lateral horn/.test(txt), 'fly inspection shown'); return page.eval('FlyWorldApp.setPaused(false)'); });
	}],
	['hidden tab pauses world and brain; showing it resumes without a reset', function (page) {
		var before;
		return ready(page).then(function () {
			return page.eval('Object.defineProperty(document, "hidden", { configurable: true, get: function () { return true; } }); document.dispatchEvent(new Event("visibilitychange")); ({ step: FlyWorldApp.sim.state.bodyStep, paused: FlyWorldApp.sim.clock.paused })');
		}).then(function (r) {
			assert(r.paused, 'clock paused when hidden');
			before = r.step;
			return cdp.sleep(1000);
		}).then(function () { return page.eval('FlyWorldApp.sim.state.bodyStep'); })
			.then(function (s) {
				assert(s === before, 'no steps while hidden');
				return page.eval('Object.defineProperty(document, "hidden", { configurable: true, get: function () { return false; } }); document.dispatchEvent(new Event("visibilitychange")); true');
			})
			.then(function () { return cdp.sleep(1000); })
			.then(function () { return page.eval('({ step: FlyWorldApp.sim.state.bodyStep, t: FlyWorldApp.sim.state.time })'); })
			.then(function (r) { assert(r.step > before, 'resumed from step ' + before); assert(r.t > 0.5, 'did not restart from zero'); });
	}],
	['Brain 3D, the 139K neuron view and the garden coexist', function (page) {
		return ready(page).then(function () { return page.eval('document.getElementById("brain3dBtn").click(); true'); })
			.then(function () { return cdp.sleep(1500); })
			.then(function () { return page.eval('({ b3d: Brain3D.active, neuro: typeof NeuroRenderer !== "undefined" && NeuroRenderer.isActive(), t: FlyWorldApp.sim.state.time })'); })
			.then(function (r) { assert(r.b3d, 'Brain 3D opened'); assert(r.neuro, '139K view active'); return page.eval('document.getElementById("brain3dBtn").click(); FlyWorldApp.sim.state.time'); })
			.then(function (t) { return cdp.sleep(1000).then(function () { return page.eval('FlyWorldApp.sim.state.time > ' + t + ' && !Brain3D.active'); }); })
			.then(function (ok) { assert(ok, 'garden keeps running after Brain 3D closes'); });
	}],
	['losing the WebGL context switches to the 2D garden without stopping the run', function (page) {
		var t;
		return ready(page).then(function () {
			return page.eval('var gl = document.getElementById("world-canvas").getContext("webgl"); window.__lose = gl.getExtension("WEBGL_lose_context"); __lose.loseContext(); FlyWorldApp.sim.state.time');
		}).then(function (t0) { t = t0; return page.waitFor('FlyWorldApp.renderer.kind === "canvas2d"', 5000); })
			.then(function () { return cdp.sleep(800); })
			.then(function () { return page.eval('FlyWorldApp.sim.state.time'); })
			.then(function (t1) { assert(t1 > t, 'simulation continued during the renderer swap'); });
	}],
	['the 2D renderer works on its own (?renderer=2d)', function (page) {
		return ready(page, BASE + '?renderer=2d&seed=4').then(function () { return page.eval('({ r: FlyWorldApp.renderer.kind, seed: FlyWorldApp.sim.state.seed })'); })
			.then(function (r) { assert(r.r === 'canvas2d', 'renderer ' + r.r); assert(r.seed === 4, 'seed from URL'); });
	}],
	['the fallback brain is labeled and still drives the fly (?brain=legacy)', function (page) {
		return ready(page, BASE + '?brain=legacy').then(function () { return cdp.sleep(2000); })
			.then(function () { return page.eval('({ kind: FlyWorldApp.brain.kind, badge: document.getElementById("brainModeBadge").textContent, t: FlyWorldApp.sim.state.time })'); })
			.then(function (r) { assert(r.kind === 'legacy', 'legacy brain'); assert(/Fallback/.test(r.badge), 'badge says fallback'); assert(r.t > 1, 'running'); });
	}],
	['replaying a run from its log matches the original exactly', function (page) {
		return ready(page).then(function () { return cdp.sleep(3000); })
			.then(function () { return page.eval('FlyWorldApp.command({ type: "placeFruit", params: { x: 62, z: 40 } }); true'); })
			.then(function () { return cdp.sleep(2000); })
			.then(function () { return page.eval('FlyWorldApp.replay(); true'); })
			.then(function () { return page.waitFor('/Replay (matched|diverged)/.test(FlyWorldApp.replayStatus)', 60000); })
			.then(function () { return page.eval('FlyWorldApp.replayStatus'); })
			.then(function (s) { assert(/matched/.test(s), s); });
	}],
	['loads from file:// like the iOS bundle (XHR, gzip, worker)', function (page) {
		return ready(page, 'file://' + ROOT + '/index.html').then(function () {
			return page.eval('({ brain: FlyWorldApp.brain.kind, directional: FlyWorldApp.brain.directional, checks: FlyWorldApp.brain.validation.checks })');
		}).then(function (r) {
			assert(r.brain === 'connectome', 'connectome loads from file:// (got ' + r.brain + ')');
			assert(r.directional, 'sidecar loads from file://');
			r.checks.forEach(function (c) { assert(c.ok, 'asset check failed: ' + c.name); });
		});
	}],
	['phone-sized touch screen: tap places fruit', function (page) {
		return page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, mobile: true, touch: true })
			.then(function () { return ready(page); })
			.then(function () { return page.eval('FlyWorldApp.setTool("fruit"); FlyWorldApp.renderer.resetCamera(); FlyWorldApp.setPaused(true); true'); })
			.then(function () { return cdp.sleep(300); })
			.then(function () { return page.eval('FlyWorldApp.renderer.worldToScreen(60, 0, 55)'); })
			.then(function (p) { return page.tap(p.x, p.y); })
			.then(function () { return cdp.sleep(300); })
			.then(function () { return page.eval('FlyWorldApp.getState().fruits.filter(function (f) { return f.source === "user"; }).length'); })
			.then(function (n) { assert(n === 1, 'tap placed ' + n + ' fruit'); return page.setViewport({ width: 1400, height: 900 }); });
	}]
];

function runAll() {
	var server, browser;
	return cdp.serve(ROOT, HTTP_PORT).then(function (s) { server = s; return cdp.launch(); })
		.then(function (b) {
			browser = b;
			console.log('Chrome: ' + b.version);
			var chain = Promise.resolve();
			scenarios.forEach(function (sc) {
				if (only && sc[0].indexOf(only) === -1) return;
				chain = chain.then(function () {
					var t0 = Date.now();
					return browser.newPage().then(function (page) {
						return Promise.resolve().then(function () { return sc[1](page); }).then(function () {
							var errs = page.errors.filter(function (e) { return !/WebSocket|ERR_CONNECTION_REFUSED|Failed to fetch/.test(e); });
							if (errs.length) throw new Error('page errors: ' + errs.join(' | '));
							results.push({ name: sc[0], ok: true, ms: Date.now() - t0 });
							console.log('PASS ' + sc[0]);
						}, function (err) {
							results.push({ name: sc[0], ok: false, error: err.message });
							console.log('FAIL ' + sc[0] + ': ' + err.message);
							if (page.errors.length) console.log('     page errors: ' + page.errors.slice(0, 3).join(' | '));
						}).then(function () { return page.close(); });
					});
				});
			});
			if (perfDir) chain = chain.then(function () { return perfSample(browser); });
			return chain;
		})
		.then(function () {
			var failed = results.filter(function (r) { return !r.ok; }).length;
			console.log((results.length - failed) + ' passed / ' + failed + ' failed / ' + results.length + ' total');
			if (failed) process.exitCode = 1;
		}, function (err) { console.error(err); process.exitCode = 1; })
		.then(function () { if (browser) browser.close(); if (server) server.close(); });
}

// Performance sample: 20 s of the free garden with the brain running.
function perfSample(browser) {
	var samples = [];
	function one(label, url, viewport, action) {
		return browser.newPage(viewport).then(function (page) {
			return ready(page, url).then(function () { return action ? page.eval(action) : null; })
				.then(function () { return cdp.sleep(20000); })
				.then(function () { return page.eval('FlyWorldApp.perfStats()'); })
				.then(function (p) { p.label = label; p.viewport = viewport || { width: 1400, height: 900 }; samples.push(p); console.log('perf ' + label + ': ' + JSON.stringify(p)); })
				.then(function () { return page.close(); });
		});
	}
	return one('desktop 1400x900, garden + 139K neuron view', BASE)
		.then(function () { return one('desktop 1400x900, 139K view off, follow camera', BASE, null,
			'document.getElementById("connectomeToggleBtn").click(); FlyWorldApp.renderer.setFollow(true); NeuroRenderer.isActive()'); })
		.then(function () { return one('desktop 1400x900, Brain 3D open (garden render suspended) + 139K view: three WebGL contexts', BASE, null,
			'document.getElementById("brain3dBtn").click(); Brain3D.active'); })
		.then(function () { return one('phone viewport 390x844 @3x (emulated on desktop)', BASE, { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, touch: true }); })
		.then(function () {
			var os = require('os');
			var out = { generated: new Date().toISOString(), chrome: browser.version, host: { platform: process.platform, arch: process.arch, cpus: os.cpus()[0].model, cores: os.cpus().length, memGB: Math.round(os.totalmem() / 1073741824) },
				note: 'Headless Chrome on the development machine. Mobile Safari and the bundled WKWebView were not measured here.', samples: samples };
			fs.mkdirSync(perfDir, { recursive: true });
			fs.writeFileSync(path.join(perfDir, 'browser-performance.json'), JSON.stringify(out, null, 1) + '\n');
		});
}

runAll();
