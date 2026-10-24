import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { WEAPON_BY_ID } from '../../src/sim/weaponData.js';

// match.js pulls in three.js, so the ladder is read from the source rather than imported.
const src = readFileSync(new URL('../../src/match.js', import.meta.url), 'utf8');
const ladder = JSON.parse(/export const GUN_LADDER = (\[.*?\]);/.exec(src)[1].replaceAll("'", '"'));

test('every rung of the Gun Game ladder is a real gun, with no repeats', () => {
  assert.ok(ladder.length >= 8);
  for (const id of ladder) assert.ok(WEAPON_BY_ID[id], `unknown gun ${id}`);
  assert.equal(new Set(ladder).size, ladder.length);
});

test('the ladder never hands out the grenade, and ends on a long-range gun', () => {
  assert.ok(!ladder.includes('frag'));
  assert.equal(ladder.at(-1), 'sniper');
});
