/* world-config.js -- Garden layout, units, and tunable simulation parameters.
 *
 * Units: body lengths (BL) and seconds. One BL is the fly's body length
 * (~2.5 mm in a real Drosophila); the garden's trees are deliberately
 * compressed so the fly and its habitat stay legible together.
 *
 * Axes (single convention for every world module):
 *   x: west (0) -> east (120)        ground plane
 *   z: north (0) -> south (90)       ground plane; the viewer looks from the south
 *   y: altitude above the ground     (0 = walking on the ground)
 *   heading h: rotation about +y. forward = (cos h, 0, -sin h),
 *              left = (-sin h, 0, -cos h). Positive yaw rate turns left
 *              (counter-clockwise seen from above). Three.js rotation.y = h
 *              for a model built facing +x.
 *
 * Named areas (`areas`) are viewer descriptions only. No module that decides
 * what the fly does may read them; the fly only receives local sensory
 * samples and contacts.
 *
 * Everything here is data. Change parameters here rather than in code.
 */
(function (root) {
	'use strict';

	var WorldConfig = {
		version: 'garden-v1',
		coordinateVersion: 'world-bl-v1',

		units: { length: 'body_length', time: 'second', bodyLengthMm: 2.5 },

		bounds: { xMin: 0, xMax: 120, zMin: 0, zMax: 90 },

		enclosure: {
			wallHeight: 30,
			wallThickness: 2.5,
			cornerRadius: 6,
			roofHeight: 32,
			maxFlightAltitude: 22
		},

		// Viewer-facing descriptions of the authored areas (never read by the fly).
		areas: [
			{ id: 'safe-orchard', name: 'Safe orchard', x: 24, z: 26, description: 'Fig tree with fallen fruit and a clear approach.' },
			{ id: 'risky-orchard', name: 'Risky orchard', x: 88, z: 26, description: 'Fragrant apple patch beside a web strung between low branches.' },
			{ id: 'trellis', name: 'Trellis corner', x: 96, z: 70, description: 'A second web, turned sideways and partly hidden by vine leaves.' },
			{ id: 'clearing', name: 'Sunny clearing', x: 60, z: 48, description: 'Open ground, a soft breeze, and bright light. The fly starts here.' },
			{ id: 'shelter', name: 'Leaf shelter', x: 22, z: 72, description: 'Shade and leaf litter for resting.' }
		],

		fly: {
			start: { x: 60, z: 48, heading: Math.PI * 0.5 },
			bodyLength: 1.0,
			collisionRadius: 0.45,
			headOffset: 0.5,            // head centre ahead of the body centre
			eyeHeight: 0.3,             // eye height when standing on the ground
			antennaSeparation: 0.25,    // half-distance between odor samples (exaggerated ~3x, see docs)
			antennaForward: 0.6,
			biteRange: 0.35,            // head-to-fruit-surface distance allowing taste and intake
			wallClearance: 0.15
		},

		body: {
			walkSpeed: 3.2,             // BL/s at full forward drive
			surgeSpeed: 4.5,
			escapeRunSpeed: 8.0,
			flightSpeed: 10.0,
			maxEscapeSpeed: 20.0,       // hard cap used by containment tests
			maxYawRate: 7.0,            // rad/s walking
			maxYawRateEscape: 12.0,
			accel: 18.0,
			decel: 30.0,
			yawTau: 0.08,
			climbRate: 6.0,
			cruiseAltitude: 7.0,
			flightMinDuration: 1.2,
			flightMaxDuration: 2.5,
			landingDescent: 5.0
		},

		// Stationary obstacles. Trunks and stones are vertical cylinders.
		trees: [
			{ id: 'fig', species: 'fig', x: 24, z: 20, trunkRadius: 1.6, trunkHeight: 13, canopyY: 18, canopyRadius: 12,
				canopyFruitCap: 5, fruitSpawnInterval: 70, dropRadius: 9 },
			{ id: 'apple', species: 'apple', x: 96, z: 15, trunkRadius: 2.0, trunkHeight: 14, canopyY: 20, canopyRadius: 14,
				canopyFruitCap: 6, fruitSpawnInterval: 55, dropRadius: 10,
				lowBranches: [ { to: { x: 81, y: 7.2, z: 31 } }, { to: { x: 86, y: 4.5, z: 40 } } ] },
			{ id: 'plum', species: 'plum', x: 106, z: 80, trunkRadius: 1.2, trunkHeight: 9, canopyY: 13, canopyRadius: 8,
				canopyFruitCap: 3, fruitSpawnInterval: 90, dropRadius: 6 }
		],

		stones: [
			{ x: 46, z: 62, radius: 1.6, height: 1.3 },
			{ x: 70, z: 63, radius: 1.2, height: 1.0 },
			{ x: 40, z: 38, radius: 1.4, height: 1.2 },
			{ x: 64, z: 24, radius: 1.8, height: 1.5 },
			{ x: 10, z: 50, radius: 1.3, height: 1.1 }
		],

		// Trellis panels: vertical lattice segments (solid for collision,
		// partially transparent for vision).
		trellis: [
			{ x1: 84, z1: 60, x2: 84, z2: 76, height: 12, transmission: 0.55 },
			{ x1: 84, z1: 76, x2: 96, z2: 76, height: 12, transmission: 0.55 }
		],

		// Foliage volumes block sight but not smell or movement.
		foliage: [
			{ id: 'vine-a', x: 80, y: 3.5, z: 67, rx: 2.8, ry: 3.5, rz: 3.2, opacity: 0.75 },
			{ id: 'vine-b', x: 82, y: 6.0, z: 72, rx: 2.5, ry: 3.0, rz: 2.8, opacity: 0.7 }
		],

		// Shade: local light multipliers (the Light control scales globally).
		shade: [
			{ id: 'fig-canopy', x: 24, z: 20, radius: 12, light: 0.55 },
			{ id: 'apple-canopy', x: 96, z: 15, radius: 14, light: 0.55 },
			{ id: 'plum-canopy', x: 106, z: 80, radius: 8, light: 0.6 },
			{ id: 'leaf-shelter', x: 22, z: 72, radius: 12, light: 0.3 }
		],

		shelter: {
			x: 22, z: 72, radius: 12,
			leaves: [
				{ x: 18, z: 68, size: 7, angle: 0.4, height: 3.2 },
				{ x: 27, z: 74, size: 6, angle: 2.1, height: 2.6 },
				{ x: 20, z: 79, size: 5.5, angle: 3.6, height: 2.1 },
				{ x: 13, z: 74, size: 5, angle: 5.0, height: 2.8 }
			]
		},

		sun: { dirX: 0.35, dirY: 0.85, dirZ: 0.4 },

		// Spiderwebs: vertical orb webs. normal is horizontal (x, z).
		webs: [
			{ id: 'web-a', label: 'Web A (apple branches)', x: 80, y: 3.2, z: 33.5, normalX: 0.86, normalZ: -0.51,
				radius: 4.5, contrast: 0.85, spokes: 16, spiralTurns: 11, motion: 0.6 },
			{ id: 'web-b', label: 'Web B (trellis)', x: 89, y: 3.0, z: 68, normalX: 0.2, normalZ: -0.98,
				radius: 4.0, contrast: 0.7, spokes: 14, spiralTurns: 9, motion: 0.4 }
		],

		// Initial edible fruit on the ground (fallen, ripe). Canopy fruit ripens
		// and falls later.
		initialFruit: [
			{ tree: 'fig', x: 19, z: 30, stage: 'fallen' },
			{ tree: 'fig', x: 30, z: 29, stage: 'fallen' },
			{ tree: 'fig', x: 26, z: 34, stage: 'fermenting' },
			{ tree: 'fig', x: 14, z: 24, stage: 'fallen' },
			{ tree: 'apple', x: 86, z: 27, stage: 'fermenting' },
			{ tree: 'apple', x: 89.5, z: 30.5, stage: 'fermenting' },
			{ tree: 'apple', x: 84.5, z: 31.5, stage: 'fallen' },
			{ tree: 'apple', x: 91, z: 26, stage: 'fermenting' },
			{ tree: 'plum', x: 101, z: 73, stage: 'fallen' },
			{ tree: 'plum', x: 108, z: 71, stage: 'fallen' }
		],
		initialCanopyFruit: { fig: 2, apple: 3, plum: 1 },

		species: {
			fig: { color: '#6b3f5e', radius: 0.8, sugar: 0.9, nutrition: 0.55, odorRipe: 1.0, odorFerment: 1.5 },
			apple: { color: '#c7372f', radius: 1.0, sugar: 0.85, nutrition: 0.7, odorRipe: 1.2, odorFerment: 1.9 },
			plum: { color: '#4b3a8c', radius: 0.7, sugar: 0.95, nutrition: 0.45, odorRipe: 1.0, odorFerment: 1.4 },
			user: { color: '#e5a823', radius: 0.8, sugar: 1.0, nutrition: 0.6, odorRipe: 1.3, odorFerment: 1.8 }
		},

		fruit: {
			ripenRate: 1 / 60,          // ripeness per second on the branch (accelerated)
			fermentDelay: 120,          // seconds after falling before fermentation
			decayRate: 1 / 900,         // edible amount lost per second while fermenting
			intakeRate: 0.12,           // portion per second while feeding with contact
			maxFruit: 18,               // cap on all fruit objects (attached + ground)
			maxGroundFruit: 12,
			depletedFade: 6,            // seconds a depleted fruit lingers before removal
			unripeOdor: 0.1
		},

		odor: {
			lengthScale: 8.0,           // BL e-folding distance of a source's contribution
			downwindStretch: 1.9,
			upwindCompress: 1.6,
			historyLength: 20           // retained antenna samples (neural steps)
		},

		breeze: { fromX: 1, fromZ: -1, speed: 0.35 },  // blowing from the north-east

		threat: {
			// Design assumption: the mapping from visible web features to an
			// aversive visual input. Flies have looming-sensitive circuits; an
			// innate spiderweb detector is NOT established. See docs/world-model.md.
			sizeRef: 0.6,               // rad of apparent size giving unit size term (squared)
			sizeCap: 1.5,               // static size alone yields at most mild avoidance
			expansionRef: 0.5,          // rad/s of expansion giving unit expansion term
			sizeWeight: 0.25,
			expansionWeight: 1.0,
			motionWeight: 0.12,
			maxRange: 22,               // BL beyond which strands are not resolved
			edgeOnFloor: 0.18,          // visible fraction when viewed edge-on
			binocularOverlap: 0.26,     // rad each eye sees across the midline
			rearBlind: 0.3,             // rad blind sector behind the fly
			lineOfSightSamples: 5
		},

		silk: {
			thickness: 0.12,
			snagMin: 0.7,
			snagMax: 1.8,
			releasePush: 0.7,
			dragFactor: 0.08
		},

		drives: {
			// Converted from the legacy 500 ms tick so intended timescales hold.
			hungerRate: 0.01,           // per s (legacy +0.005 per 0.5 s)
			hungerPerNutrition: 1.0,    // hunger reduced per unit of consumed nutrition
			fearRetentionPerHalfSecond: 0.85,
			fatigueGainMoving: 0.006,   // per s (legacy +0.003 per 0.5 s)
			fatigueGainMovingDark: 0.012,
			fatigueGainFlying: 0.02,
			fatigueRecovery: 0.02,      // per s at rest (legacy -0.01 per 0.5 s)
			curiosityStep: 0.06,        // legacy uniform range per 0.5 s
			curiosityStepDark: 0.02,
			groomRate: 0.016,
			groomTouchGain: 0.4,
			groomRelief: 1.0
		},

		initialDrives: { hunger: 0.55, fear: 0.0, fatigue: 0.0, curiosity: 0.5, groom: 0.1 },

		clock: {
			bodyDt: 1 / 60,
			neuralDt: 0.1,
			maxCatchUpSteps: 12         // body steps per frame before yielding
		},

		// Neural encoder / readout / motor adapter. Values marked "calibrated"
		// come from tools/connectome-baseline.js; see docs/connectome-baseline.md.
		brain: {
			synapseWeight: 0.0035,      // calibrated: voltage per synapse (threshold = 1); see docs/connectome-baseline.md
			ticksPerStep: 1,
			neuralDt: 0.1,
			settleSteps: 150,           // neural steps run before t = 0 (initial brain state)
			stimMin: 0.05,              // per-tick intensity at the recruitment edge
			stimMax: 0.3,               // per-tick intensity at saturation
			odorHalfSat: 0.6,
			odorAdaptTau: 4.0,          // s, receptor adaptation
			odorAdaptGain: 0.5,
			hungerOdorGain: [0.25, 1.5],    // gain at hunger 0 and 1
			hungerTasteGain: [0.3, 1.5],
			lightStim: 0.15,
			tonicCentral: 0.08,
			hungerDriveStim: 0.15,
			contactPulse: 0.9,          // one-shot voltage for touch/silk pulses
			readoutTau: 0.25            // s, smoothing of population rates
		},

		policy: {
			minDuration: { idle: 0, walk: 0.4, feed: 1.2, groom: 1.5, rest: 3.0, startle: 0.5, fly: 1.2, brace: 0.5, snagged: 0 },
			cooldown: { startle: 3.0, fly: 6.0, groom: 3.0, feed: 0.6, brace: 1.0 }
		},

		render: {
			maxPixelRatio: 2,
			shadowMapSize: 1024,
			trailLength: 600
		},

		// Experiment presets (plan: "Demonstrate emergence with experiments").
		// stateOptions feed WorldState.create; `at` schedules logged
		// interventions by simulation time; `triggers` fire a logged
		// intervention once when a matching event first occurs.
		scenarios: {
			free: {
				label: 'Free garden',
				description: 'The authored garden: fig, apple and plum fruit, two webs, the fly in the clearing.',
				stateOptions: {}
			},
			hungry: {
				label: 'Hungry fly',
				description: 'Same garden and seed, starting hunger 0.9. Compare food-contact latency and intake with the satiated fly.',
				stateOptions: { drives: { hunger: 0.9 } }
			},
			satiated: {
				label: 'Satiated fly',
				description: 'Same garden and seed, starting hunger 0.05.',
				stateOptions: { drives: { hunger: 0.05 } }
			},
			webPatch: {
				label: 'Fruit beside a web',
				description: 'Only the fragrant apple patch, with web A strung across the direct route.',
				stateOptions: { fruitTrees: ['apple'], canopyFruit: false, drives: { hunger: 0.8 } }
			},
			webPatchNoWeb: {
				label: 'Same fruit, no webs',
				description: 'The apple patch with both webs removed.',
				stateOptions: { fruitTrees: ['apple'], canopyFruit: false, omitWebs: ['web-a', 'web-b'], drives: { hunger: 0.8 } }
			},
			visibleWeb: {
				label: 'Web B in view',
				description: 'The fly starts 11 BL north of web B, facing it with nothing in between.',
				stateOptions: { start: { x: 89, z: 57, heading: -Math.PI / 2 }, fruit: false, drives: { hunger: 0.3 } }
			},
			hiddenWeb: {
				label: 'Web B behind vines',
				description: 'Same distance to web B, but seen from the west through vine leaves and the trellis.',
				stateOptions: { start: { x: 78, z: 64, heading: -0.25 }, fruit: false, drives: { hunger: 0.3 } }
			},
			recover: {
				label: 'Recover after a threat',
				description: 'The fly starts facing web A. After its first escape the web is taken down; watch fear subside and feeding resume.',
				stateOptions: { start: { x: 70, z: 40, heading: 0.53 }, drives: { hunger: 0.75 } },
				triggers: [ { event: 'behavior', to: 'startle', cmd: { type: 'removeWeb', params: { id: 'web-a' } } } ]
			},
			moveFruit: {
				label: 'Move fruit, change wind',
				description: 'At 15 s the breeze swings to blow from the west; at 30 s the nearest fig moves to the east side.',
				stateOptions: { drives: { hunger: 0.8 } },
				at: [
					{ t: 15, cmd: { type: 'setBreeze', params: { fromX: -1, fromZ: 0, speed: 0.35 } } },
					{ t: 30, cmd: { type: 'moveFruit', params: { id: 'fruit-2', x: 70, z: 30 } } }
				]
			}
		}
	};

	root.WorldConfig = WorldConfig;
})(typeof window !== 'undefined' ? window : globalThis);
