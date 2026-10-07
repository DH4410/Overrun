import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_SETTINGS, aimToggles, assistLevel, lookBoost, settings } from '../../src/settings.js';

test('the touchpad switch turns the friendly options on without touching the individual ones', () => {
  Object.assign(settings, DEFAULT_SETTINGS);
  assert.equal(aimToggles(), false);
  assert.equal(lookBoost(), false);
  assert.equal(assistLevel(), DEFAULT_SETTINGS.aimAssist);

  settings.touchpad = true;
  assert.equal(aimToggles(), true);
  assert.equal(lookBoost(), true);
  assert.equal(settings.toggleAim, false);       // untouched: switching back puts everything back
  assert.equal(settings.trackpadLook, false);

  settings.touchpad = false;
  assert.equal(aimToggles(), false);
  Object.assign(settings, DEFAULT_SETTINGS);
});

test('on a touchpad aim assist is at least friction-only, and never lowered by the player having it higher', () => {
  Object.assign(settings, DEFAULT_SETTINGS, { touchpad: true, aimAssist: 0 });
  assert.equal(assistLevel(), 0.5);
  settings.aimAssist = 0.8;
  assert.equal(assistLevel(), 0.8);
  Object.assign(settings, DEFAULT_SETTINGS);
});
