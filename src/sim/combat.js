import { Euler, Quaternion } from 'three';

import { CONFIG } from '../config.js';
import { clamp, lerp } from '../utils.js';
import { BTN, WEAPON_IDS } from './protocol.js';
import { WEAPONS, WEAPON_BY_ID, playerSpread, recoilStep } from './weaponData.js';

/**
 * A multiplayer player's weapons, one fixed tick at a time: timers, reload, swap, fire and the
 * grenade in hand. The server runs it for real and the client runs the same code to predict its
 * own ammo, recoil and spray, so what you see down the barrel is what the server shot. Single
 * player keeps its own per-frame version in src/player.js.
 *
 * Differences from single player, all deliberate: the recoil has no random component (the
 * pattern alone, so client and server agree), and fire comes from the eye, not the muzzle.
 */

export const THROW_POWER_SOFT = 6;    // m/s at a tap
export const THROW_POWER_HARD = 21;   // m/s at a full hold
export const THROW_LIFT_SOFT = 0.4;   // extra upward aim at a tap, so a short lob clears a crate
export const THROW_LIFT_HARD = 0.06;
/** Recoil decays to this fraction per second (see applyLook in src/player.js). */
export const RECOIL_RECOVERY = 0.0009;

export function resetAmmo(p) {
  p.ammo = {};
  for (const w of WEAPONS) {
    if (w.thrown) continue;
    p.ammo[w.id] = { mag: w.mag, reserve: w.reserve };
  }
  p.fragCount = 3;
  p.smokeCount = 1;
}

const _e = new Euler(0, 0, 0, 'YXZ');
const _q = new Quaternion();

/** Where the player is aiming, recoil included. */
export function aimDirection(p, out) {
  _e.set(p.pitch + p.recoilPitch, p.yaw + p.recoilYaw, 0, 'YXZ');
  _q.setFromEuler(_e);
  return out.set(0, 0, -1).applyQuaternion(_q);
}

/** The throw a release now would make: direction into `out`, speed returned. */
export function throwAim(p, out) {
  const c = clamp(p.chargeTicks / CONFIG.PHYSICS_HZ / CONFIG.THROW_CHARGE_TIME, 0, 1);
  aimDirection(p, out);
  out.y += lerp(THROW_LIFT_SOFT, THROW_LIFT_HARD, c);
  out.normalize();
  return lerp(THROW_POWER_SOFT, THROW_POWER_HARD, c);
}

/** A throw's launch velocity, the same as single player's launchVelocity. */
export function launchVelocity(vel, dir, power, out) {
  return out.set(
    dir.x * power + vel.x,
    dir.y * power + 1.6 + Math.max(0, vel.y) * 0.5,
    dir.z * power + vel.z,
  );
}

function startReload(p) {
  const w = WEAPON_BY_ID[p.current];
  if (w.thrown || p.reloading > 0) return;
  const a = p.ammo[w.id];
  if (a.mag >= w.mag || a.reserve <= 0) return;
  p.reloading = w.reload;
  p.reloadTotal = w.reload;
}

function finishReload(p) {
  const w = WEAPON_BY_ID[p.current];
  const a = p.ammo[w.id];
  const take = Math.min(w.mag - a.mag, a.reserve);
  a.mag += take; a.reserve -= take;
}

/**
 * One tick. `cmd` is a decoded command ({ buttons, weapon }); `armed` is false outside a running
 * round. `fx` is optional callbacks: fire(p, weapon, cone), throw(p, kind), reload(p).
 * Spray and recoil recover even while dead, as in single player.
 */
export function stepWeapons(p, cmd, dt, armed, fx = null) {
  p.sinceShot += dt;
  const sw = WEAPON_BY_ID[p.current];
  if (p.bloom > 0 && sw) {
    if (p.sinceShot > sw.cooldown * 1.35) {
      p.bloom = Math.max(0, p.bloom - (sw.bloomDecay ?? 0.1) * dt);
      if (p.bloom === 0) p.sprayIndex = 0;
    }
  } else if (p.sinceShot > 0.35) {
    p.sprayIndex = 0;
  }
  const rec = Math.pow(RECOIL_RECOVERY, dt);
  p.recoilPitch *= rec;
  p.recoilYaw *= rec;

  const b = cmd.buttons;
  const prev = p.prevButtons;
  p.prevButtons = b;
  if (!p.alive) { p.cooking = null; return; }
  if (p.invulnTimer > 0) p.invulnTimer = Math.max(0, p.invulnTimer - dt);

  const id = WEAPON_IDS[cmd.weapon];
  if (id !== p.current && p.loadout.includes(id)) {
    p.current = id;
    p.reloading = 0;
    p.cooldown = Math.max(p.cooldown, 0.25);
  }

  if (p.cooldown > 0) {
    p.cooldown -= dt;
    p.fireCarry = p.cooldown < 0 ? -p.cooldown : 0;
    if (p.cooldown < 0) p.cooldown = 0;
  }
  if (p.reloading > 0) {
    p.reloading -= dt;
    if (p.reloading <= 0) { p.reloading = 0; finishReload(p); }
  }
  if (!armed) { p.cooking = null; return; }

  if (b & BTN.RELOAD) startReload(p);

  const w = WEAPON_BY_ID[p.current];
  const fire = (b & BTN.FIRE) !== 0;
  if (fire && (w.auto || !(prev & BTN.FIRE))) tryFire(p, w, (b & BTN.AIM) !== 0, fx);

  // Grenades: the bit held cooks, letting go throws. One in hand at a time.
  if (p.cooking) {
    const bit = p.cooking === 'frag' ? BTN.FRAG : BTN.SMOKE;
    if (b & bit) p.chargeTicks++;
    else {
      const kind = p.cooking;
      p.cooking = null;
      if (kind === 'frag') p.fragCount--; else p.smokeCount--;
      p.invulnTimer = 0;
      fx?.throw?.(p, kind);
    }
  } else if ((b & BTN.FRAG) && !(prev & BTN.FRAG) && p.fragCount > 0) {
    p.cooking = 'frag'; p.chargeTicks = 0;
  } else if ((b & BTN.SMOKE) && !(prev & BTN.SMOKE) && p.smokeCount > 0) {
    p.cooking = 'smoke'; p.chargeTicks = 0;
  }
}

function tryFire(p, w, aiming, fx) {
  if (p.cooldown > 0 || p.reloading > 0 || w.thrown) return;
  p.invulnTimer = 0;
  const a = p.ammo[w.id];
  if (a.mag <= 0) { startReload(p); fx?.reload?.(p); return; }
  a.mag--;
  p.cooldown = Math.max(0, w.cooldown - p.fireCarry);
  p.fireCarry = 0;
  const cone = playerSpread(w, {
    speed: Math.hypot(p.body.velocity.x, p.body.velocity.z),
    grounded: p.grounded, aiming, crouching: p.crouching, bloom: p.bloom,
  });
  fx?.fire?.(p, w, cone);
  const [patYaw, patPitch] = recoilStep(w, p.sprayIndex);
  p.recoilPitch += w.recoil * patPitch;
  p.recoilYaw += w.recoil * patYaw;
  p.sprayIndex++;
  p.bloom = Math.min(w.bloomMax ?? 0, (p.bloom ?? 0) + (w.bloomStep ?? 0));
  p.sinceShot = 0;
  if (a.mag === 0) startReload(p);
}

/** The weapon fields stepWeapons reads and writes, for snapshots and reconciliation. */
export const WEAPON_STATE_KEYS = [
  'current', 'cooldown', 'fireCarry', 'reloading', 'reloadTotal', 'bloom', 'sprayIndex', 'sinceShot',
  'recoilPitch', 'recoilYaw', 'cooking', 'chargeTicks', 'prevButtons', 'fragCount', 'smokeCount', 'invulnTimer',
];
