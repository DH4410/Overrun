import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDevice, createAutoGovernor } from '../../src/device.js';
import { createResScaler } from '../../src/perf.js';
import { DEFAULT_SETTINGS, QUALITY, activeQuality, qualityKey, setAutoTier, settings } from '../../src/settings.js';

const MP = 1e6;

test('a dedicated GPU gets the top preset, even on a big screen', () => {
  const rtx = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
  assert.equal(classifyDevice({ gpu: rtx, cores: 12, memoryGB: 8, pixels: 3.7 * MP }).tier, 'high');
  assert.equal(classifyDevice({ gpu: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11)', cores: 8, pixels: 2 * MP }).tier, 'high');
});

test('an integrated GPU is fine on a laptop panel and drops to Performance on a big monitor', () => {
  const amd = 'ANGLE (AMD, AMD Radeon (TM) Graphics (0x000015E7) Direct3D11 vs_5_0 ps_5_0, D3D11)';
  assert.equal(classifyDevice({ gpu: amd, cores: 8, memoryGB: 8, pixels: 1.2 * MP }).tier, 'medium');
  const monitor = classifyDevice({ gpu: amd, cores: 8, memoryGB: 8, pixels: 2.07 * MP });
  assert.equal(monitor.tier, 'low');
  assert.equal(monitor.gpuClass, 'integrated');
  assert.equal(classifyDevice({ gpu: 'AMD Radeon(TM) Graphics', cores: 8, pixels: 2 * MP }).gpuClass, 'integrated');
  assert.equal(classifyDevice({ gpu: 'Intel(R) UHD Graphics 620', cores: 8, pixels: 2 * MP }).tier, 'low');
});

test('few cores or little memory cap the result whatever the GPU is', () => {
  const rtx = 'NVIDIA GeForce RTX 4070';
  assert.equal(classifyDevice({ gpu: rtx, cores: 4, memoryGB: 8, pixels: MP }).tier, 'medium');
  assert.equal(classifyDevice({ gpu: rtx, cores: 16, memoryGB: 4, pixels: MP }).tier, 'medium');
  assert.equal(classifyDevice({ gpu: rtx, cores: 2, memoryGB: 8, pixels: MP }).tier, 'low');
  assert.equal(classifyDevice({ gpu: rtx, cores: 16, memoryGB: 2, pixels: MP }).tier, 'low');
});

test('software rendering, phones and unknown figures', () => {
  assert.equal(classifyDevice({ gpu: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))', cores: 16, memoryGB: 8 }).tier, 'low');
  assert.equal(classifyDevice({ gpu: 'Apple GPU', mobile: true, cores: 6, memoryGB: 4 }).tier, 'low');
  // A browser that hides everything must not be punished: no GPU name, no core count, no memory.
  assert.equal(classifyDevice({}).tier, 'medium');
  assert.equal(classifyDevice().tier, 'medium');
});

test('the governor steps down only after two full late windows with adaptive resolution spent', () => {
  const g = createAutoGovernor({ window: 10, patience: 2, cooldown: 5 });
  const run = (n, interval, exhausted, tier) => {
    let out = null;
    for (let i = 0; i < n; i++) out = g.sample(interval, 1 / 60, exhausted, tier) ?? out;
    return out;
  };
  assert.equal(run(40, 1 / 20, false, 'medium'), null, 'adaptive resolution still has pixels to take');
  assert.equal(run(10, 1 / 20, true, 'medium'), null, 'one late window is not enough');
  assert.equal(run(10, 1 / 20, true, 'medium'), 'low', 'the second one is');
  assert.equal(run(40, 1 / 20, true, 'low'), null, 'nothing is below Performance');
});

test('the governor leaves a machine that keeps up alone, and waits after a step', () => {
  const g = createAutoGovernor({ window: 10, patience: 2, cooldown: 5 });
  for (let i = 0; i < 200; i++) assert.equal(g.sample(1 / 60, 1 / 60, true, 'high'), null);
  let stepped = null;
  for (let i = 0; i < 20 && !stepped; i++) stepped = g.sample(1 / 20, 1 / 60, true, 'high');
  assert.equal(stepped, 'medium');
  // Five seconds of cooldown at 20 fps is 100 frames; none of them may step down again.
  for (let i = 0; i < 90; i++) assert.equal(g.sample(1 / 20, 1 / 60, true, 'medium'), null);
});

test('a pause or load frame is not counted as a late one', () => {
  const g = createAutoGovernor({ window: 5, patience: 1, cooldown: 1 });
  for (let i = 0; i < 50; i++) assert.equal(g.sample(2, 1 / 60, true, 'high'), null);
});

test('the resolution scaler reports when it has nothing left to take', () => {
  const s = createResScaler({ floor: 0.8, step: 0.1 });
  assert.equal(s.exhausted, false);
  // Late frames that improve with each step walk it down to the floor.
  let interval = 0.05;
  for (let i = 0; i < 400 && !s.exhausted; i++) {
    if (s.sample(interval, 1 / 60) !== null) interval *= 0.9;
  }
  assert.equal(s.exhausted, true);
  s.restore();
  assert.equal(s.exhausted, false);
});

test('AUTO resolves to the detected preset and a named preset ignores it', () => {
  Object.assign(settings, DEFAULT_SETTINGS);
  assert.equal(settings.quality, 'auto');
  setAutoTier('low');
  assert.equal(qualityKey(), 'low');
  assert.equal(activeQuality(), QUALITY.low);
  settings.quality = 'high';
  assert.equal(qualityKey(), 'high');
  setAutoTier('nonsense');
  settings.quality = 'auto';
  assert.equal(qualityKey(), 'low', 'an unknown tier is ignored');
  setAutoTier('medium');
});
