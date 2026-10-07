import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TEAM } from '../../src/config.js';
import { MODE_INFO, PLAYABLE, mapHosts } from '../../src/sim/modes.js';
import { MAP_DATA } from '../../src/sim/mapData.js';
import { PHASE, WEAPON_IDS } from '../../src/sim/protocol.js';
import { join, makeRoom, run, startRound } from './room-kit.mjs';

/** Zombie Escape: the dead are server-driven melee seats; the people win by holding the extraction zone. */

const zombies = (room) => room.players.filter((p) => p.zombie);
const ends = (room) => {
  const sent = [];
  const orig = room.broadcastJson.bind(room);
  room.broadcastJson = (m) => { sent.push(m); orig(m); };
  return sent;
};

test('the mode is offered, hosted wherever survival is, and claw is a known weapon', () => {
  assert.ok(PLAYABLE.includes('zombie'));
  assert.equal(MODE_INFO.zombie.coop, true);
  for (const id of Object.keys(MAP_DATA)) assert.equal(mapHosts(MAP_DATA, id, 'zombie'), mapHosts(MAP_DATA, id, 'survival'), id);
  assert.ok(WEAPON_IDS.includes('claw'));
});

test('a round puts everyone on blue, picks a far reachable zone and sends it with the match', () => {
  const { room } = makeRoom();
  const a = join(room, 'A'), b = join(room, 'B');
  startRound(room, [a, b], { mode: 'zombie', map: 'port' });
  assert.equal(a.p.team, TEAM.BLUE);
  assert.equal(b.p.team, TEAM.BLUE);
  const z = room.zb.zone, home = room.humanSpawns[0];
  assert.ok(Math.hypot(z.x - home.x, z.z - home.z) > 20, 'the zone is far from the start');
  const info = room.matchInfo();
  assert.deepEqual(info.zone, z);
  assert.ok(Math.abs(info.timeLeft - room.settings.time) < 1, 'the clock is the host\'s time limit');
});

test('zombies arrive after a short grace as red melee seats, flagged in the roster', () => {
  const { room } = makeRoom();
  const a = join(room, 'A');
  startRound(room, [a], { mode: 'zombie', map: 'port' });
  a.p.invulnTimer = 1e9;
  run(room, 3);
  assert.equal(zombies(room).length, 0, 'none in the first moments');
  run(room, 10);
  const z = zombies(room);
  assert.ok(z.length >= 2, `${z.length} zombies`);
  for (const m of z) {
    assert.equal(m.team, TEAM.RED);
    assert.ok(m.bot && m.ai.spec.melee);
    assert.ok(m.health > 0 && m.health <= 255, 'health fits a snapshot byte');
  }
  assert.equal(room.roster().filter((r) => r.zombie).length, z.length);
  assert.equal(room.report().players, 1, 'zombies are not players');
});

test('a zombie in reach claws the person, and only on its swing cooldown', () => {
  const { room } = makeRoom();
  const a = join(room, 'A');
  startRound(room, [a], { mode: 'zombie', map: 'port' });
  run(room, 7);
  a.p.invulnTimer = 0; a.p.armor = 0; a.p.health = 100;
  const m = zombies(room)[0];
  assert.ok(m, 'a zombie exists');
  for (const q of zombies(room)) if (q !== m) { q.body.position.set(500, 60, 500); q.body.type = 4; }
  m.invulnTimer = 0;
  m.body.position.set(a.p.body.position.x + 1.0, a.p.body.position.y, a.p.body.position.z);
  m.body.velocity.set(0, 0, 0);
  const hits = [];
  const orig = room.applyDamage.bind(room);
  room.applyDamage = (t, amt, src, ...rest) => { if (src === m) hits.push(room.tick); return orig(t, amt, src, ...rest); };
  run(room, 2);
  assert.ok(hits.length >= 1, 'it hit');
  assert.ok(a.p.health < 100, 'and it hurt');
  assert.ok(hits.length <= Math.ceil(2 / m.ai.spec.swing) + 1, 'no faster than its swing');
});

test('holding the open zone escapes; the zone is locked at first', () => {
  const { room } = makeRoom();
  const a = join(room, 'A');
  startRound(room, [a], { mode: 'zombie', map: 'port' });
  const sent = ends(room);
  a.p.invulnTimer = 1e9;
  const z = room.zb.zone;
  a.p.body.position.set(z.x, z.y + 0.6, z.z);
  run(room, 12);
  assert.equal(room.phase, PHASE.PLAYING, 'standing in a locked zone does nothing');
  assert.equal(room.scoreA, 0);
  run(room, 60);
  assert.ok(room.zb.open, 'it opened');
  a.p.body.position.set(z.x, z.y + 0.6, z.z);
  run(room, 11);
  assert.equal(room.phase, PHASE.INTERMISSION);
  const end = sent.find((m) => m.t === 'end');
  assert.equal(end.title, 'ESCAPED');
  assert.equal(end.winner.team, TEAM.BLUE);
});

test('the clock running out, or every person falling, hands it to the dead', () => {
  const t1 = makeRoom();
  const a = join(t1.room, 'A');
  startRound(t1.room, [a], { mode: 'zombie', map: 'port' });
  const s1 = ends(t1.room);
  a.p.invulnTimer = 1e9;
  t1.room.timeLeft = 0.05;
  run(t1.room, 0.2);
  assert.equal(s1.find((m) => m.t === 'end').title, 'OVERRUN');

  const t2 = makeRoom();
  const b = join(t2.room, 'B'), c = join(t2.room, 'C');
  startRound(t2.room, [b, c], { mode: 'zombie', map: 'port' });
  const s2 = ends(t2.room);
  b.p.health = 0; t2.room.kill(b.p, null, false, 'claw');
  run(t2.room, 0.1);
  assert.equal(t2.room.phase, PHASE.PLAYING, 'one fallen is not the end');
  assert.ok(b.p.respawnTimer > 20, 'reinforcements are on the way');
  c.p.health = 0; t2.room.kill(c.p, null, false, 'claw');
  run(t2.room, 0.1);
  const end = s2.find((m) => m.t === 'end');
  assert.equal(end.title, 'OVERRUN');
  assert.equal(end.winner.team, TEAM.RED);
});

test('a fallen person comes back while a friend still stands', () => {
  const { room } = makeRoom();
  const a = join(room, 'A'), b = join(room, 'B');
  startRound(room, [a, b], { mode: 'zombie', map: 'port' });
  a.p.invulnTimer = b.p.invulnTimer = 1e9;
  b.p.health = 0; room.kill(b.p, null, false, 'claw');
  run(room, 26);
  assert.ok(b.p.alive);
  assert.equal(room.phase, PHASE.PLAYING);
});

test('the dead drop only healing items, and not every time', () => {
  const { room } = makeRoom();
  const a = join(room, 'A');
  startRound(room, [a], { mode: 'zombie', map: 'port' });
  const fake = { zombie: true, current: 'pistol', loadout: ['pistol'], body: { position: { x: 0, y: 1, z: 0 } } };
  for (let i = 0; i < 200; i++) room.dropLoot(fake);
  assert.ok(room.drops.length > 10, 'some drops');
  assert.ok(room.drops.length < 120, 'a minority of kills');
  assert.ok(room.drops.every((d) => d.type === 1), 'items only');
});
