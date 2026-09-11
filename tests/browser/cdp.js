// Minimal Chrome DevTools Protocol client for browser scenario tests.
// Uses Node's built-in WebSocket client (Node 22+) or, on older Node, the
// `ws` package the caretaker server already depends on -- no
// browser-automation dependency is needed.
'use strict';

var childProcess = require('child_process');
var http = require('http');
var fs = require('fs');
var os = require('os');
var path = require('path');

// Returns {send, close, onMessage(fn)} over either WebSocket implementation.
function openSocket(url) {
	return new Promise(function (resolve, reject) {
		var handlers = [];
		if (typeof globalThis.WebSocket === 'function') {
			var s = new globalThis.WebSocket(url);
			s.onopen = function () { resolve({ send: function (d) { s.send(d); }, close: function () { s.close(); }, onMessage: function (f) { handlers.push(f); } }); };
			s.onmessage = function (e) { handlers.forEach(function (f) { f(typeof e.data === 'string' ? e.data : String(e.data)); }); };
			s.onerror = function (e) { reject(new Error('websocket error')); };
		} else {
			var WS = require('ws');
			var w = new WS(url, { perMessageDeflate: false });
			w.on('open', function () { resolve({ send: function (d) { w.send(d); }, close: function () { w.close(); }, onMessage: function (f) { handlers.push(f); } }); });
			w.on('message', function (d) { handlers.forEach(function (f) { f(String(d)); }); });
			w.on('error', reject);
		}
	});
}

var DEFAULT_CHROME = {
	darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	linux: 'google-chrome',
	win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
};

function chromePath() {
	return process.env.CHROME_PATH || DEFAULT_CHROME[process.platform] || 'google-chrome';
}

function getJson(url) {
	return new Promise(function (resolve, reject) {
		http.get(url, function (res) {
			var body = '';
			res.on('data', function (c) { body += c; });
			res.on('end', function () { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
		}).on('error', reject);
	});
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Launches headless Chrome and returns a connected browser client.
function launch(opts) {
	opts = opts || {};
	var port = opts.port || 9333;
	var userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flybrain-chrome-'));
	var proc = childProcess.spawn(chromePath(), [
		'--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + userDir,
		'--no-first-run', '--no-default-browser-check', '--ignore-gpu-blocklist', '--enable-webgl',
		'--allow-file-access-from-files',   // file:// scenario approximates the iOS WKWebView bundle
		'--use-angle=' + (opts.angle || (process.platform === 'darwin' ? 'metal' : 'default')), 'about:blank'
	], { stdio: 'ignore' });
	var tries = 0;
	function connect() {
		return getJson('http://127.0.0.1:' + port + '/json/version').then(function (v) {
			return openSocket(v.webSocketDebuggerUrl).then(function (ws) { return new Browser(ws, proc, userDir, v); });
		}, function (err) {
			if (++tries > 50) throw err;
			return sleep(200).then(connect);
		});
	}
	return connect();
}

function Browser(ws, proc, userDir, version) {
	var self = this;
	this.ws = ws; this.proc = proc; this.userDir = userDir; this.version = version.Browser;
	this.nextId = 1; this.pending = {}; this.listeners = [];
	ws.onMessage(function (data) {
		var msg = JSON.parse(data);
		if (msg.id && self.pending[msg.id]) {
			var p = self.pending[msg.id];
			delete self.pending[msg.id];
			if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
		} else if (msg.method) {
			self.listeners.forEach(function (l) { l(msg); });
		}
	});
}

Browser.prototype.send = function (method, params, sessionId) {
	var self = this, id = this.nextId++;
	var msg = { id: id, method: method, params: params || {} };
	if (sessionId) msg.sessionId = sessionId;
	return new Promise(function (resolve, reject) {
		self.pending[id] = { resolve: resolve, reject: reject };
		self.ws.send(JSON.stringify(msg));
	});
};

Browser.prototype.newPage = function (viewport) {
	var self = this;
	return this.send('Target.createTarget', { url: 'about:blank' }).then(function (t) {
		return self.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }).then(function (a) {
			var page = new Page(self, a.sessionId, t.targetId);
			return page.init(viewport).then(function () { return page; });
		});
	});
};

Browser.prototype.close = function () {
	try { this.ws.close(); } catch (e) { /* ignore */ }
	try { this.proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
	try { fs.rmSync(this.userDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
};

function Page(browser, sessionId, targetId) {
	var self = this;
	this.browser = browser; this.sessionId = sessionId; this.targetId = targetId;
	this.errors = []; this.logs = []; this.loadWaiters = [];
	browser.listeners.push(function (msg) {
		if (msg.sessionId !== sessionId) return;
		if (msg.method === 'Runtime.exceptionThrown') {
			var d = msg.params.exceptionDetails;
			self.errors.push((d.exception && d.exception.description) || d.text);
		} else if (msg.method === 'Runtime.consoleAPICalled') {
			var text = msg.params.args.map(function (a) { return a.value !== undefined ? String(a.value) : (a.description || ''); }).join(' ');
			self.logs.push('[' + msg.params.type + '] ' + text);
		} else if (msg.method === 'Page.loadEventFired') {
			self.loadWaiters.splice(0).forEach(function (f) { f(); });
		}
	});
}

Page.prototype.send = function (m, p) { return this.browser.send(m, p, this.sessionId); };

Page.prototype.init = function (viewport) {
	var self = this;
	return this.send('Page.enable').then(function () { return self.send('Runtime.enable'); })
		.then(function () { return self.setViewport(viewport || { width: 1400, height: 900 }); });
};

Page.prototype.setViewport = function (v) {
	var self = this;
	return this.send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: v.deviceScaleFactor || 1, mobile: !!v.mobile })
		.then(function () { return self.send('Emulation.setTouchEmulationEnabled', { enabled: !!v.touch, maxTouchPoints: v.touch ? 5 : 1 }); });
};

Page.prototype.goto = function (url) {
	var self = this;
	var loaded = new Promise(function (r) { self.loadWaiters.push(r); });
	return this.send('Page.navigate', { url: url }).then(function () { return loaded; });
};

Page.prototype.eval = function (expr) {
	return this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then(function (r) {
		if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
		return r.result.value;
	});
};

Page.prototype.waitFor = function (expr, timeoutMs) {
	var self = this, t0 = Date.now();
	function poll() {
		return self.eval('!!(' + expr + ')').then(function (ok) {
			if (ok) return true;
			if (Date.now() - t0 > (timeoutMs || 30000)) throw new Error('timed out waiting for ' + expr);
			return sleep(100).then(poll);
		});
	}
	return poll();
};

Page.prototype.click = function (x, y) {
	var self = this;
	var base = { x: x, y: y, button: 'left', clickCount: 1, pointerType: 'mouse' };
	return this.send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved' }, base))
		.then(function () { return self.send('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed' }, base)); })
		.then(function () { return self.send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased' }, base)); });
};

Page.prototype.drag = function (x0, y0, x1, y1, steps) {
	var self = this;
	steps = steps || 8;
	var chain = this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 });
	for (var i = 1; i <= steps; i++) {
		(function (k) {
			chain = chain.then(function () {
				return self.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x1 - x0) * k / steps, y: y0 + (y1 - y0) * k / steps, button: 'left', buttons: 1 });
			});
		})(i);
	}
	return chain.then(function () { return self.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1 }); });
};

Page.prototype.tap = function (x, y) {
	var self = this;
	return this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x, y: y }] })
		.then(function () { return self.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); });
};

Page.prototype.screenshot = function (file) {
	return this.send('Page.captureScreenshot', { format: 'png' }).then(function (r) {
		if (file) fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
		return r.data;
	});
};

Page.prototype.close = function () { return this.browser.send('Target.closeTarget', { targetId: this.targetId }); };

// Tiny static file server for the repository.
function serve(root, port) {
	var types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
		'.svg': 'image/svg+xml', '.png': 'image/png', '.gz': 'application/octet-stream' };
	var server = http.createServer(function (req, res) {
		var rel = decodeURIComponent(req.url.split('?')[0]);
		if (rel === '/') rel = '/index.html';
		var file = path.join(root, path.normalize(rel));
		if (file.indexOf(root) !== 0) { res.writeHead(403); res.end(); return; }
		fs.readFile(file, function (err, buf) {
			if (err) { res.writeHead(404); res.end(); return; }
			res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
			res.end(buf);
		});
	});
	return new Promise(function (resolve) { server.listen(port, '127.0.0.1', function () { resolve(server); }); });
}

module.exports = { launch: launch, serve: serve, sleep: sleep, chromePath: chromePath };
