import * as THREE from 'three';
import * as CANNON from 'cannon-es';

import { CONFIG, TEAM } from './config.js';
import { G_NADE, MAT_NADE, RAY_OPTS, world } from './physics.js';
import { matte } from './rendering.js';
import { rand } from './utils.js';
import {
  PLAYER_ZONE_MULT, ZONES, ZONE_MULT, analyticHit, segmentCapsule, segmentSphere,
} from './sim/hitmath.js';

export { HB_BOT, HB_PLAYER, HB_PLAYER_CROUCH, PLAYER_ZONE_MULT, ZONE_MULT } from './sim/hitmath.js';

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
const _rayFrom = new CANNON.Vec3();
const _rayTo = new CANNON.Vec3();
const _rayResult = new CANNON.RaycastResult();

/**
 * Nearest combatant hit, with locational damage and team/self filters.
 *
 * Bots are tested against capsules on their posed skeleton (Bot.hitShapes). The player keeps
 * an analytic hitbox — head sphere, torso cylinder, legs below it. That used to be a "limb"
 * cylinder 1.6x the torso's radius that ENCLOSED the torso, so the nearest-entry rule scored
 * most chest hits as limb hits: 0.6x damage for a centre-mass shot.
 */
function nearestCombatantHit(o, d, len, shooter) {
  let best = null, bestT = Infinity, bestZone = 'body';
  for (const c of combatants) {
    if (!c.alive || c === shooter) continue;
    if (shooter && shooter.team !== TEAM.SOLO && c.team === shooter.team) continue;
    const shapes = c.hitShapes?.();
    if (shapes) {
      // Cheap reject first: a sphere round the whole body.
      if (segmentSphere(o, d, len, shapes.centre, shapes.radius) < 0) continue;
      const v = shapes.data;
      for (let i = 0; i < shapes.count; i++) {
        const k = i * 8;
        const t = segmentCapsule(o, d, len, v[k], v[k + 1], v[k + 2], v[k + 3], v[k + 4], v[k + 5], v[k + 6]);
        if (t >= 0 && t < bestT) { bestT = t; best = c; bestZone = ZONES[v[k + 7]]; }
      }
      continue;
    }
    const t = analyticHit(o, d, len, c.pos, c.hb);
    if (t >= 0 && t < bestT) { bestT = t; best = c; bestZone = analyticHit.zone; }
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
      const table = cHit.target === getPlayer() ? PLAYER_ZONE_MULT : ZONE_MULT;
      const dmg = b.damage * (table[cHit.zone] ?? 1);
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
  // The player's own gun plays dry; everyone else's is placed in 3D where they stand, so you
  // can tell where you are being shot from, and how far, before you see anyone.
  Audio.gunshot(weapon.sound, shooter === getPlayer() ? null : origin);
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
  launchVelocity(owner, dir, power, body.velocity);
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
    if (speed > 1.4) Audio.bounce(mesh.position);
  });
  return g;
}

/** A throw's launch velocity: the throw, a little loft, and the thrower's own motion. */
function launchVelocity(owner, dir, power, out) {
  const inherited = owner?.body?.velocity;
  return out.set(
    dir.x * power + (inherited ? inherited.x : 0),
    dir.y * power + 1.6 + (inherited ? Math.max(0, inherited.y) * 0.5 : 0),
    dir.z * power + (inherited ? inherited.z : 0),
  );
}

/*
 * The aiming arc for a throw being charged: the flight a grenade released now would take,
 * integrated the way the physics step does, up to where it first meets the level, with a ring
 * where it lands. It uses launchVelocity(), so the arc is the throw.
 */
const ARC_MAX = 96;
const arcGeo = new THREE.BufferGeometry();
arcGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ARC_MAX * 3), 3));
const arcLine = new THREE.Line(arcGeo, new THREE.LineDashedMaterial({
  color: 0xf3b53f, dashSize: 0.3, gapSize: 0.18, transparent: true, opacity: 0.9, depthTest: false,
}));
arcLine.renderOrder = 10;
arcLine.frustumCulled = false;
arcLine.visible = false;
scene.add(arcLine);
const arcRing = new THREE.Mesh(
  new THREE.RingGeometry(0.32, 0.46, 32),
  new THREE.MeshBasicMaterial({ color: 0xf3b53f, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthTest: false }),
);
arcRing.renderOrder = 10;
arcRing.visible = false;
scene.add(arcRing);
const _av = new THREE.Vector3();
const _ap = new THREE.Vector3();
const _aFrom = new CANNON.Vec3();
const _aTo = new CANNON.Vec3();
const _aRes = new CANNON.RaycastResult();
const _aUp = new THREE.Vector3(0, 0, 1);

/** Where a throw first meets the level, or null if it flies for 4 s without doing so. */
function predictThrow(owner, origin, dir, power, points = null) {
  const h = 1 / 120;                     // the fixed physics step
  const drag = Math.pow(1 - 0.01, h);    // the grenade body's linearDamping
  launchVelocity(owner, dir, power, _av);
  _ap.copy(origin);
  let n = 0;
  if (points) { points[0] = _ap.x; points[1] = _ap.y; points[2] = _ap.z; n = 1; }
  for (let i = 0; i < 480; i += 4) {
    _aFrom.set(_ap.x, _ap.y, _ap.z);
    for (let k = 0; k < 4; k++) {
      _av.y += CONFIG.GRAVITY * h;        // CONFIG.GRAVITY is negative
      _av.multiplyScalar(drag);
      _ap.addScaledVector(_av, h);
    }
    _aTo.set(_ap.x, _ap.y, _ap.z);
    _aRes.reset();
    world.raycastClosest(_aFrom, _aTo, RAY_OPTS, _aRes);
    if (_aRes.hasHit) {
      const hp = _aRes.hitPointWorld;
      if (points && n < ARC_MAX) { points[n * 3] = hp.x; points[n * 3 + 1] = hp.y; points[n * 3 + 2] = hp.z; n++; }
      predictThrow.count = n;
      predictThrow.normal = _aRes.hitNormalWorld;
      return new THREE.Vector3(hp.x, hp.y, hp.z);
    }
    if (points && n < ARC_MAX) { points[n * 3] = _ap.x; points[n * 3 + 1] = _ap.y; points[n * 3 + 2] = _ap.z; n++; }
  }
  predictThrow.count = n;
  return null;
}

/** Draw the arc for a throw being charged; pass null to hide it. */
function showThrowArc(owner, origin, dir, power) {
  if (!owner) { arcLine.visible = false; arcRing.visible = false; return null; }
  const attr = arcGeo.attributes.position;
  const hit = predictThrow(owner, origin, dir, power, attr.array);
  attr.needsUpdate = true;
  arcGeo.setDrawRange(0, predictThrow.count);
  arcLine.computeLineDistances();
  arcLine.visible = true;
  arcRing.visible = !!hit;
  if (hit) {
    const nrm = predictThrow.normal;
    arcRing.position.set(hit.x + nrm.x * 0.03, hit.y + nrm.y * 0.03, hit.z + nrm.z * 0.03);
    arcRing.quaternion.setFromUnitVectors(_aUp, _ap.set(nrm.x, nrm.y, nrm.z));
  }
  return hit;
}

function clearGrenades() {
  for (const g of grenades) { world.removeBody(g.body); scene.remove(g.mesh); }
  grenades.length = 0;
  showThrowArc(null);
}

/** Radial damage with linear falloff, plus a 1/d^2 impulse on every dynamic body nearby. */
function explode(pos, owner) {
  spawnExplosion(pos);
  Audio.explosion(pos);

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
    // Nor other grenades. The impulse is sized to shove an 80 kg player; a 0.4 kg grenade given
    // the same took off at 200 m/s, through the floor or off the map, so of three frags thrown
    // in a row only the first ever went off where it landed.
    if (body.collisionFilterGroup === G_NADE) continue;
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
  grenades,
  throwGrenade,
  clearGrenades,
  predictThrow,
  showThrowArc,
  explode,
  stepGrenades,
  syncGrenades,
};
}
