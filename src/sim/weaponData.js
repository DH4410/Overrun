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
    damage: 20, botDamage: 15, falloff: [18, 45, 0.6],
    speed: 400, cooldown: 0.22, mag: 15, reserve: 90, reload: 1.2,
    spread: 0.006, pellets: 1, recoil: 0.017, kick: 0.05, zoom: false,
    rest: 0.0016, move: 0.010, air: 0.050,
    bloomStep: 0.0040, bloomMax: 0.030, bloomDecay: 0.090,
    pattern: [[0, 1], [0.2, 0.9], [-0.3, 0.8], [0.35, 0.7]],
    color: 0x2b3038, sound: 'pistol',
  },
  {
    id: 'ar', name: 'ASSAULT RIFLE', slot: 2, auto: true,
    damage: 24, botDamage: 26, falloff: [25, 70, 0.7],
    speed: 380, cooldown: 0.09, mag: 30, reserve: 180, reload: 2.0,
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
    damage: 18, botDamage: 17, falloff: [10, 38, 0.5],
    speed: 360, cooldown: 0.066, mag: 30, reserve: 210, reload: 1.7,
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
    // 8 pellets of 19 is 152 at point-blank: a full load kills a fresh 100 + 50 spawn in one
    // shot, and the falloff takes it to a fifth of that by 16 m.
    damage: 19, botDamage: 10, falloff: [5, 16, 0.2],
    speed: 280, cooldown: 0.9, mag: 8, reserve: 40, reload: 2.5,
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
    // 150 so a body shot kills a fresh 100 + 50 spawn, which is the sniper's whole job. A full
    // 100 shield on top of 100 health takes two, or one to the head.
    damage: 150, botDamage: 110, falloff: null,
    speed: 700, cooldown: 1.4, mag: 5, reserve: 25, reload: 2.8,
    spread: 0.0015, pellets: 1, recoil: 0.075, kick: 0.2, zoom: true, zoomFov: 25,
    // The heaviest movement penalty in the game: a sniper that can be run-and-gunned makes
    // every other gun pointless.
    rest: 0.0006, move: 0.030, air: 0.120,
    bloomStep: 0.0200, bloomMax: 0.060, bloomDecay: 0.150,
    pattern: [[0, 1]],
    color: 0x232a24, sound: 'sniper',
  },
  {
    // Two shots to the body, one to the head, and a slow hammer between them. Heavy kick
    // and a wide bloom: a second shot fired in a hurry misses.
    id: 'revolver', name: 'REVOLVER', slot: 1, auto: false,
    damage: 56, speed: 480, cooldown: 0.52, mag: 6, reserve: 36, reload: 2.6,
    spread: 0.004, pellets: 1, recoil: 0.05, kick: 0.14, zoom: false,
    rest: 0.0010, move: 0.016, air: 0.070,
    bloomStep: 0.0120, bloomMax: 0.040, bloomDecay: 0.140,
    pattern: [[0, 1], [0.15, 1]],
    color: 0x3a3d42, sound: 'revolver',
  },
  {
    // The pistol turned up: more than twice the rate of fire for a weaker bullet and a cone
    // that opens fast. Strong at the corner, wasteful across the map.
    id: 'mp', name: 'MACHINE PISTOL', slot: 1, auto: true,
    damage: 11, speed: 340, cooldown: 0.055, mag: 24, reserve: 144, reload: 1.5,
    spread: 0.04, pellets: 1, recoil: 0.011, kick: 0.028, zoom: false,
    rest: 0.0048, move: 0.0050, air: 0.040,
    bloomStep: 0.0034, bloomMax: 0.058, bloomDecay: 0.160,
    pattern: [
      [0, 1.0], [0.3, 1.0], [-0.4, 0.9], [0.5, 0.85], [-0.5, 0.8], [0.45, 0.75],
      [-0.4, 0.7], [0.35, 0.7],
    ],
    color: 0x2a2d31, sound: 'mp',
  },
  {
    // The deepest magazine and the slowest reload. Settled and crouched it is a laser; on the
    // move the cone opens wider than any other automatic.
    id: 'lmg', name: 'LIGHT MACHINE GUN', slot: 2, auto: true,
    damage: 24, speed: 380, cooldown: 0.085, mag: 100, reserve: 200, reload: 4.6,
    spread: 0.03, pellets: 1, recoil: 0.015, kick: 0.05, zoom: false,
    rest: 0.0030, move: 0.021, air: 0.080,
    bloomStep: 0.0030, bloomMax: 0.050, bloomDecay: 0.090,
    pattern: [
      [0, 1.0], [0, 1.1], [0.05, 1.1], [0.15, 1.0], [0.3, 0.9], [0.4, 0.8], [0.25, 0.7],
      [-0.1, 0.6], [-0.4, 0.55], [-0.6, 0.5], [-0.4, 0.5], [0.0, 0.5], [0.4, 0.5], [0.5, 0.45],
    ],
    color: 0x33372f, sound: 'lmg',
  },
  {
    // Self-loading, so it never waits for a pump. Each pellet is weak: three body shots,
    // not two, which is what keeps it from replacing the pump gun.
    id: 'ashotgun', name: 'AUTO SHOTGUN', slot: 3, auto: true,
    damage: 7, speed: 280, cooldown: 0.3, mag: 8, reserve: 48, reload: 3.2,
    spread: 0.09, pellets: 8, recoil: 0.045, kick: 0.12, zoom: false,
    rest: 0.0850, move: 0.012, air: 0.050,
    bloomStep: 0.0030, bloomMax: 0.025, bloomDecay: 0.090,
    pattern: [[0, 1], [0.3, 0.9], [-0.3, 0.9], [0.2, 0.85]],
    color: 0x2f2a26, sound: 'ashotgun',
  },
  {
    // Between the rifle and the sniper: a low-power scope, three body shots, and a mag long
    // enough to correct a miss.
    id: 'dmr', name: 'MARKSMAN RIFLE', slot: 4, auto: false,
    damage: 48, speed: 600, cooldown: 0.27, mag: 12, reserve: 48, reload: 2.6,
    spread: 0.002, pellets: 1, recoil: 0.035, kick: 0.09, zoom: true, zoomFov: 40,
    rest: 0.0008, move: 0.022, air: 0.100,
    bloomStep: 0.0100, bloomMax: 0.050, bloomDecay: 0.130,
    pattern: [[0, 1], [0.2, 0.9], [-0.2, 0.9]],
    color: 0x2b2f26, sound: 'dmr',
  },
  {
    id: 'frag', name: 'FRAG GRENADE', slot: 5, auto: false,
    damage: 0, speed: 0, cooldown: 0.8, mag: 3, reserve: 0, reload: 0,
    spread: 0, pellets: 0, recoil: 0, kick: 0, zoom: false,
    color: 0x3d4a33, sound: 'pistol', thrown: true,
  },
];

export const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map((weapon) => [weapon.id, weapon]));

/**
 * Damage of one projectile that has flown `dist` metres. `falloff` is [near, far, min]: full
 * damage out to `near`, a straight line down to `min` of it at `far`, flat beyond. The shotgun
 * is the gun this exists for; a pump that kills at the muzzle and tickles at 20 m is the point.
 */
export function damageAt(weapon, dist, base = weapon.damage) {
  const f = weapon.falloff;
  if (!f || dist <= f[0]) return base;
  if (dist >= f[1]) return base * f[2];
  return base * (1 - (1 - f[2]) * ((dist - f[0]) / (f[1] - f[0])));
}

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
