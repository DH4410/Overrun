import * as THREE from 'three';

import { MAP_DATA } from './sim/mapData.js';

/**
 * METRO: an underground station hub, modelled in Blender (scripts/blender/build_metro.py).
 * Loaded by src/mapGlb.js; this file is only what differs from the other Blender maps.
 *
 * 56 by 46 m under one flat ceiling at 6.2 m (which is ceilY). Two tracks run the length of the hall
 * with a train of three cars on each, an island platform between them with a walled information hall
 * in the middle (where the people hold out in survival), and a wide platform on the outside of each
 * track with kiosks along the wall. 180-degree rotational symmetry.
 *
 * Units are metres; +Z is south.
 */
export const METRO = {
  ...MAP_DATA.metro,
  id: 'metro',
  file: 'metro',
  name: 'METRO',
  blurb: 'An underground station, 56 by 46 metres. Two tracks with trains on them, an island platform between, an information hall in the middle.',
  mapView: 50,
  shadowExtent: 30,
  plates: { ground: 0x1e1e20, solid: 0x9a9a94 },

  /** One Poly Haven material per mesh. The GLB's UVs are metres / tile size, so repeat is 1. */
  materials(pbrMat) {
    const decal = (n) => ({ polygonOffset: true, polygonOffsetFactor: -n, polygonOffsetUnits: -n });
    const flat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...extra });
    return {
      ballast: pbrMat('asphalt_02', { repeat: 1, ao: true, fallback: 0x2c2a28, rough: 0.95 }),
      floor: pbrMat('concrete_floor_damaged_01', { repeat: 1, ao: true, fallback: 0x6e6c66, rough: 0.7 }),
      tile: pbrMat('plastered_wall_03', { repeat: 1, ao: true, fallback: 0xffffff, rough: 0.5, extra: { vertexColors: true } }),
      concrete: pbrMat('rough_concrete', { repeat: 1, ao: true, fallback: 0x8c8a84, rough: 0.95 }),
      ceil: pbrMat('concrete_slab_wall', { repeat: 1, ao: true, fallback: 0x5c5f62, rough: 0.92 }),
      steel: pbrMat('metal_plate', { repeat: 1, ao: true, fallback: 0x575b5f, rough: 0.5, metal: 0.6 }),
      train: pbrMat('box_profile_metal_sheet', { repeat: 1, ao: true, fallback: 0xffffff, rough: 0.35, metal: 0.5, extra: { vertexColors: true } }),
      wood: pbrMat('weathered_planks', { repeat: 1, ao: true, fallback: 0x76583c, rough: 0.85 }),
      rail: flat(0x3a3d41, { roughness: 0.5, metalness: 0.6 }),
      dark: flat(0x07080a, { roughness: 0.9, ...decal(1) }),
      glass: flat(0x16202c, { roughness: 0.15, metalness: 0.4, ...decal(1) }),
      lines: flat(0xd8b422, { roughness: 0.8, ...decal(2) }),
      foliage: flat(0x2a5a22, { roughness: 0.95 }),
      glow: new THREE.MeshBasicMaterial({ color: 0xfff1d8 }),
      signblue: new THREE.MeshBasicMaterial({ color: 0x2a6cf0 }),
      signgreen: new THREE.MeshBasicMaterial({ color: 0x2ee07a }),
      signred: new THREE.MeshBasicMaterial({ color: 0xf0301f }),
    };
  },
  /** Ground, paint and emitters stay out of the shadow pass; so does the ceiling, so light reaches the floor. */
  noCast: ['ballast', 'floor', 'lines', 'dark', 'glass', 'glow', 'signblue', 'signgreen', 'signred', 'ceil'],

  look: {
    background: 0x14161a,
    fog: { color: 0x1a1d22, near: 40, far: 140 },
    // Never seen from inside the hall; the gradient only has to be dark.
    sky: {
      top: 0x1a222c, horizon: 0x2a2f36, ground: 0x15181c, sunDir: [-0.3, 0.8, -0.5],
      cover: 0, sunColor: 0xcfe0f5, haze: 0.2,
    },
    env: 0.4,
    lighting: {
      ambient: { color: 0xb4bcc8, intensity: 0.4 },
      hemi: { sky: 0xc8d4e4, ground: 0x6a6258, intensity: 0.6 },
      sun: { color: 0xdfe8f5, intensity: 0.9, pos: [-14, 40, -18] },
    },
  },

  // Strip lights over the platforms and the tracks, a little under the troughs.
  lamps: [-14, 0, 14].flatMap((x) => [-12, 0, 12].map((z) => [x, 5.3, z, 55, 20])),
};
