import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Predictor } from '../../src/net/predict.js';
import { MAP_DATA, MAP_IDS } from '../../src/sim/mapData.js';
import { BTN, EV, MAX_CMDS_PER_PACKET, PHASE, TICK_HZ, WEAPON_IDS, quantPitch, quantYaw } from '../../src/sim/protocol.js';
import { WsBot } from './wsclient.mjs';

/**
 * The swarm: a real server process, 10 scripted players and 6 spectators over WebSockets with
 * added latency and jitter. Each player predicts itself with src/net/predict.js, exactly as the
 * browser does, so this measures how far prediction and the server drift apart, as well as the
 * traffic, the snapshot size and the server's cost per tick.
 *
 *   node tests/mp/swarm.mjs              (SWARM_SECONDS=40 by default; 300 for the long run)
 *
 * Phases: active (everyone runs, jumps, crouches, shoots), then idle (nobody touches anything,
 * so clients send nothing) during which one client sends forged messages that must change
 * nobody's health. Exits non-zero if an assertion fails.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PORT = Number(process.env.SWARM_PORT || 8795);
const SECONDS = Number(process.env.SWARM_SECONDS || 40);
const PLAYERS = 10, SPECTATORS = 6;
// Prediction costs ~0.3 ms a tick plus replays; ten in one Node process would starve the loop
// that is meant to be measuring, so only the first few predict (the rest just play).
const PREDICTING = Number(process.env.SWARM_PREDICTING || 3);
const ACTIVE = SECONDS * 0.7, IDLE = SECONDS * 0.3;
const colliders = Object.fromEntries(MAP_IDS.map((id) => [id, JSON.parse(readFileSync(join(ROOT, 'assets', 'maps', `${id}.json`), 'utf8'))]));
const LOADOUT = ['ar', 'pistol', 'shotgun', 'sniper'];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, q) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const stats = async () => (await fetch(`http://127.0.0.1:${PORT}/stats`)).json();
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); };

/** A scripted player: a 120 Hz command stream from a wandering intent, predicted locally. */
class SwarmPlayer {
  constructor(i) {
    this.predicts = i < PREDICTING;
    const lagMs = 60 + (i % 5) * 25, jitterMs = (i % 3) * 15;
    this.bot = new WsBot(`ws://127.0.0.1:${PORT}/ws`, { name: `SWARM${i}`, loadout: LOADOUT, lagMs, jitterMs });
    this.pred = new Predictor(LOADOUT);
    this.seq = 0; this.ticks = 0; this.t0 = 0; this.pending = []; this.lastSent = null;
    this.intent = { ix: 0, iz: 1, yaw: Math.random() * 6.28, buttons: 0, until: 0 };
    this.active = true;
    this.sentAt = 0;
    this.corrections = [];
    this.lastPump = 0; this.maxGap = 0;   // the longest stall of this process's own pump since the last correction
    this.bot.onSnap = (s) => {
      if (!s.you) return;
      this.pred.setMap(MAP_IDS[s.map], colliders[MAP_IDS[s.map]], MAP_DATA[MAP_IDS[s.map]].half);
      if (!this.started) { this.pred.apply(s.you); this.started = true; this.t0 = performance.now(); return; }
      const spawned = s.events.some((e) => e.kind === EV.SPAWN && e.id === s.youId);
      if (spawned) this.pred.clear();
      if (!this.predicts) { this.pred.apply(s.you); return; }
      // Each correction is tagged with its cause: a death or a respawn the client could not
      // have predicted (the browser snaps those), or neither, which is the drift that blends.
      const wasAlive = this.pred.p.alive, replays = this.pred.stats.replays;
      const err = this.pred.reconcile(s, s.phase === PHASE.PLAYING);
      if (this.pred.stats.replays === replays) return;      // agreed, or an idle tick-count resync
      const cause = spawned ? 'spawn' : wasAlive !== s.you.alive ? 'death' : 'drift';
      this.corrections.push({ err, cause, gap: this.maxGap });
      this.maxGap = 0;
    };
  }

  wander(now) {
    const it = this.intent;
    if (now < it.until) return;
    const r = Math.random();
    it.until = now + 400 + Math.random() * 1200;
    it.ix = [-1, 0, 0, 1][Math.floor(Math.random() * 4)];
    it.iz = r < 0.15 ? 0 : r < 0.25 ? -1 : 1;
    it.yaw += (Math.random() - 0.5) * 2.5;
    it.buttons = 0;
    if (Math.random() < 0.3) it.buttons |= BTN.SPRINT;
    if (Math.random() < 0.25) it.buttons |= BTN.FIRE;
    if (Math.random() < 0.1) it.buttons |= BTN.CROUCH;
    if (Math.random() < 0.08) it.buttons |= BTN.AIM;
    if (Math.random() < 0.05) it.buttons |= BTN.RELOAD;
    it.jumpAt = Math.random() < 0.3 ? this.ticks + 10 : -1;
  }

  /** The nearest other living player in the last snapshot, if any is within 40 m. */
  target(s) {
    if (!s) return null;
    const me = this.pred.p.body.position;
    let best = null, bestD = 40 * 40;
    for (const q of s.players) {
      if (q.id === s.youId || !q.alive) continue;
      const d = (q.pos.x - me.x) ** 2 + (q.pos.z - me.z) ** 2;
      if (d < bestD) { bestD = d; best = q; }
    }
    return best;
  }

  /** Run every tick owed by wall time, and send a packet when one is due. */
  pump(now) {
    if (!this.started || this.bot.closed) return;
    if (this.lastPump) this.maxGap = Math.max(this.maxGap, now - this.lastPump);
    this.lastPump = now;
    const s = this.bot.snap;
    const owed = Math.floor((now - this.t0) * TICK_HZ / 1000) - this.ticks;
    for (let k = 0; k < Math.min(owed, 60); k++) {
      this.ticks++;
      if (this.active) this.wander(now);
      const it = this.intent, p = this.pred.p;
      const alive = p.alive;
      let cmd;
      if (!this.active || !alive) {
        // Idle (or dead): the same look and weapon, nothing pressed.
        cmd = { ix: 0, iz: 0, yawQ: this.lastSent?.yawQ ?? 0, pitchQ: this.lastSent?.pitchQ ?? 0, buttons: 0, weapon: this.lastSent?.weapon ?? 1, emote: 0 };
      } else {
        let buttons = it.buttons;
        if (it.jumpAt === this.ticks) buttons |= BTN.JUMP;
        let yaw = it.yaw, pitch = -0.05;
        const t = (buttons & BTN.FIRE) && this.target(s);
        if (t) {
          const dx = t.pos.x - p.eye.x, dy = t.pos.y + 0.65 - p.eye.y, dz = t.pos.z - p.eye.z;
          yaw = Math.atan2(-dx, -dz) + (Math.random() - 0.5) * 0.06;
          pitch = Math.atan2(dy, Math.hypot(dx, dz));
        }
        cmd = { ix: it.ix, iz: it.iz, yawQ: quantYaw(yaw), pitchQ: quantPitch(pitch), buttons, weapon: WEAPON_IDS.indexOf('ar'), emote: 0 };
      }
      const L = this.lastSent;
      const idle = !cmd.ix && !cmd.iz && !cmd.buttons && L && L.yawQ === cmd.yawQ && L.pitchQ === cmd.pitchQ
        && L.weapon === cmd.weapon && L.emote === cmd.emote && !L.ix && !L.iz && !L.buttons;
      const armed = s?.phase === PHASE.PLAYING;
      if (!idle && alive) {
        this.seq++;
        this.pending.push(cmd);
        this.lastSent = cmd;
      }
      if (this.predicts) this.pred.tick(cmd, idle || !alive ? null : this.seq, armed);
    }
    if (owed > 60) this.ticks += owed - 60;
    const rate = s?.inputRate || 20;
    if (this.pending.length && now - this.sentAt >= 1000 / rate) {
      this.sentAt = now;
      const viewTick = Math.max(0, (s?.tick ?? 0) - 12);
      while (this.pending.length) {
        const cmds = this.pending.splice(0, MAX_CMDS_PER_PACKET);
        this.bot.sendCmds(cmds, this.seq - this.pending.length - cmds.length + 1, viewTick);
      }
    }
  }
}

async function main() {
  const budgetFile = join(tmpdir(), `overrun-swarm-budget-${process.pid}.json`);
  const server = spawn(process.execPath, [join(ROOT, 'server', 'node.js'), String(PORT)], {
    env: { ...process.env, MP_BUDGET_FILE: budgetFile }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { if (String(d).includes('multiplayer on')) resolve(); });
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  try {
    await run();
  } finally {
    server.kill();
  }
}

async function run() {
  const players = Array.from({ length: PLAYERS }, (_, i) => new SwarmPlayer(i));
  const specs = Array.from({ length: SPECTATORS }, (_, i) => new WsBot(`ws://127.0.0.1:${PORT}/ws`, { name: `SPEC${i}`, spectate: true, lagMs: 80 }));
  await Promise.all([...players.map((p) => p.bot.ready), ...specs.map((s) => s.ready)]);
  check(players.every((p) => p.bot.welcome && !p.bot.welcome.spectator), `${PLAYERS} players seated`);
  check(specs.every((s) => s.welcome?.spectator), `${SPECTATORS} spectators admitted`);

  const timer = setInterval(() => { const now = performance.now(); for (const p of players) p.pump(now); }, 1);

  // Active phase.
  await wait(2000);
  const a0 = await stats(), aT = performance.now(), aIn = players.map((p) => p.bot.bytesIn);
  const events = { kills: 0, hits: 0, shots: 0 };
  const countEvents = (s) => { for (const e of s.events) { if (e.kind === EV.KILL) events.kills++; if (e.kind === EV.HIT) events.hits++; if (e.kind === EV.SHOT) events.shots++; } };
  specs[0].onSnap = countEvents;
  await wait(ACTIVE * 1000 - 2000);
  const a1 = await stats(), aSec = (performance.now() - aT) / 1000;
  const aBytesIn = players.map((p, i) => (p.bot.bytesIn - aIn[i]) / aSec);

  // Idle phase: everyone lets go. Give in-flight grenades and respawns time to settle first,
  // measure the idle traffic, then forge.
  for (const p of players) p.active = false;
  await wait(4000);
  const i0 = await stats(), iT = performance.now();
  await wait(Math.max(3000, IDLE * 1000 - 8000));
  const i1 = await stats(), iSec = (performance.now() - iT) / 1000;
  const healthBefore = new Map(specs[0].snap.players.map((q) => [q.id, q.health]));
  const idleEvents = { kills: 0, hits: 0 };
  specs[0].onSnap = (s) => { for (const e of s.events) { if (e.kind === EV.KILL) idleEvents.kills++; if (e.kind === EV.HIT) idleEvents.hits++; } };
  // Forged traffic from player 0: made-up JSON verbs, a damage claim, a malformed and an
  // oversized binary packet.
  const cheat = players[0].bot;
  const victim = specs[0].snap.players.find((q) => q.id !== cheat.welcome.id).id;
  cheat.sendJson({ t: 'hit', victim, dmg: 999, zone: 'head' });
  cheat.sendJson({ t: 'damage', target: victim, amount: 500 });
  cheat.sendJson({ t: 'kill', victim });
  cheat.sendJson({ t: 'state', health: 1000, pos: [0, 0, 0] });
  cheat.raw(new Uint8Array([1, 200, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer);
  cheat.raw(new Uint8Array(3000).fill(1).buffer);
  await wait(3000);
  const healthAfter = new Map(specs[0].snap.players.map((q) => [q.id, q.health]));
  const f1 = await stats();
  clearInterval(timer);

  // Numbers.
  const msgsActive = (a1.totals.msgsIn - a0.totals.msgsIn) / aSec;
  const msgsIdle = (i1.totals.msgsIn - i0.totals.msgsIn) / iSec;
  const perPlayerHour = (m) => (m / PLAYERS) * 3600 / 20;
  const pred = players.filter((p) => p.predicts).map((p) => p.pred.stats);
  const compares = pred.reduce((n, s) => n + s.compares, 0), agreed = pred.reduce((n, s) => n + s.agreed, 0);
  const replays = pred.reduce((n, s) => n + s.replays, 0), replayed = pred.reduce((n, s) => n + s.replayedTicks, 0);
  const corr = players.filter((p) => p.predicts).flatMap((p) => p.corrections);
  const byCause = (c) => corr.filter((x) => x.cause === c).map((x) => x.err);
  const drift = byCause('drift');
  const bigDrift = corr.filter((x) => x.cause === 'drift' && x.err >= 1);
  console.log('\n--- swarm', SECONDS, 's,', PLAYERS, 'players +', SPECTATORS, 'spectators, rtt 60-160 ms + jitter 0-30 ms');
  console.log('server ms/tick avg', a1.msPerTick.avg, 'p95', a1.msPerTick.p95, 'max', a1.msPerTick.max, '| callback gap ms', JSON.stringify(a1.callbackGapMs));
  console.log('ticks dropped', f1.totals.ticksDropped, '| cmds repeated', f1.totals.cmdsRepeated, 'trimmed', f1.totals.cmdsTrimmed, '| input dropped', f1.totals.inputDropped, 'bad', f1.totals.inputBad);
  console.log('snapshot bytes avg', a1.snapshotBytes.avg, 'max', a1.snapshotBytes.max, '| per-client download', Math.round(pct(aBytesIn, 0.5)), 'B/s (median)');
  console.log(`msgs in/s active ${msgsActive.toFixed(1)} (${(msgsActive / PLAYERS).toFixed(1)}/player), idle ${msgsIdle.toFixed(2)}`);
  console.log(`billed requests/hour/player: active ${perPlayerHour(msgsActive).toFixed(0)}, idle ${perPlayerHour(msgsIdle).toFixed(1)}`);
  console.log(`events (active, seen by a spectator): shots ${events.shots}, hits ${events.hits}, kills ${events.kills}`);
  console.log(`prediction: ${compares} checks, ${agreed} agreed (${(100 * agreed / Math.max(1, compares)).toFixed(1)}%), ${replays} replays of ${(replayed / Math.max(1, replays)).toFixed(1)} ticks avg`);
  console.log(`   ${pred.reduce((n, s) => n + s.resyncs, 0)} idle resyncs (the client had run fewer ticks than the server; state and tick count taken, nothing replayed)`);
  console.log('  (with no network in between prediction matches the room tick for tick: tests/unit/mp-predict.test.mjs;');
  console.log('   these replays follow late input the server had to stand in for, pickups and respawns)');
  console.log(`corrections: ${byCause('death').length} at a death, ${byCause('spawn').length} at a respawn (both snap), ${drift.length} drift`);
  console.log(`drift correction distance (n=${drift.length}): p50 ${pct(drift, 0.5).toFixed(4)} p95 ${pct(drift, 0.95).toFixed(4)} p99 ${pct(drift, 0.99).toFixed(4)} max ${Math.max(0, ...drift).toFixed(4)} m`);
  if (bigDrift.length) console.log('  drift >= 1 m:', bigDrift.map((x) => `${x.err.toFixed(2)} m (swarm pump stalled up to ${x.gap.toFixed(0)} ms before it)`).join(', '));
  console.log('rtt seen by the server', JSON.stringify(a1.rtt), '| budget', JSON.stringify(f1.budget));
  console.log('---\n');

  check(f1.totals.ticksDropped === 0, 'the server never fell behind');
  check(f1.totals.inputBad >= 2, 'the malformed packets were counted as bad');
  check(events.kills > 0 && events.hits > 0, 'the active phase had fights');
  check(msgsActive / PLAYERS <= 21, `at most ~20 packets/s per active player (${(msgsActive / PLAYERS).toFixed(1)})`);
  check(msgsIdle < 0.5, `idle players send nothing (${msgsIdle.toFixed(2)} msgs/s)`);
  check(idleEvents.hits === 0 && idleEvents.kills === 0, 'forged messages hurt nobody');
  check([...healthBefore].every(([id, h]) => (healthAfter.get(id) ?? h) >= h), 'nobody lost health to forged messages');
  check(players.every((p) => p.bot.closed === null || p.bot === cheat), 'nobody but the cheater was disconnected');
  check(compares > SECONDS * 20 * PREDICTING * 0.5, 'prediction was checked against most snapshots');
  check(agreed / Math.max(1, compares) > 0.95, 'prediction agrees with the server on at least 95% of snapshots');
  check(bigDrift.length === 0, `no drift correction big enough to snap (max ${Math.max(0, ...drift).toFixed(3)} m)`);

  for (const p of players) p.bot.close();
  for (const s of specs) s.close();
  await wait(300);
}

main().then(() => {
  if (failures.length) { console.log(`${failures.length} failed`); process.exit(1); }
  process.exit(0);
}, (e) => { console.error(e); process.exit(1); });
