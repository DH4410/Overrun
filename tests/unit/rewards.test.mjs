import assert from 'node:assert/strict';
import test from 'node:test';

import { EMPTY_PROFILE, clean, withEquipped, xpToNext } from '../../src/profile.js';
import {
  DEFAULT_EQUIPPED, OPERATORS, SKINS, TITLES, TRACK_END, isUnlocked, levelRewards, nextReward, sanitizeEquipped, skinForGun,
} from '../../src/rewards.js';

/** A profile that has just reached `level`. */
function atLevel(level, extra = {}) {
  let xp = 0;
  for (let l = 1; l < level; l++) xp += xpToNext(l);
  return clean({ ...EMPTY_PROFILE, xp, ...extra });
}

test('a new player owns the starter operators and the stock finish only', () => {
  const p = atLevel(1);
  assert.ok(isUnlocked(p, 'operator', 'swat') && isUnlocked(p, 'operator', 'trooper'));
  assert.ok(!isUnlocked(p, 'operator', 'gasmask'));
  assert.ok(isUnlocked(p, 'skin', 'stock'));
  assert.ok(!isUnlocked(p, 'skin', 'desert'));
});

test('a reward unlocks exactly at its level, not a level before', () => {
  for (const o of OPERATORS) {
    assert.ok(!isUnlocked(atLevel(Math.max(1, o.level - 1)), 'operator', o.id) || o.level === 1, o.id);
    assert.ok(isUnlocked(atLevel(o.level), 'operator', o.id), o.id);
  }
  for (const s of SKINS) assert.ok(isUnlocked(atLevel(s.level), 'skin', s.id), s.id);
});

test('unknown ids are never unlocked', () => {
  const p = atLevel(50);
  assert.ok(!isUnlocked(p, 'operator', 'nobody'));
  assert.ok(!isUnlocked(p, 'skin', 'rainbow'));
  assert.ok(!isUnlocked(p, 'title', 'cheater'));
  assert.ok(!isUnlocked(p, 'bogus', 'swat'));
});

test('titles come from stats, and need every stat they name', () => {
  assert.ok(!isUnlocked(atLevel(1), 'title', 'headhunter'));
  assert.ok(isUnlocked(atLevel(1, { headshots: 50 }), 'title', 'headhunter'));
  assert.ok(isUnlocked(atLevel(1), 'title', ''), 'no title is always allowed');
  for (const t of TITLES) assert.equal(isUnlocked(atLevel(1, Object.fromEntries(Object.entries(t.need).map(([k, v]) => [k, v]))), 'title', t.id), true);
});

test('levelRewards lists what a level grants; level 1 grants nothing new', () => {
  assert.deepEqual(levelRewards(1), []);
  assert.deepEqual(levelRewards(2).map((r) => r.id), ['gasmask', 'desert']);
  assert.deepEqual(levelRewards(3).map((r) => r.id), ['crypto']);
  assert.ok(levelRewards(5).some((r) => r.kind === 'skin' && r.id === 'arctic'));
  assert.deepEqual(levelRewards(4).map((r) => r.id), ['ely']);
  assert.deepEqual(levelRewards(19), []);
});

test('nextReward finds the next level that grants something, and ends past the track', () => {
  assert.equal(nextReward(1).level, 2);
  assert.equal(nextReward(3).level, 4);
  assert.equal(nextReward(18).level, 20);
  assert.equal(nextReward(TRACK_END), null);
});

test('sanitizeEquipped falls back for anything not earned or not real', () => {
  const p = atLevel(1);
  assert.deepEqual(sanitizeEquipped(p, { operator: 'steve', skin: 'gold', title: 'champion' }), DEFAULT_EQUIPPED);
  assert.deepEqual(sanitizeEquipped(p, null), DEFAULT_EQUIPPED);
  const rich = atLevel(20, { wins: 25 });
  assert.deepEqual(sanitizeEquipped(rich, { operator: 'steve', skin: 'gold', title: 'champion' }), { operator: 'steve', skin: 'gold', title: 'champion', guns: {} });
});

test('every skin names only the material roles the guns actually have', () => {
  for (const s of SKINS) if (s.slots) for (const role of Object.keys(s.slots)) assert.ok(['polymer', 'alloy', 'steel'].includes(role));
});

test('the profile keeps what is worn, and rejects junk names', () => {
  const p = withEquipped(atLevel(1), { skin: 'desert' });
  assert.equal(p.equipped.skin, 'desert');
  assert.equal(clean({ equipped: { operator: '<script>', skin: 'x'.repeat(40) } }).equipped.operator, 'swat');
  assert.equal(clean({ equipped: { skin: 'x'.repeat(40) } }).equipped.skin, 'stock');
  assert.deepEqual(clean(null).equipped, DEFAULT_EQUIPPED);
});

test('every operator on the pass is a character the game can load, with a portrait', async () => {
  const { existsSync } = await import('node:fs');
  const { SKINS: CHARACTERS } = await import('../../src/skins.js');
  const known = new Set(CHARACTERS.map((c) => c.id));
  for (const o of OPERATORS) {
    assert.ok(known.has(o.id) || ['swat', 'trooper', 'gasmask', 'crypto', 'ely', 'steve'].includes(o.id), `${o.id} is not a known character`);
    assert.ok(existsSync(new URL(`../../assets/skins/${o.id}.jpg`, import.meta.url)), `${o.id} has no portrait`);
  }
  assert.equal(new Set(OPERATORS.map((o) => o.id)).size, OPERATORS.length, 'operator ids are unique');
});

test('a gun skin is worn only while it is in the collection, and it beats the finish worn on every gun', () => {
  const have = { ...atLevel(1), owned: ['skin:cobalt'] };
  const eq = sanitizeEquipped(have, { skin: 'stock', guns: { ar: 'cobalt', smg: 'magma' } });
  assert.deepEqual(eq.guns, { ar: 'cobalt' }, 'magma is not owned');
  assert.equal(skinForGun(eq, 'ar').id, 'cobalt');
  assert.equal(skinForGun(eq, 'smg').id, 'stock', 'a gun with no skin takes the finish');
  assert.equal(skinForGun({ skin: 'nope', guns: {} }, 'ar'), null);
});
