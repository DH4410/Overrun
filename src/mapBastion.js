import * as THREE from 'three';

import { MAP_DATA } from './sim/mapData.js';

/**
 * BASTION: two stone keeps and the grass between them, for capture the flag. Modelled in Blender
 * (scripts/blender/build_bastion.py). Loaded by src/mapGlb.js; this file is only what differs from
 * the other Blender maps.
 *
 * 64 by 110 m. Each keep is a walled bailey with a flag hall behind a gated curtain wall; between
 * them is open grass with a raised stone causeway down the middle, ruined walls and standing
 * stones, and a dirt trail and a pine grove down each flank. 180-degree rotational symmetry.
 * The hall roof, 4.6 m, is the lowest thing overhead and is ceilY.
 *
 * Units are metres; +Z is south.
 */
export const BASTION = {
  ...MAP_DATA.bastion,
  id: 'bastion',
  file: 'bastion',
  name: 'BASTION',
  blurb: 'Two stone keeps and the grass between them, 64 by 110 metres. A causeway down the middle, a pine trail on each flank. Capture the flag.',
  mapView: 62,
  shadowExtent: 40,
  plates: { ground: 0x3a4a2c, solid: 0x9a948a },

  /** One Poly Haven material per mesh. The GLB's UVs are metres / tile size, so repeat is 1. */
  materials(pbrMat) {
    const decal = (n) => ({ polygonOffset: true, polygonOffsetFactor: -n, polygonOffsetUnits: -n });
    // The grass, the keeps and the field walls keep a chosen colour and take only their texture's
    // detail: leafy_grass is dry-looking and castle_brick_07 is red brick, and neither is wanted.
    const grass = pbrMat('leafy_grass', { repeat: 1, ao: true, fallback: 0x5f8238, rough: 0.95, detail: true });
    return {
      grass,
      hill: grass,
      dirt: pbrMat('brown_mud_leaves_01', { repeat: 1, ao: true, fallback: 0x6b5438, rough: 0.95, extra: decal(1) }),
      paving: pbrMat('cobblestone_floor_04', { repeat: 1, ao: true, fallback: 0x7d7a72, rough: 0.9, extra: decal(2) }),
      castle: pbrMat('castle_brick_07', { repeat: 1, ao: true, fallback: 0xb0a898, rough: 0.9, detail: true }),
      rock: pbrMat('rock_wall_08', { repeat: 1, ao: true, fallback: 0x9a978e, rough: 0.92, detail: true }),
      wood: pbrMat('wood_planks', { repeat: 1, ao: true, fallback: 0x76583c, rough: 0.85 }),
      slates: pbrMat('roof_slates_02', { repeat: 1, ao: true, fallback: 0x4c5158, rough: 0.8 }),
      trunk: pbrMat('bark_brown_02', { repeat: 1, ao: true, fallback: 0x59443a, rough: 0.95 }),
      // Needles, banners and the backdrop: the colour is per face (vertex colours).
      pine: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, vertexColors: true, side: THREE.DoubleSide }),
      banner: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, vertexColors: true, side: THREE.DoubleSide }),
      far: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, vertexColors: true }),
      dark: new THREE.MeshStandardMaterial({ color: 0x0b0b0d, roughness: 0.95, ...decal(1) }),
      metal: new THREE.MeshStandardMaterial({ color: 0x35363a, roughness: 0.5, metalness: 0.6 }),
    };
  },
  /** Meshes that stay out of the shadow pass: ground, decals, and everything past the wall. */
  noCast: ['grass', 'hill', 'dirt', 'paving', 'dark', 'far'],

  look: {
    background: 0xbcd0e0,
    fog: { color: 0xc4d4de, near: 50, far: 215 },   // the far ranges sit at 235-255 m: fully hazed, so they read as distance not slabs
    sky: {
      top: 0x4a86c8, horizon: 0xcfdde6, ground: 0x6a7a58, sunDir: [-0.45, 0.7, 0.4],
      cover: 0.35, sunColor: 0xfff0d2, haze: 1.1,
    },
    env: 0.55,
    lighting: {
      ambient: { color: 0xe2ead8, intensity: 0.22 },
      hemi: { sky: 0xcfe2f4, ground: 0x6c7a50, intensity: 0.6 },
      sun: { color: 0xfff0d2, intensity: 2.4, pos: [-36, 48, 32] },
    },
  },

  // Daylight, and the hall is open to the front: no lamps.
  lamps: [],
};
