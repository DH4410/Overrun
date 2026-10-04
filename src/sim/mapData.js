/**
 * The gameplay half of each Blender map: its extent, the height ground-finding casts start
 * below, spawn candidates and pickup spots. Pure data, shared by the browser's map definitions
 * (src/mapPort.js, mapDesert.js, mapSnow.js spread it in) and the multiplayer server.
 */
export const MAP_DATA = {
  port: {
    id: 'port',
    file: 'port',
    modes: ['dm', 'tdm', 'sv', 'duel', 'ctf'],
    half: [50, 38],
    /** Flag stands (blue, red) in the middle of each spawn shed; also where each side's spawns are. */
    flags: [[0, 31], [0, -31]],
    /**
     * Spawn, pickup and nav casts start just below this, and it must be under every roof: the spawn
     * sheds' roofs start at y = 6.0, and a cast from above them would put the spawns on the roof.
     * Stacked containers top out at 5.18 m, safely below the cast.
     */
    ceilY: 6.0,
    /**
     * Mirrored spawn candidates, listed in pairs. Each clears buildSpawnPoints' 2 m blocker pad,
     * checked against the built layout: four in each spawn shed, the rest spread over the flanks so
     * "furthest from every enemy" has somewhere to choose from in deathmatch.
     */
    spawns: [
      [0, 31], [0, -31], [-5, 33], [5, -33], [5, 33], [-5, -33], [-12, 31], [12, -31],
      [-34, 34], [34, -34], [46, 34], [-46, -34], [-46, 3], [46, -3],
      [26, 20], [-26, -20], [-34, 16], [34, -16], [44, 16], [-44, -16], [-17, 21], [17, -21],
    ],
    // Ammo in the lanes, health and shield out on the flanks.
    ammo: [
      [3.5, 15.5], [-3.5, -15.5], [17.5, 0], [-17.5, 0],
      [26, 21], [-26, -21], [-30, 16], [30, -16],
    ],
    consumables: [
      ['health', 40, 1], ['health', -40, -1],
      ['shield', -33, 13], ['shield', 33, -13],
      ['health', 0, 0], ['shield', 17, 25], ['shield', -17, -25],
    ],
  },
  desert: {
    id: 'desert',
    file: 'desert',
    modes: ['dm', 'tdm', 'sv', 'duel', 'ctf'],
    half: [42, 32],
    flags: [[0, 26.5], [0, -26.5]],
    /** The arcade roofs and the souk slats start at 4.2 m; a cast from above them lands on top. */
    ceilY: 4.2,
    /**
     * Mirrored spawn candidates, listed in pairs. Each clears buildSpawnPoints' 2 m blocker pad,
     * checked against the built layout: five in each spawn yard, the rest spread over the souk and
     * the yard so "furthest from every enemy" has somewhere to choose from in deathmatch.
     */
    spawns: [
      [0, 26.5], [0, -26.5], [-4.6, 27.6], [4.6, -27.6], [4.6, 27.4], [-4.6, -27.4], [-3.5, 24.4], [3.5, -24.4],
      [3.5, 24.4], [-3.5, -24.4], [-30.5, 23.75], [30.5, -23.75], [-38.4, 4.0], [38.4, -4.0],
      [-18.5, 10.6], [18.5, -10.6], [38.5, 19.5], [-38.5, -19.5], [28.5, 1.8], [-28.5, -1.8],
      [24.2, 24.6], [-24.2, -24.6], [34.5, 2.5], [-34.5, -2.5], [-6.5, 1.2], [6.5, -1.2],
    ],
    // Ammo under the arcades and in the souk, health and shield out on the flanks.
    ammo: [
      [-1.5, 12.2], [1.5, -12.2], [-22.6, 13.8], [22.6, -13.8],
      [29.0, 8.5], [-29.0, -8.5], [37.0, 25.6], [-37.0, -25.6],
    ],
    consumables: [
      ['health', -40, 22.5], ['health', 40, -22.5], ['shield', 26.5, 22.4], ['shield', -26.5, -22.4],
      ['health', -15.5, 4.5], ['health', 15.5, -4.5], ['shield', 9.0, 11.8], ['shield', -9.0, -11.8],
    ],
  },
  snow: {
    id: 'snow',
    file: 'snow',
    modes: ['dm', 'tdm', 'sv', 'duel', 'ctf'],
    half: [44, 34],
    flags: [[0, 28], [0, -28]],
    /** The station and garage roofs start at 4.0 m; a cast from above them lands on top. */
    ceilY: 4.0,
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
  },
  warzone: {
    id: 'warzone',
    file: 'warzone',
    /** The big map: only the deathmatches, the endless one above all. */
    modes: ['dm', 'tdm', 'war'],
    half: [70, 50],
    flags: [[0, 44], [0, -44]],
    /** Every roof is at 4.0 m; a cast from above them lands on top. */
    ceilY: 4.0,
    /**
     * Mirrored spawn candidates, listed in pairs and picked from the built layout (2 m clear of every
     * blocker, floor at ground level): the first six pairs are in the two walled bases, the rest are
     * spread by furthest-point sampling over the districts, the boulevard and the plaza.
     */
    spawns: [
      [0, 45.5], [0, -45.5], [1.5, 45.5], [-1.5, -45.5], [-3, 44], [3, -44],
      [3, 44], [-3, -44], [-3, 42.5], [3, -42.5], [3, 42.5], [-3, -42.5],
      [-66, 0.5], [66, -0.5], [51, 45.5], [-51, -45.5], [-58.5, 45.5], [58.5, -45.5],
      [-19.5, 0.5], [19.5, -0.5], [-34.5, 27.5], [34.5, -27.5], [33, 24.5], [-33, -24.5],
      [1.5, 17], [-1.5, -17], [-63, 23], [63, -23], [-43.5, 0.5], [43.5, -0.5],
      [25.5, 45.5], [-25.5, -45.5], [55.5, 18.5], [-55.5, -18.5], [-24, 45.5], [24, -45.5],
      [-16.5, 21.5], [16.5, -21.5], [15, 29], [-15, -29], [-42, 44], [42, -44],
      [-33, 12.5], [33, -12.5], [66, 44], [-66, -44], [4.5, 0.5], [-4.5, -0.5],
      [-48, 23], [48, -23], [15, 14], [-15, -14],
    ],
    ammo: [
      [40.5, 36.5], [-40.5, -36.5], [42, 14], [-42, -14], [-66, 35], [66, -35],
      [-51, 11], [51, -11], [-21, 33.5], [21, -33.5], [54, 6.5], [-54, -6.5],
      [-9, 30.5], [9, -30.5],
    ],
    consumables: [
      ['health', -9, 12.5], ['shield', 9, -12.5], ['health', -66, 12.5], ['shield', 66, -12.5],
      ['health', 49.5, 27.5], ['shield', -49.5, -27.5], ['health', 57, 36.5], ['shield', -57, -36.5],
      ['health', -46.5, 33.5], ['shield', 46.5, -33.5], ['health', -33, 38], ['shield', 33, -38],
      ['health', -31.5, 2], ['shield', 31.5, -2], ['health', 66, 17], ['shield', -66, -17],
      ['health', 30, 36.5], ['shield', -30, -36.5],
    ],
  },
  depot: {
    id: 'depot',
    file: 'depot',
    /** The small map: a warehouse hall built for the one-on-one duel and the quick deathmatches. */
    modes: ['duel', 'dm', 'tdm'],
    half: [18, 26],
    flags: [[0, 21], [0, -21]],
    /** The roof's underside is at 7.0 m; a cast from above it would land on the roof slab. */
    ceilY: 7.0,
    /**
     * Mirrored spawn candidates, listed in pairs and picked from the built layout (2 m clear of every
     * blocker, floor at ground level): the first four pairs sit in the two spawn ends, the rest are
     * spread by furthest-point sampling over the lanes and round the stage.
     */
    spawns: [
      [0, 21], [0, -21], [-1.5, 22], [1.5, -22], [1.5, 22], [-1.5, -22], [0, 19.5], [0, -19.5],
      [-14.5, 0], [14.5, 0], [5, -9], [-5, 9], [-7, -9], [7, 9], [-8.5, 3], [8.5, -3],
      [-2.5, -15], [2.5, 15], [-8.5, -15], [8.5, 15],
    ],
    ammo: [
      [-8.5, -4.5], [8.5, 4.5], [2, -15], [-2, 15], [-5.5, -22.5], [5.5, 22.5], [-5.5, 22.5], [5.5, -22.5],
    ],
    consumables: [
      ['health', -8.5, 7.5], ['health', 8.5, -7.5], ['shield', 5, 10.5], ['shield', -5, -10.5],
      ['health', 9.5, -1.5], ['health', -9.5, 1.5],
    ],
  },
  bastion: {
    id: 'bastion',
    file: 'bastion',
    /** The capture-the-flag map: two stone keeps and the grass between them. */
    modes: ['ctf', 'dm', 'tdm'],
    half: [32, 55],
    /** Each flag stands on its plinth at the back of its keep's flag hall. */
    flags: [[0, 49.8], [0, -49.8]],
    /** The flag halls' roofs are at 4.6 m; a cast from above them lands on the roof slab. */
    ceilY: 4.6,
    /**
     * Mirrored spawn candidates, listed in pairs and picked from the built layout (2 m clear of every
     * blocker, floor at ground level): the first six pairs are in the two keeps, the rest are spread
     * by furthest-point sampling over the field, the trails and the groves.
     */
    spawns: [
      [0, 46], [0, -46], [-19.5, 50.5], [19.5, -50.5], [19.5, 50.5], [-19.5, -50.5],
      [0, 43], [0, -43], [-4, 50.5], [4, -50.5], [4, 50.5], [-4, -50.5], [-12, 43], [12, -43],
      [-28.5, -0.5], [28.5, 0.5], [28.5, -32], [-28.5, 32], [28.5, 32.5], [-28.5, -32.5],
      [-4.5, 16], [4.5, -16], [-16.5, -17], [16.5, 17], [-10.5, -0.5], [10.5, 0.5],
      [-22.5, 16], [22.5, -16], [7.5, 31], [-7.5, -31], [-12, 31], [12, -31],
      [28.5, 13], [-28.5, -13], [18, 37], [-18, -37], [-6, -20], [6, 20],
      [-19.5, -6.5], [19.5, 6.5], [-27, -23], [27, 23], [-1.5, 35.5], [1.5, -35.5],
    ],
    ammo: [
      [25.5, 29.5], [-25.5, -29.5], [-24, 28], [24, -28], [-4.5, -14], [4.5, 14], [-19.5, 46], [19.5, -46],
    ],
    consumables: [
      ['health', -21, -50], ['health', 21, 50], ['shield', -16.5, 11.5], ['shield', 16.5, -11.5],
      ['health', 21, 14.5], ['health', -21, -14.5], ['shield', -12, -36.5], ['shield', 12, 36.5],
    ],
  },
};

export const MAP_IDS = Object.keys(MAP_DATA);
