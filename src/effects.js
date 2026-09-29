import * as THREE from 'three';

import { CONFIG } from './config.js';
import { QUALITY, settings } from './settings.js';
import { clamp, lerp, rand } from './utils.js';

/**
 * Create the presentation effects runtime. Gameplay systems call the returned API; scene,
 * audio, light-pool, and geometry helpers remain explicit dependencies.
 */
export function createEffects({
  scene,
  audio: Audio,
  camera,
  addLightEmitter,
  removeLightEmitter,
  markShared,
}) {
const _fwdZ = new THREE.Vector3(0, 0, 1);
const _v1 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

function segmentSphere(o, d, len, center, radius) {
  _v1.subVectors(o, center);
  const b = _v1.dot(d);
  const c = _v1.dot(_v1) - radius * radius;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  let t = -b - Math.sqrt(disc);
  if (t < 0) t = 0;
  return t <= len ? t : -1;
}

/* ------------------------------ particles ------------------------------ */


/** One THREE.Points per burst: N particles, one draw call, hand-integrated with gravity. */
/**
 * Pooled particles.
 *
 * Every burst used to allocate a BufferGeometry, two Float32Arrays and a PointsMaterial, then
 * dispose all four ~0.4 s later. A frag grenade is 200 particles, so a firefight produced a
 * steady stream of garbage and the collector paid for it in visible hitches.
 *
 * Now there are exactly two Points objects for the whole game — one additive, one normal —
 * each with a fixed vertex budget. A burst leases a slice of the buffer; when a particle dies
 * its size drops to zero and the slot returns to the free list. No allocation at runtime.
 *
 * Per-particle colour and size (which a shared PointsMaterial cannot express) come from
 * vertex attributes, so pooling costs nothing in appearance.
 */
const PARTICLE_VS = `
  attribute float psize;
  attribute float alpha;
  varying vec3 vColor;
  varying float vAlpha;
  uniform float uScale;
  void main() {
    vColor = color;
    vAlpha = alpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = psize * (uScale / max(-mv.z, 0.001));
    gl_Position = projectionMatrix * mv;
  }`;

const PARTICLE_FS = `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    if (dot(c, c) > 0.25) discard;          // round points, not squares
    gl_FragColor = vec4(vColor, vAlpha);
  }`;

class ParticlePool {
  constructor(capacity, additive) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.psize = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.baseSize = new Float32Array(capacity);
    this.free = new Int32Array(capacity);
    this.freeCount = capacity;
    for (let i = 0; i < capacity; i++) this.free[i] = i;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute('psize', new THREE.BufferAttribute(this.psize, 1));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    geo.setDrawRange(0, capacity);
    this.geo = geo;

    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: innerHeight * 0.5 } },
      vertexShader: PARTICLE_VS,
      fragmentShader: PARTICLE_FS,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
    this.active = 0;
  }

  emit(o) {
    if (this.freeCount === 0) return;                  // budget exhausted; drop silently
    const i = this.free[--this.freeCount];
    const i3 = i * 3;
    this.pos[i3] = o.x; this.pos[i3 + 1] = o.y; this.pos[i3 + 2] = o.z;
    this.vel[i3] = o.vx; this.vel[i3 + 1] = o.vy; this.vel[i3 + 2] = o.vz;
    this.col[i3] = o.r; this.col[i3 + 1] = o.g; this.col[i3 + 2] = o.b;
    this.life[i] = o.life; this.maxLife[i] = o.life;
    this.gravity[i] = o.gravity; this.drag[i] = o.drag;
    this.baseSize[i] = o.size;
    this.psize[i] = o.size;
    this.alpha[i] = 1;
    this.active++;
  }

  update(dt) {
    if (this.active === 0) return;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      const i3 = i * 3;
      const damp = 1 - this.drag[i] * dt;
      this.vel[i3 + 1] += this.gravity[i] * dt;
      this.vel[i3] *= damp; this.vel[i3 + 1] *= damp; this.vel[i3 + 2] *= damp;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.psize[i] = 0;                             // invisible, and the slot comes back
        this.alpha[i] = 0;
        this.free[this.freeCount++] = i;
        this.active--;
      } else {
        this.alpha[i] = clamp(this.life[i] / this.maxLife[i], 0, 1);
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.alpha.needsUpdate = true;
    this.geo.attributes.psize.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }

  clear() {
    this.freeCount = 0;
    for (let i = 0; i < this.capacity; i++) {
      this.life[i] = 0; this.psize[i] = 0; this.alpha[i] = 0;
      this.free[this.freeCount++] = i;
    }
    this.active = 0;
    this.geo.attributes.psize.needsUpdate = true;
    this.geo.attributes.alpha.needsUpdate = true;
  }
}

const particlesAdd = new ParticlePool(900, true);
const particlesNorm = new ParticlePool(500, false);
const _pcol = new THREE.Color();

function spawnBurst({ origin, count, color, size, speed, spreadDir = null, cone = 1,
                      gravity = -9.0, life = 0.8, drag = 0.0, additive = true }) {
  const pool = additive ? particlesAdd : particlesNorm;
  _pcol.setHex(color);
  // Density scales with the graphics preset: fewer, slightly larger particles read almost
  // the same and cost proportionally less to integrate and upload.
  const n = Math.max(1, Math.round(count * QUALITY[settings.quality].particles));
  for (let i = 0; i < n; i++) {
    let dx = rand(-1, 1), dy = rand(-1, 1), dz = rand(-1, 1);
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    if (spreadDir) {
      dx = lerp(spreadDir.x, dx, cone);
      dy = lerp(spreadDir.y, dy, cone);
      dz = lerp(spreadDir.z, dz, cone);
    }
    const s = speed * rand(0.35, 1);
    pool.emit({
      x: origin.x, y: origin.y, z: origin.z,
      vx: dx * s, vy: dy * s, vz: dz * s,
      r: _pcol.r, g: _pcol.g, b: _pcol.b,
      size, life, gravity, drag,
    });
  }
}

function updateBursts(dt) {
  particlesAdd.update(dt);
  particlesNorm.update(dt);
}

function spawnSparks(pos, normal) {
  spawnBurst({
    origin: pos, count: 5, color: 0xffc474, size: 0.05, speed: 4.2,
    spreadDir: normal, cone: 0.65, gravity: -11, life: 0.35,
  });
}
function spawnBlood(pos) {
  spawnBurst({
    origin: pos, count: 12, color: 0xc0202a, size: 0.075, speed: 3.0,
    gravity: -12, life: 0.5, additive: false,
  });
}

/* ------------------------------- decals ------------------------------- */

const decalGeo = new THREE.CircleGeometry(0.05, 10);
markShared(decalGeo);
const decalMat = new THREE.MeshBasicMaterial({
  color: 0x0b0b0d, transparent: true, opacity: 0.85, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -4,
});
const decals = [];

function spawnDecal(pos, normal) {
  const m = new THREE.Mesh(decalGeo, decalMat);
  m.position.copy(pos).addScaledVector(normal, 0.012);
  m.quaternion.setFromUnitVectors(_fwdZ, normal);
  m.rotateZ(rand(0, Math.PI * 2));
  scene.add(m);
  decals.push(m);
  if (decals.length > CONFIG.MAX_DECALS) scene.remove(decals.shift());
}
function clearDecals() {
  for (const d of decals) scene.remove(d);
  decals.length = 0;
}

/* ----------------------------- explosions ----------------------------- */

const shockGeo = new THREE.RingGeometry(0.6, 1.0, 40);
markShared(shockGeo);
const shocks = [];
const blastLights = [];

/**
 * Shock rings are pooled for the same reason the lights are: a fresh MeshBasicMaterial per
 * detonation meant a fresh shader program on the first one (measured at 208 ms). Eight rings
 * is more than can be on screen at once, and each keeps its own material so they can fade
 * independently.
 */
const SHOCK_POOL = 8;
const shockRings = [];
for (let i = 0; i < SHOCK_POOL; i++) {
  const m = new THREE.Mesh(shockGeo, new THREE.MeshBasicMaterial({
    color: 0xffd08a, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
  }));
  m.rotation.x = -Math.PI / 2;
  m.visible = false;
  m.frustumCulled = false;
  scene.add(m);
  shockRings.push({ mesh: m, busy: false });
}

function spawnExplosion(pos) {
  // Upward cone of fire.
  spawnBurst({
    origin: pos, count: 150, color: 0xffa22e, size: 0.20, speed: 15,
    spreadDir: new THREE.Vector3(0, 1, 0), cone: 0.85, gravity: -7, life: 0.9, drag: 1.4,
  });
  spawnBurst({
    origin: pos, count: 50, color: 0x3a3a3a, size: 0.55, speed: 6,
    spreadDir: new THREE.Vector3(0, 1, 0), cone: 0.9, gravity: -1.2, life: 1.6,
    drag: 1.8, additive: false,
  });

  const slot = shockRings.find((r) => !r.busy);
  if (slot) {
    slot.busy = true;
    slot.mesh.visible = true;
    slot.mesh.position.set(pos.x, pos.y + 0.15, pos.z);
    slot.mesh.scale.setScalar(1);
    slot.mesh.material.opacity = 0.9;
    shocks.push({ slot, t: 0 });
  }

  // Leases a slot rather than creating a light. Creating one here was costing a full shader
  // recompile on detonation and another when it was removed 0.2 s later.
  const emitter = addLightEmitter({
    x: pos.x, y: pos.y + 0.5, z: pos.z,
    color: 0xffd9a0, intensity: 900, distance: 18,
    priority: 10,                              // outbids torches and lamps for a slot
  });
  blastLights.push({ emitter, t: 0 });
}

function updateExplosionFx(dt) {
  for (let i = shocks.length - 1; i >= 0; i--) {
    const s = shocks[i];
    s.t += dt;
    const k = s.t / 0.4;
    s.slot.mesh.scale.setScalar(1 + k * 9);
    s.slot.mesh.material.opacity = clamp(0.9 * (1 - k), 0, 1);
    if (k >= 1) { s.slot.mesh.visible = false; s.slot.busy = false; shocks.splice(i, 1); }
  }
  for (let i = blastLights.length - 1; i >= 0; i--) {
    const b = blastLights[i];
    b.t += dt;
    b.emitter.intensity = 900 * clamp(1 - b.t / 0.2, 0, 1);
    if (b.t >= 0.2) { removeLightEmitter(b.emitter); blastLights.splice(i, 1); }
  }
}

/* ------------------------------- smoke ------------------------------- */

/** Soft radial puff, generated once and shared by every smoke sprite. */
const smokeTexture = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0.00, 'rgba(215,218,222,0.95)');
  grad.addColorStop(0.45, 'rgba(180,185,192,0.55)');
  grad.addColorStop(1.00, 'rgba(150,155,162,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

const smokeClouds = [];
const SMOKE_PUFFS = 38;
const SMOKE_GROW = 1.4;       // seconds to full size
const SMOKE_FADE = 2.5;       // seconds of fade at the end of its life
let smokeVeil = null;

function spawnSmoke(pos, owner) {
  Audio.smokePop(pos.distanceTo(camera.position));
  const group = new THREE.Group();
  group.position.copy(pos);
  scene.add(group);

  // Dense and low: most puffs sit between the ankles and the top of a head, where a smoke has
  // to hide people, and fill the middle as well as the edge. Twenty puffs spread over a sphere
  // left gaps you could see a bot through, which is not a smoke.
  const puffs = [];
  for (let i = 0; i < SMOKE_PUFFS; i++) {
    const mat = new THREE.SpriteMaterial({
      map: smokeTexture, color: i % 3 ? 0xc9cdd2 : 0xb4b9bf, transparent: true,
      opacity: 0, depthWrite: false, rotation: rand(0, Math.PI * 2),
    });
    const s = new THREE.Sprite(mat);
    const dir = new THREE.Vector3(rand(-1, 1), rand(-0.15, 0.6), rand(-1, 1)).normalize();
    s.position.copy(dir).multiplyScalar(rand(0.1, 0.6));
    s.scale.setScalar(0.8);
    group.add(s);
    puffs.push({ sprite: s, dir, spin: rand(-0.5, 0.5), target: rand(0.15, 1.0) });
  }

  smokeClouds.push({
    group, puffs, t: 0, owner,
    center: pos.clone(), radius: CONFIG.SMOKE_RADIUS,
  });
}

function updateSmoke(dt) {
  for (let i = smokeClouds.length - 1; i >= 0; i--) {
    const c = smokeClouds[i];
    c.t += dt;
    // Expand to full size quickly, hold, then fade across the end of its life.
    const grow = clamp(c.t / SMOKE_GROW, 0, 1);
    const fade = c.t > CONFIG.SMOKE_LIFE - SMOKE_FADE
      ? clamp(1 - (c.t - (CONFIG.SMOKE_LIFE - SMOKE_FADE)) / SMOKE_FADE, 0, 1)
      : 1;
    c.opacity = grow * fade;
    c.radius = CONFIG.SMOKE_RADIUS * (0.25 + 0.75 * grow);
    for (const p of c.puffs) {
      const spread = c.radius * p.target;
      p.sprite.position.copy(p.dir).multiplyScalar(spread);
      p.sprite.position.y += grow * 0.6;                     // drift upward
      p.sprite.scale.setScalar(1.6 + grow * c.radius * 0.9);
      p.sprite.material.rotation += p.spin * dt;
      p.sprite.material.opacity = 0.92 * grow * fade;
    }
    c.group.position.y = c.center.y + grow * 0.5;
    if (c.t >= CONFIG.SMOKE_LIFE) {
      for (const p of c.puffs) p.sprite.material.dispose();
      scene.remove(c.group);
      smokeClouds.splice(i, 1);
    }
  }
  updateSmokeVeil();
}

/**
 * Standing in a smoke greys the screen out, the deeper the thicker. Sprites alone cannot do it:
 * from inside the cloud they are billboards around you with clear air between them, so a smoke
 * you had walked into was the one place you could see out of.
 */
function updateSmokeVeil() {
  smokeVeil ??= document.getElementById('smokeveil');
  if (!smokeVeil) return;
  let depth = 0;
  for (const c of smokeClouds) {
    _v1.set(c.center.x, c.center.y + 0.5, c.center.z);
    const d = camera.position.distanceTo(_v1) / Math.max(0.01, c.radius);
    depth = Math.max(depth, clamp((1 - d) / 0.45, 0, 1) * (c.opacity ?? 0));
  }
  smokeVeil.style.opacity = depth.toFixed(3);
}

/** True when the segment passes through any smoke that has actually built up. */
function smokeBlocks(from, to) {
  if (smokeClouds.length === 0) return false;
  _v3.subVectors(to, from);
  const len = _v3.length();
  if (len < 1e-4) return false;
  _v3.divideScalar(len);
  for (const c of smokeClouds) {
    if (c.t < 0.4 || (c.opacity ?? 1) < 0.35) continue;   // deploying or fading: not opaque
    _v1.set(c.center.x, c.center.y + 0.5, c.center.z);
    if (segmentSphere(from, _v3, len, _v1, c.radius * 0.9) >= 0) return true;
  }
  return false;
}

function clearSmoke() {
  for (const c of smokeClouds) { for (const p of c.puffs) p.sprite.material.dispose(); scene.remove(c.group); }
  smokeClouds.length = 0;
  updateSmokeVeil();
}

function clearEffectPools() {
  particlesAdd.clear();
  particlesNorm.clear();
  for (const s of shocks) { s.slot.mesh.visible = false; s.slot.busy = false; }
  shocks.length = 0;
  for (const b of blastLights) removeLightEmitter(b.emitter);
  blastLights.length = 0;
  clearSmoke();
  clearDecals();
}

/* ---------------------------- screen shake ---------------------------- */

let shakeAmp = 0;
const _shakeOff = new THREE.Vector3();
function addShake(a) { shakeAmp = Math.min(0.35, shakeAmp + a); }
function updateShake(dt) {
  shakeAmp *= Math.pow(0.02, dt / 0.3);          // damped to ~nothing in 0.3 s
  if (shakeAmp < 0.0005) { shakeAmp = 0; _shakeOff.set(0, 0, 0); return; }
  _shakeOff.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(shakeAmp);
}

return {
  particlesAdd,
  particlesNorm,
  spawnBurst,
  updateBursts,
  spawnSparks,
  spawnBlood,
  spawnDecal,
  clearDecals,
  spawnExplosion,
  updateExplosionFx,
  spawnSmoke,
  updateSmoke,
  smokeBlocks,
  clearSmoke,
  clearEffectPools,
  addShake,
  updateShake,
  shakeOffset: _shakeOff,
};
}
