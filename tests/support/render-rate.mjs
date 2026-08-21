export function frameDeltas(renderHz, seconds) {
  if (!Number.isFinite(renderHz) || renderHz <= 0) throw new RangeError('renderHz must be positive');
  if (!Number.isFinite(seconds) || seconds <= 0) throw new RangeError('seconds must be positive');

  const frameCount = Math.round(renderHz * seconds);
  const frameDt = seconds / frameCount;
  return Array.from({ length: frameCount }, () => frameDt);
}
/**
 * Mirrors the capped fixed-step scheduler used by the current game loop. Callers can attach
 * live-game callbacks later without duplicating the accumulator rules in every regression.
 */
export function runFixedStepSchedule({
  renderHz,
  seconds,
  fixedHz = 120,
  maxSubsteps = 3,
  maxFrameDt = 0.25,
  onFixedStep = () => {},
  onFrame = () => {},
} = {}) {
  if (!Number.isInteger(maxSubsteps) || maxSubsteps < 1) {
    throw new RangeError('maxSubsteps must be a positive integer');
  }

  const fixedDt = 1 / fixedHz;
  let accumulator = 0;
  let simulatedSeconds = 0;
  let droppedSeconds = 0;
  let fixedSteps = 0;
  const stepsPerFrame = [];

  for (const rawDt of frameDeltas(renderHz, seconds)) {
    const dt = Math.min(rawDt, maxFrameDt);
    accumulator += dt;
    let steps = 0;

    while (accumulator >= fixedDt && steps < maxSubsteps) {
      onFixedStep(fixedDt);
      accumulator -= fixedDt;
      simulatedSeconds += fixedDt;
      fixedSteps += 1;
      steps += 1;
    }

    if (accumulator > fixedDt * maxSubsteps) {
      droppedSeconds += accumulator;
      accumulator = 0;
    }

    stepsPerFrame.push(steps);
    onFrame(dt);
  }

  return {
    renderHz,
    renderedSeconds: seconds,
    simulatedSeconds,
    droppedSeconds,
    remainderSeconds: accumulator,
    fixedSteps,
    stepsPerFrame,
  };
}

export function relativeDifference(a, b) {
  const scale = Math.max(Math.abs(a), Math.abs(b), Number.EPSILON);
  return Math.abs(a - b) / scale;
}
