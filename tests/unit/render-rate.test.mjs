import assert from 'node:assert/strict';
import test from 'node:test';

import { CONFIG } from '../../src/config.js';
import { frameDeltas, relativeDifference, runFixedStepSchedule } from '../support/render-rate.mjs';

test('frame schedules cover the requested wall-clock duration', () => {
  for (const hz of [120, 60, 30]) {
    const elapsed = frameDeltas(hz, 10).reduce((sum, dt) => sum + dt, 0);
    assert.ok(Math.abs(elapsed - 10) < 1e-10, `${hz} Hz elapsed ${elapsed}`);
  }
});
test('four-substep budget covers ten seconds of physics at 30 Hz', () => {
  const at60 = runFixedStepSchedule({ renderHz: 60, seconds: 10 });
  const at30 = runFixedStepSchedule({ renderHz: 30, seconds: 10 });

  assert.ok(Math.abs(at60.simulatedSeconds - 10) < 1 / 120);
  assert.ok(Math.abs(at30.simulatedSeconds - 10) < 1 / 120);
  assert.equal(at30.fixedSteps, 1200);
});

/**
 * The bug a laptop playtest found: below 30 fps the loop threw simulation time away, so the
 * whole game ran in slow motion — and the bots looked worst, because their leg animation is
 * paced off body VELOCITY while their bodies were only covering a fraction of it per second.
 *
 * These two tests are a pair on purpose. The first pins the fix to the shipped constant, so
 * lowering CONFIG.MAX_SUBSTEPS goes red. The second states what the old value actually did, so
 * the first cannot be mistaken for a test that would pass either way.
 */
test('the shipped substep budget keeps physics real-time down to 10 fps', () => {
  for (const renderHz of [30, 20, 15, 10]) {
    const run = runFixedStepSchedule({
      renderHz, seconds: 10, maxSubsteps: CONFIG.MAX_SUBSTEPS,
    });
    assert.equal(run.droppedSeconds, 0, `${renderHz} fps dropped ${run.droppedSeconds}s`);
    assert.ok(Math.abs(run.simulatedSeconds - 10) < 1 / 120,
      `${renderHz} fps simulated ${run.simulatedSeconds}s of 10`);
  }
});

test('four substeps ran the simulation at half speed at 15 fps', () => {
  const starved = runFixedStepSchedule({ renderHz: 15, seconds: 10, maxSubsteps: 4 });

  assert.ok(starved.simulatedSeconds < 6,
    `expected slow motion, simulated ${starved.simulatedSeconds}s of 10`);
  assert.ok(starved.droppedSeconds > 4, `only dropped ${starved.droppedSeconds}s`);
});

test('relativeDifference is symmetric and scale independent', () => {
  assert.equal(relativeDifference(10, 8), relativeDifference(8, 10));
  assert.equal(relativeDifference(100, 80), relativeDifference(10, 8));
  assert.equal(relativeDifference(0, 0), 0);
});
