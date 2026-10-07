import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CLOSE, PHASE } from '../../src/sim/protocol.js';
import { join, makeRoom, run, startRound } from './room-kit.mjs';

/** Seats and the host's powers: no doubled players, kicking, sending everyone back to the lobby. */

const humans = (room) => room.players.filter((p) => !p.bot);

test('a returning token takes over its seat even when the old socket still looks open', () => {
  const { room } = makeRoom();
  const A = join(room, 'A'), B = join(room, 'B');
  assert.equal(humans(room).length, 2);
  const again = join(room, 'B', { token: B.p.token });
  assert.equal(humans(room).length, 2, 'no second B');
  assert.equal(again.p, B.p, 'same seat');
  assert.ok(B.p.connected && B.p.conn === again.conn);
  assert.equal(B.conn.closed, CLOSE.REPLACED, 'the stale socket is closed');
  assert.ok(A.p.connected);
});

test('a socket that goes silent is dropped and its seat is held, not doubled', () => {
  const { room, clock } = makeRoom();
  const A = join(room, 'A'), B = join(room, 'B');
  run(room, 1);
  for (let i = 0; i < 8; i++) { clock.t += 10_000; run(room, 1); A.say({ t: 'ka' }); }   // A keeps talking, B does not
  assert.equal(B.conn.closed, 1001, 'B timed out');
  assert.ok(!B.p.connected);
  assert.ok(A.p.connected && A.conn.closed === null);
  const back = join(room, 'B', { token: B.p.token });
  assert.equal(humans(room).length, 2);
  assert.equal(back.p, B.p);
});

test('only the host kicks; the seat goes at once and the token is refused for a while', () => {
  const { room, clock } = makeRoom();
  const A = join(room, 'A'), B = join(room, 'B'), C = join(room, 'C');
  const token = B.p.token;
  B.say({ t: 'kick', id: C.p.id });
  assert.equal(humans(room).length, 3, 'a guest cannot kick');
  A.say({ t: 'kick', id: A.p.id });
  assert.equal(humans(room).length, 3, 'the host cannot kick themself');
  A.say({ t: 'kick', id: B.p.id });
  assert.equal(humans(room).length, 2);
  assert.equal(B.conn.closed, CLOSE.KICKED);
  const retry = join(room, 'B', { token });
  assert.equal(retry.conn.closed, CLOSE.KICKED, 'refused at the door');
  assert.equal(humans(room).length, 2);
  clock.t += 130_000;
  run(room, 2);
  const later = join(room, 'B', { token });
  assert.equal(later.conn.closed, null, 'the ban runs out');
});

test('the host sends everyone back to the lobby from a running round; a guest cannot', () => {
  const { room } = makeRoom();
  const A = join(room, 'A'), B = join(room, 'B');
  startRound(room, [A, B], { mode: 'dm' });
  B.say({ t: 'lobby' });
  assert.equal(room.phase, PHASE.PLAYING, 'a guest cannot');
  A.say({ t: 'lobby' });
  assert.equal(room.phase, PHASE.LOBBY);
  assert.ok(!A.p.ready && !B.p.ready);
});

test('when everyone else leaves a round that needs company, the host is returned to the lobby', () => {
  const { room } = makeRoom();
  const A = join(room, 'A'), B = join(room, 'B');
  startRound(room, [A, B], { mode: 'dm' });
  B.conn.close = () => {};
  room.close(B.conn);
  run(room, 10);
  assert.equal(room.phase, PHASE.PLAYING, 'a blip as long as the client\'s whole retry window does not end the round');
  run(room, 7);
  assert.equal(room.phase, PHASE.LOBBY);
});

test('kicking a flag carrier sends the flag home', () => {
  const { room } = makeRoom();
  const A = join(room, 'A'), B = join(room, 'B');
  startRound(room, [A, B], { mode: 'ctf', map: 'bastion' });
  const flag = room.flags.find((f) => f.team !== B.p.team);
  flag.state = 'carried'; flag.carrier = B.p.id;
  A.say({ t: 'kick', id: B.p.id });
  run(room, 1);
  assert.notEqual(flag.state, 'carried');
  assert.equal(flag.carrier, null);
});

test('kicking a duelist ends the duel instead of leaving it hanging', () => {
  const { room } = makeRoom();
  const A = join(room, 'A'), B = join(room, 'B');
  startRound(room, [A, B], { mode: 'duel', map: 'depot' });
  A.say({ t: 'kick', id: B.p.id });
  run(room, 6);
  assert.notEqual(room.phase, PHASE.PLAYING, 'a duel with one person left does not carry on');
});

test('a friend who reconnects inside the grace period keeps the round going', () => {
  const { room } = makeRoom();
  const A = join(room, 'A'), B = join(room, 'B');
  startRound(room, [A, B], { mode: 'dm' });
  const token = B.p.token;
  room.close(B.conn);
  run(room, 4);
  join(room, 'B', { token });
  run(room, 10);
  assert.equal(room.phase, PHASE.PLAYING);
});
