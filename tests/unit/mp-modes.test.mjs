import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG, TEAM } from '../../src/config.js';
import { PHASE } from '../../src/sim/protocol.js';
import { join, makeRoom, run, startRound } from './room-kit.mjs';

/** The game modes beyond deathmatch, driven through the lobby with no sockets. */

const kill = (room, victim, killer) => {
  killer.invulnTimer = 0; victim.invulnTimer = 0;
  room.applyDamage(victim, 500, killer, killer.pos, false, 'body', 'ar');
};

test('duel: two players, one life a round, first to the round limit wins', () => {
  const { room } = makeRoom();
  const A = join(room, 'A'), B = join(room, 'B'), C = join(room, 'C');
  A.say({ t: 'settings', mode: 'duel' });
  C.say({ t: 'ready', ready: true }); B.say({ t: 'ready', ready: true });
  assert.match(room.startBlocker(), /IS FOR 2 PLAYERS/);
  room.close(C.conn);
  room.freeSeat(C.p);
  startRound(room, [A, B], { mode: 'duel', limit: 3 });
  assert.notEqual(A.p.team, B.p.team);
  assert.ok(Math.abs(room.timeLeft - CONFIG.DUEL_ROUND_SECONDS) < 0.2, 'the clock is the round clock');
  const d = Math.hypot(A.p.pos.x - B.p.pos.x, A.p.pos.z - B.p.pos.z);
  assert.ok(d > 30, `opened ${d.toFixed(1)} m apart`);

  kill(room, B.p, A.p);
  assert.equal(B.p.alive, false);
  run(room, 1);
  assert.equal(B.p.alive, false, 'no respawn inside the round');
  assert.equal(A.p.team === TEAM.BLUE ? room.scoreA : room.scoreB, 1);
  run(room, CONFIG.DUEL_RESET_DELAY);
  assert.ok(A.p.alive && B.p.alive, 'both stand again for the next round');
  assert.equal(A.p.invulnTimer, 0);

  kill(room, A.p, B.p);                           // B takes one; B's own death in the same reset window is ignored
  kill(room, B.p, A.p);
  assert.equal(room.scoreA + room.scoreB, 2);
  run(room, CONFIG.DUEL_RESET_DELAY + 0.1);
  kill(room, B.p, A.p);
  assert.equal(room.phase, PHASE.PLAYING, '2 - 1 is not enough');
  run(room, CONFIG.DUEL_RESET_DELAY + 0.1);
  kill(room, B.p, A.p);
  assert.equal(room.phase, PHASE.INTERMISSION);
  assert.equal(Math.max(room.scoreA, room.scoreB), 3);
});

test('duel: a round that runs out is a draw, and a duellist who leaves forfeits', () => {
  const { room } = makeRoom();
  const A = join(room, 'A'), B = join(room, 'B');
  startRound(room, [A, B], { mode: 'duel' });
  run(room, CONFIG.DUEL_ROUND_SECONDS + 0.1);
  assert.equal(room.scoreA + room.scoreB, 0);
  assert.ok(room.roundReset > 0, 'a draw still resets the round');
  run(room, CONFIG.DUEL_RESET_DELAY + 0.1);
  assert.ok(A.p.alive && B.p.alive);
  room.close(B.conn);
  room.freeSeat(B.p);
  room.step();
  assert.equal(room.phase, PHASE.INTERMISSION);
});

const teleport = (p, at) => {
  p.body.position.set(at.x, at.y + 0.55, at.z);
  p.body.velocity.set(0, 0, 0);
  p.pos.set(at.x, at.y + 0.55, at.z);
};

test('ctf: take the enemy flag, drop it on death, return it, and score only with your own flag home', () => {
  const { room } = makeRoom();
  const P = ['A', 'B', 'C', 'D'].map((n) => join(room, n));
  startRound(room, P, { mode: 'ctf', limit: 3 });
  const blue = P.filter((x) => x.p.team === TEAM.BLUE), red = P.filter((x) => x.p.team === TEAM.RED);
  assert.equal(blue.length, 2);
  const [bf, rf] = room.flags;
  assert.equal(bf.state, 'home');
  const dist = (p, f) => Math.hypot(p.pos.x - f.home.x, p.pos.z - f.home.z);
  for (const x of blue) assert.ok(dist(x.p, bf) < dist(x.p, rf), 'spawned on its own side');

  const runner = blue[0].p, guard = red[0].p;
  for (const x of P) x.p.invulnTimer = 0;
  teleport(runner, rf.home);
  run(room, 0.1);
  assert.equal(rf.state, 'carried');
  assert.equal(rf.carrier, runner.id);

  // Killed with it: the flag falls where they died.
  teleport(guard, { x: rf.home.x + 8, y: rf.home.y, z: rf.home.z });
  room.applyDamage(runner, 500, guard, guard.pos, false, 'body', 'ar');
  assert.equal(rf.state, 'dropped');
  assert.ok(Math.hypot(rf.pos.x - rf.home.x, rf.pos.z - rf.home.z) < 2);
  // The owner's team returns it by touching it.
  teleport(guard, rf.pos);
  run(room, 0.1);
  assert.equal(rf.state, 'home');

  // Capture: bring theirs to your base. It does not count while your own flag is away.
  const mate = blue[1].p;
  teleport(mate, rf.home); run(room, 0.1);
  assert.equal(rf.carrier, mate.id);
  teleport(red[1].p, bf.home); run(room, 0.1);     // red takes blue's flag
  assert.equal(bf.state, 'carried');
  teleport(mate, bf.home); run(room, 0.2);
  assert.equal(room.scoreA, 0, 'no capture while your flag is out');
  bf.carrier = null; bf.state = 'home'; bf.pos = { ...bf.home };   // returned
  teleport(red[1].p, rf.home);
  teleport(mate, bf.home); run(room, 0.2);
  assert.equal(room.scoreA, 1);
  assert.equal(rf.state, 'home');
  assert.equal(mate.captures, 1);

  // A dropped flag goes home on its own after a while, and the score limit ends the match.
  teleport(mate, rf.home); run(room, 0.1);
  room.applyDamage(mate, 500, guard, guard.pos, false, 'body', 'ar');
  assert.equal(rf.state, 'dropped');
  run(room, 21);
  assert.equal(rf.state, 'home');
  room.scoreA = 2;
  teleport(blue[1].p, rf.home); run(room, 0.1);
  teleport(blue[1].p, bf.home); run(room, 0.2);
  assert.equal(room.phase, PHASE.INTERMISSION, 'three captures win');
});

test('ctf: a carrier who disconnects drops the flag', () => {
  const { room } = makeRoom();
  const P = ['A', 'B'].map((n) => join(room, n));
  startRound(room, P, { mode: 'ctf' });
  const enemy = room.flags[P[0].p.team === TEAM.BLUE ? 1 : 0];
  teleport(P[0].p, enemy.home); run(room, 0.1);
  assert.equal(enemy.carrier, P[0].p.id);
  room.close(P[0].conn);
  run(room, 0.1);
  assert.equal(enemy.state, 'dropped');
});
