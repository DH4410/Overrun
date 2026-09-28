import * as THREE from 'three';
import * as CANNON from 'cannon-es';

import { CONFIG, TEAM } from './config.js';
import { G_NADE, MAT_NADE, RAY_OPTS, world } from './physics.js';
import { matte } from './rendering.js';
import { rand } from './utils.js';

/** Combatant hitbox profiles. Offsets are relative to the combatant chest position. */
export const HB_PLAYER = { bodyR: 0.42, bodyHalfH: 0.58, headR: 0.27, headY: 0.78 };
export const HB_PLAYER_CROUCH = { bodyR: 0.42, bodyHalfH: 0.38, headR: 0.27, headY: 0.45 };
export const HB_BOT = { bodyR: 0.38, bodyHalfH: 0.45, headR: 0.22, headY: 0.62 };

export const ZONE_MULT = { head: 2.4, body: 1.0, limb: 0.6 };

/** Bullet hit testing, projectile simulation, and grenade lifecycle. */
export function createProjectileRuntime({
  scene,
  camera,
  getPlayer,
  combatants,
  Audio,
  spawnBlood,
  applyDamage,
  spawnDecal,
  spawnSparks,
  alertBots,
  spawnExplosion,
  losClear,
  addShake,
  spawnSmoke,
}) {
/* ------------- analytic segment tests (shared scratch) ------------- */

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _m = new THREE.Vector3();
const _rayFrom = new CANNON.Vec3();
const _rayTo = new CANNON.Vec3();
const _rayResult = new CANNON.RaycastResult();

/** Distance along the segment to the sphere, or -1. */
function segmentSphere(o, d, len, center, r) {
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
function segmentCylinderY(o, d, len, cx, cy, cz, r, halfH) {
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

/** Nearest combatant hit, with locational damage volumes and team/self filters. */
function nearestCombatantHit(o, d, len, shooter) {
  let best = null, bestT = Infinity, bestZone = 'body';
  for (const c of combatants) {
    if (!c.alive || c === shooter) continue;
    if (shooter && shooter.team !== TEAM.SOLO && c.team === shooter.team) continue;
    const p = c.pos, hb = c.hb;
    const th = segmentSphere(o, d, len, _v1.set(p.x, p.y + hb.headY, p.z), hb.headR);
    const tb = segmentCylinderY(o, d, len, p.x, p.y, p.z, hb.bodyR, hb.bodyHalfH);
    // Centred lower and made taller than the torso so legs are genuinely hittable — the
    // previous limb volume stopped at roughly hip height.
    const tl = segmentCylinderY(o, d, len, p.x, p.y - 0.25, p.z, hb.bodyR * 1.6, hb.bodyHalfH * 1.6);
    let t = -1, zone = 'body';
    // Nearest wins, and ties resolve toward the more specific volume.
    if (th >= 0) { t = th; zone = 'head'; }
    if (tb >= 0 && (t < 0 || tb < t)) { t = tb; zone = 'body'; }
    if (tl >= 0 && (t < 0 || tl < t - 1e-4)) { t = tl; zone = 'limb'; }
    if (t >= 0 && t < bestT) { bestT = t; best = c; bestZone = zone; }
  }
  return best ? { target: best, t: bestT, zone: bestZone, head: bestZone === 'head' } : null;
}


/* ------------------------------ bullets ------------------------------ */

const bullets = [];
const tracerGeo = new THREE.SphereGeometry(1, 6, 4);
const tracerMats = {
  player: new THREE.MeshBasicMaterial({ color: 0xfff0b0 }),
  enemy: new THREE.MeshBasicMaterial({ color: 0xff9a6a }),
  ally: new THREE.MeshBasicMaterial({ color: 0x8fd0ff }),
};
const _step = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
const _hitNormal = new THREE.Vector3();
const _fwdZ = new THREE.Vector3(0, 0, 1);

function spawnBullet(origin, direction, weapon, owner, damage) {
  const kind = owner === getPlayer() ? 'player' : (owner.team !== TEAM.SOLO && owner.team === getPlayer().team ? 'ally' : 'enemy');
  const mesh = new THREE.Mesh(tracerGeo, tracerMats[kind]);
  mesh.frustumCulled = false;
  scene.add(mesh);
  bullets.push({
    pos: origin.clone(), prev: origin.clone(),
    vel: direction.clone().multiplyScalar(weapon.speed),
    travelled: 0, damage, owner, weapon, mesh,
  });
}

function despawnBullet(i) {
  scene.remove(bullets[i].mesh);
  bullets.splice(i, 1);
}
function clearBullets() {
  for (const b of bullets) scene.remove(b.mesh);
  bullets.length = 0;
}

/**
 * One fixed step for every bullet. Gravity is integrated explicitly, then the segment swept
 * this tick is tested against combatants (analytic) and the static world (raycastClosest).
 * The nearer result wins — that ordering is the whole reason bullets cannot pass through walls.
 */
function stepBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.prev.copy(b.pos);
    b.vel.y += CONFIG.GRAVITY * dt;
    _step.copy(b.vel).multiplyScalar(dt);
    b.pos.add(_step);

    const len = _step.length();
    if (len < 1e-6) continue;
    _dir.copy(_step).divideScalar(len);

    const cHit = nearestCombatantHit(b.prev, _dir, len, b.owner);

    _rayFrom.set(b.prev.x, b.prev.y, b.prev.z);
    _rayTo.set(b.pos.x, b.pos.y, b.pos.z);
    _rayResult.reset();
    world.raycastClosest(_rayFrom, _rayTo, RAY_OPTS, _rayResult);
    const wallT = _rayResult.hasHit ? _rayResult.distance : Infinity;

    if (cHit && cHit.t <= wallT) {
      _hitPoint.copy(b.prev).addScaledVector(_dir, cHit.t);
      const dmg = b.damage * ZONE_MULT[cHit.zone];
      spawnBlood(_hitPoint);
      applyDamage(cHit.target, dmg, b.owner, _hitPoint, cHit.head, cHit.zone);
      despawnBullet(i);
      continue;
    }
    if (_rayResult.hasHit) {
      _hitPoint.set(_rayResult.hitPointWorld.x, _rayResult.hitPointWorld.y, _rayResult.hitPointWorld.z);
      _hitNormal.set(_rayResult.hitNormalWorld.x, _rayResult.hitNormalWorld.y, _rayResult.hitNormalWorld.z);
      spawnDecal(_hitPoint, _hitNormal);
      spawnSparks(_hitPoint, _hitNormal);
      despawnBullet(i);
      continue;
    }

    b.travelled += len;
    if (b.travelled > CONFIG.MAX_RANGE) { despawnBullet(i); continue; }

    // A 700 m/s point never renders twice in the same place, so stretch it into a streak
    // covering the ground it just crossed.
    const streak = Math.min(len, CONFIG.TRACER_MAX_LEN);
    _mid.copy(b.pos).addScaledVector(_dir, -streak / 2);
    b.mesh.position.copy(_mid);
    b.mesh.quaternion.setFromUnitVectors(_fwdZ, _dir);
    b.mesh.scale.set(CONFIG.TRACER_RADIUS, CONFIG.TRACER_RADIUS, streak / 2);
  }
}

/** Fire one weapon. `dirBase` is a unit vector; spread is applied per pellet. */
/**
 * `_fireDir` is a scratch vector of its own on purpose. Callers legitimately pass one of the
 * shared scratch vectors as `dirBase` (the bots aim in `_v2`), and reusing that same vector
 * here would make `copy(dirBase)` a no-op — every pellet would then inherit the previous
 * pellet's deviation and a shotgun would fire a compounding random walk instead of a cone.
 */
const _fireDir = new THREE.Vector3();

/**
 * `coneOverride` is an absolute cone in radians and wins over `spreadMult` when supplied.
 * The player passes one (see playerSpread) because its accuracy is additive — a settled tap
 * is far tighter than the gun's nominal cone and a sprinting spray far wider, which no
 * single multiplier on weapon.spread can express. Bots still use spreadMult.
 */
function fireWeapon(shooter, weapon, origin, dirBase, spreadMult = 1, coneOverride = null) {
  const spread = coneOverride === null ? weapon.spread * spreadMult : coneOverride;
  for (let p = 0; p < weapon.pellets; p++) {
    _fireDir.copy(dirBase);
    if (spread > 0) {
      _fireDir.x += rand(-spread, spread);
      _fireDir.y += rand(-spread, spread);
      _fireDir.z += rand(-spread, spread);
      _fireDir.normalize();
    }
    spawnBullet(origin, _fireDir, weapon, shooter, weapon.damage);
  }
  // The player's own gun stays centred; everyone else's is placed in the stereo field so you
  // can tell which side you are being shot from before you see anyone.
  if (shooter === getPlayer()) {
    Audio.gunshot(weapon.sound, 0, 0);
  } else {
    const sp = Audio.spatial(origin);
    Audio.gunshot(weapon.sound, sp.dist, sp.pan);
  }
  alertBots(origin, shooter);
}

/* ----------------------------- grenades ----------------------------- */

const grenades = [];
const fragGeo = new THREE.SphereGeometry(0.075, 12, 9);
const fragMat = matte(0x39452f, 0.85, 0.2);
const smokeCanGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.17, 10);
const smokeCanMat = matte(0xb8c4cf, 0.5, 0.6);

/**
 * Throw a grenade.
 *
 * `power` is the throw itself, in m/s. The thrower's own velocity is ADDED to it rather than
 * ignored: a grenade released by someone sprinting leaves their hand doing sprint speed plus
 * the throw, which is why running throws carry further and why a grenade thrown while
 * backpedalling falls short. Leaving it out made every throw land at the same spot
 * regardless of how the thrower was moving, which is the single most obviously wrong thing
 * about thrown ordnance in a shooter.
 *
 * A frag masses 0.4 kg and is 6 cm across, which are real numbers for one, so it decelerates
 * and bounces like an object of that size rather than like a beach ball.
 */
function throwGrenade(owner, origin, dir, power, kind, fuseLeft) {
  const body = new CANNON.Body({
    mass: 0.4, material: MAT_NADE,
    shape: new CANNON.Sphere(0.06),
    // Air drag on a 6 cm steel sphere is negligible over a 3 s fuse; the angular damping is
    // what stops it spinning forever once it is on the floor.
    linearDamping: 0.01, angularDamping: 0.22,
    collisionFilterGroup: G_NADE,
  });
  body.position.set(origin.x, origin.y, origin.z);
  const inherited = owner?.body?.velocity;
  body.velocity.set(
    dir.x * power + (inherited ? inherited.x : 0),
    dir.y * power + 1.6 + (inherited ? Math.max(0, inherited.y) * 0.5 : 0),
    dir.z * power + (inherited ? inherited.z : 0),
  );
  // Spin about the axis perpendicular to the throw, so it tumbles end-over-end along its
  // flight path instead of buzzing randomly about its own centre.
  const spin = 11 + power * 0.25;
  body.angularVelocity.set(-dir.z * spin, rand(-2, 2), dir.x * spin);
  world.addBody(body);

  const mesh = new THREE.Mesh(
    kind === 'smoke' ? smokeCanGeo : fragGeo,
    kind === 'smoke' ? smokeCanMat : fragMat,
  );
  mesh.castShadow = true;
  scene.add(mesh);

  const g = { body, mesh, fuse: fuseLeft, owner, kind, bounceCd: 0 };
  grenades.push(g);
  body.addEventListener('collide', () => {
    if (g.bounceCd > 0) return;
    g.bounceCd = 0.12;
    const speed = body.velocity.length();
    if (speed > 1.4) Audio.bounce(mesh.position.distanceTo(camera.position));
  });
  return g;
}

function clearGrenades() {
  for (const g of grenades) { world.removeBody(g.body); scene.remove(g.mesh); }
  grenades.length = 0;
}

/** Radial damage with linear falloff, plus a 1/d^2 impulse on every dynamic body nearby. */
function explode(pos, owner) {
  spawnExplosion(pos);
  Audio.explosion(pos.distanceTo(camera.position));

  for (const c of combatants) {
    if (!c.alive) continue;
    // Skip teammates (but allow self-damage). Bullet code uses the same pattern.
    if (owner && c !== owner && owner.team !== TEAM.SOLO && c.team === owner.team) continue;
    _v1.set(c.pos.x, c.pos.y, c.pos.z);
    const d = _v1.distanceTo(pos);
    if (d > CONFIG.FRAG_RADIUS) continue;
    // Cover matters: no line of sight to the blast means no damage.
    if (!losClear(pos.x, pos.y, pos.z, c.pos.x, c.pos.y, c.pos.z)) continue;
    const dmg = CONFIG.FRAG_DAMAGE * (1 - d / CONFIG.FRAG_RADIUS);
    if (dmg > 1) applyDamage(c, dmg, owner, _v1, false);
  }

  for (const body of world.bodies) {
    // Dynamic bodies only. Corpses are kinematic (see Bot.die) and keep their mass, so without
    // the type check a frag would hand one a velocity that nothing ever takes away again.
    if (body.mass <= 0 || body.type !== CANNON.Body.DYNAMIC) continue;
    _v2.set(body.position.x - pos.x, body.position.y - pos.y, body.position.z - pos.z);
    const d = _v2.length();
    if (d > CONFIG.FRAG_RADIUS * 1.6 || d < 1e-3) continue;
    _v2.divideScalar(d);
    const mag = CONFIG.FRAG_IMPULSE / (d * d + 1);
    body.applyImpulse(new CANNON.Vec3(_v2.x * mag, (_v2.y + 0.45) * mag, _v2.z * mag));
  }

  const camDist = pos.distanceTo(camera.position);
  if (camDist < 10) addShake(0.10 * (1 - camDist / 10));
}

/** Speed below which a grenade is treated as rolling on the floor rather than flying. */
const NADE_ROLL_SPEED = 2.6;

function stepGrenades(dt) {
  for (let i = grenades.length - 1; i >= 0; i--) {
    const g = grenades[i];
    g.bounceCd = Math.max(0, g.bounceCd - dt);

    /**
     * Rolling friction.
     *
     * The MAT_WORLD/MAT_NADE contact gives restitution 0.45, which is right for the bounce
     * but says nothing about what happens afterwards: a sphere on a plane has a single
     * contact point, so cannon's Coulomb friction barely bites and a spent grenade rolls
     * across the entire arena before the fuse runs out. Real ordnance comes to rest within a
     * metre or two of where it stops bouncing. Bleeding speed once it is slow and low is a
     * far cheaper fix than raising contact friction, which would also make it refuse to
     * bounce off walls properly.
     */
    const v = g.body.velocity;
    const planar = Math.hypot(v.x, v.z);
    if (planar > 0.02 && Math.abs(v.y) < 1.2 && planar < NADE_ROLL_SPEED) {
      const decay = Math.pow(0.12, dt);       // ~88% of speed shed per second
      v.x *= decay; v.z *= decay;
      g.body.angularVelocity.scale(decay, g.body.angularVelocity);
    }

    g.fuse -= dt;
    if (g.fuse <= 0) {
      if (g.kind === 'smoke') spawnSmoke(g.body.position, g.owner);
      else explode(g.body.position, g.owner);
      world.removeBody(g.body);
      scene.remove(g.mesh);
      grenades.splice(i, 1);
    }
  }
}

function syncGrenades() {
  for (const g of grenades) {
    g.mesh.position.copy(g.body.position);
    g.mesh.quaternion.copy(g.body.quaternion);
  }
}

return {
  bullets,
  clearBullets,
  stepBullets,
  fireWeapon,
  throwGrenade,
  clearGrenades,
  explode,
  stepGrenades,
  syncGrenades,
};
}
