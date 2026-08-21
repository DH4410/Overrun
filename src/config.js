export const CONFIG = {
  GRAVITY: -9.82,
  PHYSICS_HZ: 120,
  MAX_SUBSTEPS: 4,  // 4 * 8.33 ms = 33.3 ms covers 30 fps without accumulator drift
  MAX_FRAME_DT: 0.25,

  // Arena (metres). Outer shell is ARENA half-extent; the inner ring sits at RING.
  ARENA: 50,          // outer wall at +/- 50  => 100 x 100 floor
  RING: 34,           // inner ring wall at +/- 34 => ~68 x 68 plaza
  GAP: 9,             // half-width of the doorway in the middle of each ring wall
  CEIL: 10,

  // Player
  EYE_HEIGHT: 1.6,
  CROUCH_HEIGHT: 0.95,
  PLAYER_RADIUS: 0.5,
  CROUCH_RADIUS: 0.38,
  PLAYER_MASS: 80,
  WALK_SPEED: 5.0,
  SPRINT_MULT: 1.6,
  CROUCH_MULT: 0.5,
  MOVE_ACCEL: 60,
  JUMP_SPEED: 4.7,
  MAX_HEALTH: 100,
  MAX_ARMOR: 100,
  START_ARMOR: 50,
  ARMOR_ABSORB: 0.55,

  // Bullets
  MAX_RANGE: 400,
  TRACER_RADIUS: 0.022,
  TRACER_MAX_LEN: 10,

  // Grenades
  FRAG_FUSE: 3.0,
  FRAG_DAMAGE: 80,
  FRAG_RADIUS: 8,
  FRAG_IMPULSE: 900,
  SMOKE_FUSE: 2.0,
  SMOKE_LIFE: 8.0,
  SMOKE_RADIUS: 4.0,

  // Match rules
  DM_TARGET: 20,
  TDM_TARGET: 25,
  MATCH_SECONDS: 300,
  RESPAWN_DELAY: 4.0,
  PLAYER_RESPAWN: 3.0,

  MAX_DECALS: 90,
  SENS: 0.0022,
};

/** Dungeon grid pitch and ceiling, measured from the Kenney Modular Dungeon Kit. */
export const DUNGEON_TILE = 4;
export const DUNGEON_CEIL = 4.15;

/** Seconds of spawn protection. Bots would otherwise have LOS before the player can move. */
export const SPAWN_INVULN = 3.0;

export const FIXED_DT = 1 / CONFIG.PHYSICS_HZ;

// FOV constants. Hip is the neutral camera FOV; ADS narrows it for precision.
export const HIP_FOV = 78;
export const ADS_FOV = 68;

/** cannon applies damping as v *= (1-d)^dt. Horizontal velocity is overwritten every tick. */
export const PLAYER_DAMPING = 0.95;
export const DAMP_PER_STEP = Math.pow(1 - PLAYER_DAMPING, FIXED_DT);

export const TEAM = { SOLO: 0, BLUE: 1, RED: 2 };
export const TEAM_COLOR = { 0: 0x52e08a, 1: 0x4d9dff, 2: 0xff4d4d };
