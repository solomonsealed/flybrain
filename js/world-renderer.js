/* world-renderer.js -- WebGL garden (Three.js r128): scene, meshes, fly
 * animation, cameras, overlays, the brain inside the fly, and picking.
 *
 * Draws the shared world state; it never changes it. Camera pan, zoom,
 * orbit, resize, follow or a change of view only move a camera, so they
 * cannot affect the simulation. Cosmetic randomness (leaf placement, strand
 * wobble phases) uses its own generator seeded from state.cosmeticSeed.
 *
 * Views: 'garden' (orthographic overview, OrbitControls), 'closeup' (a
 * perspective camera orbiting the fly) and 'eyes' (first person, from the
 * fly's head, with a live brain inset). In the close views, drag orbits or
 * looks around and the wheel or a pinch zooms.
 *
 * X-ray: the fly's body is drawn as glass, with every connectome neuron at
 * its FlyWire position inside the head, lit when it fires. Positions and
 * spikes are display-only.
 *
 * API (shared with world-renderer-2d.js):
 *   create(canvas, config, state) -> renderer | throws if WebGL unavailable
 *   renderer.sync(state, pose, info)   update dynamic objects for this frame;
 *                                      info.fire: the latest worker fire state
 *   renderer.render()
 *   renderer.pick(clientX, clientY)    -> {type, id, x, z} | null
 *   renderer.screenToGround(cx, cy)    -> {x, z} | null
 *   renderer.worldToScreen(x, y, z)    -> {x, y, visible}
 *   renderer.setFollow(on), resetCamera(), zoomBy(f), setOverlay(name, on),
 *   renderer.select(obj), resize(), suspend(on), dispose(), kind
 * WebGL only:
 *   renderer.setViewMode('garden' | 'closeup' | 'eyes'), viewMode()
 *   renderer.setBrain({positions, sortedToOriginal, regionType} | null)
 *   renderer.setXray(on), xray(), wantsFireState(), brainInfo(), pipRect()
 */
(function (root) {
	'use strict';

	var WS = root.WorldState;
	var WB = root.WorldBrainAdapter;

	function cosmeticRng(seed) {
		var rng = root.WorldRandom.create(seed);
		return function () { return root.WorldRandom.next(rng); };
	}

	function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

	var BEHAVIOR_COLORS = {
		walk: [0.55, 0.8, 1.0], feed: [1.0, 0.8, 0.25], startle: [1.0, 0.35, 0.3], fly: [0.85, 0.55, 1.0],
		groom: [0.6, 1.0, 0.6], rest: [0.6, 0.6, 0.7], idle: [0.75, 0.75, 0.75], brace: [0.6, 0.9, 0.9], snagged: [1.0, 0.2, 0.6]
	};

	/* ---------- X-ray fly: glass body and the brain inside ---------- */

	// Brain placement in the fly model's frame (faces +x, y up, left = -z).
	// FlyWire's brain is 814 um across the optic lobes; the model's head and
	// eyes are narrower than a real fly's, so it is drawn at ~80% of true
	// scale relative to the 2.5 mm body.
	var BRAIN_CENTER = [0.3, 0.29, 0];
	var BRAIN_WIDTH = 0.26;              // BL across the optic lobes
	var NEURON_SIZE = 0.0032;            // BL, drawn diameter of one neuron
	var SPIKE_TAU = 0.15;                // s (simulation time), glow decay after a spike
	var BRAIN_GLOW = 0.3;                // mean resting brightness over the brain
	var SPIKE_GLOW = 0.45;               // mean brightness budget for firing neurons
	var MIN_POINT_GAIN = 0.006;          // below this, additive 8-bit blending loses a point
	// Region colors match the neuron panel (sensory, central, drives, motor).
	var REGION_RGB = [[84, 150, 255], [168, 118, 255], [255, 178, 50], [255, 90, 90]];

	// Glass: tinted, mostly clear in the middle, bright at grazing angles.
	var GLASS_VS = [
		'varying vec3 vNormal;',
		'varying vec3 vView;',
		'varying vec2 vUv;',
		'void main() {',
		'	vUv = uv;',
		'	vec4 mv = modelViewMatrix * vec4(position, 1.0);',
		'	vNormal = normalize(normalMatrix * normal);',
		'	vView = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(-mv.xyz);',
		'	gl_Position = projectionMatrix * mv;',
		'}'
	].join('\n');
	var GLASS_FS = [
		'uniform vec3 uTint;',
		'uniform vec3 uRim;',
		'uniform float uOpacity;',
		'uniform float uRimStrength;',
		'uniform float uLight;',
		'uniform float uUseMap;',
		'uniform sampler2D uMap;',
		'varying vec3 vNormal;',
		'varying vec3 vView;',
		'varying vec2 vUv;',
		'void main() {',
		'	vec3 n = normalize(vNormal), v = normalize(vView);',
		'	float rim = pow(1.0 - abs(dot(n, v)), 2.2);',
		'	float spec = pow(max(dot(n, normalize(v + vec3(-0.35, 0.8, 0.5))), 0.0), 48.0);',
		'	vec3 tint = mix(uTint, texture2D(uMap, vUv).rgb, uUseMap);',
		'	vec3 color = tint * (0.4 + 0.6 * uLight) + uRim * rim * uRimStrength + vec3(spec * 0.45 * uLight);',
		'	gl_FragColor = vec4(color, clamp(uOpacity + rim * uRimStrength * 0.75 + spec * 0.3, 0.0, 1.0));',
		'}'
	].join('\n');

	// Neurons: soft additive points. aSpike is the simulation time of the
	// neuron's latest spike, so the glow decays in simulated time (and holds
	// still while paused). uBase and the draw range are set per frame from
	// the brain's size on screen, so it reads the same at every zoom.
	var BRAIN_VS = [
		'attribute vec3 aColor;',
		'attribute float aSpike;',
		'uniform float uTime;',
		'uniform float uTau;',
		'uniform float uSize;',
		'uniform float uPx;',
		'uniform float uBase;',
		'uniform float uHot;',
		'varying vec3 vColor;',
		'void main() {',
		'	vec4 mv = modelViewMatrix * vec4(position, 1.0);',
		'	gl_Position = projectionMatrix * mv;',
		'	float age = uTime - aSpike;',
		'	float act = age >= 0.0 ? exp(-age / uTau) : 0.0;',
		'	float px = uSize * projectionMatrix[1][1] * uPx;',
		'	if (!isOrthographic) px /= max(-mv.z, 1e-4);',
		'	gl_PointSize = clamp(px * (1.0 + 0.6 * act), 1.0, 40.0);',
		'	vColor = aColor * uBase + mix(aColor, vec3(1.0, 0.97, 0.9), 0.55) * (uHot * act);',
		'}'
	].join('\n');
	var BRAIN_FS = [
		'varying vec3 vColor;',
		'void main() {',
		'	vec2 d = gl_PointCoord - 0.5;',
		'	float r2 = dot(d, d) * 4.0;',
		'	if (r2 > 1.0) discard;',
		'	gl_FragColor = vec4(vColor * (1.0 - r2), 1.0);',
		'}'
	].join('\n');

	// Sky dome for the perspective views (the overview looks down and never
	// sees it).
	var SKY_VS = [
		'varying vec3 vDir;',
		'void main() {',
		'	vDir = normalize(position);',
		'	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
		'}'
	].join('\n');
	var SKY_FS = [
		'uniform vec3 uZenith;',
		'uniform vec3 uHorizon;',
		'varying vec3 vDir;',
		'void main() {',
		'	float h = clamp(vDir.y, 0.0, 1.0);',
		'	gl_FragColor = vec4(mix(uHorizon, uZenith, pow(h, 0.6)), 1.0);',
		'}'
	].join('\n');

	function normAngle(a) {
		a = (a + Math.PI) % (2 * Math.PI);
		if (a < 0) a += 2 * Math.PI;
		return a - Math.PI;
	}

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

		// Close views share one perspective camera. Close-up orbits the fly:
		// yaw is measured in the fly's frame (0 = behind it, positive = toward
		// its left), so the camera swings round lazily as the fly turns. The
		// eyes view sits in front of the head; yaw/pitch there are a look
		// offset from the heading that relaxes back after a drag.
		var persp = new THREE.PerspectiveCamera(45, 1, 0.02, 1000);
		var viewMode = 'garden';
		var panEnabled = true;
		var CLOSE_HOME = { yaw: 0.7, pitch: 0.34, dist: 1.3 };
		var close = { yaw: CLOSE_HOME.yaw, pitch: CLOSE_HOME.pitch, dist: CLOSE_HOME.dist, heading: null };
		var eyes = { yaw: 0, pitch: 0, hfov: 110, heading: null, heading1: null };
		function activeCamera() { return viewMode === 'garden' ? camera : persp; }

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

		var skyMat = track(new THREE.ShaderMaterial({
			uniforms: { uZenith: { value: new THREE.Color(0x6f9ccc) }, uHorizon: { value: new THREE.Color(0xc9d4cf) } },
			vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false
		}));
		var sky = new THREE.Mesh(track(new THREE.SphereGeometry(450, 32, 16)), skyMat);
		sky.position.set(cx, 0, cz);
		sky.renderOrder = -10;
		sky.visible = false;
		scene.add(sky);

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
			// per-tree material so one canopy can thin without the others
			var inst = new THREE.InstancedMesh(leafGeo, track(leafMat.clone()), n);
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
			inst.userData.tree = t;
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

		var whiteTex = track(new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat));
		whiteTex.needsUpdate = true;
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
			var sph = track(new THREE.SphereGeometry(1, 24, 18));
			var abdGeo = track(new THREE.SphereGeometry(1, 20, 16));
			abdGeo.rotateZ(Math.PI / 2);
			var glass = {
				thorax: glassMaterial({ tint: 0x9a7420, rim: 0xffd690, opacity: 0.1, rimStrength: 0.55 }),
				head: glassMaterial({ tint: 0x9a7420, rim: 0xffe3ae, opacity: 0.04, rimStrength: 0.5 }),
				abdomen: glassMaterial({ map: stripeTex, rim: 0xffcf7a, opacity: 0.13, rimStrength: 0.5 }),
				eye: glassMaterial({ tint: 0xc0141e, rim: 0xff6a58, opacity: 0.1, rimStrength: 0.6 })
			};
			// Smoked lining: the far inside wall of the head and eyes, drawn
			// before the brain, so the additive glow has a dark backdrop even
			// over sunlit sand.
			var lining = track(new THREE.MeshBasicMaterial({ color: 0x05070d, transparent: true, opacity: 0.7, side: THREE.BackSide, depthWrite: false }));
			var shells = [];   // body parts that turn to glass in X-ray
			function shell(mesh, opaque, glassMat) { shells.push({ mesh: mesh, opaque: opaque, glass: glassMat }); return mesh; }
			var linings = [];
			function lined(src) {
				var m = new THREE.Mesh(src.geometry, lining);
				m.position.copy(src.position);
				m.scale.copy(src.scale).multiplyScalar(0.97);
				m.renderOrder = 4;
				body.add(m);
				linings.push(m);
			}

			var thorax = shell(new THREE.Mesh(sph, mThorax), mThorax, glass.thorax);
			thorax.scale.set(0.17, 0.13, 0.13);
			thorax.position.set(0.08, 0.26, 0);
			body.add(thorax);
			var abdomen = shell(new THREE.Mesh(abdGeo, mAbd), mAbd, glass.abdomen);
			abdomen.scale.set(0.27, 0.14, 0.15);
			abdomen.position.set(-0.24, 0.24, 0);
			body.add(abdomen);
			var head = shell(new THREE.Mesh(sph, mThorax), mThorax, glass.head);
			head.scale.set(0.09, 0.1, 0.12);
			head.position.set(0.3, 0.28, 0);
			body.add(head);
			lined(head);
			var eyes = [];
			[-1, 1].forEach(function (s) {
				var eye = shell(new THREE.Mesh(sph, mEye), mEye, glass.eye);
				eye.scale.set(0.07, 0.08, 0.055);
				eye.position.set(0.31, 0.3, s * 0.085);
				body.add(eye);
				lined(eye);
				eyes.push(eye);
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
				head: head, eyes: eyes, shells: shells, glass: glass, linings: linings, lining: lining, dark: mDark,
				walkPhase: 0, twitchT: 0, twitch: [0, 0], twitchTarget: [0, 0], probExt: 0, spread: 0 };
		}

		function glassMaterial(o) {
			return track(new THREE.ShaderMaterial({
				uniforms: {
					uTint: { value: new THREE.Color(o.tint !== undefined ? o.tint : 0xffffff) },
					uRim: { value: new THREE.Color(o.rim) },
					uOpacity: { value: o.opacity },
					uRimStrength: { value: o.rimStrength },
					uLight: { value: 1 },
					uUseMap: { value: o.map ? 1 : 0 },
					uMap: { value: o.map || whiteTex }
				},
				vertexShader: GLASS_VS, fragmentShader: GLASS_FS, transparent: true, depthWrite: false
			}));
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
			// the eyes view is inside the head; the findability ring is for the overview
			fly.root.visible = viewMode !== 'eyes';
			fly.marker.visible = viewMode !== 'eyes';
			fly.ring.visible = viewMode === 'garden';
		}

		/* ---------- X-ray: glass body and the brain inside ---------- */

		var xray = true;
		var brainMat = track(new THREE.ShaderMaterial({
			uniforms: {
				uTime: { value: 0 }, uTau: { value: SPIKE_TAU }, uSize: { value: NEURON_SIZE },
				uPx: { value: 400 }, uBase: { value: 0.01 }, uHot: { value: 1 }
			},
			vertexShader: BRAIN_VS, fragmentShader: BRAIN_FS,
			transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
		}));
		var brain = null;   // built by setBrain once the connectome and positions load
		var brainFragments = 24e6;   // fill budget per frame (device pixels); lower in lite mode
		var brainWorld = new THREE.Vector3();
		var yAxis = new THREE.Vector3(0, 1, 0);
		function noRaycast() {}

		// The brain inset shown in the eyes view: the same neurons (shared
		// geometry and material) inside a glass head, seen from behind and
		// above so the fly's left is on the left.
		var pip = { scene: new THREE.Scene(), cam: new THREE.PerspectiveCamera(30, 4 / 3, 0.01, 20), rect: null,
			center: new THREE.Vector3(BRAIN_CENTER[0], BRAIN_CENTER[1], BRAIN_CENTER[2]) };
		(function () {
			[fly.head].concat(fly.eyes).forEach(function (src) {
				var m = new THREE.Mesh(src.geometry, src === fly.head ? fly.glass.head : fly.glass.eye);
				m.position.copy(src.position);
				m.scale.copy(src.scale);
				m.renderOrder = 6;
				pip.scene.add(m);
			});
			fly.linings.forEach(function (src) {
				var m = new THREE.Mesh(src.geometry, fly.lining);
				m.position.copy(src.position);
				m.scale.copy(src.scale);
				m.renderOrder = 4;
				pip.scene.add(m);
			});
		})();

		function applyXray() {
			for (var i = 0; i < fly.shells.length; i++) {
				var s = fly.shells[i];
				s.mesh.material = xray ? s.glass : s.opaque;
				s.mesh.renderOrder = xray ? 6 : 0;   // glass after the brain it covers
			}
			// the lining is a backdrop for the brain; the fallback brain has none
			for (var j = 0; j < fly.linings.length; j++) fly.linings[j].visible = xray && !!brain;
			// legs and antennae stay dark but let the brain show through
			fly.dark.transparent = xray;
			fly.dark.opacity = xray ? 0.45 : 1;
			fly.dark.depthWrite = !xray;
			fly.dark.needsUpdate = true;
			if (brain) brain.points.visible = xray;
		}
		applyXray();

		// Places every neuron at its FlyWire position inside the head. data:
		// {positions: parsed neuron_positions (original index order),
		//  sortedToOriginal, regionType (worker order)}. Points are kept in a
		// fixed shuffled order, so any prefix is an even sample of the whole
		// brain; far away only a prefix is drawn.
		// data null removes the brain (the fallback brain has no neurons to show).
		function buildBrain(data) {
			if (brain) {
				fly.body.remove(brain.points);
				pip.scene.remove(brain.pipPoints);
				brain.geo.dispose();
				brain = null;
			}
			if (!data) { applyXray(); return; }
			var P = data.positions, s2o = data.sortedToOriginal, rt = data.regionType;
			var n = P.neuronCount, f = [0, 0, 0];
			var order = new Uint32Array(n), i;
			for (i = 0; i < n; i++) order[i] = i;
			var r = cosmeticRng(0x5eed);   // a fixed layout, independent of the run
			for (i = n - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)), t = order[i]; order[i] = order[j]; order[j] = t; }
			var slotOf = new Uint32Array(n);
			var pos = new Float32Array(n * 3), col = new Uint8Array(n * 3), spike = new Float32Array(n);
			for (var slot = 0; slot < n; slot++) {
				var si = order[slot], o = s2o ? s2o[si] : si;
				slotOf[si] = slot;
				WB.brainFramePosition(P, o, f);
				pos[slot * 3] = BRAIN_CENTER[0] + f[0] * BRAIN_WIDTH;
				pos[slot * 3 + 1] = BRAIN_CENTER[1] + f[1] * BRAIN_WIDTH;
				pos[slot * 3 + 2] = BRAIN_CENTER[2] + f[2] * BRAIN_WIDTH;
				var c = REGION_RGB[rt ? rt[si] : 1] || REGION_RGB[1];
				col[slot * 3] = c[0]; col[slot * 3 + 1] = c[1]; col[slot * 3 + 2] = c[2];
				spike[slot] = -1e9;
			}
			var geo = track(new THREE.BufferGeometry());
			geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
			geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3, true));
			var spikeAttr = new THREE.BufferAttribute(spike, 1);
			spikeAttr.setUsage(THREE.DynamicDrawUsage);
			geo.setAttribute('aSpike', spikeAttr);
			geo.computeBoundingSphere();
			var points = new THREE.Points(geo, brainMat);
			points.renderOrder = 5;
			points.raycast = noRaycast;   // picking the fly uses its body
			fly.body.add(points);
			var pipPoints = new THREE.Points(geo, brainMat);
			pipPoints.renderOrder = 5;
			pipPoints.raycast = noRaycast;
			pip.scene.add(pipPoints);
			brain = { n: n, geo: geo, points: points, pipPoints: pipPoints, slotOf: slotOf, spike: spike, spikeAttr: spikeAttr,
				lastFire: null, lastTime: 0, spikes: 0, spikeRate: 0 };
			applyXray();
		}

		// Stamps the latest step's spikes with the current simulation time.
		function updateBrain(state, info) {
			if (!brain) return;
			if (state.time < brain.lastTime - 1e-6) {
				// a new run or a replay: forget the previous run's spikes
				brain.spike.fill(-1e9);
				brain.spikeAttr.needsUpdate = true;
				brain.lastFire = null;
			}
			brain.lastTime = state.time;
			var fire = info && info.fire;
			if (xray && fire && fire !== brain.lastFire && fire.length === brain.n) {
				brain.lastFire = fire;
				var count = 0;
				for (var i = 0; i < fire.length; i++) {
					if (fire[i]) { brain.spike[brain.slotOf[i]] = state.time; count++; }
				}
				brain.spikes = count;
				// smoothed so the firing gain below does not flicker per step
				brain.spikeRate = brain.spikeRate ? brain.spikeRate + (count - brain.spikeRate) * 0.3 : count;
				brain.spikeAttr.needsUpdate = true;
			}
			brainMat.uniforms.uTime.value = state.time;
		}

		// Level of detail and brightness for the brain's current size on
		// screen: points shrink to a pixel far away, so fewer are drawn and
		// each is brighter, keeping the glow the same at every zoom and every
		// drawn point above the 8-bit blending floor. Firing neurons share a
		// brightness budget, like auto-exposure: a few spikes flash at full
		// brightness, a burst of thousands does not wash the brain out.
		function prepareBrain(cam, viewH, center) {
			var hDev = viewH * renderer.getPixelRatio();
			var ppu;   // device pixels per BL at the brain
			if (cam.isOrthographicCamera) ppu = hDev * cam.zoom / (cam.top - cam.bottom);
			else ppu = hDev / (2 * Math.tan(cam.fov * Math.PI / 360) * Math.max(0.01, center.distanceTo(cam.position)));
			var sPx = Math.max(1, NEURON_SIZE * ppu);
			var area = BRAIN_WIDTH * 0.12 * 0.7 * ppu * ppu;
			var m = Math.min(BRAIN_GLOW * area / (0.39 * MIN_POINT_GAIN * sPx * sPx), brainFragments / (0.8 * sPx * sPx));
			m = Math.round(clamp(m, 400, brain.n));
			brain.geo.setDrawRange(0, m);
			brainMat.uniforms.uPx.value = hDev * 0.5;
			brainMat.uniforms.uBase.value = clamp(BRAIN_GLOW * area / (0.39 * m * sPx * sPx), MIN_POINT_GAIN, 0.35);
			// glowing points: ~2 steps of spikes decaying at once, drawn ~1.6x larger in area
			var lit = Math.max(1, 2 * brain.spikeRate * m / brain.n);
			brainMat.uniforms.uHot.value = clamp(SPIKE_GLOW * area / (0.39 * lit * sPx * sPx * 1.6), 0.08, 1);
		}

		var pipClear = new THREE.Color();
		function renderPip(t) {
			var r = pip.rect, h = canvas.clientHeight || root.innerHeight, w = canvas.clientWidth || root.innerWidth;
			var yGl = h - (r.y + r.h);
			// a slow sway shows depth without losing left and right
			var a = 0.22 * Math.sin(t * 0.3);
			pip.cam.position.set(BRAIN_CENTER[0] - Math.cos(a) * 0.46, BRAIN_CENTER[1] + 0.27, BRAIN_CENTER[2] + Math.sin(a) * 0.46);
			pip.cam.lookAt(BRAIN_CENTER[0] + 0.02, BRAIN_CENTER[1] - 0.01, BRAIN_CENTER[2]);
			pip.cam.aspect = r.w / r.h;
			pip.cam.updateProjectionMatrix();
			renderer.getClearColor(pipClear);
			var alpha = renderer.getClearAlpha();
			var hex = pipClear.getHex();
			renderer.setScissorTest(true);
			renderer.setScissor(r.x, yGl, r.w, r.h);
			renderer.setViewport(r.x, yGl, r.w, r.h);
			renderer.setClearColor(0x0b1224, 1);
			prepareBrain(pip.cam, r.h, pip.center);
			renderer.render(pip.scene, pip.cam);
			renderer.setScissorTest(false);
			renderer.setViewport(0, 0, w, h);
			renderer.setClearColor(hex, alpha);
		}

		/* ---------- close views: orbit and look ---------- */

		function updateCloseCamera(pose, dt) {
			var h = pose.heading;
			if (viewMode === 'closeup') {
				close.heading = close.heading === null ? h : close.heading + normAngle(h - close.heading) * (1 - Math.exp(-dt / 0.6));
				// zooming in moves the aim from the whole body to the brain
				var near = clamp((close.dist - 0.35) / 1.6, 0, 1);
				var lx = BRAIN_CENTER[0] * (1 - near), ly = BRAIN_CENTER[1] + (0.22 - BRAIN_CENTER[1]) * near;
				var tx = pose.x + lx * Math.cos(h), ty = pose.y + ly, tz = pose.z - lx * Math.sin(h);
				var cp = Math.cos(close.pitch);
				var ox = -cp * Math.cos(close.yaw) * close.dist, oy = Math.sin(close.pitch) * close.dist, oz = -cp * Math.sin(close.yaw) * close.dist;
				var c = Math.cos(close.heading), s = Math.sin(close.heading);
				persp.position.set(clamp(tx + ox * c + oz * s, b.xMin + 0.4, b.xMax - 0.4),
					clamp(ty + oy, 0.05, enc.roofHeight - 0.5),
					clamp(tz - ox * s + oz * c, b.zMin + 0.4, b.zMax - 0.4));
				persp.lookAt(tx, ty, tz);
				persp.near = clamp(close.dist * 0.02, 0.004, 0.05);
			} else if (viewMode === 'eyes') {
				// The fly turns at up to ~650 deg/s in escapes (130 deg/s at the
				// 90th percentile of normal walking). Two cascaded 0.12 s filters
				// ease the view into and out of turns instead of snapping.
				if (eyes.heading === null) { eyes.heading = h; eyes.heading1 = h; }
				var ease = 1 - Math.exp(-dt / 0.12);
				eyes.heading1 += normAngle(h - eyes.heading1) * ease;
				eyes.heading += normAngle(eyes.heading1 - eyes.heading) * ease;
				var he = eyes.heading;
				var ex = pose.x + 0.42 * Math.cos(he), ey = pose.y + 0.31, ez = pose.z - 0.42 * Math.sin(he);
				if (!look.drag && performance.now() - look.releasedAt > 1500) {
					var relax = Math.exp(-dt / 0.8);
					eyes.yaw *= relax;
					eyes.pitch *= relax;
				}
				var yaw = he + eyes.yaw, pitch = -0.08 + eyes.pitch, cpp = Math.cos(pitch);
				persp.position.set(ex, ey, ez);
				persp.lookAt(ex + cpp * Math.cos(yaw), ey + Math.sin(pitch), ez - cpp * Math.sin(yaw));
				persp.near = 0.03;
			}
			persp.updateProjectionMatrix();
		}

		// Eyes: vertical FOV from the chosen horizontal FOV, so wide screens
		// see ~110 degrees around the fly (the real eyes cover ~330).
		function applyFov() {
			var w = canvas.clientWidth || root.innerWidth, h = canvas.clientHeight || root.innerHeight;
			persp.fov = viewMode === 'eyes' ? clamp(2 * Math.atan(Math.tan(eyes.hfov * Math.PI / 360) * h / w) * 180 / Math.PI, 40, 100) : 45;
			persp.updateProjectionMatrix();
		}

		// Drag orbits (close-up) or looks around (eyes, grab-the-world like a
		// street panorama); a second finger pinches to zoom. Clicks still reach
		// the tools, which ignore anything that moved.
		var look = { pointers: {}, drag: null, pinch: 0, releasedAt: -1e9 };
		function pinchSpan() {
			var ids = Object.keys(look.pointers);
			if (ids.length < 2) return 0;
			var a = look.pointers[ids[0]], c = look.pointers[ids[1]];
			return Math.hypot(a.x - c.x, a.y - c.y);
		}
		function onLookDown(e) {
			if (viewMode === 'garden') return;
			look.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
			if (Object.keys(look.pointers).length >= 2) { look.drag = null; look.pinch = pinchSpan(); }
			else if (panEnabled) look.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
		}
		function onLookMove(e) {
			var p = look.pointers[e.pointerId];
			if (!p) return;
			p.x = e.clientX; p.y = e.clientY;
			if (viewMode === 'garden' || !panEnabled) return;
			if (look.pinch) {
				var span = pinchSpan();
				if (span > 0) api.zoomBy(span / look.pinch);
				look.pinch = span;
				return;
			}
			var d = look.drag;
			if (!d || d.id !== e.pointerId) return;
			var dx = e.clientX - d.x, dy = e.clientY - d.y;
			d.x = e.clientX; d.y = e.clientY;
			var hpx = canvas.clientHeight || 600;
			if (viewMode === 'closeup') {
				close.yaw = normAngle(close.yaw + dx * 5 / hpx);
				close.pitch = clamp(close.pitch + dy * 5 / hpx, -0.35, 1.45);
			} else {
				var k = persp.fov * Math.PI / 180 / hpx;
				eyes.yaw = clamp(eyes.yaw + dx * k, -2.6, 2.6);
				eyes.pitch = clamp(eyes.pitch + dy * k, -1.1, 1.1);
			}
		}
		function onLookUp(e) {
			if (!look.pointers[e.pointerId]) return;
			delete look.pointers[e.pointerId];
			if (look.drag && look.drag.id === e.pointerId) { look.drag = null; look.releasedAt = performance.now(); }
			if (Object.keys(look.pointers).length < 2) look.pinch = 0;
		}
		function onLookWheel(e) {
			if (viewMode === 'garden') return;
			e.preventDefault();
			api.zoomBy(Math.exp(-e.deltaY * 0.0015));
		}
		function onContextMenu(e) { if (viewMode !== 'garden') e.preventDefault(); }
		canvas.addEventListener('pointerdown', onLookDown);
		root.addEventListener('pointermove', onLookMove);
		root.addEventListener('pointerup', onLookUp);
		root.addEventListener('pointercancel', onLookUp);
		canvas.addEventListener('wheel', onLookWheel, { passive: false });
		canvas.addEventListener('contextmenu', onContextMenu);

		/* ---------- overlays ---------- */

		var overlays = { scent: false, danger: true, trail: true, neural: false };

		// Scent: odor field sampled on a grid, drawn as a translucent ground layer.
		var scentW = 120, scentH = 90;
		var scentData = new Uint8Array(scentW * scentH * 4);
		var scentTex = track(new THREE.DataTexture(scentData, scentW, scentH, THREE.RGBAFormat));
		scentTex.magFilter = THREE.LinearFilter;
		scentTex.minFilter = THREE.LinearFilter;
		// polygon offset keeps the layer above the ground in the close views,
		// whose near plane is small
		var scentMesh = new THREE.Mesh(track(new THREE.PlaneGeometry(b.xMax - b.xMin, b.zMax - b.zMin)),
			track(new THREE.MeshBasicMaterial({ map: scentTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })));
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
			// the overview fades walls between camera and garden; the close
			// views are inside the garden, where every wall stands
			var overview = viewMode === 'garden';
			if (overview) {
				camDir.copy(camera.position).sub(controls.target);
				camDir.y = 0;
				camDir.normalize();
			}
			for (var i = 0; i < walls.length; i++) {
				var w = walls[i];
				var target = overview && w.userData.outward.dot(camDir) > 0.25 ? 0.14 : 1;
				w.material.opacity += (target - w.material.opacity) * 0.15;
				w.material.depthWrite = w.material.opacity > 0.9;
				w.castShadow = w.material.opacity > 0.9;
			}
			// thin canopies when zoomed in so the fly stays visible below, or
			// when the close-up camera rises into one
			var p = persp.position;
			for (var c = 0; c < canopyMeshes.length; c++) {
				var t = canopyMeshes[c].userData.tree;
				var thin = overview ? camera.zoom > 3 :
					viewMode === 'closeup' && Math.hypot(p.x - t.x, p.z - t.z) < t.canopyRadius * 1.1 && p.y > t.canopyY - t.canopyRadius * 0.6;
				var canopyOpacity = thin ? 0.35 : 1;
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
			skyMat.uniforms.uZenith.value.setRGB(0.04 + 0.4 * dayness, 0.05 + 0.56 * dayness, 0.09 + 0.71 * dayness);
			skyMat.uniforms.uHorizon.value.setRGB(0.1 + 0.69 * dayness, 0.11 + 0.72 * dayness, 0.13 + 0.68 * dayness);
			for (var k in fly.glass) fly.glass[k].uniforms.uLight.value = dayness;
			applyFog();
		}

		function applyFog() {
			if (viewMode === 'garden') {
				scene.fog.color.setHex(0x3a3a30);
				scene.fog.near = 180;
				scene.fog.far = 320;
			} else {
				// haze toward the horizon gives the fly-scale garden depth
				scene.fog.color.copy(skyMat.uniforms.uHorizon.value);
				scene.fog.near = 45;
				scene.fog.far = 280;
			}
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
			brainWorld.set(BRAIN_CENTER[0], BRAIN_CENTER[1], BRAIN_CENTER[2]).applyAxisAngle(yAxis, pose.heading).add(fly.root.position);
			updateBrain(state, info);
			if (overlays.trail) updateTrail(state);
			trailLine.visible = overlays.trail;
			// in the eyes view the wedge would start at the camera
			dangerGroup.visible = overlays.danger && viewMode !== 'eyes';
			if (dangerGroup.visible) updateDanger(state, info);
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
			if (viewMode !== 'garden') updateCloseCamera(pose, dt);
		};

		// Draw calls and triangles of the last frame's garden pass plus the
		// brain inset (three.js counts each render call on its own).
		var frameInfo = { calls: 0, triangles: 0 };
		api.render = function () {
			if (suspended) return;
			var cam = activeCamera();
			if (viewMode === 'garden') controls.update();
			updateWalls();
			if (brain && xray && viewMode !== 'eyes') prepareBrain(cam, canvas.clientHeight || root.innerHeight, brainWorld);
			renderer.render(scene, cam);
			frameInfo.calls = renderer.info.render.calls;
			frameInfo.triangles = renderer.info.render.triangles;
			if (viewMode === 'eyes' && brain && xray && pip.rect) {
				renderPip(performance.now() / 1000);
				frameInfo.calls += renderer.info.render.calls;
				frameInfo.triangles += renderer.info.render.triangles;
			}
		};

		/* ---------- picking and projections ---------- */

		var raycaster = new THREE.Raycaster();
		var ndc = new THREE.Vector2();
		function setNdc(clientX, clientY) {
			var r = canvas.getBoundingClientRect();
			ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
			raycaster.setFromCamera(ndc, activeCamera());
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
			// in the eyes view the (hidden) fly surrounds the camera
			var targets = viewMode === 'eyes' ? [] : [fly.root];
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
			proj.set(x, y, z).project(activeCamera());
			var r = canvas.getBoundingClientRect();
			return { x: r.left + (proj.x + 1) / 2 * r.width, y: r.top + (1 - proj.y) / 2 * r.height, visible: proj.z < 1 && proj.z > -1 };
		};

		/* ---------- camera API ---------- */

		// Following is an overview behavior; asking for it leaves a close view.
		api.setFollow = function (on) {
			follow = !!on;
			if (follow && viewMode !== 'garden') api.setViewMode('garden');
			if (follow && camera.zoom < 4) { camera.zoom = 4.5; camera.updateProjectionMatrix(); }
		};
		api.isFollowing = function () { return follow; };
		api.resetCamera = function () {
			follow = false;
			close.yaw = CLOSE_HOME.yaw; close.pitch = CLOSE_HOME.pitch; close.dist = CLOSE_HOME.dist;
			eyes.hfov = 110;
			api.setViewMode('garden');
			resetCamera();
		};
		// Overview: orthographic zoom. Close-up: distance to the fly. Eyes:
		// field of view.
		api.zoomBy = function (f) {
			if (viewMode === 'closeup') { close.dist = clamp(close.dist / f, 0.22, 14); return; }
			if (viewMode === 'eyes') { eyes.hfov = clamp(eyes.hfov / f, 50, 140); applyFov(); return; }
			camera.zoom = clamp(camera.zoom * f, controls.minZoom, controls.maxZoom);
			camera.updateProjectionMatrix();
		};
		api.setViewMode = function (mode) {
			if (mode !== 'closeup' && mode !== 'eyes') mode = 'garden';
			if (mode === viewMode) return;
			viewMode = mode;
			controls.enabled = panEnabled && mode === 'garden';
			close.heading = null;
			eyes.heading = null;
			eyes.yaw = 0;
			eyes.pitch = 0;
			look.drag = null;
			look.pinch = 0;
			sky.visible = mode !== 'garden';
			applyFog();
			api.resize();
		};
		api.viewMode = function () { return viewMode; };
		api.setOverlay = function (name, on) { overlays[name] = !!on; };
		api.overlays = function () { return overlays; };
		api.select = function (sel) { selection = sel; };
		api.clearTrail = function () { trail = []; };
		api.controls = controls;
		api.camera = camera;
		api.activeCamera = activeCamera;

		api.setBrain = buildBrain;
		api.setXray = function (on) { xray = !!on; applyXray(); };
		api.xray = function () { return xray; };
		// Spikes are display-only: requesting them never changes the worker's
		// dynamics, only what its step result carries.
		api.wantsFireState = function () { return xray && !!brain; };
		api.brainInfo = function () {
			return brain ? { neurons: brain.n, drawn: brain.geo.drawRange.count, spikes: brain.spikes, visible: xray } : null;
		};
		// The eyes view's brain inset, in CSS pixels from the canvas top-left.
		api.pipRect = function () { return viewMode === 'eyes' && brain && xray ? pip.rect : null; };

		// Screen insets (px) covered by the toolbar and bottom panel; the
		// overview is fitted to the band between them. pipBottom: space to
		// keep clear under the brain inset (defaults to the bottom inset).
		var insets = { top: 0, bottom: 0, pip: 0 };
		api.setInsets = function (top, bottom, pipBottom) {
			insets.top = top || 0;
			insets.bottom = bottom || 0;
			insets.pip = Math.max(insets.bottom, pipBottom || 0);
			api.resize();
		};

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
			persp.aspect = w / h;
			persp.setViewOffset(w, h, 0, (insets.bottom - insets.top) / 2, w, h);
			applyFov();
			// brain inset: bottom-left of the visible band, clear of the
			// right-hand controls
			var pw = Math.round(clamp(w * 0.24, 150, 300)), ph = Math.round(pw * 0.72);
			pip.rect = { x: 12, y: Math.max(insets.top + 8, Math.round(h - insets.pip - 12 - ph)), w: pw, h: ph };
		};

		api.suspend = function (on) { suspended = !!on; };
		api.setPanEnabled = function (on) {
			panEnabled = !!on;
			controls.enabled = panEnabled && viewMode === 'garden';
			if (!panEnabled) look.drag = null;
		};
		// Reduce visual quality before touching simulation dynamics.
		api.setQuality = function (level) {
			var lite = level === 'lite';
			renderer.setPixelRatio(lite ? 1 : Math.min(root.devicePixelRatio || 1, cfg.render.maxPixelRatio));
			sun.castShadow = !lite;
			brainFragments = lite ? 3e6 : 24e6;
			api.resize();
		};

		api.dispose = function () {
			controls.dispose();
			canvas.removeEventListener('pointerdown', onLookDown);
			root.removeEventListener('pointermove', onLookMove);
			root.removeEventListener('pointerup', onLookUp);
			root.removeEventListener('pointercancel', onLookUp);
			canvas.removeEventListener('wheel', onLookWheel);
			canvas.removeEventListener('contextmenu', onContextMenu);
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

		api.stats = function () { return { calls: frameInfo.calls, triangles: frameInfo.triangles, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures }; };

		resetCamera();
		api.resize();
		return api;
	}

	root.WorldRenderer = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
