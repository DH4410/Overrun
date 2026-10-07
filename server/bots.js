import { FIXED_DT } from '../src/config.js';
import { floorAt, inBlockers } from '../src/sim/colliders.js';
import { BTN, TICK_HZ, WEAPON_IDS, quantPitch, quantYaw } from '../src/sim/protocol.js';

/**
 * The hostiles of multiplayer survival: players the server drives itself. A bot is a seat like
 * any other (a physics body, a hitbox history, a loadout) whose command each tick comes from
 * botCommand() instead of a socket, so it walks, shoots and takes damage by exactly the rules a
 * person does, and every client already knows how to draw it.
 *
 * Moving needs a route. navFor() lays a half-metre grid over the map the first time a survival round
 * opens on it (a cell is open when its centre clears every blocker and has a floor), and
 * findPath() runs A* over it. The grid is shared by every room, and a bot replans about once a
 * second, so the whole thing costs well under a millisecond a tick even with a dozen bots.
 */

const CELL = 0.5;                 // fine enough that a 1.3 m gap between two containers has a cell in it
const PAD = 0.42;                 // a cell centre must clear every blocker by this: the body is 0.5 m wide
const STEP = 0.25;                // the most the floor may change between neighbouring cells (a ramp is 0.22 a metre)
const MAX_EXPAND = 30000;
const grids = new Map();

export function navFor(mapId, world, blockers, def) {
  let g = grids.get(mapId);
  if (g) return g;
  const [hx, hz] = def.half;
  const w = Math.ceil((2 * hx) / CELL), h = Math.ceil((2 * hz) / CELL);
  const ok = new Uint8Array(w * h), fy = new Float32Array(w * h).fill(-9);
  const castY = Math.min(def.ceilY - 0.5, 2.4);   // from head height, so a gantry or crane overhead is not mistaken for the floor
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = -hx + (i + 0.5) * CELL, z = -hz + (j + 0.5) * CELL;
      const y = floorAt(world, x, z, castY);
      if (y === null) continue;
      fy[j * w + i] = y;
      if (!inBlockers(blockers, x, z, PAD)) ok[j * w + i] = 1;
    }
  }
  const n = w * h;
  g = {
    w, h, hx, hz, ok, fy,
    stamp: 0, seen: new Uint32Array(n), done: new Uint32Array(n), gs: new Float32Array(n), from: new Int32Array(n),
  };
  grids.set(mapId, g);
  return g;
}

const cellOf = (g, x, z) => {
  const i = Math.floor((x + g.hx) / CELL), j = Math.floor((z + g.hz) / CELL);
  return i < 0 || j < 0 || i >= g.w || j >= g.h ? -1 : j * g.w + i;
};
const cellX = (g, c) => -g.hx + ((c % g.w) + 0.5) * CELL;
const cellZ = (g, c) => -g.hz + (Math.floor(c / g.w) + 0.5) * CELL;

/** The open cell nearest a point, searching a few rings out; -1 when there is none. */
function nearestOpen(g, x, z) {
  const c = cellOf(g, x, z);
  if (c >= 0 && g.ok[c]) return c;
  const ci = Math.floor((x + g.hx) / CELL), cj = Math.floor((z + g.hz) / CELL);
  let best = -1, bd = Infinity;
  for (let r = 1; r <= 6 && best < 0; r++) {
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= g.w || j >= g.h || !g.ok[j * g.w + i]) continue;
        const d = di * di + dj * dj;
        if (d < bd) { bd = d; best = j * g.w + i; }
      }
    }
  }
  return best;
}

/** True when a straight walk from a to b stays on open cells. */
export function lineOpen(g, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
  const n = Math.ceil(len / 0.5);
  let prev = -1;
  for (let k = 1; k <= n; k++) {
    const c = cellOf(g, ax + (dx * k) / n, az + (dz * k) / n);
    if (c < 0 || !g.ok[c]) return false;
    if (prev >= 0 && c !== prev && Math.abs(g.fy[c] - g.fy[prev]) > STEP) return false;
    prev = c;
  }
  return true;
}

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const top = v[0], lk = k.pop(), lv = v.pop();
    const n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];

/** A* over the grid: a list of [x, z] cell centres from a to b, or null when there is no way. */
export function findPath(g, ax, az, bx, bz) {
  const s = nearestOpen(g, ax, az), t = nearestOpen(g, bx, bz);
  if (s < 0 || t < 0) return null;
  if (s === t) return [[bx, bz]];
  const id = ++g.stamp, { w, h, ok, fy, seen, done, gs, from } = g;
  const tx = t % w, tz = Math.floor(t / w);
  const heur = (c) => {
    const dx = Math.abs((c % w) - tx), dz = Math.abs(Math.floor(c / w) - tz);
    return dx + dz + (1.414 - 2) * Math.min(dx, dz);
  };
  const open = new Heap();
  gs[s] = 0; seen[s] = id; from[s] = -1;
  open.push(heur(s), s);
  let expanded = 0, found = false;
  while (open.size && expanded++ < MAX_EXPAND) {
    const c = open.pop();
    if (done[c] === id) continue;
    done[c] = id;
    if (c === t) { found = true; break; }
    const ci = c % w, cj = Math.floor(c / w);
    for (const [di, dj, cost] of DIRS) {
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= w || j >= h) continue;
      const n = j * w + i;
      if (!ok[n] || done[n] === id || Math.abs(fy[n] - fy[c]) > STEP) continue;
      if (di && dj && (!ok[cj * w + i] || !ok[j * w + ci])) continue;   // no cutting a corner
      const g2 = gs[c] + cost;
      if (seen[n] !== id || g2 < gs[n]) {
        seen[n] = id; gs[n] = g2; from[n] = c;
        open.push(g2 + heur(n), n);
      }
    }
  }
  if (!found) return null;
  const out = [[bx, bz]];
  for (let c = from[t]; c >= 0 && c !== s; c = from[c]) out.push([cellX(g, c), cellZ(g, c)]);
  return out.reverse();
}

/* ------------------------------------------------------------------ the brain */

/** How a hostile fights on wave `wave`: sturdier, quicker to react and a better shot as the waves go on. */
export function botSpec(wave, rng) {
  const roll = rng();
  const weapon = wave >= 3 && roll < 0.2 ? 'shotgun' : roll < 0.5 ? 'smg' : 'ar';
  return {
    weapon,
    health: Math.min(180, 55 + wave * 9),
    dmg: Math.min(0.85, 0.42 + wave * 0.03),
    aimError: Math.max(0.016, 0.07 - wave * 0.004),
    reaction: Math.max(0.25, 0.75 - wave * 0.04),
    turn: Math.min(9, 4 + wave * 0.4),
    hold: weapon === 'shotgun' ? 6 : weapon === 'smg' ? 12 : 18,
    reach: weapon === 'shotgun' ? 14 : weapon === 'smg' ? 30 : 48,
    headAim: Math.min(0.35, wave * 0.025),
  };
}

/**
 * A zombie of Zombie Escape: no gun, a claw the room swings for it (server/room.js stepZombie).
 * Walkers are the crowd, runners keep pace with a sprinting person, brutes soak a magazine.
 * `age` is seconds into the round: the longer it goes, the sturdier and the more common the nasty kinds.
 * Health stays under 255 because a snapshot carries it in one byte.
 */
export function zombieSpec(age, rng) {
  const heat = Math.min(1, age / 240), roll = rng();
  const kind = roll < 0.08 + 0.1 * heat ? 'brute' : roll < 0.38 + 0.1 * heat ? 'runner' : 'walker';
  const base = { weapon: 'pistol', melee: true, kind, aimError: 0.02, reaction: 0, turn: 7, hold: 0, reach: 0, headAim: 0, dmg: 1 };
  if (kind === 'brute') return { ...base, health: Math.round(190 + 50 * heat), claw: 30, swing: 1.1, run: false, turn: 4.5 };
  if (kind === 'runner') return { ...base, health: Math.round(40 + 30 * heat), claw: 9, swing: 0.6, run: true, turn: 9 };
  return { ...base, health: Math.round(65 + 45 * heat), claw: 14, swing: 0.9, run: false };
}

export function newAi(spec, rng) {
  return {
    spec, target: null, retargetAt: 0, losAt: 0, los: false, seenAt: -9, path: null, pi: 0, replanAt: 0, replanFrom: null,
    way: null, wayAt: 0, yaw: rng() * Math.PI * 2, pitch: 0, eYaw: 0, eP: 0, eAt: 0,
    firing: false, switchAt: 0, phase: Math.floor(rng() * 24),
    strafe: rng() < 0.5 ? -1 : 1, strafeAt: 0, lastX: 0, lastZ: 0, stuckAt: 0, unstickUntil: 0, unstickDir: 1,
  };
}

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const HOLD = Object.freeze({ seq: 0, ix: 0, iz: 0, yawQ: 0, pitchQ: 0, buttons: 0, weapon: 0, emote: 0, viewTick: 0 });

/** The command a hostile issues this tick: where to walk, where to look, whether to fire. */
export function botCommand(room, p) {
  const ai = p.ai, spec = ai.spec, rng = room.rng;
  const t = room.tick / TICK_HZ;
  const weapon = Math.max(0, WEAPON_IDS.indexOf(p.current));
  if (!p.alive) return { ...HOLD, yawQ: quantYaw(ai.yaw), weapon, viewTick: room.tick };

  const body = p.body.position;
  // The nearest living person, looked at again now and then (and at once when theirs is gone).
  if (!ai.target?.alive || t >= ai.retargetAt) {
    ai.retargetAt = t + 0.7 + rng() * 0.4;
    let best = null, bd = Infinity;
    for (const q of room.players) {
      if (q.bot || !q.connected || !q.alive) continue;
      const d = (q.pos.x - p.pos.x) ** 2 + (q.pos.z - p.pos.z) ** 2;
      if (d < bd) { bd = d; best = q; }
    }
    ai.target = best;
  }
  const tgt = ai.target;
  if (!tgt) return { ...HOLD, yawQ: quantYaw(ai.yaw), pitchQ: quantPitch(ai.pitch), weapon, viewTick: room.tick };

  const dx = tgt.pos.x - p.pos.x, dz = tgt.pos.z - p.pos.z;
  const dist = Math.hypot(dx, dz);
  // Line of sight six times a second; a bot that has just seen you needs its reaction time to start shooting.
  if (t >= ai.losAt) {
    ai.losAt = t + 0.16 + rng() * 0.05;
    const los = dist < 80 && room.losClear(p.eye, tgt.pos);
    if (los && !ai.los) ai.seenAt = t;
    ai.los = los;
  }
  const canShoot = !spec.melee && ai.los && t - ai.seenAt >= spec.reaction && dist <= spec.reach;

  // Where to walk: strafe and hold a distance when it can see you, otherwise follow a route to you.
  const g = room.nav;
  let mx = 0, mz = 0, sprint = false;
  const holding = !spec.melee && ai.los && dist <= spec.hold * 1.4;
  if (holding) {
    if (t >= ai.strafeAt) { ai.strafe = -ai.strafe; ai.strafeAt = t + 0.7 + rng() * 1.1; }
    const ux = dx / (dist || 1), uz = dz / (dist || 1);
    const radial = dist > spec.hold ? 0.6 : dist < spec.hold * 0.5 ? -0.8 : 0;
    mx = -uz * ai.strafe + ux * radial;
    mz = ux * ai.strafe + uz * radial;
  } else if (g) {
    if (t >= ai.replanAt) {
      ai.replanAt = t + 0.9 + rng() * 0.5;
      ai.path = findPath(g, body.x, body.z, tgt.pos.x, tgt.pos.z);
      ai.pi = 0; ai.way = null;
    }
    if (ai.path) {
      while (ai.pi < ai.path.length - 1 && Math.hypot(ai.path[ai.pi][0] - body.x, ai.path[ai.pi][1] - body.z) < 0.6) ai.pi++;
      if (!ai.way || t >= ai.wayAt) {
        ai.wayAt = t + 0.05;
        let j = ai.pi;
        for (let k = Math.min(ai.path.length - 1, ai.pi + 12); k > ai.pi; k--) {
          if (lineOpen(g, body.x, body.z, ai.path[k][0], ai.path[k][1])) { j = k; break; }
        }
        ai.way = ai.path[j];
      }
      mx = ai.way[0] - body.x; mz = ai.way[1] - body.z;
    } else { mx = dx; mz = dz; }
    if (spec.melee && ai.los && dist < 7) { mx = dx; mz = dz; }   // close and in sight: straight at them, no detour round a cell corner
    sprint = spec.melee ? spec.run : !ai.los && dist > 14;
  } else { mx = dx; mz = dz; }

  // Wedged on something low: hop and sidestep, and plan again.
  let jump = false;
  if (t >= ai.stuckAt) {
    ai.stuckAt = t + 0.5;
    if ((mx || mz) && Math.hypot(body.x - ai.lastX, body.z - ai.lastZ) < 0.12 && !holding) {
      ai.unstickUntil = t + 0.6; ai.unstickDir = rng() < 0.5 ? -1 : 1; ai.replanAt = 0;
    }
    ai.lastX = body.x; ai.lastZ = body.z;
  }
  const unstick = t < ai.unstickUntil;
  if (unstick) jump = true;

  // Look: at you when it can see you, along its way otherwise, turning no faster than it can.
  if (t >= ai.eAt) {
    ai.eAt = t + 0.3;
    const e = spec.aimError * (1 + dist / 30);
    ai.eYaw = (rng() + rng() - 1) * e; ai.eP = (rng() + rng() - 1) * e;
  }
  let wantYaw = ai.yaw;
  if (ai.los) wantYaw = Math.atan2(-dx, -dz) + ai.eYaw;
  else if (mx || mz) wantYaw = Math.atan2(-mx, -mz);
  const turn = spec.turn * FIXED_DT;
  const dy = wrap(wantYaw - ai.yaw);
  ai.yaw = wrap(ai.yaw + Math.max(-turn, Math.min(turn, dy)));
  const aimY = tgt.pos.y + (spec.headAim > 0 && ((p.id + Math.floor(t / 2)) % 100) / 100 < spec.headAim ? 0.55 : 0.1);
  const wantPitch = ai.los ? Math.atan2(aimY - p.eye.y, dist || 1) + ai.eP : 0;
  ai.pitch += Math.max(-turn, Math.min(turn, wantPitch - ai.pitch));

  // Fire in bursts while it has you in its sights.
  const onTarget = Math.abs(dy) < 0.22 + spec.aimError;
  if (canShoot && onTarget) {
    if (t >= ai.switchAt) { ai.firing = !ai.firing; ai.switchAt = t + (ai.firing ? 0.5 + rng() * 0.7 : 0.35 + rng() * 0.6); }
  } else ai.firing = false;
  const auto = p.current === 'ar' || p.current === 'smg';
  let buttons = 0;
  if (ai.firing && (auto || (room.tick + ai.phase) % 24 === 0)) buttons |= BTN.FIRE;
  if (sprint && !ai.firing) buttons |= BTN.SPRINT;
  if (jump) buttons |= BTN.JUMP;
  const a = p.ammo[p.current];
  if (a && a.reserve < 30) a.reserve = 999;      // hostiles never run dry

  // The walk, in the frame of the way it is facing.
  let ix = 0, iz = 0;
  if (unstick) { ix = ai.unstickDir; iz = 1; } else if (mx || mz) {
    const len = Math.hypot(mx, mz);
    const ux = mx / len, uz = mz / len;
    const f = ux * -Math.sin(ai.yaw) + uz * -Math.cos(ai.yaw), r = ux * Math.cos(ai.yaw) + uz * -Math.sin(ai.yaw);
    iz = f > 0.38 ? 1 : f < -0.38 ? -1 : 0;
    ix = r > 0.38 ? 1 : r < -0.38 ? -1 : 0;
  }
  return { seq: p.lastCmd.seq + 1, ix, iz, yawQ: quantYaw(ai.yaw), pitchQ: quantPitch(ai.pitch), buttons, weapon, emote: 0, viewTick: room.tick };
}
