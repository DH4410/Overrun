import * as THREE from 'three';

import { MAP_DATA } from './sim/mapData.js';
import { typeAtlas } from './typeAtlas.js';

/**
 * DEPOT: a warehouse hall for the one-on-one duel, modelled in Blender (scripts/blender/build_depot.py).
 * Loaded by src/mapGlb.js; this file is only what differs from the other Blender maps.
 *
 * 36 by 52 m under one roof at 7.0 m (which is ceilY): a raised steel deck in the middle with a ramp
 * at each end, a lane down each side (containers, racking, crates, a roofless site office), and a
 * roller door behind each spawn. 180-degree rotational symmetry. Lit from within: a weak sun comes
 * through the skylights and hanging lamps do the rest.
 *
 * Units are metres; +Z is south.
 */
export const DEPOT = {
  ...MAP_DATA.depot,
  id: 'depot',
  file: 'depot',
  name: 'DEPOT',
  blurb: 'A warehouse hall, 36 by 52 metres. A raised deck in the middle, a lane down each side. Made for the duel.',
  mapView: 60,
  shadowExtent: 32,
  plates: { ground: 0x24262a, solid: 0x9a9a94 },

  /** One Poly Haven material per mesh. The GLB's UVs are metres / tile size, so repeat is 1. */
  materials(pbrMat) {
    const decal = (n) => ({ polygonOffset: true, polygonOffsetFactor: -n, polygonOffsetUnits: -n });
    // Block, concrete, steel, timber and plaster also carry vertex colours: dirt gathered at the
    // foot and soft patches (the wear pass in roundkit_dh.py). Every key that has them has them on
    // every mesh, or a mesh without would draw black.
    const worn = { vertexColors: true };
    return {
      cmu: pbrMat('concrete_slab_wall', { repeat: 1, ao: true, fallback: 0x8f8d86, rough: 0.92, extra: worn }),
      concrete: pbrMat('rough_concrete', { repeat: 1, ao: true, fallback: 0x8c8a84, rough: 0.95, extra: worn }),
      // precast and dressed detail (plinths, capitals, cornices, hoods): no collider
      trim: pbrMat('rough_concrete', { repeat: 1, ao: true, fallback: 0xa5a4a0, rough: 0.9, detail: true, extra: worn }),
      // pipes, ducts, hangers, frames, housings and hinges: dark painted steel
      metal: new THREE.MeshStandardMaterial({ color: 0x3b3e42, roughness: 0.55, metalness: 0.45, vertexColors: true }),
      floor: pbrMat('concrete_floor_damaged_01', { repeat: 1, ao: true, fallback: 0x625f59, rough: 0.9 }),
      lines: new THREE.MeshStandardMaterial({ color: 0xcdb866, roughness: 0.85, ...decal(2) }),
      roof: pbrMat('corrugated_iron_02', { repeat: 1, ao: true, fallback: 0x6b6a68, rough: 0.6, metal: 0.3 }),
      steel: pbrMat('metal_plate', { repeat: 1, ao: true, fallback: 0x575b5f, rough: 0.5, metal: 0.6, extra: worn }),
      rail: new THREE.MeshStandardMaterial({ color: 0x4a4e52, roughness: 0.5, metalness: 0.6, vertexColors: true }),
      wood: pbrMat('weathered_planks', { repeat: 1, ao: true, fallback: 0x76583c, rough: 0.85, extra: worn }),
      stucco: pbrMat('peeling_painted_wall', { repeat: 1, ao: true, fallback: 0xb5a584, rough: 0.9, extra: worn }),
      plaster: pbrMat('plastered_wall_03', { repeat: 1, ao: true, fallback: 0xc2bba8, rough: 0.9, detail: true, extra: worn }),
      container: pbrMat('box_profile_metal_sheet', { repeat: 1, ao: true, fallback: 0xffffff, rough: 0.55, metal: 0.3, detail: true, extra: { vertexColors: true } }),
      // hazard stripes, extinguishers, signs and column bands: the colour is per face
      paint: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, vertexColors: true, ...decal(1) }),
      dark: new THREE.MeshStandardMaterial({ color: 0x0d1114, roughness: 0.9, ...decal(1) }),
      glow: new THREE.MeshBasicMaterial({ color: 0xffd9a0 }),      skylight: new THREE.MeshBasicMaterial({ color: 0xcfe4ff }),
      // The detail pass, coloured per piece by the GLB: hardware, matte paint (Lambert is the
      // cheaper shader and looks the same on it) and lamp lenses and sign text, which are unlit.
      fit: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.5, vertexColors: true }),
      mark: new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, ...decal(3) }),
      glyph: new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, ...decal(4) }),
      // Sign text, a quad per character sampling the glyph atlas: painted (lit) and lamp (unlit).
      tmark: new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, map: typeAtlas(), alphaTest: 0.4, ...decal(5) }),
      tglyph: new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, map: typeAtlas(), alphaTest: 0.4, ...decal(6) }),
    };
  },
  /** The roof stays out of the shadow pass so the sun reaches the floor through it; so do the small fittings and the paint. */
  noCast: ['floor', 'lines', 'dark', 'glow', 'skylight', 'roof', 'fit', 'mark', 'glyph', 'tmark', 'tglyph'],

  look: {
    background: 0x15181c,
    fog: { color: 0x1b1f24, near: 40, far: 140 },
    // Never seen from inside the hall, but the PMREM environment comes from it: it is what lifts the
    // steel, the corrugated roof and the container skins, which are all metallic.
    sky: {
      top: 0x7e8793, horizon: 0xa59f93, ground: 0x6a6258, sunDir: [-0.3, 0.8, -0.5],
      cover: 0, sunColor: 0xcfe0f5, haze: 0.2,
    },
    env: 0.9,
    lighting: {
      ambient: { color: 0xc4ccd6, intensity: 0.5 },
      hemi: { sky: 0xc4d2e4, ground: 0xa09484, intensity: 0.75 },
      sun: { color: 0xdbe6f5, intensity: 1.3, pos: [-14, 40, -18] },
    },
  },

  // Hanging lamps over the hall: the same seven the model has, a little under each fitting.
  lamps: [
    [0, 5.2, 0, 60, 22], [0, 5.2, 12, 55, 20], [0, 5.2, -12, 55, 20],
    [-9, 5.2, 6, 50, 18], [9, 5.2, -6, 50, 18], [9, 5.2, 18, 50, 18], [-9, 5.2, -18, 50, 18],
  ],
};
