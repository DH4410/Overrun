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
const DARK = new THREE.Color(0x070a0e);     // the map's sky is bright; the stage sits in the dark

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

/* ---------- textures: all drawn once, small, and shared by the whole stage ---------- */

function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Cheap deterministic noise, so the stage is the same every time. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Sky: a tall gradient with a pale band low on the horizon, dithered so there is no banding. */
function skyTexture() {
  return canvasTex(64, 1024, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0.00, '#04060a');
    grad.addColorStop(0.38, '#0b121b');
    grad.addColorStop(0.50, '#142230');
    grad.addColorStop(0.545, '#2c3e4d');
    grad.addColorStop(0.56, '#1a2733');
    grad.addColorStop(0.75, '#070b10');
    grad.addColorStop(1.00, '#030405');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    const r = rng(7);
    const img = g.getImageData(0, 0, w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (r() - 0.5) * 5;
      img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
  });
}

/** Floor: a fine hexagon grid under a pool of light that fades to nothing at the rim. */
function floorTexture() {
  return canvasTex(1024, 1024, (g, w, h) => {
    g.fillStyle = '#0e141b'; g.fillRect(0, 0, w, h);
    const R = 27, dx = R * Math.sqrt(3), dy = R * 1.5;
    g.lineWidth = 1.4;
    for (let row = -1; row * dy < h + R; row++) {
      for (let col = -1; col * dx < w + dx; col++) {
        const cx = col * dx + (row & 1 ? dx / 2 : 0), cy = row * dy;
        g.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = Math.PI / 6 + (k * Math.PI) / 3;
          g.lineTo(cx + Math.cos(a) * (R - 1.5), cy + Math.sin(a) * (R - 1.5));
        }
        g.closePath();
        g.strokeStyle = 'rgba(122, 160, 196, .16)';
        g.stroke();
        if (((row * 7 + col * 13) & 15) === 0) { g.fillStyle = 'rgba(122, 160, 196, .07)'; g.fill(); }
      }
    }
    const r = rng(11);
    for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(190, 210, 230, ${0.03 + r() * 0.05})`; g.fillRect(r() * w, r() * h, 1 + r() * 2, 1 + r() * 2); }
    // A pool of light in the middle, then a fade to transparent so the floor melts into the dark.
    const pool = g.createRadialGradient(w / 2, h * 0.52, 0, w / 2, h / 2, w / 2);
    pool.addColorStop(0, 'rgba(255, 236, 200, .16)');
    pool.addColorStop(0.45, 'rgba(160, 190, 220, .05)');
    pool.addColorStop(1, 'rgba(0, 0, 0, 0)');
    g.globalCompositeOperation = 'lighter'; g.fillStyle = pool; g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'destination-in';
    const fade = g.createRadialGradient(w / 2, h / 2, w * 0.2, w / 2, h / 2, w / 2);
    fade.addColorStop(0, 'rgba(0, 0, 0, 1)');
    fade.addColorStop(0.62, 'rgba(0, 0, 0, .9)');
    fade.addColorStop(1, 'rgba(0, 0, 0, 0)');
    g.fillStyle = fade; g.fillRect(0, 0, w, h);
  });
}

function softTexture() {
  return canvasTex(64, 64, (g, w, h) => {
    const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,255,255,.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
  });
}

/** A beam: bright at the top, gone by the bottom, soft on both sides. */
function beamTexture() {
  return canvasTex(64, 256, (g, w, h) => {
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = (x / (w - 1)) * 2 - 1, v = y / (h - 1);
        const a = Math.pow(1 - Math.abs(u), 1.8) * Math.pow(1 - v, 1.4);
        const i = (y * w + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(a * 255);
      }
    }
    g.putImageData(img, 0, 0);
  }, false);
}

/** Shipping container skin: ribs and a frame, light enough that the instance colour does the work. */
function containerTexture() {
  return canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 8) { g.fillStyle = x % 16 ? 'rgba(0,0,0,.16)' : 'rgba(0,0,0,.05)'; g.fillRect(x, 0, 4, h); }
    g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 3; g.strokeRect(2, 2, w - 4, h - 4);
    const dark = g.createLinearGradient(0, 0, 0, h);
    dark.addColorStop(0, 'rgba(0,0,0,0)'); dark.addColorStop(1, 'rgba(0,0,0,.4)');
    g.fillStyle = dark; g.fillRect(0, 0, w, h);
  });
}

const POLES = 7;                       // lamp poles on an arc behind the line-up

/** All the scenery in a handful of draw calls: sky, floor, a ring of containers, lamp poles with halos and beams, drifting dust. */
function buildScenery() {
  const g = new THREE.Group();
  const soft = softTexture();
  const r = rng(3);

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(70, 32, 20),
    new THREE.MeshBasicMaterial({ map: skyTexture(), side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  sky.renderOrder = -9;           // after the map's own sky dome (-10), which is bright and encloses us too
  g.add(sky);

  // Containers: one instanced mesh. Stacks stand on a ring behind the line-up and fade into the dark.
  const MAXBOX = 150;
  const boxes = new THREE.InstancedMesh(new THREE.BoxGeometry(2.45, 2.6, 6.4), new THREE.MeshBasicMaterial({ map: containerTexture(), fog: false }), MAXBOX);
  const palette = [0x2b4a5c, 0x5a2a22, 0x2f4b3b, 0x6a5524, 0x39424e, 0x2a3a66, 0x4d3340];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), col = new THREE.Color();
  const pos = new THREE.Vector3(), scl = new THREE.Vector3();
  let n = 0;
  for (let k = 0; k < 64 && n < MAXBOX; k++) {
    const a = (k / 64) * Math.PI * 2 + (r() - 0.5) * 0.05;
    const rad = 24 + r() * 9;
    const x = Math.sin(a) * rad, z = -Math.cos(a) * rad;
    if (z > 9) continue;               // behind the camera, never seen
    const levels = 1 + Math.floor(r() * 3);
    for (let l = 0; l < levels && n < MAXBOX; l++) {
      e.set(0, a + (r() - 0.5) * 0.18, 0);
      q.setFromEuler(e);
      m.compose(pos.set(x, 1.3 + l * 2.62, z), q, scl.set(1, 1, 0.7 + r() * 0.5));
      boxes.setMatrixAt(n, m);
      boxes.setColorAt(n, col.setHex(palette[Math.floor(r() * palette.length)]).multiplyScalar(0.22 + r() * 0.2));
      n++;
    }
  }
  boxes.count = n;
  boxes.instanceMatrix.needsUpdate = true;
  boxes.instanceColor.needsUpdate = true;
  g.add(boxes);

  // Floor and podium.
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(15, 96).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: floorTexture(), transparent: true, roughness: 0.5, metalness: 0.25, fog: false, depthWrite: false }),
  );
  floor.renderOrder = -5;
  floor.position.y = -0.16;
  const podium = new THREE.Mesh(
    new THREE.CylinderGeometry(6.4, 6.7, 0.16, 72),
    new THREE.MeshStandardMaterial({ color: 0x1a232d, roughness: 0.4, metalness: 0.6, fog: false }),
  );
  podium.position.y = -0.08;
  const rim = new THREE.Mesh(new THREE.RingGeometry(6.28, 6.4, 96).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xf3b53f, fog: false }));
  rim.position.y = 0.004;
  const rim2 = new THREE.Mesh(new THREE.RingGeometry(7.0, 7.04, 96).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x8fb4d9, transparent: true, opacity: 0.35, fog: false }));
  rim2.position.y = -0.15;
  g.add(floor, podium, rim, rim2);

  // Lamp poles on an arc behind the players: a thin pole, a glowing head, a halo and a soft beam.
  const poleGeo = new THREE.CylinderGeometry(0.07, 0.11, 1, 8);
  const headGeo = new THREE.BoxGeometry(0.7, 0.16, 0.34);
  const beamTex = beamTexture();
  const beamGeo = new THREE.PlaneGeometry(2.0, 1).translate(0, -0.5, 0);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x151b22, roughness: 0.6, metalness: 0.7, fog: false });
  const headMat = new THREE.MeshBasicMaterial({ color: 0xfff2d6, fog: false });
  const halo = new Float32Array(POLES * 3);
  const beams = [];
  const down = new THREE.Vector3(0, -1, 0), dir = new THREE.Vector3();
  for (let i = 0; i < POLES; i++) {
    const a = (i / (POLES - 1) - 0.5) * 2.5;             // about 143 degrees, centred behind the line-up
    const rad = 9.5 + (i % 2) * 1.6, h = 6.4 + (i % 3) * 0.7;
    const x = Math.sin(a) * rad, z = -Math.cos(a) * rad - 1;
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.scale.y = h; pole.position.set(x, h / 2, z);
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.set(x, h, z); head.lookAt(0, 0, 0);
    g.add(pole, head);
    halo.set([x, h, z], i * 3);
    dir.set(x * 0.12 - x, -h, -z);
    const len = dir.length();
    dir.normalize();
    for (let k = 0; k < 1; k++) {
      const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ map: beamTex, color: i % 2 ? 0x9cc4ee : 0xffe2b0, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
      beam.position.set(x, h, z);
      beam.quaternion.setFromUnitVectors(down, dir);
      beam.rotateY(k * Math.PI / 2);
      beam.scale.set(1, len, 1);
      g.add(beam);
      beams.push(beam);
    }
  }
  const glow = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(halo, 3)),
    new THREE.PointsMaterial({ map: soft, size: 3.0, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false, color: 0xffe9c4, fog: false }));
  glow.frustumCulled = false;
  g.add(glow);

  // Dust turning in the light.
  const DUST = 140;
  const dp = new Float32Array(DUST * 3);
  for (let i = 0; i < DUST; i++) dp.set([(r() - 0.5) * 14, r() * 6, -6 + r() * 10], i * 3);
  const dust = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(dp, 3)),
    new THREE.PointsMaterial({ map: soft, size: 0.11, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, color: 0xc4d8ee, fog: false }));
  dust.frustumCulled = false;
  g.add(dust);

  return {
    group: g,
    tick(t, dt) {
      const a = dust.geometry.attributes.position;
      for (let i = 0; i < DUST; i++) {
        let y = a.getY(i) + dt * (0.05 + (i % 5) * 0.02);
        if (y > 6) y = 0;
        a.setY(i, y);
        a.setX(i, a.getX(i) + Math.sin(t * 0.3 + i) * dt * 0.05);
      }
      a.needsUpdate = true;
      for (let i = 0; i < beams.length; i++) beams[i].material.opacity = 0.07 + Math.sin(t * 0.6 + i * 1.7) * 0.015;
    },
  };
}

export function createStage({ scene, camera }) {
  const group = new THREE.Group();
  group.position.set(0, BASE_Y, 0);
  const scenery = buildScenery();
  group.add(scenery.group);

  // One pad per slot: a glowing ring on the floor and a faint column of light.
  const pads = [];
  const ringGeo = new THREE.RingGeometry(0.5, 0.66, 40).rotateX(-Math.PI / 2);
  const discGeo = new THREE.CircleGeometry(0.5, 40).rotateX(-Math.PI / 2);
  const colGeo = new THREE.CylinderGeometry(0.55, 0.55, 3.6, 24, 1, true);
  const colTex = canvasTex(4, 128, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(255,255,255,0)'); grad.addColorStop(1, 'rgba(255,255,255,1)');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
  }, false);
  function pad(i) {
    if (pads[i]) return pads[i];
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: WAIT, fog: false }));
    const disc = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, fog: false }));
    const col = new THREE.Mesh(colGeo, new THREE.MeshBasicMaterial({ map: colTex, color: WAIT, transparent: true, opacity: 0.1, fog: false, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    ring.position.y = 0.02; disc.position.y = 0.015; col.position.y = 1.8;
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

  let on = false, order = [], slots = [], t = 0, savedBackground = null;
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
      p.userData.col.material.opacity = e.ready || e.host ? 0.09 : 0.035;
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
    scenery.tick(t, dt);
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
      if (v) { scene.add(group); savedBackground = scene.background; scene.background = DARK; } else { scene.remove(group); scene.background = savedBackground; }
      layer.classList.toggle('on', v);
      document.body.classList.toggle('mp-stage', v);
      if (!v) { for (const pl of plates.values()) pl.el.remove(); plates.clear(); order = []; slots = []; }
    },
  };
}
