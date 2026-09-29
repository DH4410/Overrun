import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { markShared } from './rendering.js';

/**
 * PORT: a container port in daylight, modelled in Blender.
 *
 * The geometry is assets/maps/port.glb and the colliders are assets/maps/port.json, both written
 * by scripts/blender/build_port.py. That script emits every piece's mesh and its collider in the
 * same call, so what you see is exactly what you stand on, hide behind and slide along. To change
 * the layout, edit the script and re-run it in Blender; nothing here needs to change.
 *
 * The rules the layout follows:
 *  - Heights are chosen for movement. Crates are 1.0 m, which a jump clears; containers are
 *    2.59 m, which it does not, so they are walls. The dock is 1.4 m: up by ramp, or by jumping
 *    off the crate beside it.
 *  - Daylight. A target is read by silhouette and contrast; a sunlit yard reads at 60 m where a
 *    dim warehouse loses you at 20.
 *  - 180-degree rotational symmetry, like Foundry, so a duel is decided by the players. Three
 *    lanes: a warehouse flank, the plaza round the dock, a container-yard flank.
 *
 * Units are metres; +Z is south.
 */
export const PORT_HALF_X = 50;
export const PORT_HALF_Z = 38;
/**
 * Spawn, pickup and nav casts start just below this, and it must be under every roof: the spawn
 * sheds' roofs start at y = 6.0, and a cast from above them would put the spawns on the roof
 * (the Foundry bug in HANDOFF). Stacked containers top out at 5.18 m, safely below the cast.
 */
export const PORT_CEIL = 6.0;

/**
 * Mirrored spawn candidates, listed in pairs. Each clears buildSpawnPoints' 2 m blocker pad,
 * checked against the built layout: four in each spawn shed, the rest spread over the flanks so
 * "furthest from every enemy" has somewhere to choose from in deathmatch.
 */
const PORT_SPAWNS = [
  [0, 31], [0, -31], [-5, 33], [5, -33], [5, 33], [-5, -33], [-12, 31], [12, -31],
  [-34, 34], [34, -34], [46, 34], [-46, -34], [-46, 3], [46, -3],
  [26, 20], [-26, -20], [-34, 16], [34, -16], [44, 16], [-44, -16], [-17, 21], [17, -21],
];

export function createPortMap({
  mapGroup, pbrMat, addStaticBox, addRampCollider, addBlocker, addLightEmitter,
  buildSpawnPoints, spawnAmmoChests, spawnConsumables,
}) {
  /** The loaded scene and collider table, or null if the files could not be loaded. */
  let source = null;
  let mats = null;

  async function loadPort() {
    try {
      const [gltf, data] = await Promise.all([
        new GLTFLoader().loadAsync('assets/maps/port.glb'),
        fetch('assets/maps/port.json').then((r) => {
          if (!r.ok) throw new Error(`port.json ${r.status}`);
          return r.json();
        }),
      ]);
      if (data.ceilY !== PORT_CEIL) {
        console.warn(`port.json ceilY ${data.ceilY} != PORT_CEIL ${PORT_CEIL}; re-run build_port.py`);
      }
      // Every build clones this scene, and clearMap() frees the geometry of whatever it takes
      // down. Marking the source geometry shared is what lets a second visit render at all.
      gltf.scene.traverse((o) => { if (o.isMesh) markShared(o.geometry); });
      source = { scene: gltf.scene, data };
      return true;
    } catch {
      return false;   // PORT stays unavailable and its menu entry is disabled; the rest is fine
    }
  }

  /**
   * One Poly Haven material per mesh. The GLB's UVs are metres divided by each key's tile size
   * in build_port.py, so repeat is 1 here and the tiling is chosen there.
   */
  function materials() {
    if (mats) return mats;
    const decal = (n) => ({ polygonOffset: true, polygonOffsetFactor: -n, polygonOffsetUnits: -n });
    mats = {
      asphalt: pbrMat('asphalt_02', { repeat: 1, fallback: 0x4d5054, rough: 0.95 }),
      apron: pbrMat('concrete_floor_01', { repeat: 1, fallback: 0x9a968e, rough: 0.9 }),
      slab: pbrMat('concrete_pavement', { repeat: 1, fallback: 0x8f8c86, rough: 0.9, extra: decal(1) }),
      wall: pbrMat('concrete_slab_wall', { repeat: 1, fallback: 0xa19d95, rough: 0.92 }),
      barrier: pbrMat('rough_concrete', { repeat: 1, fallback: 0xaaa69c, rough: 0.95 }),
      cladding: pbrMat('factory_wall', { repeat: 1, fallback: 0x56705a, rough: 0.6, metal: 0.3 }),
      roof: pbrMat('box_profile_metal_sheet', { repeat: 1, fallback: 0x6b4038, rough: 0.6, metal: 0.3 }),
      wood: pbrMat('plywood', { repeat: 1, fallback: 0xa07c52, rough: 0.8 }),
      // Container paint: the colour is per container (vertex colours from the GLB); the texture
      // only adds its scratches and grime, as luminance.
      paint: pbrMat('green_metal_rust', {
        repeat: 1, fallback: 0xffffff, rough: 0.55, metal: 0.25, detail: true, extra: { vertexColors: true },
      }),
      yellow: pbrMat('green_metal_rust', { repeat: 1, fallback: 0xd29a1c, rough: 0.55, metal: 0.25, detail: true }),
      steel: new THREE.MeshStandardMaterial({ color: 0x5b6167, roughness: 0.45, metalness: 0.6 }),
      lines: new THREE.MeshStandardMaterial({ color: 0xd9b23a, roughness: 0.85, ...decal(2) }),
      linesW: new THREE.MeshStandardMaterial({ color: 0xd6d8d4, roughness: 0.85, ...decal(2) }),
      lamp: new THREE.MeshBasicMaterial({ color: 0xfff1d6 }),
      far: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.1, vertexColors: true }),
      water: new THREE.MeshStandardMaterial({ color: 0x27414b, roughness: 0.25, metalness: 0.1 }),
    };
    return mats;
  }

  /** Meshes that stay out of the shadow pass: decals, emitters, and everything past the wall. */
  const NO_CAST = new Set(['asphalt', 'slab', 'lines', 'linesW', 'lamp', 'far', 'water']);

  function sky() {
    const geo = new THREE.SphereGeometry(420, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x4f86c0) },
        horizon: { value: new THREE.Color(0xc9dcea) },
        ground: { value: new THREE.Color(0x8e8a80) },
        sunDir: { value: new THREE.Vector3(-0.45, 0.72, 0.52).normalize() },
      },
      vertexShader: `varying vec3 vDir;
        void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; uniform vec3 sunDir; varying vec3 vDir;
        void main() {
          float h = vDir.y;
          vec3 c = h > 0.0 ? mix(horizon, top, pow(clamp(h, 0.0, 1.0), 0.55)) : mix(horizon, ground, clamp(-h * 4.0, 0.0, 1.0));
          float s = max(dot(normalize(vDir), sunDir), 0.0);
          c += vec3(1.0, 0.92, 0.75) * (pow(s, 900.0) * 3.0 + pow(s, 12.0) * 0.18);
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    const dome = new THREE.Mesh(geo, mat);
    dome.frustumCulled = false;
    dome.renderOrder = -10;
    // Follow the camera so the horizon never comes closer than the fog.
    dome.onBeforeRender = (_r, _s, camera) => { dome.position.copy(camera.position); dome.updateMatrixWorld(); };
    mapGroup.add(dome);
  }

  function buildPort() {
    const M = materials();
    const root = source.scene.clone(true);
    root.traverse((o) => {
      if (!o.isMesh) return;
      const key = o.material?.name;
      if (M[key]) o.material = M[key];
      o.castShadow = !NO_CAST.has(key);
      o.receiveShadow = key !== 'lamp';
    });
    mapGroup.add(root);
    sky();

    const { boxes, ramps } = source.data;
    const Y = new CANNON.Vec3(0, 1, 0);
    for (const [x, y, z, hx, hy, hz, yaw, block] of boxes) {
      const quat = yaw ? new CANNON.Quaternion().setFromAxisAngle(Y, yaw) : null;
      addStaticBox(hx, hy, hz, { x, y, z }, quat);
      // Same rule as addSolid: anything in the band a body occupies blocks spawns and pickups
      // and shows on the minimap. Roofs, lintels and the ground are flagged out in the script.
      if (block && y + hy > 0.7 && y - hy < 2.4) {
        const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
        addBlocker(x, z, hx * c + hz * s, hx * s + hz * c);
      }
    }
    for (const r of ramps) addRampCollider(...r);

    // The perimeter wall IS the boundary, so it is not a blocker (that would push spawns off
    // the edge of the whole map); these strips keep spawns and pickups off its foot instead.
    const HX = PORT_HALF_X, HZ = PORT_HALF_Z;
    addBlocker(0, -HZ, HX, 1.2); addBlocker(0, HZ, HX, 1.2);
    addBlocker(-HX, 0, 1.2, HZ); addBlocker(HX, 0, 1.2, HZ);

    // Interior lamps: the sheds and warehouses have roofs, so the sun does not reach inside.
    const lamp = (x, y, z, intensity, distance) =>
      addLightEmitter({ x, y, z, color: 0xffe1b8, intensity, distance, priority: 0 });
    for (const s of [1, -1]) {
      lamp(s * -7, 5.4, s * 32.5, 90, 22);
      lamp(s * 7, 5.4, s * 32.5, 90, 22);
      lamp(s * -39, 5.4, s * 11, 110, 20);
      lamp(s * -27, 5.4, s * 18, 110, 20);
    }
  }

  function buildPortMap() {
    buildPort();
    buildSpawnPoints(PORT_SPAWNS, [[0, 31], [0, -31], [7, 33], [-7, -33]], PORT_CEIL - 0.5);
    // Ammo in the lanes, health and shield out on the flanks.
    spawnAmmoChests([
      [3.5, 15.5], [-3.5, -15.5], [17.5, 0], [-17.5, 0],
      [26, 21], [-26, -21], [-30, 16], [30, -16],
    ], 8);
    spawnConsumables([
      ['health', 40, 1], ['health', -40, -1],
      ['shield', -33, 13], ['shield', 33, -13],
      ['health', 0, 0], ['shield', 17, 25], ['shield', -17, -25],
    ], 8);
  }

  return { loadPort, buildPortMap, portReady: () => source !== null };
}
