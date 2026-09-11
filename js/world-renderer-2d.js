/* world-renderer-2d.js -- Simplified Canvas 2D renderer of the same world
 * model, used when WebGL is unavailable or its context is lost.
 *
 * Top-down map with pan (drag) and zoom (wheel/pinch). Same API as
 * world-renderer.js so the coordinator can swap renderers at runtime; like
 * the WebGL renderer it only reads the world state.
 */
(function (root) {
	'use strict';

	var WS = root.WorldState;

	function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

	var BEHAVIOR_COLORS = {
		walk: '#8cc8ff', feed: '#ffcc40', startle: '#ff5a4d', fly: '#d88cff', groom: '#99ff99',
		rest: '#9999b3', idle: '#bfbfbf', brace: '#99e6e6', snagged: '#ff3399'
	};

	function create(canvas, cfg, state) {
		var ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Canvas 2D unavailable');
		var b = cfg.bounds;
		var view = { cx: (b.xMin + b.xMax) / 2, cz: (b.zMin + b.zMax) / 2, scale: 1, zoom: 1 };
		var follow = false, suspended = false, selection = null;
		var overlays = { scent: false, danger: true, trail: true, neural: false };
		var trail = [];
		var lastState = state, lastPose = null, lastInfo = null;
		var dpr = 1;
		var scentCanvas = document.createElement('canvas');
		scentCanvas.width = 120; scentCanvas.height = 90;
		var scentTimer = 0;

		function band() {
			var w = canvas.clientWidth || root.innerWidth, h = canvas.clientHeight || root.innerHeight;
			return { w: w, h: Math.max(100, h - insets.top - insets.bottom), cy: insets.top + Math.max(100, h - insets.top - insets.bottom) / 2 };
		}

		function fitScale() {
			var bd = band();
			view.scale = Math.min(bd.w / (b.xMax - b.xMin + 16), bd.h / (b.zMax - b.zMin + 16)) * view.zoom;
		}

		function toScreen(x, z) {
			var bd = band();
			return { x: bd.w / 2 + (x - view.cx) * view.scale, y: bd.cy + (z - view.cz) * view.scale };
		}

		function toWorld(sx, sy) {
			var r = canvas.getBoundingClientRect();
			var bd = band();
			return { x: view.cx + (sx - r.left - bd.w / 2) / view.scale, z: view.cz + (sy - r.top - bd.cy) / view.scale };
		}

		/* ---------- input: pan and zoom ---------- */

		var drag = null, panEnabled = true;
		function onDown(e) {
			if (!panEnabled || (e.button !== undefined && e.button !== 0)) return;
			drag = { x: e.clientX, y: e.clientY, cx: view.cx, cz: view.cz };
		}
		function onMove(e) {
			if (!drag) return;
			view.cx = drag.cx - (e.clientX - drag.x) / view.scale;
			view.cz = drag.cz - (e.clientY - drag.y) / view.scale;
			follow = false;
		}
		function onUp() { drag = null; }
		function onWheel(e) {
			e.preventDefault();
			api.zoomBy(e.deltaY < 0 ? 1.12 : 0.89);
		}
		canvas.addEventListener('pointerdown', onDown);
		root.addEventListener('pointermove', onMove);
		root.addEventListener('pointerup', onUp);
		canvas.addEventListener('wheel', onWheel, { passive: false });

		/* ---------- drawing ---------- */

		function drawScene(state, pose, info) {
			var w = canvas.clientWidth || root.innerWidth, h = canvas.clientHeight || root.innerHeight;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			var light = state.env.lightLevel;
			ctx.fillStyle = light >= 1 ? '#232320' : (light >= 0.5 ? '#1b1b18' : '#0d0d0c');
			ctx.fillRect(0, 0, w, h);
			var s = view.scale;
			var o = toScreen(b.xMin, b.zMin);

			// ground (rounded rectangle interior)
			ctx.save();
			roundRectPath(o.x, o.y, (b.xMax - b.xMin) * s, (b.zMax - b.zMin) * s, cfg.enclosure.cornerRadius * s);
			ctx.fillStyle = shadeColor('#6a5a41', light);
			ctx.fill();
			ctx.clip();
			cfg.shade.forEach(function (sh) {
				var p = toScreen(sh.x, sh.z);
				var g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, sh.radius * s * 1.1);
				g.addColorStop(0, 'rgba(20,16,10,' + (0.55 * (1 - sh.light)).toFixed(2) + ')');
				g.addColorStop(1, 'rgba(20,16,10,0)');
				ctx.fillStyle = g;
				ctx.fillRect(p.x - sh.radius * s * 1.2, p.y - sh.radius * s * 1.2, sh.radius * s * 2.4, sh.radius * s * 2.4);
			});
			if (overlays.scent) drawScent(state, o, s);
			ctx.restore();
			// wall
			roundRectPath(o.x, o.y, (b.xMax - b.xMin) * s, (b.zMax - b.zMin) * s, cfg.enclosure.cornerRadius * s);
			ctx.lineWidth = Math.max(3, cfg.enclosure.wallThickness * s);
			ctx.strokeStyle = shadeColor('#b59a78', light);
			ctx.stroke();

			// shelter leaves
			cfg.shelter.leaves.forEach(function (l) {
				var p = toScreen(l.x, l.z);
				ctx.save();
				ctx.translate(p.x, p.y);
				ctx.rotate(l.angle);
				ctx.fillStyle = 'rgba(94,109,44,0.55)';
				ctx.beginPath(); ctx.ellipse(0, 0, l.size * 0.45 * s, l.size * 0.8 * s, 0, 0, Math.PI * 2); ctx.fill();
				ctx.restore();
			});
			// stones
			cfg.stones.forEach(function (st) { circle(st.x, st.z, st.radius, shadeColor('#8d8579', light)); });
			// trellis
			ctx.lineWidth = Math.max(2, 0.5 * s);
			ctx.strokeStyle = shadeColor('#9a7b52', light);
			cfg.trellis.forEach(function (p) {
				var a = toScreen(p.x1, p.z1), c = toScreen(p.x2, p.z2);
				ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke();
			});
			cfg.foliage.forEach(function (f) { ellipse(f.x, f.z, f.rx, f.rz, 'rgba(61,107,46,0.65)'); });

			// fruit (ground first, canopy later)
			state.fruits.forEach(function (f) {
				if (f.stage === 'attached') return;
				var sp = cfg.species[f.species] || cfg.species.user;
				var r = f.radius * Math.max(0.35, Math.cbrt(Math.max(0.05, f.amount)));
				ctx.globalAlpha = f.stage === 'depleted' ? 0.35 : 1;
				circle(f.x, f.z, r, f.stage === 'fermenting' ? mix(sp.color, '#5a4020', 0.35) : sp.color);
				ctx.globalAlpha = 1;
			});

			// webs: a vertical disk seen from above is a line segment
			state.webs.forEach(function (web) {
				var fr = WS.webFrame(web);
				var a = toScreen(fr.cx + fr.ux * web.radius, fr.cz + fr.uz * web.radius);
				var c = toScreen(fr.cx - fr.ux * web.radius, fr.cz - fr.uz * web.radius);
				var hot = web.lastContact >= 0 && state.time - web.lastContact < 1.5;
				ctx.strokeStyle = hot ? '#ffd0d0' : 'rgba(246,242,230,0.9)';
				ctx.lineWidth = Math.max(1.5, 0.25 * s);
				ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke();
				ctx.lineWidth = 1;
				ctx.strokeStyle = 'rgba(246,242,230,0.35)';
				for (var k = -2; k <= 2; k++) {
					var m = toScreen(fr.cx + fr.ux * web.radius * k / 2.5, fr.cz + fr.uz * web.radius * k / 2.5);
					ctx.beginPath(); ctx.moveTo(m.x - fr.nx * 0.6 * s, m.y - fr.nz * 0.6 * s); ctx.lineTo(m.x + fr.nx * 0.6 * s, m.y + fr.nz * 0.6 * s); ctx.stroke();
				}
			});

			// trail
			if (overlays.trail && trail.length > 1) {
				for (var i = 1; i < trail.length; i++) {
					var p0 = toScreen(trail[i - 1].x, trail[i - 1].z), p1 = toScreen(trail[i].x, trail[i].z);
					ctx.strokeStyle = BEHAVIOR_COLORS[trail[i].b] || '#bbb';
					ctx.globalAlpha = 0.25 + 0.6 * (i / trail.length);
					ctx.lineWidth = 1.5;
					ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
				}
				ctx.globalAlpha = 1;
			}

			// danger wedges
			if (overlays.danger && info && info.senses) {
				info.senses.threat.webs.forEach(function (wt) {
					var web = WS.findById(state.webs, wt.id);
					if (!web || wt.intensity < 0.02) return;
					var fr = WS.webFrame(web);
					var e = toScreen(pose.x, pose.z);
					var a = toScreen(fr.cx + fr.ux * web.radius, fr.cz + fr.uz * web.radius);
					var c = toScreen(fr.cx - fr.ux * web.radius, fr.cz - fr.uz * web.radius);
					ctx.fillStyle = 'rgba(255,75,58,' + clamp(wt.intensity * 0.45, 0.05, 0.45).toFixed(2) + ')';
					ctx.beginPath(); ctx.moveTo(e.x, e.y); ctx.lineTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.closePath(); ctx.fill();
				});
			}

			drawFly(state, pose, info);

			// canopies over everything, translucent
			cfg.trees.forEach(function (t) {
				circle(t.x, t.z, t.trunkRadius, shadeColor('#5b3f28', light));
				ctx.globalAlpha = view.zoom > 2.5 ? 0.18 : 0.42;
				circle(t.x, t.z, t.canopyRadius, '#3f6b2a');
				ctx.globalAlpha = 1;
			});
			state.fruits.forEach(function (f) {
				if (f.stage !== 'attached') return;
				circle(f.x, f.z, f.radius * (0.35 + 0.65 * f.ripeness), mix((cfg.species[f.species] || cfg.species.user).color, '#7a9a3a', 0.5));
			});

			// selection
			if (selection) {
				var obj = selection.type === 'fruit' ? WS.findById(state.fruits, selection.id) : selection.type === 'web' ? WS.findById(state.webs, selection.id) : null;
				if (obj) {
					var sp2 = toScreen(obj.x, obj.z);
					ctx.strokeStyle = '#7dd3fc'; ctx.lineWidth = 2;
					ctx.beginPath(); ctx.arc(sp2.x, sp2.y, (obj.radius * 1.4) * s + 4, 0, Math.PI * 2); ctx.stroke();
				}
			}
		}

		function drawScent(state, o, s) {
			scentTimer -= 1 / 60;
			if (scentTimer <= 0) {
				scentTimer = 0.5;
				var sc = scentCanvas.getContext('2d');
				var img = sc.createImageData(120, 90);
				var wind = root.WorldSenses.windAt(state);
				for (var j = 0; j < 90; j++) {
					for (var i = 0; i < 120; i++) {
						var c = root.WorldSenses.odorAt(state, cfg, b.xMin + i + 0.5, 0.3, b.zMin + j + 0.5, wind);
						var a = clamp(Math.log(1 + c * 2) / Math.log(13), 0, 1);
						var k = (j * 120 + i) * 4;
						img.data[k] = 255; img.data[k + 1] = 150 + 80 * a; img.data[k + 2] = 40; img.data[k + 3] = a * 150;
					}
				}
				sc.putImageData(img, 0, 0);
			}
			ctx.imageSmoothingEnabled = true;
			ctx.drawImage(scentCanvas, o.x, o.y, (b.xMax - b.xMin) * s, (b.zMax - b.zMin) * s);
		}

		function drawFly(state, pose, info) {
			var p = toScreen(pose.x, pose.z);
			var s = view.scale;
			var bh = state.behavior.current;
			// marker ring for findability
			ctx.strokeStyle = 'rgba(255,243,196,0.6)';
			ctx.lineWidth = 1.5;
			ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(8, 1.1 * s), 0, Math.PI * 2); ctx.stroke();
			if (overlays.neural && info && info.motor) {
				ctx.strokeStyle = 'rgba(255,180,50,' + clamp(info.motor.odorResponse, 0, 1).toFixed(2) + ')';
				ctx.lineWidth = 3;
				ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(12, 1.6 * s), 0, Math.PI * 2); ctx.stroke();
			}
			ctx.save();
			ctx.translate(p.x, p.y);
			// screen y = world z; heading h has forward (cos h, -sin h)
			ctx.rotate(-pose.heading);
			var k = Math.max(s, 7);
			if (pose.y > 0.1) { ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.ellipse(0, 0, 0.5 * k, 0.25 * k, 0, 0, Math.PI * 2); ctx.fill(); ctx.translate(0, -pose.y * 0.3 * k); }
			var spread = bh === 'fly' ? 1 : 0;
			ctx.fillStyle = 'rgba(210,220,236,0.5)';
			[-1, 1].forEach(function (side) {
				ctx.save(); ctx.rotate(side * (0.25 + spread * 1.1));
				ctx.beginPath(); ctx.ellipse(-0.3 * k, side * 0.08 * k, 0.3 * k, 0.1 * k, 0, 0, Math.PI * 2); ctx.fill();
				ctx.restore();
			});
			ctx.strokeStyle = '#3d2b0f'; ctx.lineWidth = Math.max(1, 0.03 * k);
			for (var i = 0; i < 3; i++) {
				var ax = 0.16 - i * 0.08;
				var sw = state.fly.speed > 0.05 ? Math.sin(performance.now() / 60 + i * 2) * 0.1 : 0;
				[-1, 1].forEach(function (side) {
					ctx.beginPath(); ctx.moveTo(ax * k, 0); ctx.lineTo((ax + (1 - i) * 0.12 + sw * side) * k, side * 0.3 * k); ctx.stroke();
				});
			}
			ctx.fillStyle = '#c28f1f';
			ctx.beginPath(); ctx.ellipse(-0.24 * k, 0, 0.27 * k, 0.15 * k, 0, 0, Math.PI * 2); ctx.fill();
			ctx.fillStyle = '#8b6914';
			ctx.beginPath(); ctx.ellipse(0.08 * k, 0, 0.17 * k, 0.13 * k, 0, 0, Math.PI * 2); ctx.fill();
			ctx.beginPath(); ctx.ellipse(0.3 * k, 0, 0.09 * k, 0.12 * k, 0, 0, Math.PI * 2); ctx.fill();
			ctx.fillStyle = '#b3121a';
			ctx.beginPath(); ctx.ellipse(0.31 * k, -0.085 * k, 0.07 * k, 0.05 * k, 0, 0, Math.PI * 2); ctx.fill();
			ctx.beginPath(); ctx.ellipse(0.31 * k, 0.085 * k, 0.07 * k, 0.05 * k, 0, 0, Math.PI * 2); ctx.fill();
			if (bh === 'feed') { ctx.strokeStyle = '#3d2b0f'; ctx.beginPath(); ctx.moveTo(0.38 * k, 0); ctx.lineTo(0.5 * k, 0); ctx.stroke(); }
			ctx.restore();
		}

		function circle(x, z, r, color) {
			var p = toScreen(x, z);
			ctx.fillStyle = color;
			ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1.5, r * view.scale), 0, Math.PI * 2); ctx.fill();
		}
		function ellipse(x, z, rx, rz, color) {
			var p = toScreen(x, z);
			ctx.fillStyle = color;
			ctx.beginPath(); ctx.ellipse(p.x, p.y, rx * view.scale, rz * view.scale, 0, 0, Math.PI * 2); ctx.fill();
		}
		function roundRectPath(x, y, w, h, r) {
			ctx.beginPath();
			ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
			ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
			ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
			ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
			ctx.closePath();
		}
		function shadeColor(hex, light) {
			var f = 0.35 + 0.65 * clamp(light, 0, 1);
			var n = parseInt(hex.slice(1), 16);
			return 'rgb(' + Math.round(((n >> 16) & 255) * f) + ',' + Math.round(((n >> 8) & 255) * f) + ',' + Math.round((n & 255) * f) + ')';
		}
		function mix(a, c, t) {
			var x = parseInt(a.slice(1), 16), y = parseInt(c.slice(1), 16);
			var r = ((x >> 16) & 255) * (1 - t) + ((y >> 16) & 255) * t;
			var g = ((x >> 8) & 255) * (1 - t) + ((y >> 8) & 255) * t;
			var bb = (x & 255) * (1 - t) + (y & 255) * t;
			return 'rgb(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(bb) + ')';
		}

		/* ---------- API ---------- */

		var api = { kind: 'canvas2d' };
		api.sync = function (state, pose, info) {
			lastState = state; lastPose = pose; lastInfo = info;
			var f = state.fly, last = trail[trail.length - 1];
			if (!last || Math.hypot(last.x - f.x, last.z - f.z) > 0.25) {
				trail.push({ x: f.x, z: f.z, b: state.behavior.current });
				if (trail.length > cfg.render.trailLength) trail.shift();
			}
			if (follow) {
				view.cx += (pose.x - view.cx) * 0.08;
				view.cz += (pose.z - view.cz) * 0.08;
			}
		};
		api.render = function () {
			if (suspended || !lastPose) return;
			drawScene(lastState, lastPose, lastInfo);
		};
		api.screenToGround = function (cx, cy) {
			var p = toWorld(cx, cy);
			if (p.x < b.xMin || p.x > b.xMax || p.z < b.zMin || p.z > b.zMax) return null;
			return p;
		};
		api.pick = function (cx, cy) {
			var p = api.screenToGround(cx, cy);
			if (!p) return null;
			var st = lastState, tol = 10 / view.scale;
			if (Math.hypot(p.x - st.fly.x, p.z - st.fly.z) < Math.max(0.8, tol)) return { type: 'fly', x: p.x, z: p.z };
			for (var i = 0; i < st.fruits.length; i++) {
				var f = st.fruits[i];
				if (f.stage === 'attached') continue;
				if (Math.hypot(p.x - f.x, p.z - f.z) < Math.max(f.radius * 1.3, tol)) return { type: 'fruit', id: f.id, x: p.x, z: p.z };
			}
			for (var w = 0; w < st.webs.length; w++) {
				var web = st.webs[w], fr = WS.webFrame(web);
				var d = WS.pointSegmentDistance(p.x, p.z, fr.cx + fr.ux * web.radius, fr.cz + fr.uz * web.radius, fr.cx - fr.ux * web.radius, fr.cz - fr.uz * web.radius);
				if (d < Math.max(0.8, tol)) return { type: 'web', id: web.id, x: p.x, z: p.z };
			}
			return { type: 'ground', x: p.x, z: p.z };
		};
		api.worldToScreen = function (x, y, z) {
			var r = canvas.getBoundingClientRect();
			var p = toScreen(x, z);
			return { x: r.left + p.x, y: r.top + p.y - y * 0.3 * view.scale, visible: true };
		};
		api.setFollow = function (on) { follow = !!on; if (follow && view.zoom < 3) { view.zoom = 3.5; fitScale(); } };
		api.isFollowing = function () { return follow; };
		api.resetCamera = function () { follow = false; view.cx = (b.xMin + b.xMax) / 2; view.cz = (b.zMin + b.zMax) / 2; view.zoom = 1; fitScale(); };
		api.zoomBy = function (f) { view.zoom = clamp(view.zoom * f, 0.7, 14); fitScale(); };
		api.setOverlay = function (name, on) { overlays[name] = !!on; };
		api.overlays = function () { return overlays; };
		api.select = function (sel) { selection = sel; };
		api.clearTrail = function () { trail = []; };
		api.resize = function () {
			dpr = Math.min(root.devicePixelRatio || 1, cfg.render.maxPixelRatio);
			var w = canvas.clientWidth || root.innerWidth, h = canvas.clientHeight || root.innerHeight;
			canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
			fitScale();
		};
		api.suspend = function (on) { suspended = !!on; };
		api.setPanEnabled = function (on) { panEnabled = !!on; if (!on) drag = null; };
		var insets = { top: 0, bottom: 0 };
		api.setInsets = function (top, bottom) { insets.top = top || 0; insets.bottom = bottom || 0; api.resize(); };
		api.setQuality = function () {};
		api.dispose = function () {
			canvas.removeEventListener('pointerdown', onDown);
			root.removeEventListener('pointermove', onMove);
			root.removeEventListener('pointerup', onUp);
			canvas.removeEventListener('wheel', onWheel);
		};
		api.onContextLost = function () {};
		api.stats = function () { return { calls: 0 }; };
		api.resize();
		return api;
	}

	root.WorldRenderer2D = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
