import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../../src/config.js';
import { MAP_DATA } from '../../src/sim/mapData.js';
import { mapHash } from '../../src/sim/protocol.js';
import { WEAPONS } from '../../src/sim/weaponData.js';
import { HASH } from '../mp/wsclient.mjs';

const colliders = { port: { boxes: [[0, 0, 0, 1, 1, 1, 0, 1]] }, desert: {}, snow: {} };

test('the map hash ignores presentation settings the game changes at runtime', () => {
  const a = mapHash(colliders, MAP_DATA, CONFIG, WEAPONS);
  const keep = [CONFIG.MAX_DECALS, CONFIG.SENS];
  CONFIG.MAX_DECALS = 7; CONFIG.SENS = 0.5;
  const b = mapHash(colliders, MAP_DATA, CONFIG, WEAPONS);
  [CONFIG.MAX_DECALS, CONFIG.SENS] = keep;
  assert.equal(a, b);
});

test('the map hash changes with a gameplay constant, a weapon or a collider', () => {
  const a = mapHash(colliders, MAP_DATA, CONFIG, WEAPONS);
  const g = CONFIG.JUMP_SPEED;
  CONFIG.JUMP_SPEED = g + 0.1;
  assert.notEqual(mapHash(colliders, MAP_DATA, CONFIG, WEAPONS), a);
  CONFIG.JUMP_SPEED = g;
  assert.notEqual(mapHash(colliders, MAP_DATA, CONFIG, WEAPONS.map((w) => ({ ...w, damage: w.damage + 1 }))), a);
  assert.notEqual(mapHash({ ...colliders, port: { boxes: [[0, 0, 0, 1, 1, 2, 0, 1]] } }, MAP_DATA, CONFIG, WEAPONS), a);
  assert.match(HASH, /^[0-9a-f]{8}$/);
});
