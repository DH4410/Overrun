import * as THREE from 'three';

import { MAP_DATA } from './sim/mapData.js';

/**
 * PORT: a container port in daylight, modelled in Blender (scripts/blender/build_port.py).
 * Loaded by src/mapGlb.js; this file is only what differs from the other Blender maps.
 *
 * The rules the layout follows:
 *  - Heights are chosen for movement. Crates are 1.0 m, which a jump clears; containers are
 *    2.59 m, which it does not, so they are walls. The dock is 1.4 m: up by ramp, or by jumping
 *    off the crate beside it.
 *  - Daylight. A target is read by silhouette and contrast; a sunlit yard reads at 60 m where a
 *    dim warehouse loses you at 20.
 *  - 180-degree rotational symmetry, so a duel is decided by the players. Three lanes: a
 *    warehouse flank, the plaza round the dock, a container-yard flank.
 *
 * Units are metres; +Z is south.
 */
export const PORT = {
  ...MAP_DATA.port,
  id: 'port',
  file: 'port',
  name: 'PORT',
  blurb: 'Container port in daylight. A raised dock in the middle, a yard and a warehouse on each flank.',
  mapView: 46,
  plates: { ground: 0x2c3238, solid: 0x9aa7b3 },

  /** One Poly Haven material per mesh. The GLB's UVs are metres / tile size, so repeat is 1. */
  materials(pbrMat) {
    const decal = (n) => ({ polygonOffset: true, polygonOffsetFactor: -n, polygonOffsetUnits: -n });
    return {
      asphalt: pbrMat('asphalt_02', { repeat: 1, ao: true, fallback: 0x4d5054, rough: 0.95 }),
      apron: pbrMat('concrete_floor_01', { repeat: 1, ao: true, fallback: 0x9a968e, rough: 0.9 }),
      slab: pbrMat('concrete_pavement', { repeat: 1, ao: true, fallback: 0x8f8c86, rough: 0.9, extra: decal(1) }),
      wall: pbrMat('concrete_slab_wall', { repeat: 1, ao: true, fallback: 0xa19d95, rough: 0.92 }),
      barrier: pbrMat('rough_concrete', { repeat: 1, ao: true, fallback: 0xaaa69c, rough: 0.95 }),
      cladding: pbrMat('factory_wall', { repeat: 1, ao: true, fallback: 0x56705a, rough: 0.6, metal: 0.3 }),
      roof: pbrMat('box_profile_metal_sheet', { repeat: 1, ao: true, fallback: 0x6b4038, rough: 0.6, metal: 0.3 }),
      wood: pbrMat('plywood', { repeat: 1, ao: true, fallback: 0xa07c52, rough: 0.8 }),
      // Container paint: the colour is per container (vertex colours from the GLB); the texture
      // only adds its scratches and grime, as luminance.
      paint: pbrMat('green_metal_rust', {
        repeat: 1, fallback: 0xffffff, rough: 0.55, metal: 0.25, detail: true, extra: { vertexColors: true },
      }),
      yellow: pbrMat('green_metal_rust', { repeat: 1, ao: true, fallback: 0xd29a1c, rough: 0.55, metal: 0.25, detail: true }),
      steel: new THREE.MeshStandardMaterial({ color: 0x5b6167, roughness: 0.45, metalness: 0.6 }),
      lines: new THREE.MeshStandardMaterial({ color: 0xd9b23a, roughness: 0.85, ...decal(2) }),
      linesW: new THREE.MeshStandardMaterial({ color: 0xd6d8d4, roughness: 0.85, ...decal(2) }),
      lamp: new THREE.MeshBasicMaterial({ color: 0xfff1d6 }),
      far: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.1, vertexColors: true }),
      water: new THREE.MeshStandardMaterial({ color: 0x27414b, roughness: 0.25, metalness: 0.1 }),
    };
  },
  /** Meshes that stay out of the shadow pass: decals, emitters, and everything past the wall. */
  noCast: ['asphalt', 'slab', 'lines', 'linesW', 'lamp', 'far', 'water'],

  look: {
    background: 0xc9dcea,
    fog: { color: 0xc3d2dd, near: 50, far: 300 },
    // The sky dome draws the sun at sunDir; the shadow-casting sun sits along the same line.
    sky: { top: 0x4f86c0, horizon: 0xc9dcea, ground: 0x8e8a80, sunDir: [-0.45, 0.72, 0.52], cover: 0.28 },
    env: 0.55,
    lighting: {
      ambient: { color: 0xc4d7ea, intensity: 0.25 },
      hemi: { sky: 0xbcd6f0, ground: 0x6d675b, intensity: 0.6 },
      sun: { color: 0xfff0d8, intensity: 2.4, pos: [-40, 64, 46] },
    },
  },

  // The sheds and warehouses have roofs, so the sun does not reach inside.
  lamps: [1, -1].flatMap((s) => [
    [s * -7, 5.4, s * 32.5, 90, 22], [s * 7, 5.4, s * 32.5, 90, 22],
    [s * -39, 5.4, s * 11, 110, 20], [s * -27, 5.4, s * 18, 110, 20],
  ]),
};
