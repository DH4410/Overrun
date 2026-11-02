import assert from 'node:assert/strict';
import test from 'node:test';

import { Accounts, AccountError } from '../../server/accounts.js';
import { memoryStore } from '../../server/accounts-file.js';
import { CRATE_PRICE, CRATE_SKINS, dailyShop, gunSkinInfo, skinKey, supplyCap } from '../../src/gunskins.js';
import { marketValue } from '../../src/market.js';
import { clean } from '../../src/profile.js';
import { balance, ownedValue } from '../../src/shop.js';

const DAY = 86_400_000;
const NOW = 20_000 * DAY + 3_600_000;
const GOOD = 'correct horse battery';
const first = () => 0;                                   // the crate's first draw, every time: the test does not depend on luck

const fail = (promise, code) => assert.rejects(promise, (e) => e instanceof AccountError && e.code === code, `expected ${code}`);

function world(grants = {}) {
  const store = memoryStore();
  return { store, a: new Accounts({ store, iterations: 1000, grants, now: () => NOW }) };
}

/** Sign up and sign in, which also pays any gift configured for the name. */
async function player(a, name) {
  const r = await a.register({ username: name, password: GOOD });
  return { token: r.token, u: await a.session(r.token) };
}

const again = async (a, token) => a.session(token);

test('a crate is paid for, mints one copy, and the same skin is never handed out twice', async () => {
  const { a } = world({ ana: 5000 });
  const { u } = await player(a, 'ana');
  const r1 = await a.openCrateFor(u, { rng: first });
  assert.ok(CRATE_SKINS.some((k) => k.id === r1.skin));
  assert.equal(r1.profile.spent, CRATE_PRICE);
  assert.ok(r1.profile.owned.includes(skinKey(r1.skin)));
  assert.equal(ownedValue(r1.profile.owned), r1.profile.spent, 'what is owned is exactly what was paid');
  const r2 = await a.openCrateFor(u, { rng: first });
  assert.notEqual(r2.skin, r1.skin, 'the second crate skips the skin already held');
});

test('a crate is refused when the copies are all minted, and nothing is charged', async () => {
  const { a, store } = world({ ana: 5000 });
  const { u, token } = await player(a, 'ana');
  await store.put('supply', Object.fromEntries(CRATE_SKINS.map((k) => [k.id, supplyCap(k.id)])));
  await fail(a.openCrateFor(u, { rng: first }), 'sold_out');
  assert.equal((await again(a, token)).profile.spent, 0);
});

test('a crate with too few credits is refused, and mints nothing', async () => {
  const { a, store } = world({});
  const { u } = await player(a, 'pat');
  await fail(a.openCrateFor(u, { rng: first }), 'poor');
  assert.equal(await store.get('supply'), undefined);
});

test('a shop skin is bought once, only while on sale, and it counts against its supply', async () => {
  const { a, store } = world({ sam: 9000 });
  const { u, token } = await player(a, 'sam');
  const [on] = dailyShop(NOW);
  const r = await a.buyShopFor(u, on.id, { now: NOW });
  assert.ok(r.profile.owned.includes(skinKey(on.id)));
  assert.equal(r.profile.spent, on.price);
  assert.equal((await store.get('supply'))[on.id], 1);
  await fail(a.buyShopFor(u, on.id, { now: NOW }), 'owned');
  const off = gunSkinInfo(CRATE_SKINS[0].id);
  await fail(a.buyShopFor(u, off.id, { now: NOW }), 'not_on_sale');
  assert.equal((await again(a, token)).profile.spent, on.price);
});

test('a market sale: the buyer is charged and gets the skin, the seller loses it and is paid, and no copy is minted', async () => {
  const { a, store } = world({ ana: 5000, ben: 5000 });
  const seller = await player(a, 'ana');
  const buyer = await player(a, 'ben');
  const { skin } = await a.openCrateFor(seller.u, { rng: first });
  const key = skinKey(skin);
  const price = gunSkinInfo(skin).price + 150;
  const { listing } = await a.listSkin(seller.u, { skin, price });
  const minted = JSON.stringify(await store.get('supply'));

  await a.buyListing(buyer.u, listing.id);

  const b = await again(a, buyer.token);
  assert.ok(b.profile.owned.includes(key), 'the buyer has the skin');
  assert.equal(b.profile.owned.filter((k) => k === key).length, 1, 'exactly one copy');
  assert.equal(balance(b.profile), 5000 - price, 'the buyer paid the listing price');
  const s = await again(a, seller.token);
  assert.ok(!s.profile.owned.includes(key), 'the seller lost the skin');
  assert.equal(balance(s.profile), 5000 - CRATE_PRICE + price, 'the seller was paid the same');
  assert.equal(JSON.stringify(await store.get('supply')), minted, 'a sale mints nothing');
  assert.equal(ownedValue(b.profile.owned) <= b.profile.spent, true);
  assert.equal(ownedValue(s.profile.owned) <= s.profile.spent, true);
});

test('a stale device cannot bring a sold skin back', async () => {
  const { a } = world({ ana: 5000, ben: 5000 });
  const seller = await player(a, 'ana');
  const buyer = await player(a, 'ben');
  const { skin } = await a.openCrateFor(seller.u, { rng: first });
  const key = skinKey(skin);
  const { listing } = await a.listSkin(seller.u, { skin, price: gunSkinInfo(skin).price });
  await a.buyListing(buyer.u, listing.id);
  const after = await again(a, seller.token);
  const stale = clean({ ...after.profile, owned: [...after.profile.owned, key] });   // the old device still has it
  const saved = await a.saveProfile(after, { profile: stale, rev: after.rev });
  assert.ok(!saved.profile.owned.includes(key), 'the save does not add it back');
  assert.ok(!(await again(a, seller.token)).profile.owned.includes(key));
});

test('a buyer without enough credits is refused, and the listing stays for sale', async () => {
  const { a } = world({ ana: 5000 });
  const seller = await player(a, 'ana');
  const poor = await player(a, 'cal');
  const { skin } = await a.openCrateFor(seller.u, { rng: first });
  const { listing } = await a.listSkin(seller.u, { skin, price: gunSkinInfo(skin).price });
  await fail(a.buyListing(poor.u, listing.id), 'poor');
  assert.ok((await a.market(poor.u)).listings.some((l) => l.id === listing.id));
});

test('you cannot buy your own listing', async () => {
  const { a } = world({ ana: 5000 });
  const seller = await player(a, 'ana');
  const { skin } = await a.openCrateFor(seller.u, { rng: first });
  const { listing } = await a.listSkin(seller.u, { skin, price: gunSkinInfo(skin).price });
  await fail(a.buyListing(seller.u, listing.id), 'own_listing');
});

test('you can only list a skin you own, once', async () => {
  const { a } = world({ ana: 5000 });
  const seller = await player(a, 'ana');
  const { skin } = await a.openCrateFor(seller.u, { rng: first });
  await fail(a.listSkin(seller.u, { skin: CRATE_SKINS[CRATE_SKINS.length - 1].id, price: 999 }), 'not_owned');
  await fail(a.listSkin(seller.u, { skin, price: gunSkinInfo(skin).price - 1 }), 'price');
  await a.listSkin(seller.u, { skin, price: gunSkinInfo(skin).price });
  await fail(a.listSkin(seller.u, { skin, price: gunSkinInfo(skin).price + 5 }), 'listed');
});

test('a listing can be cancelled by its seller only', async () => {
  const { a } = world({ ana: 5000, ben: 5000 });
  const seller = await player(a, 'ana');
  const other = await player(a, 'ben');
  const { skin } = await a.openCrateFor(seller.u, { rng: first });
  const { listing } = await a.listSkin(seller.u, { skin, price: gunSkinInfo(skin).price });
  await fail(a.cancelListing(other.u, listing.id), 'not_listed');
  await a.cancelListing(seller.u, listing.id);
  assert.equal((await a.market(seller.u)).listings.length, 0);
});

test('a career saved before the rework syncs unchanged: its old skin ids are still valid', async () => {
  const { a, store } = world({});
  const { token, u } = await player(a, 'olda');
  const rec = await store.get(`u:${u.usernameLc}`);
  rec.profile = clean({ xp: 1500, credits: 1000, spent: 1000, owned: ['skin:aurora', 'skin:chrome'], equipped: { guns: { ar: 'aurora' } } });
  rec.rev = 3;
  await store.put(`u:${u.usernameLc}`, rec);
  const cur = await again(a, token);
  const kept = await a.saveProfile(cur, { profile: rec.profile, rev: 3 });
  assert.deepEqual([...kept.profile.owned].sort(), ['skin:aurora', 'skin:chrome']);
  assert.deepEqual(kept.profile.equipped.guns, { ar: 'aurora' });
  const again2 = await a.saveProfile(cur, { profile: kept.profile, rev: kept.rev });
  assert.deepEqual([...again2.profile.owned].sort(), ['skin:aurora', 'skin:chrome']);
});

test('market value climbs as copies run out, and recent sales pull it toward what people paid', () => {
  const id = CRATE_SKINS[0].id;
  const cap = supplyCap(id);
  const price = CRATE_SKINS[0].price;
  assert.equal(marketValue(id, 0, []), price, 'a fresh skin is worth its price');
  assert.ok(marketValue(id, Math.floor(cap / 2), []) > price);
  assert.ok(marketValue(id, cap - 1, []) > marketValue(id, Math.floor(cap / 2), []), 'the last copies cost most');
  assert.ok(marketValue(id, cap - 1, []) <= price * 6, 'scarcity is capped at six times');
  assert.ok(marketValue(id, 0, [price * 3, price * 3]) > price, 'a sale above the price lifts it');
  assert.equal(marketValue(id, 0, [1]), price, 'a sale below the price never pulls it under');
});
