import { Vector3 } from 'three';

/** Combatant hitbox profiles. Offsets are relative to the combatant chest position. */
// The player stands 2.0 m tall, as tall as the bots: legs to 0.73 m, torso to 1.57 m, and a
// bot-sized head (0.22 m) centred at 1.78 m, at the 1.8 m eye. Crouched it is 1.39 m. It used to
// top out at 2.3 m, which only made you easier to hit than anyone you were fighting. The head
// sits right on the torso: a bigger head any lower caught chest shots that drifted up.
export const HB_PLAYER = { bodyR: 0.42, bodyHalfH: 0.42, headR: 0.22, headY: 0.63, legLen: 0.73 };
export const HB_PLAYER_CROUCH = { bodyR: 0.42, bodyHalfH: 0.28, headR: 0.22, headY: 0.42, legLen: 0.47 };
export const HB_BOT = { bodyR: 0.38, bodyHalfH: 0.45, headR: 0.22, headY: 0.62 };

/**
 * Damage multiplier by hit zone, for rounds that hit a BOT. Bots are hit on capsules fitted to
 * their animated skeleton (Bot.hitShapes), so the zone is whatever part of the model the round
 * actually met. A rifle headshot kills an unarmoured bot outright — 26 x 4 — which is what every
 * tactical shooter teaches you to expect; it used to be 26 x 2.4 = 62, and "I headshot him and he
 * didn't die" was the report. Arms count as body, as in Valorant: an arm in front of the chest
 * should not turn a chest shot into a weak one.
 */
export const ZONE_MULT = { head: 4.0, body: 1.0, arm: 1.0, leg: 0.75 };
/**
 * The same for rounds that hit the PLAYER. The player has no visible body, so this stays an
 * analytic head / torso / legs hitbox, and the head multiplier stays where the bot aim profiles
 * were tuned (tests/e2e/duel.spec.mjs): a 4x head on the player would make the elite bot, which
 * aims at the head 80% of the time, a two-shot kill from across the map.
 */
export const PLAYER_ZONE_MULT = { head: 2.4, body: 1.0, leg: 0.7 };
export const ZONES = ['head', 'body', 'arm', 'leg'];

const _m = new Vector3();
const _c = new Vector3();

/** Distance along the segment to the sphere, or -1. */
export function segmentSphere(o, d, len, center, r) {
  _m.subVectors(o, center);
  const b = _m.dot(d);
  const c = _m.dot(_m) - r * r;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  let t = -b - Math.sqrt(disc);
  if (t < 0) t = 0;
  return t <= len ? t : -1;
}

/** Y-axis finite cylinder: solve the infinite cylinder in XZ, then clamp to the height slab. */
export function segmentCylinderY(o, d, len, cx, cy, cz, r, halfH) {
  const mx = o.x - cx, mz = o.z - cz;
  const a = d.x * d.x + d.z * d.z;
  const b = 2 * (mx * d.x + mz * d.z);
  const c = mx * mx + mz * mz - r * r;
  let t;
  if (a < 1e-8) {
    if (c > 0) return -1;
    t = 0;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return -1;
    t = (-b - Math.sqrt(disc)) / (2 * a);
    if (t < 0) t = (-b + Math.sqrt(disc)) / (2 * a);
    if (t < 0 || t > len) return -1;
  }
  const y = o.y + d.y * t;
  if (y < cy - halfH || y > cy + halfH) {
    if (Math.abs(d.y) < 1e-8) return -1;
    const capY = d.y > 0 ? cy - halfH : cy + halfH;
    const tc = (capY - o.y) / d.y;
    if (tc < 0 || tc > len) return -1;
    const px = o.x + d.x * tc - cx, pz = o.z + d.z * tc - cz;
    return (px * px + pz * pz <= r * r) ? tc : -1;
  }
  return t;
}

/**
 * Distance along the segment to a capsule (the points within `r` of the segment A-B), or -1.
 * A sphere is the capsule with A = B. After Inigo Quilez's ray-capsule intersection.
 */
export function segmentCapsule(o, d, len, ax, ay, az, bx, by, bz, r) {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const oax = o.x - ax, oay = o.y - ay, oaz = o.z - az;
  const baba = bax * bax + bay * bay + baz * baz;
  const bard = bax * d.x + bay * d.y + baz * d.z;
  const baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = d.x * oax + d.y * oay + d.z * oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;
  let t = -1;
  if (baba < 1e-10) {                                  // a sphere
    const h = rdoa * rdoa - (oaoa - r * r);
    if (h < 0) return -1;
    t = -rdoa - Math.sqrt(h);
    if (t < 0 && oaoa <= r * r) t = 0;                 // started inside
  } else {
    const a = baba - bard * bard;
    const b = baba * rdoa - baoa * bard;
    const c = baba * oaoa - baoa * baoa - r * r * baba;
    const h = b * b - a * c;
    if (h < 0) return -1;
    t = a > 1e-12 ? (-b - Math.sqrt(h)) / a : -1;
    const y = baoa + t * bard;
    if (!(a > 1e-12) || y <= 0 || y >= baba) {
      // One of the end caps.
      const ocx = y <= 0 ? oax : o.x - bx, ocy = y <= 0 ? oay : o.y - by, ocz = y <= 0 ? oaz : o.z - bz;
      const b2 = d.x * ocx + d.y * ocy + d.z * ocz;
      const c2 = ocx * ocx + ocy * ocy + ocz * ocz - r * r;
      const h2 = b2 * b2 - c2;
      if (h2 < 0) return -1;
      t = -b2 - Math.sqrt(h2);
    }
  }
  if (t < 0) {
    // Started inside (a muzzle pressed into someone): that is a hit at the muzzle.
    const s = baba > 1e-10 ? Math.min(1, Math.max(0, baoa / baba)) : 0;
    const qx = oax - bax * s, qy = oay - bay * s, qz = oaz - baz * s;
    return qx * qx + qy * qy + qz * qz <= r * r ? 0 : -1;
  }
  return t > len ? -1 : t;
}

/**
 * The analytic hitbox (player): head sphere, torso Y-cylinder, legs below it, around the chest
 * position `p`. Returns the distance along the segment or -1; the zone hit is left in
 * analyticHit.zone.
 */
export function analyticHit(o, d, len, p, hb) {
  const th = segmentSphere(o, d, len, _c.set(p.x, p.y + hb.headY, p.z), hb.headR);
  const tb = segmentCylinderY(o, d, len, p.x, p.y, p.z, hb.bodyR, hb.bodyHalfH);
  // Legs: from the floor up to the bottom of the torso, a little narrower than it.
  const legTop = p.y - hb.bodyHalfH;
  const legHalf = (hb.legLen ?? 0.7) / 2;
  const tl = segmentCylinderY(o, d, len, p.x, legTop - legHalf, p.z, hb.bodyR * 0.85, legHalf);
  let t = -1, zone = 'body';
  if (th >= 0) { t = th; zone = 'head'; }
  if (tb >= 0 && (t < 0 || tb < t)) { t = tb; zone = 'body'; }
  if (tl >= 0 && (t < 0 || tl < t)) { t = tl; zone = 'leg'; }
  analyticHit.zone = zone;
  return t;
}
analyticHit.zone = 'body';
