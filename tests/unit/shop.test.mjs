import assert from 'node:assert/strict';
import test from 'node:test';

import { Accounts, AccountError } from '../../server/accounts.js';
import { memoryStore } from '../../server/accounts-file.js';
import { EMPTY_PROFILE, applyMatch, clean, matchAward, mergeProfiles, xpToNext } from '../../src/profile.js';
import { isUnlocked } from '../../src/rewards.js';
import { CREDITS, GUN_PRICES, balance, buyGun, maxCredits, ownedValue, ownsGun } from '../../src/shop.js';

const rich = (credits) => clean({ ...EMPTY_PROFILE, credits });

test('a match pays credits in proportion to XP, and a level-up adds a bonus', () => {
  const win = { outcome: 'win', kills: 5, deaths: 2, headshots: 1, bestStreak: 3 };
  const r = applyMatch(EMPTY_PROFILE, win);
  assert.equal(r.award.credits, Math.round(r.award.total * CREDITS.PER_XP));
  assert.equal(r.profile.credits, r.award.credits);
  const near = { ...EMPTY_PROFILE, xp: xpToNext(1) - 5 };
  const up = applyMatch(near, win);
  assert.equal(up.leveledUp, true);
  assert.equal(up.credits, up.award.credits + CREDITS.LEVEL_UP);
  assert.equal(matchAward({ outcome: 'loss' }).credits > 0, true);
});

test('free guns are always owned, priced guns only once bought', () => {
  assert.equal(ownsGun(EMPTY_PROFILE, 'ar'), true);
  assert.equal(ownsGun(EMPTY_PROFILE, 'lmg'), false);
  assert.equal(isUnlocked(EMPTY_PROFILE, 'gun', 'lmg'), false);
});

test('buying takes the price, keeps the gun, and refuses what you cannot afford or already own', () => {
  assert.equal(buyGun(rich(GUN_PRICES.lmg - 1), 'lmg'), null);
  const bought = buyGun(rich(GUN_PRICES.lmg + 50), 'lmg');
  assert.equal(balance(bought), 50);
  assert.equal(ownsGun(bought, 'lmg'), true);
  assert.equal(buyGun(bought, 'lmg'), null, 'already owned');
  assert.equal(buyGun(rich(9999), 'ar'), null, 'free guns are not for sale');
});

test('a save keeps only items the shop sells, once each', () => {
  const p = clean({ owned: ['gun:lmg', 'gun:lmg', 'gun:rocket', 7, 'skin:gold'] });
  assert.deepEqual(p.owned, ['gun:lmg']);
});

test('merging two devices keeps every purchase and never refunds a spent credit', () => {
  const a = clean({ xp: 900, credits: 1000, spent: 400, owned: ['gun:mp'] });
  const b = clean({ xp: 700, credits: 900, spent: 500, owned: ['gun:revolver'] });
  const m = mergeProfiles(a, b);
  assert.deepEqual([...m.owned].sort(), ['gun:mp', 'gun:revolver']);
  assert.equal(m.spent, ownedValue(m.owned));
  assert.ok(m.credits >= m.spent);
  assert.ok(balance(m) <= 1000 - 900);
});

test('the server refuses invented credits, overspending and a refunded gun', async () => {
  const a = new Accounts({ store: memoryStore(), iterations: 1000 });
  const reg = await a.register({ username: 'Shopper', password: 'correct horse battery' });
  const u = await a.session(reg.token);
  const save = (profile, rev) => a.saveProfile(u, { profile, rev });
  const refused = (promise, code) => assert.rejects(promise, (e) => e instanceof AccountError && e.code === code);

  await refused(save({ ...EMPTY_PROFILE, xp: 0, credits: 5000 }, 0), 'range');                 // credits from nowhere
  await refused(save({ ...EMPTY_PROFILE, xp: 900, credits: 700, spent: 800 }, 0), 'range');    // spent more than earned
  await refused(save({ ...EMPTY_PROFILE, xp: 900, credits: 700, spent: 0, owned: ['gun:lmg'] }, 0), 'range'); // unpaid gun

  const ok = await save({ ...EMPTY_PROFILE, xp: 900, credits: 700, spent: 400, owned: ['gun:mp'] }, 0);
  assert.deepEqual(ok.profile.owned, ['gun:mp']);
  await refused(save({ ...EMPTY_PROFILE, xp: 900, credits: 700, spent: 400, owned: [] }, 1), 'regress'); // refunded gun
});

test('maxCredits grows with XP and level', () => {
  assert.ok(maxCredits(1000, 3) > maxCredits(100, 1));
});

test('a configured gift is paid once, survives saves and tops up when raised', async () => {
  const store = memoryStore();
  const mk = (grants) => new Accounts({ store, iterations: 1000, grants });
  let a = mk({ gifted: 5000 });
  const reg = await a.register({ username: 'Gifted', password: 'correct horse battery' });
  const other = await a.register({ username: 'Plain', password: 'correct horse battery' });
  let u = await a.session(reg.token);
  assert.equal(u.profile.credits, 5000);
  assert.equal((await a.session(other.token)).profile.credits, 0);
  u = await a.session(reg.token);
  assert.equal(u.profile.credits, 5000);                                  // not paid twice
  const bought = await a.saveProfile(u, { profile: { ...u.profile, spent: 400, owned: ['gun:mp'] }, rev: u.rev });
  assert.equal(balance(bought.profile), 4600);                            // the gift can be spent
  a = mk({ gifted: 8000 });
  assert.equal(balance((await a.session(reg.token)).profile), 7600);     // raising it pays the difference
  const login = await a.login({ login: 'Gifted', password: 'correct horse battery' });
  assert.equal(balance(login.profile), 7600);
});
