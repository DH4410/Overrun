import * as THREE from 'three';

import { TEAM_COLOR, TEAM } from '../config.js';

/**
 * Capture the flag, drawn: a pole and cloth at each base with a tall beam so it can be found from
 * across the map, carried on the carrier's back, and two chips at the top of the screen. The
 * server owns the state (server/ctf.js) and sends only changes; a carried flag is placed by the
 * caller's position lookup (a foot position), since the carrier's own position is already in every snapshot.
 */

const TEAMS = [TEAM.BLUE, TEAM.RED];
const NAMES = ['BLUE', 'RED'];
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;
const STATE = ['AT HOME', 'TAKEN', 'DROPPED'];

function makeFlag(color) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.2, 8), new THREE.MeshStandardMaterial({ color: 0xcfd3d8, metalness: 0.6, roughness: 0.4 }));
  pole.position.y = 1.6;
  const cloth = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.8, 6, 1), new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, roughness: 0.8, emissive: color, emissiveIntensity: 0.35 }));
  cloth.position.set(0.68, 2.75, 0);
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.35, 0.35, 40, 12, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
  );
  beam.position.y = 20;
  g.add(pole, cloth, beam);
  g.userData = { cloth, beam };
  g.frustumCulled = false;
  return g;
}

export function createFlags({ scene, positionOf }) {
  const meshes = TEAMS.map((t) => makeFlag(TEAM_COLOR[t]));
  let state = [];
  const root = document.createElement('div');
  root.id = 'mp-flags';
  const chips = TEAMS.map((t, i) => {
    const c = document.createElement('span');
    c.style.setProperty('--c', hex(TEAM_COLOR[t]));
    root.appendChild(c);
    return c;
  });
  document.body.appendChild(root);
  let t = 0;

  function set(list, myId) {
    state = Array.isArray(list) ? list : [];
    for (const m of meshes) { if (state.length) scene.add(m); else scene.remove(m); }
    root.classList.toggle('on', state.length > 0);
    chips.forEach((c, i) => {
      const f = state[i];
      if (!f) return;
      const carrying = f.s === 1 && f.c === myId;
      c.textContent = `${NAMES[i]} FLAG ${carrying ? 'YOU HAVE IT' : STATE[f.s]}`;
      c.className = `s${f.s}${carrying ? ' me' : ''}`;
    });
  }

  function update(dt) {
    t += dt;
    state.forEach((f, i) => {
      const m = meshes[i];
      if (!f) return;
      let pos = f;
      if (f.s === 1) {
        const at = positionOf(f.c);
        if (at) pos = at;
      }
      m.position.set(pos.x, pos.y, pos.z);
      const carried = f.s === 1;
      m.scale.setScalar(carried ? 0.55 : 1);
      m.userData.beam.visible = !carried;
      m.position.y += carried ? 0.85 : 0;
      m.userData.cloth.rotation.y = Math.sin(t * 3 + i) * 0.25;
    });
  }

  return {
    set, update,
    clear() { set([], null); },
  };
}
