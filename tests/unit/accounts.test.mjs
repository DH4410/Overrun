import assert from 'node:assert/strict';
import test from 'node:test';

import { Accounts, AccountError, Throttle } from '../../server/accounts.js';
import { createAccountApi } from '../../server/accounts-http.js';
import { memoryStore } from '../../server/accounts-file.js';
import { EMPTY_PROFILE, clean, mergeProfiles } from '../../src/profile.js';

const fast = () => new Accounts({ store: memoryStore(), iterations: 1000 });
const GOOD = 'correct horse battery';

async function rejects(promise, code) {
  await assert.rejects(promise, (e) => e instanceof AccountError && e.code === code, `expected ${code}`);
}

test('sign up, then sign in by username or by email, in any case', async () => {
  const a = fast();
  const r = await a.register({ username: 'Viper', email: 'Viper@Example.com', password: GOOD });
  assert.equal(r.user.username, 'Viper');
  assert.match(r.recoveryCode, /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
  assert.equal((await a.login({ login: 'viper', password: GOOD })).user.username, 'Viper');
  assert.equal((await a.login({ login: 'VIPER@example.com', password: GOOD })).user.username, 'Viper');
});

test('usernames and emails are unique, case-insensitively', async () => {
  const a = fast();
  await a.register({ username: 'Viper', email: 'v@example.com', password: GOOD });
  await rejects(a.register({ username: 'vIPER', password: GOOD }), 'taken');
  await rejects(a.register({ username: 'Other', email: 'V@example.com', password: GOOD }), 'email_taken');
});

test('two sign-ups racing for one name: exactly one wins', async () => {
  const a = fast();
  const results = await Promise.allSettled([1, 2, 3, 4].map(() => a.register({ username: 'Racer', password: GOOD })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
});

test('bad input is refused with a reason', async () => {
  const a = fast();
  await rejects(a.register({ username: 'ab', password: GOOD }), 'username');
  await rejects(a.register({ username: 'has space', password: GOOD }), 'username');
  await rejects(a.register({ username: 'x'.repeat(13), password: GOOD }), 'username');
  await rejects(a.register({ username: 'Fine', email: 'not-an-email', password: GOOD }), 'email');
  await rejects(a.register({ username: 'Fine', password: 'short' }), 'password');
  await rejects(a.register({ username: 'Fine', password: 'x'.repeat(200) }), 'password');
});

test('the password is never stored, and a wrong one (or an unknown name) gives the same answer', async () => {
  const store = memoryStore();
  const a = new Accounts({ store, iterations: 1000 });
  await a.register({ username: 'Viper', password: GOOD });
  const rec = await store.get('u:viper');
  assert.ok(!JSON.stringify(rec).includes(GOOD));
  assert.equal(rec.pw.iter, 1000);
  await rejects(a.login({ login: 'viper', password: 'wrong wrong wrong' }), 'credentials');
  await rejects(a.login({ login: 'nobody', password: GOOD }), 'credentials');
  await rejects(a.login({ login: 'viper' }), 'credentials');
});

test('sessions: the token works, only its hash is stored, logout ends it', async () => {
  const store = memoryStore();
  const a = new Accounts({ store, iterations: 1000 });
  const { token } = await a.register({ username: 'Viper', password: GOOD });
  assert.equal((await a.session(token)).username, 'Viper');
  const rec = await store.get('u:viper');
  assert.ok(!JSON.stringify(rec).includes(token));
  assert.equal(await a.session('0'.repeat(64)), null);
  assert.equal(await a.session('not a token'), null);
  await a.logout(token);
  assert.equal(await a.session(token), null);
});

test('a session expires after 30 days', async () => {
  let t = 1_000_000;
  const a = new Accounts({ store: memoryStore(), iterations: 1000, now: () => t });
  const { token } = await a.register({ username: 'Viper', password: GOOD });
  t += 29 * 86_400_000;
  assert.ok(await a.session(token));
  t += 2 * 86_400_000;
  assert.equal(await a.session(token), null);
});

test('the career saves, comes back, and is checked', async () => {
  const a = fast();
  const { token } = await a.register({ username: 'Viper', password: GOOD });
  const u = await a.session(token);
  const saved = await a.saveProfile(u, { profile: { ...EMPTY_PROFILE, xp: 900, kills: 40, wins: 2 }, rev: 0 });
  assert.equal(saved.rev, 1);
  assert.equal((await a.login({ login: 'viper', password: GOOD })).profile.xp, 900);

  // Wrong revision: someone saved elsewhere.
  await rejects(a.saveProfile(u, { profile: { ...EMPTY_PROFILE, xp: 1000, kills: 40, wins: 2 }, rev: 0 }), 'conflict');
  // Going backwards, or impossible numbers.
  await rejects(a.saveProfile(u, { profile: { ...EMPTY_PROFILE, xp: 10 }, rev: 1 }), 'regress');
  await rejects(a.saveProfile(u, { profile: { ...EMPTY_PROFILE, xp: 5e9 }, rev: 1 }), 'range');
});

test('a career cannot wear what it has not earned', async () => {
  const a = fast();
  const { token } = await a.register({ username: 'Viper', password: GOOD });
  const u = await a.session(token);
  const r = await a.saveProfile(u, { profile: { ...EMPTY_PROFILE, xp: 10, equipped: { operator: 'steve', skin: 'gold', title: 'champion' } }, rev: 0 });
  assert.deepEqual(r.profile.equipped, { operator: 'swat', skin: 'stock', title: '' });
});

test('lost password: the recovery code resets it once, and issues a new code', async () => {
  const a = fast();
  const { recoveryCode } = await a.register({ username: 'Viper', password: GOOD });
  await rejects(a.recover({ login: 'viper', recoveryCode: 'AAAAA-AAAAA-AAAAA-AAAAA', password: 'a brand new one' }), 'recovery');
  const r = await a.recover({ login: 'viper', recoveryCode: recoveryCode.toLowerCase().replaceAll('-', ' '), password: 'a brand new one' });
  assert.notEqual(r.recoveryCode, recoveryCode);
  await rejects(a.login({ login: 'viper', password: GOOD }), 'credentials');
  assert.ok(await a.login({ login: 'viper', password: 'a brand new one' }));
  await rejects(a.recover({ login: 'viper', recoveryCode, password: 'yet another one' }), 'recovery');
});

test('changing the password signs every other device out', async () => {
  const a = fast();
  const first = await a.register({ username: 'Viper', password: GOOD });
  const second = await a.login({ login: 'viper', password: GOOD });
  const u = await a.session(second.token);
  await rejects(a.changePassword(u, { current: 'wrong wrong', password: 'another good one' }), 'credentials');
  const { token } = await a.changePassword(u, { current: GOOD, password: 'another good one' });
  assert.equal(await a.session(first.token), null);
  assert.equal(await a.session(second.token), null);
  assert.ok(await a.session(token));
});

test('deleting an account frees the name and the email', async () => {
  const a = fast();
  const { token } = await a.register({ username: 'Viper', email: 'v@example.com', password: GOOD });
  const u = await a.session(token);
  await rejects(a.deleteAccount(u, { password: 'wrong wrong' }), 'credentials');
  await a.deleteAccount(u, { password: GOOD });
  assert.equal(await a.session(token), null);
  assert.ok(await a.register({ username: 'Viper', email: 'v@example.com', password: GOOD }));
});

test('the throttle stops a guesser and forgives after the window', () => {
  let t = 0;
  const th = new Throttle({ limit: 3, windowMs: 1000, now: () => t });
  for (let i = 0; i < 3; i++) { assert.equal(th.wait('k'), 0); th.fail('k'); }
  assert.ok(th.wait('k') > 0);
  t += 1001;
  assert.equal(th.wait('k'), 0);
});

/* ---------------------------------- over HTTP ---------------------------------- */

function client() {
  const accounts = fast();
  const handle = createAccountApi({ accounts, throttle: new Throttle({ limit: 4 }) });
  let cookie = '';
  async function call(method, path, body, { headers = {}, ip = '1.2.3.4', base = 'http://game.test' } = {}) {
    const res = await handle(new Request(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), { ip });
    const set = res?.headers.get('set-cookie');
    if (set) cookie = set.startsWith('overrun_session=;') ? '' : set.split(';')[0];
    return { res, data: res ? await res.json() : null, set };
  }
  return { call, accounts, jar: () => cookie };
}

test('over HTTP: sign up sets an HttpOnly cookie, /api/me reads it, logout clears it', async () => {
  const c = client();
  const up = await c.call('POST', '/api/register', { username: 'Viper', password: GOOD });
  assert.equal(up.res.status, 201);
  assert.match(up.set, /HttpOnly/);
  assert.match(up.set, /SameSite=Lax/);
  assert.doesNotMatch(up.set, /Secure/, 'plain http (local development) must not set Secure');
  assert.ok(!('token' in up.data));
  const me = await c.call('GET', '/api/me');
  assert.equal(me.data.user.username, 'Viper');
  await c.call('POST', '/api/logout', {});
  const out = await c.call('GET', '/api/me');
  assert.equal(out.res.status, 200, 'signed out is a quiet 200, not a console-logged 401');
  assert.equal(out.data.user, null);
});

test('over HTTP: https gets a Secure cookie', async () => {
  const c = client();
  const up = await c.call('POST', '/api/register', { username: 'Viper', password: GOOD }, { base: 'https://game.test' });
  assert.match(up.set, /Secure/);
});

test('over HTTP: signed-out calls and cross-site or non-JSON calls are refused', async () => {
  const c = client();
  assert.equal((await c.call('PUT', '/api/profile', { profile: {}, rev: 0 })).res.status, 401);
  assert.equal((await c.call('POST', '/api/login', { login: 'x', password: 'y' }, { headers: { origin: 'https://evil.test' } })).res.status, 403);
  assert.equal((await c.call('POST', '/api/login', { login: 'x', password: 'y' }, { headers: { 'content-type': 'text/plain' } })).res.status, 415);
  assert.equal((await c.call('GET', '/api/nothing')).res.status, 401, 'unknown routes are not revealed to the signed-out');
});

test('over HTTP: five wrong passwords lock that address out, with Retry-After', async () => {
  const c = client();
  await c.call('POST', '/api/register', { username: 'Viper', password: GOOD });
  await c.call('POST', '/api/logout', {});
  for (let i = 0; i < 4; i++) assert.equal((await c.call('POST', '/api/login', { login: 'viper', password: 'wrong wrong' })).res.status, 401);
  const locked = await c.call('POST', '/api/login', { login: 'viper', password: GOOD });
  assert.equal(locked.res.status, 429);
  assert.ok(Number(locked.res.headers.get('retry-after')) > 0);
  // Another address is not affected by that one, but the account's own failures still count.
  assert.equal((await c.call('POST', '/api/login', { login: 'viper', password: GOOD }, { ip: '9.9.9.9' })).res.status, 429);
  assert.equal((await c.call('POST', '/api/login', { login: 'someoneelse', password: GOOD }, { ip: '9.9.9.9' })).res.status, 401);
});

test('over HTTP: only /api/ is handled, bad JSON is a 400, a huge body a 413', async () => {
  const c = client();
  assert.equal(await createAccountApi({ accounts: fast() })(new Request('http://game.test/index.html')), null);
  const bad = await createAccountApi({ accounts: fast() })(new Request('http://game.test/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' }));
  assert.equal(bad.status, 400);
  const big = await c.call('POST', '/api/login', { login: 'x'.repeat(20_000), password: 'y' });
  assert.equal(big.res.status, 413);
});

test('over HTTP: the career round-trips through the cookie, with a conflict on a stale revision', async () => {
  const c = client();
  await c.call('POST', '/api/register', { username: 'Viper', password: GOOD });
  const put = await c.call('PUT', '/api/profile', { profile: { ...EMPTY_PROFILE, xp: 300 }, rev: 0 });
  assert.equal(put.data.rev, 1);
  assert.equal((await c.call('GET', '/api/me')).data.profile.xp, 300);
  const stale = await c.call('PUT', '/api/profile', { profile: { ...EMPTY_PROFILE, xp: 400 }, rev: 0 });
  assert.equal(stale.res.status, 409);
});

test('mergeProfiles keeps the richer career and never lowers a counter', () => {
  const a = clean({ xp: 500, kills: 10, bestStreak: 2, equipped: { skin: 'desert' } });
  const b = clean({ xp: 100, kills: 30, bestStreak: 6 });
  const m = mergeProfiles(a, b);
  assert.equal(m.xp, 500);
  assert.equal(m.kills, 30);
  assert.equal(m.bestStreak, 6);
  assert.equal(m.equipped.skin, 'desert');
  assert.deepEqual(mergeProfiles(a, b), mergeProfiles(b, a));
});
