import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settings, tuning, saverActive, _setPower, DEFAULT_SETTINGS } from '../../src/settings.js';

test('saver is off while plugged in and engages when unplugged with auto on', () => {
  Object.assign(settings, DEFAULT_SETTINGS, { quality: 'high', frameCap: 120 });
  _setPower({ charging: true, level: 1, known: true });
  assert.equal(saverActive(), false);
  assert.equal(tuning().frameCap, 120);
  _setPower({ charging: false, level: 0.8, known: true });
  assert.equal(saverActive(), true);
  const t = tuning();
  assert.equal(t.frameCap, 60);
  assert.equal(t.maxPixelRatio, 1);
  assert.equal(t.detail, false);
  assert.ok(t.lights <= 6 && t.renderScale <= 0.85);
});

test('critical battery drops the cap to 30 and auto off ignores the battery', () => {
  Object.assign(settings, DEFAULT_SETTINGS);
  _setPower({ charging: false, level: 0.1, known: true });
  assert.equal(tuning().frameCap, 30);
  settings.powerAuto = false;
  assert.equal(saverActive(), false);
  settings.powerSaver = true;
  assert.equal(saverActive(), true);
});

test('the saver never raises a Performance profile', () => {
  Object.assign(settings, DEFAULT_SETTINGS, { quality: 'low', powerSaver: true });
  const t = tuning();
  assert.ok(t.renderScale <= 0.75 && t.lights <= 4);
});
