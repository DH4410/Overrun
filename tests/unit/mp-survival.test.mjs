import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TEAM } from '../../src/config.js';
import { MAP_DATA } from '../../src/sim/mapData.js';
import { PHASE } from '../../src/sim/protocol.js';
import { findPath } from '../../server/bots.js';
import { join, makeRoom, run, startRound } from './room-kit.mjs';

/** Multiplayer survival: hostiles are server-driven seats that come in waves and fight by the same rules as people. */

const hostiles = (room) => room.players.filter((p) => p.bot);
const alive = (room) => hostiles(room).filter((p) => p.alive);

/** Play the round forward, killing every hostile as it appears (the people shoot well in this test). */
function clearWave(room, limitS = 60) {
  for (let i = 0; i < limitS * 120 && room.sv.state === 'wave' && room.phase === PHASE.PLAYING; i++) {
    room.step();
    for (const b of alive(room)) { b.health = 0; room.kill(b, null, false, 'ar'); }
  }
}

for (const map of ['port', 'desert', 'snow', 'arena', 'metro']) {
  test(`${map}: survival opens with a break, then wave 1 spawns hostiles on solid ground`, () => {
    const { room } = makeRoom();
    const a = join(room, 'A');
    startRound(room, [a], { mode: 'survival', map });
    assert.equal(room.mode, 'survival');
    assert.equal(room.sv.wave, 0);
    assert.equal(hostiles(room).length, 0);
    run(room, 4.2);
    assert.equal(room.sv.wave, 1);
    run(room, 3);
    const bots = hostiles(room);
    assert.ok(bots.length >= 2, `${bots.length} hostiles in wave 1`);
    for (const b of bots) {
      assert.ok(b.id >= 100 && b.id < 250, `hostile id ${b.id}`);
      assert.equal(b.team, TEAM.RED, 'hostiles are the red team');
      assert.ok(Number.isFinite(b.pos.x) && b.pos.y > -2, 'on the map');
    }
    assert.equal(room.roster().filter((r) => r.bot).length, bots.length);
    assert.equal(room.report().players, 1, 'hostiles are not players');
  });
}

test('hostiles walk toward the person and hurt them', () => {
  const { room } = makeRoom();
  const a = join(room, 'A');
  startRound(room, [a], { mode: 'survival', map: 'port' });
  run(room, 5);
  const bot = hostiles(room)[0];
  assert.ok(bot, 'a hostile exists');
  const d0 = Math.hypot(bot.pos.x - a.p.pos.x, bot.pos.z - a.p.pos.z);
  const hp0 = a.p.health + a.p.armor;
  a.p.invulnTimer = 0;
  run(room, 25);
  const moved = hostiles(room).some((b) => Math.hypot(b.pos.x - a.p.pos.x, b.pos.z - a.p.pos.z) < d0 - 3) || !a.p.alive;
  assert.ok(moved, 'hostiles close in');
  assert.ok(!a.p.alive || a.p.health + a.p.armor < hp0, 'hostiles do damage');
});

test('waves scale with the number of people and end the round when everyone is down', () => {
  const { room } = makeRoom();
  const a = join(room, 'A'), b = join(room, 'B');
  startRound(room, [a, b], { mode: 'survival', map: 'desert' });
  run(room, 4.2);
  const two = room.sv.queue + alive(room).length;
  assert.ok(two >= 6, `wave 1 with two people has ${two} hostiles`);
  const solo = makeRoom(), s = join(solo.room, 'S');
  startRound(solo.room, [s], { mode: 'survival', map: 'desert' });
  run(solo.room, 4.2);
  assert.ok(solo.room.sv.queue + alive(solo.room).length < two, 'one person faces fewer');
  for (const q of [a, b]) { q.p.health = 0; room.kill(q.p, null, false, 'ar'); }
  run(room, 0.1);
  assert.equal(room.phase, PHASE.INTERMISSION);
  assert.equal(hostiles(room).length, 0, 'the hostiles are cleared when the round ends');
});

test('clearing a wave starts a break, then the next wave, and the dead come back', () => {
  const { room } = makeRoom();
  const a = join(room, 'A'), b = join(room, 'B');
  startRound(room, [a, b], { mode: 'survival', map: 'port' });
  a.p.invulnTimer = b.p.invulnTimer = 1e9;
  run(room, 4.2);
  clearWave(room);
  assert.equal(room.sv.state, 'break');
  b.p.health = 0; room.kill(b.p, null, false, 'ar');
  assert.ok(!b.p.alive);
  run(room, 7.2);
  assert.equal(room.sv.wave, 2);
  assert.ok(b.p.alive, 'a person who fell is back for the next wave');
  assert.ok(a.p.health > 0);
});

test('the scoreboard standings leave the hostiles out', () => {
  const { room } = makeRoom();
  const a = join(room, 'A');
  startRound(room, [a], { mode: 'survival', map: 'snow' });
  run(room, 6);
  const sent = [];
  const orig = room.broadcastJson.bind(room);
  room.broadcastJson = (m) => { sent.push(m); orig(m); };
  a.p.health = 0; room.kill(a.p, null, false, 'ar');
  run(room, 0.1);
  const end = sent.find((m) => m.t === 'end');
  assert.ok(end, 'the round ended');
  assert.equal(end.standings.length, 1);
  assert.match(end.title, /DEFEAT/);
});

for (const map of ['port', 'desert', 'snow', 'arena', 'metro']) {
  test(`${map}: the hostiles' route grid connects every spawn to every other`, () => {
    const { room } = makeRoom();
    room.loadMap(map);
    assert.ok(room.nav, 'a map that hosts survival has a grid');
    const pts = MAP_DATA[map].spawns;
    for (const [ax, az] of pts) for (const [bx, bz] of pts) {
      if (ax === bx && az === bz) continue;
      assert.ok(findPath(room.nav, ax, az, bx, bz), `no way from ${ax},${az} to ${bx},${bz}`);
    }
  });
}
