import * as THREE from 'three';

/**
 * SNOW: a research outpost in a mountain valley at the end of a winter afternoon, modelled in
 * Blender (scripts/blender/build_snow.py). Loaded by src/mapGlb.js; this file is only what
 * differs from the other Blender maps.
 *
 * The layout: a fenced spawn yard at each end, a container across each approach road, and a
 * frozen pond round a radio mast in the middle. Each flank has a walk-through research station
 * at one end and an open-fronted garage at the other. 180-degree rotational symmetry, so a duel
 * starts from two identical ends. The station and garage roofs are at 4.0 m, which is ceilY.
 *
 * Units are metres; +Z is south.
 */
export const SNOW = {
  id: 'snow',
  file: 'snow',
  name: 'SNOW',
  blurb: 'Research outpost at the end of a winter afternoon. A frozen pond in the middle, a station and a garage on each flank.',
  half: [44, 34],
  /** The station and garage roofs start at 4.0 m; a cast from above them lands on top. */
  ceilY: 4.0,
  mapView: 44,
  plates: { ground: 0x2a3036, solid: 0xc9d2da },

  /** One Poly Haven material per mesh. The GLB's UVs are metres / tile size, so repeat is 1. */
  materials(pbrMat) {
    const decal = (n) => ({ polygonOffset: true, polygonOffsetFactor: -n, polygonOffsetUnits: -n });
    // The snows, the cladding and the paint keep a chosen colour and take only their texture's
    // detail, so the base stays one palette whatever each scan's own tint.
    const snow = pbrMat('snow_02', { repeat: 1, ao: true, fallback: 0xe4e9ef, rough: 0.9, detail: true });
    const steel = pbrMat('metal_plate', { repeat: 1, ao: true, fallback: 0x5a5e62, rough: 0.5, metal: 0.6 });
    return {
      snow,
      drift: snow,
      snowcap: pbrMat('snow_01', { repeat: 1, ao: true, fallback: 0xeef1f5, rough: 0.85, detail: true }),
      berm: pbrMat('snow_01', { repeat: 1, ao: true, fallback: 0xdde4eb, rough: 0.9, detail: true }),
      track: pbrMat('asphalt_snow', { repeat: 1, ao: true, fallback: 0x8d9296, rough: 0.9, extra: decal(1) }),
      ice: new THREE.MeshStandardMaterial({ color: 0x9fb8c9, roughness: 0.12, ...decal(1) }),
      concrete: pbrMat('concrete_wall_006', { repeat: 1, ao: true, fallback: 0x8c8b87, rough: 0.9 }),
      floor: pbrMat('concrete_floor_worn_001', { repeat: 1, ao: true, fallback: 0x74736f, rough: 0.9, extra: decal(1) }),
      red: pbrMat('corrugated_iron_02', { repeat: 1, ao: true, fallback: 0x9c2f24, rough: 0.6, metal: 0.3, detail: true }),
      ochre: pbrMat('corrugated_iron_02', { repeat: 1, ao: true, fallback: 0xc28a2e, rough: 0.6, metal: 0.3, detail: true }),
      grey: pbrMat('corrugated_iron', { repeat: 1, ao: true, fallback: 0x6e767c, rough: 0.55, metal: 0.4, detail: true }),
      lining: pbrMat('plastered_wall_03', { repeat: 1, ao: true, fallback: 0xd8d2c4, rough: 0.9, detail: true }),
      steel,
      rail: steel,
      tank: pbrMat('rusty_metal_sheet', { repeat: 1, ao: true, fallback: 0xd6d6d0, rough: 0.6, metal: 0.2, detail: true }),
      // Containers, fir needles, paint and the backdrop: the colour is per face (vertex colours).
      container: pbrMat('box_profile_metal_sheet', { repeat: 1, ao: true, fallback: 0xffffff, rough: 0.55, metal: 0.3, detail: true, extra: { vertexColors: true } }),
      wood: pbrMat('weathered_planks', { repeat: 1, ao: true, fallback: 0x76583c, rough: 0.85 }),
      trunk: pbrMat('rough_wood', { repeat: 1, ao: true, fallback: 0x5a4636, rough: 0.95 }),
      fir: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, vertexColors: true, side: THREE.DoubleSide }),
      paint: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, vertexColors: true }),
      far: pbrMat('snow_02', { repeat: 1, fallback: 0xffffff, rough: 0.95, detail: true, extra: { vertexColors: true } }),
      black: new THREE.MeshStandardMaterial({ color: 0x161718, roughness: 0.8 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x0d1114, roughness: 0.9, ...decal(1) }),
      glow: new THREE.MeshBasicMaterial({ color: 0xffd9a0 }),
    };
  },
  /** Meshes that stay out of the shadow pass: ground, decals, emitters, and everything past the fence. */
  noCast: ['snow', 'drift', 'track', 'ice', 'floor', 'dark', 'glow', 'far'],

  look: {
    background: 0xd9d6d8,
    fog: { color: 0xd6d8de, near: 40, far: 260 },
    // A low sun in the south-west going down: long shadows, warm light on the snow, blue shade.
    sky: {
      top: 0x4a74ad, horizon: 0xf1cfae, ground: 0xc9d0d8, sunDir: [0.55, 0.4, -0.73],
      cover: 0.25, sunColor: 0xffc890, haze: 1.6,
    },
    env: 0.55,
    lighting: {
      ambient: { color: 0xc8d4e6, intensity: 0.25 },
      hemi: { sky: 0xb9cbe6, ground: 0xe6dcd2, intensity: 0.6 },
      sun: { color: 0xffd2a0, intensity: 2.4, pos: [48, 35, -64] },
    },
  },

  /**
   * Mirrored spawn candidates, listed in pairs. Each clears buildSpawnPoints' 2 m blocker pad,
   * checked against the built layout: four in each spawn yard, the rest spread over the pond, the
   * approaches, both station rooms and the garage yards, so "furthest from every enemy" has
   * somewhere to choose from in deathmatch.
   */
  spawns: [
    [0, 28], [0, -28], [-2.5, 30.3], [2.5, -30.3], [2.5, 30.3], [-2.5, -30.3], [0, 25.8], [0, -25.8],
    [-10.5, 25.9], [10.5, -25.9], [10.5, 25.9], [-10.5, -25.9], [-6.5, 20.4], [6.5, -20.4],
    [6.8, 11], [-6.8, -11], [6.5, -1], [-6.5, 1], [24.5, 4], [-24.5, -4], [38.5, -1], [-38.5, 1],
    [22.8, 12.3], [-22.8, -12.3], [33.5, 12.3], [-33.5, -12.3], [32, 18.7], [-32, -18.7],
    [22, 20], [-22, -20], [-27, 11.6], [27, -11.6], [-17, 26], [17, -26],
  ],
  // Ammo in the station halls, the garages and behind the approach containers; health and
  // shield out on the flanks and by the mast.
  ammo: [
    [28, 10.2], [-28, -10.2], [-29, 16.5], [29, -16.5], [0, 20.8], [0, -20.8], [27, 7], [-27, -7],
  ],
  consumables: [
    ['health', 24, 23.5], ['health', -24, -23.5], ['shield', 0, 5.8], ['shield', 0, -5.8],
    ['health', -33, 22.9], ['health', 33, -22.9], ['shield', 36.8, -4.5], ['shield', -36.8, 4.5],
  ],
  // Under the station and garage roofs: one in each station room and hall, one in each garage.
  lamps: [1, -1].flatMap((s) => [
    [s * 22, 3.6, s * 12.5, 60, 12], [s * 34, 3.6, s * 12.5, 60, 12],
    [s * 28, 3.6, s * 12.5, 60, 12], [s * -29, 3.6, s * 19, 60, 12],
  ]),
};
