import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { buildCrate, preloadCrate } from './crateModel.js';
import { applyGunSkin, buildGunModel } from './gunmodels.js';
import { RARITY, RARITY_ORDER } from './gunskins.js';
import { freshPattern } from './gunTextures.js';

/**
 * The SUPPLY DROP: opening a skin crate. A full-screen window of its own, over the store.
 *
 * A supply crate comes down on a parachute through the night, lands, shakes and warms up (its seam
 * flickers through every rarity colour and then locks onto the one you drew), blows its lid and
 * sends up a beam; the skin rises out of it on a gun you can spin with the mouse or a finger.
 *
 * It is only a show. The draw has already been made and saved by the time `play` is called, so
 * leaving in the middle can never lose the skin. The scene is its own small WebGL context that
 * exists only while the window is open, and the loop stops when it closes (battery).
 *
 * The beats are driven by the clock, not by frames, so a slow machine sees fewer frames of the same
 * sequence instead of a longer one; and the buttons appear on a timer, so they never wait on WebGL.
 */

preloadCrate();             // fetch the modelled crate while the menus are open

const FALL = 2100;          // ms: the crate touches down
const LOCK = 3300;          // the seam stops flickering and shows the rarity
const BURST = 4300;         // the lid goes
const CARD = 5200;          // name and buttons
const START_Y = 9.5;
const GUN_LEN = 2.7;        // metres on screen
const TAU = Math.PI * 2;

const ease = {
  out: (t) => 1 - (1 - t) ** 3,
  back: (t) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2,
};
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const calm = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const COIN = '<i class="coin"></i>';

/** A soft round sprite, drawn once. */
function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * A shaft of light: soft at its silhouette (so it never reads as a hard-edged tube), brightest at
 * the foot and gone at the top, with slow streaks drifting up it. `uOpacity` is the only knob.
 */
function beamMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color.clone() }, uOpacity: { value: 0 }, uTime: { value: 0 } },
    vertexShader: `
      varying vec3 vN; varying vec3 vV; varying vec2 vUv; varying vec3 vP;
      void main() {
        vUv = uv; vP = position;
        vN = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vV = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uOpacity; uniform float uTime;
      varying vec3 vN; varying vec3 vV; varying vec2 vUv; varying vec3 vP;
      void main() {
        float facing = abs(dot(normalize(vN), normalize(vV)));
        float soft = smoothstep(0.0, 0.85, facing);
        float rise = pow(clamp(1.0 - vUv.y, 0.0, 1.0), 1.6);
        float a = atan(vP.x, vP.z);
        float streak = 0.72 + 0.18 * sin(a * 7.0 + vUv.y * 5.0 - uTime * 1.4) + 0.1 * sin(a * 17.0 - vUv.y * 9.0 - uTime * 2.3);
        float alpha = soft * soft * rise * streak * uOpacity;
        gl_FragColor = vec4(uColor, alpha);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
}

/** Orange and white panels for the parachute. */
function canopyTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 32;
  const g = c.getContext('2d');
  for (let i = 0; i < 12; i++) {
    g.fillStyle = i % 2 ? '#f4efe6' : '#f08a24';
    g.fillRect((i * 256) / 12, 0, 256 / 12 + 1, 32);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createDrop({ sfx = () => {}, gunId = 'ar' } = {}) {
  let root = null, canvas = null, renderer = null;
  let scene = null, camera = null, S = null;           // S: everything the current play made
  let raf = 0, tick = 0, t0 = 0, resolve = null, open = false, quiet = false;
  let rarity = 'common', color = new THREE.Color('#9aa6b2');
  const own = [];                                      // disposables made by the current play
  const drag = { on: false, x: 0, y: 0, yaw: 0, pitch: 0, vyaw: 0, last: 0 };

  const q = (sel) => root.querySelector(sel);
  const track = (o) => { own.push(o); return o; };

  function build() {
    root = document.createElement('div');
    root.id = 'drop';
    root.className = 'hidden';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Supply drop');
    root.innerHTML = `
      <canvas id="drop-canvas"></canvas>
      <div class="dr-flash" id="drop-flash"></div>
      <button id="drop-skip" type="button">SKIP<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l7 7-7 7M13 5l7 7-7 7"/></svg></button>
      <div class="dr-hint" id="drop-hint" aria-live="polite"></div>
      <div class="dr-card" id="drop-win" hidden>
        <em id="drop-rar"></em>
        <b id="drop-name"></b>
        <div class="dr-act">
          <button type="button" id="drop-try">TRY IT</button>
          <button type="button" id="drop-again"></button>
          <button type="button" id="drop-done">DONE</button>
        </div>
      </div>`;
    document.body.appendChild(root);
    canvas = q('#drop-canvas');
    q('#drop-skip').addEventListener('click', skip);
    q('#drop-try').addEventListener('click', () => finish('try'));
    q('#drop-again').addEventListener('click', () => finish('again'));
    q('#drop-done').addEventListener('click', () => finish('done'));
    addEventListener('keydown', (e) => {
      if (!open || e.code !== 'Escape') return;
      e.stopImmediatePropagation();
      if (q('#drop-win').hidden) skip(); else finish('done');
    }, true);
    addEventListener('resize', fit);
    canvas.addEventListener('pointerdown', (e) => {
      if (!S?.gun) return;
      drag.on = true; drag.x = e.clientX; drag.y = e.clientY; drag.vyaw = 0; drag.last = performance.now();
      canvas.setPointerCapture?.(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag.on) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      drag.yaw += dx * 0.011;
      drag.pitch = Math.max(-0.7, Math.min(0.7, drag.pitch + dy * 0.006));
      drag.vyaw = dx * 0.011;
      drag.last = performance.now();
    });
    const up = () => { drag.on = false; };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
  }

  function ensureRenderer() {
    if (renderer) return true;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch { renderer = null; return false; }
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    return true;
  }

  function fit() {
    if (!open || !renderer || !camera) return;
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // A narrow window backs the camera off so the crate and the parachute still fit.
    camera.userData.dist = Math.min(13, 7.4 * Math.max(1, 1.55 / camera.aspect));
    camera.updateProjectionMatrix();
  }

  /* ----------------------------- the scene ----------------------------- */

  function makeScene(skin) {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 80);
    camera.userData.dist = 7.4;
    const pm = new THREE.PMREMGenerator(renderer);
    const env = track(pm.fromScene(new RoomEnvironment(), 0.04).texture);
    pm.dispose();
    scene.environment = env;
    scene.environmentIntensity = 0.55;

    scene.add(new THREE.HemisphereLight(0x9bb4e0, 0x141a26, 0.9));
    const key = new THREE.DirectionalLight(0xfff1dc, 2.1);
    key.position.set(3.5, 6, 4.5);
    scene.add(key);
    const glowLight = new THREE.PointLight(color, 0, 10, 1.6);
    glowLight.position.set(0, 1.5, 1.2);
    scene.add(glowLight);

    const dot = track(dotTexture());
    const mat = (m) => track(m);

    // Stars
    const starPos = new Float32Array(260 * 3);
    for (let i = 0; i < 260; i++) {
      const a = Math.random() * TAU, r = 18 + Math.random() * 14;
      starPos[i * 3] = Math.cos(a) * r; starPos[i * 3 + 1] = -2 + Math.random() * 22; starPos[i * 3 + 2] = -10 - Math.random() * 18 + Math.sin(a) * 4;
    }
    const starGeo = track(new THREE.BufferGeometry());
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    scene.add(new THREE.Points(starGeo, mat(new THREE.PointsMaterial({ color: 0xcfe0ff, size: 0.09, transparent: true, opacity: 0.8, map: dot, depthWrite: false }))));

    // Ground: a dark hex floor under a pool of light
    const hex = track(freshPattern('hex'));
    hex.repeat.set(9, 9);
    const floor = new THREE.Mesh(track(new THREE.CircleGeometry(7, 64)), mat(new THREE.MeshStandardMaterial({ map: hex, color: 0x141c2c, roughness: 0.6, metalness: 0.45 })));
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
    const pool = new THREE.Mesh(track(new THREE.PlaneGeometry(9, 9)), mat(new THREE.MeshBasicMaterial({ map: dot, color, transparent: true, opacity: 0.0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })));
    pool.rotation.x = -Math.PI / 2; pool.position.y = 0.01;
    scene.add(pool);
    const ring = new THREE.Mesh(track(new THREE.TorusGeometry(1.55, 0.03, 8, 72)), mat(new THREE.MeshBasicMaterial({ color: 0xf3b53f, toneMapped: false })));
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.02;
    scene.add(ring);

    // The crate
    const built = buildCrate();
    track({ dispose: built.dispose });
    const { crate, lid, seamMat } = built;
    built.actions?.idle?.play();
    crate.position.y = START_Y;
    scene.add(crate);

    // The parachute
    const chute = new THREE.Group();
    const canopy = new THREE.Mesh(
      track(new THREE.SphereGeometry(1.75, 28, 12, 0, TAU, 0, Math.PI * 0.5)),
      mat(new THREE.MeshStandardMaterial({ map: track(canopyTexture()), roughness: 0.85, metalness: 0, side: THREE.DoubleSide, transparent: true })),
    );
    canopy.scale.y = 0.62;
    chute.add(canopy);
    const lines = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      lines.push(Math.cos(a) * 1.72, 0, Math.sin(a) * 1.72);
      lines.push(Math.sign(Math.cos(a)) * 0.7, -2.35, Math.sign(Math.sin(a)) * 0.5);
    }
    const lineGeo = track(new THREE.BufferGeometry());
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    const lineMat = mat(new THREE.LineBasicMaterial({ color: 0xd9dde4, transparent: true }));
    chute.add(new THREE.LineSegments(lineGeo, lineMat));
    chute.position.y = 3.45;
    crate.add(chute);

    // The beam and the rings
    const beam = new THREE.Mesh(track(new THREE.CylinderGeometry(0.62, 1.05, 16, 48, 1, true)), mat(beamMaterial(color)));
    beam.position.y = 8.9;
    const core = new THREE.Mesh(track(new THREE.CylinderGeometry(0.14, 0.3, 16, 32, 1, true)), mat(beamMaterial(new THREE.Color(0xffffff))));
    core.position.y = 8.9;
    scene.add(beam, core);
    const ringGeo = track(new THREE.RingGeometry(0.92, 1, 72));
    const waves = [];
    const wave = (delay, size, strength) => {
      const m = new THREE.Mesh(ringGeo, mat(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false })));
      m.rotation.x = -Math.PI / 2; m.position.y = 0.05; m.visible = false;
      scene.add(m);
      waves.push({ m, at: delay, size, strength, done: false });
    };

    // Sparks
    const COUNT = 420;
    const P = {
      pos: new Float32Array(COUNT * 3), vel: new Float32Array(COUNT * 3), col: new Float32Array(COUNT * 3), life: new Float32Array(COUNT), max: new Float32Array(COUNT), at: 0,
    };
    const pGeo = track(new THREE.BufferGeometry());
    pGeo.setAttribute('position', new THREE.BufferAttribute(P.pos, 3));
    pGeo.setAttribute('color', new THREE.BufferAttribute(P.col, 3));
    const sparks = new THREE.Points(pGeo, mat(new THREE.PointsMaterial({ size: 0.16, map: dot, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })));
    sparks.frustumCulled = false;
    scene.add(sparks);
    for (let i = 0; i < COUNT; i++) P.pos[i * 3 + 1] = -50;

    // The skin, on a gun
    const gun = new THREE.Group();
    const model = buildGunModel(gunId);
    applyGunSkin(model, skin);
    model.rotation.y = Math.PI / 2;
    model.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(model), size = bb.getSize(new THREE.Vector3()), mid = bb.getCenter(new THREE.Vector3());
    model.position.sub(mid);
    gun.add(model);
    const gunSize = Math.max(size.x, size.z);
    gun.scale.setScalar(GUN_LEN / gunSize);
    gun.visible = false;
    scene.add(gun);

    S = { crate, chute, lid, built, seamMat, glowLight, pool, ring, beam, core, waves, wave, P, sparks, gun, lineMat, canopy, key,
      fired: { land: false, lock: false, burst: false }, lidV: new THREE.Vector3(), lidSpin: new THREE.Vector3(), lidT: 0, chuteV: 0, shake: 0, gunT: -1, gunSize };
    const top = RARITY_ORDER.indexOf(rarity);
    wave(0, 5 + top, 0.9);
    if (top >= 1) wave(0.12, 7 + top, 0.6);
    if (top >= 2) wave(0.26, 9 + top, 0.5);
    if (top >= 3) wave(0.4, 13, 0.7);
  }

  function emit(n, { speed = 4, up = 3, spread = 1, from = [0, 1, 0], life = 1.1, white = 0.4 } = {}) {
    const { P } = S;
    for (let k = 0; k < n; k++) {
      const i = P.at = (P.at + 1) % (P.life.length);
      const a = Math.random() * TAU, r = Math.random() * spread;
      P.pos[i * 3] = from[0] + Math.cos(a) * r * 0.4; P.pos[i * 3 + 1] = from[1]; P.pos[i * 3 + 2] = from[2] + Math.sin(a) * r * 0.4;
      const v = speed * (0.35 + Math.random() * 0.65);
      P.vel[i * 3] = Math.cos(a) * v * spread; P.vel[i * 3 + 1] = up * (0.4 + Math.random() * 0.9); P.vel[i * 3 + 2] = Math.sin(a) * v * spread;
      P.life[i] = life * (0.6 + Math.random() * 0.6);
      const mix = Math.random() < white ? 1 : 0;
      P.col[i * 3] = color.r + (1 - color.r) * mix * 0.7; P.col[i * 3 + 1] = color.g + (1 - color.g) * mix * 0.7; P.col[i * 3 + 2] = color.b + (1 - color.b) * mix * 0.7;
      P.max[i] = P.life[i];
    }
  }

  const SEAM_IDLE = new THREE.Color(0x59657a);
  const cycle = RARITY_ORDER.map((r) => new THREE.Color(RARITY[r].color));

  /** One frame of the show at `t` ms since the start. */
  function frame(t, dt) {
    const top = RARITY_ORDER.indexOf(rarity);
    const { crate, chute, lid, seamMat, glowLight, pool, beam, core, waves, P, sparks, gun, fired } = S;

    // Fall: slows to a stop as the chute bites
    const f = clamp01(t / FALL);
    const y = START_Y * (1 - ease.out(f));
    if (!fired.land) {
      crate.position.y = y;
      crate.rotation.z = Math.sin(t / 260) * 0.05 * (1 - f);
      chute.rotation.z = -Math.sin(t / 260) * 0.03;
    }
    const camY = 1.75 + (y / START_Y) * 2.4;
    camera.position.set(0, camY, camera.userData.dist);
    const reveal = clamp01((t - BURST) / 1200);
    camera.position.z -= reveal * 0.9;
    camera.lookAt(0, 0.5 + reveal * 0.1 + (y / START_Y) * 1.2, 0);

    if (t >= FALL && !fired.land) {
      fired.land = true;
      crate.position.y = 0; crate.rotation.z = 0;
      const A = S.built.actions;
      if (A) { A.idle.stop(); A.land.reset().play(); }
      S.chuteV = 0.4;
      if (!quiet) emit(46, { speed: 2.6, up: 0.7, spread: 1.6, from: [0, 0.05, 0], life: 0.9, white: 0.9 });
      sfx('thud', rarity);
    }
    // The parachute collapses and drifts off
    if (fired.land) {
      S.chuteV += dt * 0.9;
      const k = clamp01((t - FALL) / 900);
      chute.scale.y = 1 - 0.8 * k;
      chute.position.y = 3.45 - k * 2.25;
      chute.position.x = k * 0.9;
      chute.rotation.z = k * 0.5;
      const fade = 1 - clamp01((t - FALL) / 1200);
      S.canopy.material.opacity = fade; S.lineMat.opacity = fade;
      chute.visible = fade > 0.01;
    }

    // Charging: the seam runs through every colour, then locks on the real one
    const charging = t >= FALL && t < BURST;
    if (charging) {
      const warm = clamp01((t - FALL) / (BURST - FALL));
      if (t < LOCK) {
        const idx = Math.floor((t - FALL) / 120) % cycle.length;
        seamMat.color.copy(cycle[idx]);
        glowLight.color.copy(cycle[idx]);
        glowLight.intensity = 1 + Math.sin(t / 40) * 0.5;
      } else {
        if (!fired.lock) { fired.lock = true; sfx('lock', rarity); }
        seamMat.color.copy(color);
        glowLight.color.copy(color);
        glowLight.intensity = 1.2 + ((t - LOCK) / (BURST - LOCK)) * (2.5 + top);
      }
      pool.material.opacity = 0.08 + warm * 0.3;
      pool.material.color.copy(seamMat.color);
      const amp = quiet ? 0 : (0.004 + warm * 0.032) * (t < LOCK ? 0.6 : 1.4);
      if (S.built.actions) {
        const A = S.built.actions;
        if (t >= FALL + 800 && !A.shake.isRunning()) A.shake.reset().play();
        A.shake.setEffectiveWeight(0.2 + warm * 1.6);
      } else {
        crate.position.x = (Math.random() - 0.5) * amp * 2;
        crate.position.z = (Math.random() - 0.5) * amp;
        crate.rotation.z = (Math.random() - 0.5) * amp * 0.9;
      }
      if (!quiet && Math.random() < 0.5) emit(1, { speed: 0.5, up: 1.6, spread: 0.6, from: [(Math.random() - 0.5) * 1.3, 0.92, (Math.random() - 0.5) * 0.9], life: 0.7, white: 0.5 });
    } else if (t < FALL) {
      seamMat.color.copy(SEAM_IDLE);
    }

    // Burst
    if (t >= BURST && !fired.burst) {
      fired.burst = true;
      crate.position.set(0, 0, 0); crate.rotation.z = 0;
      S.lidV.set((Math.random() < 0.5 ? -1 : 1) * (1 + Math.random()), 7.5 + top, -2.5 - Math.random() * 1.5);   // up and away from the camera
      S.lidSpin.set(Math.random() * 6 - 3, Math.random() * 6 - 3, Math.random() * 6 - 3);
      const A = S.built.actions;
      if (A) { A.shake.stop(); A.open.reset().play(); }
      S.shake = quiet ? 0 : [0.05, 0.1, 0.17, 0.3][top];
      if (!quiet) emit([90, 140, 230, 400][top], { speed: 4.4 + top, up: 6 + top * 1.5, spread: 1, from: [0, 1, 0], life: 1.5, white: 0.5 });
      const fl = q('#drop-flash');
      if (!quiet) { fl.style.setProperty('--fc', RARITY[rarity].color); fl.classList.remove('go'); void fl.offsetWidth; fl.classList.add('go'); }
      sfx('burst', rarity);
    }
    if (fired.burst) {
      const b = (t - BURST) / 1000;
      // Lid
      S.lidT += dt;
      if (!S.built.actions) {
        S.lidV.y -= 16 * dt;
        lid.position.addScaledVector(S.lidV, dt);
        lid.rotation.x += S.lidSpin.x * dt; lid.rotation.y += S.lidSpin.y * dt; lid.rotation.z += S.lidSpin.z * dt;
        lid.visible = S.lidT < 1.1;
      }
      // Beam: shoots up, settles to a steady glow
      const grow = ease.out(clamp01(b / 0.35));
            // A flash of light that eases to a faint haze, so the gun is what you look at.
      const haze = 0.09 + 0.3 * Math.exp(-b * 2.2);
      beam.material.uniforms.uOpacity.value = grow * (haze + 0.03 * top);
      core.material.uniforms.uOpacity.value = grow * (0.04 + 0.26 * Math.exp(-b * 3.2));
      beam.material.uniforms.uTime.value = b; core.material.uniforms.uTime.value = b;
      beam.scale.set(0.25 + 0.75 * grow, 1, 0.25 + 0.75 * grow);
      core.scale.set(0.2 + 0.8 * grow, 1, 0.2 + 0.8 * grow);
      seamMat.color.copy(color).lerp(new THREE.Color(0xffffff), 0.5 * Math.exp(-b * 3));
      glowLight.intensity = (3.2 + top * 1.4) * (0.4 + 0.6 * Math.exp(-b * 2));
      pool.material.opacity = 0.18 + 0.2 * Math.exp(-b * 2);
      // Rings
      for (const w of waves) {
        const k = (b - w.at) / 1.1;
        if (k < 0 || w.done) continue;
        if (k >= 1) { w.done = true; w.m.visible = false; continue; }
        w.m.visible = true;
        const s = 0.5 + ease.out(k) * w.size;
        w.m.scale.set(s, s, 1);
        w.m.material.opacity = (1 - k) * w.strength;
      }
      // Camera shake
      if (S.shake > 0.001) {
        camera.position.x += (Math.random() - 0.5) * S.shake;
        camera.position.y += (Math.random() - 0.5) * S.shake;
        S.shake *= Math.exp(-dt * 4.5);
      }
      // The skin comes up out of the crate
      if (t >= BURST + 280) {
        if (S.gunT < 0) { S.gunT = t; gun.visible = true; sfx('reveal', rarity); }
        const k = clamp01((t - S.gunT) / 950);
        const e = ease.back(k);
        gun.position.y = 0.9 + e * 1.0;
        gun.scale.setScalar((GUN_LEN / S.gunSize) * (0.25 + 0.75 * e));
        const now = performance.now();
        if (!drag.on) {
          if (now - drag.last > 1600) drag.vyaw = 0.012 * (quiet ? 0.3 : 1);   // idle: a slow turn
          drag.yaw += drag.vyaw * (dt * 60);
          drag.vyaw *= drag.last && now - drag.last < 1600 ? Math.exp(-dt * 2.6) : 1;
          drag.pitch *= Math.exp(-dt * 1.2);
        }
        const bob = quiet ? 0 : Math.sin((t - S.gunT) / 520) * 0.05 * k;
        gun.position.y += bob;
        gun.rotation.set(drag.pitch, drag.yaw, 0);
        if (!quiet && Math.random() < 0.6) emit(1, { speed: 0.6, up: 1.4, spread: 1.3, from: [0, 1.0, 0], life: 1.6, white: 0.3 });
      }
    }

    // The clips run on the drop's own clock (t), so a skip or a faked clock lands them in the right place
    const M = S.built.mixer;
    if (M) {
      const A = S.built.actions;
      if (fired.burst) A.open.time = Math.min((t - BURST) / 1000, A.open.getClip().duration);
      else if (fired.land) {
        A.land.time = Math.min((t - FALL) / 1000, A.land.getClip().duration);
        if (A.shake.isRunning()) A.shake.time = (t - FALL - 800) / 1000 % A.shake.getClip().duration;
      } else A.idle.time = t / 1000 % A.idle.getClip().duration;
      M.update(0);
    }

    // Sparks
    const hot = fired.burst || fired.land;
    if (hot) {
      for (let i = 0; i < P.life.length; i++) {
        if (P.life[i] <= 0) { P.pos[i * 3 + 1] = -50; continue; }
        P.life[i] -= dt;
        P.vel[i * 3 + 1] -= 7.5 * dt;
        P.pos[i * 3] += P.vel[i * 3] * dt; P.pos[i * 3 + 1] += P.vel[i * 3 + 1] * dt; P.pos[i * 3 + 2] += P.vel[i * 3 + 2] * dt;
        if (P.pos[i * 3 + 1] < 0.02) { P.pos[i * 3 + 1] = 0.02; P.vel[i * 3 + 1] *= -0.3; P.vel[i * 3] *= 0.7; P.vel[i * 3 + 2] *= 0.7; }
        const a = clamp01(P.life[i] / P.max[i]);
        P.col[i * 3] *= 0.5 + 0.5 * a; P.col[i * 3 + 1] *= 0.5 + 0.5 * a; P.col[i * 3 + 2] *= 0.5 + 0.5 * a;
      }
      sparks.geometry.attributes.position.needsUpdate = true;
      sparks.geometry.attributes.color.needsUpdate = true;
    }
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (!S) return;
    const t = now - t0 + (S.skipTo ?? 0);
    const dt = Math.min(0.1, (now - (S.lastNow ?? now)) / 1000);
    S.lastNow = now;
    frame(t, dt);
    renderer.render(scene, camera);
  }

  /* ----------------------------- the window ----------------------------- */

  function elapsed() { return performance.now() - t0 + (S?.skipTo ?? 0); }

  function hint(text) { const h = q('#drop-hint'); h.textContent = text; h.classList.toggle('on', !!text); }

  /** The DOM side, on a timer so the buttons never wait on a frame. */
  function step(skin, again) {
    const t = elapsed();
    if (t < FALL) hint('SUPPLY DROP INBOUND');
    else if (t < BURST) hint('DECRYPTING');
    else hint('');
    if (t >= CARD && q('#drop-win').hidden) {
      const win = q('#drop-win');
      win.hidden = false;
      win.style.setProperty('--rc', RARITY[rarity].color);
      win.className = `dr-card r-${rarity}`;
      q('#drop-rar').textContent = RARITY[rarity].name;
      q('#drop-name').textContent = skin.name;
      const btn = q('#drop-again');
      btn.innerHTML = again.ok ? `${COIN}<b>${again.price}</b><span>OPEN ANOTHER</span>` : `<span>${again.label}</span>`;
      btn.disabled = !again.ok;
      q('#drop-skip').hidden = true;
      q('#drop-try').focus({ preventScroll: true });
    }
  }

  function skip() {
    if (!open || !S) return;
    const t = elapsed();
    if (t < BURST + 40) S.skipTo = (S.skipTo ?? 0) + (BURST + 40 - t);
    else if (t < CARD) S.skipTo = (S.skipTo ?? 0) + (CARD - t);
    q('#drop-skip').hidden = t >= BURST;
  }

  function dispose() {
    while (own.length) {
      const o = own.pop();
      o.dispose?.();
    }
    if (scene) {
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose?.();
        const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of ms) m.dispose?.();
      });
    }
    scene = null; S = null;
  }

  function stop() {
    cancelAnimationFrame(raf);
    clearInterval(tick);
    raf = 0; tick = 0;
  }

  function finish(action) {
    const r = resolve;
    resolve = null;
    if (action !== 'again') close();
    else { stop(); q('#drop-win').hidden = true; }
    r?.(action);
  }

  /**
   * Run the show for `skin` (an entry of GUN_SKINS) and resolve with what the player chose:
   * 'try', 'again' or 'done'. `again` is `{ ok, price, label }`: whether another crate can be
   * opened right now. A second `play` while the window is open reuses it.
   */
  function play(skin, again = { ok: false, label: 'NO CRATES LEFT' }) {
    if (!root) build();
    resolve?.('done');
    stop();
    dispose();
    open = true;
    quiet = calm();
    rarity = skin.rarity;
    color = new THREE.Color(RARITY[rarity].color);
    root.classList.remove('hidden');
    q('#drop-win').hidden = true;
    q('#drop-skip').hidden = false;
    q('#drop-flash').classList.remove('go');
    drag.yaw = 0; drag.pitch = 0; drag.vyaw = 0; drag.last = 0; drag.on = false;
    t0 = performance.now();
    const gl = ensureRenderer();
    if (gl) {
      makeScene(skin);
      fit();
      if (quiet) S.skipTo = BURST - 500;
      sfx('fall', rarity);
      raf = requestAnimationFrame(loop);
    } else {
      S = { skipTo: CARD };                       // no WebGL: straight to the name and the buttons
    }
    tick = setInterval(() => step(skin, again), 80);
    step(skin, again);
    return new Promise((r) => { resolve = r; });
  }

  function close() {
    if (!root || !open) return;
    open = false;
    stop();
    dispose();
    root.classList.add('hidden');
    const r = resolve;
    resolve = null;
    r?.('done');
  }

  return { play, close, isOpen: () => open };
}
