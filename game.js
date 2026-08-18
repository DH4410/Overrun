/**
 * Aim Trainer — a first-person shooting range with ballistic (non-hitscan) projectiles.
 *
 * Architecture
 *   - Rendering:  three.js, one scene, shadow-casting directional key light.
 *   - Collision:  cannon-es static world (room + obstacles). Bullets are NOT rigid
 *                 bodies — at 400 m/s a body would tunnel straight through a wall in
 *                 a single step. Instead each bullet is integrated by hand and the
 *                 segment it swept during the step is raycast against the cannon world.
 *   - Timing:     fixed 120 Hz physics accumulator, decoupled from the render loop.
 */

import * as THREE from 'three';
import * as CANNON from 'cannon-es';

/* ------------------------------------------------------------------ *
 * Config — every tunable lives here.
 * ------------------------------------------------------------------ */

const CONFIG = {
  // Ballistics (real-world units: metres, seconds)
  MUZZLE_VELOCITY: 400,     // m/s — a typical pistol/carbine muzzle speed
  GRAVITY: -9.82,           // m/s^2, applied to bullets and to the cannon world
  MAX_RANGE: 500,           // m — bullets despawn past this
  BULLET_RADIUS: 0.03,      // m — visual radius of the tracer
  TRACER_MAX_LENGTH: 9,     // m — cap on the stretched-tracer streak
  FIRE_INTERVAL: 0.11,      // s between shots when holding LMB

  // Recoil
  RECOIL_PITCH: 0.022,      // rad kicked up per shot
  RECOIL_YAW: 0.006,        // rad of random horizontal kick
  RECOIL_RECOVERY: 11,      // higher = snappier return to the original aim

  // Player
  EYE_HEIGHT: 1.7,
  WALK_SPEED: 4.6,
  SPRINT_SPEED: 7.4,
  MOVE_ACCEL: 14,

  // Room (metres)
  ROOM_W: 40, ROOM_D: 64, ROOM_H: 9,

  // Targets
  TARGET_NEAR: 10, TARGET_FAR: 40,
  TARGET_R_NEAR: 0.15,      // 0.30 m diameter up close
  TARGET_R_FAR: 0.25,       // 0.50 m diameter at range
  STATIC_COUNT: 6,
  MOVING_COUNT: 4,
  POPUP_COUNT: 4,
  POPUP_VISIBLE: [1.0, 3.0],  // s on screen
  POPUP_HIDDEN: [0.8, 2.4],   // s between appearances
  RESPAWN_DELAY: 0.45,        // s before a hit target returns

  // Misc
  PHYSICS_HZ: 120,
  MAX_DECALS: 80,
  SENS_MIN: 0.15, SENS_MAX: 4.0, SENS_STEP: 0.05,
};

const FIXED_DT = 1 / CONFIG.PHYSICS_HZ;
const MAX_FRAME_DT = 0.25;   // clamp so an alt-tab doesn't spiral the accumulator

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ------------------------------------------------------------------ *
 * Renderer / scene / camera
 * ------------------------------------------------------------------ */

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1017);
scene.fog = new THREE.Fog(0x0b1017, 45, 130);

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 400);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

/* ------------------------------------------------------------------ *
 * Lighting
 * ------------------------------------------------------------------ */

scene.add(new THREE.AmbientLight(0x5a6b80, 1.1));

const hemi = new THREE.HemisphereLight(0x88a6c8, 0x1a1f26, 0.55);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff2dd, 2.4);
sun.position.set(16, 24, 14);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 110;
// The shadow frustum must span the whole room or shadows silently vanish.
sun.shadow.camera.left = -CONFIG.ROOM_D * 0.6;
sun.shadow.camera.right = CONFIG.ROOM_D * 0.6;
sun.shadow.camera.top = CONFIG.ROOM_D * 0.6;
sun.shadow.camera.bottom = -CONFIG.ROOM_D * 0.6;
sun.shadow.bias = -0.0008;
sun.shadow.normalBias = 0.02;
scene.add(sun);

// Cool fill from the far end so the downrange wall reads.
const fill = new THREE.DirectionalLight(0x6ea8d8, 0.6);
fill.position.set(-12, 10, -30);
scene.add(fill);

/* ------------------------------------------------------------------ *
 * Procedural textures (canvas-generated — no external files)
 * ------------------------------------------------------------------ */

function makeCanvas(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

/** Speckled concrete-ish tile with grout lines. */
function concreteTexture(base, grout, repeat) {
  const tex = makeCanvas(256, (g, s) => {
    g.fillStyle = base;
    g.fillRect(0, 0, s, s);
    // fine noise
    for (let i = 0; i < 5000; i++) {
      const a = Math.random() * 0.09;
      g.fillStyle = `rgba(0,0,0,${a.toFixed(3)})`;
      g.fillRect(Math.random() * s, Math.random() * s, 2, 2);
    }
    for (let i = 0; i < 2200; i++) {
      g.fillStyle = `rgba(255,255,255,${(Math.random() * 0.05).toFixed(3)})`;
      g.fillRect(Math.random() * s, Math.random() * s, 2, 2);
    }
    // grout
    g.strokeStyle = grout;
    g.lineWidth = 5;
    g.strokeRect(0, 0, s, s);
    g.beginPath();
    g.moveTo(s / 2, 0); g.lineTo(s / 2, s);
    g.moveTo(0, s / 2); g.lineTo(s, s / 2);
    g.stroke();
  });
  tex.repeat.set(repeat, repeat);
  return tex;
}

/** Horizontal panel banding for the walls. */
function panelTexture(base, line, repeat) {
  const tex = makeCanvas(256, (g, s) => {
    g.fillStyle = base;
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 3500; i++) {
      g.fillStyle = `rgba(0,0,0,${(Math.random() * 0.07).toFixed(3)})`;
      g.fillRect(Math.random() * s, Math.random() * s, 2, 2);
    }
    g.strokeStyle = line;
    g.lineWidth = 4;
    for (let y = 0; y <= s; y += s / 4) {
      g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke();
    }
    g.lineWidth = 2;
    g.strokeStyle = 'rgba(255,255,255,0.05)';
    for (let y = 3; y <= s; y += s / 4) {
      g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke();
    }
  });
  tex.repeat.set(repeat, repeat);
  return tex;
}

/* ------------------------------------------------------------------ *
 * Physics world (static geometry only)
 * ------------------------------------------------------------------ */

const world = new CANNON.World({ gravity: new CANNON.Vec3(0, CONFIG.GRAVITY, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.defaultContactMaterial.friction = 0.4;

/** Add a static box to both the physics world and the scene. */
function addBox(size, pos, material, receive = true, cast = true) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), material);
  mesh.position.copy(pos);
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  scene.add(mesh);

  const body = new CANNON.Body({
    type: CANNON.Body.STATIC,
    shape: new CANNON.Box(new CANNON.Vec3(size.x / 2, size.y / 2, size.z / 2)),
    position: new CANNON.Vec3(pos.x, pos.y, pos.z),
  });
  world.addBody(body);
  return { mesh, body };
}

const { ROOM_W: RW, ROOM_D: RD, ROOM_H: RH } = CONFIG;
const T = 0.6; // structural thickness

const floorMat = new THREE.MeshStandardMaterial({
  map: concreteTexture('#3b4149', 'rgba(0,0,0,0.45)', 16), roughness: 0.94, metalness: 0.02,
});
const wallMat = new THREE.MeshStandardMaterial({
  map: panelTexture('#4a5260', 'rgba(0,0,0,0.35)', 8), roughness: 0.88, metalness: 0.05,
});
const ceilMat = new THREE.MeshStandardMaterial({
  map: panelTexture('#2b313a', 'rgba(0,0,0,0.5)', 10), roughness: 0.95, metalness: 0.02,
});
const propMat = new THREE.MeshStandardMaterial({
  map: concreteTexture('#59616e', 'rgba(0,0,0,0.4)', 2), roughness: 0.8, metalness: 0.08,
});
const pillarMat = new THREE.MeshStandardMaterial({
  map: panelTexture('#6a5b4d', 'rgba(0,0,0,0.4)', 3), roughness: 0.85, metalness: 0.05,
});

// Shell: floor, ceiling, four walls.
addBox(new THREE.Vector3(RW, T, RD), new THREE.Vector3(0, -T / 2, 0), floorMat, true, false);
addBox(new THREE.Vector3(RW, T, RD), new THREE.Vector3(0, RH + T / 2, 0), ceilMat, true, false);
addBox(new THREE.Vector3(T, RH, RD), new THREE.Vector3(-RW / 2 - T / 2, RH / 2, 0), wallMat);
addBox(new THREE.Vector3(T, RH, RD), new THREE.Vector3(RW / 2 + T / 2, RH / 2, 0), wallMat);
addBox(new THREE.Vector3(RW + T * 2, RH, T), new THREE.Vector3(0, RH / 2, -RD / 2 - T / 2), wallMat);
addBox(new THREE.Vector3(RW + T * 2, RH, T), new THREE.Vector3(0, RH / 2, RD / 2 + T / 2), wallMat);

// Cover: crates and pillars, kept clear of the firing lane centre-line.
const COVER = [
  { s: [2.4, 2.4, 2.4], p: [-9, 1.2, 6] },
  { s: [2.0, 1.4, 2.0], p: [-11.5, 0.7, 2] },
  { s: [2.4, 2.4, 2.4], p: [10, 1.2, 3] },
  { s: [1.6, 3.2, 1.6], p: [13, 1.6, -8] },
  { s: [3.0, 1.2, 2.0], p: [-6, 0.6, -12] },
  { s: [2.2, 2.2, 2.2], p: [7, 1.1, -18] },
  { s: [2.6, 1.6, 2.6], p: [-13, 0.8, -20] },
  { s: [1.8, 2.8, 1.8], p: [4, 1.4, -26] },
];
for (const c of COVER) {
  addBox(new THREE.Vector3(...c.s), new THREE.Vector3(...c.p), propMat);
}

const PILLARS = [
  [-15, -4], [15, -4], [-15, -24], [15, -24], [-15, 14], [15, 14],
];
for (const [x, z] of PILLARS) {
  addBox(new THREE.Vector3(1.2, RH, 1.2), new THREE.Vector3(x, RH / 2, z), pillarMat);
}

// A lit strip down the ceiling so the room has some depth cues.
for (let z = -RD / 2 + 6; z < RD / 2; z += 10) {
  const strip = new THREE.Mesh(
    new THREE.BoxGeometry(5, 0.12, 0.7),
    new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xbfd8ff, emissiveIntensity: 1.6 })
  );
  strip.position.set(0, RH - 0.16, z);
  scene.add(strip);
  const lamp = new THREE.PointLight(0xcfe2ff, 12, 26, 2);
  lamp.position.set(0, RH - 0.6, z);
  scene.add(lamp);
}

/* ------------------------------------------------------------------ *
 * Targets
 * ------------------------------------------------------------------ */

const TargetType = { STATIC: 'static', MOVING: 'moving', POPUP: 'popup' };

const targets = [];
const targetGroup = new THREE.Group();
scene.add(targetGroup);

const MAT_STATIC = new THREE.MeshStandardMaterial({
  color: 0xe0342f, emissive: 0x5c0d0a, emissiveIntensity: 0.9, roughness: 0.35, metalness: 0.1,
});
const MAT_MOVING = new THREE.MeshStandardMaterial({
  color: 0xf5c518, emissive: 0x5c4406, emissiveIntensity: 0.9, roughness: 0.35, metalness: 0.1,
});
const MAT_POPUP = new THREE.MeshStandardMaterial({
  color: 0x35d06a, emissive: 0x0b4a22, emissiveIntensity: 0.9, roughness: 0.35, metalness: 0.1,
});

const SPHERE_GEO = new THREE.SphereGeometry(1, 20, 14);
const CYL_GEO = new THREE.CylinderGeometry(1, 1, 2, 18); // unit: r=1, halfHeight=1

/** Target radius grows with distance so far targets stay hittable. */
function radiusForDistance(dist) {
  const t = clamp((dist - CONFIG.TARGET_NEAR) / (CONFIG.TARGET_FAR - CONFIG.TARGET_NEAR), 0, 1);
  return THREE.MathUtils.lerp(CONFIG.TARGET_R_NEAR, CONFIG.TARGET_R_FAR, t);
}

// Player spawn — one end of the range, facing -Z.
const SPAWN = new THREE.Vector3(0, CONFIG.EYE_HEIGHT, RD / 2 - 6);

class Target {
  constructor(type) {
    this.type = type;
    const isCyl = type === TargetType.POPUP;
    this.mesh = new THREE.Mesh(
      isCyl ? CYL_GEO : SPHERE_GEO,
      type === TargetType.STATIC ? MAT_STATIC : type === TargetType.MOVING ? MAT_MOVING : MAT_POPUP
    );
    this.mesh.castShadow = true;
    targetGroup.add(this.mesh);

    this.alive = true;
    this.respawnIn = 0;
    this.t = 0;
    this.place();
  }

  /** Choose a fresh position/size and reset per-type motion state. */
  place() {
    const dist = rand(CONFIG.TARGET_NEAR, CONFIG.TARGET_FAR);
    this.radius = radiusForDistance(dist);
    // Distances are measured from the spawn point, straight downrange.
    this.home = new THREE.Vector3(
      rand(-RW / 2 + 3, RW / 2 - 3),
      rand(1.1, 3.4),
      SPAWN.z - dist
    );
    this.pos = this.home.clone();
    this.t = rand(0, Math.PI * 2);

    if (this.type === TargetType.MOVING) {
      this.amplitude = rand(2.5, 6.0);
      this.speed = rand(0.6, 1.4);         // rad/s — peak lateral speed stays under ~8 m/s
      this.vertical = Math.random() < 0.35;
      if (this.vertical) {
        this.amplitude = rand(0.7, 1.6);
        this.home.y = clamp(this.home.y, 1.6, 3.0);
      }
    }

    if (this.type === TargetType.POPUP) {
      this.halfHeight = this.radius * 2.0;
      this.visible = false;
      this.phaseTimer = rand(0.2, CONFIG.POPUP_HIDDEN[1]);
      this.home.y = clamp(this.home.y, 1.2, 3.0);
    }

    this.applyTransform();
    this.mesh.visible = this.type !== TargetType.POPUP;
  }

  applyTransform() {
    this.mesh.position.copy(this.pos);
    if (this.type === TargetType.POPUP) {
      this.mesh.scale.set(this.radius, this.halfHeight, this.radius);
    } else {
      this.mesh.scale.setScalar(this.radius);
    }
  }

  /** Only hittable when alive AND (for pop-ups) currently shown. */
  get hittable() {
    return this.alive && this.mesh.visible;
  }

  update(dt) {
    if (!this.alive) {
      this.respawnIn -= dt;
      if (this.respawnIn <= 0) {
        this.alive = true;
        this.place();
      }
      return;
    }

    this.t += dt;

    if (this.type === TargetType.MOVING) {
      const offset = Math.sin(this.t * this.speed) * this.amplitude;
      if (this.vertical) {
        this.pos.set(this.home.x, this.home.y + offset, this.home.z);
      } else {
        this.pos.set(clamp(this.home.x + offset, -RW / 2 + 1.5, RW / 2 - 1.5), this.home.y, this.home.z);
      }
      this.applyTransform();
    } else if (this.type === TargetType.POPUP) {
      this.phaseTimer -= dt;
      if (this.phaseTimer <= 0) {
        this.visible = !this.visible;
        this.mesh.visible = this.visible;
        if (this.visible) {
          this.phaseTimer = rand(...CONFIG.POPUP_VISIBLE);
        } else {
          this.place();           // reappear somewhere new next time
          this.mesh.visible = false;
          this.visible = false;
          this.phaseTimer = rand(...CONFIG.POPUP_HIDDEN);
        }
      }
    }
  }

  kill() {
    this.alive = false;
    this.mesh.visible = false;
    this.respawnIn = CONFIG.RESPAWN_DELAY;
  }
}

function buildTargets() {
  for (const t of targets) targetGroup.remove(t.mesh);
  targets.length = 0;
  for (let i = 0; i < CONFIG.STATIC_COUNT; i++) targets.push(new Target(TargetType.STATIC));
  for (let i = 0; i < CONFIG.MOVING_COUNT; i++) targets.push(new Target(TargetType.MOVING));
  for (let i = 0; i < CONFIG.POPUP_COUNT; i++) targets.push(new Target(TargetType.POPUP));
}

/* ------------------------------------------------------------------ *
 * Analytic segment intersection tests
 * All take a segment origin `o`, unit direction `d` and length `len`.
 * Return the hit distance along the segment, or -1.
 * ------------------------------------------------------------------ */

const _m = new THREE.Vector3();

function segmentSphere(o, d, len, center, r) {
  _m.subVectors(o, center);
  const b = _m.dot(d);
  const c = _m.dot(_m) - r * r;
  if (c > 0 && b > 0) return -1;          // origin outside, pointing away
  const disc = b * b - c;
  if (disc < 0) return -1;
  let t = -b - Math.sqrt(disc);
  if (t < 0) t = 0;                       // origin already inside
  return t <= len ? t : -1;
}

/** Y-axis-aligned finite cylinder: infinite-cylinder solve in XZ, then clamp to the height slab. */
function segmentCylinderY(o, d, len, center, r, halfH) {
  const mx = o.x - center.x, mz = o.z - center.z;
  const a = d.x * d.x + d.z * d.z;
  const b = 2 * (mx * d.x + mz * d.z);
  const c = mx * mx + mz * mz - r * r;

  let t;
  if (a < 1e-8) {
    // Segment is (near) parallel to the axis — only hits if already inside the radius.
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
  if (y < center.y - halfH || y > center.y + halfH) {
    // Missed the side wall — try the end caps.
    if (Math.abs(d.y) < 1e-8) return -1;
    const capY = d.y > 0 ? center.y - halfH : center.y + halfH;
    const tc = (capY - o.y) / d.y;
    if (tc < 0 || tc > len) return -1;
    const px = o.x + d.x * tc - center.x;
    const pz = o.z + d.z * tc - center.z;
    return (px * px + pz * pz <= r * r) ? tc : -1;
  }
  return t;
}

/** Nearest hittable target along the swept segment. */
function nearestTargetHit(o, d, len) {
  let best = null, bestT = Infinity;
  for (const tgt of targets) {
    if (!tgt.hittable) continue;
    const t = tgt.type === TargetType.POPUP
      ? segmentCylinderY(o, d, len, tgt.pos, tgt.radius, tgt.halfHeight)
      : segmentSphere(o, d, len, tgt.pos, tgt.radius);
    if (t >= 0 && t < bestT) { bestT = t; best = tgt; }
  }
  return best ? { target: best, t: bestT } : null;
}

/* ------------------------------------------------------------------ *
 * Decals (bullet holes)
 * ------------------------------------------------------------------ */

const decalGeo = new THREE.CircleGeometry(0.055, 12);
const decalMat = new THREE.MeshBasicMaterial({
  color: 0x0a0a0c, transparent: true, opacity: 0.9,
  depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4,
});
const decalPool = [];
let decalCursor = 0;

const _decalLook = new THREE.Vector3();
function spawnDecal(point, normal) {
  let d;
  if (decalPool.length < CONFIG.MAX_DECALS) {
    d = new THREE.Mesh(decalGeo, decalMat);
    scene.add(d);
    decalPool.push(d);
  } else {
    d = decalPool[decalCursor];
    decalCursor = (decalCursor + 1) % CONFIG.MAX_DECALS;
  }
  // Sit 1 cm proud of the surface along its normal to avoid z-fighting.
  d.position.copy(point).addScaledVector(normal, 0.01);
  d.lookAt(_decalLook.copy(d.position).add(normal));
  d.rotateZ(Math.random() * Math.PI);
  d.scale.setScalar(rand(0.8, 1.35));
}

function clearDecals() {
  for (const d of decalPool) scene.remove(d);
  decalPool.length = 0;
  decalCursor = 0;
}

/* ------------------------------------------------------------------ *
 * Impact sparks — a tiny points burst so hits read at distance
 * ------------------------------------------------------------------ */

const sparks = [];
const sparkGeo = new THREE.SphereGeometry(0.05, 6, 5);
const sparkMat = new THREE.MeshBasicMaterial({ color: 0xffd08a, transparent: true });

function spawnSpark(point, color) {
  const m = new THREE.Mesh(sparkGeo, sparkMat.clone());
  m.material.color.setHex(color);
  m.position.copy(point);
  scene.add(m);
  sparks.push({ mesh: m, life: 0.22, max: 0.22 });
}

function updateSparks(dt) {
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.life -= dt;
    if (s.life <= 0) {
      scene.remove(s.mesh);
      s.mesh.material.dispose();
      sparks.splice(i, 1);
      continue;
    }
    const k = s.life / s.max;
    s.mesh.scale.setScalar(1 + (1 - k) * 5);
    s.mesh.material.opacity = k;
  }
}

/* ------------------------------------------------------------------ *
 * Bullets — hand-integrated projectiles with swept collision
 * ------------------------------------------------------------------ */

const bullets = [];
const bulletGeo = new THREE.SphereGeometry(1, 8, 6);
const bulletMat = new THREE.MeshBasicMaterial({ color: 0xfff0b0 });

// Reused scratch objects — allocating per physics tick would thrash the GC.
const _rayFrom = new CANNON.Vec3();
const _rayTo = new CANNON.Vec3();
const _rayResult = new CANNON.RaycastResult();
const _step = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
const _hitNormal = new THREE.Vector3();
const _up = new THREE.Vector3(0, 0, 1);

function spawnBullet(origin, direction) {
  const mesh = new THREE.Mesh(bulletGeo, bulletMat);
  mesh.frustumCulled = false;
  scene.add(mesh);
  bullets.push({
    pos: origin.clone(),
    prev: origin.clone(),
    vel: direction.clone().multiplyScalar(CONFIG.MUZZLE_VELOCITY),
    travelled: 0,
    mesh,
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
 * One fixed physics step for every bullet.
 * Gravity is integrated explicitly, then the swept segment prev->pos is tested
 * against the targets (analytic) and the cannon static world (raycastClosest).
 * Whichever is nearer wins — that ordering is what prevents shooting through walls.
 */
function stepBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];

    b.prev.copy(b.pos);
    b.vel.y += CONFIG.GRAVITY * dt;          // bullet drop
    _step.copy(b.vel).multiplyScalar(dt);
    b.pos.add(_step);

    const len = _step.length();
    if (len < 1e-6) continue;
    _dir.copy(_step).divideScalar(len);

    // 1. Targets
    const tHit = nearestTargetHit(b.prev, _dir, len);

    // 2. Static world
    _rayFrom.set(b.prev.x, b.prev.y, b.prev.z);
    _rayTo.set(b.pos.x, b.pos.y, b.pos.z);
    _rayResult.reset();
    world.raycastClosest(_rayFrom, _rayTo, { skipBackfaces: true }, _rayResult);
    const wallT = _rayResult.hasHit ? _rayResult.distance : Infinity;

    if (tHit && tHit.t <= wallT) {
      _hitPoint.copy(b.prev).addScaledVector(_dir, tHit.t);
      onTargetHit(tHit.target, _hitPoint);
      despawnBullet(i);
      continue;
    }

    if (_rayResult.hasHit) {
      _hitPoint.set(_rayResult.hitPointWorld.x, _rayResult.hitPointWorld.y, _rayResult.hitPointWorld.z);
      _hitNormal.set(_rayResult.hitNormalWorld.x, _rayResult.hitNormalWorld.y, _rayResult.hitNormalWorld.z);
      spawnDecal(_hitPoint, _hitNormal);
      spawnSpark(_hitPoint, 0xffd08a);
      despawnBullet(i);
      continue;
    }

    b.travelled += len;
    if (b.travelled > CONFIG.MAX_RANGE) { despawnBullet(i); continue; }

    // Visual: a 400 m/s point-sphere would never render twice in the same place,
    // so stretch it into a tracer streak spanning the distance covered this step.
    const streak = Math.min(len, CONFIG.TRACER_MAX_LENGTH);
    _mid.copy(b.pos).addScaledVector(_dir, -streak / 2);
    b.mesh.position.copy(_mid);
    b.mesh.quaternion.setFromUnitVectors(_up, _dir);
    b.mesh.scale.set(CONFIG.BULLET_RADIUS, CONFIG.BULLET_RADIUS, streak / 2);
  }
}

/* ------------------------------------------------------------------ *
 * Audio — synthesised gunshot, no external files
 * ------------------------------------------------------------------ */

let audioCtx = null;
let noiseBuffer = null;

/** Must be called from a user gesture or the context stays suspended. */
function initAudio() {
  if (audioCtx) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return;
  }
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const len = Math.floor(audioCtx.sampleRate * 0.4);
  noiseBuffer = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
}

/** Crack (filtered noise burst) + thump (pitch-swept sine) + a short tail. */
function playGunshot() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const now = audioCtx.currentTime;

  const master = audioCtx.createGain();
  master.gain.value = 0.5;
  master.connect(audioCtx.destination);

  // Crack
  const noise = audioCtx.createBufferSource();
  noise.buffer = noiseBuffer;
  const bp = audioCtx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(1800, now);
  bp.frequency.exponentialRampToValueAtTime(500, now + 0.12);
  bp.Q.value = 0.8;
  const ng = audioCtx.createGain();
  ng.gain.setValueAtTime(1.0, now);
  ng.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
  noise.connect(bp).connect(ng).connect(master);
  noise.start(now);
  noise.stop(now + 0.2);

  // Low thump
  const osc = audioCtx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(160, now);
  osc.frequency.exponentialRampToValueAtTime(42, now + 0.1);
  const og = audioCtx.createGain();
  og.gain.setValueAtTime(0.9, now);
  og.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
  osc.connect(og).connect(master);
  osc.start(now);
  osc.stop(now + 0.2);

  // Room tail
  const tail = audioCtx.createBufferSource();
  tail.buffer = noiseBuffer;
  const lp = audioCtx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 700;
  const tg = audioCtx.createGain();
  tg.gain.setValueAtTime(0.18, now + 0.02);
  tg.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
  tail.connect(lp).connect(tg).connect(master);
  tail.start(now + 0.02);
  tail.stop(now + 0.45);
}

function playHitPing() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  osc.type = 'square';
  osc.frequency.setValueAtTime(1400, now);
  osc.frequency.exponentialRampToValueAtTime(2100, now + 0.05);
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.13, now);
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + 0.14);
}

/* ------------------------------------------------------------------ *
 * Weapon model + muzzle flash (children of the camera)
 * ------------------------------------------------------------------ */

const weapon = new THREE.Group();
camera.add(weapon);
scene.add(camera);

const gunMetal = new THREE.MeshStandardMaterial({ color: 0x24282e, roughness: 0.45, metalness: 0.85 });
const gunGrip = new THREE.MeshStandardMaterial({ color: 0x14171b, roughness: 0.85, metalness: 0.15 });

function gunPart(w, h, d, x, y, z, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  weapon.add(m);
  return m;
}
gunPart(0.075, 0.10, 0.34, 0, 0, -0.17, gunMetal);         // receiver
gunPart(0.045, 0.045, 0.40, 0, 0.012, -0.44, gunMetal);    // barrel shroud
gunPart(0.055, 0.13, 0.075, 0, -0.105, -0.05, gunGrip);    // grip
gunPart(0.05, 0.055, 0.16, 0, -0.055, -0.30, gunGrip);     // handguard
gunPart(0.016, 0.03, 0.02, 0, 0.06, -0.62, gunMetal);      // front sight

// The muzzle is an empty at the tip — the flash light and bullets spawn from it.
const muzzle = new THREE.Object3D();
muzzle.position.set(0, 0.012, -0.66);
weapon.add(muzzle);

const muzzleFlash = new THREE.PointLight(0xffc35a, 0, 12, 2);
muzzleFlash.position.copy(muzzle.position);
weapon.add(muzzleFlash);

const flashSprite = new THREE.Mesh(
  new THREE.SphereGeometry(0.09, 8, 6),
  new THREE.MeshBasicMaterial({ color: 0xffdd99, transparent: true, opacity: 0 })
);
flashSprite.position.copy(muzzle.position);
weapon.add(flashSprite);

let flashTimer = 0;
const FLASH_DURATION = 0.045;

// Weapon rest pose; sway/bob are offsets from here.
const WEAPON_REST = new THREE.Vector3(0.17, -0.15, -0.02);
weapon.position.copy(WEAPON_REST);

const swayTarget = new THREE.Vector2(0, 0);   // driven by mouse delta
const swayCurrent = new THREE.Vector2(0, 0);
let bobPhase = 0;

/* ------------------------------------------------------------------ *
 * Player state, input, camera control
 * ------------------------------------------------------------------ */

const player = {
  pos: SPAWN.clone(),
  vel: new THREE.Vector3(),
  yaw: 0,
  pitch: 0,
  recoilPitch: 0,
  recoilYaw: 0,
};

const keys = Object.create(null);
let sensitivity = 1.0;
let firing = false;
let fireCooldown = 0;
let locked = false;

const stats = { score: 0, shots: 0, lastHitDistance: null };
const session = { mode: 0, remaining: 0, elapsed: 0, running: false, over: false };

const el = (id) => document.getElementById(id);
const dom = {
  overlay: el('overlay'), result: el('result'), timer: el('timer'),
  score: el('s-score'), shots: el('s-shots'), acc: el('s-acc'),
  dist: el('s-dist'), sens: el('s-sens'), fps: el('s-fps'),
  bullets: el('s-bullets'), hitmarker: el('hitmarker'),
};

// --- Pointer lock ---------------------------------------------------

dom.overlay.addEventListener('click', (e) => {
  if (e.target.classList.contains('mode')) return;   // mode buttons handled separately
  initAudio();
  renderer.domElement.requestPointerLock();
});

for (const btn of document.querySelectorAll('.mode')) {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    for (const b of document.querySelectorAll('.mode')) b.classList.remove('active');
    btn.classList.add('active');
    session.mode = Number(btn.dataset.seconds);
    resetSession();
  });
}

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === renderer.domElement;
  dom.overlay.classList.toggle('hidden', locked);
  if (locked) {
    if (session.over) resetSession();
    session.running = true;
  } else {
    session.running = false;
    firing = false;
  }
});

// --- Mouse ----------------------------------------------------------

document.addEventListener('mousemove', (e) => {
  if (!locked) return;
  const s = 0.0022 * sensitivity;
  player.yaw -= e.movementX * s;
  player.pitch -= e.movementY * s;
  player.pitch = clamp(player.pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);

  // Weapon sway lags behind fast mouse movement.
  swayTarget.x = clamp(swayTarget.x - e.movementX * 0.0012, -0.06, 0.06);
  swayTarget.y = clamp(swayTarget.y + e.movementY * 0.0012, -0.05, 0.05);
});

document.addEventListener('mousedown', (e) => {
  if (!locked || e.button !== 0) return;
  firing = true;
  fireCooldown = 0;   // fire immediately on press
});
document.addEventListener('mouseup', (e) => { if (e.button === 0) firing = false; });

// Scroll adjusts sensitivity. passive:false so preventDefault actually applies.
addEventListener('wheel', (e) => {
  if (!locked) return;
  e.preventDefault();
  sensitivity = clamp(sensitivity - Math.sign(e.deltaY) * CONFIG.SENS_STEP, CONFIG.SENS_MIN, CONFIG.SENS_MAX);
  dom.sens.textContent = sensitivity.toFixed(2);
}, { passive: false });

// --- Keyboard -------------------------------------------------------

addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'KeyR') resetSession();
});
addEventListener('keyup', (e) => { keys[e.code] = false; });

/* ------------------------------------------------------------------ *
 * Shooting
 * ------------------------------------------------------------------ */

const _muzzleWorld = new THREE.Vector3();
const _aimDir = new THREE.Vector3();

function shoot() {
  stats.shots++;

  // The projectile originates on the camera axis, not at the barrel tip. The muzzle
  // sits ~0.2 m right of and below the eye; spawning there and firing parallel to the
  // view axis leaves the bullet permanently ~0.2 m off the crosshair — wider than a
  // target — so every shot would miss. Real weapons solve this by converging the bore
  // on the sight line; here the sight line IS the bore, which keeps the crosshair
  // truthful at every range. Bullet drop is unaffected and still has to be led for.
  camera.getWorldDirection(_aimDir);
  camera.getWorldPosition(_muzzleWorld);
  spawnBullet(_muzzleWorld, _aimDir);

  // Recoil impulse
  player.recoilPitch += CONFIG.RECOIL_PITCH;
  player.recoilYaw += rand(-CONFIG.RECOIL_YAW, CONFIG.RECOIL_YAW);

  flashTimer = FLASH_DURATION;
  playGunshot();
  updateHUD();
}

function onTargetHit(target, point) {
  stats.score++;
  stats.lastHitDistance = player.pos.distanceTo(point);
  target.kill();
  spawnSpark(point, 0xff6a4a);
  playHitPing();
  flashHitmarker();
  updateHUD();
}

let hitmarkerTimer = 0;
function flashHitmarker() { hitmarkerTimer = 0.14; }

/* ------------------------------------------------------------------ *
 * Movement (simple capsule-free collision against the room bounds)
 * ------------------------------------------------------------------ */

const _wish = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const PLAYER_RADIUS = 0.35;

function updatePlayer(dt) {
  _fwd.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  _right.set(Math.cos(player.yaw), 0, -Math.sin(player.yaw));

  _wish.set(0, 0, 0);
  if (keys['KeyW']) _wish.add(_fwd);
  if (keys['KeyS']) _wish.sub(_fwd);
  if (keys['KeyD']) _wish.add(_right);
  if (keys['KeyA']) _wish.sub(_right);
  if (_wish.lengthSq() > 0) _wish.normalize();

  const speed = (keys['ShiftLeft'] || keys['ShiftRight']) ? CONFIG.SPRINT_SPEED : CONFIG.WALK_SPEED;
  _wish.multiplyScalar(speed);

  // Exponential approach to the wish velocity — gives weight without a full physics body.
  const k = 1 - Math.exp(-CONFIG.MOVE_ACCEL * dt);
  player.vel.lerp(_wish, k);

  const nextX = player.pos.x + player.vel.x * dt;
  const nextZ = player.pos.z + player.vel.z * dt;

  // Room bounds
  player.pos.x = clamp(nextX, -RW / 2 + PLAYER_RADIUS, RW / 2 - PLAYER_RADIUS);
  player.pos.z = clamp(nextZ, -RD / 2 + PLAYER_RADIUS, RD / 2 - PLAYER_RADIUS);

  // Push out of any cover box we ended up inside (axis of least penetration).
  for (const c of COVER) {
    const hx = c.s[0] / 2 + PLAYER_RADIUS, hz = c.s[2] / 2 + PLAYER_RADIUS;
    const dx = player.pos.x - c.p[0], dz = player.pos.z - c.p[2];
    if (Math.abs(dx) < hx && Math.abs(dz) < hz && c.p[1] + c.s[1] / 2 > 0.9) {
      const penX = hx - Math.abs(dx), penZ = hz - Math.abs(dz);
      if (penX < penZ) { player.pos.x += Math.sign(dx || 1) * penX; player.vel.x = 0; }
      else { player.pos.z += Math.sign(dz || 1) * penZ; player.vel.z = 0; }
    }
  }
  for (const [px, pz] of PILLARS) {
    const hx = 0.6 + PLAYER_RADIUS, hz = 0.6 + PLAYER_RADIUS;
    const dx = player.pos.x - px, dz = player.pos.z - pz;
    if (Math.abs(dx) < hx && Math.abs(dz) < hz) {
      const penX = hx - Math.abs(dx), penZ = hz - Math.abs(dz);
      if (penX < penZ) { player.pos.x += Math.sign(dx || 1) * penX; player.vel.x = 0; }
      else { player.pos.z += Math.sign(dz || 1) * penZ; player.vel.z = 0; }
    }
  }

  player.pos.y = CONFIG.EYE_HEIGHT;

  // Recoil decays back toward zero; the kick is added on top of the aim angles.
  const decay = Math.exp(-CONFIG.RECOIL_RECOVERY * dt);
  player.recoilPitch *= decay;
  player.recoilYaw *= decay;

  camera.position.copy(player.pos);
  camera.rotation.set(player.pitch + player.recoilPitch, player.yaw + player.recoilYaw, 0, 'YXZ');
}

function updateWeapon(dt) {
  // Sway springs back to centre; the target itself is driven by mouse motion.
  swayTarget.multiplyScalar(Math.exp(-6 * dt));
  swayCurrent.lerp(swayTarget, 1 - Math.exp(-10 * dt));

  const planarSpeed = Math.hypot(player.vel.x, player.vel.z);
  bobPhase += dt * planarSpeed * 1.9;
  const bobAmount = Math.min(planarSpeed / CONFIG.WALK_SPEED, 1.4) * 0.012;
  const bobX = Math.cos(bobPhase) * bobAmount;
  const bobY = Math.abs(Math.sin(bobPhase)) * bobAmount;

  weapon.position.set(
    WEAPON_REST.x + swayCurrent.x + bobX,
    WEAPON_REST.y + swayCurrent.y - bobY - player.recoilPitch * 0.25,
    WEAPON_REST.z + player.recoilPitch * 0.7        // gun slides back under recoil
  );
  weapon.rotation.set(
    -swayCurrent.y * 2.2 - player.recoilPitch * 0.8,
    -swayCurrent.x * 2.6,
    swayCurrent.x * 1.4
  );

  // Muzzle flash decay
  if (flashTimer > 0) {
    flashTimer -= dt;
    const k = Math.max(flashTimer, 0) / FLASH_DURATION;
    muzzleFlash.intensity = k * 26;
    flashSprite.material.opacity = k;
    flashSprite.scale.setScalar(0.7 + (1 - k) * 0.9);
  } else {
    muzzleFlash.intensity = 0;
    flashSprite.material.opacity = 0;
  }
}

/* ------------------------------------------------------------------ *
 * Session / HUD
 * ------------------------------------------------------------------ */

function resetSession() {
  stats.score = 0;
  stats.shots = 0;
  stats.lastHitDistance = null;
  session.elapsed = 0;
  session.remaining = session.mode;
  session.over = false;
  session.running = locked;
  clearBullets();
  clearDecals();
  buildTargets();
  player.pos.copy(SPAWN);
  player.vel.set(0, 0, 0);
  player.yaw = 0; player.pitch = 0;
  player.recoilPitch = 0; player.recoilYaw = 0;
  dom.result.textContent = '';
  updateHUD();
}

function endSession() {
  session.over = true;
  session.running = false;
  const acc = stats.shots ? (stats.score / stats.shots) * 100 : 0;
  dom.result.textContent =
    `TIME UP — ${stats.score} HITS / ${stats.shots} SHOTS · ${acc.toFixed(1)}% ACCURACY`;
  document.exitPointerLock();
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function updateHUD() {
  dom.score.textContent = stats.score;
  dom.shots.textContent = stats.shots;
  dom.acc.textContent = stats.shots ? `${((stats.score / stats.shots) * 100).toFixed(1)}%` : '0%';
  dom.dist.textContent = stats.lastHitDistance === null ? '—' : `${stats.lastHitDistance.toFixed(1)} m`;
  dom.sens.textContent = sensitivity.toFixed(2);
}

/* ------------------------------------------------------------------ *
 * Main loop — fixed-timestep physics, variable-rate rendering
 * ------------------------------------------------------------------ */

let accumulator = 0;
let lastTime = performance.now();
let fpsAccum = 0, fpsFrames = 0;

function fixedUpdate(dt) {
  world.step(dt);                     // we own the accumulator, so no substepping here
  updatePlayer(dt);
  for (const t of targets) t.update(dt);
  stepBullets(dt);

  if (firing) {
    fireCooldown -= dt;
    if (fireCooldown <= 0) {
      shoot();
      fireCooldown = CONFIG.FIRE_INTERVAL;
    }
  }
}

function frame(now) {
  requestAnimationFrame(frame);

  const rawDt = (now - lastTime) / 1000;
  lastTime = now;
  const dt = Math.min(rawDt, MAX_FRAME_DT);

  // FPS counter (averaged over ~0.4 s so it doesn't flicker)
  fpsAccum += rawDt; fpsFrames++;
  if (fpsAccum >= 0.4) {
    dom.fps.textContent = Math.round(fpsFrames / fpsAccum);
    fpsAccum = 0; fpsFrames = 0;
  }

  if (session.running) {
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < 60) {   // step cap = spiral-of-death guard
      fixedUpdate(FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps >= 60) accumulator = 0;

    session.elapsed += dt;
    if (session.mode > 0) {
      session.remaining = Math.max(0, session.mode - session.elapsed);
      dom.timer.textContent = formatTime(session.remaining);
      if (session.remaining <= 0) endSession();
    } else {
      dom.timer.textContent = formatTime(session.elapsed);
    }
  }

  // Frame-rate-dependent presentation only.
  updateWeapon(dt);
  updateSparks(dt);

  if (hitmarkerTimer > 0) {
    hitmarkerTimer -= dt;
    dom.hitmarker.style.opacity = Math.max(0, hitmarkerTimer / 0.14);
  }

  dom.bullets.textContent = bullets.length;
  renderer.render(scene, camera);
}

resetSession();
dom.timer.textContent = formatTime(0);
requestAnimationFrame(frame);

// Debug handle — lets the game be inspected or driven without a pointer lock.
window.__aim = { CONFIG, scene, camera, player, session, stats, targets, bullets, shoot, resetSession };
