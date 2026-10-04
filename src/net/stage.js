import * as THREE from 'three';

import { CONFIG, TEAM, TEAM_COLOR } from '../config.js';

/**
 * The lobby's stage: every player standing in a line-up in their own character, in front of the
 * camera, with a name plate over each head. It is built far above the map, in the same scene, so
 * the characters are the real ones (the same rigs the match draws) and nothing about the map is
 * disturbed. The stage owns the look and the camera; the client owns who is standing on it.
 */

const BASE_Y = 300;                 // far above any map
const FRONT = 5;                    // players in the front row; the rest stand behind
const GAP = 1.25;
const FOV = 34;
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

const READY = 0x6fe08a, HOST = 0xf3b53f, WAIT = 0x6b7684;

/** Slots for `n` players: the first is front and centre, then left and right outward, then a second row. */
export function slotsFor(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (i < FRONT) {
      const k = Math.ceil(i / 2) * (i % 2 ? 1 : -1);
      out.push({ x: (i === 0 ? 0 : k) * GAP, z: 0 });
    } else {
      const j = i - FRONT;
      const k = (Math.floor(j / 2) + 0.5) * (j % 2 ? 1 : -1);
      out.push({ x: k * GAP, z: -1.5 });
    }
  }
  return out;
}

function backdrop() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#05080c');
  grad.addColorStop(0.55, '#121b25');
  grad.addColorStop(0.78, '#25384a');
  grad.addColorStop(1, '#0a0f15');
  g.fillStyle = grad; g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(
    new THREE.SphereGeometry(60, 32, 16),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false }),
  );
}

export function createStage({ scene, camera }) {
  const group = new THREE.Group();
  group.position.set(0, BASE_Y, 0);
  group.add(backdrop());

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(11, 72).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x151c25, metalness: 0.55, roughness: 0.38, fog: false }),
  );
  const edge = new THREE.Mesh(
    new THREE.RingGeometry(10.7, 11, 72).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xf3b53f, fog: false }),
  );
  edge.position.y = 0.01;
  group.add(floor, edge);

  // Light strips behind the line-up, a set of tall dim panels that the characters stand against.
  const stripMat = new THREE.MeshBasicMaterial({ color: 0x8fb4d9, transparent: true, opacity: 0.16, fog: false, blending: THREE.AdditiveBlending, depthWrite: false });
  for (let i = -5; i <= 5; i++) {
    const s = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 9), stripMat);
    const a = i * 0.2;
    s.position.set(Math.sin(a) * 9, 4.5, -Math.cos(a) * 9);
    s.rotation.y = a;
    group.add(s);
  }

  // One pad per slot: a glowing ring on the floor and a faint column of light.
  const pads = [];
  const ringGeo = new THREE.RingGeometry(0.5, 0.66, 40).rotateX(-Math.PI / 2);
  const discGeo = new THREE.CircleGeometry(0.5, 40).rotateX(-Math.PI / 2);
  const colGeo = new THREE.CylinderGeometry(0.5, 0.5, 4.2, 24, 1, true);
  function pad(i) {
    if (pads[i]) return pads[i];
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: WAIT, fog: false }));
    const disc = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, fog: false }));
    const col = new THREE.Mesh(colGeo, new THREE.MeshBasicMaterial({ color: WAIT, transparent: true, opacity: 0.05, fog: false, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    ring.position.y = 0.02; disc.position.y = 0.015; col.position.y = 2.5;
    const g = new THREE.Group();
    g.add(disc, ring, col);
    g.userData = { ring, col };
    group.add(g);
    pads[i] = g;
    return g;
  }

  // The plates: one element per player, kept across frames and only rewritten when what they say changes.
  const layer = document.createElement('div');
  layer.id = 'mp-plates';
  document.body.appendChild(layer);
  const plates = new Map();     // id -> { el, key, x, y, z }

  let on = false, order = [], slots = [], t = 0;
  const _v = new THREE.Vector3();

  function setPlayers(list) {
    order = list;
    slots = slotsFor(list.length);
    list.forEach((e, i) => {
      const p = pad(i);
      p.position.set(slots[i].x, 0, slots[i].z);
      const color = e.host ? HOST : (e.ready ? READY : WAIT);
      const team = e.team === TEAM.BLUE || e.team === TEAM.RED ? TEAM_COLOR[e.team] : null;
      p.userData.ring.material.color.setHex(team ?? color);
      p.userData.col.material.color.setHex(color);
      p.userData.col.material.opacity = e.ready || e.host ? 0.1 : 0.04;
      p.visible = true;
    });
    for (let i = list.length; i < pads.length; i++) pads[i].visible = false;

    const live = new Set();
    for (const e of list) {
      live.add(e.id);
      let pl = plates.get(e.id);
      if (!pl) {
        const el = document.createElement('div');
        el.className = 'plate';
        layer.appendChild(el);
        pl = { el, key: '' };
        plates.set(e.id, pl);
      }
      const key = `${e.name}|${e.host}|${e.ready}|${e.self}|${e.team}`;
      if (key !== pl.key) {
        pl.key = key;
        pl.el.className = `plate${e.self ? ' self' : ''}${e.host ? ' host' : ''}${e.ready ? ' ready' : ''}`;
        pl.el.style.setProperty('--team', e.team === TEAM.BLUE || e.team === TEAM.RED ? hex(TEAM_COLOR[e.team]) : 'transparent');
        pl.el.textContent = '';
        const nm = document.createElement('b');
        nm.textContent = `${e.host ? '♕ ' : ''}${e.name}`;
        const st = document.createElement('span');
        st.textContent = e.host ? 'HOST' : (e.ready ? 'READY' : 'NOT READY');
        pl.el.append(nm, st);
        if (e.self) { const you = document.createElement('i'); you.textContent = 'YOU'; pl.el.appendChild(you); }
      }
    }
    for (const [id, pl] of plates) if (!live.has(id)) { pl.el.remove(); plates.delete(id); }
  }

  /** World position and facing for the character of the player standing in slot `i`. */
  function spot(i) {
    const s = slots[i];
    if (!s) return null;
    return { x: s.x, y: BASE_Y + CONFIG.PLAYER_RADIUS, z: s.z, yaw: Math.PI - s.x * 0.09 };
  }

  /** Put the camera in front of the line-up and the plates over the heads. `shift` slides the line-up left. */
  function frame(dt, shift) {
    t += dt;
    const aspect = innerWidth / innerHeight;
    const back = order.length > FRONT;
    const dist = (back ? 7.4 : 5.6) * (aspect < 1.2 ? 1.5 : 1);
    const halfW = dist * Math.tan((FOV * Math.PI) / 360) * aspect;
    const dx = shift * halfW;
    if (camera.fov !== FOV) { camera.fov = FOV; camera.updateProjectionMatrix(); }
    camera.position.set(dx + Math.sin(t * 0.35) * 0.18, BASE_Y + (back ? 1.9 : 1.45), dist);
    camera.lookAt(dx, BASE_Y + (back ? 1.1 : 1.0), 0);
    camera.updateMatrixWorld();
    order.forEach((e, i) => {
      const pl = plates.get(e.id);
      const s = slots[i];
      if (!pl || !s) return;
      _v.set(s.x, BASE_Y + 2.12, s.z).project(camera);
      pl.el.style.transform = `translate(-50%, -100%) translate(${((_v.x * 0.5 + 0.5) * innerWidth).toFixed(1)}px, ${((-_v.y * 0.5 + 0.5) * innerHeight).toFixed(1)}px)`;
    });
  }

  return {
    setPlayers, spot, frame,
    get on() { return on; },
    show(v) {
      if (v === on) return;
      on = v;
      if (v) scene.add(group); else scene.remove(group);
      layer.classList.toggle('on', v);
      document.body.classList.toggle('mp-stage', v);
      if (!v) { for (const pl of plates.values()) pl.el.remove(); plates.clear(); order = []; slots = []; }
    },
  };
}
