import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Governor } from '../../server/governor.js';
import { Room } from '../../server/room.js';
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
  const room = new Room({ colliders, now: () => t, rng, governor: new Governor({ now: () => t }), mapId });
  const players = [];
  for (let i = 0; i < 4; i++) {
    const conn = { send() {}, close() {} };
    room.open(conn);
    room.message(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, hash: room.hash, name: `P${i}`, loadout: LOADOUT }));
    players.push(room.clients.get(conn).player);
  }
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
    if (d > 1e-3 || a.crouching !== y.crouching) {
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
    assert.equal(r.differ, 0, `diverged ${r.differ} times, worst ${r.worst.toFixed(4)} m, first ${JSON.stringify(r.firstDiff)}`);
  });
}
