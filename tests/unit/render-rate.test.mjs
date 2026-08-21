import assert from 'node:assert/strict';
import test from 'node:test';

import { frameDeltas, relativeDifference, runFixedStepSchedule } from '../support/render-rate.mjs';

test('frame schedules cover the requested wall-clock duration', () => {
  for (const hz of [120, 60, 30]) {
    const elapsed = frameDeltas(hz, 10).reduce((sum, dt) => sum + dt, 0);
    assert.ok(Math.abs(elapsed - 10) < 1e-10, `${hz} Hz elapsed ${elapsed}`);
  }
});
test('current three-substep budget exposes the 30 Hz physics deficit', () => {
  const at60 = runFixedStepSchedule({ renderHz: 60, seconds: 10 });
  const at30 = runFixedStepSchedule({ renderHz: 30, seconds: 10 });

  assert.ok(Math.abs(at60.simulatedSeconds - 10) < 1 / 120);
  assert.ok(Math.abs(at30.simulatedSeconds - 7.5) < 1 / 120);
  assert.equal(at30.fixedSteps, 900);
});

test('relativeDifference is symmetric and scale independent', () => {
  assert.equal(relativeDifference(10, 8), relativeDifference(8, 10));
  assert.equal(relativeDifference(100, 80), relativeDifference(10, 8));
  assert.equal(relativeDifference(0, 0), 0);
});
