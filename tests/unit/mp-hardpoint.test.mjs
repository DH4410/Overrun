import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TEAM } from '../../src/config.js';
import { MODE_INFO, PLAYABLE, mapHosts } from '../../src/sim/modes.js';
import { MAP_DATA } from '../../src/sim/mapData.js';
import { MODE_IDS, PHASE } from '../../src/sim/protocol.js';
import { join, makeRoom, run, startRound } from './room-kit.mjs';

/** Online Hardpoint: one zone, a point a second for the team holding it alone, and it moves on. */

const stand = (p, z) => { p.body.position.set(z.x, z.y, z.z); p.pos.set(z.x, z.y, z.z); };
const away = (room, p) => { const sp = room.spawns.find((s) => Math.hypot(s.x - room.hp.zone.x, s.z - room.hp.zone.z) > 30); p.body.position.set(sp.x, sp.y, sp.z); p.pos.set(sp.x, sp.y, sp.z); };

test('the mode is offered, has a wire id, and is hosted on the team maps', () => {
  assert.ok(PLAYABLE.includes('hp'));
  assert.ok(MODE_IDS.includes('hp'));
  assert.equal(MODE_INFO.hp.teams, true);
  for (const id of Object.keys(MAP_DATA)) assert.equal(mapHosts(MAP_DATA, id, 'hp'), mapHosts(MAP_DATA, id, 'tdm'), id);
});

test('a round deals two teams and sends the zone with the match', () => {
  const { room } = makeRoom();
  const a = join(room, 'A'), b = join(room, 'B');
  startRound(room, [a, b], { mode: 'hp', map: 'port' });
  assert.notEqual(a.p.team, b.p.team);
  assert.deepEqual(room.matchInfo().zone, room.hp.zone);
  assert.equal(room.hp.zone.hp, true);
});

test('one team alone on the point scores a point a second; both on it scores nothing', () => {
  const { room } = makeRoom();
  const a = join(room, 'A'), b = join(room, 'B');
  startRound(room, [a, b], { mode: 'hp', map: 'port' });
  a.p.invulnTimer = b.p.invulnTimer = 1e9;
  stand(a.p, room.hp.zone); away(room, b.p);
  run(room, 5.2);
  const mine = a.p.team === TEAM.BLUE ? room.scoreA : room.scoreB;
  const theirs = a.p.team === TEAM.BLUE ? room.scoreB : room.scoreA;
  assert.ok(mine >= 4 && mine <= 6, `held for 5 s scored ${mine}`);
  assert.equal(theirs, 0);
  stand(b.p, room.hp.zone);
  const before = room.scoreA + room.scoreB;
  run(room, 3);
  assert.equal(room.hp.zone.owner, 3, 'contested');
  assert.equal(room.scoreA + room.scoreB, before);
});

test('the zone moves on after its time, far from where it was, and says so', () => {
  const { room } = makeRoom();
  const a = join(room, 'A'), b = join(room, 'B');
  startRound(room, [a, b], { mode: 'hp', map: 'port' });
  a.p.invulnTimer = b.p.invulnTimer = 1e9;
  const first = { ...room.hp.zone };
  const sent = [];
  const orig = room.broadcastJson.bind(room);
  room.broadcastJson = (m) => { sent.push(m); orig(m); };
  run(room, 46);
  const z = room.hp.zone;
  assert.ok(Math.hypot(z.x - first.x, z.z - first.z) >= 16, 'a real jump');
  assert.ok(sent.some((m) => m.t === 'zone' && m.zone.x === z.x));
});

test('reaching the point limit ends the round for the holding team', () => {
  const { room } = makeRoom();
  const a = join(room, 'A'), b = join(room, 'B');
  startRound(room, [a, b], { mode: 'hp', map: 'port' });
  a.p.invulnTimer = b.p.invulnTimer = 1e9;
  const blue = a.p.team === TEAM.BLUE;
  if (blue) room.scoreA = room.settings.limit - 2; else room.scoreB = room.settings.limit - 2;
  stand(a.p, room.hp.zone); away(room, b.p);
  run(room, 4);
  assert.equal(room.phase, PHASE.INTERMISSION, 'the limit ends the round');
});
