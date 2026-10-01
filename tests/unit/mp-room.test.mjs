import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Governor } from '../../server/governor.js';
import { MAX_REWIND, QUEUE_MAX, Room } from '../../server/room.js';
import { floorAt } from '../../src/sim/colliders.js';
import { MAP_IDS } from '../../src/sim/mapData.js';
import {
  BTN, CLOSE, EV, INPUT_CMD, INPUT_HEADER, MSG_INPUT, PHASE, PROTOCOL_VERSION, WEAPON_IDS,
  encodeInput, quantPitch, quantYaw, readSnapshot,
} from '../../src/sim/protocol.js';

/**
 * The room driven directly: an injected clock, fake connections, commands pushed into the
 * queue or sent as real packets. No sockets, no browser.
 */

const colliders = Object.fromEntries(MAP_IDS.map((id) => [id, JSON.parse(readFileSync(new URL(`../../assets/maps/${id}.json`, import.meta.url), 'utf8'))]));

function makeRoom({ limit } = {}) {
  const clock = { t: Date.UTC(2026, 0, 1, 12) };
  let seed = 1;
  const rng = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const governor = new Governor({ now: () => clock.t, limit });
  const room = new Room({ colliders, now: () => clock.t, rng, governor });
  return { room, clock, governor };
}

function join(room, name, extra = {}) {
  const conn = { sent: [], closed: null, send(d) { this.sent.push(d); }, close(code) { this.closed = code; } };
  room.open(conn);
  room.message(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, hash: room.hash, name, loadout: ['pistol', 'ar', 'shotgun', 'sniper'], ...extra }));
  const c = room.clients.get(conn);
  return { conn, c, p: c?.player };
}

let seqs = new Map();
function push(room, p, { ix = 0, iz = 0, yaw = 0, pitch = 0, buttons = 0, weapon = 'sniper', viewTick = room.tick } = {}) {
  const seq = (seqs.get(p) ?? 0) + 1;
  seqs.set(p, seq);
  p.queue.push({ seq, ix, iz, yawQ: quantYaw(yaw), pitchQ: quantPitch(pitch), buttons, weapon: WEAPON_IDS.indexOf(weapon), emote: 0, viewTick });
}

function place(room, p, x, z) {
  const y = floorAt(room.world, x, z, 5.5);
  p.body.position.set(x, y + 0.55, z);
  p.body.velocity.set(0, 0, 0);
}

/** Target strafes; shooter fires at where the target was at `viewTick`. Returns the target's health. */
function strafeShot(useRewind) {
  seqs = new Map();
  const { room } = makeRoom();
  const A = join(room, 'A').p, B = join(room, 'B').p;
  place(room, A, -14, 31);
  place(room, B, 6, 31);
  // Settle and switch to the sniper, then B sprints sideways (across A's line of fire) and is
  // seen by A at tick T0; A fires 25 ticks later, at where B was then.
  const strafe = { ix: -1, yaw: Math.PI / 2, buttons: BTN.SPRINT };
  for (let i = 0; i < 120; i++) {
    push(room, A, { yaw: -Math.PI / 2 });
    push(room, B, { yaw: Math.PI / 2 });
    room.step();
  }
  for (let i = 0; i < 20; i++) { push(room, A, { yaw: -Math.PI / 2 }); push(room, B, strafe); room.step(); }
  B.invulnTimer = 0; A.invulnTimer = 0;
  const T0 = room.tick;
  const seen = { x: B.pos.x, y: B.pos.y, z: B.pos.z };
  for (let i = 0; i < 24; i++) { push(room, A, { yaw: -Math.PI / 2 }); push(room, B, strafe); room.step(); }
  assert.ok(Math.hypot(B.pos.x - seen.x, B.pos.z - seen.z) > 1.2, 'the target moved well clear of where it was seen');
  assert.ok(room.losClear(A.eye, B.pos), 'clear line between them');
  const dx = seen.x - A.eye.x, dy = seen.y - A.eye.y, dz = seen.z - A.eye.z;
  const yaw = Math.atan2(-dx, -dz), pitch = Math.asin(dy / Math.hypot(dx, dy, dz));
  push(room, A, { yaw, pitch, buttons: BTN.FIRE, viewTick: useRewind ? T0 : room.tick + 1 });
  push(room, B, strafe);
  room.step();
  assert.ok(room.tick - T0 <= MAX_REWIND, 'within the rewind window');
  for (let i = 0; i < 20; i++) { push(room, A, { yaw, pitch }); push(room, B, strafe); room.step(); }
  return { health: B.health, armor: B.armor, ammo: A.ammo.sniper.mag };
}

test('lag compensation: a shot at where a strafing target was seen hits it', () => {
  const r = strafeShot(true);
  assert.equal(r.ammo, 4, 'one round fired');
  assert.ok(r.health < 100, `rewound shot should hit (health ${r.health})`);
});

test('lag compensation: the same shot without the rewind misses', () => {
  const r = strafeShot(false);
  assert.equal(r.ammo, 4, 'one round fired');
  assert.equal(r.health, 100);
  assert.equal(r.armor, 50);
});

function packet(cmds, opts = {}) {
  return encodeInput(cmds.map((c) => ({ ix: 0, iz: 0, yawQ: 0, pitchQ: 0, buttons: 0, weapon: 1, emote: 0, ...c })), opts.seq ?? 1, 0, 0, 100, 0);
}

test('forged packets are refused or clamped, and a flood is dropped', () => {
  const { room, clock } = makeRoom();
  const { conn, p } = join(room, 'A');
  const bad0 = room.stats.inputBad;
  // 17 commands, a truncated packet, a wrong type byte, text pretending to be binary.
  room.message(conn, new ArrayBuffer(INPUT_HEADER + 17 * INPUT_CMD));
  const short = packet([{}]).slice(0, INPUT_HEADER + 3);
  room.message(conn, short);
  const wrong = packet([{}]); new DataView(wrong).setUint8(0, MSG_INPUT + 7);
  room.message(conn, wrong);
  assert.equal(room.stats.inputBad - bad0, 3);
  assert.equal(p.queue.length, 0);

  clock.t += 1000;
  room.message(conn, packet([{ weapon: 200, buttons: 0xffff, emote: 99, ix: 127, iz: -128 }], { seq: 1 }));
  const cmd = p.queue[0];
  assert.equal(cmd.ix, 1); assert.equal(cmd.iz, -1);
  assert.equal(cmd.buttons, 0xff);
  assert.equal(cmd.emote, 0);
  assert.equal(WEAPON_IDS[cmd.weapon], 'frag');
  room.step();
  assert.ok(p.loadout.includes(p.current), 'a weapon outside the loadout is never equipped');

  const drop0 = room.stats.inputDropped;
  for (let i = 0; i < 50; i++) room.message(conn, packet([{}], { seq: 100 + i }));
  assert.ok(room.stats.inputDropped - drop0 >= 39, `flood dropped ${room.stats.inputDropped - drop0}`);
});

test('a starved queue repeats the last command without its one-shots, and an overfull one is trimmed', () => {
  seqs = new Map();
  const { room } = makeRoom();
  const { p } = join(room, 'A');
  for (let i = 0; i < 6; i++) push(room, p, { iz: 1, buttons: i === 5 ? BTN.JUMP | BTN.FIRE : BTN.FIRE, weapon: 'ar' });
  for (let i = 0; i < 6; i++) room.step();
  assert.equal(p.ackSeq, 6);
  const rep0 = room.stats.cmdsRepeated;
  room.step();
  assert.equal(room.stats.cmdsRepeated - rep0, 1);
  assert.equal(p.lastCmd.buttons, BTN.FIRE, 'the repeat keeps FIRE held and drops JUMP');
  assert.equal(p.ackSeq, 6, 'a repeat does not use up a sequence number');
  for (let i = 0; i < 20; i++) room.step();
  assert.equal(p.lastCmd.iz, 0, 'a player gone quiet stops after MAX_GUESS ticks');

  for (let i = 0; i < QUEUE_MAX + 10; i++) push(room, p, { iz: 1 });
  const trim0 = room.stats.cmdsTrimmed;
  const { conn } = [...room.clients.values()][0];
  room.message(conn, packet([{ iz: 1 }], { seq: 1000 }));
  assert.equal(p.queue.length, QUEUE_MAX);
  assert.equal(room.stats.cmdsTrimmed - trim0, 11);
  // A queue that never drains below a packet for a whole one-second window is trimmed back
  // to one packet (the first window still holds the starved ticks above, so give it two).
  for (let i = 0; i < 260; i++) { push(room, p, { iz: 1 }); room.step(); }
  assert.ok(p.queue.length <= 7, `queue drained to ${p.queue.length}`);
});

test('snapshots carry the recipient block and parse back', () => {
  const { room, clock } = makeRoom();
  const A = join(room, 'A');
  const S = join(room, 'S', { spectate: true });
  assert.equal(S.c.spectator, true);
  clock.t += 100;
  room.update();
  const snapA = readSnapshot(A.conn.sent.findLast((d) => typeof d !== 'string'));
  const snapS = readSnapshot(S.conn.sent.findLast((d) => typeof d !== 'string'));
  assert.equal(snapA.youId, A.p.id);
  assert.ok(Math.abs(snapA.you.py - A.p.body.position.y) < 1e-9);
  assert.equal(snapS.you, null);
  assert.equal(snapS.players.length, 1);
  assert.ok(snapA.events.some((e) => e.kind === EV.SPAWN));
  assert.equal(snapA.phase, PHASE.PLAYING);
});

test('the governor steps the rate down, ends after the round, closes, and reopens the next day', () => {
  const { room, clock, governor } = makeRoom({ limit: 1000 });
  const A = join(room, 'A');
  assert.equal(governor.inputRate, 20);
  governor.add(600); assert.equal(governor.inputRate, 15);
  governor.add(250); assert.equal(governor.inputRate, 10);
  governor.add(100); assert.equal(governor.lastRound, true);
  // The round ends; the intermission runs out; the room closes instead of starting another.
  room.endMatch('TEST', '');
  assert.equal(room.phase, PHASE.INTERMISSION);
  for (let i = 0; i < 20 * 120 + 5; i++) room.step();
  assert.equal(room.phase, PHASE.CLOSED);
  assert.equal(A.conn.closed, CLOSE.CLOSED);
  const late = join(room, 'B');
  assert.equal(late.conn.closed, CLOSE.CLOSED, 'nobody joins a closed room');
  clock.t = Date.UTC(2026, 0, 2, 0, 0, 5);
  const next = join(room, 'C');
  assert.equal(next.conn.closed, null, 'a new UTC day reopens it');
  assert.equal(room.phase, PHASE.PLAYING);
  assert.equal(governor.count, 1);
});

test('a hello from a stale client is told to refresh', () => {
  const { room } = makeRoom();
  const { conn } = join(room, 'A', { hash: 'deadbeef' });
  assert.equal(conn.closed, CLOSE.REFRESH);
  assert.match(conn.sent[0], /Refresh/);
});
