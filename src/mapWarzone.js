import * as THREE from 'three';

import { MAP_DATA } from './sim/mapData.js';

/**
 * WARZONE: a ruined town on open ground under a smoky afternoon sky, modelled in Blender
 * (scripts/blender/build_warzone.py). Loaded by src/mapGlb.js; this file is only what differs
 * from the other Blender maps.
 *
 * The big map: 140 by 100 m, two walled bases, a boulevard to a plaza in the middle, and a
 * district on each flank (apartments, shops, a ruin and a warehouse to the west; a roofless
 * church, a fuel station, a factory and houses to the east). 180-degree rotational symmetry, so
 * both ends of a team match get the same fight. Every roof is at 4.0 m, which is ceilY.
 *
 * Units are metres; +Z is south.
 */
export const WARZONE = {
  ...MAP_DATA.warzone,
  id: 'warzone',
  file: 'warzone',
  name: 'WARZONE',
  blurb: 'A ruined town, 140 metres across. Two walled bases, a plaza in the middle and a district on each flank. Built for the endless deathmatch.',
  mapView: 74,
  shadowExtent: 84,
  plates: { ground: 0x2a2a28, solid: 0xa09a8c },

  /** One Poly Haven material per mesh. The GLB's UVs are metres / tile size, so repeat is 1. */
  materials(pbrMat) {
    const decal = (n) => ({ polygonOffset: true, polygonOffsetFactor: -n, polygonOffsetUnits: -n });
    return {
      ground: pbrMat('dry_ground_rocks', { repeat: 1, ao: true, fallback: 0x6f6654, rough: 0.95 }),
      outer: pbrMat('dry_ground_rocks', { repeat: 1, fallback: 0x6f6654, rough: 0.95 }),
      road: pbrMat('asphalt_02', { repeat: 1, ao: true, fallback: 0x3c3c3e, rough: 0.95, extra: decal(1) }),
      lines: new THREE.MeshStandardMaterial({ color: 0xcdb866, roughness: 0.85, ...decal(2) }),
      paving: pbrMat('cobblestone_floor_04', { repeat: 1, ao: true, fallback: 0x87806f, rough: 0.9, extra: decal(1) }),
      brick: pbrMat('broken_brick_wall', { repeat: 1, ao: true, fallback: 0x8a4e3a, rough: 0.9 }),
      stucco: pbrMat('peeling_painted_wall', { repeat: 1, ao: true, fallback: 0xb5a584, rough: 0.9 }),
      cmu: pbrMat('concrete_slab_wall', { repeat: 1, ao: true, fallback: 0x8f8d86, rough: 0.92 }),
      plaster: pbrMat('plastered_wall_03', { repeat: 1, ao: true, fallback: 0xc2bba8, rough: 0.9, detail: true }),
      concrete: pbrMat('rough_concrete', { repeat: 1, ao: true, fallback: 0x8c8a84, rough: 0.95 }),
      floor: pbrMat('concrete_floor_damaged_01', { repeat: 1, ao: true, fallback: 0x625f59, rough: 0.9, extra: decal(1) }),
      roof: pbrMat('corrugated_iron_02', { repeat: 1, ao: true, fallback: 0x6b4a40, rough: 0.6, metal: 0.3 }),
      rubble: pbrMat('rubble', { repeat: 1, ao: true, fallback: 0x75706a, rough: 0.95 }),
      steel: pbrMat('metal_plate', { repeat: 1, ao: true, fallback: 0x575b5f, rough: 0.5, metal: 0.6 }),
      rail: new THREE.MeshStandardMaterial({ color: 0x4a4e52, roughness: 0.5, metalness: 0.6 }),
      wood: pbrMat('weathered_planks', { repeat: 1, ao: true, fallback: 0x76583c, rough: 0.85 }),
      trunk: pbrMat('rough_wood', { repeat: 1, ao: true, fallback: 0x4a3c30, rough: 0.95 }),
      // Containers, vehicles and sandbags: the colour is per face (vertex colours); the texture
      // only adds its scratches and weave, as luminance.
      container: pbrMat('box_profile_metal_sheet', { repeat: 1, ao: true, fallback: 0xffffff, rough: 0.55, metal: 0.3, detail: true, extra: { vertexColors: true } }),
      paint: pbrMat('rusty_metal_sheet', { repeat: 1, fallback: 0xffffff, rough: 0.65, metal: 0.25, detail: true, extra: { vertexColors: true } }),
      sand: pbrMat('hessian_230', { repeat: 1, fallback: 0xffffff, rough: 0.95, detail: true, extra: { vertexColors: true } }),
      dark: new THREE.MeshStandardMaterial({ color: 0x0d1114, roughness: 0.9, ...decal(1) }),
      glow: new THREE.MeshBasicMaterial({ color: 0xffd9a0 }),
      far: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, vertexColors: true }),
    };
  },
  /** Meshes that stay out of the shadow pass: ground, decals, emitters, and everything past the wall. */
  noCast: ['ground', 'outer', 'road', 'lines', 'paving', 'floor', 'dark', 'glow', 'far'],

  look: {
    background: 0xb9b6ae,
    fog: { color: 0xb4b2ac, near: 70, far: 360 },
    // A hazy afternoon: the sun high behind thin smoke, long sightlines and flat warm light.
    sky: {
      top: 0x5f7d9c, horizon: 0xc9c2b2, ground: 0x8a8678, sunDir: [-0.35, 0.62, -0.7],
      cover: 0.5, sunColor: 0xffe2b0, haze: 1.8, cloudColor: 0xb9b6b0,
    },
    env: 0.5,
    lighting: {
      ambient: { color: 0xc8c4b8, intensity: 0.28 },
      hemi: { sky: 0xb8c6d6, ground: 0x7a7060, intensity: 0.6 },
      sun: { color: 0xffe0b4, intensity: 2.2, pos: [-40, 66, -52] },
    },
  },

  // Under the roofs, where the sun does not reach: one in each building (and the fuel canopy).
  lamps: [1, -1].flatMap((s) => [
    [s * -54, 3.5, s * 14, 55, 14], [s * -33, 3.5, s * 12, 55, 12], [s * -35, 3.5, s * 28, 70, 18],
    [s * -10, 3.5, s * 44.5, 50, 12], [s * 52, 3.5, s * 29, 70, 18], [s * 60.5, 3.5, s * 11.5, 45, 10],
    [s * 26, 3.5, s * 30, 45, 10], [s * 48, 3.7, s * 14, 55, 12],
  ]),
};
