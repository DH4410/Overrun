import { Vector3 } from 'three';

import { FIXED_DT } from '../config.js';
import { buildMapWorld } from '../sim/colliders.js';
import { resetAmmo } from '../sim/combat.js';
import { HB_PLAYER } from '../sim/hitmath.js';
import { createPlayerBody, crouchShape, syncPlayerPoints } from '../sim/movement.js';
import { applyCommand } from '../sim/tick.js';
import { G_WORLD } from '../sim/world.js';

/**
 * Client-side prediction for your own player: a private physics world holding only the level,
 * the same applyCommand + world.step the server runs, and reconciliation against the state the
 * server sends back. Pure simulation, no DOM, so the swarm test runs it under Node as well.
 *
 * Every tick is tagged (seq, rep): the last command sent and how many unsent ticks have passed
 * since (an idle client sends nothing; the server repeats the last command, which is the idle
 * one). The server's you-block is tagged (ackSeq, ackAge) the same way, so the state to compare
 * against is found by tag. If it differs, or the server repeated a command the client never
 * repeated (a late packet), the client takes the server's state and replays what came after.
 */

const MAX_ENTRIES = 600;          // 5 s of ticks
const POS_EPS = 1e-3;             // m; closer than this is agreement
const VEL_EPS = 1e-2;

export function createSimPlayer(loadout) {
  const p = {
    body: createPlayerBody(G_WORLD),
    pos: new Vector3(), eye: new Vector3(), vel: new Vector3(),
    hb: HB_PLAYER, yaw: 0, pitch: 0, grounded: false, crouching: false, sprinting: false, aiming: false,
    slideTime: 0, landTime: 99, landKick: 0, airVy: 0,
    alive: false, health: 0, armor: 0, respawnTimer: 0, invulnTimer: 0,
    loadout: [...loadout], current: loadout[0], ammo: {}, fragCount: 3, smokeCount: 1,
    cooldown: 0, fireCarry: 0, reloading: 0, reloadTotal: 0, bloom: 0, sprayIndex: 0, sinceShot: 99,
    recoilPitch: 0, recoilYaw: 0, cooking: null, chargeTicks: 0, prevButtons: 0,
  };
  resetAmmo(p);
  return p;
}

const SCALARS = [
  'alive', 'grounded', 'sprinting', 'slideTime', 'airVy', 'landTime', 'health', 'armor', 'current',
  'fragCount', 'smokeCount', 'cooldown', 'fireCarry', 'reloading', 'reloadTotal', 'bloom', 'sprayIndex',
  'sinceShot', 'recoilPitch', 'recoilYaw', 'cooking', 'chargeTicks', 'prevButtons', 'respawnTimer', 'invulnTimer',
];

/** The player's state in the you-block's shape (see readYou). */
function capture(p) {
  const b = p.body;
  const s = {
    px: b.position.x, py: b.position.y, pz: b.position.z, vx: b.velocity.x, vy: b.velocity.y, vz: b.velocity.z,
    crouching: p.crouching, ammo: {},
  };
  for (const k of SCALARS) s[k] = p[k];
  for (const id in p.ammo) s.ammo[id] = { mag: p.ammo[id].mag, reserve: p.ammo[id].reserve };
  return s;
}

/** Whether a predicted state and the server's agree on everything that steers what comes next. */
function agrees(a, y) {
  if (Math.abs(a.px - y.px) > POS_EPS || Math.abs(a.py - y.py) > POS_EPS || Math.abs(a.pz - y.pz) > POS_EPS) return false;
  if (Math.abs(a.vx - y.vx) > VEL_EPS || Math.abs(a.vy - y.vy) > VEL_EPS || Math.abs(a.vz - y.vz) > VEL_EPS) return false;
  if (a.alive !== y.alive || a.crouching !== y.crouching || a.current !== y.current || a.cooking !== y.cooking) return false;
  if ((a.reloading > 0) !== (y.reloading > 0) || a.fragCount !== y.fragCount || a.smokeCount !== y.smokeCount) return false;
  for (const id in y.ammo) {
    const m = a.ammo[id];
    if (m && (m.mag !== y.ammo[id].mag || m.reserve !== y.ammo[id].reserve)) return false;
  }
  return true;
}

export class Predictor {
  constructor(loadout) {
    this.p = createSimPlayer(loadout);
    this.world = null;
    this.mapId = null;
    this.entries = [];             // { seq, rep, cmd, state } per tick, oldest first
    this.lastSeq = 0;
    this.lastRep = 0;
    this.stats = { compares: 0, agreed: 0, replays: 0, replayedTicks: 0, resyncs: 0, errors: [] };
  }

  /** Build the level for a map. `colliders` is the parsed assets/maps/<id>.json. */
  setMap(id, colliders, half) {
    if (this.mapId === id) return;
    if (this.world) this.world.removeBody(this.p.body);
    this.world = buildMapWorld(colliders, half).world;
    this.world.addBody(this.p.body);
    this.mapId = id;
    this.entries.length = 0;
  }

  /** Take the server's state wholesale. */
  apply(y) {
    const p = this.p, b = p.body;
    if (p.crouching !== y.crouching) crouchShape(p, y.crouching);
    b.position.set(y.px, y.py, y.pz);
    b.previousPosition.set(y.px, y.py, y.pz);
    b.velocity.set(y.vx, y.vy, y.vz);
    for (const k of SCALARS) p[k] = y[k];
    for (const id in y.ammo) {
      if (p.ammo[id]) { p.ammo[id].mag = y.ammo[id].mag; p.ammo[id].reserve = y.ammo[id].reserve; }
    }
    p.vel.set(y.vx, y.vy, y.vz);
    syncPlayerPoints(p);
  }

  /** Simulate one tick. `seq` is the command's sequence number if it was sent, else null. */
  tick(cmd, seq, armed, fx = null) {
    if (seq !== null) { this.lastSeq = seq; this.lastRep = 0; } else this.lastRep++;
    this.simulate(cmd, armed, fx);
    this.entries.push({ seq: this.lastSeq, rep: this.lastRep, cmd, state: capture(this.p) });
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
  }

  simulate(cmd, armed, fx) {
    const p = this.p;
    applyCommand(this.world, p, cmd, FIXED_DT, armed, fx);
    this.world.step(FIXED_DT);
    const b = p.body;
    p.vel.set(b.velocity.x, b.velocity.y, b.velocity.z);
    syncPlayerPoints(p);
  }

  /**
   * Check a snapshot's you-block against what was predicted for the same tick; on disagreement
   * take the server's state and replay everything after it. Returns how far the predicted
   * position moved (0 when it agreed), for the caller to smooth out on screen.
   */
  reconcile(snap, armed) {
    const y = snap.you;
    if (!y || !this.world) return 0;
    const { ackSeq, ackAge } = snap;
    // The newest tick the server has also simulated: its command acked, with no more unsent
    // ticks after it than the server has repeated.
    let i = -1;
    for (let j = this.entries.length - 1; j >= 0; j--) {
      const e = this.entries[j];
      if (e.seq === ackSeq && e.rep <= ackAge) { i = j; break; }
      if (e.seq < ackSeq) break;
    }
    this.stats.compares++;
    if (i >= 0 && this.entries[i].rep === ackAge && agrees(this.entries[i].state, y)) {
      this.stats.agreed++;
      this.entries.splice(0, i);
      return 0;
    }
    // Disagreement, a repeat the client did not make, or history already dropped: rewrite.
    const before = this.p.body.position.clone();
    this.apply(y);
    const rest = this.entries.slice(i + 1).filter((e) => e.seq > ackSeq || i >= 0);
    const lastCmd = this.entries[this.entries.length - 1]?.cmd;
    this.entries.length = 0;
    const resync = this.lastSeq === ackSeq && this.lastRep < ackAge && !!lastCmd;
    if (resync) {
      // Idle, and the server has run more ticks than this client (a slow frame dropped some):
      // take its tick count as well as its state, or every later snapshot would disagree too.
      this.lastRep = ackAge;
      this.entries.push({ seq: ackSeq, rep: ackAge, cmd: lastCmd, state: capture(this.p) });
    }
    for (const e of rest) {
      this.simulate(e.cmd, armed, null);
      e.state = capture(this.p);
      this.entries.push(e);
    }
    const err = before.distanceTo(this.p.body.position);
    if (resync) { this.stats.resyncs++; return err; }
    this.stats.replays++;
    this.stats.replayedTicks += rest.length;
    this.stats.errors.push(err);
    if (this.stats.errors.length > 5000) this.stats.errors.splice(0, 2500);
    return err;
  }

  /** Forget the predicted history; `seq` too on a reconnect, where numbering starts over. */
  clear(seq = false) {
    this.entries.length = 0;
    if (seq) { this.lastSeq = 0; this.lastRep = 0; }
  }
}
