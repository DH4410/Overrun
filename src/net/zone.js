import * as THREE from 'three';

import { ZOMBIE_HOLD } from '../sim/modes.js';

/**
 * Zombie Escape's extraction zone, drawn: a ring on the floor and a tall beam so it can be found
 * from across the map (red while it is locked, green once it is open), and one chip at the top of
 * the screen with the distance and how much of the hold is done. The server owns the state
 * (server/room.js stepZombie); it sends the zone with the match and the hold in the score word:
 * 0 while the zone is locked, 1 + tenths of a second held once it is open.
 */

const LOCKED = 0xff5a4e, OPEN = 0x62ff9a;
// Hardpoint: who is on the point (0 nobody, 1 blue, 2 red, 3 both).
const HP_OWNER = [0xe8eef6, 0x4d9dff, 0xff4d4d, 0xffc233];

export function createZone({ scene }) {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.93, 1, 64),
    new THREE.MeshBasicMaterial({ color: LOCKED, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(1, 48),
    new THREE.MeshBasicMaterial({ color: LOCKED, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide }),
  );
  disc.rotation.x = -Math.PI / 2;
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 60, 24, 1, true),
    new THREE.MeshBasicMaterial({ color: LOCKED, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
  );
  beam.position.y = 30;
  const root = new THREE.Group();
  root.add(ring, disc, beam);
  root.frustumCulled = false;

  const chip = document.createElement('div');
  chip.id = 'mp-zone';
  chip.innerHTML = '<span class="zt"></span><i></i>';
  document.body.appendChild(chip);
  const text = chip.firstChild, fill = chip.lastChild;

  let zone = null, t = 0, wasOpen = null;

  function paint(open) {
    if (open === wasOpen) return;
    wasOpen = open;
    const c = zone?.hp ? HP_OWNER[open] ?? HP_OWNER[0] : open ? OPEN : LOCKED;
    ring.material.color.setHex(c); disc.material.color.setHex(c); beam.material.color.setHex(c);
    beam.material.opacity = open ? 0.26 : 0.14;
    chip.classList.toggle('open', !zone?.hp && !!open);
  }

  function set(z) {
    if (zone) scene.remove(root);
    zone = z && Number.isFinite(z.x) ? z : null;
    chip.classList.toggle('on', !!zone);
    wasOpen = null;
    if (!zone) return;
    place();
    scene.add(root);
    paint(zone.hp ? zone.owner ?? 0 : false);
  }

  function place() {
    root.position.set(zone.x, zone.y + 0.06, zone.z);
    root.scale.set(zone.r, 1, zone.r);
  }

  /** `score` is the snapshot's score word, `from` the camera, `team` the player's team. */
  function update(dt, score, from, team) {
    if (!zone) return;
    t += dt;
    if (zone.hp) {
      const owner = zone.owner ?? 0;
      paint(owner);
      ring.scale.set(1 + Math.sin(t * 3) * 0.02, 1 + Math.sin(t * 3) * 0.02, 1);
      disc.material.opacity = owner === 1 || owner === 2 ? 0.2 : 0.1;
      const away = from ? Math.round(Math.hypot(from.x - zone.x, from.z - zone.z)) : 0;
      const mine = team === 1 ? 1 : team === 2 ? 2 : 0;
      text.textContent = away < zone.r
        ? (owner === 3 ? 'CONTESTED' : owner === mine ? 'HOLDING THE POINT' : owner ? 'ENEMY ON THE POINT' : 'ON THE POINT')
        : `HARDPOINT \u00b7 ${away} M`;
      fill.style.transform = 'scaleX(0)';
      return;
    }
    const open = score > 0, held = open ? (score - 1) / 10 : 0;
    paint(open);
    const pulse = 1 + Math.sin(t * 3) * 0.02;
    ring.scale.set(pulse, pulse, 1);
    disc.material.opacity = (open ? 0.16 : 0.08) + (held > 0 ? 0.08 : 0);
    const dist = from ? Math.round(Math.hypot(from.x - zone.x, from.z - zone.z)) : 0;
    const inside = dist < zone.r;
    text.textContent = !open ? `EXTRACTION LOCKED · ${dist} M`
      : held > 0 ? `HOLD THE ZONE · ${held.toFixed(1)} / ${ZOMBIE_HOLD}`
        : inside ? 'HOLD THE ZONE' : `EXTRACTION OPEN · ${dist} M`;
    fill.style.transform = `scaleX(${Math.min(1, held / ZOMBIE_HOLD)})`;
  }

  return { set, update, clear() { set(null); } };
}
