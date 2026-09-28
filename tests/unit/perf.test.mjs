import assert from 'node:assert/strict';
import test from 'node:test';

import { IDLE_FPS, RES_FLOOR, createFrameGate, createResScaler } from '../../src/perf.js';

/**
 * Run a gate against a synthetic display and count the frames it let through.
 *
 * `panelHz` is the rate requestAnimationFrame fires at, which is the display's, and has nothing
 * to do with the cap — the whole point of the gate is to hit a target that the display does not
 * divide evenly into.
 */
function runGate({ panelHz, capHz, seconds = 2 }) {
  return runTimes({ panelHz, capHz, seconds }).length / seconds;
}

/** The timestamps of the frames a gate let through, on a synthetic display. */
function runTimes({ panelHz, capHz, seconds = 2 }) {
  const gate = createFrameGate();
  const budget = capHz > 0 ? 1 / capHz : 0;
  const frames = Math.round(panelHz * seconds);
  const times = [];
  for (let i = 1; i <= frames; i += 1) {
    if (gate.shouldRun(i / panelHz, budget)) times.push(i / panelHz);
  }
  return times;
}

test('capped frames are evenly spaced, and never slower than the cap', () => {
  // Uneven spacing is judder even when the average is right: the first gate hit 60 on a 144 Hz
  // panel by alternating frames 14 ms and 21 ms apart, and turning the camera hitched. After
  // the first few frames (while the refresh rate is being measured) every gap must be equal.
  for (const panelHz of [60, 75, 90, 120, 144, 165, 240]) {
    const times = runTimes({ panelHz, capHz: 60 }).slice(4);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    const spread = Math.max(...gaps) - Math.min(...gaps);
    assert.ok(spread < 1e-9, `${panelHz} Hz panel: frame gaps vary by ${(spread * 1000).toFixed(2)} ms`);
    const fps = 1 / gaps[0];
    assert.ok(fps >= 59.9 && fps <= panelHz + 1e-6, `${panelHz} Hz panel ran at ${fps.toFixed(1)} fps`);
  }
});

test('a 60 cap on a 144 Hz panel runs every second refresh', () => {
  const times = runTimes({ panelHz: 144, capHz: 60 }).slice(4);
  assert.ok(Math.abs(1 / (times[1] - times[0]) - 72) < 1e-6);
});

test('a 30 cap halves a 60 Hz panel and a 60 cap does not touch it', () => {
  assert.ok(Math.abs(runGate({ panelHz: 60, capHz: 30 }) - 30) <= 2);
  assert.equal(runGate({ panelHz: 60, capHz: 60 }), 60);
});

test('an uncapped gate passes every frame', () => {
  assert.equal(runGate({ panelHz: 144, capHz: 0 }), 144);
});

test('the idle budget throttles menus to IDLE_FPS', () => {
  const fps = runGate({ panelHz: 60, capHz: IDLE_FPS });
  assert.ok(Math.abs(fps - IDLE_FPS) <= 2, `measured ${fps} fps`);
});

test('changing the budget runs the next frame immediately', () => {
  const gate = createFrameGate();
  assert.equal(gate.shouldRun(0, 1 / 15), true);      // first frame, idle budget
  assert.equal(gate.shouldRun(0.016, 1 / 15), false); // still inside it
  // Leaving the menu must not inherit the menu's cadence, or the first few frames of play are
  // skipped while a timestamp 60 ms in the future catches up.
  assert.equal(gate.shouldRun(0.017, 1 / 60), true);
});

/** Feed the scaler `count` frames that each took `interval` seconds. */
function feed(scaler, count, interval, budget = 1 / 60) {
  const changes = [];
  for (let i = 0; i < count; i += 1) {
    const next = scaler.sample(interval, budget);
    if (next !== null) changes.push(next);
  }
  return changes;
}

/**
 * A machine whose frame cost is proportional to the pixels it draws — the case dynamic
 * resolution exists for. `cost` is the seconds per frame it manages at full resolution.
 */
function feedPixelBound(scaler, count, cost, budget = 1 / 60) {
  for (let i = 0; i < count; i += 1) scaler.sample(cost * scaler.scale, budget);
  return scaler.scale;
}

test('sustained late frames step the resolution down, and only after a full window', () => {
  const scaler = createResScaler();
  assert.deepEqual(feed(scaler, 29, 1 / 20), []);     // 29 samples decide nothing
  assert.deepEqual(feed(scaler, 1, 1 / 20), [0.9]);
});

test('a machine limited by pixels is scaled down until it keeps up', () => {
  const scaler = createResScaler();
  const settled = feedPixelBound(scaler, 3000, 1 / 40);
  assert.ok(settled < 1, `expected a step down, settled at ${settled}`);
  assert.ok(settled >= RES_FLOOR, `expected to stay above the floor, settled at ${settled}`);
});

test('a hopeless machine stops at the floor instead of rendering mush', () => {
  const scaler = createResScaler();
  assert.equal(feedPixelBound(scaler, 6000, 1 / 4), RES_FLOOR);
});

test('a machine NOT limited by pixels gets its resolution back and is left alone', () => {
  // The frame cost here does not move when the scale does: the bottleneck is elsewhere. Taking
  // pixels away buys nothing, so the scaler must undo its probe rather than walk to the floor.
  const scaler = createResScaler();
  feed(scaler, 4000, 1 / 20);
  assert.equal(scaler.scale, 1, 'resolution should have been handed back');
});

test('frames that hit the budget bring the resolution back', () => {
  const scaler = createResScaler();
  feed(scaler, 30, 1 / 20);
  assert.equal(scaler.scale, 0.9);
  // Recovery is deliberately slow — the up-wait is longer than the down-wait — so this needs
  // far more than one window of good frames.
  assert.deepEqual(feed(scaler, 600, 1 / 60), [1]);
});

test('every step down makes the next step up slower to arrive', () => {
  const scaler = createResScaler();
  const settled = feedPixelBound(scaler, 2000, 1 / 12);   // several steps down
  assert.ok(settled < 0.9, `expected repeated steps down, settled at ${settled}`);
  // One window of healthy frames is not enough to undo a history of being too slow.
  assert.deepEqual(feed(scaler, 60, 1 / 60), []);
  assert.equal(scaler.scale, settled);
});

test('a frame that spans a pause or a level load is not evidence of anything', () => {
  const scaler = createResScaler();
  feed(scaler, 40, 3.0);
  assert.equal(scaler.scale, 1);
});

test('restore returns to the preset resolution and forgets the history', () => {
  const scaler = createResScaler();
  feedPixelBound(scaler, 2000, 1 / 12);
  assert.ok(scaler.scale < 1);
  scaler.restore();
  assert.equal(scaler.scale, 1);
  assert.deepEqual(feed(scaler, 29, 1 / 20), []);
  assert.deepEqual(feed(scaler, 1, 1 / 20), [0.9]);
});
