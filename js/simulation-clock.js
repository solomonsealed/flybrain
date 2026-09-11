/* simulation-clock.js -- Fixed simulation time, brain-step scheduling, pause,
 * and speed control.
 *
 * Body physics runs at a fixed 60 Hz and the brain at 10 Hz; rendering is
 * interpolated between body steps. At every 100 ms boundary the clock asks
 * the simulation whether the previous neural step has returned. If it has
 * not, simulated time stalls: under load the garden runs slower than wall
 * time instead of silently changing neural dynamics. At most one neural step
 * is ever outstanding.
 */
(function (root) {
	'use strict';

	function create(cfg) {
		var c = cfg.clock;
		var clock = {
			bodyDt: c.bodyDt,
			neuralDt: c.neuralDt,
			stepsPerBlock: Math.round(c.neuralDt / c.bodyDt),
			maxCatchUpSteps: c.maxCatchUpSteps,
			speed: 1,
			paused: false,
			accumulator: 0,
			stalled: false,
			stats: { stallSeconds: 0, stallEvents: 0, simSeconds: 0, wallSeconds: 0, ratio: 1 }
		};

		// Advances simulated time by up to realDt * speed. `sim` provides
		// preStep(), canStartBlock(), startBlock() and bodyStep() and exposes
		// state.bodyStep. Returns the number of body steps taken.
		clock.advance = function (realDt, sim) {
			if (clock.paused || !(realDt > 0)) return 0;
			var st = clock.stats;
			st.wallSeconds += realDt;
			clock.accumulator += realDt * clock.speed;
			var cap = clock.maxCatchUpSteps * clock.bodyDt;
			if (clock.accumulator > cap) clock.accumulator = cap;   // drop, never burst
			var steps = 0;
			var wasStalled = clock.stalled;
			clock.stalled = false;
			while (clock.accumulator >= clock.bodyDt && steps < clock.maxCatchUpSteps) {
				// replays stop exactly at the recorded step
				if (sim.stopAt !== undefined && sim.state.bodyStep >= sim.stopAt) { clock.paused = true; break; }
				sim.preStep();
				if (sim.state.bodyStep % clock.stepsPerBlock === 0) {
					if (!sim.canStartBlock()) {
						clock.stalled = true;
						st.stallSeconds += realDt;
						if (!wasStalled) st.stallEvents++;
						break;
					}
					sim.startBlock();
				}
				sim.bodyStep();
				clock.accumulator -= clock.bodyDt;
				steps++;
			}
			st.simSeconds += steps * clock.bodyDt;
			var a = 1 - Math.exp(-realDt / 2);
			st.ratio += ((steps * clock.bodyDt) / (realDt * clock.speed) - st.ratio) * a;
			return steps;
		};

		// Headless: run exactly n body steps (the brain must be synchronous).
		clock.runSteps = function (n, sim) {
			for (var i = 0; i < n; i++) {
				sim.preStep();
				if (sim.state.bodyStep % clock.stepsPerBlock === 0) {
					if (!sim.canStartBlock()) throw new Error('neural step ' + (sim.state.bodyStep / clock.stepsPerBlock - 1) + ' has not returned');
					sim.startBlock();
				}
				sim.bodyStep();
			}
			clock.stats.simSeconds += n * clock.bodyDt;
		};

		// Interpolation factor between the previous and current body step.
		clock.alpha = function () {
			return Math.max(0, Math.min(1, clock.accumulator / clock.bodyDt));
		};

		clock.setSpeed = function (s) { clock.speed = Math.max(0.1, Math.min(8, s)); };
		clock.pause = function () { clock.paused = true; };
		clock.resume = function () { clock.paused = false; clock.accumulator = 0; };

		return clock;
	}

	root.SimulationClock = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
