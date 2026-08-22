import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { CONFIG, DUNGEON_CEIL, DUNGEON_TILE } from './config.js';
import {
  RAY_OPTS,
  addStaticBox,
  addStaticCylinder,
  mapBodies,
  world,
} from './physics.js';
import { disposeTree, markShared, matte } from './rendering.js';
import { clamp, lerp, pick, rand, randInt } from './utils.js';

/** Warehouse/Dungeon construction, navigation, presentation, and teardown runtime. */
export function createMapRuntime({
  scene,
  maxAnisotropy: MAX_ANISO,
  ceilingLayer: L_CEIL,
  mapLayer: L_MAP,
  glowTexture,
  addLightEmitter,
  lightEmitters,
  lightSlots,
  spawnAmmoChests,
  spawnConsumables,
  clearMapItems,
}) {
const PH = 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k';
const texLoader = new THREE.TextureLoader();
texLoader.setCrossOrigin('anonymous');

/**
 * A PBR material that is usable the instant it is created and upgrades itself as the
 * Poly Haven maps arrive. It starts as a flat `fallback` colour; when the albedo lands the
 * colour is neutralised so the texture shows through. If the network or CORS kills the
 * request the material simply stays the flat colour — the arena is never left untextured.
 *
 * The ARM map feeds roughnessMap/metalnessMap only. aoMap is skipped on purpose: in three
 * r169 it samples the `uv1` attribute, which none of these primitives have, so wiring it up
 * would render everything fully occluded.
 */
function pbrMat(slug, { repeat = 4, fallback = 0x8a8a8a, rough = 0.9, metal = 0.0, extra = {} } = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color: fallback, roughness: rough, metalness: metal, ...extra,
  });
  const base = `${PH}/${slug}/${slug}`;
  texLoader.load(
    `${base}_diff_1k.jpg`,
    (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeat, repeat);
      t.anisotropy = MAX_ANISO;
      t.colorSpace = THREE.SRGBColorSpace;
      mat.map = t;
      mat.color.setHex(0xffffff);
      mat.needsUpdate = true;
    },
    undefined,
    () => { mat.color.setHex(fallback); },
  );
  texLoader.load(
    `${base}_nor_gl_1k.jpg`,
    (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeat, repeat);
      t.anisotropy = MAX_ANISO;
      mat.normalMap = t;
      mat.normalScale.set(0.8, 0.8);
      mat.needsUpdate = true;
    },
    undefined, () => {},
  );
  texLoader.load(
    `${base}_arm_1k.jpg`,
    (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeat, repeat);
      t.anisotropy = MAX_ANISO;
      mat.roughnessMap = t;
      mat.metalnessMap = t;
      mat.metalness = Math.max(metal, 0.35);   // metalnessMap multiplies, so give it headroom
      mat.needsUpdate = true;
    },
    undefined, () => {},
  );
  return mat;
}

const MATS = {
  floor: pbrMat('concrete_wall_006', { repeat: 8, fallback: 0x6a6f74, rough: 0.95 }),
  wall:  pbrMat('brick_wall_006',    { repeat: 6, fallback: 0x6d5a4e, rough: 0.92 }),
  metal: pbrMat('metal_plate',       { repeat: 3, fallback: 0x7b8894, rough: 0.5, metal: 0.6 }),
  ceiling: new THREE.MeshStandardMaterial({ color: 0x14181f, roughness: 1.0, metalness: 0.0, side: THREE.FrontSide }),
  trim: new THREE.MeshStandardMaterial({ color: 0xffb454, roughness: 0.6, metalness: 0.2 }),
};

/** Ground-plane footprints that block walking — used to lay out the bot waypoint graph. */
const blockers = [];
function addBlocker(cx, cz, hx, hz) { blockers.push({ x: cx, z: cz, hx, hz }); }
function inBlocker(x, z, pad = 0) {
  for (const b of blockers) {
    if (Math.abs(x - b.x) < b.hx + pad && Math.abs(z - b.z) < b.hz + pad) return true;
  }
  return false;
}

const mapGroup = new THREE.Group();
scene.add(mapGroup);

/**
 * Texture tiles per metre, per material. The maps already carry a `repeat`, so the per-mesh
 * UV scale has to be its reciprocal-ish: scale * repeat lands near 0.5 tiles/m (one tile
 * every two metres) for every surface, which is what keeps a 30 m wall from turning into
 * aliased noise while a 3 m crate still reads as brick.
 */
const UV_SCALE = new Map([
  [MATS.floor, 0.06],   // repeat 8  -> 0.48 tiles/m
  [MATS.wall, 0.08],    // repeat 6  -> 0.48
  [MATS.metal, 0.16],   // repeat 3  -> 0.48
  [MATS.trim, 0.25],
]);

/** Box mesh + matching static collider, with UV scaling so textures keep a constant density. */
function addSolid(w, h, d, x, y, z, mat, { block = true, uvScale = null, cast = true } = {}) {
  const uvs = uvScale ?? UV_SCALE.get(mat) ?? 0.15;
  const geo = new THREE.BoxGeometry(w, h, d);
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = cast;
  m.receiveShadow = true;
  mapGroup.add(m);
  addStaticBox(w / 2, h / 2, d / 2, { x, y, z });
  if (block && y + h / 2 > 0.7 && y - h / 2 < 2.4) addBlocker(x, z, w / 2, d / 2);
  // Scale the UVs per-instance so a 30 m wall does not show one stretched brick.
  const uv = geo.attributes.uv;
  const norm = geo.attributes.normal;
  for (let i = 0; i < uv.count; i++) {
    const ny = Math.abs(norm.getY(i));
    const su = ny > 0.5 ? w : (Math.abs(norm.getX(i)) > 0.5 ? d : w);
    const sv = ny > 0.5 ? d : h;
    uv.setXY(i, uv.getX(i) * su * uvs, uv.getY(i) * sv * uvs);
  }
  uv.needsUpdate = true;
  return m;
}

/** Inclined slab from (x0,y0,z0) up to (x1,y1,z1) — the only way onto the central hub. */
function addRamp(x0, y0, z0, x1, y1, z1, width, mat) {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const run = Math.hypot(dx, dz);
  const len = Math.hypot(run, dy);
  const yaw = Math.atan2(dx, dz);
  const pitch = -Math.atan2(dy, run);
  const euler = new THREE.Euler(pitch, yaw, 0, 'YXZ');
  const quat = new THREE.Quaternion().setFromEuler(euler);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;

  const m = new THREE.Mesh(new THREE.BoxGeometry(width, 0.4, len), mat);
  m.position.set(cx, cy, cz);
  m.quaternion.copy(quat);
  m.castShadow = true; m.receiveShadow = true;
  mapGroup.add(m);

  const cq = new CANNON.Quaternion(quat.x, quat.y, quat.z, quat.w);
  addStaticBox(width / 2, 0.2, len / 2, { x: cx, y: cy, z: cz }, cq);
  addBlocker(cx, cz, width / 2, Math.max(Math.abs(dz) / 2, width / 2));
  return m;
}

function addPillar(x, z, radius, height, mat) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 1.12, height, 16), mat);
  m.position.set(x, height / 2, z);
  m.castShadow = true; m.receiveShadow = true;
  mapGroup.add(m);
  addStaticCylinder(radius, height, { x, y: height / 2, z });
  addBlocker(x, z, radius, radius);
  return m;
}

/* --------------------------- GLB props --------------------------- */

const gltfLoader = new GLTFLoader();
/** name -> prepared THREE.Group (cloned per instance). Missing entries fall back to primitives. */
const propCache = {};

const PROP_FILES = {
  crate:   { file: 'box-large.glb',   size: 1.5 },
  crateSm: { file: 'box-small.glb',   size: 1.0 },
  crateLg: { file: 'box-wide.glb',    size: 2.0 },
  barrel:  { file: 'hopper-round.glb', size: 1.7 },
  tank:    { file: 'machine-fortified.glb', size: 2.6 },
  shelf:   { file: 'machine.glb',     size: 2.4 },
  piston:  { file: 'piston-round.glb', size: 2.2 },
  // Dungeon kit. Its floor tile is authored at exactly the 4 m grid pitch the dungeon map
  // uses, so normalising to size 4 is a no-op and the tiles butt up seamlessly.
  dungeonFloor: { file: 'dungeon/template-floor.glb', size: DUNGEON_TILE },
};

function loadProp(key) {
  const spec = PROP_FILES[key];
  return new Promise((resolve) => {
    gltfLoader.load(
      `assets/models/${spec.file}`,
      (gltf) => {
        const root = gltf.scene;
        // Kenney kits are authored on their own grid — normalise to the size we want and
        // re-seat the model so its origin sits on the floor at its centre.
        const box = new THREE.Box3().setFromObject(root);
        const dim = box.getSize(new THREE.Vector3());
        const biggest = Math.max(dim.x, dim.y, dim.z) || 1;
        const s = spec.size / biggest;
        root.scale.setScalar(s);
        const box2 = new THREE.Box3().setFromObject(root);
        const c = box2.getCenter(new THREE.Vector3());
        root.position.set(-c.x, -box2.min.y, -c.z);
        root.traverse((o) => {
          if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
        });
        const wrap = new THREE.Group();
        wrap.add(root);
        wrap.userData.size = new THREE.Vector3(
          box2.max.x - box2.min.x, box2.max.y - box2.min.y, box2.max.z - box2.min.z);
        propCache[key] = wrap;
        resolve(true);
      },
      undefined,
      () => resolve(false),   // missing/blocked file — the primitive fallback covers it
    );
  });
}

/** Place a prop: the GLB if it loaded, otherwise an equivalent primitive. Always collides. */
function placeProp(key, x, z, yaw = 0) {
  const spec = PROP_FILES[key];
  const cached = propCache[key];
  let hx, hy, hz;
  let isRound = false;

  if (cached) {
    const inst = cached.clone(true);
    inst.position.set(x, 0, z);
    inst.rotation.y = yaw;
    mapGroup.add(inst);
    const s = cached.userData.size;
    // Use true model half-extents; rotation is handled by the body quaternion below.
    hx = s.x / 2; hz = s.z / 2; hy = s.y / 2;
  } else {
    const sz = spec.size;
    isRound = key === 'barrel' || key === 'piston';
    const geo = isRound
      ? new THREE.CylinderGeometry(sz * 0.36, sz * 0.4, sz, 14)
      : new THREE.BoxGeometry(sz, sz * 0.92, sz);
    const mat = isRound ? MATS.metal : MATS.wall;
    const m = new THREE.Mesh(geo, mat);
    hy = (isRound ? sz : sz * 0.92) / 2;
    m.position.set(x, hy, z);
    m.rotation.y = yaw;
    m.castShadow = true; m.receiveShadow = true;
    mapGroup.add(m);
    hx = hz = isRound ? sz * 0.4 : sz / 2;
  }

  // Rotate the physics body to match the visual mesh yaw.
  const quat = yaw ? new CANNON.Quaternion().setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw) : null;
  addStaticBox(hx, hy, hz, { x, y: hy, z }, quat);

  // Nav blocker: axis-aligned bounding box of the rotated rectangle (cylindrical props are
  // symmetric so their AABB does not change with yaw).
  if (isRound || !yaw) {
    addBlocker(x, z, hx, hz);
  } else {
    const cosA = Math.abs(Math.cos(yaw));
    const sinA = Math.abs(Math.sin(yaw));
    addBlocker(x, z, hx * cosA + hz * sinA, hx * sinA + hz * cosA);
  }
}

/* ------------------------- arena assembly ------------------------- */

const A = CONFIG.ARENA, R = CONFIG.RING, GAP = CONFIG.GAP, CH = CONFIG.CEIL;

const spawnPoints = [];
const sniperPerches = [];

function buildArena() {
  /* ---- floor ---- */
  const floorGeo = new THREE.PlaneGeometry(A * 2, A * 2);
  const floor = new THREE.Mesh(floorGeo, MATS.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  mapGroup.add(floor);
  addStaticBox(A, 0.5, A, { x: 0, y: -0.5, z: 0 });

  /* ---- ceiling: enclosed warehouse, no sky leaks ---- */
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(A * 2, A * 2), MATS.ceiling);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = CH;
  ceil.layers.set(L_CEIL);              // the minimap camera must be able to see past it
  mapGroup.add(ceil);
  addStaticBox(A, 0.5, A, { x: 0, y: CH + 0.5, z: 0 });

  // Roof trusses, purely visual.
  for (let i = -4; i <= 4; i++) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(A * 2, 0.4, 0.5), MATS.metal);
    t.position.set(0, CH - 0.35, i * 11);
    t.layers.set(L_CEIL);
    t.castShadow = false;
    mapGroup.add(t);
  }

  /* ---- outer shell ---- */
  addSolid(A * 2, CH, 1.5, 0, CH / 2, -A, MATS.wall, { block: false });
  addSolid(A * 2, CH, 1.5, 0, CH / 2, A, MATS.wall, { block: false });
  addSolid(1.5, CH, A * 2, -A, CH / 2, 0, MATS.wall, { block: false });
  addSolid(1.5, CH, A * 2, A, CH / 2, 0, MATS.wall, { block: false });
  addBlocker(0, -A, A, 1.4); addBlocker(0, A, A, 1.4);
  addBlocker(-A, 0, 1.4, A); addBlocker(A, 0, 1.4, A);

  /* ---- inner ring: four walls, each split by a central doorway.
         The gap between the ring and the outer shell is a continuous corridor loop whose
         four corners are the flanking "arms". ---- */
  const RW = 6;                             // ring wall height
  const seg = (R - GAP) / 2;                // length of one half-wall
  const off = (R + GAP) / 2;                // its centre offset from the axis
  for (const s of [-1, 1]) {
    for (const o of [-off, off]) {
      addSolid(seg, RW, 1.4, o, RW / 2, s * R, MATS.wall);          // north / south
      addSolid(1.4, RW, seg, s * R, RW / 2, o, MATS.wall);          // east / west
    }
    // Doorway lintels so the openings read as gates rather than holes.
    addSolid(GAP * 2, 1.2, 1.4, 0, RW - 0.6, s * R, MATS.trim, { block: false });
    addSolid(1.4, 1.2, GAP * 2, s * R, RW - 0.6, 0, MATS.trim, { block: false });
  }

  /* ---- central hub: raised platform with four ramps ---- */
  addSolid(16, 3.2, 16, 0, 1.6, 0, MATS.metal);
  addRamp(0, 0.0, -15.5, 0, 3.2, -8.2, 5, MATS.metal);
  addRamp(0, 0.0, 15.5, 0, 3.2, 8.2, 5, MATS.metal);
  addRamp(-15.5, 0.0, 0, -8.2, 3.2, 0, 5, MATS.metal);
  addRamp(15.5, 0.0, 0, 8.2, 3.2, 0, 5, MATS.metal);
  // Chest-high cover on the hub so it is holdable but not a fortress.
  addSolid(6, 1.1, 0.6, 0, 3.75, -6.5, MATS.metal, { block: false });
  addSolid(6, 1.1, 0.6, 0, 3.75, 6.5, MATS.metal, { block: false });
  addSolid(0.6, 1.1, 6, -6.5, 3.75, 0, MATS.metal, { block: false });
  addSolid(0.6, 1.1, 6, 6.5, 3.75, 0, MATS.metal, { block: false });

  /* ---- four corner sniper perches + the catwalk ring that links them ---- */
  const P = 22, TOP = 4.6;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const px = sx * P, pz = sz * P;
      addSolid(7, TOP, 7, px, TOP / 2, pz, MATS.metal);
      // Staircase of jumpable ledges: 1.15 -> 2.3 -> 3.45 -> deck.
      addSolid(3, 1.15, 3, px - sx * 5.0, 0.575, pz - sz * 5.0, MATS.metal);
      addSolid(3, 2.30, 3, px - sx * 5.0, 1.150, pz - sz * 2.2, MATS.metal);
      addSolid(3, 3.45, 3, px - sx * 2.2, 1.725, pz - sz * 5.0, MATS.metal);
      // Waist-high railing on the outer two edges.
      addSolid(7, 1.0, 0.4, px, TOP + 0.5, pz + sz * 3.3, MATS.trim, { block: false });
      addSolid(0.4, 1.0, 7, px + sx * 3.3, TOP + 0.5, pz, MATS.trim, { block: false });
      sniperPerches.push(new THREE.Vector3(px, TOP, pz));
    }
  }
  // Catwalk ring at deck height joining all four perches — 3 m wide, walk-through cover.
  for (const s of [-1, 1]) {
    addSolid(2 * P - 7, 0.4, 3, 0, TOP - 0.2, s * P, MATS.metal, { block: false });
    addSolid(3, 0.4, 2 * P - 7, s * P, TOP - 0.2, 0, MATS.metal, { block: false });
  }

  /* ---- structural pillars from floor to ceiling ---- */
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    addPillar(sx * 13, sz * 13, 0.85, CH, MATS.metal);
    addPillar(sx * 42, sz * 42, 1.0, CH, MATS.metal);
  }

  // Low concrete walls that break the long plaza sight lines.
  addSolid(14, 1.3, 0.8, -16, 0.65, -6, MATS.floor);
  addSolid(14, 1.3, 0.8, 16, 0.65, 6, MATS.floor);
  addSolid(0.8, 1.3, 14, -6, 0.65, 16, MATS.floor);
  addSolid(0.8, 1.3, 14, 6, 0.65, -16, MATS.floor);

  buildLights();
}

/**
 * Spawn points, validated against the finished level rather than trusted.
 *
 * This runs after placeArenaProps() so the prop blockers exist — validating inside
 * buildArena() would happily approve a point that a crate later lands on. Every candidate
 * has to clear inBlocker() with a 2 m pad and have real floor under it; the floor height
 * comes from a downward ray, so a candidate on the raised hub spawns on the hub instead of
 * inside it.
 *
 * The old list put four spawns at (0,+/-44) and (+/-44,0), which face the ring wall from
 * ~10 m out, and four more in the corridor corners. Those are the "spawned facing a wall"
 * complaints. These candidates are spread across the plaza and the corridor ring.
 */
const SPAWN_CANDIDATES = [
  // plaza ring, off-axis so none of them sit on the four ramps
  [10, 10], [-10, 10], [10, -10], [-10, -10],
  [20, 20], [-20, 20], [20, -20], [-20, -20],
  [24, 0], [-24, 0], [0, 24], [0, -24],
  // corridor ring between the inner wall and the shell
  [42, 20], [-42, 20], [42, -20], [-42, -20],
  [20, 42], [-20, 42], [20, -42], [-20, -42],
  // fallbacks well inside the plaza
  [28, 10], [-28, 10], [10, 28], [-10, 28],
];

const _spFrom = new CANNON.Vec3();
const _spTo = new CANNON.Vec3();
const _spRes = new CANNON.RaycastResult();

function buildSpawnPoints() {
  let rejected = 0;
  for (const [x, z] of SPAWN_CANDIDATES) {
    if (inBlocker(x, z, 2.0)) { rejected++; continue; }        // pillar, ramp, crate, low wall
    _spFrom.set(x, CONFIG.CEIL - 0.5, z);
    _spTo.set(x, -1, z);
    _spRes.reset();
    world.raycastClosest(_spFrom, _spTo, RAY_OPTS, _spRes);
    if (!_spRes.hasHit) { rejected++; continue; }               // no floor under it at all
    spawnPoints.push(new THREE.Vector3(x, _spRes.hitPointWorld.y + 0.9, z));
  }
  // Never leave the game unable to spawn anyone.
  if (spawnPoints.length < 4) {
    for (const [x, z] of [[0, 28], [0, -28], [28, 0], [-28, 0]]) {
      spawnPoints.push(new THREE.Vector3(x, 0.9, z));
    }
  }
  return { accepted: spawnPoints.length, rejected };
}

/** Scattered cover — run once the GLBs have resolved, before the waypoint graph is laid out. */
function placeArenaProps() {
  const layout = [
    ['crateLg', -6, -20, 0], ['crate', -8.4, -20, 0.4], ['crateSm', -7, -22.3, 0],
    ['crateLg', 6, 20, 0], ['crate', 8.4, 20, 0.4], ['crateSm', 7, 22.3, 0],
    ['tank', -20, 6, Math.PI / 2], ['barrel', -22.5, 8.5, 0], ['barrel', -22.5, 3.5, 0],
    ['tank', 20, -6, -Math.PI / 2], ['barrel', 22.5, -8.5, 0], ['barrel', 22.5, -3.5, 0],
    ['shelf', -28, -28, Math.PI / 4], ['shelf', 28, 28, Math.PI / 4],
    ['piston', 0, -26, 0], ['piston', 0, 26, 0], ['piston', -26, 0, 0], ['piston', 26, 0, 0],
    // corridor loop
    ['crate', -42, -18, 0], ['crateSm', -42, -14, 0.6], ['crate', 42, 18, 0], ['crateSm', 42, 14, 0.6],
    ['barrel', -18, -42, 0], ['barrel', -14, -42, 0], ['barrel', 18, 42, 0], ['barrel', 14, 42, 0],
    ['tank', 42, -30, 0], ['tank', -42, 30, 0],
    ['crateLg', -30, 42, 0], ['crateLg', 30, -42, 0],
  ];
  for (const [key, x, z, yaw] of layout) placeProp(key, x, z, yaw);
  placeDressing();
}

/* ---------------------- environment dressing ---------------------- */

/**
 * Set dressing. None of it registers a blocker or a physics body: it is small enough to walk
 * through visually, and adding colliders here would silently invalidate spawn points and carve
 * holes in the nav graph for the sake of a soda can.
 */
const DRESS_MATS = {
  bin:      matte(0x3b4046, 0.85, 0.15),
  binLid:   matte(0x2b3036, 0.8, 0.25),
  alu:      matte(0xc0c0c0, 0.2, 0.9),
  duct:     matte(0x8b9299, 0.6, 0.55),
  cable:    matte(0x17191c, 0.9, 0.1),
  lampCase: matte(0x2a2e34, 0.7, 0.4),
  lampGlow: new THREE.MeshBasicMaterial({ color: 0xffdca8 }),
  drain:    new THREE.MeshBasicMaterial({ color: 0x0d1014 }),
};

/** Yellow/black hazard stripes, drawn once into a canvas and shared by every strip. */
const cautionTexture = (() => {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 16;
  const x = c.getContext('2d');
  x.fillStyle = '#f2c200';
  x.fillRect(0, 0, 64, 16);
  x.fillStyle = '#141414';
  // Diagonal bars. Drawn as a skewed parallelogram so the stripe reads at a glance.
  for (let i = -16; i < 64; i += 16) {
    x.beginPath();
    x.moveTo(i, 0); x.lineTo(i + 8, 0); x.lineTo(i + 8 + 16, 16); x.lineTo(i + 16, 16);
    x.closePath(); x.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
})();

function addDeco(mesh, x, y, z, yaw = 0) {
  mesh.position.set(x, y, z);
  mesh.rotation.y = yaw;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mapGroup.add(mesh);
  return mesh;
}

function addTrashCan(x, z) {
  const g = new THREE.Group();
  const can = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.18, 0.8, 12), DRESS_MATS.bin);
  can.position.y = 0.4;
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.05, 12), DRESS_MATS.binLid);
  lid.position.y = 0.82;
  g.add(can, lid);
  addDeco(g, x, 0, z, rand(0, Math.PI));
}

function addSodaCans(x, y, z, n) {
  const g = new THREE.Group();
  for (let i = 0; i < n; i++) {
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.12, 12), DRESS_MATS.alu);
    can.position.set(rand(-0.22, 0.22), 0.06, rand(-0.22, 0.22));
    can.rotation.z = Math.random() < 0.35 ? Math.PI / 2 : 0;   // a few knocked over
    if (can.rotation.z !== 0) can.position.y = 0.04;
    g.add(can);
  }
  addDeco(g, x, y, z);
}

function addDuct(x, y, z, len, horizontalAlongX) {
  const geo = horizontalAlongX
    ? new THREE.BoxGeometry(len, 0.4, 0.4)
    : new THREE.BoxGeometry(0.4, 0.4, len);
  addDeco(new THREE.Mesh(geo, DRESS_MATS.duct), x, y, z);
}

function addCautionTape(x, y, z, len, yaw) {
  const mat = new THREE.MeshBasicMaterial({
    map: cautionTexture.clone(), side: THREE.DoubleSide, transparent: false,
  });
  mat.map.needsUpdate = true;
  mat.map.repeat.set(Math.max(1, Math.round(len / 0.6)), 1);
  addDeco(new THREE.Mesh(new THREE.PlaneGeometry(len, 0.15), mat), x, y, z, yaw);
}

function addCable(x, y, z, len, yaw, sag = 0.35) {
  // A slack cable is a quadratic bezier; three's TubeGeometry renders it for almost nothing.
  const curve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(-len / 2, 0, 0),
    new THREE.Vector3(0, -sag, 0),
    new THREE.Vector3(len / 2, 0, 0),
  );
  addDeco(new THREE.Mesh(new THREE.TubeGeometry(curve, 10, 0.025, 6, false), DRESS_MATS.cable), x, y, z, yaw);
}

function addWallLamp(x, y, z, yaw) {
  const g = new THREE.Group();
  const casing = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 0.2), DRESS_MATS.lampCase);
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.3, 8), DRESS_MATS.lampGlow);
  tube.rotation.z = Math.PI / 2;
  tube.position.y = -0.08;
  g.add(casing, tube);
  addDeco(g, x, y, z, yaw);
}

function addFloorDrain(x, z) {
  const m = new THREE.Mesh(new THREE.CircleGeometry(0.45, 16), DRESS_MATS.drain);
  m.rotation.x = -Math.PI / 2;
  addDeco(m, x, 0.012, z);      // just above the floor so it does not z-fight
}

function placeDressing() {
  const R = CONFIG.RING, A = CONFIG.ARENA;

  for (const [x, z] of [[-R + 3, -12], [R - 3, 12], [-12, R - 3], [12, -R + 3],
                        [-A + 4, 24], [A - 4, -24]]) addTrashCan(x, z);

  for (const [x, y, z, n] of [[-6, 1.3, -20, 3], [6, 1.3, 20, 2], [-42, 1.3, -18, 4],
                              [42, 1.3, 18, 2], [-30, 1.3, 42, 3]]) addSodaCans(x, y, z, n);

  const ductY = CONFIG.CEIL - 1.2;
  for (const s of [-1, 1]) {
    addDuct(0, ductY, s * (R - 2), 40, true);
    addDuct(s * (R - 2), ductY, 0, 40, false);
    addDuct(0, ductY, s * (A - 3), 60, true);
  }

  for (const [x, y, z, len, yaw] of [
    [0, 1.15, -CONFIG.GAP - 0.2, 5, 0], [0, 1.15, CONFIG.GAP + 0.2, 5, 0],
    [-CONFIG.GAP - 0.2, 1.15, 0, 5, Math.PI / 2], [CONFIG.GAP + 0.2, 1.15, 0, 5, Math.PI / 2],
    [-16, 1.45, -6.2, 6, 0], [16, 1.45, 6.2, 6, 0],
  ]) addCautionTape(x, y, z, len, yaw);

  for (const s of [-1, 1]) {
    addCable(s * (A - 0.6), CONFIG.CEIL - 2.0, -20, 12, Math.PI / 2);
    addCable(s * (A - 0.6), CONFIG.CEIL - 2.4, 20, 12, Math.PI / 2);
    addCable(-20, CONFIG.CEIL - 2.2, s * (A - 0.6), 12, 0);
  }

  for (const s of [-1, 1]) {
    for (const d of [-24, 0, 24]) {
      addWallLamp(s * (A - 0.7), 4.2, d, s > 0 ? -Math.PI / 2 : Math.PI / 2);
      addWallLamp(d, 4.2, s * (A - 0.7), s > 0 ? Math.PI : 0);
    }
  }

  for (const [x, z] of [[-14, 14], [14, -14], [0, 0], [-30, -30], [30, 30]]) addFloorDrain(x, z);
}

function buildLights() {
  // Ceiling lamps: four warm quadrant lights. The bulb geometry is map-owned, the light
  // itself is only a request for one of the shared slots.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * 24, y = CH - 1.2, z = sz * 24;
    addLightEmitter({ x, y, z, color: 0xffd9a8, intensity: 420, distance: 78, priority: 1 });
    const bulb = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 2.0, 0.6, 14),
      new THREE.MeshBasicMaterial({ color: 0xffe3bb }),
    );
    bulb.position.set(x, y, z);
    bulb.layers.set(L_CEIL);
    mapGroup.add(bulb);
  }
  // Cool fill over the corridor loop so the outer ring is not a black void.
  addLightEmitter({ x: 0, y: CH - 2, z: 0, color: 0x9fc4ff, intensity: 260, distance: 110, priority: 1 });
}

/* ======================= MAP 2: DUNGEON ======================= */

/**
 * A tiled stone map built on the Kenney Modular Dungeon Kit's native grid.
 *
 * The kit measures out cleanly: every corridor piece is a 4 x 4 m footprint 4.15 m tall with
 * its origin centred on the tile and its floor on y=0, and the rooms are exact multiples
 * (room-small 12 m, room-large 20 m). So the map is authored as a character grid on a 4 m
 * pitch and each open cell gets a floor; walls go on the boundary between an open cell and a
 * closed one.
 *
 * Colliders are generated procedurally from that same grid rather than from the GLB meshes.
 * The art can then be swapped, or fail to load entirely, without any risk of the physics
 * disagreeing with what the player can see — a mesh collider built from an arbitrary GLB is
 * exactly the kind of thing that produces invisible walls.
 */
/*
 * The layout is carved rather than hand-drawn as ASCII. Every corridor here is TWO tiles
 * (8 m) wide and the halls are far bigger, because the first pass at this map used 1-tile
 * corridors and they played like a drainpipe — you could not strafe, dodge or flank, and a
 * walk test could only cover 1.4 m before hitting stone.
 *
 * '#' solid rock, '.' floor, 'S' spawn, 'A' ammo chest, 'T' torch.
 */
const DUNGEON_COLS = 23, DUNGEON_ROWS = 23;

function carveDungeon() {
  const g = Array.from({ length: DUNGEON_ROWS }, () => Array(DUNGEON_COLS).fill('#'));
  const rect = (r0, c0, r1, c1) => {
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (r > 0 && c > 0 && r < DUNGEON_ROWS - 1 && c < DUNGEON_COLS - 1) g[r][c] = '.';
      }
    }
  };

  // Outer ring corridor, 2 tiles wide, hugging the shell.
  rect(2, 2, 3, 20); rect(19, 2, 20, 20);
  rect(2, 2, 20, 3); rect(2, 19, 20, 20);

  // Central hall, 7x7 tiles (28 m) — the main fighting space.
  rect(8, 8, 14, 14);

  // Four 2-wide spokes from the ring into the hall.
  rect(3, 10, 8, 12); rect(14, 10, 20, 12);
  rect(10, 3, 12, 8); rect(10, 14, 12, 20);

  // Corner chambers, joined to the ring by short 2-wide necks.
  rect(5, 5, 7, 7);   rect(3, 5, 5, 6);   rect(5, 3, 6, 5);
  rect(5, 15, 7, 17); rect(3, 16, 5, 17); rect(5, 17, 6, 19);
  rect(15, 5, 17, 7); rect(17, 5, 19, 6); rect(15, 3, 16, 5);
  rect(15, 15, 17, 17); rect(17, 16, 19, 17); rect(15, 17, 16, 19);

  // Two pillars inside the hall so it is not a featureless box.
  g[10][10] = '#'; g[10][12] = '#'; g[12][10] = '#'; g[12][12] = '#';

  const put = (r, c, ch) => { if (g[r] && g[r][c] === '.') g[r][c] = ch; };
  // Spawns: spread around the ring and the corner chambers, never in the central hall.
  for (const [r, c] of [[2, 2], [2, 20], [20, 2], [20, 20], [2, 11], [20, 11],
                        [11, 2], [11, 20], [6, 6], [6, 16], [16, 6], [16, 16]]) put(r, c, 'S');
  // Ammo in the spokes and the hall corners — restocking means leaving cover.
  for (const [r, c] of [[6, 11], [16, 11], [11, 6], [11, 16], [9, 9], [13, 13]]) put(r, c, 'A');
  // Torches along the ring and the hall edge.
  for (const [r, c] of [[3, 6], [3, 16], [19, 6], [19, 16], [6, 3], [16, 3], [6, 19], [16, 19],
                        [8, 11], [14, 11], [11, 8], [11, 14], [2, 8], [20, 14]]) put(r, c, 'T');

  return g.map((row) => row.join(''));
}

const DUNGEON_MAP = carveDungeon();

// Shared geometry — one box, one plane, reused by every tile.
const dungeonWallGeo = new THREE.BoxGeometry(DUNGEON_TILE, DUNGEON_CEIL, DUNGEON_TILE);
const dungeonTileGeo = new THREE.PlaneGeometry(DUNGEON_TILE, DUNGEON_TILE);

/**
 * Procedural stone. The dungeon read as flat coloured boxes because it literally was flat
 * coloured boxes — no map of any kind. This draws a masonry pattern into a canvas once
 * (mortar courses, per-brick tone variation, speckle and a little wear) and derives a bump
 * map from it, which is what makes the surfaces catch the torchlight.
 *
 * Generated rather than downloaded so the map cannot end up untextured if a CDN is blocked.
 */
function makeStoneTexture({ size = 256, rows = 6, cols = 6, base = [122, 112, 96],
                            mortar = [58, 52, 44], jitter = 26, seedSpeckle = 0.16 } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const rgb = (a) => `rgb(${a[0]|0},${a[1]|0},${a[2]|0})`;

  g.fillStyle = rgb(mortar);
  g.fillRect(0, 0, size, size);

  const bw = size / cols, bh = size / rows, gap = Math.max(1.5, size * 0.008);
  for (let r = 0; r < rows; r++) {
    // Every other course is offset half a brick, the way real masonry is laid.
    const offset = (r % 2) * bw * 0.5;
    for (let i = -1; i <= cols; i++) {
      const x = i * bw + offset, y = r * bh;
      const v = (Math.random() - 0.5) * 2 * jitter;
      g.fillStyle = rgb([base[0] + v, base[1] + v, base[2] + v]);
      g.fillRect(x + gap, y + gap, bw - gap * 2, bh - gap * 2);
      // A darker corner wash so bricks are not perfectly flat.
      g.fillStyle = `rgba(0,0,0,${0.05 + Math.random() * 0.09})`;
      g.fillRect(x + gap, y + bh - gap * 3, bw - gap * 2, gap * 2);
    }
  }
  // Speckle for grain.
  const img = g.getImageData(0, 0, size, size), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (Math.random() > seedSpeckle) continue;
    const n = (Math.random() - 0.5) * 42;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = MAX_ANISO;
  return tex;
}

const STONE_WALL_TEX = makeStoneTexture({ rows: 5, cols: 5, base: [126, 116, 99] });
const STONE_FLOOR_TEX = makeStoneTexture({ rows: 4, cols: 4, base: [138, 129, 112], jitter: 20 });
const STONE_CEIL_TEX = makeStoneTexture({ rows: 3, cols: 3, base: [86, 78, 66], jitter: 14 });
for (const [t, n] of [[STONE_WALL_TEX, 1], [STONE_FLOOR_TEX, 1], [STONE_CEIL_TEX, 1]]) t.repeat.set(n, n);

const DUNGEON_MATS = {
  // Textured stone, and deliberately mid-tone rather than "realistically" black — two passes
  // of this map came back as unplayably dark.
  floor: new THREE.MeshStandardMaterial({
    map: STONE_FLOOR_TEX, bumpMap: STONE_FLOOR_TEX, bumpScale: 0.04,
    color: 0xbfb6a4, roughness: 0.95, metalness: 0.02,
  }),
  wall: new THREE.MeshStandardMaterial({
    map: STONE_WALL_TEX, bumpMap: STONE_WALL_TEX, bumpScale: 0.06,
    color: 0xb3a893, roughness: 0.92, metalness: 0.03,
  }),
  ceiling: new THREE.MeshStandardMaterial({
    map: STONE_CEIL_TEX, color: 0x8d8477, roughness: 1.0, metalness: 0.0,
  }),
  torch: new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.75, metalness: 0.55 }),
  torchWood: new THREE.MeshStandardMaterial({ color: 0x3d2a1a, roughness: 0.95, metalness: 0.0 }),
  // Three nested cones read as fire far better than one flat one: deep ember at the edge,
  // orange body, near-white core.
  flameOuter: new THREE.MeshBasicMaterial({
    color: 0xc23a08, transparent: true, opacity: 0.45, depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
  flameMid: new THREE.MeshBasicMaterial({
    color: 0xff8a1e, transparent: true, opacity: 0.8, depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
  flameCore: new THREE.MeshBasicMaterial({ color: 0xffe6a8 }),
  chain: new THREE.MeshStandardMaterial({ color: 0x51565c, roughness: 0.55, metalness: 0.85 }),
};

const dungeonTorches = [];     // flickered every frame
const dungeonChains = [];      // gently swayed

const dungeonCells = [];       // { x, z, char } for every open cell, in world coordinates

function dungeonGrid() {
  const rows = DUNGEON_MAP.length, cols = DUNGEON_MAP[0].length;
  const ox = -(cols - 1) / 2 * DUNGEON_TILE;
  const oz = -(rows - 1) / 2 * DUNGEON_TILE;
  return { rows, cols, ox, oz };
}

const dungeonAt = (r, c) => (DUNGEON_MAP[r] && DUNGEON_MAP[r][c]) || '#';
const dungeonOpen = (r, c) => dungeonAt(r, c) !== '#';

/**
 * Wall sconce: an iron bracket and cradle holding a burning log, with a layered flame.
 * The old version was a plain cone stuck on a stick. This one builds the flame from three
 * nested, differently-tinted cones (deep red at the base through to near-white at the core)
 * with a soft additive halo, which is what actually sells fire at a distance.
 */
function addTorch(x, y, z, yaw) {
  const g = new THREE.Group();

  // Wall plate and an S-curved arm out from it.
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.26, 0.05), DUNGEON_MATS.torch);
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.032, 0.34, 6), DUNGEON_MATS.torch);
  arm.rotation.x = Math.PI / 2.6;
  arm.position.set(0, 0.06, -0.13);
  // Cradle ring the log sits in.
  const cradle = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.016, 5, 10), DUNGEON_MATS.torch);
  cradle.rotation.x = Math.PI / 2;
  cradle.position.set(0, 0.20, -0.24);
  const log = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.26, 7), DUNGEON_MATS.torchWood);
  log.position.set(0, 0.16, -0.24);
  log.rotation.x = -0.12;
  g.add(plate, arm, cradle, log);

  // Flame: outer haze, mid body, bright core.
  const flame = new THREE.Group();
  const outer = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.42, 8), DUNGEON_MATS.flameOuter);
  const mid = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.30, 8), DUNGEON_MATS.flameMid);
  const core = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.18, 8), DUNGEON_MATS.flameCore);
  outer.position.y = 0.21; mid.position.y = 0.15; core.position.y = 0.09;
  flame.add(outer, mid, core);
  flame.position.set(0, 0.30, -0.24);
  g.add(flame);

  // Soft glow billboard so the sconce reads as a light source, not a lit object.
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture, color: 0xff9a3c, transparent: true, opacity: 0.5,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  halo.scale.setScalar(1.5);
  halo.position.set(0, 0.34, -0.24);
  g.add(halo);

  g.position.set(x, y, z);
  g.rotation.y = yaw;
  mapGroup.add(g);

  // The actual illumination is a request for a shared slot, positioned in world space.
  const wx = x - Math.sin(yaw) * 0.24, wz = z - Math.cos(yaw) * 0.24;
  const emitter = addLightEmitter({
    x: wx, y: y + 0.34, z: wz, color: 0xff8c2a, intensity: 34, distance: 11, priority: 0,
  });
  dungeonTorches.push({ emitter, flame, halo, base: 34, phase: rand(0, Math.PI * 2) });
}

function addHangingChain(x, z, links) {
  const g = new THREE.Group();
  for (let i = 0; i < links; i++) {
    const t = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.018, 5, 10), DUNGEON_MATS.chain);
    t.position.y = -i * 0.1;
    t.rotation.x = Math.PI / 2;
    t.rotation.y = (i % 2) * Math.PI / 2;
    g.add(t);
  }
  g.position.set(x, DUNGEON_CEIL - 0.1, z);
  mapGroup.add(g);
  dungeonChains.push({ group: g, phase: rand(0, Math.PI * 2) });
}

function updateDungeonFx(dt) {
  const t = performance.now() * 0.001;
  for (const tc of dungeonTorches) {
    // Flicker: a fast sine plus a slower one so it never reads as a clean pulse.
    const f = 1 + Math.sin(t * 8 + tc.phase) * 0.3 + Math.sin(t * 3.3 + tc.phase) * 0.12;
    tc.emitter.intensity = tc.base * f;
    // Flames stretch vertically as they gutter rather than scaling uniformly.
    tc.flame.scale.set(1 + Math.sin(t * 13 + tc.phase) * 0.09, f, 1 + Math.cos(t * 11 + tc.phase) * 0.09);
    tc.halo.material.opacity = 0.36 + f * 0.16;
  }
  for (const c of dungeonChains) {
    c.group.rotation.z = Math.sin(t * 0.8 + c.phase) * 0.06;
    c.group.rotation.x = Math.cos(t * 0.6 + c.phase) * 0.04;
  }
}

/** Instance a dungeon GLB on a tile. Silently does nothing if the kit failed to download. */
function placeDungeonPiece(key, x, z, yaw = 0) {
  const src = propCache[key];
  if (!src) return false;
  const m = src.clone(true);
  m.position.set(x, 0, z);
  m.rotation.y = yaw;
  m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  mapGroup.add(m);
  return true;
}

function buildDungeonMap() {
  const { rows, cols, ox, oz } = dungeonGrid();
  const H = DUNGEON_TILE / 2;
  dungeonCells.length = 0;
  dungeonTorches.length = 0;
  dungeonChains.length = 0;

  const torchSpots = [];
  const chestSpots = [];
  const spawnSpots = [];

  // Floor + ceiling slabs for the whole footprint, then per-cell art.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ch = dungeonAt(r, c);
      const x = ox + c * DUNGEON_TILE;
      const z = oz + r * DUNGEON_TILE;

      if (ch === '#') {
        // Rock buried behind other rock is never seen and never touched, so it gets neither
        // geometry nor a collider — only cells with an open neighbour do. On this layout that
        // is roughly a third of the wall cells, and it is the difference between a map that
        // costs 400 draw calls and one that costs 140.
        const exposed = dungeonOpen(r - 1, c) || dungeonOpen(r + 1, c)
                     || dungeonOpen(r, c - 1) || dungeonOpen(r, c + 1)
                     || dungeonOpen(r - 1, c - 1) || dungeonOpen(r - 1, c + 1)
                     || dungeonOpen(r + 1, c - 1) || dungeonOpen(r + 1, c + 1);
        addBlocker(x, z, H, H);
        if (!exposed) continue;
        const m = new THREE.Mesh(dungeonWallGeo, DUNGEON_MATS.wall);
        m.position.set(x, DUNGEON_CEIL / 2, z);
        m.castShadow = true; m.receiveShadow = true;
        mapGroup.add(m);
        addStaticBox(H, DUNGEON_CEIL / 2, H, { x, y: DUNGEON_CEIL / 2, z });
        continue;
      }

      dungeonCells.push({ x, z, char: ch });
      if (ch === 'T') torchSpots.push([r, c, x, z]);
      if (ch === 'A') chestSpots.push([x, z]);
      if (ch === 'S') spawnSpots.push([x, z]);

      // Prefer the kit's own floor tile; fall back to a plain slab.
      if (!placeDungeonPiece('dungeonFloor', x, z)) {
        const f = new THREE.Mesh(dungeonTileGeo, DUNGEON_MATS.floor);
        f.rotation.x = -Math.PI / 2;
        f.position.set(x, 0.01, z);
        f.receiveShadow = true;
        mapGroup.add(f);
      }
      // Ceiling slab, so looking up is stone rather than sky.
      const ceil = new THREE.Mesh(dungeonTileGeo, DUNGEON_MATS.ceiling);
      ceil.rotation.x = Math.PI / 2;
      ceil.position.set(x, DUNGEON_CEIL, z);
      ceil.layers.set(L_CEIL);
      mapGroup.add(ceil);
    }
  }

  // Outer shell: floor plate and a lid, so nothing can fall out of the level.
  addStaticBox(cols * DUNGEON_TILE, 0.5, rows * DUNGEON_TILE, { x: 0, y: -0.5, z: 0 });
  addStaticBox(cols * DUNGEON_TILE, 0.5, rows * DUNGEON_TILE,
    { x: 0, y: DUNGEON_CEIL + 0.5, z: 0 });

  // Torch sconces face into the corridor from an adjacent wall.
  for (const [r, c, x, z] of torchSpots) {
    const dirs = [[0, -1, 0], [0, 1, Math.PI], [-1, 0, Math.PI / 2], [1, 0, -Math.PI / 2]];
    for (const [dc, dr, yaw] of dirs) {
      if (!dungeonOpen(r + dr, c + dc)) {
        addTorch(x + dc * (H - 0.25), 2.3, z + dr * (H - 0.25), yaw);
        break;
      }
    }
  }

  for (const { x, z, char } of dungeonCells) {
    if (char === '.' && Math.random() < 0.06) addHangingChain(x, z, 5 + randInt(0, 3));
  }

  // Props from the factory kit dress the rooms; they already have procedural fallbacks.
  let dressed = 0;
  for (const { x, z, char } of dungeonCells) {
    if (char !== '.' || dressed > 14 || Math.random() > 0.12) continue;
    placeProp(pick(['barrel', 'crate', 'crateSm']), x + rand(-0.8, 0.8), z + rand(-0.8, 0.8), rand(0, Math.PI));
    dressed++;
  }


  // Spawns and chests come from the authored cells, still validated the usual way.
  for (const [x, z] of spawnSpots) {
    if (inBlocker(x, z, 0.8)) continue;
    spawnPoints.push(new THREE.Vector3(x, 0.9, z));
  }
  if (spawnPoints.length < 4) {
    for (const { x, z, char } of dungeonCells) {
      if (spawnPoints.length >= 8) break;
      if (char === '.' && !inBlocker(x, z, 0.8)) spawnPoints.push(new THREE.Vector3(x, 0.9, z));
    }
  }
  spawnAmmoChests(chestSpots, 6);

  // Health and shield go in the corner chambers, deliberately off the ammo route.
  const T = DUNGEON_TILE, gx = (c) => (c - (DUNGEON_COLS - 1) / 2) * T, gz = (r) => (r - (DUNGEON_ROWS - 1) / 2) * T;
  spawnConsumables([
    ['health', gx(6), gz(6)], ['health', gx(16), gz(16)],
    ['health', gx(11), gz(2)], ['health', gx(11), gz(20)],
    ['shield', gx(16), gz(6)], ['shield', gx(6), gz(16)],
    ['shield', gx(2), gz(11)], ['shield', gx(20), gz(11)],
  ]);
}

/* --------------------- bot navigation waypoints --------------------- */
/**
 * The waypoint graph. Nodes sit on the floor plane only: bots never take the perches or the
 * catwalks, which is a deliberate design line — verticality is the human's edge, and it keeps
 * the AI off a class of pathing bugs. Bots still aim and throw grenades in full 3D, so a
 * camped perch is contested, not safe.
 */
const waypoints = [];       // { pos: Vector3, links: number[], cover: boolean }
const _rayFrom   = new CANNON.Vec3();
const _rayTo     = new CANNON.Vec3();
const _rayResult = new CANNON.RaycastResult();

function losClear(ax, ay, az, bx, by, bz) {
  _rayFrom.set(ax, ay, az);
  _rayTo.set(bx, by, bz);
  _rayResult.reset();
  world.raycastClosest(_rayFrom, _rayTo, RAY_OPTS, _rayResult);
  return !_rayResult.hasHit;
}

function buildWaypoints({ extent = 46, step = 8.5, pad = 1.1, coverPad = 3.6 } = {}) {
  for (let x = -extent; x <= extent; x += step) {
    for (let z = -extent; z <= extent; z += step) {
      if (inBlocker(x, z, pad)) continue;
      waypoints.push({
        pos: new THREE.Vector3(x, 0.9, z),
        links: [],
        cover: inBlocker(x, z, coverPad),     // hugging a solid = usable as a cover spot
      });
    }
  }
  // Connect each node to its three nearest neighbours, but only where the walk is actually
  // clear. Edges are added symmetrically so BFS can traverse either way.
  const N = 3;
  for (let i = 0; i < waypoints.length; i++) {
    const a = waypoints[i];
    const cands = [];
    for (let j = 0; j < waypoints.length; j++) {
      if (i === j) continue;
      const d = a.pos.distanceToSquared(waypoints[j].pos);
      if (d < step * step * 4.2) cands.push({ j, d });
    }
    cands.sort((p, q) => p.d - q.d);
    let added = 0;
    for (const c of cands) {
      if (added >= N) break;
      const b = waypoints[c.j];
      if (a.links.includes(c.j)) { added++; continue; }
      if (!losClear(a.pos.x, 1.0, a.pos.z, b.pos.x, 1.0, b.pos.z)) continue;
      a.links.push(c.j);
      if (!b.links.includes(i)) b.links.push(i);
      added++;
    }
  }
}

/**
 * Flat top-down floor plan for the minimap: one unlit plate per solid footprint, plus a
 * ground plate. Built from `blockers`, so the map always matches what actually blocks
 * movement. Materials opt out of fog — otherwise distance haze would grey the whole plan.
 */
const MAP_PLATE_GEO = new THREE.PlaneGeometry(1, 1);

function buildMapLayer(extent = A, plates = { ground: 0x141a21, solid: 0x5c6b7a }) {
  const g = new THREE.Group();

  const ground = new THREE.Mesh(MAP_PLATE_GEO,
    new THREE.MeshBasicMaterial({ color: plates.ground, fog: false }));
  ground.scale.set(extent * 2, extent * 2, 1);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0.02;
  g.add(ground);

  const solidMat = new THREE.MeshBasicMaterial({ color: plates.solid, fog: false });
  for (const b of blockers) {
    const m = new THREE.Mesh(MAP_PLATE_GEO, solidMat);
    m.scale.set(b.hx * 2, b.hz * 2, 1);
    m.rotation.x = -Math.PI / 2;
    m.position.set(b.x, 0.06, b.z);
    g.add(m);
  }

  g.traverse((o) => o.layers.set(L_MAP));
  scene.add(g);
  mapLayerGroup = g;
}

/* ======================= map lifecycle ======================= */

/**
 * Anything a map adds straight to the scene (lights, the minimap plate layer) is tracked so a
 * map switch can take it back out again. mapGroup holds the geometry, mapBodies the colliders;
 * these two arrays cover the rest.
 */
const mapLights = [];
let mapLayerGroup = null;

function addMapLight(obj) {
  mapLights.push(obj);
  scene.add(obj);
  return obj;
}

/**
 * Geometry that outlives any single map. The dungeon reuses one box and one plane across
 * hundreds of tiles, so these must survive clearMap() or the second visit to a map renders
 * nothing. Anything not in here is per-mesh and safe to free.
 */
markShared(dungeonWallGeo, dungeonTileGeo, MAP_PLATE_GEO);

/** Tear the current level down completely: colliders, meshes, lights, nav data, pickups. */
function clearMap() {
  for (const b of mapBodies) world.removeBody(b);
  mapBodies.length = 0;

  disposeTree(mapGroup);
  mapGroup.clear();

  for (const l of mapLights) scene.remove(l);
  mapLights.length = 0;

  // Every emitter belongs to the map that registered it; blast leases are transient and are
  // released by updateExplosionFx. Clearing the array is what keeps the slot pool honest.
  lightEmitters.length = 0;
  for (const l of lightSlots) l.intensity = 0;
  dungeonTorches.length = 0;
  dungeonChains.length = 0;

  if (mapLayerGroup) {
    scene.remove(mapLayerGroup);
    disposeTree(mapLayerGroup);
    mapLayerGroup = null;
  }

  clearMapItems();

  blockers.length = 0;
  spawnPoints.length = 0;
  sniperPerches.length = 0;
  waypoints.length = 0;
}

function nearestWaypoint(pos, skip = -1) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < waypoints.length; i++) {
    if (i === skip) continue;
    const d = waypoints[i].pos.distanceToSquared(pos);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/** Breadth-first search across the waypoint graph. Returns an array of Vector3, or null. */
function findPath(fromPos, toPos) {
  const s = nearestWaypoint(fromPos);
  const g = nearestWaypoint(toPos);
  if (s < 0 || g < 0) return null;
  if (s === g) return [waypoints[g].pos];

  const prev = new Int32Array(waypoints.length).fill(-1);
  const seen = new Uint8Array(waypoints.length);
  const queue = [s];
  seen[s] = 1;
  let head = 0, found = false;
  while (head < queue.length) {
    const cur = queue[head++];
    if (cur === g) { found = true; break; }
    for (const nx of waypoints[cur].links) {
      if (seen[nx]) continue;
      seen[nx] = 1; prev[nx] = cur; queue.push(nx);
    }
  }
  if (!found) return null;
  const out = [];
  for (let n = g; n !== -1; n = prev[n]) out.push(waypoints[n].pos);
  out.reverse();
  return out;
}

return {
  arenaExtent: A,
  PROP_FILES,
  loadProp,
  mapGroup,
  blockers,
  inBlocker,
  spawnPoints,
  sniperPerches,
  updateDungeonFx,
  waypoints,
  mapLights,
  clearMap,
  losClear,
  nearestWaypoint,
  findPath,
  buildArena,
  placeArenaProps,
  buildSpawnPoints,
  buildDungeonMap,
  buildWaypoints,
  buildMapLayer,
};
}
/** Map selection, shared lighting configuration, and level lifecycle. */
export function createMapController({
  scene,
  mapCamera,
  rigAmbient,
  rigHemi,
  rigSun,
  arenaExtent: A,
  buildArena,
  placeArenaProps,
  buildSpawnPoints,
  buildDungeonMap,
  buildWaypoints,
  buildMapLayer,
  clearMap,
  spawnAmmoChests,
  spawnConsumables,
  setSpawnCastY,
}) {
  /**
   * The two playable levels. Each entry owns everything that differs between them: how the
   * geometry is built, the sky/fog treatment, and the nav-graph and minimap tuning (the dungeon
   * is a 4 m corridor grid, so it needs a much finer graph than the open warehouse).
   */
  const MAPS = {
    warehouse: {
      name: 'WAREHOUSE',
      blurb: 'Open industrial plaza, long sight lines, four ramps to the hub.',
      background: 0x0a0e14,
      fog: { color: 0x0a0e14, near: 55, far: 190 },
      mapView: 46,
      ceilY: CONFIG.CEIL,
      nav: { extent: 46, step: 8.5, pad: 1.1, coverPad: 3.6 },
      layerExtent: A,
      plates: { ground: 0x141a21, solid: 0x5c6b7a },
      lighting: {
        ambient: { color: 0x8ea6c0, intensity: 0.4 },
        hemi: { sky: 0x7f9bb8, ground: 0x232830, intensity: 0.75 },
        sun: { color: 0xfff1dc, intensity: 1.7, pos: [38, 62, 26], extent: A * 1.05, far: 170 },
      },
      build() {
        buildArena();
        placeArenaProps();
        buildSpawnPoints();
        spawnAmmoChests([
          [0, 38], [0, -38], [38, 0], [-38, 0],
          [22, 22], [-22, -22], [22, -22], [-22, 22],
          [12, 12], [-12, -12], [12, -12], [-12, 12],
          [30, 12], [-30, 12], [12, 30], [-12, 30],
        ]);
        // Health and shield sit away from the ammo, so topping up costs a separate trip.
        spawnConsumables([
          ['health', 0, 20], ['health', 0, -20], ['health', -34, -34], ['health', 34, 34],
          ['shield', 20, 0], ['shield', -20, 0], ['shield', 34, -34], ['shield', -34, 34],
        ]);
      },
    },
    dungeon: {
      name: 'DUNGEON',
      blurb: 'Tight stone corridors, torchlight, choke points everywhere.',
      background: 0x1a1410,
      fog: { color: 0x140d07, near: 8, far: 60 },
      mapView: 44,
      ceilY: DUNGEON_CEIL,
      nav: { extent: 40, step: DUNGEON_TILE, pad: 0.9, coverPad: 2.6 },
      layerExtent: 44,
      // High-contrast plan: on the warehouse palette the dungeon minimap was near-black on
      // near-black and unreadable.
      plates: { ground: 0x120d08, solid: 0xb08a52 },
      lighting: {
        // Deliberately much brighter than a "realistic" dungeon. Two passes of this map were
        // reported as unplayably black; atmosphere is worth nothing if you cannot see a target.
        ambient: { color: 0x9c8a72, intensity: 1.15 },
        hemi: { sky: 0xa08d70, ground: 0x3a2c20, intensity: 0.95 },
        sun: { color: 0xffd9ad, intensity: 0.95, pos: [20, 50, 14], extent: 46, far: 130 },
      },
      build() { buildDungeonMap(); },
    },
  };

  let currentMapId = 'warehouse';

  /** Build a level from scratch. Assumes clearMap() has already run if one was loaded. */
  function buildMap(id) {
    const m = MAPS[id];
    currentMapId = id;
    // Must be set before m.build() runs — the spawners below it cast down from here.
    setSpawnCastY((m.ceilY ?? CONFIG.CEIL) - 0.5);

    scene.background = new THREE.Color(m.background);
    scene.fog = new THREE.Fog(m.fog.color, m.fog.near, m.fog.far);

    mapCamera.left = -m.mapView / 2; mapCamera.right = m.mapView / 2;
    mapCamera.top = m.mapView / 2; mapCamera.bottom = -m.mapView / 2;
    mapCamera.updateProjectionMatrix();

    // Re-tint the shared rig rather than swapping lights in and out — see MAX_POINT_LIGHTS.
    const L = m.lighting;
    rigAmbient.color.setHex(L.ambient.color);
    rigAmbient.intensity = L.ambient.intensity;
    rigHemi.color.setHex(L.hemi.sky);
    rigHemi.groundColor.setHex(L.hemi.ground);
    rigHemi.intensity = L.hemi.intensity;
    rigSun.color.setHex(L.sun.color);
    rigSun.intensity = L.sun.intensity;
    rigSun.position.set(...L.sun.pos);
    rigSun.shadow.camera.far = L.sun.far;
    rigSun.shadow.camera.left = -L.sun.extent; rigSun.shadow.camera.right = L.sun.extent;
    rigSun.shadow.camera.top = L.sun.extent; rigSun.shadow.camera.bottom = -L.sun.extent;
    rigSun.shadow.camera.updateProjectionMatrix();

    m.build();
    buildWaypoints(m.nav);
    buildMapLayer(m.layerExtent, m.plates);
  }

  /** Swap levels. No-op when the requested map is already loaded. */
  function switchMap(id) {
    if (id === currentMapId || !MAPS[id]) return;
    clearMap();
    buildMap(id);
  }

  return {
    MAPS,
    buildMap,
    switchMap,
    currentMapId: () => currentMapId,
  };
}
