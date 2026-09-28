/**
 * Frame pacing and adaptive resolution — the two knobs that decide what a laptop spends its
 * battery on.
 *
 * Both live here rather than inside the main loop because the rules are arithmetic with no
 * three.js and no DOM in them, which means they can be unit tested directly against a
 * synthetic display (tests/unit/perf.test.mjs) instead of only through a browser that cannot
 * be asked to run slowly on demand.
 */

/**
 * Rendered frames per second while a menu is up. The world behind the overlay does not update,
 * so anything faster is battery spent redrawing an identical picture.
 */
export const IDLE_FPS = 15;

/**
 * A render-rate limiter that keeps frames evenly spaced.
 *
 * The point is battery: an uncapped loop on a 144 Hz laptop panel draws 2.4x the frames of a
 * 60 cap for a difference most players cannot see. Simulation is unaffected — the caller keeps
 * its own `lastTime`, so a skipped frame's time still reaches the physics accumulator.
 *
 * It runs every Nth display refresh, N fixed. The first version aimed at the exact number
 * instead, which a display that does not divide into it cannot give evenly: on 144 Hz a 60 cap
 * alternated frames 14 ms and 21 ms apart, and uneven frame spacing is judder — the camera
 * visibly hitches while turning even though the average rate is right. So N is the largest
 * whole number of refreshes that still meets the cap, and the rate lands at or a little above
 * it: 72 on a 144 Hz panel, exactly 60 on 60 and 120 Hz.
 *
 * The refresh interval is measured, as the median interval between calls, because
 * requestAnimationFrame fires once per refresh and nothing else reports the rate.
 */
export function createFrameGate() {
  let lastCall = -Infinity;
  let lastBudget = -1;
  let count = 0;
  const intervals = [];

  const refresh = () => {
    if (intervals.length === 0) return 0;
    const sorted = intervals.slice().sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  };

  return {
    /**
     * @param {number} now     seconds, monotonic
     * @param {number} budget  seconds per frame; 0 or less means uncapped
     * @returns {boolean} whether this frame should run
     */
    shouldRun(now, budget) {
      const interval = now - lastCall;
      lastCall = now;
      if (interval > 0 && interval < 0.1) {
        intervals.push(interval);
        if (intervals.length > 30) intervals.shift();
      }
      // A budget change is a state change — to or from a menu, or the cap setting moving. Draw
      // it promptly, and start counting afresh.
      if (budget !== lastBudget) {
        lastBudget = budget;
        count = 0;
        return true;
      }
      if (!(budget > 0)) return true;
      // The 0.1 absorbs timer noise, so a 60 Hz panel against a 60 cap is N = 1, not N = 0.
      const every = Math.max(1, Math.floor(budget / (refresh() || budget) + 0.1));
      count += 1;
      if (count < every) return false;
      count = 0;
      return true;
    },

    reset() { lastCall = -Infinity; lastBudget = -1; count = 0; intervals.length = 0; },
  };
}

/** How far the adaptive scaler may go before it gives up; below this the image is mush. */
export const RES_FLOOR = 0.6;

const WINDOW = 30;            // frames averaged before any decision
const DOWN_RATIO = 1.30;      // mean frame this far over budget = not keeping up
const UP_RATIO = 1.08;        // and this close to it = the cap is being met
const DOWN_WAIT = 1.5;        // seconds of quiet after a step down
const UP_WAIT = 4.0;          // ...and after a step up, which is the riskier direction
const UP_WAIT_MAX = 60.0;

/**
 * Dynamic resolution.
 *
 * Renders fewer pixels when frames are late, which is the one lever that reliably converts
 * "unplayable on this machine" into "playable" without the player having to know what a
 * shadow map is. Scale is a multiplier on the quality preset's own renderScale.
 *
 * Two things shape the rules. Changing the scale re-allocates the drawing buffer, which is
 * itself a hitch, so changes are rate limited and hysteretic. And under a frame cap the
 * measured interval cannot distinguish "comfortable" from "exactly keeping up" — both sit at
 * the budget — so recovery has to be optimistic. It is made safe by backing off: every step
 * down doubles the wait before the next step up, so a machine that genuinely sits on the
 * boundary settles instead of pumping the resolution every few seconds.
 */
export function createResScaler({ floor = RES_FLOOR, step = 0.1 } = {}) {
  let scale = 1;
  let mean = 0;
  let samples = 0;
  let wait = 0;
  let upWait = UP_WAIT;
  let probeMean = 0;      // the mean that triggered the step down being checked
  let probing = false;
  let frozen = false;     // this machine is not pixel bound; stop taking pixels away from it

  const quantise = (value) => Math.round(value * 100) / 100;

  return {
    get scale() { return scale; },

    /** Forget the sample window. Used whenever the frame stream is not steady-state play. */
    reset() { mean = 0; samples = 0; },

    /** Back to the preset's own resolution, and re-probe from scratch. */
    restore() {
      scale = 1; mean = 0; samples = 0; wait = 0; upWait = UP_WAIT;
      probing = false; frozen = false; probeMean = 0;
    },

    /**
     * @param {number} interval  seconds since the previous rendered frame
     * @param {number} budget    seconds per frame being targeted
     * @returns {number|null} the new scale if it changed, else null
     */
    sample(interval, budget) {
      if (wait > 0 && interval > 0) wait -= interval;
      // A frame spanning a pause, a tab switch or a level load says nothing about the cost of
      // steady-state play, and averaging it in would drop the scale for no reason.
      if (!(budget > 0) || !(interval > 0) || interval > 0.5) return null;

      samples += 1;
      mean += (interval - mean) / Math.min(samples, WINDOW);
      if (samples < WINDOW || wait > 0) return null;

      /**
       * Did the last step down actually buy anything?
       *
       * Resolution only helps when the frame is limited by pixels. A machine that is CPU bound
       * — too many bots, a browser throttling timers, a background task — sees no improvement
       * at all, and without this check the scaler walks all the way to the floor and hands the
       * player a blurry picture for nothing. Measured in the real game against a timer-limited
       * loop: it reached 0.6 with no frame-rate gain whatsoever. So each step down is a probe:
       * if the next window is not at least 6% faster, put the pixels back and stop.
       */
      if (probing) {
        probing = false;
        if (mean > probeMean * 0.94) {
          frozen = true;
          scale = Math.min(1, quantise(scale + step));
          samples = 0; mean = 0; wait = DOWN_WAIT;
          return scale;
        }
      }

      if (!frozen && mean > budget * DOWN_RATIO && scale > floor) {
        probeMean = mean;
        probing = true;
        scale = Math.max(floor, quantise(scale - step));
        samples = 0; mean = 0;
        wait = DOWN_WAIT;
        upWait = Math.min(UP_WAIT_MAX, upWait * 2);
        return scale;
      }
      if (mean < budget * UP_RATIO && scale < 1) {
        scale = Math.min(1, quantise(scale + step));
        samples = 0; mean = 0;
        wait = upWait;
        return scale;
      }
      return null;
    },
  };
}
