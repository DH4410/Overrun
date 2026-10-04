import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Governor } from '../../server/governor.js';
import { COUNTDOWN, Room } from '../../server/room.js';
import { MAP_IDS } from '../../src/sim/mapData.js';
import { PHASE, PROTOCOL_VERSION } from '../../src/sim/protocol.js';

/** Shared by the room tests: a room on an injected clock, fake connections, and a lobby-to-round helper. */

const colliders = Object.fromEntries(MAP_IDS.map((id) => [id, JSON.parse(readFileSync(new URL(`../../assets/maps/${id}.json`, import.meta.url), 'utf8'))]));

export function makeRoom(opts = {}) {
  const clock = { t: Date.UTC(2026, 0, 1, 12) };
  let seed = 11;
  const rng = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const room = new Room({ colliders, now: () => clock.t, rng, governor: new Governor({ now: () => clock.t }), ...opts });
  return { room, clock };
}

export function join(room, name, extra = {}) {
  const conn = { sent: [], closed: null, send(d) { this.sent.push(d); }, close(code) { this.closed = code; } };
  room.open(conn);
  room.message(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, hash: room.hash, name, loadout: ['pistol', 'ar', 'shotgun', 'sniper'], ...extra }));
  const c = room.clients.get(conn);
  return { conn, c, p: c?.player, say: (m) => room.message(conn, JSON.stringify(m)) };
}

export const run = (room, seconds) => { for (let i = 0; i < seconds * 120; i++) room.step(); };

/** Lobby to a running round: the host sets the mode, everyone readies, the host starts, the countdown runs out. */
export function startRound(room, players, settings) {
  const [host, ...guests] = players;
  host.say({ t: 'settings', ...settings });
  for (const g of guests) g.say({ t: 'ready', ready: true });
  host.say({ t: 'start' });
  assert.equal(room.phase, PHASE.COUNTDOWN, room.startBlocker() ?? 'did not start');
  run(room, COUNTDOWN + 0.1);
  assert.equal(room.phase, PHASE.PLAYING);
}

