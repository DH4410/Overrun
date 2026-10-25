import * as THREE from 'three';

import { MAP_DATA } from './sim/mapData.js';

/**
 * ARENA: a floodlit concrete pit for survival, modelled in Blender (scripts/blender/build_arena.py).
 * Loaded by src/mapGlb.js; this file is only what differs from the other Blender maps.
 *
 * 64 by 64 m, four-fold symmetric. The people start on a raised dais in the middle; the hostiles
 * come out of a recess in the middle of each wall. Cover in each quarter, tiers of stands behind a
 * 6.5 m wall, a floodlight tower at each corner, and the last of the sun going down behind them.
 *
 * Units are metres; +Z is south.
 */
export const ARENA = {
  ...MAP_DATA.arena,
  id: 'arena',
  file: 'arena',
  name: 'ARENA',
  blurb: 'A floodlit concrete pit, 64 by 64 metres, with a dais in the middle and four gates in the walls. Survival only.',
  mapView: 40,
  shadowExtent: 38,
  plates: { ground: 0x1d1d20, solid: 0x8a8a86 },

  /** One Poly Haven material per mesh. The GLB's UVs are metres / tile size, so repeat is 1. */
  materials(pbrMat) {
    const decal = (n) => ({ polygonOffset: true, polygonOffsetFactor: -n, polygonOffsetUnits: -n });
    return {
      asphalt: pbrMat('asphalt_02', { repeat: 1, ao: true, fallback: 0x2c2c30, rough: 0.9 }),
      dais: pbrMat('concrete_floor_damaged_01', { repeat: 1, ao: true, fallback: 0x8a8a88, rough: 0.9, detail: true }),
      concrete: pbrMat('rough_concrete', { repeat: 1, ao: true, fallback: 0x9a9a98, rough: 0.95, detail: true }),
      cmu: pbrMat('concrete_slab_wall', { repeat: 1, ao: true, fallback: 0x84847f, rough: 0.92, detail: true }),
      steel: pbrMat('metal_plate', { repeat: 1, ao: true, fallback: 0x6a6e72, rough: 0.5, metal: 0.6, detail: true }),
      wood: pbrMat('weathered_planks', { repeat: 1, ao: true, fallback: 0x76583c, rough: 0.85 }),
      lines: new THREE.MeshStandardMaterial({ color: 0xd2b02a, roughness: 0.8, ...decal(2) }),
      dark: new THREE.MeshStandardMaterial({ color: 0x08090b, roughness: 0.9, ...decal(3) }),
      beacon: new THREE.MeshBasicMaterial({ color: 0xff7a30 }),
      glow: new THREE.MeshBasicMaterial({ color: 0xfff1d8 }),
      // The tiers: the colour is per face (vertex colours).
      stands: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, vertexColors: true }),
    };
  },
  /** Ground, paint, emitters and the stands stay out of the shadow pass. */
  noCast: ['asphalt', 'lines', 'dark', 'beacon', 'glow', 'stands'],

  look: {
    background: 0x2a2a3a,
    fog: { color: 0x3b3446, near: 55, far: 230 },
    // Dusk: the sun is on the horizon, so the walls throw long shadows across the pit.
    sky: {
      top: 0x15203c, horizon: 0xe08a52, ground: 0x1c1a1c, sunDir: [-0.8, 0.14, 0.45],
      cover: 0.35, sunColor: 0xff9a55, haze: 1.7,
    },
    env: 0.3,
    lighting: {
      ambient: { color: 0x8890ac, intensity: 0.42 },
      hemi: { sky: 0x5a6a94, ground: 0x2c2a30, intensity: 0.5 },
      sun: { color: 0xffb27c, intensity: 1.25, pos: [-70, 18, 40] },
    },
  },

  // The four floodlights, brought in from their towers over the stands to a little over the wall.
  lamps: [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => [sx * 27, 17, sz * 27, 1500, 80, 0xfff0dc]),
};
