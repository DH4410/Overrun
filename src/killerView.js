import * as THREE from 'three';

import { CONFIG } from './config.js';
import { clamp, lerp } from './utils.js';

/**
 * The killer's own screen, for the kill cam (solo, src/killcam.js, and online, src/net/client.js):
 * the gun they held, in their hands, the sights or the scope they were looking through, their
 * crosshair, the kick and flash of each shot. It drives the same first-person rig the player's own
 * screen uses, so what the replay shows is what the killer saw.
 *
 * `fp` is the rig, handed over by main.js: { vmRig, viewHands, vmModels, homePositions, adsPosition,
 * triggerMuzzleFlash, updateMuzzleFlash, setAmmoCounter, hipFov, adsFov }.
 */
export function createKillerView({ camera, fp, $ = (id) => document.getElementById(id) }) {
  let on = false, scoped = false, kick = 0;
  const painted = new Map();                          // gun id -> the finish its first-person model wears now
  const _hip = new THREE.Vector3(), _aim = new THREE.Vector3(), _pos = new THREE.Vector3(), _mz = new THREE.Vector3();

  /**
   * Once a frame. `w` is the weapon in hand, `aim` how far up the sights are (0 to 1), `speed` their
   * ground speed in m/s and `time` any steadily rising clock for the walk bob. False when there is no
   * model for the gun (the caller then keeps its own camera settings).
   * `finish` is the killer's gun finish (a skin id, '' for stock): the gun wears theirs, not this player's own.
   */
  function frame(w, aim, speed, time, dt, finish = '') {
    const model = w && fp.vmModels[w.id];
    if (!model) { end(); return false; }
    on = true;
    for (const id in fp.vmModels) fp.vmModels[id].visible = id === w.id;
    if (painted.get(w.id) !== finish) { painted.set(w.id, finish); fp.paint?.(model, finish); }
    aim = clamp(aim, 0, 1);
    scoped = !!w.zoom && aim > 0.85;
    const ads = w.zoom ? 0 : aim;                       // a scope replaces the model; other sights raise it
    _hip.copy(fp.homePositions[w.id] ?? fp.homePositions.ar);
    fp.adsPosition(w.id, _aim);
    _pos.lerpVectors(_hip, _aim, ads);
    const hip = 1 - ads;
    const bob = Math.min(speed / CONFIG.WALK_SPEED, 1.6) * (0.15 + 0.85 * hip);
    _pos.x += Math.sin(time * 7) * 0.008 * bob;
    _pos.y += Math.abs(Math.cos(time * 7)) * 0.007 * bob;
    kick *= Math.pow(0.0005, dt);
    _pos.z += kick * 0.6;
    fp.vmRig.position.copy(_pos);
    fp.vmRig.rotation.set(-0.02 * hip - kick * 1.1, 0.07 * hip, 0.03 * hip);
    fp.vmRig.visible = !scoped;
    if (fp.viewHands) {
      fp.vmRig.updateMatrixWorld(true);
      fp.viewHands.update({ id: w.id, vmMatrix: fp.vmRig.matrixWorld, reload: -1, show: !scoped });
    }
    fp.setAmmoCounter?.('', false, 0);                  // the counter on the gun is yours, not theirs
    fp.updateMuzzleFlash(dt);
    $('scope')?.classList.toggle('on', scoped);
    const xh = $('crosshair');
    if (xh) {
      xh.classList.toggle('off', scoped);
      if (xh.dataset.w !== w.id) xh.dataset.w = w.id;
      document.documentElement.style.setProperty('--xhair-gap', `${lerp(7, 3, aim)}px`);   // theirs, not the cone you died with
    }
    camera.fov = scoped ? w.zoomFov : lerp(fp.hipFov(), w.zoom ? w.zoomFov : fp.adsFov(), aim);
    camera.updateProjectionMatrix();
    return true;
  }

  /** A shot leaves the killer's gun: it kicks, and its muzzle flash lights the room (only the room, through a scope). */
  function shoot(w, origin) {
    kick += w?.kick ?? 0.05;
    const model = w && fp.vmModels[w.id];
    if (model && !scoped) {
      fp.vmRig.updateMatrixWorld(true);
      model.userData.muzzle.getWorldPosition(_mz);
      fp.triggerMuzzleFlash(_mz.clone(), origin);
    } else if (scoped) {
      fp.triggerMuzzleFlash(_mz.set(0, -9, 0), origin);
    }
  }

  /** Back to the player's own screen. */
  function end() {
    if (!on) return;
    on = scoped = false; kick = 0;
    if (painted.size) { painted.clear(); fp.restorePaint?.(); }
    fp.vmRig.visible = false;
    fp.viewHands?.update({ id: null, vmMatrix: fp.vmRig.matrixWorld, reload: -1, show: false });
    fp.updateMuzzleFlash(1);
    $('scope')?.classList.remove('on');
    $('crosshair')?.classList.add('off');
  }

  return { frame, shoot, end, get on() { return on; }, get scoped() { return scoped; } };
}
