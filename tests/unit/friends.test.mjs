import assert from 'node:assert/strict';
import test from 'node:test';

import { Accounts, AccountError } from '../../server/accounts.js';
import { memoryStore } from '../../server/accounts-file.js';
import { Friends, INVITE_MS, MAX_PENDING, ONLINE_MS } from '../../server/friends.js';

async function world() {
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const accounts = new Accounts({ store: memoryStore(), iterations: 1000, now });
  const friends = new Friends({ store: accounts.store, accounts, now });
  const user = async (username) => {
    const r = await accounts.register({ username, password: 'correct horse battery' });
    return accounts.session(r.token);
  };
  return { clock, accounts, friends, user };
}
const rejects = (p, code) => assert.rejects(p, (e) => e instanceof AccountError && e.code === code, code);

test('a request waits until it is accepted, then both sides are friends', async () => {
  const { friends, user } = await world();
  const ann = await user('Ann'), bo = await user('Bob');
  const sent = await friends.request(ann, 'bob');                 // names are not case sensitive
  assert.deepEqual(sent.outgoing, ['Bob']);
  assert.deepEqual(sent.friends, []);
  assert.deepEqual((await friends.list(bo)).incoming, ['Ann']);
  const done = await friends.accept(bo, 'Ann');
  assert.deepEqual(done.friends.map((f) => f.username), ['Ann']);
  assert.deepEqual((await friends.list(ann)).friends.map((f) => f.username), ['Bob']);
  assert.deepEqual((await friends.list(ann)).outgoing, []);
});

test('asking someone who already asked you makes you friends at once', async () => {
  const { friends, user } = await world();
  const ann = await user('Ann'), bo = await user('Bob');
  await friends.request(ann, 'Bob');
  const r = await friends.request(bo, 'Ann');
  assert.deepEqual(r.friends.map((f) => f.username), ['Ann']);
  assert.deepEqual(r.incoming, []);
});

test('refuses yourself, strangers, repeats and non-requests', async () => {
  const { friends, user } = await world();
  const ann = await user('Ann'), bo = await user('Bob');
  await rejects(friends.request(ann, 'ann'), 'self');
  await rejects(friends.request(ann, 'nobody'), 'nouser');
  await rejects(friends.request(ann, ''), 'name');
  await friends.request(ann, 'Bob');
  await rejects(friends.request(ann, 'Bob'), 'sent');
  await rejects(friends.accept(ann, 'Bob'), 'norequest');          // you cannot accept your own request
  await friends.accept(bo, 'Ann');
  await rejects(friends.request(ann, 'Bob'), 'already');
});

test('declining or cancelling clears both sides, removing unfriends both sides', async () => {
  const { friends, user } = await world();
  const ann = await user('Ann'), bo = await user('Bob'), cy = await user('Cyd');
  await friends.request(ann, 'Bob');
  assert.deepEqual((await friends.decline(bo, 'Ann')).incoming, []);
  assert.deepEqual((await friends.list(ann)).outgoing, []);
  await friends.request(ann, 'Cyd');
  assert.deepEqual((await friends.decline(ann, 'Cyd')).outgoing, [], 'taking back a request');
  assert.deepEqual((await friends.list(cy)).incoming, []);
  await friends.request(ann, 'Bob'); await friends.accept(bo, 'Ann');
  await friends.remove(bo, 'Ann');
  assert.deepEqual((await friends.list(ann)).friends, []);
  assert.deepEqual((await friends.list(bo)).friends, []);
});

test('presence: online only while the page keeps checking in, and offline players show no status', async () => {
  const { friends, clock, user } = await world();
  const ann = await user('Ann'), bo = await user('Bob');
  await friends.request(ann, 'Bob'); await friends.accept(bo, 'Ann');
  assert.equal((await friends.list(ann)).friends[0].online, false);
  assert.equal((await friends.list(ann)).friends[0].status, 'offline');
  await friends.heartbeat(bo, 'online');
  const on = (await friends.list(ann)).friends[0];
  assert.deepEqual([on.online, on.status], [true, 'online']);
  clock.t += ONLINE_MS + 1;
  assert.equal((await friends.list(ann)).friends[0].online, false);
  await friends.heartbeat(bo, 'nonsense');                         // unknown status falls back to the lobby
  assert.equal((await friends.list(ann)).friends[0].status, 'lobby');
});

test('online friends sort first', async () => {
  const { friends, user } = await world();
  const ann = await user('Ann'), bo = await user('Bob'), cy = await user('Cyd');
  for (const o of [bo, cy]) { await friends.request(ann, o.username); await friends.accept(o, 'Ann'); }
  await friends.heartbeat(cy, 'solo');
  assert.deepEqual((await friends.list(ann)).friends.map((f) => f.username), ['Cyd', 'Bob']);
});

test('invites go to friends only, replace the last one, expire, and can be dismissed', async () => {
  const { friends, clock, user } = await world();
  const ann = await user('Ann'), bo = await user('Bob'), cy = await user('Cyd');
  await rejects(friends.invite(ann, 'Bob'), 'notfriend');
  await friends.request(ann, 'Bob'); await friends.accept(bo, 'Ann');
  await friends.invite(ann, 'Bob'); await friends.invite(ann, 'Bob');
  const got = (await friends.list(bo)).invites;
  assert.equal(got.length, 1);
  assert.equal(got[0].from, 'Ann');
  assert.deepEqual((await friends.dismiss(bo, 'Ann')).invites, []);
  await friends.invite(ann, 'Bob');
  clock.t += INVITE_MS + 1;
  assert.deepEqual((await friends.list(bo)).invites, [], 'expired');
  assert.deepEqual((await friends.list(cy)).invites, []);
});

test('unfriending withdraws that friend\'s pending invite', async () => {
  const { friends, user } = await world();
  const ann = await user('Ann'), bo = await user('Bob');
  await friends.request(ann, 'Bob'); await friends.accept(bo, 'Ann');
  await friends.invite(ann, 'Bob');
  await friends.remove(ann, 'Bob');
  assert.deepEqual((await friends.list(bo)).invites, []);
});

test('pending requests are capped, and a deleted account vanishes from the list', async () => {
  const { accounts, friends, user } = await world();
  const ann = await user('Ann');
  for (let i = 0; i < MAX_PENDING; i++) await friends.request(ann, (await user(`Pal${i}`)).username);
  await rejects(friends.request(ann, (await user('Late')).username), 'full');
  const bo = await user('Bob'), cy = await user('Cyd');
  await friends.request(bo, 'Cyd'); await friends.accept(cy, 'Bob');
  const r = await accounts.register({ username: 'Zed', password: 'correct horse battery' });
  const zed = await accounts.session(r.token);
  await friends.request(bo, 'Zed'); await friends.accept(zed, 'Bob');
  await accounts.deleteAccount(zed, { password: 'correct horse battery' });
  assert.deepEqual((await friends.list(bo)).friends.map((f) => f.username), ['Cyd']);
});

test('two people adding each other at the same moment do not deadlock', async () => {
  const { friends, user } = await world();
  const ann = await user('Ann'), bo = await user('Bob');
  await Promise.all([friends.request(ann, 'Bob'), friends.request(bo, 'Ann').catch(() => null)]);
  assert.equal((await friends.list(ann)).friends.length + (await friends.list(ann)).outgoing.length, 1);
});
