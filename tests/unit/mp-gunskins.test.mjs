import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cleanGunSkins } from '../../server/room.js';
import { join, makeRoom } from './room-kit.mjs';

/** Gun finishes are cosmetic: the room bounds them and relays them in the roster so everyone sees your gun. */

test('only known guns with plain ids survive, and no more than a few', () => {
  assert.deepEqual(cleanGunSkins({ ar: 'gold_vein', pistol: 'x'.repeat(41), bogus: 'a', smg: { evil: 1 }, shotgun: '<img>' }), { ar: 'gold_vein' });
  assert.deepEqual(cleanGunSkins(null), {});
  assert.deepEqual(cleanGunSkins('ar'), {});
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`g${i}`, 'a']));
  assert.deepEqual(cleanGunSkins(many), {});
});

test('a finish sent with hello is in the roster, and a later gear message changes it, even mid-round', () => {
  const { room } = makeRoom();
  const a = join(room, 'A', { skins: { ar: 'gold_vein' } });
  const rec = () => room.roster().find((r) => r.id === a.p.id);
  assert.deepEqual(rec().skins, { ar: 'gold_vein' });
  a.say({ t: 'gear', skins: { ar: 'ember', sniper: 'frost' } });
  assert.deepEqual(rec().skins, { ar: 'ember', sniper: 'frost' });
  a.say({ t: 'gear', skins: {} });
  assert.equal(rec().skins, undefined, 'nothing worn, nothing sent');
});
