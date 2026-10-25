import assert from 'node:assert/strict';
import test from 'node:test';

import { GUN_LADDER as ladder } from '../../src/sim/modes.js';
import { WEAPON_BY_ID } from '../../src/sim/weaponData.js';

test('every rung of the Gun Game ladder is a real gun, with no repeats', () => {
  assert.ok(ladder.length >= 8);
  for (const id of ladder) assert.ok(WEAPON_BY_ID[id], `unknown gun ${id}`);
  assert.equal(new Set(ladder).size, ladder.length);
});

test('the ladder never hands out the grenade, and ends on a long-range gun', () => {
  assert.ok(!ladder.includes('frag'));
  assert.equal(ladder.at(-1), 'sniper');
});
