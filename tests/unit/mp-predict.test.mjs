import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Governor } from '../../server/governor.js';
import { COUNTDOWN, Room } from '../../server/room.js';
import { Predictor } from '../../src/net/predict.js';
import { MAP_DATA, MAP_IDS } from '../../src/sim/mapData.js';
import { BTN, PROTOCOL_VERSION, Reader, WEAPON_IDS, quantPitch, quantYaw, readYou, Writer, writeYou } from '../../src/sim/protocol.js';

/**
 * Client prediction against the real room, with no network in between: every player gets a
 * scripted command each tick, and player 0's predictor runs the same commands in its own
 * level-only world. With nothing late and nothing lost the two must agree tick for tick; a
 * disagreement here is the simulation itself diverging, which reconciliation would then be
 * hiding as constant small corrections.
 */

const colliders = Object.fromEntries(MAP_IDS.map((id) => [id, JSON.parse(readFileSync(new URL(`../../assets/maps/${id}.json`, import.meta.url), 'utf8'))]));
const LOADOUT = ['ar', 'pistol', 'shotgun', 'sniper'];

function you(p) {
  const w = new Writer(256);
  writeYou(w, p);
  return readYou(new Reader(w.bytes()));
}

function run(mapId, ticks) {
  let seed = 7;
  const rng = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const t = Date.UTC(2026, 0, 1, 12);
  const room = new Room({ colliders, now: () => t, rng, governor: new Governor({ now: () => t }), mapId,
    mode: MAP_DATA[mapId].modes?.includes('dm') === false ? 'survival' : 'dm' });   // a survival-only map (ARENA) has no deathmatch
  const players = [], conns = [];
  for (let i = 0; i < 4; i++) {
    const conn = { send() {}, close() {} };
    room.open(conn);
    room.message(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, hash: room.hash, name: `P${i}`, loadout: LOADOUT }));
    players.push(room.clients.get(conn).player);
    conns.push(conn);
  }
  // Nobody walks in the lobby or the countdown, so play it through to the round itself.
  for (let i = 1; i < conns.length; i++) room.message(conns[i], JSON.stringify({ t: 'ready', ready: true }));
  room.message(conns[0], JSON.stringify({ t: 'start' }));
  for (let i = 0; i < (COUNTDOWN + 0.6) * 120; i++) room.step();      // and a moment for everyone to settle on the ground
  const me = players[0];
  const pred = new Predictor(LOADOUT);
  pred.setMap(mapId, colliders[mapId], MAP_DATA[mapId].half);
  pred.apply(you(me));
  const intents = players.map(() => ({ ix: 0, iz: 1, yaw: rng() * 6.28, buttons: 0, until: 0 }));
  let seq = 0, differ = 0, worst = 0, firstDiff = null;
  for (let k = 0; k < ticks; k++) {
    players.forEach((p, i) => {
      const it = intents[i];
      if (k >= it.until) {
        it.until = k + 30 + Math.floor(rng() * 150);
        it.ix = [-1, 0, 1][Math.floor(rng() * 3)];
        it.iz = [-1, 0, 1, 1][Math.floor(rng() * 4)];
        it.yaw += (rng() - 0.5) * 3;
        it.buttons = (rng() < 0.4 ? BTN.SPRINT : 0) | (rng() < 0.15 ? BTN.CROUCH : 0) | (rng() < 0.1 ? BTN.AIM : 0);
      }
      const buttons = it.buttons | (rng() < 0.02 ? BTN.JUMP : 0);
      p.queue.push({ seq: k + 1, ix: it.ix, iz: it.iz, yawQ: quantYaw(it.yaw), pitchQ: quantPitch(0), buttons, weapon: WEAPON_IDS.indexOf('ar'), emote: 0, viewTick: room.tick });
    });
    const cmd = me.queue[me.queue.length - 1];
    room.step();
    pred.tick(cmd, ++seq, true);
    const a = pred.entries[pred.entries.length - 1].state, y = you(me);
    const d = Math.hypot(a.px - y.px, a.py - y.py, a.pz - y.pz);
    worst = Math.max(worst, d);
    // The first tick lands a body that was resting a millimetre off the level: that is the predictor
    // taking the server's start state, not drift.
    if (k === 0) pred.apply(y);
    else if (d > 1e-3 || a.crouching !== y.crouching) {
      differ++;
      firstDiff ??= { tick: k, d };
      pred.apply(y);
    }
  }
  return { differ, worst, firstDiff };
}

for (const mapId of MAP_IDS) {
  test(`prediction matches the room tick for tick on ${mapId}`, () => {
    const r = run(mapId, 2400);
    // A survival-only map has hostiles in the room's world and not in the predictor's: one bumping
    // a player is a few centimetres the reconciliation takes back (any survival round does it).
    const svOnly = MAP_DATA[mapId].modes?.includes('dm') === false;
    const allowed = svOnly ? 3 : 0;
    assert.ok(r.differ <= allowed && (!r.differ || r.worst < 0.15), `diverged ${r.differ} times, worst ${r.worst.toFixed(4)} m, first ${JSON.stringify(r.firstDiff)}`);
  });
}

test('a hit that does not move you still reaches the predicted health at once', () => {
  const mapId = MAP_IDS[0];
  const t = Date.UTC(2026, 0, 1, 12);
  let seed = 3;
  const rng = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const room = new Room({ colliders, now: () => t, rng, governor: new Governor({ now: () => t }), mapId, mode: 'dm' });
  const conns = [], players = [];
  for (let i = 0; i < 2; i++) {
    const conn = { send() {}, close() {} };
    room.open(conn);
    room.message(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, hash: room.hash, name: `P${i}`, loadout: LOADOUT }));
    players.push(room.clients.get(conn).player); conns.push(conn);
  }
  room.message(conns[1], JSON.stringify({ t: 'ready', ready: true }));
  room.message(conns[0], JSON.stringify({ t: 'start' }));
  for (let i = 0; i < (COUNTDOWN + 0.6) * 120; i++) room.step();
  const me = players[0];
  const pred = new Predictor(LOADOUT);
  pred.setMap(mapId, colliders[mapId], MAP_DATA[mapId].half);
  pred.apply(you(me));
  let seq = 0;
  for (let k = 0; k < 60; k++) {
    me.queue.push({ seq: k + 1, ix: 0, iz: 0, yawQ: quantYaw(0), pitchQ: quantPitch(0), buttons: 0, weapon: 0, emote: 0, viewTick: room.tick });
    const cmd = me.queue[me.queue.length - 1];
    room.step();
    pred.tick(cmd, ++seq, true);
  }
  me.health = 55; me.armor = 0;                       // shot while standing still: nothing about the position changes
  const y = you(me);
  pred.reconcile({ you: y, ackSeq: seq, ackAge: 0 }, true);
  assert.equal(pred.p.health, 55);
  assert.equal(pred.p.armor, 0);
});
