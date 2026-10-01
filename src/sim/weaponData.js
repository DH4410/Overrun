/** Weapon tuning and inventory definitions shared by player, bots, HUD, and tests. */
/**
 * === PLAYER ACCURACY MODEL ===
 *
 * `spread` is still the cone fireWeapon() applies by default, and the bots still drive it
 * through their own aim profile (see AIM in bots.js). The PLAYER no longer uses it. A single
 * multiplied cone cannot express the thing that makes a tactical shooter feel tactical: that
 * standing still and tapping is pinpoint, and that moving, jumping or holding the trigger is
 * not. So the player's cone is built additively from these, in radians:
 *
 *   rest   — standing, settled, first shot. Small enough to be effectively pinpoint.
 *   move   — per m/s of planar speed. Walking is survivable; sprinting is not.
 *   air    — flat penalty while off the ground. Jump-peeking should not be free.
 *   bloomStep / bloomMax / bloomDecay — spray cost per shot, its ceiling, and how fast it
 *            recovers once you let go. This is what makes bursting beat holding.
 *
 * `pattern` is the recoil the gun kicks per shot, as [yaw, pitch] multiples of `recoil`,
 * indexed by shot number and held at the last entry. Deterministic on purpose: a pattern can
 * be learned and pulled against, where the old random kick could only be endured.
 */
export const WEAPONS = [
  {
    id: 'pistol', name: 'PISTOL', slot: 1, auto: false,
    damage: 15, speed: 400, cooldown: 0.22, mag: 15, reserve: 90, reload: 1.2,
    spread: 0.006, pellets: 1, recoil: 0.017, kick: 0.05, zoom: false,
    rest: 0.0016, move: 0.010, air: 0.050,
    bloomStep: 0.0040, bloomMax: 0.030, bloomDecay: 0.090,
    pattern: [[0, 1], [0.2, 0.9], [-0.3, 0.8], [0.35, 0.7]],
    color: 0x2b3038, sound: 'pistol',
  },
  {
    id: 'ar', name: 'ASSAULT RIFLE', slot: 2, auto: true,
    damage: 26, speed: 380, cooldown: 0.09, mag: 30, reserve: 180, reload: 2.0,
    spread: 0.025, pellets: 1, recoil: 0.014, kick: 0.045, zoom: false,
    rest: 0.0018, move: 0.013, air: 0.070,
    bloomStep: 0.0035, bloomMax: 0.042, bloomDecay: 0.110,
    // Climbs hard for the first eight, then breaks left and right — the classic shape, so
    // the counter is the classic one: burst, or pull down and counter the sway.
    pattern: [
      [0, 1.0], [0, 1.15], [0, 1.25], [0.1, 1.2], [0.25, 1.05], [0.45, 0.9],
      [0.3, 0.7], [-0.15, 0.6], [-0.55, 0.5], [-0.8, 0.45], [-0.6, 0.4],
      [-0.1, 0.4], [0.5, 0.4], [0.8, 0.4], [0.5, 0.35], [-0.2, 0.35],
    ],
    color: 0x33372f, sound: 'ar',
  },
  {
    // Built to be used on the move: the lightest movement penalty of the automatics and the
    // fastest rate of fire, paid for with damage that falls behind the rifle past close range.
    id: 'smg', name: 'SMG', slot: 2, auto: true,
    damage: 17, speed: 360, cooldown: 0.066, mag: 30, reserve: 210, reload: 1.7,
    spread: 0.035, pellets: 1, recoil: 0.009, kick: 0.03, zoom: false,
    rest: 0.0040, move: 0.0065, air: 0.045,
    bloomStep: 0.0028, bloomMax: 0.050, bloomDecay: 0.150,
    pattern: [
      [0, 1.0], [0.15, 1.0], [-0.2, 0.95], [0.3, 0.9], [-0.35, 0.85], [0.4, 0.8],
      [-0.4, 0.75], [0.35, 0.7], [-0.3, 0.7], [0.25, 0.65],
    ],
    color: 0x2a2d31, sound: 'smg',
  },
  {
    id: 'shotgun', name: 'SHOTGUN', slot: 3, auto: false,
    damage: 10, speed: 280, cooldown: 0.9, mag: 8, reserve: 40, reload: 2.5,
    spread: 0.08, pellets: 8, recoil: 0.06, kick: 0.16, zoom: false,
    // `rest` IS the pellet pattern here, not an error term — a shotgun is supposed to
    // spread. Moving barely matters for the same reason.
    rest: 0.0750, move: 0.012, air: 0.050,
    bloomStep: 0.0020, bloomMax: 0.020, bloomDecay: 0.080,
    pattern: [[0, 1], [0.4, 0.9], [-0.4, 0.9]],
    color: 0x4a3123, sound: 'shotgun',
  },
  {
    id: 'sniper', name: 'SNIPER RIFLE', slot: 4, auto: false,
    // 110 so a body shot kills an unarmoured target, which is the sniper's whole job.
    damage: 110, speed: 700, cooldown: 1.4, mag: 5, reserve: 25, reload: 2.8,
    spread: 0.0015, pellets: 1, recoil: 0.075, kick: 0.2, zoom: true, zoomFov: 25,
    // The heaviest movement penalty in the game: a sniper that can be run-and-gunned makes
    // every other gun pointless.
    rest: 0.0006, move: 0.030, air: 0.120,
    bloomStep: 0.0200, bloomMax: 0.060, bloomDecay: 0.150,
    pattern: [[0, 1]],
    color: 0x232a24, sound: 'sniper',
  },
  {
    id: 'frag', name: 'FRAG GRENADE', slot: 5, auto: false,
    damage: 0, speed: 0, cooldown: 0.8, mag: 3, reserve: 0, reload: 0,
    spread: 0, pellets: 0, recoil: 0, kick: 0, zoom: false,
    color: 0x3d4a33, sound: 'pistol', thrown: true,
  },
];

export const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map((weapon) => [weapon.id, weapon]));

/** Aiming tightens the cone; it does not remove the movement or spray penalty. */
export const ADS_SPREAD_MULT = 0.45;
/** Crouching steadies the gun — the cheapest way to convert movement error into accuracy. */
export const CROUCH_SPREAD_MULT = 0.70;

/**
 * The player's absolute firing cone in radians, from the additive model above.
 *
 * Returned as an absolute angle rather than a multiplier on `weapon.spread`, because the
 * whole point is that a settled tap is far tighter than the gun's nominal cone while a
 * sprinting spray is far wider — a single multiplier cannot span both.
 */
export function playerSpread(weapon, { speed = 0, grounded = true, aiming = false, crouching = false, bloom = 0 }) {
  if (!weapon || weapon.rest === undefined) return weapon?.spread ?? 0;
  let cone = weapon.rest + speed * weapon.move + bloom;
  if (!grounded) cone += weapon.air;
  if (crouching) cone *= CROUCH_SPREAD_MULT;
  if (aiming) cone *= ADS_SPREAD_MULT;
  return cone;
}

/** Recoil for shot `index` of a burst, as [yaw, pitch] multiples of `weapon.recoil`. */
export function recoilStep(weapon, index) {
  const pattern = weapon.pattern;
  if (!pattern || !pattern.length) return [0, 1];
  return pattern[Math.min(index, pattern.length - 1)];
}

/** Slots 1-4 are the guns bots may spawn with. */
export const BOT_GUN_IDS = ['pistol', 'ar', 'shotgun', 'sniper'];
