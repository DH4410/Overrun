import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CRATE_PRICE, CRATE_SKINS, GUN_SKINS, PATTERNS, RARITY, SHOP_SKINS, SHOP_SLOTS, dailyShop, rollCrate, shopDay, shopEndsAt, skinKey,
} from '../../src/gunskins.js';
import { clean, mergeProfiles } from '../../src/profile.js';
import { balance, buyShopSkin, openCrate, ownedValue, ownsSkin } from '../../src/shop.js';
import { Accounts, AccountError } from '../../server/accounts.js';
import { memoryStore } from '../../server/accounts-file.js';

const rich = (credits) => clean({ xp: 0, credits, spent: 0, owned: [] });
const DAY = 86_400_000;

test('every skin is well formed, and the crate and shop pools never overlap', () => {
  const ids = GUN_SKINS.map((k) => k.id);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  for (const k of GUN_SKINS) {
    assert.match(k.id, /^[a-z0-9_-]{1,24}$/);
    assert.ok(RARITY[k.rarity], k.rarity);
    for (const role of ['polymer', 'alloy', 'steel']) {
      const [hex, rough, metal, glow = 0] = k.slots[role];
      assert.ok(hex >= 0 && hex <= 0xffffff && glow >= 0 && glow <= 0xffffff);
      assert.ok(rough >= 0 && rough <= 1 && metal >= 0 && metal <= 1);
    }
  }
  for (const k of GUN_SKINS) {
    for (const [role, name] of Object.entries(k.tex ?? {})) {
      assert.ok(k.slots[role], `${k.id}: ${role} is a real role`);
      assert.ok(PATTERNS[name], `${k.id} names a pattern that exists: ${name}`);
    }
  }
  const drawn = readFileSync(new URL('../../src/gunTextures.js', import.meta.url), 'utf8');
  for (const name of Object.keys(PATTERNS)) assert.match(drawn, new RegExp(`\\b${name}[(:]`), `${name} has a drawing routine`);
  assert.ok(CRATE_SKINS.every((k) => k.source === 'crate' && k.price === CRATE_PRICE));
  assert.ok(SHOP_SKINS.every((k) => k.source === 'shop' && k.price > CRATE_PRICE));
  assert.ok(SHOP_SKINS.length >= SHOP_SLOTS + 2, 'the shop has more than one day of stock');
});

test('the daily shop is the same for everyone all day, and turns over at 00:00 UTC', () => {
  const noon = 20_000 * DAY + 12 * 3_600_000;
  const a = dailyShop(noon).map((k) => k.id);
  assert.equal(a.length, SHOP_SLOTS);
  assert.equal(new Set(a).size, SHOP_SLOTS);
  assert.deepEqual(dailyShop(noon + 3_600_000).map((k) => k.id), a);
  assert.equal(shopEndsAt(noon), 20_001 * DAY);
  assert.equal(shopDay(shopEndsAt(noon)), shopDay(noon) + 1);
  const days = new Set();
  for (let d = 0; d < 30; d++) days.add(dailyShop((20_000 + d) * DAY).map((k) => k.id).join());
  assert.ok(days.size > 10, 'the shop actually rotates');
});

test('a crate takes its price, gives one skin you did not have, and never repeats one', () => {
  let p = rich(CRATE_PRICE * CRATE_SKINS.length + 5);
  const got = [];
  for (let i = 0; i < CRATE_SKINS.length; i++) {
    const r = openCrate(p);
    assert.ok(r, `crate ${i}`);
    assert.ok(!got.includes(r.skin));
    got.push(r.skin);
    p = r.profile;
    assert.equal(ownedValue(p.owned), p.spent, 'what is owned is exactly what was paid');
  }
  assert.equal(balance(p), 5);
  assert.equal(openCrate(p), null, 'the pool is empty, so no more crates');
  assert.ok(got.every((id) => CRATE_SKINS.some((k) => k.id === id)));
});

test('a crate refuses when you cannot pay, and charges nothing', () => {
  assert.equal(openCrate(rich(CRATE_PRICE - 1)), null);
});

test('rarity follows the weights: commons are most draws, legendaries the fewest', () => {
  let seed = 7;
  const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const n = { common: 0, rare: 0, epic: 0, legendary: 0 };
  for (let i = 0; i < 4000; i++) { const id = rollCrate([], rng); n[CRATE_SKINS.find((k) => k.id === id).rarity]++; }
  assert.ok(n.common > n.rare && n.rare > n.epic && n.epic > n.legendary, JSON.stringify(n));
  assert.ok(n.legendary > 0);
  // Having finished a tier moves the weight to the ones left.
  const noCommon = CRATE_SKINS.filter((k) => k.rarity === 'common').map((k) => skinKey(k.id));
  const next = rollCrate(noCommon, rng);
  assert.ok(CRATE_SKINS.find((k) => k.id === next).rarity !== 'common');
});

test('shop skins can only be bought while on sale, once, and with enough credits', () => {
  const now = 20_000 * DAY + 5_000;
  const [on] = dailyShop(now);
  const off = SHOP_SKINS.find((k) => !dailyShop(now).some((d) => d.id === k.id));
  assert.equal(buyShopSkin(rich(99999), off.id, now), null, 'not on sale today');
  assert.equal(buyShopSkin(rich(on.price - 1), on.id, now), null, 'too dear');
  assert.equal(buyShopSkin(rich(99999), CRATE_SKINS[0].id, now), null, 'crate skins are not sold');
  const bought = buyShopSkin(rich(on.price + 7), on.id, now);
  assert.equal(balance(bought), 7);
  assert.ok(ownsSkin(bought, on.id));
  assert.equal(buyShopSkin(bought, on.id, now), null, 'already owned');
});

test('a save keeps real skins and the skin each gun wears, and drops the rest', () => {
  const p = clean({ owned: ['skin:cobalt', 'skin:cobalt', 'skin:nope', 'gun:lmg'], equipped: { guns: { ar: 'cobalt', 'bad key!': 'x', smg: 7 } } });
  assert.deepEqual(p.owned, ['skin:cobalt', 'gun:lmg']);
  assert.deepEqual(p.equipped.guns, { ar: 'cobalt' });
});

test('merging two devices keeps skins from both', () => {
  const a = clean({ xp: 900, credits: 1000, spent: CRATE_PRICE, owned: ['skin:slate'] });
  const b = clean({ xp: 700, credits: 900, spent: CRATE_PRICE, owned: ['skin:jade'] });
  const m = mergeProfiles(a, b);
  assert.deepEqual([...m.owned].sort(), ['skin:jade', 'skin:slate']);
  assert.equal(m.spent, 2 * CRATE_PRICE);
});

test('the server refuses a skin that was never paid for, and one taken back', async () => {
  const a = new Accounts({ store: memoryStore(), iterations: 1000 });
  const reg = await a.register({ username: 'Collector', password: 'correct horse battery' });
  const u = await a.session(reg.token);
  const save = (profile, rev) => a.saveProfile(u, { profile, rev });
  const refused = (promise, code) => assert.rejects(promise, (e) => e instanceof AccountError && e.code === code);
  await refused(save(clean({ xp: 1000, credits: 800, spent: 0, owned: ['skin:aurora'] }), 0), 'range');
  const paid = clean({ xp: 1000, credits: 800, spent: CRATE_PRICE, owned: ['skin:aurora'] });
  const ok = await save(paid, 0);
  assert.deepEqual(ok.profile.owned, ['skin:aurora']);
  await refused(save(clean({ ...paid, owned: [] }), ok.rev), 'regress');
  // Wearing is checked too: a skin you do not own is dropped from what you wear.
  const worn = await save(clean({ ...paid, equipped: { guns: { ar: 'aurora', smg: 'void' } } }), ok.rev);
  assert.deepEqual(worn.profile.equipped.guns, { ar: 'aurora' });
});
