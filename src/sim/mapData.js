/**
 * The gameplay half of each Blender map: its extent, the height ground-finding casts start
 * below, spawn candidates and pickup spots. Pure data, shared by the browser's map definitions
 * (src/mapPort.js, mapDesert.js, mapSnow.js spread it in) and the multiplayer server.
 */
export const MAP_DATA = {
  port: {
    id: 'port',
    file: 'port',
    half: [50, 38],
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
    half: [42, 32],
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
    half: [44, 34],
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
};

export const MAP_IDS = Object.keys(MAP_DATA);
