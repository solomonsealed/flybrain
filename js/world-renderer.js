/* world-renderer.js -- WebGL garden (Three.js r128): scene, meshes, fly
 * animation, camera, overlays and picking.
 *
 * Draws the shared world state; it never changes it. Camera pan, zoom,
 * orbit, resize or follow only move the camera, so they cannot affect the
 * simulation. Cosmetic randomness (leaf placement, strand wobble phases)
 * uses its own generator seeded from state.cosmeticSeed.
 *
 * API (shared with world-renderer-2d.js):
 *   create(canvas, config, state) -> renderer | throws if WebGL unavailable
 *   renderer.sync(state, pose, info)   update dynamic objects for this frame
 *   renderer.render()
 *   renderer.pick(clientX, clientY)    -> {type, id, x, z} | null
 *   renderer.screenToGround(cx, cy)    -> {x, z} | null
 *   renderer.worldToScreen(x, y, z)    -> {x, y, visible}
 *   renderer.setFollow(on), resetCamera(), zoomBy(f), setOverlay(name, on),
 *   renderer.select(obj), resize(), suspend(on), dispose(), kind
 */
(function (root) {
	'use strict';

	var WS = root.WorldState;

	function cosmeticRng(seed) {
		var rng = root.WorldRandom.create(seed);
		return function () { return root.WorldRandom.next(rng); };
	}

	function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

	var BEHAVIOR_COLORS = {
		walk: [0.55, 0.8, 1.0], feed: [1.0, 0.8, 0.25], startle: [1.0, 0.35, 0.3], fly: [0.85, 0.55, 1.0],
		groom: [0.6, 1.0, 0.6], rest: [0.6, 0.6, 0.7], idle: [0.75, 0.75, 0.75], brace: [0.6, 0.9, 0.9], snagged: [1.0, 0.2, 0.6]
	};

	function create(canvas, cfg, state, options) {
		options = options || {};
		if (typeof THREE === 'undefined') throw new Error('Three.js not loaded');
		var gl = null;
		try {
			gl = canvas.getContext('webgl', { antialias: true }) || canvas.getContext('experimental-webgl');
		} catch (e) { gl = null; }
		if (!gl) throw new Error('WebGL unavailable');

		var renderer = new THREE.WebGLRenderer({ canvas: canvas, context: gl, antialias: true });
		renderer.setPixelRatio(Math.min(root.devicePixelRatio || 1, cfg.render.maxPixelRatio));
		renderer.shadowMap.enabled = true;
		renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		renderer.setClearColor(0x2a2a24);

		var scene = new THREE.Scene();
		scene.fog = new THREE.Fog(0x3a3a30, 180, 320);
		var disposables = [];
		function track(o) { disposables.push(o); return o; }

		var b = cfg.bounds;
		var cx = (b.xMin + b.xMax) / 2, cz = (b.zMin + b.zMax) / 2;
		var rand = cosmeticRng(state.cosmeticSeed);

		/* ---------- camera and controls ---------- */

		var camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -500, 1000);
		var HOME = { target: new THREE.Vector3(cx, 0, cz + 4), offset: new THREE.Vector3(0, 95, 80), zoom: 1 };
		var controls = new THREE.OrbitControls(camera, canvas);
		controls.enableDamping = true;
		controls.dampingFactor = 0.12;
		controls.screenSpacePanning = false;
		controls.minZoom = 0.7;
		controls.maxZoom = 14;
		controls.minPolarAngle = 0.25;
		controls.maxPolarAngle = 1.25;
		controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
		controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
		controls.keys = { LEFT: 'ArrowLeft', UP: 'ArrowUp', RIGHT: 'ArrowRight', BOTTOM: 'ArrowDown' };
		// arrow keys pan while the garden canvas has keyboard focus
		if (controls.listenToKeyEvents) controls.listenToKeyEvents(canvas);
		var follow = false;

		function resetCamera() {
			controls.target.copy(HOME.target);
			camera.position.copy(HOME.target).add(HOME.offset);
			camera.zoom = HOME.zoom;
			camera.updateProjectionMatrix();
			controls.update();
		}

		controls.addEventListener('change', function () {
			// keep the look-at point inside the garden
			var t = controls.target;
			var nx = clamp(t.x, b.xMin - 5, b.xMax + 5), nz = clamp(t.z, b.zMin - 5, b.zMax + 5);
			if (nx !== t.x || nz !== t.z || t.y !== 0) {
				camera.position.x += nx - t.x; camera.position.z += nz - t.z; camera.position.y -= t.y;
				t.set(nx, 0, nz);
			}
		});

		/* ---------- lights ---------- */

		var hemi = new THREE.HemisphereLight(0xe9f1ff, 0x5a4a36, 0.55);
		scene.add(hemi);
		var sun = new THREE.DirectionalLight(0xfff0d8, 0.95);
		var sd = cfg.sun;
		sun.position.set(cx + sd.dirX * 120, sd.dirY * 140, cz + sd.dirZ * 120);
		sun.target.position.set(cx, 0, cz);
		sun.castShadow = true;
		sun.shadow.mapSize.set(cfg.render.shadowMapSize, cfg.render.shadowMapSize);
		var sc = sun.shadow.camera;
		sc.left = -90; sc.right = 90; sc.top = 90; sc.bottom = -90; sc.near = 10; sc.far = 400;
		sun.shadow.bias = -0.0015;
		scene.add(sun);
		scene.add(sun.target);
		var fill = new THREE.DirectionalLight(0xbfd6ff, 0.18);
		fill.position.set(cx - 80, 60, cz - 60);
		scene.add(fill);

		/* ---------- procedural textures ---------- */

		function canvasTexture(w, h, paint) {
			var c = document.createElement('canvas');
			c.width = w; c.height = h;
			paint(c.getContext('2d'), w, h);
			var t = track(new THREE.CanvasTexture(c));
			t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
			return t;
		}

		var groundTex = canvasTexture(1024, 1024, function (g, w, h) {
			var sx = w / (b.xMax - b.xMin), sz = h / (b.zMax - b.zMin);
			g.fillStyle = '#6a5a41';
			g.fillRect(0, 0, w, h);
			var i;
			// soil grain
			for (i = 0; i < 9000; i++) {
				var v = 80 + Math.floor(rand() * 40);
				g.fillStyle = 'rgba(' + (v + 20) + ',' + (v + 5) + ',' + (v - 25) + ',0.35)';
				g.fillRect(rand() * w, rand() * h, 2 + rand() * 3, 2 + rand() * 3);
			}
			// moss patches
			for (i = 0; i < 140; i++) {
				var mx = rand() * w, mz = rand() * h, mr = 12 + rand() * 50;
				var mg = g.createRadialGradient(mx, mz, 0, mx, mz, mr);
				mg.addColorStop(0, 'rgba(92,122,52,0.55)');
				mg.addColorStop(1, 'rgba(92,122,52,0)');
				g.fillStyle = mg;
				g.beginPath(); g.arc(mx, mz, mr, 0, Math.PI * 2); g.fill();
			}
			// sunny clearing
			var clr = cfg.areas.filter(function (a) { return a.id === 'clearing'; })[0] || { x: cx, z: cz };
			var cg = g.createRadialGradient(clr.x * sx, clr.z * sz, 10, clr.x * sx, clr.z * sz, 30 * sx);
			cg.addColorStop(0, 'rgba(196,170,112,0.55)');
			cg.addColorStop(1, 'rgba(196,170,112,0)');
			g.fillStyle = cg; g.fillRect(0, 0, w, h);
			// darker soil and litter under trees and the shelter
			cfg.shade.forEach(function (s) {
				var sg = g.createRadialGradient(s.x * sx, s.z * sz, 0, s.x * sx, s.z * sz, s.radius * sx * 1.1);
				sg.addColorStop(0, 'rgba(48,36,24,0.55)');
				sg.addColorStop(1, 'rgba(48,36,24,0)');
				g.fillStyle = sg; g.fillRect(0, 0, w, h);
			});
			// fallen leaves
			var leafCols = ['#8c6a2a', '#a4792e', '#6d5a24', '#7f8a36', '#b0662c'];
			for (i = 0; i < 700; i++) {
				g.save();
				g.translate(rand() * w, rand() * h);
				g.rotate(rand() * Math.PI);
				g.fillStyle = leafCols[Math.floor(rand() * leafCols.length)];
				g.globalAlpha = 0.5 + rand() * 0.4;
				g.beginPath(); g.ellipse(0, 0, 3 + rand() * 4, 1.5 + rand() * 2, 0, 0, Math.PI * 2); g.fill();
				g.restore();
			}
		});

		var stoneTex = canvasTexture(512, 512, function (g, w, h) {
			g.fillStyle = '#6f5f4c';
			g.fillRect(0, 0, w, h);
			var rowH = 38, y = 0, row = 0;
			while (y < h) {
				var x = row % 2 ? -30 : 0;
				while (x < w) {
					var bw = 50 + rand() * 60;
					var tone = 150 + Math.floor(rand() * 50);
					g.fillStyle = 'rgb(' + tone + ',' + Math.floor(tone * 0.86) + ',' + Math.floor(tone * 0.68) + ')';
					roundRect(g, x + 3, y + 3, bw - 6, rowH - 6, 7);
					g.fill();
					g.fillStyle = 'rgba(255,240,210,0.08)';
					roundRect(g, x + 6, y + 5, bw - 14, 8, 4);
					g.fill();
					x += bw;
				}
				y += rowH; row++;
			}
		});
		stoneTex.wrapS = stoneTex.wrapT = THREE.RepeatWrapping;

		function roundRect(g, x, y, w, h, r) {
			g.beginPath();
			g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
			g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
			g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
			g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
			g.closePath();
		}

		var barkTex = canvasTexture(128, 256, function (g, w, h) {
			g.fillStyle = '#5b3f28'; g.fillRect(0, 0, w, h);
			for (var i = 0; i < 60; i++) {
				g.strokeStyle = 'rgba(30,20,12,' + (0.3 + rand() * 0.4) + ')';
				g.lineWidth = 1 + rand() * 3;
				var x = rand() * w;
				g.beginPath(); g.moveTo(x, 0); g.bezierCurveTo(x + 8, h * 0.3, x - 8, h * 0.6, x + 4, h); g.stroke();
			}
		});
		barkTex.wrapS = barkTex.wrapT = THREE.RepeatWrapping;

		/* ---------- static scenery ---------- */

		var ground = new THREE.Mesh(track(new THREE.PlaneGeometry(b.xMax - b.xMin, b.zMax - b.zMin)),
			track(new THREE.MeshLambertMaterial({ map: groundTex })));
		ground.rotation.x = -Math.PI / 2;
		ground.position.set(cx, 0, cz);
		ground.receiveShadow = true;
		ground.userData.pick = { type: 'ground' };
		scene.add(ground);

		// Walls: four straight boxes and four rounded corners, each fadeable.
		var enc = cfg.enclosure;
		var walls = [];
		function wallMaterial(repeatX) {
			var t = stoneTex.clone();
			t.needsUpdate = true;
			t.repeat.set(repeatX, enc.wallHeight / 12);
			track(t);
			return track(new THREE.MeshLambertMaterial({ map: t, transparent: true, opacity: 1 }));
		}
		var R = enc.cornerRadius, T = enc.wallThickness, H = enc.wallHeight;
		function addWall(mesh, outX, outZ) {
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			mesh.userData.outward = new THREE.Vector3(outX, 0, outZ).normalize();
			scene.add(mesh);
			walls.push(mesh);
		}
		var lenX = (b.xMax - b.xMin) - 2 * R, lenZ = (b.zMax - b.zMin) - 2 * R;
		var wn = new THREE.Mesh(track(new THREE.BoxGeometry(lenX, H, T)), wallMaterial(lenX / 12));
		wn.position.set(cx, H / 2, b.zMin - T / 2); addWall(wn, 0, -1);
		var wsm = new THREE.Mesh(track(new THREE.BoxGeometry(lenX, H, T)), wallMaterial(lenX / 12));
		wsm.position.set(cx, H / 2, b.zMax + T / 2); addWall(wsm, 0, 1);
		var ww = new THREE.Mesh(track(new THREE.BoxGeometry(T, H, lenZ)), wallMaterial(lenZ / 12));
		ww.position.set(b.xMin - T / 2, H / 2, cz); addWall(ww, -1, 0);
		var we = new THREE.Mesh(track(new THREE.BoxGeometry(T, H, lenZ)), wallMaterial(lenZ / 12));
		we.position.set(b.xMax + T / 2, H / 2, cz); addWall(we, 1, 0);
		[[b.xMin + R, b.zMin + R, Math.PI, -1, -1], [b.xMax - R, b.zMin + R, 1.5 * Math.PI, 1, -1],
			[b.xMax - R, b.zMax - R, 0, 1, 1], [b.xMin + R, b.zMax - R, 0.5 * Math.PI, -1, 1]].forEach(function (c) {
			var shape = new THREE.Shape();
			shape.absarc(0, 0, R + T, c[2], c[2] + Math.PI / 2, false);
			shape.absarc(0, 0, R, c[2] + Math.PI / 2, c[2], true);
			var geo = track(new THREE.ExtrudeGeometry(shape, { depth: H, bevelEnabled: false, curveSegments: 10 }));
			geo.rotateX(-Math.PI / 2);
			// extrusion runs along +y after rotation; shape y maps to -z
			// ExtrudeGeometry UVs are in world units: scale the stone pattern to match
			var cm = wallMaterial(1 / 12);
			cm.map.repeat.set(1 / 12, 1 / 12);
			var m = new THREE.Mesh(geo, cm);
			m.position.set(c[0], 0, c[1]);
			m.scale.z = -1;
			addWall(m, c[3], c[4]);
		});

		// Lightly indicated mesh roof.
		(function () {
			var pts = [];
			var y = enc.roofHeight;
			for (var x = b.xMin; x <= b.xMax + 0.1; x += 6) { pts.push(x, y, b.zMin, x, y, b.zMax); }
			for (var z = b.zMin; z <= b.zMax + 0.1; z += 6) { pts.push(b.xMin, y, z, b.xMax, y, z); }
			var g = track(new THREE.BufferGeometry());
			g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
			var roof = new THREE.LineSegments(g, track(new THREE.LineBasicMaterial({ color: 0xd8e4ea, transparent: true, opacity: 0.1 })));
			scene.add(roof);
		})();

		// Trees: tapered trunk, low branches, instanced leaf clusters.
		var trunkMat = track(new THREE.MeshLambertMaterial({ map: barkTex }));
		var leafGeo = track(new THREE.IcosahedronGeometry(1, 0));
		var leafMat = track(new THREE.MeshLambertMaterial({ color: 0xffffff }));
		var canopyMeshes = [];
		cfg.trees.forEach(function (t) {
			var trunk = new THREE.Mesh(track(new THREE.CylinderGeometry(t.trunkRadius * 0.7, t.trunkRadius, t.trunkHeight + 3, 10)), trunkMat);
			trunk.position.set(t.x, (t.trunkHeight + 3) / 2, t.z);
			trunk.castShadow = true;
			trunk.userData.pick = { type: 'tree', id: t.id };
			scene.add(trunk);
			var branches = (t.lowBranches || []).map(function (lb) { return lb.to; });
			for (var k = 0; k < 4; k++) {
				var a = k * Math.PI / 2 + rand() * 0.8;
				branches.push({ x: t.x + Math.cos(a) * t.canopyRadius * 0.6, y: t.trunkHeight + 2 + rand() * 3, z: t.z + Math.sin(a) * t.canopyRadius * 0.6 });
			}
			branches.forEach(function (to, i) {
				var from = new THREE.Vector3(t.x, i < (t.lowBranches || []).length ? to.y + 2.5 : t.trunkHeight - 1, t.z);
				var end = new THREE.Vector3(to.x, to.y, to.z);
				var dir = end.clone().sub(from);
				var len = dir.length();
				var br = new THREE.Mesh(track(new THREE.CylinderGeometry(0.18, t.trunkRadius * 0.35, len, 6)), trunkMat);
				br.position.copy(from).addScaledVector(dir, 0.5);
				br.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
				br.castShadow = true;
				scene.add(br);
			});
			var n = Math.round(t.canopyRadius * 9);
			var inst = new THREE.InstancedMesh(leafGeo, leafMat, n);
			var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color();
			var base = t.species === 'fig' ? [0.3, 0.45, 0.2] : (t.species === 'apple' ? [0.28, 0.5, 0.22] : [0.32, 0.42, 0.26]);
			for (var i = 0; i < n; i++) {
				var u = rand() * Math.PI * 2, v = Math.acos(2 * rand() - 1), rr = Math.cbrt(rand());
				var px = t.x + Math.sin(v) * Math.cos(u) * t.canopyRadius * rr;
				var pz = t.z + Math.sin(v) * Math.sin(u) * t.canopyRadius * rr;
				var py = t.canopyY + Math.cos(v) * t.canopyRadius * 0.45 * rr;
				var s = 1.6 + rand() * 2.2;
				q.setFromEuler(new THREE.Euler(rand() * 3, rand() * 3, rand() * 3));
				m4.compose(new THREE.Vector3(px, py, pz), q, new THREE.Vector3(s, s * 0.8, s));
				inst.setMatrixAt(i, m4);
				var j = 0.75 + rand() * 0.45;
				col.setRGB(base[0] * j, base[1] * j, base[2] * j);
				inst.setColorAt(i, col);
			}
			inst.castShadow = true;
			inst.userData.baseOpacity = 1;
			scene.add(inst);
			canopyMeshes.push(inst);
		});

		// Stones.
		var stoneMat = track(new THREE.MeshLambertMaterial({ color: 0x8d8579 }));
		cfg.stones.forEach(function (s) {
			var m = new THREE.Mesh(track(new THREE.DodecahedronGeometry(1, 1)), stoneMat);
			m.scale.set(s.radius, s.height, s.radius * (0.85 + rand() * 0.3));
			m.position.set(s.x, s.height * 0.45, s.z);
			m.rotation.y = rand() * Math.PI;
			m.castShadow = true;
			m.receiveShadow = true;
			scene.add(m);
		});

		// Trellis: posts and a diagonal lattice.
		var woodMat = track(new THREE.MeshLambertMaterial({ color: 0x9a7b52 }));
		cfg.trellis.forEach(function (p) {
			var dx = p.x2 - p.x1, dz = p.z2 - p.z1, len = Math.hypot(dx, dz);
			var ang = Math.atan2(-dz, dx);
			var grp = new THREE.Group();
			grp.position.set(p.x1, 0, p.z1);
			grp.rotation.y = ang;
			var postGeo = track(new THREE.BoxGeometry(0.5, p.height, 0.5));
			for (var s = 0; s <= len + 0.01; s += len / Math.max(1, Math.round(len / 6))) {
				var post = new THREE.Mesh(postGeo, woodMat);
				post.position.set(s, p.height / 2, 0);
				post.castShadow = true;
				grp.add(post);
			}
			var slatGeo = track(new THREE.BoxGeometry(1, 0.18, 0.12));
			var step = 2.2;
			for (var d = -p.height; d < len; d += step) {
				[1, -1].forEach(function (dir) {
					var x0 = d, y0 = 0, x1 = d + p.height, y1 = p.height;
					if (dir < 0) { x0 = d + p.height; x1 = d; }
					var ax = Math.max(0, Math.min(len, x0)), bx = Math.max(0, Math.min(len, x1));
					var ty0 = y0 + (ax - x0) / (x1 - x0) * (y1 - y0), ty1 = y0 + (bx - x0) / (x1 - x0) * (y1 - y0);
					var sl = Math.hypot(bx - ax, ty1 - ty0);
					if (sl < 0.3) return;
					var slat = new THREE.Mesh(slatGeo, woodMat);
					slat.scale.x = sl;
					slat.position.set((ax + bx) / 2, (ty0 + ty1) / 2, 0);
					slat.rotation.z = Math.atan2(ty1 - ty0, bx - ax);
					grp.add(slat);
				});
			}
			scene.add(grp);
		});

		// Vine foliage around the trellis (blocks sight in the senses too).
		var vineMat = track(new THREE.MeshLambertMaterial({ color: 0xffffff }));
		cfg.foliage.forEach(function (f) {
			var n = 40;
			var inst = new THREE.InstancedMesh(leafGeo, vineMat, n);
			var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color();
			for (var i = 0; i < n; i++) {
				var u = rand() * Math.PI * 2, v = Math.acos(2 * rand() - 1), rr = Math.cbrt(rand());
				var pos = new THREE.Vector3(f.x + Math.sin(v) * Math.cos(u) * f.rx * rr, Math.max(0.3, f.y + Math.cos(v) * f.ry * rr), f.z + Math.sin(v) * Math.sin(u) * f.rz * rr);
				var s = 0.7 + rand() * 0.8;
				q.setFromEuler(new THREE.Euler(rand() * 3, rand() * 3, rand() * 3));
				m4.compose(pos, q, new THREE.Vector3(s, s * 0.5, s));
				inst.setMatrixAt(i, m4);
				var j = 0.7 + rand() * 0.4;
				col.setRGB(0.24 * j, 0.42 * j, 0.18 * j);
				inst.setColorAt(i, col);
			}
			inst.castShadow = true;
			scene.add(inst);
		});

		// Shelter: large leaves tilted over the resting area, plus litter.
		var bigLeafShape = new THREE.Shape();
		bigLeafShape.moveTo(0, -0.5);
		bigLeafShape.bezierCurveTo(0.45, -0.25, 0.45, 0.25, 0, 0.5);
		bigLeafShape.bezierCurveTo(-0.45, 0.25, -0.45, -0.25, 0, -0.5);
		var bigLeafGeo = track(new THREE.ShapeGeometry(bigLeafShape, 12));
		var bigLeafMat = track(new THREE.MeshLambertMaterial({ color: 0x5e6d2c, side: THREE.DoubleSide }));
		cfg.shelter.leaves.forEach(function (l) {
			var m = new THREE.Mesh(bigLeafGeo, bigLeafMat);
			m.scale.set(l.size * 0.9, l.size * 1.6, 1);
			m.position.set(l.x, l.height, l.z);
			m.rotation.set(-Math.PI / 2 + 0.25, 0, l.angle);
			m.castShadow = true;
			m.receiveShadow = true;
			scene.add(m);
			var stem = new THREE.Mesh(track(new THREE.CylinderGeometry(0.08, 0.12, l.height, 5)), woodMat);
			stem.position.set(l.x, l.height / 2, l.z);
			scene.add(stem);
		});

		// Grass tufts and litter (cosmetic instancing).
		(function () {
			var tuftGeo = track(new THREE.ConeGeometry(0.1, 0.8, 4));
			var n = 900;
			var inst = new THREE.InstancedMesh(tuftGeo, track(new THREE.MeshLambertMaterial({ color: 0xffffff })), n);
			var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color();
			var placed = 0;
			for (var tries = 0; tries < n * 3 && placed < n; tries++) {
				var x = b.xMin + 2 + rand() * (b.xMax - b.xMin - 4), z = b.zMin + 2 + rand() * (b.zMax - b.zMin - 4);
				if (!WS.groundPointFree(cfg, x, z, 1.0)) continue;
				var s = 0.5 + rand() * 0.9;
				q.setFromEuler(new THREE.Euler((rand() - 0.5) * 0.5, rand() * 3, (rand() - 0.5) * 0.5));
				m4.compose(new THREE.Vector3(x, s * 0.4, z), q, new THREE.Vector3(s, s, s));
				inst.setMatrixAt(placed, m4);
				var j = 0.7 + rand() * 0.5;
				col.setRGB(0.33 * j, 0.47 * j, 0.2 * j);
				inst.setColorAt(placed, col);
				placed++;
			}
			inst.count = placed;
			scene.add(inst);
		})();

		/* ---------- fruit ---------- */

		var fruitGeo = track(new THREE.SphereGeometry(1, 18, 14));
		var fruitMeshes = {};
		var fruitMats = {};
		function fruitMaterial(species, stage) {
			var key = species + ':' + stage;
			if (!fruitMats[key]) {
				var sp = cfg.species[species] || cfg.species.user;
				var c = new THREE.Color(sp.color);
				if (stage === 'fermenting') c.lerp(new THREE.Color(0x5a4020), 0.35);
				if (stage === 'attached') c.lerp(new THREE.Color(0x7a9a3a), 0.5);
				fruitMats[key] = track(new THREE.MeshStandardMaterial({ color: c, roughness: stage === 'fermenting' ? 0.9 : 0.45, metalness: 0,
					emissive: stage === 'fermenting' ? new THREE.Color(0x221400) : new THREE.Color(0), transparent: true }));
			}
			return fruitMats[key];
		}

		function syncFruit(state) {
			var seen = {};
			for (var i = 0; i < state.fruits.length; i++) {
				var f = state.fruits[i];
				seen[f.id] = true;
				var m = fruitMeshes[f.id];
				if (!m) {
					m = new THREE.Mesh(fruitGeo, fruitMaterial(f.species, f.stage));
					m.castShadow = true;
					m.userData.pick = { type: 'fruit', id: f.id };
					m.userData.stage = f.stage;
					scene.add(m);
					fruitMeshes[f.id] = m;
				}
				if (m.userData.stage !== f.stage) {
					m.material = fruitMaterial(f.species, f.stage);
					m.userData.stage = f.stage;
				}
				var r = f.radius * (f.stage === 'attached' ? 0.35 + 0.65 * f.ripeness : Math.max(0.35, Math.cbrt(Math.max(0.05, f.amount))));
				m.scale.set(r, r * (f.stage === 'attached' ? 1 : 0.85), r);
				m.position.set(f.x, f.stage === 'attached' ? f.y : r * 0.8, f.z);
				m.material.opacity = f.stage === 'depleted' ? 0.35 : 1;
			}
			for (var id in fruitMeshes) {
				if (!seen[id]) { scene.remove(fruitMeshes[id]); delete fruitMeshes[id]; }
			}
		}

		/* ---------- webs ---------- */

		var webMat = track(new THREE.LineBasicMaterial({ color: 0xf6f2e6, transparent: true, opacity: 0.85 }));
		var anchorMat = track(new THREE.LineBasicMaterial({ color: 0xe8e2d0, transparent: true, opacity: 0.45 }));
		var webObjs = {};

		function buildWeb(web) {
			var f = WS.webFrame(web);
			var wr = cosmeticRng((state.cosmeticSeed ^ hashId(web.id)) >>> 0);
			var R0 = web.radius;
			var spokes = web.spokes;
			var angles = [], rims = [];
			for (var i = 0; i < spokes; i++) {
				angles.push((i + (wr() - 0.5) * 0.3) / spokes * Math.PI * 2);
				rims.push(R0 * (0.85 + wr() * 0.15));
			}
			var local = [];   // [u, v] pairs, two per segment
			for (i = 0; i < spokes; i++) {
				local.push(0, 0, Math.cos(angles[i]) * rims[i], Math.sin(angles[i]) * rims[i]);
			}
			// frame thread
			for (i = 0; i < spokes; i++) {
				var j = (i + 1) % spokes;
				local.push(Math.cos(angles[i]) * rims[i], Math.sin(angles[i]) * rims[i], Math.cos(angles[j]) * rims[j], Math.sin(angles[j]) * rims[j]);
			}
			// capture spiral: straight between spokes
			var turns = web.spiralTurns, r0 = 0.14;
			var total = turns * spokes;
			var prev = null;
			for (var k = 0; k <= total; k++) {
				var si = k % spokes;
				var frac = k / total;
				var rr = (r0 + (0.93 - r0) * frac) * rims[si];
				var pt = [Math.cos(angles[si]) * rr, Math.sin(angles[si]) * rr];
				if (prev) local.push(prev[0], prev[1], pt[0], pt[1]);
				prev = pt;
			}
			var n = local.length / 2;
			var pos = new Float32Array(n * 3);
			var geo = new THREE.BufferGeometry();
			geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
			var lines = new THREE.LineSegments(geo, webMat);
			// anchor threads to the ground and upward
			var anc = [];
			var top = [f.cx, f.cy + R0 + 3.5, f.cz];
			[[0, R0 * 0.95, top[0], top[1], top[2]],
				[R0 * 0.9, -R0 * 0.3, f.cx + f.ux * (R0 + 2.5), 0.02, f.cz + f.uz * (R0 + 2.5)],
				[-R0 * 0.9, -R0 * 0.3, f.cx - f.ux * (R0 + 2.5), 0.02, f.cz - f.uz * (R0 + 2.5)],
				[R0 * 0.7, R0 * 0.7, f.cx + f.ux * (R0 + 1.5), f.cy + R0 + 1.5, f.cz + f.uz * (R0 + 1.5)]].forEach(function (a) {
				var p = webPoint(f, a[0], a[1], 0);
				anc.push(p[0], p[1], p[2], a[2], a[3], a[4]);
			});
			var ageo = new THREE.BufferGeometry();
			ageo.setAttribute('position', new THREE.Float32BufferAttribute(anc, 3));
			var anchors = new THREE.LineSegments(ageo, anchorMat);
			// invisible disk for picking
			var disk = new THREE.Mesh(new THREE.CircleGeometry(R0, 24), new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
			disk.position.set(f.cx, f.cy, f.cz);
			disk.lookAt(f.cx + f.nx, f.cy, f.cz + f.nz);
			disk.userData.pick = { type: 'web', id: web.id };
			var grp = new THREE.Group();
			grp.add(lines); grp.add(anchors); grp.add(disk);
			scene.add(grp);
			return { group: grp, lines: lines, local: local, frame: f, geo: geo, ageo: ageo, disk: disk, motion: web.motion, radius: R0 };
		}

		function webPoint(f, u, v, off) {
			return [f.cx + f.ux * u + f.nx * off, Math.max(0.03, f.cy + v), f.cz + f.uz * u + f.nz * off];
		}

		function hashId(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

		function syncWebs(state, t) {
			var seen = {};
			state.webs.forEach(function (web) {
				seen[web.id] = true;
				var o = webObjs[web.id];
				if (!o) o = webObjs[web.id] = buildWeb(web);
				// subtle strand motion along the normal
				var pos = o.geo.attributes.position.array;
				var L = o.local, f = o.frame;
				for (var i = 0; i < L.length / 2; i++) {
					var u = L[i * 2], v = L[i * 2 + 1];
					var rr = Math.hypot(u, v) / o.radius;
					var off = o.motion * 0.12 * rr * Math.sin(t * 2.3 + u * 0.9 + v * 0.7);
					var p = webPoint(f, u, v, off);
					pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2];
				}
				o.geo.attributes.position.needsUpdate = true;
				var hot = web.lastContact >= 0 && state.time - web.lastContact < 1.5;
				o.lines.material = hot ? hotWebMat : webMat;
			});
			for (var id in webObjs) {
				if (!seen[id]) {
					scene.remove(webObjs[id].group);
					webObjs[id].geo.dispose(); webObjs[id].ageo.dispose(); webObjs[id].disk.geometry.dispose();
					delete webObjs[id];
				}
			}
		}
		var hotWebMat = track(new THREE.LineBasicMaterial({ color: 0xffd0d0, transparent: true, opacity: 1 }));

		/* ---------- the fly ---------- */

		var fly = buildFly();
		scene.add(fly.root);

		function buildFly() {
			var rootG = new THREE.Group();
			var body = new THREE.Group();
			rootG.add(body);
			var mThorax = track(new THREE.MeshStandardMaterial({ color: 0x8b6914, roughness: 0.55 }));
			var stripeTex = canvasTexture(64, 128, function (g, w, h) {
				g.fillStyle = '#c28f1f'; g.fillRect(0, 0, w, h);
				g.fillStyle = '#5a3d0a';
				for (var i = 0; i < 5; i++) g.fillRect(0, 30 + i * 17, w, 7);
			});
			var mAbd = track(new THREE.MeshStandardMaterial({ map: stripeTex, roughness: 0.6 }));
			var mEye = track(new THREE.MeshStandardMaterial({ color: 0xb3121a, roughness: 0.3, emissive: 0x3a0000 }));
			var mDark = track(new THREE.MeshStandardMaterial({ color: 0x3d2b0f, roughness: 0.8 }));
			var mWing = track(new THREE.MeshStandardMaterial({ color: 0xdfe7f3, transparent: true, opacity: 0.42, roughness: 0.2, side: THREE.DoubleSide, depthWrite: false }));
			var sph = track(new THREE.SphereGeometry(1, 16, 12));
			var abdGeo = track(new THREE.SphereGeometry(1, 16, 16));
			abdGeo.rotateZ(Math.PI / 2);

			var thorax = new THREE.Mesh(sph, mThorax);
			thorax.scale.set(0.17, 0.13, 0.13);
			thorax.position.set(0.08, 0.26, 0);
			body.add(thorax);
			var abdomen = new THREE.Mesh(abdGeo, mAbd);
			abdomen.scale.set(0.27, 0.14, 0.15);
			abdomen.position.set(-0.24, 0.24, 0);
			body.add(abdomen);
			var head = new THREE.Mesh(sph, mThorax);
			head.scale.set(0.09, 0.1, 0.12);
			head.position.set(0.3, 0.28, 0);
			body.add(head);
			[-1, 1].forEach(function (s) {
				var eye = new THREE.Mesh(sph, mEye);
				eye.scale.set(0.07, 0.08, 0.055);
				eye.position.set(0.31, 0.3, s * 0.085);
				body.add(eye);
			});
			var segGeo = track(new THREE.CylinderGeometry(0.012, 0.012, 1, 5));
			segGeo.translate(0, 0.5, 0);
			function segment(parent, from, to, mat, rad) {
				var dir = to.clone().sub(from);
				var m = new THREE.Mesh(segGeo, mat);
				m.position.copy(from);
				m.scale.set(rad || 1, dir.length(), rad || 1);
				m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
				parent.add(m);
				return m;
			}
			var antennae = [];
			[-1, 1].forEach(function (s) {
				var a = new THREE.Group();
				a.position.set(0.37, 0.33, s * 0.03);
				segment(a, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.06, 0.07, s * 0.04), mDark, 1.3);
				var tip = new THREE.Mesh(sph, mDark);
				tip.scale.setScalar(0.018);
				tip.position.set(0.06, 0.07, s * 0.04);
				a.add(tip);
				body.add(a);
				antennae.push(a);
			});
			var prob = new THREE.Group();
			prob.position.set(0.36, 0.22, 0);
			segment(prob, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.05, -0.16, 0), mDark, 2.2);
			prob.scale.setScalar(0.01);
			body.add(prob);
			// wings: teardrops in the horizontal plane extending backward
			var wingShape = new THREE.Shape();
			wingShape.moveTo(0, 0);
			wingShape.bezierCurveTo(-0.15, 0.14, -0.45, 0.16, -0.55, 0.05);
			wingShape.bezierCurveTo(-0.5, -0.03, -0.2, -0.03, 0, 0);
			var wingGeo = track(new THREE.ShapeGeometry(wingShape, 10));
			wingGeo.rotateX(-Math.PI / 2);
			var wings = [];
			[-1, 1].forEach(function (s) {
				var pivot = new THREE.Group();
				pivot.position.set(0.1, 0.37, s * 0.05);
				var w = new THREE.Mesh(wingGeo, mWing);
				w.scale.z = -s;
				pivot.add(w);
				body.add(pivot);
				wings.push({ pivot: pivot, side: s });
			});
			// legs: femur + tibia per leg, swung about a hip pivot
			var legs = [];
			var attach = [0.16, 0.08, 0.0];
			var baseYaw = [0.7, 0.0, -0.7];
			for (var li = 0; li < 6; li++) {
				var pair = Math.floor(li / 2), s = li % 2 === 0 ? -1 : 1;
				var hip = new THREE.Group();
				hip.position.set(attach[pair], 0.2, s * 0.08);
				hip.rotation.y = s * baseYaw[pair];
				var knee = new THREE.Vector3(0.02, 0.1, s * 0.2);
				var foot = new THREE.Vector3(0.05, -0.2, s * 0.36);
				segment(hip, new THREE.Vector3(0, 0, 0), knee, mDark, 1.4);
				segment(hip, knee, foot, mDark, 1.1);
				body.add(hip);
				legs.push({ hip: hip, side: s, pair: pair, baseYaw: hip.rotation.y });
			}
			// marker ring and blob shadow (always drawn, for findability)
			var ring = new THREE.Mesh(track(new THREE.RingGeometry(0.9, 1.05, 32)),
				track(new THREE.MeshBasicMaterial({ color: 0xfff3c4, transparent: true, opacity: 0.55, depthWrite: false })));
			ring.rotation.x = -Math.PI / 2;
			ring.position.y = 0.04;
			var shadowTex = canvasTexture(64, 64, function (g) {
				var gr = g.createRadialGradient(32, 32, 2, 32, 32, 30);
				gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
				g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
			});
			var blob = new THREE.Mesh(track(new THREE.PlaneGeometry(1, 1)), track(new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false })));
			blob.rotation.x = -Math.PI / 2;
			blob.position.y = 0.03;
			var marker = new THREE.Group();
			marker.add(ring); marker.add(blob);
			scene.add(marker);
			rootG.userData.pick = { type: 'fly' };
			return { root: rootG, body: body, antennae: antennae, prob: prob, wings: wings, legs: legs, marker: marker, ring: ring, blob: blob,
				walkPhase: 0, twitchT: 0, twitch: [0, 0], twitchTarget: [0, 0], probExt: 0, spread: 0 };
		}

		var crand = cosmeticRng((state.cosmeticSeed ^ 0xa5a5a5) >>> 0);
		function animateFly(state, pose, dt, t) {
			var f = state.fly, bh = state.behavior.current;
			fly.root.position.set(pose.x, pose.y, pose.z);
			fly.root.rotation.y = pose.heading;
			var flying = f.mode === 'air';
			// legs: tripod gait advanced by walking speed
			var walking = !flying && f.speed > 0.05;
			fly.walkPhase += f.speed * dt * 9;
			for (var i = 0; i < fly.legs.length; i++) {
				var L = fly.legs[i];
				var tripodA = (i === 0 || i === 3 || i === 4);
				var ph = fly.walkPhase + (tripodA ? 0 : Math.PI);
				var swing = walking ? Math.sin(ph) * 0.35 : 0;
				var lift = walking ? Math.max(0, Math.cos(ph)) * 0.25 : 0;
				if (bh === 'groom' && L.pair === 0) { swing = Math.sin(t * 9 + L.side) * 0.5; lift = 0.5; }
				if (flying) { swing = 0; lift = 0.9; }
				if (bh === 'snagged') { swing = Math.sin(t * 14 + i) * 0.4; lift = 0.3; }
				L.hip.rotation.y = L.baseYaw + swing * L.side;
				L.hip.rotation.x = -L.side * lift;
			}
			// wings: spread and buzz in flight or startle, fold at rest
			var targetSpread = flying ? 1 : (bh === 'startle' && state.behavior.phase === 'run' ? 0.45 : 0);
			fly.spread += (targetSpread - fly.spread) * (1 - Math.exp(-dt / 0.08));
			for (var w = 0; w < fly.wings.length; w++) {
				var W = fly.wings[w];
				var buzz = flying ? Math.sin(t * 90) * 0.7 : 0;
				W.pivot.rotation.y = W.side * (0.25 + fly.spread * 1.15);
				W.pivot.rotation.x = W.side * buzz;
			}
			// proboscis follows feeding output
			var ext = bh === 'feed' ? 1 : 0;
			fly.probExt += (ext - fly.probExt) * (1 - Math.exp(-dt / 0.12));
			fly.prob.scale.setScalar(0.01 + fly.probExt);
			// antennae twitch (cosmetic)
			fly.twitchT -= dt;
			if (fly.twitchT <= 0) {
				fly.twitchT = 0.6 + crand() * 1.4;
				fly.twitchTarget = [(crand() - 0.5) * 0.5, (crand() - 0.5) * 0.5];
			}
			for (var a = 0; a < 2; a++) {
				fly.twitch[a] += (fly.twitchTarget[a] - fly.twitch[a]) * (1 - Math.exp(-dt / 0.1));
				fly.antennae[a].rotation.y = fly.twitch[a];
			}
			// body bob and snag struggle
			fly.body.position.y = walking ? Math.abs(Math.sin(fly.walkPhase)) * 0.012 : 0;
			fly.body.rotation.z = bh === 'snagged' ? Math.sin(t * 18) * 0.12 : 0;
			fly.marker.position.set(pose.x, 0, pose.z);
			var s = 1 + Math.min(4, pose.y) * 0.15;
			fly.blob.scale.set(1.3 * s, 0.8 * s, 1);
			fly.blob.rotation.z = pose.heading;
			var zoomFade = clamp(1.6 - camera.zoom / 5, 0.25, 0.9);
			fly.ring.material.opacity = zoomFade;
		}

		/* ---------- overlays ---------- */

		var overlays = { scent: false, danger: true, trail: true, neural: false };

		// Scent: odor field sampled on a grid, drawn as a translucent ground layer.
		var scentW = 120, scentH = 90;
		var scentData = new Uint8Array(scentW * scentH * 4);
		var scentTex = track(new THREE.DataTexture(scentData, scentW, scentH, THREE.RGBAFormat));
		scentTex.magFilter = THREE.LinearFilter;
		scentTex.minFilter = THREE.LinearFilter;
		var scentMesh = new THREE.Mesh(track(new THREE.PlaneGeometry(b.xMax - b.xMin, b.zMax - b.zMin)),
			track(new THREE.MeshBasicMaterial({ map: scentTex, transparent: true, depthWrite: false })));
		scentMesh.rotation.x = -Math.PI / 2;
		scentMesh.position.set(cx, 0.08, cz);
		scentMesh.visible = false;
		scene.add(scentMesh);
		var scentTimer = 0;
		function updateScent(state) {
			var wind = root.WorldSenses.windAt(state);
			var sx = (b.xMax - b.xMin) / scentW, sz = (b.zMax - b.zMin) / scentH;
			for (var j = 0; j < scentH; j++) {
				for (var i = 0; i < scentW; i++) {
					var c = root.WorldSenses.odorAt(state, cfg, b.xMin + (i + 0.5) * sx, 0.3, b.zMin + (scentH - 1 - j + 0.5) * sz, wind);
					var a = clamp(Math.log(1 + c * 2) / Math.log(1 + 12), 0, 1);
					var k = (j * scentW + i) * 4;
					scentData[k] = 255; scentData[k + 1] = Math.round(150 + 80 * a); scentData[k + 2] = 40;
					scentData[k + 3] = Math.round(a * 150);
				}
			}
			scentTex.needsUpdate = true;
		}

		// Danger: a translucent wedge from the eye to each web the fly senses.
		var dangerGroup = new THREE.Group();
		scene.add(dangerGroup);
		var dangerMat = track(new THREE.MeshBasicMaterial({ color: 0xff4b3a, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }));
		var dangerMeshes = {};
		function updateDanger(state, info) {
			var seen = {};
			var webs = info && info.senses ? info.senses.threat.webs : [];
			for (var i = 0; i < webs.length; i++) {
				var w = webs[i];
				var web = WS.findById(state.webs, w.id);
				if (!web || w.intensity < 0.02) continue;
				seen[w.id] = true;
				var m = dangerMeshes[w.id];
				if (!m) {
					var g = new THREE.BufferGeometry();
					g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
					m = dangerMeshes[w.id] = new THREE.Mesh(g, dangerMat.clone());
					dangerGroup.add(m);
				}
				var f = WS.webFrame(web);
				var fwd = WS.forward(state.fly.heading);
				var p = m.geometry.attributes.position.array;
				p[0] = state.fly.x + fwd.x * 0.5; p[1] = state.fly.y + 0.35; p[2] = state.fly.z + fwd.z * 0.5;
				p[3] = f.cx + f.ux * web.radius; p[4] = f.cy; p[5] = f.cz + f.uz * web.radius;
				p[6] = f.cx - f.ux * web.radius; p[7] = f.cy; p[8] = f.cz - f.uz * web.radius;
				m.geometry.attributes.position.needsUpdate = true;
				m.geometry.computeBoundingSphere();
				m.material.opacity = clamp(w.intensity * 0.5, 0.05, 0.5);
			}
			for (var id in dangerMeshes) {
				if (!seen[id]) { dangerGroup.remove(dangerMeshes[id]); dangerMeshes[id].geometry.dispose(); dangerMeshes[id].material.dispose(); delete dangerMeshes[id]; }
			}
		}

		// Trail: recent positions coloured by behavior.
		var TRAIL = cfg.render.trailLength;
		var trailPos = new Float32Array(TRAIL * 3), trailCol = new Float32Array(TRAIL * 3);
		var trailGeo = track(new THREE.BufferGeometry());
		trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
		trailGeo.setAttribute('color', new THREE.BufferAttribute(trailCol, 3));
		trailGeo.setDrawRange(0, 0);
		var trailLine = new THREE.Line(trailGeo, track(new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75 })));
		trailLine.frustumCulled = false;
		scene.add(trailLine);
		var trail = [];
		function updateTrail(state) {
			var f = state.fly;
			var last = trail[trail.length - 1];
			if (!last || Math.hypot(last.x - f.x, last.z - f.z) > 0.25 || Math.abs(last.y - f.y) > 0.25) {
				trail.push({ x: f.x, y: f.y + 0.06, z: f.z, b: state.behavior.current });
				if (trail.length > TRAIL) trail.shift();
			}
			for (var i = 0; i < trail.length; i++) {
				var p = trail[i], c = BEHAVIOR_COLORS[p.b] || BEHAVIOR_COLORS.idle;
				var fade = 0.35 + 0.65 * (i / trail.length);
				trailPos[i * 3] = p.x; trailPos[i * 3 + 1] = p.y; trailPos[i * 3 + 2] = p.z;
				trailCol[i * 3] = c[0] * fade; trailCol[i * 3 + 1] = c[1] * fade; trailCol[i * 3 + 2] = c[2] * fade;
			}
			trailGeo.setDrawRange(0, trail.length);
			trailGeo.attributes.position.needsUpdate = true;
			trailGeo.attributes.color.needsUpdate = true;
		}

		// Neural: odor response ring and left/right threat arcs around the fly.
		var neural = new THREE.Group();
		var odorRing = new THREE.Mesh(track(new THREE.RingGeometry(1.4, 1.6, 40)), track(new THREE.MeshBasicMaterial({ color: 0xffb432, transparent: true, depthWrite: false })));
		var arcL = new THREE.Mesh(track(new THREE.RingGeometry(1.75, 2.05, 24, 1, Math.PI * 0.1, Math.PI * 0.8)), track(new THREE.MeshBasicMaterial({ color: 0xff4436, transparent: true, depthWrite: false, side: THREE.DoubleSide })));
		var arcR = new THREE.Mesh(track(new THREE.RingGeometry(1.75, 2.05, 24, 1, Math.PI * 1.1, Math.PI * 0.8)), track(new THREE.MeshBasicMaterial({ color: 0xff4436, transparent: true, depthWrite: false, side: THREE.DoubleSide })));
		[odorRing, arcL, arcR].forEach(function (m) { m.rotation.x = -Math.PI / 2; neural.add(m); });
		neural.visible = false;
		scene.add(neural);
		function updateNeural(pose, info) {
			var m = info && info.motor;
			neural.position.set(pose.x, 0.1, pose.z);
			neural.rotation.y = pose.heading;
			odorRing.material.opacity = m ? clamp(m.odorResponse, 0, 1) * 0.8 : 0;
			arcL.material.opacity = m ? clamp(m.threatL * 0.6, 0, 0.9) : 0;
			arcR.material.opacity = m ? clamp(m.threatR * 0.6, 0, 0.9) : 0;
		}

		/* ---------- selection ---------- */

		var selRing = new THREE.Mesh(track(new THREE.RingGeometry(1, 1.15, 40)), track(new THREE.MeshBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide })));
		selRing.visible = false;
		scene.add(selRing);
		var selection = null;
		function updateSelection(state) {
			if (!selection) { selRing.visible = false; return; }
			var obj = selection.type === 'fruit' ? WS.findById(state.fruits, selection.id) :
				selection.type === 'web' ? WS.findById(state.webs, selection.id) : null;
			if (!obj) { selRing.visible = false; return; }
			selRing.visible = true;
			if (selection.type === 'fruit') {
				selRing.position.set(obj.x, obj.stage === 'attached' ? obj.y : 0.06, obj.z);
				selRing.rotation.set(-Math.PI / 2, 0, 0);
				selRing.scale.setScalar(obj.radius * 1.5);
			} else {
				var f = WS.webFrame(obj);
				selRing.position.set(f.cx, f.cy, f.cz);
				selRing.lookAt(f.cx + f.nx, f.cy, f.cz + f.nz);
				selRing.scale.setScalar(obj.radius * 1.05);
			}
		}

		/* ---------- wall fading and light level ---------- */

		var camDir = new THREE.Vector3();
		function updateWalls() {
			camDir.copy(camera.position).sub(controls.target);
			camDir.y = 0;
			camDir.normalize();
			for (var i = 0; i < walls.length; i++) {
				var w = walls[i];
				var facing = w.userData.outward.dot(camDir);
				var target = facing > 0.25 ? 0.14 : 1;
				w.material.opacity += (target - w.material.opacity) * 0.15;
				w.material.depthWrite = w.material.opacity > 0.9;
				w.castShadow = w.material.opacity > 0.9;
			}
			// thin canopies when zoomed in so the fly stays visible below
			var canopyOpacity = camera.zoom > 3 ? 0.35 : 1;
			for (var c = 0; c < canopyMeshes.length; c++) {
				var mat = canopyMeshes[c].material;
				if (mat.opacity !== canopyOpacity) { mat.transparent = canopyOpacity < 1; mat.opacity = canopyOpacity; }
			}
		}

		var lastLight = -1;
		function updateLight(level) {
			if (level === lastLight) return;
			lastLight = level;
			var dayness = clamp(level, 0, 1);
			sun.intensity = 0.15 + 0.85 * dayness;
			hemi.intensity = 0.18 + 0.4 * dayness;
			hemi.color.setRGB(0.55 + 0.36 * dayness, 0.6 + 0.35 * dayness, 0.85 + 0.15 * dayness);
			renderer.setClearColor(new THREE.Color(0.08 + 0.1 * dayness, 0.08 + 0.1 * dayness, 0.1 + 0.06 * dayness));
		}

		/* ---------- frame ---------- */

		var lastT = null;
		var suspended = false;
		var api = { kind: 'webgl' };

		api.sync = function (state, pose, info) {
			var now = performance.now() / 1000;
			var dt = lastT === null ? 0.016 : Math.min(0.1, now - lastT);
			lastT = now;
			syncFruit(state);
			syncWebs(state, now);
			animateFly(state, pose, dt, now);
			if (overlays.trail) updateTrail(state);
			trailLine.visible = overlays.trail;
			dangerGroup.visible = overlays.danger;
			if (overlays.danger) updateDanger(state, info);
			neural.visible = overlays.neural;
			if (overlays.neural) updateNeural(pose, info);
			scentMesh.visible = overlays.scent;
			if (overlays.scent) {
				scentTimer -= dt;
				if (scentTimer <= 0) { scentTimer = 0.5; updateScent(state); }
			}
			updateSelection(state);
			updateLight(state.env.lightLevel);
			if (follow) {
				var tgt = new THREE.Vector3(pose.x, 0, pose.z);
				var delta = tgt.sub(controls.target).multiplyScalar(1 - Math.exp(-dt / 0.25));
				controls.target.add(delta);
				camera.position.add(delta);
			}
		};

		api.render = function () {
			if (suspended) return;
			controls.update();
			updateWalls();
			renderer.render(scene, camera);
		};

		/* ---------- picking and projections ---------- */

		var raycaster = new THREE.Raycaster();
		var ndc = new THREE.Vector2();
		function setNdc(clientX, clientY) {
			var r = canvas.getBoundingClientRect();
			ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
			raycaster.setFromCamera(ndc, camera);
		}

		api.screenToGround = function (clientX, clientY) {
			setNdc(clientX, clientY);
			var ray = raycaster.ray;
			if (Math.abs(ray.direction.y) < 1e-6) return null;
			var t = -ray.origin.y / ray.direction.y;
			if (t < 0) return null;
			var x = ray.origin.x + ray.direction.x * t, z = ray.origin.z + ray.direction.z * t;
			if (x < b.xMin || x > b.xMax || z < b.zMin || z > b.zMax) return null;
			return { x: x, z: z };
		};

		api.pick = function (clientX, clientY) {
			setNdc(clientX, clientY);
			var targets = [fly.root];
			for (var id in fruitMeshes) targets.push(fruitMeshes[id]);
			for (var wid in webObjs) targets.push(webObjs[wid].disk);
			var hits = raycaster.intersectObjects(targets, true);
			for (var i = 0; i < hits.length; i++) {
				var o = hits[i].object;
				while (o && !o.userData.pick) o = o.parent;
				if (o) {
					var g = api.screenToGround(clientX, clientY);
					return { type: o.userData.pick.type, id: o.userData.pick.id, x: g ? g.x : hits[i].point.x, z: g ? g.z : hits[i].point.z };
				}
			}
			var gp = api.screenToGround(clientX, clientY);
			return gp ? { type: 'ground', x: gp.x, z: gp.z } : null;
		};

		var proj = new THREE.Vector3();
		api.worldToScreen = function (x, y, z) {
			proj.set(x, y, z).project(camera);
			var r = canvas.getBoundingClientRect();
			return { x: r.left + (proj.x + 1) / 2 * r.width, y: r.top + (1 - proj.y) / 2 * r.height, visible: proj.z < 1 && proj.z > -1 };
		};

		/* ---------- camera API ---------- */

		api.setFollow = function (on) {
			follow = !!on;
			if (follow && camera.zoom < 4) { camera.zoom = 4.5; camera.updateProjectionMatrix(); }
		};
		api.isFollowing = function () { return follow; };
		api.resetCamera = function () { follow = false; resetCamera(); };
		api.zoomBy = function (f) {
			camera.zoom = clamp(camera.zoom * f, controls.minZoom, controls.maxZoom);
			camera.updateProjectionMatrix();
		};
		api.setOverlay = function (name, on) { overlays[name] = !!on; };
		api.overlays = function () { return overlays; };
		api.select = function (sel) { selection = sel; };
		api.clearTrail = function () { trail = []; };
		api.controls = controls;
		api.camera = camera;

		// Screen insets (px) covered by the toolbar and bottom panel; the
		// overview is fitted to the band between them.
		var insets = { top: 0, bottom: 0 };
		api.setInsets = function (top, bottom) { insets.top = top || 0; insets.bottom = bottom || 0; api.resize(); };

		api.resize = function () {
			var w = canvas.clientWidth || root.innerWidth, h = canvas.clientHeight || root.innerHeight;
			renderer.setSize(w, h, false);
			var bandH = Math.max(120, h - insets.top - insets.bottom);
			// world units needed to show the whole enclosure obliquely
			var needW = (b.xMax - b.xMin) + 14, needH = 96;
			var unitsPerPx = Math.max(needW / w, needH / bandH);
			camera.left = -w * unitsPerPx / 2; camera.right = w * unitsPerPx / 2;
			camera.top = h * unitsPerPx / 2; camera.bottom = -h * unitsPerPx / 2;
			// shift in pixels (zoom-independent) so the look-at point sits in
			// the middle of the visible band
			camera.setViewOffset(w, h, 0, (insets.bottom - insets.top) / 2, w, h);
			camera.updateProjectionMatrix();
		};

		api.suspend = function (on) { suspended = !!on; };
		api.setPanEnabled = function (on) { controls.enabled = !!on; };
		// Reduce visual quality before touching simulation dynamics.
		api.setQuality = function (level) {
			var lite = level === 'lite';
			renderer.setPixelRatio(lite ? 1 : Math.min(root.devicePixelRatio || 1, cfg.render.maxPixelRatio));
			sun.castShadow = !lite;
			api.resize();
		};

		api.dispose = function () {
			controls.dispose();
			for (var id in fruitMeshes) scene.remove(fruitMeshes[id]);
			for (var wid in webObjs) { webObjs[wid].geo.dispose(); webObjs[wid].ageo.dispose(); webObjs[wid].disk.geometry.dispose(); }
			for (var did in dangerMeshes) { dangerMeshes[did].geometry.dispose(); dangerMeshes[did].material.dispose(); }
			disposables.forEach(function (d) { if (d && d.dispose) d.dispose(); });
			renderer.dispose();
			if (renderer.forceContextLoss) renderer.forceContextLoss();
		};

		api.onContextLost = function (lost, restored) {
			canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); lost(); }, false);
			canvas.addEventListener('webglcontextrestored', function () { restored(); }, false);
		};

		api.stats = function () { return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures }; };

		resetCamera();
		api.resize();
		return api;
	}

	root.WorldRenderer = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
