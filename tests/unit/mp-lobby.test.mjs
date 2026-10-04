import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Governor } from '../../server/governor.js';
import { COUNTDOWN, INTERMISSION, LATE_JOIN_CUTOFF, Room } from '../../server/room.js';
import { MAP_IDS } from '../../src/sim/mapData.js';
import { PHASE, PROTOCOL_VERSION } from '../../src/sim/protocol.js';
import { cleanSettings } from '../../src/sim/modes.js';

/** The lobby: host, ready-up, countdown, results, late joiners and chat, with no sockets. */

const colliders = Object.fromEntries(MAP_IDS.map((id) => [id, JSON.parse(readFileSync(new URL(`../../assets/maps/${id}.json`, import.meta.url), 'utf8'))]));

function makeRoom(opts = {}) {
  const clock = { t: Date.UTC(2026, 0, 1, 12) };
  let seed = 7;
  const rng = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const room = new Room({ colliders, now: () => clock.t, rng, governor: new Governor({ now: () => clock.t }), ...opts });
  return { room, clock };
}

function join(room, name, extra = {}) {
  const conn = { sent: [], closed: null, send(d) { this.sent.push(d); }, close(code) { this.closed = code; } };
  room.open(conn);
  room.message(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, hash: room.hash, name, loadout: ['pistol', 'ar', 'shotgun', 'sniper'], ...extra }));
  const c = room.clients.get(conn);
  return { conn, c, p: c?.player, say: (m) => room.message(conn, JSON.stringify(m)) };
}

const jsons = (conn) => conn.sent.filter((d) => typeof d === 'string').map((d) => JSON.parse(d));
const lastJson = (conn, t) => jsons(conn).findLast((m) => m.t === t);
const run = (room, seconds) => { for (let i = 0; i < seconds * 120; i++) room.step(); };

test('a new room is a lobby; the first player in is the host and cannot start alone', () => {
  const { room } = makeRoom();
  assert.equal(room.phase, PHASE.LOBBY);
  const A = join(room, 'A');
  assert.equal(room.hostSeat, A.p);
  assert.match(room.startBlocker(), /NEEDS 2/);
  A.say({ t: 'start' });
  assert.equal(room.phase, PHASE.LOBBY);
});

test('the round starts only when 2+ are seated and everyone but the host is ready, then counts down', () => {
  const { room } = makeRoom();
  const A = join(room, 'A'), B = join(room, 'B');
  assert.match(room.startBlocker(), /WAITING FOR 1/);
  B.say({ t: 'start' });                       // not the host
  A.say({ t: 'start' });                       // host, but B is not ready
  assert.equal(room.phase, PHASE.LOBBY);
  B.say({ t: 'ready', ready: true });
  assert.equal(room.startBlocker(), null);
  B.say({ t: 'start' });
  assert.equal(room.phase, PHASE.LOBBY, 'only the host starts');
  A.say({ t: 'start' });
  assert.equal(room.phase, PHASE.COUNTDOWN);
  assert.ok(A.p.alive && B.p.alive, 'spawned for the countdown');
  run(room, COUNTDOWN + 0.1);
  assert.equal(room.phase, PHASE.PLAYING);
  assert.ok(Math.abs(room.timeLeft - (room.settings.time - 0.1)) < 0.2);
});

test('the host chooses the settings; a hand-made message cannot pick anything off the lists', () => {
  const { room } = makeRoom();
  const A = join(room, 'A'), B = join(room, 'B');
  B.say({ t: 'settings', mode: 'tdm' });
  assert.equal(room.settings.mode, 'dm', 'a guest cannot change settings');
  A.say({ t: 'settings', mode: 'tdm', map: 'snow', time: 180, limit: 15, weapons: 'sniper' });
  assert.deepEqual(room.settings, { mode: 'tdm', map: 'snow', time: 180, limit: 15, weapons: 'sniper' });
  A.say({ t: 'settings', mode: 'nonsense', map: '../../etc', time: 99999, limit: -1, weapons: 'rpg' });
  assert.deepEqual(room.settings, { mode: 'tdm', map: 'snow', time: 180, limit: 15, weapons: 'sniper' });
  A.say({ t: 'settings', mode: 'survival' });
  assert.equal(room.settings.mode, 'survival');
  assert.equal(room.settings.limit, 15, 'a limit on the survival list is kept');
  A.say({ t: 'settings', mode: 'tdm', limit: 15 });
  assert.equal(cleanSettings({ mode: 'dm' }, room.settings).limit, 20, 'a limit from the other mode falls back to the default');
});

test('a one-gun rule gives everyone only that gun for the round, and the locker is back in the lobby', () => {
  const { room } = makeRoom();
  const A = join(room, 'A'), B = join(room, 'B');
  A.say({ t: 'settings', weapons: 'sniper', mode: 'tdm' });
  B.say({ t: 'ready', ready: true });
  A.say({ t: 'start' });
  assert.deepEqual(A.p.loadout, ['sniper']);
  assert.equal(A.p.current, 'sniper');
  assert.notEqual(A.p.team, B.p.team, 'teams dealt');
  room.endMatch('TEST', '', {});
  assert.equal(room.phase, PHASE.INTERMISSION);
  run(room, INTERMISSION + 0.1);
  assert.equal(room.phase, PHASE.LOBBY);
  assert.deepEqual(A.p.loadout, ['pistol', 'ar', 'shotgun', 'sniper']);
  assert.equal(B.p.ready, false, 'ready is cleared for the next round');
});

test('the host passes to the next player when they leave', () => {
  const { room } = makeRoom();
  const A = join(room, 'A'), B = join(room, 'B');
  room.close(A.conn);
  assert.equal(room.hostSeat, B.p);
  assert.equal(lastJson(B.conn, 'roster').host, B.p.id);
});

test('a countdown with fewer than two players left drops back to the lobby', () => {
  const { room } = makeRoom();
  const A = join(room, 'A'), B = join(room, 'B');
  B.say({ t: 'ready', ready: true });
  A.say({ t: 'start' });
  room.close(B.conn);
  room.step();
  assert.equal(room.phase, PHASE.LOBBY);
});

test('newcomers join a round in progress, unless it is nearly over; then they wait for the lobby', () => {
  const { room } = makeRoom({ autostart: true });
  const A = join(room, 'A');
  const B = join(room, 'B');
  assert.ok(B.p, 'joins mid-round');
  room.timeLeft = LATE_JOIN_CUTOFF - 1;
  const C = join(room, 'C');
  assert.ok(!C.p);
  assert.equal(C.c.queued, true);
  assert.equal(lastJson(C.conn, 'welcome').queued, true);
  room.endMatch('TEST', '', {});
  run(room, INTERMISSION + 0.1);
  assert.equal(room.phase, PHASE.LOBBY);
  assert.ok(C.c.player, 'seated when the lobby opens');
  assert.equal(lastJson(C.conn, 'welcome').spectator, false);
  assert.equal(A.p.connected, true);
});

test('chat: broadcast, team-only in a team round, cleaned, and rate limited on its own bucket', () => {
  const { room, clock } = makeRoom({ autostart: true, mode: 'tdm' });
  const A = join(room, 'A'), B = join(room, 'B'), C = join(room, 'C'), D = join(room, 'D');
  const watcher = join(room, 'W', { spectate: true });
  A.say({ t: 'chat', text: '  hello\u0007   there  ' });
  for (const x of [A, B, C, D, watcher]) assert.equal(lastJson(x.conn, 'chat').text, 'hello there');
  assert.equal(lastJson(watcher.conn, 'chat').name, 'A');
  clock.t += 2000;
  const mate = [B, C, D].find((x) => x.p.team === A.p.team), foe = [B, C, D].find((x) => x.p.team !== A.p.team);
  A.say({ t: 'chat', text: 'team only', team: true });
  assert.equal(lastJson(mate.conn, 'chat').text, 'team only');
  assert.notEqual(lastJson(foe.conn, 'chat')?.text, 'team only');
  assert.notEqual(lastJson(watcher.conn, 'chat')?.text, 'team only');
  clock.t += 5000;
  A.say({ t: 'chat', text: 'x'.repeat(500) });
  assert.equal(lastJson(B.conn, 'chat').text.length, 120);
  // A flood: only the burst gets through, and the control bucket is untouched.
  clock.t += 5000;
  const count = () => jsons(B.conn).filter((m) => m.t === 'chat' && !m.sys).length;
  const before = count(), json = A.c.json;
  for (let i = 0; i < 20; i++) A.say({ t: 'chat', text: `spam ${i}` });
  assert.ok(count() - before <= 4, `${count() - before} lines got through`);
  assert.equal(A.c.json, json, 'chat does not spend the control-message bucket');
});

test('results carry headshots and damage per player', () => {
  const { room } = makeRoom({ autostart: true });
  const A = join(room, 'A'), B = join(room, 'B');
  A.p.invulnTimer = 0; B.p.invulnTimer = 0;
  room.applyDamage(B.p, 90, A.p, A.p.pos, true, 'head', 'ar');
  room.applyDamage(B.p, 90, A.p, A.p.pos, true, 'head', 'ar');
  room.endMatch('TEST', '', { id: A.p.id });
  const end = lastJson(A.conn, 'end');
  const row = end.standings.find((r) => r.id === A.p.id);
  assert.equal(row.kills, 1);
  assert.equal(row.headshots, 1);
  assert.ok(row.damage >= 100 && row.damage <= 180, `damage ${row.damage}`);
  assert.deepEqual(end.winner, { id: A.p.id });
});

test('nobody walks in the lobby or the countdown, but they can once the round runs', () => {
  const { room } = makeRoom();
  const A = join(room, 'A'), B = join(room, 'B');
  const walk = (p, seq) => p.queue.push({ seq, ix: 0, iz: 1, yawQ: 0, pitchQ: 0, buttons: 0, weapon: 0, emote: 0, viewTick: room.tick });
  const before = { x: A.p.body.position.x, z: A.p.body.position.z };
  for (let i = 0; i < 120; i++) { walk(A.p, i + 1); room.step(); }
  assert.equal(room.phase, PHASE.LOBBY);
  assert.deepEqual({ x: A.p.body.position.x, z: A.p.body.position.z }, before, 'moved in the lobby');

  B.say({ t: 'ready', ready: true });
  A.say({ t: 'start' });
  assert.equal(room.phase, PHASE.COUNTDOWN);
  const at = { x: A.p.body.position.x, z: A.p.body.position.z };
  for (let i = 0; i < 120; i++) { walk(A.p, 200 + i); room.step(); }
  assert.deepEqual({ x: A.p.body.position.x, z: A.p.body.position.z }, at, 'moved in the countdown');

  for (let i = 0; i < (COUNTDOWN + 0.1) * 120; i++) room.step();
  assert.equal(room.phase, PHASE.PLAYING);
  const start = { x: A.p.body.position.x, z: A.p.body.position.z };
  for (let i = 0; i < 120; i++) { walk(A.p, 400 + i); room.step(); }
  assert.ok(Math.hypot(A.p.body.position.x - start.x, A.p.body.position.z - start.z) > 1, 'did not move in the round');
});

test('the locker in the lobby changes your skin and loadout for everyone; nothing off the lists, nothing mid-round', () => {
  const { room } = makeRoom();
  const A = join(room, 'A', { character: 'swat' }), B = join(room, 'B');
  A.say({ t: 'gear', character: 'ely', loadout: ['pistol', 'smg', 'ar', 'sniper'] });
  assert.equal(A.p.character, 'ely');
  assert.deepEqual(A.p.loadout, ['pistol', 'smg', 'ar', 'sniper']);
  assert.deepEqual(A.p.chosen, ['pistol', 'smg', 'ar', 'sniper']);
  A.say({ t: 'gear', character: 'not-a-skin', loadout: ['bazooka'] });
  assert.equal(A.p.character, 'ely', 'a made-up skin is ignored');
  assert.deepEqual(A.p.loadout, ['pistol', 'smg', 'ar', 'sniper'], 'so is a made-up loadout');
  A.say({ t: 'gear', character: 'soldier' });
  assert.equal(A.p.character, 'ely', 'the fallback rig is never offered');
  assert.equal(lastJson(B.conn, 'roster').players.find((q) => q.id === A.p.id).character, 'ely', 'the lobby is told');
  B.say({ t: 'ready', ready: true });
  A.say({ t: 'start' });
  run(room, COUNTDOWN + 0.1);
  assert.equal(room.phase, PHASE.PLAYING);
  A.say({ t: 'gear', character: 'crypto' });
  assert.equal(A.p.character, 'ely', 'no wardrobe changes in a round');
});
