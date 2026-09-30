export const CONFIG = {
  GRAVITY: -9.82,
  PHYSICS_HZ: 120,
  /**
   * Substeps one rendered frame may take before the loop gives up and throws the remainder
   * away.
   *
   * 16 * 8.33 ms = 133 ms, so the simulation keeps real time down to 7.5 fps.
   *
   * This was 4, which covers 33.3 ms — exactly one frame at 30 fps and therefore no headroom
   * at all there, let alone below it. Under that the loop silently discarded time (see the
   * accumulator guard in frame()), which is the bug reported from a laptop: everything moved
   * in slow motion, and the bots looked worst, because their leg animation is played back at
   * a rate derived from body VELOCITY while the body itself only advanced a fraction of that
   * per second. Feet cycling against ground they are not covering reads exactly as "the
   * animation doesn't match the movement".
   *
   * Measured in the real game, loaded down to 10 fps with four bots: one fixed step costs
   * 0.407 ms, so the worst case here is 6.5 ms of catch-up — on a frame that was already over
   * 130 ms long. The frame rate was identical with 4, 8 and 16 (9.8-10.1 fps), which is the
   * evidence that this cannot spiral: the cost is in drawing, not stepping. Measured simulation
   * speed against real time at that frame rate: 0.32x with 4 substeps, 0.65x with 8, 1.00x with
   * 16. A slow machine should run slowly, not in slow motion.
   *
   * MAX_FRAME_DT still bounds the worst case, so a genuine multi-second stall drops time
   * rather than trying to simulate its way out of a hole.
   */
  MAX_SUBSTEPS: 16,
  MAX_FRAME_DT: 0.25,

  // Player
  // Eye above the body centre (the foot sphere's centre): 1.8 m and 1.15 m above the floor.
  EYE_HEIGHT: 1.3,
  CROUCH_HEIGHT: 0.77,
  PLAYER_RADIUS: 0.5,
  CROUCH_RADIUS: 0.38,
  PLAYER_MASS: 80,
  WALK_SPEED: 5.0,
  SPRINT_MULT: 1.6,
  CROUCH_MULT: 0.5,
  /**
   * Ground movement is acceleration plus friction, the model every tactical shooter since Quake
   * uses, rather than the old "lerp half-way to the target speed every physics step" — which
   * reached full speed in about 50 ms and stopped dead just as fast, so movement had no weight.
   * With these, walking speed takes ~0.15 s to reach and ~0.2 s to shed: quick enough to peek,
   * slow enough that stopping to shoot (counter-strafing) is a thing you do, not a thing that
   * happens.
   */
  GROUND_ACCEL: 10,     // per second, as a multiple of the wish speed
  FRICTION: 8,          // per second, proportional to speed...
  STOP_SPEED: 2.5,      // ...but never less than this, so a slow drift still stops promptly
  /** Air steering. No friction in the air, and only this much control: jumps commit. */
  AIR_ACCEL: 1.2,
  /**
   * Jumping. The player falls under extra gravity so a jump is a quick hop, not a float: the
   * old 4.7 m/s under world gravity took 0.96 s in the air. Same 1.25 m apex (the warehouse
   * perch steps are 1.15 m), 0.73 s in the air.
   */
  PLAYER_GRAVITY: 18.5,
  JUMP_SPEED: 6.8,
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
  THROW_CHARGE_TIME: 0.9,   // seconds of holding throw for the farthest throw
  FRAG_DAMAGE: 80,
  FRAG_RADIUS: 8,
  FRAG_IMPULSE: 900,
  SMOKE_FUSE: 2.0,
  SMOKE_LIFE: 13.0,
  SMOKE_RADIUS: 5.5,

  // Match rules
  DM_TARGET: 20,
  TDM_TARGET: 25,
  MATCH_SECONDS: 300,
  RESPAWN_DELAY: 4.0,
  PLAYER_RESPAWN: 3.0,

  // 1v1 duel. Round-based rather than kill-based: one life each, the round ends the moment
  // someone dies, and the match is first to DUEL_ROUNDS. DUEL_ROUND_SECONDS exists so a
  // player who refuses to take the fight loses the round instead of stalling the match
  // forever — a timed-out round is a draw and scores for neither side.
  DUEL_ROUNDS: 7,
  DUEL_ROUND_SECONDS: 75,
  DUEL_RESET_DELAY: 3.5,
  DUEL_WEAPON: 'ar',

  MAX_DECALS: 90,
  SENS: 0.0022,
};

/** Seconds of spawn protection. Bots would otherwise have LOS before the player can move. */
export const SPAWN_INVULN = 3.0;

export const FIXED_DT = 1 / CONFIG.PHYSICS_HZ;

// FOV constants. Hip is the neutral camera FOV; ADS narrows it for precision.
export const HIP_FOV = 78;
export const ADS_FOV = 68;


export const TEAM = { SOLO: 0, BLUE: 1, RED: 2 };
export const TEAM_COLOR = { 0: 0x52e08a, 1: 0x4d9dff, 2: 0xff4d4d };
