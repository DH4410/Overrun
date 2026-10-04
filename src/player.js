import * as THREE from 'three';

import {
  CONFIG,
  TEAM,
} from './config.js';
import { world } from './physics.js';
import { HB_PLAYER } from './projectiles.js';
import { settings } from './settings.js';
import { clamp, lerp, rand } from './utils.js';
import { WEAPON_BY_ID, WEAPONS, playerSpread, recoilStep } from './weapons.js';
import { DEFAULT_LOADOUT } from './loadout.js';
import {
  createPlayerBody as createSharedBody,
  setCrouch as sharedSetCrouch,
  stepMovement,
  syncPlayerPoints as sharedSyncPoints,
} from './sim/movement.js';

export function createPlayerState() {
  return {
  isPlayer: true,
  name: 'PLAYER',
  team: TEAM.SOLO,
  alive: true,
  health: CONFIG.MAX_HEALTH,
  armor: CONFIG.START_ARMOR,
  kills: 0, deaths: 0,
  hb: HB_PLAYER,
  pos: new THREE.Vector3(),          // chest — hitbox centre and what bots aim at
  eye: new THREE.Vector3(),          // muzzle / line-of-sight origin
  vel: new THREE.Vector3(),          // world velocity, so bots can lead their shots
  body: null,
  // Body position before the most recent physics step, for render interpolation.
  prevBodyPos: new THREE.Vector3(),
  yaw: 0, pitch: 0,
  recoilPitch: 0, recoilYaw: 0,
  grounded: false, crouching: false, sprinting: false,
  slideTime: 0,                      // seconds of slide left (sprint, then crouch)
  current: 'pistol',
  loadout: [...DEFAULT_LOADOUT],     // guns on keys 1-4, in order (see loadout.js)
  ammo: {},
  cooldown: 0, reloading: 0, reloadTotal: 0,
  // Overshoot left over when the fire cooldown expired mid-frame, spent on the next shot so
  // the rate of fire does not quantise to the render rate. See the weapon timers in frame().
  fireCarry: 0,
  // Spray state: accumulated bloom in radians, how far into the recoil pattern we are, and
  // how long since the last round left the barrel. See playerSpread / recoilStep.
  bloom: 0, sprayIndex: 0, sinceShot: 99,
  fragCount: 3, smokeCount: 1,
  // cooking is the grenade in hand ('frag' or 'smoke') while the throw charges, and chargeTime
  // how long it has been held: the longer, the farther (see throwAim). The fuse only starts on
  // release. cookSource is the input holding it ('key', 'mouse' or 'pad'): only that input's
  // release throws it, or an idle controller would throw every keyboard throw on the next frame.
  cooking: null, chargeTime: 0, cookSource: null,
  respawnTimer: 0,
  invulnTimer: 0,                    // spawn protection — see SPAWN_INVULN
  stepTimer: 0,
  sway: new THREE.Vector2(),
  // Seconds since the last hard landing and how hard it was, for the camera dip.
  landTime: 99, landKick: 0,
  airVy: 0,
};
}

/** Player simulation, damage, weapons, input, pointer lock, and gamepad runtime. */
export function createPlayerRuntime({
  player,
  renderer,
  camera,
  Audio,
  getMatch,
  getAppState,
  playingState,
  pausedState,
  resumePlay,
  respawnPlayer,
  killCombatant,
  showDamageDirection,
  addShake,
  showHitMarker,
  showKillBanner,
  showDamageNumber,
  updateAmmoHud,
  showBoard,
  showPause,
  vmModels,
  fireWeapon,
  triggerMuzzleFlash,
  ejectBrass,
  addViewModelRecoil,
  losClear,
  smokeBlocks,
  getEnemies,
  throwGrenade,
  showThrowArc,
  // Multiplayer: while getNet().active the server owns the weapons, so swaps and reloads become
  // requests to it (see src/net/client.js) and nothing here fires or throws.
  getNet = () => null,
}) {
const match = getMatch();
const online = () => !!getNet()?.active;

const keys = Object.create(null);
let mouseDX = 0, mouseDY = 0;
let firing = false, aiming = false;
// A press that has not been seen by a multiplayer tick yet, so a click shorter than a frame
// still fires.
let fireLatch = false;
let pointerLocked = false;

// Shared gameplay scratch remains local to the player runtime; projectile simulation owns its
// own vectors so future player and bot work cannot mutate a bullet step in progress.
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

/** The player's collider and movement live in sim/movement.js, shared with multiplayer. */
function createPlayerBody() {
  const b = createSharedBody();
  world.addBody(b);
  player.body = b;
}

function resetPlayerAmmo() {
  player.ammo = {};
  for (const w of WEAPONS) {
    if (w.thrown) continue;
    player.ammo[w.id] = { mag: w.mag, reserve: w.reserve };
  }
  player.fragCount = 3;
  player.smokeCount = 1;                 // one smoke per life — reset here, on every respawn
}

/* ------------------------- shared damage path ------------------------- */

/**
 * Route damage through armour, then health. Handles kill bookkeeping for whoever fired.
 * Used by bullets and by explosions, for the player and for bots alike.
 */
function applyDamage(target, amount, source, hitPos, headshot, zone = 'body') {
  if (!target.alive || !match.running) return;
  // Spawn protection. Gated here as well as in Bot.canSee, because bullets already in flight
  // and grenades already thrown do not go back through target acquisition.
  if (target.invulnTimer > 0) return;

  let dmg = amount;
  let soaked = 0;
  if (target.armor > 0) {
    const soak = Math.min(target.armor, dmg * CONFIG.ARMOR_ABSORB);
    target.armor -= soak;
    dmg -= soak;
    soaked = soak;
  }
  target.health -= dmg;

  // A hit that a shield soaked cracks instead of thudding, and the hit that breaks it shatters.
  const shield = soaked > 0 ? (target.armor <= 0 ? 'break' : 'hit') : null;
  if (target === player) {
    if (shield === 'break') Audio.shieldBreak(true);
    else if (shield) Audio.shieldHit(true);
    else Audio.hurt();
    if (source && source !== player) showDamageDirection(source.pos);
    addShake(0.035);
  } else {
    if (source === player) {
      const lethal = target.health <= 0;
      if (!lethal) {
        showHitMarker(headshot ? 'head' : 'body');
        if (shield === 'break') Audio.shieldBreak();
        else if (shield) Audio.shieldHit();
        if (headshot) Audio.headshot();
        else if (!shield) Audio.hit(player.current);
      }
      // zone was being dropped here, so every number rendered with the plain body style and a
      // headshot looked exactly like a graze. soaked tells the player *why* a centre-mass hit
      // landed for single digits — armour ate the rest — instead of it reading as a weak gun.
      showDamageNumber(hitPos || target.pos, dmg, headshot, zone, soaked > 0.5, lethal);
    }
    target.lastHurtBy = source;
    target.lastHurtAt = match.time;
  }

  if (target.health <= 0) {
    target.health = 0;
    killCombatant(target, source, headshot);
    if (source === player) {
      showHitMarker('kill');
      showKillBanner(target, headshot);
      if (headshot) Audio.headshot?.();
      Audio.kill();
    }
  }
}

/* ----------------------------- movement ----------------------------- */

let crouchLatch = false, sprintLatch = false;
const moveHooks = { land: () => Audio.step?.(), slide: () => Audio.slide?.() };
const moveCmd = { ix: 0, iz: 0, crouch: false, sprint: false, aiming: false, jump: false };

const THROW_POWER_SOFT = 6;    // m/s at a tap
const THROW_POWER_HARD = 21;   // m/s at a full hold
const THROW_LIFT_SOFT = 0.4;   // extra upward aim at a tap, so a short lob clears a crate
const THROW_LIFT_HARD = 0.06;
function setCrouch(on) { sharedSetCrouch(world, player, on); }

function stepPlayer(dt) {
  const b = player.body;
  b.wakeUp();                     // belt-and-braces alongside world.allowSleep = false

  // Spray recovery. Runs on the fixed clock so it is frame-rate independent, and before the
  // alive check so a respawn never inherits the bloom the previous life ended on.
  player.sinceShot += dt;
  const sprayWeapon = WEAPON_BY_ID[player.current];
  if (player.bloom > 0 && sprayWeapon) {
    // Recovery only starts once the trigger has been off for a full cooldown, so holding
    // fire never quietly recovers between rounds.
    if (player.sinceShot > sprayWeapon.cooldown * 1.35) {
      player.bloom = Math.max(0, player.bloom - (sprayWeapon.bloomDecay ?? 0.1) * dt);
      if (player.bloom === 0) player.sprayIndex = 0;
    }
  } else if (player.sinceShot > 0.35) {
    player.sprayIndex = 0;
  }

  if (!player.alive) { b.velocity.x = 0; b.velocity.z = 0; return; }

  readMoveInput(moveCmd);
  stepMovement(world, player, moveCmd, dt, moveHooks);

  // Footsteps.
  const planar = Math.hypot(b.velocity.x, b.velocity.z);
  if (player.grounded && planar > 1.2) {
    player.stepTimer -= dt * (player.sprinting ? 1.5 : 1);
    if (player.stepTimer <= 0) { Audio.step(); player.stepTimer = 0.4; }
  } else {
    player.stepTimer = 0;
  }

  player.vel.set(b.velocity.x, b.velocity.y, b.velocity.z);
  syncPlayerPoints();

  // Fall out of the world guard.
  if (b.position.y < -20) respawnPlayer();
}

/** The movement keys as a command, shared with the multiplayer client. */
function readMoveInput(out) {
  let ix = 0, iz = 0;
  if (keys.KeyW || keys.GpForward || (settings.arrowKeys && keys.ArrowUp)) iz += 1;
  if (keys.KeyS || keys.GpBack || (settings.arrowKeys && keys.ArrowDown)) iz -= 1;
  if (keys.KeyD || keys.GpRight || (settings.arrowKeys && keys.ArrowRight)) ix += 1;
  if (keys.KeyA || keys.GpLeft || (settings.arrowKeys && keys.ArrowLeft)) ix -= 1;

  /**
   * Sprint: held, latched, or — with autoSprint — implied by walking forward.
   *
   * Holding Shift with the same hand that is covering WASD is genuinely awkward on a laptop
   * keyboard, and toggle-sprint only half solves it because you still have to remember to turn
   * it off. autoSprint needs the FORWARD key specifically, not just any movement, and stands
   * down while aiming: strafing to peek an angle stays at walking pace, and walking pace stays
   * reachable at all, which matters because sprinting is the widest accuracy cone in the game.
   */
  const wantSprint = (settings.toggleSprint ? sprintLatch : !!(keys.ShiftLeft || keys.GpSprint))
    || (settings.autoSprint && iz > 0);

  out.ix = ix;
  out.iz = iz;
  // Crouch reads from a latch when the player has chosen toggle-style bindings (see
  // settings.toggleCrouch), otherwise straight from the held key.
  out.crouch = settings.toggleCrouch ? crouchLatch : !!(keys.KeyC || keys.GpCrouch);
  out.sprint = wantSprint;
  out.aiming = aiming;
  out.jump = !!(keys.Space || keys.GpJump);
  return out;
}

function syncPlayerPoints() { sharedSyncPoints(player); }

/* ------------------------- aiming and firing ------------------------- */

const _camQ = new THREE.Quaternion();
const _camE = new THREE.Euler(0, 0, 0, 'YXZ');
const _aimDir = new THREE.Vector3();

function playerAimDirection(out) {
  _camE.set(player.pitch + player.recoilPitch, player.yaw + player.recoilYaw, 0, 'YXZ');
  _camQ.setFromEuler(_camE);
  return out.set(0, 0, -1).applyQuaternion(_camQ);
}

function currentWeapon() { return WEAPON_BY_ID[player.current]; }

function startReload() {
  if (online()) { getNet().reload(); return; }
  const w = currentWeapon();
  if (w.thrown || player.reloading > 0) return;
  const a = player.ammo[w.id];
  if (a.mag >= w.mag || a.reserve <= 0) return;
  player.reloading = w.reload;
  player.reloadTotal = w.reload;
  Audio.reloadClick();
}

function finishReload() {
  const w = currentWeapon();
  const a = player.ammo[w.id];
  const need = w.mag - a.mag;
  const take = Math.min(need, a.reserve);
  a.mag += take; a.reserve -= take;
}

/** Stand up and drop any latched crouch or slide, for a fresh life. */
function resetStance() {
  crouchLatch = false;
  player.slideTime = 0;
  setCrouch(false);
}

function switchWeapon(id) {
  if (online()) { if (getNet().selectWeapon(id)) { Audio.equip(); aiming = false; sprintLatch = false; } return; }
  if (player.current === id || !WEAPON_BY_ID[id]) return;
  if (id === 'frag' && player.fragCount <= 0) return;
  if (id !== 'frag' && !player.loadout.includes(id)) return;   // not carried
  player.current = id;
  player.reloading = 0;
  player.cooldown = Math.max(player.cooldown, 0.25);
  Audio.equip();
  // The crouch latch survives a swap: with toggle-crouch on, every swap used to stand you up.
  aiming = false; sprintLatch = false;
  updateAmmoHud();
}

function tryFire() {
  if (!player.alive || !match.running || player.cooldown > 0 || player.reloading > 0) return;
  player.invulnTimer = 0;  // firing cancels spawn protection
  const w = currentWeapon();
  if (w.thrown) return;                       // grenades are thrown with G, not LMB

  const a = player.ammo[w.id];
  if (a.mag <= 0) { startReload(); return; }

  a.mag--;
  player.cooldown = Math.max(0, w.cooldown - player.fireCarry);
  player.fireCarry = 0;

  playerAimDirection(_aimDir);
  // Additive accuracy: a settled, standing tap is effectively pinpoint, while movement, air
  // time and sustained fire each widen the cone on their own terms. See playerSpread.
  const planarSpeed = Math.hypot(player.body.velocity.x, player.body.velocity.z);
  const cone = playerSpread(w, {
    speed: planarSpeed,
    grounded: player.grounded,
    aiming,
    crouching: player.crouching,
    bloom: player.bloom,
  });

  // Fire from the muzzle marker so tracers leave the barrel, not the eyeball. The viewmodel
  // lives in its own scene whose camera sits at the origin, so its world position is already
  // camera-local: rotate by the aim quaternion and offset by the eye to reach world space.
  const mz = vmModels[w.id].userData.muzzle;
  const mzLocal = mz.getWorldPosition(new THREE.Vector3());
  _v3.copy(mzLocal).applyQuaternion(_camQ).add(camera.position);
  // Guard against the muzzle ending up inside geometry (up against a wall).
  if (!losClear(player.eye.x, player.eye.y, player.eye.z, _v3.x, _v3.y, _v3.z)) _v3.copy(player.eye);

  fireWeapon(player, w, _v3, _aimDir, 1, cone);

  // Deterministic spray pattern plus a small random component, so the pattern can be learned
  // and pulled against but two sprays are never pixel-identical.
  const [patYaw, patPitch] = recoilStep(w, player.sprayIndex);
  player.recoilPitch += w.recoil * patPitch;
  player.recoilYaw += w.recoil * patYaw + rand(-w.recoil * 0.12, w.recoil * 0.12);
  player.sprayIndex++;
  player.bloom = Math.min(w.bloomMax ?? 0, (player.bloom ?? 0) + (w.bloomStep ?? 0));
  player.sinceShot = 0;
  addViewModelRecoil(w.kick);
  triggerMuzzleFlash(mzLocal, _v3);
  ejectBrass(mzLocal.clone().add(new THREE.Vector3(0.05, 0.02, 0.12)));
  if (a.mag === 0) startReload();
  updateAmmoHud();
}

/* --------------------------- thrown ordnance --------------------------- */

function startCook(kind, source = 'key') {
  if (online()) return;           // multiplayer reads G and F as held buttons instead
  if (!player.alive || player.cooking) return;
  if (kind === 'frag' && player.fragCount <= 0) return;
  if (kind === 'smoke' && player.smokeCount <= 0) return;
  player.cooking = kind;
  player.cookSource = source;
  player.chargeTime = 0;
  Audio.pinPull();
}

/** How far the throw in hand has charged, 0 at a tap to 1 once held for THROW_CHARGE_TIME. */
function throwCharge() {
  return clamp(player.chargeTime / CONFIG.THROW_CHARGE_TIME, 0, 1);
}

/**
 * The throw a release would make now: its direction into `out`, and its speed returned.
 *
 * One throw strength could not cover both "over that wall" and "just past my feet", so the
 * hold sets it: a tap lobs it short and high, a full hold throws it flat and far, and the arc
 * drawn while you hold (updateThrowPreview) is exactly this throw.
 */
function throwAim(out) {
  const c = throwCharge();
  playerAimDirection(out);
  out.y += lerp(THROW_LIFT_SOFT, THROW_LIFT_HARD, c);
  out.normalize();
  return lerp(THROW_POWER_SOFT, THROW_POWER_HARD, c);
}

function releaseCook() {
  const kind = player.cooking;
  if (!kind) return;
  player.cooking = null;
  player.cookSource = null;
  showThrowArc(null);

  if (kind === 'frag') player.fragCount--;
  else player.smokeCount--;

  player.invulnTimer = 0;  // throwing cancels spawn protection
  const dir = new THREE.Vector3();
  const power = throwAim(dir);
  const origin = player.eye.clone().addScaledVector(dir, 0.7);
  throwGrenade(player, origin, dir, power, kind, kind === 'frag' ? CONFIG.FRAG_FUSE : CONFIG.SMOKE_FUSE);
  if (player.current === 'frag' && player.fragCount <= 0) switchWeapon(player.loadout[0]);
  updateAmmoHud();
}

const _throwDir = new THREE.Vector3();
const _throwFrom = new THREE.Vector3();

/** Charge the throw in hand and draw its arc. Once per rendered frame while playing. */
function updateThrowPreview(dt) {
  if (!player.cooking || !player.alive) { showThrowArc(null); return; }
  player.chargeTime += dt;
  const power = throwAim(_throwDir);
  _throwFrom.copy(player.eye).addScaledVector(_throwDir, 0.7);
  showThrowArc(player, _throwFrom, _throwDir, power);
}

/* ------------------------------ input ------------------------------ */

function bindInput() {
  const canvas = renderer.domElement;

  canvas.addEventListener('mousedown', (e) => {
    if (!pointerLocked) { requestLock(); return; }
    // With the frag selected, LMB cooks and releases exactly like G does.
    if (e.button === 0) {
      if (currentWeapon().thrown) startCook('frag', 'mouse');
      else { firing = true; fireLatch = true; tryFire(); }
    }
    if (e.button === 2) aiming = settings.toggleAim ? !aiming : true;
  });
  addEventListener('mouseup', (e) => {
    if (e.button === 0) {
      firing = false;
      if (player.cookSource === 'mouse') releaseCook();
    }
    if (e.button === 2 && !settings.toggleAim) aiming = false;
  });
  // Without this the browser context menu eats every right-click ADS.
  addEventListener('contextmenu', (e) => e.preventDefault());

  addEventListener('mousemove', (e) => {
    if (!pointerLocked) return;
    mouseDX += e.movementX;
    mouseDY += e.movementY;
  });

  addEventListener('keydown', (e) => {
    if (e.code === 'Tab') e.preventDefault();
    if (keys[e.code]) return;                    // ignore auto-repeat
    keys[e.code] = true;

    // Toggle latches for the trackpad-friendly bindings.
    if (e.code === 'KeyC' && settings.toggleCrouch) crouchLatch = !crouchLatch;
    if (e.code === 'ShiftLeft' && settings.toggleSprint) sprintLatch = !sprintLatch;

    switch (e.code) {
      case 'Digit1': switchWeapon(player.loadout[0]); break;
      case 'Digit2': switchWeapon(player.loadout[1]); break;
      case 'Digit3': switchWeapon(player.loadout[2]); break;
      case 'Digit4': switchWeapon(player.loadout[3]); break;
      case 'Digit5': switchWeapon('frag'); break;
      case 'KeyR': startReload(); break;
      case 'KeyG': startCook('frag'); break;
      case 'KeyF': startCook('smoke'); break;
      case 'Tab': showBoard(true); break;
    }
  });

  addEventListener('keyup', (e) => {
    keys[e.code] = false;
    if (player.cookSource === 'key') {
      if (e.code === 'KeyG' && player.cooking === 'frag') releaseCook();
      if (e.code === 'KeyF' && player.cooking === 'smoke') releaseCook();
    }
    if (e.code === 'Tab') showBoard(false);
  });

  document.addEventListener('pointerlockchange', () => {
    pointerLocked = document.pointerLockElement === canvas;
    firing = false; aiming = false;
    if (pointerLocked && (match.running || online())) {
      resumePlay();
      // The death screen shares this overlay and the match loop keeps it up while you are dead.
      if (player.alive) showPause(false);
    } else if (!pointerLocked && getAppState() === playingState) {
      showPause(true);
    }
  });

  document.getElementById('pause').addEventListener('click', () => {
    if (getAppState() === pausedState) requestLock();
  });
}

function requestLock() {
  if (!match.running && !online()) return;
  // Chrome returns a promise here and rejects it when a lock is asked for too soon after the
  // player left one — press Esc, click straight back in. Unhandled, that was a console error
  // and a click that silently did nothing. The pause overlay is still up when it happens, so
  // the next click simply asks again.
  renderer.domElement.requestPointerLock()?.catch?.(() => {});
  Audio.init();
}

/** Consume the accumulated mouse delta once per rendered frame. */
/* ---------------------------- gamepad ---------------------------- */

/**
 * Controller support, polled rather than event-driven because the Gamepad API has no events
 * for axis movement. Standard mapping: left stick moves, right stick looks, RT fires, LT aims,
 * A jumps, B crouches, LB throws a frag, right stick click sprints, D-pad swaps weapons.
 *
 * Sticks get a radial dead zone and the look axes are cubed — a linear stick makes fine aim
 * impossible, and squaring loses the sign.
 */
const GP_DEADZONE = 0.18;
const gpPrev = [];
let gamepadActive = false;

function gpAxis(v) {
  const a = Math.abs(v);
  if (a < GP_DEADZONE) return 0;
  const scaled = (a - GP_DEADZONE) / (1 - GP_DEADZONE);
  return Math.sign(v) * scaled;
}

function pollGamepad(dt) {
  const pads = navigator.getGamepads?.();
  if (!pads) return;
  let pad = null;
  for (const p of pads) if (p && p.connected) { pad = p; break; }
  if (!pad) { gamepadActive = false; return; }

  const ax = pad.axes, btn = pad.buttons;
  const moveX = gpAxis(ax[0] ?? 0), moveY = gpAxis(ax[1] ?? 0);
  const lookX = gpAxis(ax[2] ?? 0), lookY = gpAxis(ax[3] ?? 0);
  if (moveX || moveY || lookX || lookY) gamepadActive = true;

  // Movement is fed through the same key flags the keyboard sets, so nothing downstream
  // needs to know where the input came from.
  keys.GpForward = moveY < -0.1; keys.GpBack = moveY > 0.1;
  keys.GpLeft = moveX < -0.1; keys.GpRight = moveX > 0.1;

  const down = (i) => !!(btn[i] && btn[i].pressed);
  const pressed = (i) => { const d = down(i); const was = gpPrev[i]; gpPrev[i] = d; return d && !was; };

  // Look. Cubed for fine control, scaled by dt and by the same ADS multiplier as the mouse.
  const gpAdsMult = aiming && currentWeapon().zoom
    ? settings.adsSensitivity * (0.4 / 0.75)
    : (aiming ? settings.adsSensitivity : 1);
  const lookRate = 3.4 * settings.sensitivity * gpAdsMult * dt;
  player.yaw -= (lookX ** 3) * lookRate;
  player.pitch -= (lookY ** 3) * lookRate * (settings.invertY ? -1 : 1);
  player.pitch = clamp(player.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);

  // LT: toggle-ADS uses edge-triggered latch so pressing again actually toggles off.
  if (settings.toggleAim) { if (pressed(6)) aiming = !aiming; }
  else { aiming = down(6); }

  // RT: semi fires on press; auto fires via the frame() loop (firing flag, no double-call).
  if (down(7)) { if (!firing) { firing = true; fireLatch = true; tryFire(); } }
  else firing = false;

  // Buttons get their own flags, like the stick does. Writing the keyboard's (keys.Space,
  // KeyC, ShiftLeft) meant any connected pad reset them every frame before the player stepped,
  // so with a controller plugged in the keyboard could not jump, crouch or sprint.
  keys.GpJump = down(0);                                    // A
  // B: gate on toggleCrouch so only one of crouchLatch or GpCrouch is driven at a time.
  if (settings.toggleCrouch) { if (pressed(1)) crouchLatch = !crouchLatch; }
  else { keys.GpCrouch = down(1); }
  keys.GpSprint = down(11);                                 // right stick click sprints
  if (pressed(4)) startCook('frag', 'pad');                 // LB
  if (!down(4) && player.cookSource === 'pad') releaseCook();
  if (pressed(2)) startReload();                            // X
  if (pressed(3)) switchWeapon('frag');                     // Y
  if (pressed(12)) switchWeapon(player.loadout[0]);
  if (pressed(13)) switchWeapon(player.loadout[1]);
  if (pressed(14)) switchWeapon(player.loadout[2]);
  if (pressed(15)) switchWeapon(player.loadout[3]);
  if (pressed(9)) {                                          // start: pause or resume
    if (getAppState() === playingState) showPause(true);
    else if (getAppState() === pausedState) requestLock();
  }
}

/**
 * Pointer-delta boost, for playing on a trackpad.
 *
 * A trackpad gives you a few centimetres of travel, so at a sensitivity that still allows fine
 * aim a 180 turn takes three or four swipes — the single biggest reason a shooter is unpleasant
 * on a laptop. A mouse solves this in hardware with a high CPI; this makes the same trade in
 * software. Movement slower than KNEE passes through untouched, so small corrections keep the
 * 1:1 feel the whole crosshair is tuned around, and faster movement is scaled up progressively
 * to at most MAX, which is low enough that a palm brush cannot spin the camera.
 *
 * Rate is measured per 60 Hz frame rather than per frame, so the curve does not change when the
 * player caps the frame rate and each frame's delta covers more time.
 */
const BOOST_KNEE = 5;            // px per 1/60 s
const BOOST_RANGE = 35;          // px per 1/60 s of ramp above the knee
const BOOST_MAX = 2.6;

function trackpadBoost(delta, dt) {
  const rate = Math.abs(delta) / 60 / Math.max(dt, 1 / 240);
  if (rate <= BOOST_KNEE) return delta;
  const ramp = Math.min((rate - BOOST_KNEE) / BOOST_RANGE, 1);
  return delta * (1 + (BOOST_MAX - 1) * ramp);
}

/**
 * Aim assist. Off at 0, friction-only up to half strength, a small pull above that.
 *
 * This exists for trackpad and keyboard play, where the hard part is not finding the target but
 * stopping on it. Friction — slowing the crosshair while it is over someone — fixes exactly
 * that and never moves your aim for you, which is why it is what the default strength buys.
 */
const ASSIST_CONE = 0.055;       // rad, ~3.2 degrees either side of the crosshair
const ASSIST_FRICTION = 0.55;    // fraction of look speed removed dead centre at strength 1
const ASSIST_PULL = 0.5;         // rad/s of pull dead centre at strength 1
const _assistFwd = new THREE.Vector3();
const _assistVec = new THREE.Vector3();

/**
 * The enemy nearest the crosshair, if assist is on and that enemy can actually be seen.
 *
 * Visibility is a real line-of-sight test plus the smoke check, deliberately NOT bot.spotted:
 * spotting marks anything within 30 m as seen whether or not a wall is in the way, so keying
 * assist off it would drag the crosshair over targets behind cover — an accidental wallhack.
 */
function assistTarget() {
  if (!(settings.aimAssist > 0) || !player.alive || !getMatch().running) return null;

  const cp = Math.cos(player.pitch);
  _assistFwd.set(-Math.sin(player.yaw) * cp, Math.sin(player.pitch), -Math.cos(player.yaw) * cp);

  let best = null;
  let bestAngle = ASSIST_CONE;
  for (const e of getEnemies()) {
    if (!e.alive) continue;
    if (player.team !== TEAM.SOLO && e.team === player.team) continue;
    _assistVec.subVectors(e.pos, player.eye);
    const dist = _assistVec.length();
    if (dist < 0.001) continue;
    const angle = Math.acos(clamp(_assistVec.dot(_assistFwd) / dist, -1, 1));
    if (angle >= bestAngle) continue;
    bestAngle = angle;
    best = e;
  }
  if (!best) return null;
  // One ray, for the one candidate that matters.
  if (!losClear(player.eye.x, player.eye.y, player.eye.z, best.pos.x, best.pos.y, best.pos.z)) {
    return null;
  }
  if (smokeBlocks(player.eye, best.pos)) return null;
  return { target: best, closeness: 1 - bestAngle / ASSIST_CONE };
}

/**
 * A gentle pull toward the target, above half strength only.
 *
 * Bounded by rate rather than by distance, so it can help track someone crossing the screen but
 * can never snap onto them: at full strength it closes 0.5 rad/s, slower than a person turns,
 * and it fades to nothing as the crosshair arrives.
 */
function applyAssistPull(assist, dt) {
  if (settings.aimAssist <= 0.5) return;
  const rate = ASSIST_PULL * (settings.aimAssist - 0.5) * 2 * assist.closeness * dt;
  _assistVec.subVectors(assist.target.pos, player.eye);
  const len = _assistVec.length() || 1;
  let dYaw = Math.atan2(-_assistVec.x, -_assistVec.z) - player.yaw;
  while (dYaw > Math.PI) dYaw -= Math.PI * 2;
  while (dYaw < -Math.PI) dYaw += Math.PI * 2;
  player.yaw += clamp(dYaw, -rate, rate);
  player.pitch += clamp(Math.asin(clamp(_assistVec.y / len, -1, 1)) - player.pitch, -rate, rate);
}

function applyLook(dt) {
  // Scope multiplier scales with adsSensitivity so the slider is predictable at all settings.
  // At the default (0.75) this equals the previous hardcoded 0.4.
  const adsMult = aiming && currentWeapon().zoom
    ? settings.adsSensitivity * (0.4 / 0.75)
    : (aiming ? settings.adsSensitivity : 1);
  const sens = CONFIG.SENS * settings.sensitivity * adsMult;

  if (settings.trackpadLook) {
    mouseDX = trackpadBoost(mouseDX, dt);
    mouseDY = trackpadBoost(mouseDY, dt);
  }
  const assist = assistTarget();
  if (assist) {
    const grip = 1 - ASSIST_FRICTION * settings.aimAssist * assist.closeness;
    mouseDX *= grip;
    mouseDY *= grip;
  }

  player.yaw -= mouseDX * sens;
  player.pitch -= mouseDY * sens * (settings.invertY ? -1 : 1);
  player.pitch = clamp(player.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
  if (assist) applyAssistPull(assist, dt);

  // Weapon sway trails the mouse and settles back.
  player.sway.x = clamp(lerp(player.sway.x, -mouseDX * 0.0016, 0.35), -1, 1);
  player.sway.y = clamp(lerp(player.sway.y, -mouseDY * 0.0016, 0.35), -1, 1);
  player.sway.multiplyScalar(Math.pow(0.02, dt));

  mouseDX = 0; mouseDY = 0;

  const rec = Math.pow(0.0009, dt);      // exponential recovery toward the original aim
  player.recoilPitch *= rec;
  player.recoilYaw *= rec;
}

return {
  player,
  keys,
  createPlayerBody,
  resetPlayerAmmo,
  applyDamage,
  stepPlayer,
  syncPlayerPoints,
  resetStance,
  currentWeapon,
  startReload,
  finishReload,
  switchWeapon,
  tryFire,
  startCook,
  releaseCook,
  throwCharge,
  updateThrowPreview,
  bindInput,
  requestLock,
  pollGamepad,
  applyLook,
  cameraEuler: _camE,
  isAiming: () => aiming,
  setAiming: (on) => { aiming = !!on; },      // test and debug hook
  isFiring: () => firing,
  takeFireLatch: () => { const f = fireLatch; fireLatch = false; return f; },
  readMoveInput,
  isPointerLocked: () => pointerLocked,
  isGamepadActive: () => gamepadActive,
  stopFiring: () => { firing = false; },
};
}
