import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GUN_LADDER, MODE_INFO, PLAYABLE, ladderGun, mapHosts } from '../../src/sim/modes.js';
import { MAP_DATA } from '../../src/sim/mapData.js';
import { MODE_IDS, PHASE, WEAPON_IDS } from '../../src/sim/protocol.js';
import { join, makeRoom, startRound } from './room-kit.mjs';

/** Online Gun Game: a kill hands the killer the next gun; the kill with the last one wins. */

const rosterGun = (room, p) => room.roster().find((r) => r.id === p.id).loadout[0];

test('the mode is offered, every rung is on the wire, and it is hosted where deathmatch is', () => {
  assert.ok(PLAYABLE.includes('gg'));
  assert.ok(MODE_IDS.includes('gg'));
  assert.equal(MODE_INFO.gg.teams, false);
  for (const id of GUN_LADDER) assert.ok(WEAPON_IDS.includes(id), id);
  for (const id of Object.keys(MAP_DATA)) assert.equal(mapHosts(MAP_DATA, id, 'gg'), mapHosts(MAP_DATA, id, 'dm'), id);
});

test('everyone starts on the first rung whatever their locker holds', () => {
  const { room } = makeRoom();
  const a = join(room, 'A'), b = join(room, 'B');
  startRound(room, [a, b], { mode: 'gg', map: 'port' });
  assert.deepEqual(a.p.loadout, [ladderGun(0)]);
  assert.equal(a.p.current, ladderGun(0));
  assert.equal(rosterGun(room, b.p), ladderGun(0));
});

test('a kill moves the killer up one gun with a full magazine and tells the room; the victim stays put', () => {
  const { room } = makeRoom();
  const a = join(room, 'A'), b = join(room, 'B');
  startRound(room, [a, b], { mode: 'gg', map: 'port' });
  const sent = [];
  a.conn.send = (d) => sent.push(d);
  a.p.ammo[ladderGun(1)].mag = 1;
  room.kill(b.p, a.p, false, ladderGun(0));
  assert.deepEqual(a.p.loadout, [ladderGun(1)]);
  assert.equal(a.p.current, ladderGun(1));
  assert.ok(a.p.ammo[ladderGun(1)].mag > 1, 'refilled');
  assert.equal(rosterGun(room, a.p), ladderGun(1));
  assert.deepEqual(b.p.loadout, [ladderGun(0)]);
  assert.ok(sent.some((d) => typeof d === 'string' && d.includes('"roster"')), 'the roster went out');
  room.respawn(b.p);
  assert.equal(b.p.current, ladderGun(0));
});

test('the kill with the last gun wins the round', () => {
  const { room } = makeRoom();
  const a = join(room, 'A'), b = join(room, 'B');
  startRound(room, [a, b], { mode: 'gg', map: 'port' });
  for (let i = 0; i < GUN_LADDER.length; i++) {
    assert.equal(room.phase, PHASE.PLAYING, `still playing before kill ${i + 1}`);
    b.p.alive = true;
    room.kill(b.p, a.p, false, a.p.current);
  }
  assert.equal(room.phase, PHASE.INTERMISSION);
  assert.equal(a.p.kills, GUN_LADDER.length);
});

test('back in the lobby the locker loadout is restored', () => {
  const { room } = makeRoom();
  const a = join(room, 'A'), b = join(room, 'B');
  startRound(room, [a, b], { mode: 'gg', map: 'port' });
  room.kill(b.p, a.p, false, 'pistol');
  room.toLobby();
  assert.deepEqual(a.p.loadout, a.p.chosen);
});
