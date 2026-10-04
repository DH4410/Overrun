import { stepWeapons } from './combat.js';
import { stepMovement } from './movement.js';
import { BTN, dequantPitch, dequantYaw } from './protocol.js';

export const PITCH_LIMIT = Math.PI / 2 - 0.02;

/**
 * One player's share of a multiplayer tick, before world.step: look, weapons, movement. The
 * server runs it for every player and client prediction runs it for its own, so both apply a
 * command identically. `fx` gets fire/throw/reload callbacks (see stepWeapons).
 */
export function applyCommand(world, p, cmd, dt, armed, fx = null) {
  p.yaw = dequantYaw(cmd.yawQ);
  p.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, dequantPitch(cmd.pitchQ)));
  p.aiming = p.alive && (cmd.buttons & BTN.AIM) !== 0;
  stepWeapons(p, cmd, dt, armed, fx);
  p.body.wakeUp();
  if (p.alive) {
    stepMovement(world, p, {
      ix: cmd.ix, iz: cmd.iz,
      crouch: (cmd.buttons & BTN.CROUCH) !== 0,
      sprint: (cmd.buttons & BTN.SPRINT) !== 0,
      aiming: p.aiming,
      jump: (cmd.buttons & BTN.JUMP) !== 0,
    }, dt);
  } else {
    p.body.velocity.x = 0; p.body.velocity.z = 0;
  }
}
