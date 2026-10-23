import assert from 'node:assert/strict';
import test from 'node:test';

import { ROOM_CAPACITY, describeRoom } from '../../src/online.js';

const report = (extra = {}) => ({ players: 3, spectators: 1, held: 0, phase: 'PLAYING', mode: 'tdm', map: 'desert', rtt: { VIPER: 41.6, HAVOC: 80 }, budget: { exhausted: false }, ...extra });

test('a reachable room reads as online, with the numbers a player wants', () => {
  const v = describeRoom(report(), 38.2);
  assert.equal(v.state, 'online');
  assert.equal(v.players, `3 / ${ROOM_CAPACITY} · 1 WATCHING`);
  assert.equal(v.now, 'TEAM DEATHMATCH · DESERT');
  assert.equal(v.phase, 'ROUND IN PROGRESS');
  assert.equal(v.ping, '38 MS');
  assert.deepEqual(v.roster, [{ name: 'VIPER', ping: 42 }, { name: 'HAVOC', ping: 80 }]);
  assert.ok(v.canJoin && v.canWatch);
});

test('no answer is an offline server, not a crash', () => {
  for (const bad of [null, undefined, 'x']) {
    const v = describeRoom(bad);
    assert.equal(v.state, 'offline');
    assert.equal(v.canJoin, false);
    assert.match(v.note, /Solo play is unaffected/);
  }
});

test('a full room still lets you watch; a closed one does not', () => {
  const full = describeRoom(report({ players: ROOM_CAPACITY }));
  assert.equal(full.state, 'full');
  assert.equal(full.canJoin, false);
  assert.equal(full.canWatch, true);
  const closed = describeRoom(report({ budget: { exhausted: true, resetInSec: 7200 } }));
  assert.equal(closed.state, 'closed');
  assert.equal(closed.canJoin, false);
  assert.equal(closed.canWatch, false);
  assert.match(closed.note, /about 2 h/);
});

test('between rounds says it is voting; unknown modes and a long roster are handled', () => {
  assert.equal(describeRoom(report({ phase: 'INTERMISSION' })).phase, 'BETWEEN ROUNDS · VOTING');
  assert.equal(describeRoom(report({ mode: 'surprise' })).now.startsWith('SURPRISE'), true);
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`P${i}`, 20]));
  assert.equal(describeRoom(report({ rtt: many })).roster.length, ROOM_CAPACITY);
});
