import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { markShared } from './rendering.js';
import { buildMapColliders } from './sim/colliders.js';

/**
 * Maps modelled in Blender. Each one is a definition (src/mapPort.js, mapDesert.js,
 * mapSnow.js) plus two files written by its script in scripts/blender/:
 *
 *   assets/maps/<file>.glb   the meshes, one per material key, world-scaled UVs
 *   assets/maps/<file>.json  the colliders: oriented boxes, ramps and upright cylinders
 *
 * The script emits every piece's mesh and its collider in the same call, so what you see is
 * exactly what you stand on, hide behind and slide along. Nothing here knows any layout.
 *
 * A mesh whose material name is a key of the definition's `materials()` gets that Poly Haven
 * material; anything else (the baked Poly Haven props) keeps the material it was exported with.
 */
export function createGlbMap(def, {
  mapGroup, pbrMat, addStaticBox, addStaticCylinder, addRampCollider, addBlocker, addLightEmitter,
  buildSpawnPoints, spawnAmmoChests, spawnConsumables,
}) {
  let source = null;
  let mats = null;

  async function load() {
    try {
      const [gltf, data] = await Promise.all([
        new GLTFLoader().loadAsync(`assets/maps/${def.file}.glb`),
        fetch(`assets/maps/${def.file}.json`).then((r) => {
          if (!r.ok) throw new Error(`${def.file}.json ${r.status}`);
          return r.json();
        }),
      ]);
      if (data.ceilY !== def.ceilY) {
        console.warn(`${def.file}.json ceilY ${data.ceilY} != ${def.ceilY}; re-run its Blender script`);
      }
      // Every build clones this scene, and clearMap() frees the geometry of whatever it takes
      // down. Marking the source geometry shared is what lets a second visit render at all.
      gltf.scene.traverse((o) => { if (o.isMesh) markShared(o.geometry); });
      source = { scene: gltf.scene, data };
      return true;
    } catch {
      return false;   // the map stays unavailable and its menu entry is disabled; the rest is fine
    }
  }

  function build() {
    mats ??= def.materials(pbrMat);
    const noCast = new Set(def.noCast);
    const root = source.scene.clone(true);
    root.traverse((o) => {
      if (!o.isMesh) return;
      const key = o.material?.name;
      if (mats[key]) o.material = mats[key];
      o.castShadow = !noCast.has(key);
      o.receiveShadow = !mats[key]?.isMeshBasicMaterial;
    });
    mapGroup.add(root);
    mapGroup.add(skyDome(def.look.sky));

    buildMapColliders(source.data, def.half, { addStaticBox, addStaticCylinder, addRampCollider, addBlocker });

    for (const [x, y, z, intensity, distance, color = 0xffe1b8] of def.lamps) {
      addLightEmitter({ x, y, z, color, intensity, distance, priority: 0 });
    }

    buildSpawnPoints(def.spawns, def.spawns.slice(0, 4), def.ceilY - 0.5);
    spawnAmmoChests(def.ammo, 8);
    spawnConsumables(def.consumables, 8);
  }

  return { def, load, build, ready: () => source !== null };
}

/* ------------------------------------------------------------------ sky */

const SKY_VERT = `varying vec3 vDir;
  void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/**
 * A gradient sky with a sun and a layer of soft clouds. The clouds are value noise projected
 * onto a flat ceiling (dir.xz / dir.y), so they bunch up and thin out toward the horizon the
 * way a real cloud deck does, and they never move: a still sky costs one noise lookup per pixel.
 */
const SKY_FRAG = `uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; uniform vec3 sunDir;
  uniform vec3 sunColor; uniform vec3 cloudColor; uniform float cover; uniform float haze;
  varying vec3 vDir;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 c = h > 0.0 ? mix(horizon, top, pow(clamp(h, 0.0, 1.0), 0.55)) : mix(horizon, ground, clamp(-h * 4.0, 0.0, 1.0));
    float s = max(dot(d, sunDir), 0.0);
    c += sunColor * (pow(s, 900.0) * 3.0 + pow(s, 10.0) * 0.22 * haze);
    if (h > 0.0 && cover > 0.0) {
      vec2 uv = d.xz / (h + 0.08) * 1.4;
      float n = fbm(uv);
      float k = smoothstep(1.0 - cover, 1.0 - cover + 0.35, n) * smoothstep(0.0, 0.12, h);
      vec3 cc = cloudColor * (0.82 + 0.3 * n) + sunColor * pow(s, 6.0) * 0.25;
      c = mix(c, cc, k * 0.9);
    }
    gl_FragColor = vec4(c, 1.0);
    #include <colorspace_fragment>
  }`;

function skyMaterial(sky) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color(sky.top) },
      horizon: { value: new THREE.Color(sky.horizon) },
      ground: { value: new THREE.Color(sky.ground) },
      sunDir: { value: new THREE.Vector3(...sky.sunDir).normalize() },
      sunColor: { value: new THREE.Color(sky.sunColor ?? 0xffebbf) },
      cloudColor: { value: new THREE.Color(sky.cloudColor ?? 0xffffff) },
      cover: { value: sky.cover ?? 0 },
      haze: { value: sky.haze ?? 1 },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
  });
}

/** The dome drawn behind the map. It follows the camera so the horizon never comes closer than the fog. */
function skyDome(sky) {
  const dome = new THREE.Mesh(new THREE.SphereGeometry(420, 32, 16), skyMaterial(sky));
  dome.frustumCulled = false;
  dome.renderOrder = -10;
  dome.onBeforeRender = (_r, _s, camera) => { dome.position.copy(camera.position); dome.updateMatrixWorld(); };
  return dome;
}

/**
 * Image-based light from the same sky, prefiltered once per map. Without it anything metallic
 * has nothing to reflect and reads as black, and every shadowed face is one flat ambient grey;
 * with it, a face lit only by the sky picks up the sky's colour and the sun side of the dome.
 */
export function skyEnvironment(renderer, sky) {
  const scene = new THREE.Scene();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), skyMaterial(sky));
  scene.add(dome);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(scene, 0.02, 0.1, 100).texture;
  pmrem.dispose();
  dome.geometry.dispose();
  dome.material.dispose();
  return tex;
}
