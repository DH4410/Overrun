import * as THREE from 'three';
import * as CANNON from 'cannon-es';

import {
  RAY_OPTS,
  addStaticBox,
  addStaticCylinder,
  mapBodies,
  world,
} from './physics.js';
import { createGlbMap, skyEnvironment } from './mapGlb.js';
import { addRampCollider as sharedRampCollider, inBlockers, validSpawnPoints } from './sim/colliders.js';
import { DESERT } from './mapDesert.js';
import { PORT } from './mapPort.js';
import { SNOW } from './mapSnow.js';
import { disposeTree, markShared } from './rendering.js';
import { settings } from './settings.js';

/** Blender map loading, navigation, the minimap plan, and teardown runtime. */
export function createMapRuntime({
  scene,
  maxAnisotropy: MAX_ANISO,
  mapLayer: L_MAP,
  addLightEmitter,
  lightEmitters,
  lightSlots,
  spawnAmmoChests,
  spawnConsumables,
  clearMapItems,
}) {
/** The Blender maps, in menu order. The first one that loads is the map the game opens on. */
const GLB_MAPS = [PORT, DESERT, SNOW];

// 2k maps on the QUALITY preset only: four times the texels, and on a laptop four times the
// memory traffic, for detail you only see with your nose against a wall. Read once at boot.
const PH_RES = settings.quality === 'high' ? '2k' : '1k';
const PH = `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/${PH_RES}`;
const texLoader = new THREE.TextureLoader();
texLoader.setCrossOrigin('anonymous');

/**
 * A PBR material that is usable the instant it is created and upgrades itself as the
 * Poly Haven maps arrive. It starts as a flat `fallback` colour; when the albedo lands the
 * colour is neutralised so the texture shows through. If the network or CORS kills the
 * request the material simply stays the flat colour — the arena is never left untextured.
 *
 * The ARM map feeds roughnessMap and metalnessMap, and with `ao` the aoMap too (three reads
 * AO from red, roughness from green, metalness from blue: exactly Poly Haven's ARM packing).
 * AO is opt-in because it only helps where the UVs are world-scaled, as in the Blender maps.
 *
 * `detail` keeps `fallback` as the surface colour and uses the albedo only for its luminance,
 * normalised to average 1: scratches and grime without the photo's own paint colour. It is how
 * one rusty-metal photo paints ten differently coloured containers (tinted by vertex colour).
 */
function pbrMat(slug, { repeat = 4, fallback = 0x8a8a8a, rough = 0.9, metal = 0.0, detail = false, ao = false, extra = {} } = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color: fallback, roughness: rough, metalness: metal, ...extra,
  });
  if (detail) {
    const gain = { value: 1 };
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.detailGain = gain;
      shader.fragmentShader = `uniform float detailGain;\n${shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
          vec4 sampledDiffuseColor = texture2D( map, vMapUv );
          diffuseColor.rgb *= clamp( dot( sampledDiffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) * detailGain, 0.0, 1.5 );
        #endif`,
      )}`;
    };
    mat.customProgramCacheKey = () => 'pbr-detail';
    mat.userData.detailGain = gain;
  }
  const base = `${PH}/${slug}/${slug}`;
  texLoader.load(
    `${base}_diff_${PH_RES}.jpg`,
    (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeat, repeat);
      t.anisotropy = MAX_ANISO;
      t.colorSpace = THREE.SRGBColorSpace;
      mat.map = t;
      if (detail) mat.userData.detailGain.value = 1 / Math.max(0.05, meanLuminance(t.image));
      else mat.color.setHex(0xffffff);
      mat.needsUpdate = true;
    },
    undefined,
    () => { mat.color.setHex(fallback); },
  );
  texLoader.load(
    `${base}_nor_gl_${PH_RES}.jpg`,
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
    `${base}_arm_${PH_RES}.jpg`,
    (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeat, repeat);
      t.anisotropy = MAX_ANISO;
      mat.roughnessMap = t;
      mat.metalnessMap = t;
      if (ao) mat.aoMap = t;
      mat.metalness = Math.max(metal, 0.35);   // metalnessMap multiplies, so give it headroom
      mat.needsUpdate = true;
    },
    undefined, () => {},
  );
  return mat;
}

/** Average linear luminance of an image, read from a 32 px downsample; 0.5 if unreadable. */
function meanLuminance(img) {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, 32, 32);
    const px = g.getImageData(0, 0, 32, 32).data;
    const lin = (v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += 0.2126 * lin(px[i]) + 0.7152 * lin(px[i + 1]) + 0.0722 * lin(px[i + 2]);
    return sum / (px.length / 4);
  } catch {
    return 0.5;
  }
}

/** Ground-plane footprints that block walking — used to lay out the bot waypoint graph. */
const blockers = [];
function addBlocker(cx, cz, hx, hz) { blockers.push({ x: cx, z: cz, hx, hz }); }
function inBlocker(x, z, pad = 0) { return inBlockers(blockers, x, z, pad); }

const mapGroup = new THREE.Group();
scene.add(mapGroup);

function addRampCollider(x0, y0, z0, x1, y1, z1, width) {
  sharedRampCollider(x0, y0, z0, x1, y1, z1, width, { addStaticBox, addBlocker });
}

const spawnPoints = [];

/** Spawn points from a map's candidates, validated against the built level (sim/colliders.js). */
function buildSpawnPoints(candidates, fallback, castY) {
  const { points, rejected } = validSpawnPoints(world, blockers, candidates, fallback, castY);
  for (const p of points) spawnPoints.push(new THREE.Vector3(p.x, p.y, p.z));
  return { accepted: spawnPoints.length, rejected };
}

/* --------------------------- bot navigation --------------------------- */
/**
 * The navigation graph: nodes laid on every walkable SURFACE of the level, joined wherever a
 * bot's body can actually walk from one to the next.
 *
 * It replaces a flat grid at a fixed 0.9 m that was linked by single zero-width rays, which is
 * where "bots keep running into a wall" came from, several ways over:
 *  - A node could sit INSIDE a solid that was not flagged as a blocker (Foundry's raised mid
 *    platform), and bots dutifully pressed their faces into its side trying to reach it.
 *  - A zero-width ray fits through gaps a 0.72 m body does not, so edges and straightened
 *    paths clipped every corner and bots wedged themselves on it.
 *  - Paths were straightened with rays at the node height PLUS 0.9 m, about 1.7 m up, which
 *    clears every low wall and crate in the game — so straightened routes ran straight into
 *    them.
 *  - The start of every path was the nearest node by distance, even when it was on the far
 *    side of a wall.
 *
 * Nodes now come from rays cast down through the level, so a raised platform or a ramp gets
 * nodes on its surface and nothing gets nodes inside a solid. An edge exists only if the floor
 * is continuous under it (no step taller than NAV_STEP — bots cannot jump) and a body-wide
 * sweep at knee, chest and head height is clear. Straightening uses the same test.
 */
const waypoints = [];       // { pos: Vector3, floor: number, links: number[], cover: boolean }
const _rayFrom   = new CANNON.Vec3();
const _rayTo     = new CANNON.Vec3();
const _rayResult = new CANNON.RaycastResult();

const NAV_RADIUS = 0.42;     // bot body half-width (0.36 spheres) plus a little margin
const NAV_STEP = 0.3;        // tallest rise between floor samples a bot can walk up
const NAV_HEADROOM = 2.1;    // bots stand 2.0 m tall
const NAV_Y = 0.9;           // node height above its own floor
const NAV_SWEEP_Y = [0.4, 1.2, 1.9];

function losClear(ax, ay, az, bx, by, bz) {
  _rayFrom.set(ax, ay, az);
  _rayTo.set(bx, by, bz);
  _rayResult.reset();
  world.raycastClosest(_rayFrom, _rayTo, RAY_OPTS, _rayResult);
  return !_rayResult.hasHit;
}

/** Height of the first walkable surface below (x, y, z) within `depth`, or null. */
function floorBelow(x, y, z, depth) {
  _rayFrom.set(x, y, z);
  _rayTo.set(x, y - depth, z);
  _rayResult.reset();
  world.raycastClosest(_rayFrom, _rayTo, RAY_OPTS, _rayResult);
  if (!_rayResult.hasHit || _rayResult.hitNormalWorld.y < 0.6) return null;
  return _rayResult.hitPointWorld.y;
}

const _local = new CANNON.Vec3();
const _world = new CANNON.Vec3();

/**
 * True if the point is inside any level collider. Rays cannot answer this: they skip back
 * faces, so a ray that starts inside a wall sees nothing at all.
 */
function inSolid(x, y, z) {
  _world.set(x, y, z);
  for (const body of mapBodies) {
    body.pointToLocalFrame(_world, _local);
    for (const shape of body.shapes) {
      if (shape.halfExtents) {
        const h = shape.halfExtents;
        if (Math.abs(_local.x) < h.x && Math.abs(_local.y) < h.y && Math.abs(_local.z) < h.z) return true;
      } else if (shape.radiusTop !== undefined) {
        if (Math.abs(_local.y) < shape.height / 2
            && _local.x * _local.x + _local.z * _local.z < shape.radiusTop * shape.radiusTop) return true;
      }
    }
  }
  return false;
}

/** A body-wide sweep from one floor point to another, at knee, chest and head height. */
function sweepClear(ax, af, az, bx, bf, bz) {
  const dx = bx - ax, dz = bz - az;
  const d = Math.hypot(dx, dz) || 1;
  const px = (-dz / d) * NAV_RADIUS, pz = (dx / d) * NAV_RADIUS;
  for (const y of NAV_SWEEP_Y) {
    if (!losClear(ax, af + y, az, bx, bf + y, bz)) return false;
    if (y > 1.5) continue;                     // the head is narrow: centre ray only
    if (!losClear(ax + px, af + y, az + pz, bx + px, bf + y, bz + pz)) return false;
    if (!losClear(ax - px, af + y, az - pz, bx - px, bf + y, bz - pz)) return false;
  }
  return true;
}

/**
 * Can a bot walk in a straight line from floor point A to floor point B? The floor must be
 * continuous underneath (sampled every `spacing` m) and the body sweep clear. Flat stretches
 * are swept once; wherever the floor changes height each piece is swept on its own slope.
 */
function walkable(ax, af, az, bx, bf, bz, spacing = 0.45) {
  const dx = bx - ax, dz = bz - az;
  const d = Math.hypot(dx, dz);
  if (d < 1e-3) return Math.abs(bf - af) <= NAV_STEP;
  // The cheap test first: most candidate lines fail on a wall, not on the floor.
  if (Math.abs(bf - af) < 0.02 && !sweepClear(ax, af, az, bx, bf, bz)) return false;
  const n = Math.max(1, Math.ceil(d / spacing));
  let prev = af, runStart = 0, runX = ax, runZ = az, runF = af;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const x = ax + dx * t, z = az + dz * t;
    const h = floorBelow(x, prev + NAV_STEP + 0.05, z, NAV_STEP * 2 + 0.6);
    if (h === null || Math.abs(h - prev) > NAV_STEP) return false;
    // Close the current run of constant height when the floor changes, and sweep it.
    if (Math.abs(h - runF) > 0.02 || i === n) {
      const px = ax + dx * ((i - 1) / n), pz = az + dz * ((i - 1) / n);
      if (i - 1 > runStart && !sweepClear(runX, runF, runZ, px, prev, pz)) return false;
      if (!sweepClear(px, prev, pz, x, h, z)) return false;
      runStart = i; runX = x; runZ = z; runF = h;
    }
    prev = h;
  }
  return Math.abs(prev - bf) <= NAV_STEP;
}

/** Every walkable surface in a column, top down, that a standing bot fits on. */
function surfacesAt(x, z, topY) {
  const out = [];
  let y = topY;
  for (let k = 0; k < 5 && y > -1; k++) {
    const h = floorBelow(x, y, z, y + 2);
    if (h === null) break;
    if (!inSolid(x, h + 0.5, z) && !inSolid(x, h + 1.2, z) && !inSolid(x, h + 1.9, z)
        && losClear(x, h + 0.1, z, x, h + NAV_HEADROOM, z)) out.push(h);
    y = h - 0.05;           // continue below this surface: its underside is a back face
  }
  return out;
}

const NAV_DIRS = [[1, 0], [0.707, 0.707], [0, 1], [-0.707, 0.707], [-1, 0], [-0.707, -0.707], [0, -1], [0.707, -0.707]];

/** Room for a body here: nothing within NAV_RADIUS at knee or chest height. */
function nodeFits(x, f, z) {
  for (const [ux, uz] of NAV_DIRS) {
    for (const y of [0.4, 1.2]) {
      if (!losClear(x, f + y, z, x + ux * (NAV_RADIUS + 0.08), f + y, z + uz * (NAV_RADIUS + 0.08))) return false;
    }
  }
  return true;
}

function buildWaypoints({ extent = 46, step = 4, coverPad = 3.0, ceilY }) {
  const cells = new Map();                     // "ix,iz" -> node indices in that column
  const topY = ceilY - 0.3;
  const cellsPerSide = Math.floor(extent / step);
  for (let ix = -cellsPerSide; ix <= cellsPerSide; ix++) {
    for (let iz = -cellsPerSide; iz <= cellsPerSide; iz++) {
      const x = ix * step, z = iz * step;
      for (const f of surfacesAt(x, z, topY)) {
        if (!nodeFits(x, f, z)) continue;
        const list = cells.get(`${ix},${iz}`) ?? [];
        list.push(waypoints.length);
        cells.set(`${ix},${iz}`, list);
        waypoints.push({ pos: new THREE.Vector3(x, f + NAV_Y, z), floor: f, links: [], cover: false, ix, iz });
      }
    }
  }

  // Link each node to the walkable nodes in its eight neighbouring columns. Only the forward
  // half of the neighbourhood is tested, and each edge is added both ways.
  const FORWARD = [[1, 0], [1, 1], [0, 1], [-1, 1]];
  for (let i = 0; i < waypoints.length; i++) {
    const a = waypoints[i];
    for (const [ox, oz] of FORWARD) {
      for (const j of cells.get(`${a.ix + ox},${a.iz + oz}`) ?? []) {
        const b = waypoints[j];
        if (Math.abs(b.floor - a.floor) > step * Math.hypot(ox, oz) * 0.7 + NAV_STEP) continue;
        if (!walkable(a.pos.x, a.floor, a.pos.z, b.pos.x, b.floor, b.pos.z)) continue;
        a.links.push(j);
        b.links.push(i);
      }
    }
  }

  // Keep only the largest connected piece. Crate tops, wall tops and anything reachable only
  // by jumping form islands a bot could be sent to and never reach.
  const comp = new Int32Array(waypoints.length).fill(-1);
  let best = -1, bestSize = 0;
  for (let i = 0, c = 0; i < waypoints.length; i++) {
    if (comp[i] >= 0) continue;
    const stack = [i];
    comp[i] = c;
    let size = 0;
    while (stack.length) {
      const k = stack.pop();
      size++;
      for (const nx of waypoints[k].links) if (comp[nx] < 0) { comp[nx] = c; stack.push(nx); }
    }
    if (size > bestSize) { bestSize = size; best = c; }
    c++;
  }
  const remap = new Int32Array(waypoints.length).fill(-1);
  const kept = [];
  waypoints.forEach((w, i) => { if (comp[i] === best) { remap[i] = kept.length; kept.push(w); } });
  for (const w of kept) w.links = w.links.map((j) => remap[j]).filter((j) => j >= 0);
  waypoints.length = 0;
  waypoints.push(...kept);

  // Cover: a node with something chest-high close by on at least one side.
  for (const w of waypoints) {
    w.cover = NAV_DIRS.some(([ux, uz]) => !losClear(w.pos.x, w.floor + 1.0, w.pos.z,
      w.pos.x + ux * coverPad, w.floor + 1.0, w.pos.z + uz * coverPad));
  }
}

/**
 * Flat top-down floor plan for the minimap: one unlit plate per solid footprint, plus a
 * ground plate. Built from `blockers`, so the map always matches what actually blocks
 * movement. Materials opt out of fog — otherwise distance haze would grey the whole plan.
 */
const MAP_PLATE_GEO = new THREE.PlaneGeometry(1, 1);

function buildMapLayer(extent, plates = { ground: 0x141a21, solid: 0x5c6b7a }) {
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
 * Geometry that outlives any single map. Every minimap plate is this one plane, scaled, so it
 * must survive clearMap() or the second map's plan renders nothing. Anything not in here is
 * per-mesh and safe to free.
 */
markShared(MAP_PLATE_GEO);

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

  if (mapLayerGroup) {
    scene.remove(mapLayerGroup);
    disposeTree(mapLayerGroup);
    mapLayerGroup = null;
  }

  clearMapItems();

  blockers.length = 0;
  spawnPoints.length = 0;
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

/** The floor under a position, or a guess from its height if there is none within reach. */
function floorUnder(pos) {
  return floorBelow(pos.x, pos.y + 0.3, pos.z, 4) ?? pos.y - 0.9;
}

/**
 * The closest node that can actually be walked to from `pos`, trying the nearest few by
 * distance. Falls back to the plain nearest node, so a bot is never left with no path.
 */
function nearestReachable(pos) {
  const f = floorUnder(pos);
  const cands = [];
  for (let i = 0; i < waypoints.length; i++) {
    const w = waypoints[i];
    const dx = w.pos.x - pos.x, dz = w.pos.z - pos.z;
    cands.push({ i, d: dx * dx + dz * dz + 9 * (w.floor - f) * (w.floor - f) });
  }
  cands.sort((a, b) => a.d - b.d);
  for (let k = 0; k < Math.min(6, cands.length); k++) {
    const w = waypoints[cands[k].i];
    if (walkable(pos.x, f, pos.z, w.pos.x, w.floor, w.pos.z, 0.6)) return cands[k].i;
  }
  return cands.length ? cands[0].i : -1;
}

/**
 * A* over the graph, by walked distance. Returns an array of Vector3, or null.
 *
 * The path runs to the destination itself, not just to the node nearest it, whenever the last
 * stretch is walkable — nodes are up to 2.8 m from any given point, and stopping short of a
 * pickup or a remembered position by that much looks like a bot losing interest. And when the
 * destination is in plain walking reach, the graph is skipped and the bot simply goes there.
 */
function findPath(fromPos, toPos) {
  if (!waypoints.length) return null;
  const fromFloor = floorUnder(fromPos);
  const toFloor = floorUnder(toPos);
  const dest = new THREE.Vector3(toPos.x, toFloor + NAV_Y, toPos.z);
  if (walkable(fromPos.x, fromFloor, fromPos.z, dest.x, toFloor, dest.z, 0.6)) return [dest];
  const s = nearestReachable(fromPos);
  const g = nearestReachable(toPos);
  if (s < 0 || g < 0) return null;
  const finish = (path) => {
    const last = waypoints[g];
    if (walkable(last.pos.x, last.floor, last.pos.z, dest.x, toFloor, dest.z, 0.6)) path.push(dest);
    return path;
  };
  if (s === g) return finish([waypoints[g].pos]);

  const N = waypoints.length;
  const cost = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const goal = waypoints[g].pos;
  // Binary heap of [estimate, node].
  const heap = [];
  const push = (f, n) => {
    heap.push([f, n]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top[1];
  };

  cost[s] = 0;
  push(waypoints[s].pos.distanceTo(goal), s);
  while (heap.length) {
    const cur = pop();
    if (cur === g) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cp = waypoints[cur].pos;
    for (const nx of waypoints[cur].links) {
      if (closed[nx]) continue;
      const c = cost[cur] + cp.distanceTo(waypoints[nx].pos);
      if (c < cost[nx]) {
        cost[nx] = c;
        prev[nx] = cur;
        push(c + waypoints[nx].pos.distanceTo(goal), nx);
      }
    }
  }
  if (prev[g] < 0) return null;
  const nodes = [];
  for (let n = g; n !== -1; n = prev[n]) nodes.push(n);
  nodes.reverse();
  return finish(stringPull(fromPos, nodes));
}

/**
 * Straighten a node path by dropping nodes the bot can walk straight past.
 *
 * A grid route zig-zags from node to node. From the current anchor this advances while the
 * straight line is still walkable — the same body-wide test the graph edges passed, not a thin
 * sight ray — and keeps a node only where that breaks. Run once per repath, never per frame.
 */
function stringPull(fromPos, nodes) {
  const pts = nodes.map((n) => waypoints[n].pos);
  if (nodes.length < 2) return pts;
  const out = [];
  let ax = fromPos.x, az = fromPos.z, af = floorUnder(fromPos);
  let i = -1;
  while (i < nodes.length - 1) {
    let far = i + 1;
    for (let j = i + 2; j < nodes.length; j++) {
      const w = waypoints[nodes[j]];
      if (!walkable(ax, af, az, w.pos.x, w.floor, w.pos.z, 0.9)) break;
      far = j;
    }
    const w = waypoints[nodes[far]];
    out.push(w.pos);
    ax = w.pos.x; az = w.pos.z; af = w.floor;
    i = far;
  }
  return out;
}

/** Straight-line walkability between two positions, for callers outside the graph. */
function canWalk(a, b) {
  return walkable(a.x, floorUnder(a), a.z, b.x, floorUnder(b), b.z, 0.6);
}

const glbMaps = GLB_MAPS.map((def) => createGlbMap(def, {
  mapGroup, pbrMat, addStaticBox, addStaticCylinder, addRampCollider, addBlocker, addLightEmitter,
  buildSpawnPoints, spawnAmmoChests, spawnConsumables,
}));

return {
  mapGroup,
  blockers,
  inBlocker,
  spawnPoints,
  waypoints,
  mapLights,
  clearMap,
  losClear,
  nearestWaypoint,
  findPath,
  canWalk,
  glbMaps,
  /** Fetch every Blender map at once; resolves to { id: loaded } once they have all settled. */
  loadGlbMaps: async () => Object.fromEntries(await Promise.all(glbMaps.map(async (m) => [m.def.id, await m.load()]))),
  buildWaypoints,
  buildMapLayer,
};
}
/** Map selection, shared lighting configuration, and level lifecycle. */
export function createMapController({
  scene,
  renderer,
  mapCamera,
  rigAmbient,
  rigHemi,
  rigSun,
  glbMaps,
  buildWaypoints,
  buildMapLayer,
  clearMap,
  setSpawnCastY,
}) {
  /**
   * A map's entry, from its definition (see mapGlb.js): how the geometry is built, the sky and
   * fog, and the nav-graph and minimap tuning.
   */
  const glbEntry = (m) => {
    const d = m.def, [HX, HZ] = d.half, L = d.look.lighting;
    return {
      name: d.name,
      blurb: d.blurb,
      // Only offered once its GLB and collider table have loaded.
      available: m.ready,
      background: d.look.background,
      fog: d.look.fog,
      sky: d.look.sky,
      env: d.look.env,
      mapView: d.mapView,
      ceilY: d.ceilY,
      nav: { extent: Math.max(HX, HZ) - 0.5, step: 3, coverPad: 2.6 },
      layerExtent: Math.max(HX, HZ) + 2,
      plates: d.plates,
      lighting: { ...L, sun: { ...L.sun, extent: Math.max(HX, HZ) + 6, far: 200 } },
      build() { m.build(); },
    };
  };
  const MAPS = Object.fromEntries(glbMaps.map((m) => [m.def.id, glbEntry(m)]));

  let currentMapId = null;
  let currentPlan = null;          // what the minimap draws; a new object per map build
  const environments = new Map();  // sky light per map, prefiltered on first visit

  /** The map to open on: the first one that loaded, or null if none did. */
  const defaultMapId = () => glbMaps.find((m) => m.ready())?.def.id ?? null;

  /** Build a level from scratch. Assumes clearMap() has already run if one was loaded. */
  function buildMap(id) {
    const m = MAPS[id];
    currentMapId = id;
    // Must be set before m.build() runs — the spawners below it cast down from here.
    setSpawnCastY(m.ceilY - 0.5);

    scene.background = new THREE.Color(m.background);
    scene.fog = new THREE.Fog(m.fog.color, m.fog.near, m.fog.far);
    if (m.sky && !environments.has(id)) environments.set(id, skyEnvironment(renderer, m.sky));
    scene.environment = environments.get(id) ?? null;
    scene.environmentIntensity = m.env ?? 1;

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
    buildWaypoints({ ...m.nav, ceilY: m.ceilY });
    buildMapLayer(m.layerExtent, m.plates);
    currentPlan = { extent: m.layerExtent, view: m.mapView, plates: m.plates };
  }

  /** Swap levels. No-op when the requested map is already loaded, or its files are not. */
  function switchMap(id) {
    if (id === currentMapId || !MAPS[id] || MAPS[id].available?.() === false) return;
    clearMap();
    buildMap(id);
  }

  return {
    MAPS,
    buildMap,
    switchMap,
    currentMapId: () => currentMapId,
    currentPlan: () => currentPlan,
    defaultMapId,
  };
}
