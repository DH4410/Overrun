import * as THREE from 'three';

import { MAP_DATA } from './sim/mapData.js';

/**
 * DESERT: a walled desert town at mid-afternoon, modelled in Blender
 * (scripts/blender/build_desert.py). Loaded by src/mapGlb.js; this file is only what differs
 * from the other Blender maps.
 *
 * The layout: a gated spawn yard at each end, an arcaded approach, and a market square round a
 * domed cistern in the middle. Each flank is half souk (a slatted passage between houses) and
 * half caravanserai yard. 180-degree rotational symmetry, so a duel starts from two identical
 * ends. Everything under a roof is under 4.2 m, which is ceilY.
 *
 * Units are metres; +Z is south.
 */
export const DESERT = {
  ...MAP_DATA.desert,
  id: 'desert',
  file: 'desert',
  name: 'DESERT',
  blurb: 'Walled desert town at mid-afternoon. A market square in the middle, a souk and a caravanserai on each flank.',
  mapView: 42,
  plates: { ground: 0x3a3026, solid: 0xc2a57e },

  /** One Poly Haven material per mesh. The GLB's UVs are metres / tile size, so repeat is 1. */
  materials(pbrMat) {
    const decal = (n) => ({ polygonOffset: true, polygonOffsetFactor: -n, polygonOffsetUnits: -n });
    const sand = pbrMat('dense_sand', { repeat: 1, ao: true, fallback: 0xc29d6c, rough: 0.95 });
    const wood = pbrMat('weathered_planks', { repeat: 1, ao: true, fallback: 0x76583c, rough: 0.85 });
    // The plasters and the paving keep a chosen colour and take only their texture's detail, so
    // the town stays one warm palette whatever each scan's own tint.
    const lime = pbrMat('plastered_wall_03', { repeat: 1, ao: true, fallback: 0xe8dfce, rough: 0.9, detail: true });
    return {
      sand,
      dune: sand,
      paving: pbrMat('red_sandstone_pavement', { repeat: 1, ao: true, fallback: 0xa88a6c, rough: 0.9, detail: true, extra: decal(1) }),
      stone: pbrMat('sandstone_blocks_08', { repeat: 1, ao: true, fallback: 0xb89e7a, rough: 0.9 }),
      plaster: pbrMat('yellow_plaster', { repeat: 1, ao: true, fallback: 0xcaa479, rough: 0.92, detail: true }),
      mud: pbrMat('clay_plaster', { repeat: 1, ao: true, fallback: 0x94694a, rough: 0.95 }),
      lime,
      dome: lime,
      wood,
      beam: wood,
      trunk: pbrMat('rough_wood', { repeat: 1, ao: true, fallback: 0x6b5641, rough: 0.95 }),
      // Awnings and palm leaves: the colour is per face (vertex colours).
      cloth: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, vertexColors: true }),
      frond: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, vertexColors: true, side: THREE.DoubleSide }),
      far: pbrMat('patterned_clay_plaster', { repeat: 1, fallback: 0xffffff, rough: 0.95, detail: true, extra: { vertexColors: true } }),
      dark: new THREE.MeshStandardMaterial({ color: 0x2a1f17, roughness: 0.95, ...decal(1) }),
      water: new THREE.MeshStandardMaterial({ color: 0x2c3f3a, roughness: 0.15, metalness: 0.1 }),
      metal: new THREE.MeshStandardMaterial({ color: 0x3a3632, roughness: 0.5, metalness: 0.6 }),
      lamp: new THREE.MeshBasicMaterial({ color: 0xffd9a0 }),
    };
  },
  /** Meshes that stay out of the shadow pass: ground, decals, emitters, and everything past the wall. */
  noCast: ['sand', 'dune', 'paving', 'dark', 'lamp', 'far', 'water'],

  look: {
    background: 0xe6d6ba,
    fog: { color: 0xe2cfae, near: 45, far: 280 },
    // A low afternoon sun, so walls throw long shadows across the square.
    sky: {
      top: 0x3d78bf, horizon: 0xe9d9bd, ground: 0xb8966a, sunDir: [0.5, 0.62, -0.6],
      cover: 0.1, sunColor: 0xffe2b0, haze: 1.4,
    },
    env: 0.5,
    lighting: {
      ambient: { color: 0xf2dec2, intensity: 0.22 },
      hemi: { sky: 0xcfe0f0, ground: 0xb08a5c, intensity: 0.55 },
      sun: { color: 0xffe4be, intensity: 2.6, pos: [44, 55, -53] },
    },
  },

  // Under the arcade roofs and the souk slats, beside the modelled lanterns.
  lamps: [1, -1].flatMap((s) => [
    [s * -9.25, 3.7, s * 11.8, 60, 14], [s * 9.25, 3.7, s * 11.8, 60, 14],
    [s * -23.5, 3.7, s * 16, 60, 14], [s * 35, 3.7, s * 25.6, 60, 14],
  ]),
};
