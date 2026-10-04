import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EV, readEvent, writeEvent } from '../../src/sim/protocol.js';
import { KILL_FLAG, killFlags, killLine, killTags } from '../../src/sim/killinfo.js';
import { join, makeRoom, startRound } from './room-kit.mjs';

test('noscope, longshot and midair are only called for gun kills, and only when they are true', () => {
  assert.equal(killFlags({ weapon: 'sniper', zoom: true, scoped: false, dist: 10 }), KILL_FLAG.NOSCOPE);
  assert.equal(killFlags({ weapon: 'sniper', zoom: true, scoped: true, dist: 80 }), KILL_FLAG.LONGSHOT);
  assert.equal(killFlags({ weapon: 'ar', zoom: false, scoped: false, dist: 10 }), 0, 'a rifle has no scope to skip');
  assert.equal(killFlags({ weapon: 'ar', airborne: true }), KILL_FLAG.MIDAIR);
  assert.equal(killFlags({ weapon: 'frag', dist: 90, airborne: true }), 0, 'a grenade is none of these');
  assert.deepEqual(killTags({ head: true, flags: KILL_FLAG.NOSCOPE | KILL_FLAG.LONGSHOT, dist: 87.4 }), ['NOSCOPE', 'HEADSHOT', '87 M']);
  assert.equal(killLine('SNIPER RIFLE', { head: true, flags: KILL_FLAG.NOSCOPE }), 'SNIPER RIFLE · NOSCOPE · HEADSHOT');
});

test('a kill event carries its flags and distance over the wire', () => {
  const bytes = [];
  const w = { u8: (v) => bytes.push(v), u16: () => {}, pos: () => {}, dir: () => {}, i16: () => {} };
  writeEvent(w, { kind: EV.KILL, killer: 2, victim: 5, head: true, weapon: 'sniper', flags: KILL_FLAG.NOSCOPE | KILL_FLAG.MIDAIR, dist: 300.4 });
  let i = 0;
  const r = { u8: () => bytes[i++] };
  const e = readEvent(r);
  assert.equal(e.killer, 2);
  assert.equal(e.victim, 5);
  assert.equal(e.head, true);
  assert.equal(e.weapon, 'sniper');
  assert.equal(e.flags, KILL_FLAG.NOSCOPE | KILL_FLAG.MIDAIR);
  assert.equal(e.dist, 255, 'distance is capped at a byte');
});

test('the server flags an unscoped sniper kill with the real distance', () => {
  const { room } = makeRoom();
  const a = join(room, 'A'), b = join(room, 'B');
  startRound(room, [a, b], { mode: 'dm', map: 'port', limit: 50 });
  a.p.pos.set(0, 0, 0); b.p.pos.set(0, 0, -60);
  a.p.aiming = false; a.p.grounded = true;
  room.events.length = 0;
  room.kill(b.p, a.p, true, 'sniper');
  const e = room.events.find((x) => x.kind === EV.KILL);
  assert.ok(e.flags & KILL_FLAG.NOSCOPE, 'hip-fired sniper');
  assert.ok(e.flags & KILL_FLAG.LONGSHOT, '60 m');
  assert.ok(Math.abs(e.dist - 60) < 0.01);
  assert.equal(e.weapon, 'sniper');
});
