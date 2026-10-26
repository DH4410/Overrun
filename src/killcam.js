import * as THREE from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

import { CONFIG } from './config.js';
import { clamp, lerp } from './utils.js';

/**
 * The kill cam. When a bot kills you the camera first swings onto them and zooms in while the
 * world runs in slow motion, then the screen rewinds into a replay of the last few seconds at
 * real speed, through the killer's own eyes: their posed skeleton, gun and aim as they were
 * drawn, so what you see is what they saw (the sights, the shots, you), and every shot they
 * fired, with the first-person gun in the hands, the scope when they were scoped, and the damage
 * numbers and hit markers they saw as each shot landed on you. After it, a short respawn wait.
 *
 * What is recorded is the drawn pose, not the simulation, so the replay is exactly what the
 * game showed, and nothing here can change a result. Single player only.
 */

const REC_HZ = 30;
const KEEP = 3.6;                       // seconds of history kept per bot
const SLOTS = Math.ceil(KEEP * REC_HZ) + 2;

export const ZOOM_TIME = 1.7;           // slow-motion zoom on the killer (real seconds)
const ZOOM_SCALE = 0.3;                 // world speed during it
const CUT_TIME = 0.45;                  // the rewind between the two
const REPLAY_MAX = 3.2;                 // seconds of replay (less if less was recorded)
const HOLD_TIME = 0.7;                  // lingering on the moment it lands
export const AFTER_TIME = 1.3;          // the death screen after the cam, before respawn
const AVATAR_SCALE = 1.2, AVATAR_FOOT = 0.78;
const SKIP_AFTER = 0.9;

export function createKillcam({
  scene, camera, player, bots, buildCharacterMesh, getOperatorId, losClear, Audio, spawnBlood, spawnSparks, WEAPON_BY_ID,
  fp = null,
}) {
  const $ = (id) => document.getElementById(id);
  let now = 0, acc = 0;
  const rings = new Map();              // bot -> { head, n, frames[] }
  const me = [];                        // my own recorded states, newest last
  const shots = [];                     // { t, bot, o: Vector3, d: Vector3, w }
  const hits = [];                      // { t, bot, p: Vector3, dmg, head, zone, armored, lethal }

  /* ------------------------------- recording ------------------------------- */

  function skinnedOf(mesh) {
    if (mesh.userData.__kcSkin !== undefined) return mesh.userData.__kcSkin;
    let found = null;
    mesh.traverse((o) => { if (!found && o.isSkinnedMesh) found = o; });
    mesh.userData.__kcSkin = found;
    return found;
  }

  function ringFor(bot) {
    let r = rings.get(bot);
    if (!r) {
      const skin = skinnedOf(bot.mesh);
      const nb = skin ? skin.skeleton.bones.length : 0;
      r = { head: 0, n: 0, nb, frames: [] };
      for (let i = 0; i < SLOTS; i++) {
        r.frames.push({ t: 0, px: 0, py: 0, pz: 0, ry: 0, rx: 0, aim: 0, bones: new Float32Array(nb * 7), gun: new Float32Array(16), hasGun: false });
      }
      rings.set(bot, r);
    }
    return r;
  }

  /** Called every rendered frame while you are alive in a match; samples at REC_HZ. */
  function record(dt) {
    now += dt;
    acc += dt;
    if (acc < 1 / REC_HZ) return;
    acc = 0;
    const p = player.body.position;
    me.push({ t: now, x: p.x, y: p.y, z: p.z, yaw: player.yaw, vx: player.body.velocity.x, vz: player.body.velocity.z, crouch: !!player.crouching });
    while (me.length && now - me[0].t > KEEP) me.shift();
    for (const b of bots) {
      if (!b.alive || !b.mesh) continue;
      const near = b.target === player || Math.hypot(b.body.position.x - p.x, b.body.position.z - p.z) < 38;
      if (!near) continue;
      const skin = skinnedOf(b.mesh);
      if (!skin) continue;
      const r = ringFor(b);
      const f = r.frames[r.head];
      r.head = (r.head + 1) % SLOTS;
      r.n = Math.min(SLOTS, r.n + 1);
      f.t = now;
      f.px = b.mesh.position.x; f.py = b.mesh.position.y; f.pz = b.mesh.position.z;
      f.ry = b.mesh.rotation.y; f.rx = b.mesh.rotation.x;
      f.aim = b.aimW ?? 0;
      const bones = skin.skeleton.bones;
      for (let i = 0, k = 0; i < bones.length; i++, k += 7) {
        const bn = bones[i];
        f.bones[k] = bn.position.x; f.bones[k + 1] = bn.position.y; f.bones[k + 2] = bn.position.z;
        f.bones[k + 3] = bn.quaternion.x; f.bones[k + 4] = bn.quaternion.y; f.bones[k + 5] = bn.quaternion.z; f.bones[k + 6] = bn.quaternion.w;
      }
      f.hasGun = !!b.gunMesh;
      if (b.gunMesh) { b.gunMesh.updateMatrix?.(); f.gun.set(b.gunMesh.matrix.elements); }
    }
    for (const r of rings.values()) if (r.n && now - r.frames[(r.head + SLOTS - 1) % SLOTS].t > KEEP) r.n = 0;
    while (shots.length && now - shots[0].t > KEEP) shots.shift();
    while (hits.length && now - hits[0].t > KEEP) hits.shift();
  }

  function noteShot(shooter, origin, dir, weaponId) {
    if (shooter === player || !rings.has(shooter)) return;
    const last = shots[shots.length - 1];
    // A shotgun fires a pellet per call: one event per trigger pull is enough.
    if (last && last.bot === shooter && now - last.t < 0.02) return;
    shots.push({ t: now, bot: shooter, o: origin.clone(), d: dir.clone(), w: weaponId });
  }
  function noteHit(source, pos, info = {}) {
    if (source && source !== player) hits.push({ t: now, bot: source, p: pos.clone(), ...info });
  }

  /* ------------------------------- playback ------------------------------- */

  let phase = 'off', t = 0;
  let killer = null, killerName = '', killerWeapon = '', headshot = false, kWeapon = null;
  let ghostK = null, ghostMe = null, meAction = null;
  let frames = null, startT = 0, endT = 0;
  let hid = [];                         // live bot meshes hidden for the replay
  const tracers = [], flashes = [];
  const _q = new THREE.Quaternion(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
  const _gm1 = new THREE.Matrix4(), _gm2 = new THREE.Matrix4(), _gp1 = new THREE.Vector3(), _gp2 = new THREE.Vector3();
  const _gq1 = new THREE.Quaternion(), _gq2 = new THREE.Quaternion(), _gs = new THREE.Vector3(), _gs2 = new THREE.Vector3();

  const flashTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,240,200,1)'); gr.addColorStop(0.35, 'rgba(255,170,60,.7)'); gr.addColorStop(1, 'rgba(255,120,20,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();

  function makeGhostOf(bot) {
    // Object3D.copy() round-trips userData through JSON, and a bot's holds its mixer and actions,
    // which point back at each other. The clone needs none of it, so set it aside while cloning.
    const parked = [];
    bot.mesh.traverse((o) => { parked.push([o, o.userData]); o.userData = {}; });
    let g;
    try { g = skeletonClone(bot.mesh); } finally { for (const [o, u] of parked) o.userData = u; }
    g.traverse((o) => {
      if (o.isMesh) { o.material = o.material.clone(); o.material.transparent = false; o.material.opacity = 1; o.frustumCulled = false; }
    });
    g.visible = false;
    g.userData.gunIndex = bot.gunMesh ? bot.mesh.children.indexOf(bot.gunMesh) : -1;
    g.userData.skin = null;
    g.traverse((o) => { if (!g.userData.skin && o.isSkinnedMesh) g.userData.skin = o; });
    // The replay looks out of this head, so it is shrunk away: the camera sits inside it.
    const head = g.userData.skin?.skeleton.bones.find((bn) => /Head$/.test(bn.name));
    if (head) head.scale.setScalar(0.001);
    g.userData.head = head ?? null;
    scene.add(g);
    return g;
  }

  function disposeGhost(g) {
    if (!g) return;
    scene.remove(g);
    g.traverse((o) => { if (o.isMesh && o.material?.dispose) o.material.dispose(); });
  }

  /** Is there a recording of this killer, ending at the moment of the kill? */
  function framesOf(bot) {
    const r = rings.get(bot);
    if (!r || r.n < 6) return null;
    const out = [];
    for (let i = 0; i < r.n; i++) out.push(r.frames[(r.head - r.n + i + SLOTS * 2) % SLOTS]);
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  /**
   * You were just killed by `source`. Returns the seconds the cam will run (0 for none, in which
   * case the ordinary death screen is used).
   */
  function begin(source, wasHeadshot, extra = {}) {
    reset();
    if (!source || source === player || !source.alive || !source.mesh) return 0;
    killer = source;
    killerName = source.name;
    kWeapon = WEAPON_BY_ID[source.weaponId] ?? null;
    killerWeapon = kWeapon?.name ?? '';
    headshot = !!wasHeadshot;
    frames = framesOf(source);
    if (frames) {
      endT = now;
      startT = Math.max(frames[0].t, endT - REPLAY_MAX);
      ghostK = makeGhostOf(source);
      ghostMe = buildCharacterMesh(extra.operatorId ?? getOperatorId());
      if (ghostMe) {
        ghostMe.scale.setScalar(AVATAR_SCALE);
        ghostMe.visible = false;
        scene.add(ghostMe);
        for (const a of Object.values(ghostMe.userData.clips ?? {})) a.weight = 0;
      }
    }
    phase = 'zoom'; t = 0;
    document.body.classList.add('killcam');
    const name = $('kc-name'), who = $('kc-who'), wp = $('kc-weapon');
    if (name) name.textContent = killerName;
    if (who) who.textContent = 'ELIMINATED BY';
    if (wp) wp.textContent = `${killerWeapon}${headshot ? ' · HEADSHOT' : ''}`;
    const lost = $('kc-lost');
    if (lost) lost.textContent = extra.lost ? `YOUR ${extra.lost}-KILL STREAK ENDED` : '';
    $('killcam')?.classList.remove('replay');
    $('killcam')?.classList.add('on');
    return ZOOM_TIME + (frames ? CUT_TIME + (endT - startT) + HOLD_TIME : 0);
  }

  function reset() {
    if (phase === 'off' && !ghostK && !ghostMe && !hid.length) return;
    phase = 'off'; t = 0;
    for (const m of hid) m.o.visible = m.v;
    hid = [];
    disposeGhost(ghostK); disposeGhost(ghostMe);
    ghostK = ghostMe = null; meAction = null;
    for (const x of tracers) scene.remove(x.mesh);
    for (const x of flashes) scene.remove(x.sprite);
    tracers.length = 0; flashes.length = 0;
    killer = null; frames = null; kWeapon = null;
    endFirstPerson();
    document.body.classList.remove('killcam', 'killcam-replay');
    $('killcam')?.classList.remove('on', 'replay', 'cut');
  }

  /** Cut short: back to the death screen with a brief wait. */
  function skip() {
    if (phase === 'off' || t < SKIP_AFTER) return false;
    reset();
    return true;
  }

  function hideLiveBots() {
    hid = bots.filter((b) => b.mesh).map((b) => ({ o: b.mesh, v: b.mesh.visible }));
    for (const m of hid) m.o.visible = false;
  }

  /* ----------------------------- replay drawing ----------------------------- */

  function frameAt(time) {
    // The two recorded frames around `time`, and how far between them.
    let i = 0;
    while (i < frames.length - 2 && frames[i + 1].t <= time) i++;
    const a = frames[i], b = frames[Math.min(i + 1, frames.length - 1)];
    const k = b.t > a.t ? clamp((time - a.t) / (b.t - a.t), 0, 1) : 0;
    return { a, b, k };
  }

  function poseKiller(time) {
    const { a, b, k } = frameAt(time);
    const g = ghostK;
    g.position.set(lerp(a.px, b.px, k), lerp(a.py, b.py, k), lerp(a.pz, b.pz, k));
    let dy = b.ry - a.ry;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    g.rotation.set(0, a.ry + dy * k, 0);
    const skin = g.userData.skin;
    if (skin) {
      const bones = skin.skeleton.bones;
      for (let i = 0, o = 0; i < bones.length && o + 6 < a.bones.length; i++, o += 7) {
        const bn = bones[i];
        bn.position.set(lerp(a.bones[o], b.bones[o], k), lerp(a.bones[o + 1], b.bones[o + 1], k), lerp(a.bones[o + 2], b.bones[o + 2], k));
        bn.quaternion.set(a.bones[o + 3], a.bones[o + 4], a.bones[o + 5], a.bones[o + 6])
          .slerp(_q.set(b.bones[o + 3], b.bones[o + 4], b.bones[o + 5], b.bones[o + 6]), k);
      }
    }
    if (g.userData.gunIndex >= 0) {
      const gun = g.children[g.userData.gunIndex];
      if (gun && a.hasGun) {
        // Between the two samples, so the view the gun drives does not step at the recording rate.
        _gm1.fromArray(a.gun).decompose(_gp1, _gq1, _gs);
        _gm2.fromArray(b.hasGun ? b.gun : a.gun).decompose(_gp2, _gq2, _gs2);
        gun.matrixAutoUpdate = false;
        gun.matrix.compose(_gp1.lerp(_gp2, k), _gq1.slerp(_gq2, k), _gs);
        gun.matrixWorldNeedsUpdate = true;
      }
    }
    g.visible = true;
    g.updateMatrixWorld(true);
    // The replay is the killer's own view: no one sees their body, only the gun in their hands.
    if (fp) g.visible = false;
    const span = b.t - a.t;
    const speed = span > 0 ? Math.hypot(b.px - a.px, b.pz - a.pz) / span : 0;
    return { a, aim: lerp(a.aim, b.aim, k), speed };
  }

  function meAt(time) {
    let i = 0;
    while (i < me.length - 2 && me[i + 1].t <= time) i++;
    const a = me[i], b = me[Math.min(i + 1, me.length - 1)];
    const k = b.t > a.t ? clamp((time - a.t) / (b.t - a.t), 0, 1) : 0;
    return { a, b, k };
  }

  function poseMe(time, dt) {
    if (!ghostMe || !me.length) return null;
    const { a, b, k } = meAt(time);
    const x = lerp(a.x, b.x, k), y = lerp(a.y, b.y, k), z = lerp(a.z, b.z, k);
    ghostMe.position.set(x, y - CONFIG.PLAYER_RADIUS + AVATAR_FOOT, z);
    ghostMe.rotation.y = a.yaw;
    const clips = ghostMe.userData.clips ?? {};
    const speed = Math.hypot(lerp(a.vx, b.vx, k), lerp(a.vz, b.vz, k));
    const dead = time >= endT;
    for (const [n, c] of Object.entries(clips)) {
      const want = dead ? n === 'Death'
        : a.crouch ? n === 'Crouch'
          : speed > 3.6 ? n === 'Run' : speed > 0.7 ? n === 'Walk' : n === 'Idle';
      c.weight = want ? 1 : 0;
      if (n === 'Death' && want && !meAction) {
        meAction = c; c.reset(); c.setLoop(THREE.LoopOnce, 1); c.clampWhenFinished = true; c.play();
      }
    }
    ghostMe.userData.mixer.update(dt);
    ghostMe.visible = true;
    return { x, y, z };
  }

  const tracerGeo = new THREE.BoxGeometry(0.02, 0.02, 1);
  const tracerMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });

  function fireVisual(s, mePos) {
    const o = s.o;
    if (fpOn) {
      const w = WEAPON_BY_ID[s.w] ?? kWeapon;
      vmKick += w?.kick ?? 0.05;
      const model = fp.vmModels[w?.id ?? kWeapon?.id];
      if (model && !fpScoped) {
        fp.vmRig.updateMatrixWorld(true);
        const mz = model.userData.muzzle.getWorldPosition(_c);
        fp.triggerMuzzleFlash(mz.clone(), o);
      } else if (fpScoped) {
        fp.triggerMuzzleFlash(_c.set(0, -9, 0), o);     // only the room lights up through a scope
      }
    } else {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      sp.position.copy(o); sp.scale.setScalar(0.28);
      scene.add(sp);
      flashes.push({ sprite: sp, life: 0.06 });
    }
    let len = 30;
    if (mePos) {
      _a.set(mePos.x, mePos.y + 0.2, mePos.z).sub(o);
      const along = _a.dot(s.d);
      _b.copy(o).addScaledVector(s.d, along).sub(_c.set(mePos.x, mePos.y + 0.2, mePos.z));
      if (along > 0 && _b.length() < 1.6) len = along;
    }
    const m = new THREE.Mesh(tracerGeo, tracerMat);
    m.scale.z = len;
    m.position.copy(o).addScaledVector(s.d, len / 2);
    m.lookAt(_a.copy(o).addScaledVector(s.d, len));
    scene.add(m);
    tracers.push({ mesh: m, life: 0.07 });
    Audio.gunshot?.(WEAPON_BY_ID[s.w]?.sound, o);
  }

  let playedShots = 0, playedHits = 0, replayShots = [], replayHits = [];

  function startReplay() {
    phase = 'replay'; t = 0;
    document.body.classList.add('killcam-replay');
    hideLiveBots();
    replayShots = shots.filter((s) => s.bot === killer && s.t >= startT && s.t <= endT + 0.05);
    replayHits = hits.filter((h) => h.bot === killer && h.t >= startT && h.t <= endT + 0.05);
    playedShots = 0; playedHits = 0;
    $('killcam')?.classList.add('replay');
    const who = $('kc-who'); if (who) who.textContent = 'KILL CAM';
    Audio.rewind?.();
  }

  /* ----------------------- what the killer saw on screen ----------------------- */

  let fpOn = false, fpScoped = false, vmKick = 0;
  const _vmHip = new THREE.Vector3(), _vmAim = new THREE.Vector3(), _vmPos = new THREE.Vector3();

  /** Their gun in their hands, their sights or scope, their crosshair: set once a frame. */
  function firstPerson(time, dt, ks) {
    const w = kWeapon;
    const model = w && fp.vmModels[w.id];
    if (!model) { endFirstPerson(); return; }
    fpOn = true;
    for (const id in fp.vmModels) fp.vmModels[id].visible = id === w.id;
    const aim = clamp(ks.aim, 0, 1);
    fpScoped = !!w.zoom && aim > 0.85;
    const ads = w.zoom ? 0 : aim;                       // a scope replaces the model; other sights raise it
    _vmHip.copy(fp.homePositions[w.id] ?? fp.homePositions.ar);
    fp.adsPosition(w.id, _vmAim);
    _vmPos.lerpVectors(_vmHip, _vmAim, ads);
    const hip = 1 - ads;
    const bob = Math.min(ks.speed / CONFIG.WALK_SPEED, 1.6) * (0.15 + 0.85 * hip);
    const tt = time * 1;
    _vmPos.x += Math.sin(tt * 7) * 0.008 * bob;
    _vmPos.y += Math.abs(Math.cos(tt * 7)) * 0.007 * bob;
    vmKick *= Math.pow(0.0005, dt);
    _vmPos.z += vmKick * 0.6;
    fp.vmRig.position.copy(_vmPos);
    fp.vmRig.rotation.set(-0.02 * hip - vmKick * 1.1, 0.07 * hip, 0.03 * hip);
    fp.vmRig.visible = !fpScoped;
    fp.updateMuzzleFlash(dt);
    $('scope')?.classList.toggle('on', fpScoped);
    $('crosshair')?.classList.toggle('off', fpScoped);
    camera.fov = fpScoped ? w.zoomFov : lerp(fp.hipFov(), w.zoom ? w.zoomFov : fp.adsFov(), aim);
    camera.updateProjectionMatrix();
  }

  function endFirstPerson() {
    if (!fp || !fpOn) return;
    fpOn = fpScoped = false; vmKick = 0;
    fp.vmRig.visible = false;
    fp.updateMuzzleFlash(1);
    $('scope')?.classList.remove('on');
    $('crosshair')?.classList.add('off');
  }

  /* ------------------------------- the timeline ------------------------------- */

  const _look = new THREE.Quaternion(), _tmp = new THREE.Matrix4(), _up = new THREE.Vector3(0, 1, 0);
  let fovFrom = 78;

  /**
   * Once a frame, AFTER the normal camera has been placed. `dt` is real time. Returns what the
   * main loop should do with the world: its speed, and whether to freeze it.
   */
  function update(dt) {
    if (phase === 'off') return { scale: 1, frozen: false };
    t += dt;
    const prog = $('kc-progress');

    if (phase === 'zoom') {
      if (t === dt) fovFrom = camera.fov;
      const u = clamp(t / ZOOM_TIME, 0, 1);
      const e = u * u * (3 - 2 * u);
      // Swing the view onto the killer's head, then close in on them.
      _a.set(killer.pos.x, killer.eye ? killer.eye.y : killer.pos.y + 0.6, killer.pos.z);
      _tmp.lookAt(camera.position, _a, _up);
      _look.setFromRotationMatrix(_tmp);
      camera.quaternion.slerp(_look, clamp(e * 1.15, 0, 1));
      camera.fov = lerp(fovFrom, 24, e);
      camera.updateProjectionMatrix();
      if (prog) prog.style.width = '0%';
      if (t >= ZOOM_TIME) {
        if (frames) { phase = 'cut'; t = 0; Audio.rewind?.(); $('killcam')?.classList.add('cut'); }
        else { reset(); }
      }
      return { scale: ZOOM_SCALE, frozen: false };
    }

    if (phase === 'cut') {
      camera.fov = lerp(24, 34, clamp(t / CUT_TIME, 0, 1));
      camera.updateProjectionMatrix();
      if (t >= CUT_TIME) { $('killcam')?.classList.remove('cut'); startReplay(); }
      return { scale: ZOOM_SCALE, frozen: false };
    }

    // replay
    const total = endT - startT;
    const time = startT + Math.min(t, total);
    const ks = poseKiller(time);
    const mp = poseMe(time, dt);
    if (fp) firstPerson(time, dt, ks);
    while (playedShots < replayShots.length && replayShots[playedShots].t <= time) { fireVisual(replayShots[playedShots], mp); playedShots++; }

    // Through the killer's eyes: from their head, looking where they look. Shouldered, that is down
    // the gun's own line (their sights are a hand's breadth in front of the eye); carried low, it is
    // straight ahead of the body.
    const kg = ghostK;
    if (kg.userData.head) _a.setFromMatrixPosition(kg.userData.head.matrixWorld);
    else _a.set(kg.position.x, kg.position.y + 1.6, kg.position.z);
    const yaw = kg.rotation.y - Math.PI;
    _b.set(Math.sin(yaw), 0, Math.cos(yaw));                           // where the body faces
    const gun = kg.userData.gunIndex >= 0 ? kg.children[kg.userData.gunIndex] : null;
    if (gun) {
      _c.set(0, 0, -1).transformDirection(gun.matrixWorld);            // where the gun points
      _b.lerp(_c, clamp(ks.aim * 1.25, 0, 1)).normalize();
    }
    camera.position.copy(_a).addScaledVector(_b, 0.05);
    _tmp.lookAt(camera.position, _c.copy(camera.position).add(_b), _up);
    camera.quaternion.setFromRotationMatrix(_tmp);
    if (!fpOn) camera.fov = lerp(80, 64, ks.aim);       // first person sets its own: the scope's, or the sights'
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);                      // the numbers below are projected through it
    while (playedHits < replayHits.length && replayHits[playedHits].t <= time) {
      const h = replayHits[playedHits++];
      spawnBlood(h.p);
      if (fpOn && h.dmg > 0) {
        // The numbers and marker the killer saw as it landed, whatever this player's own setting says.
        fp.showDamageNumber(h.p, h.dmg, !!h.head, h.zone ?? 'body', !!h.armored, !!h.lethal, true);
        fp.showHitMarker(h.lethal ? 'kill' : h.head ? 'head' : 'body', !!h.head);
      }
    }

    for (const x of tracers) { x.life -= dt; if (x.life <= 0) { scene.remove(x.mesh); } }
    for (let i = tracers.length - 1; i >= 0; i--) if (tracers[i].life <= 0) tracers.splice(i, 1);
    for (const x of flashes) { x.life -= dt; x.sprite.material.opacity = clamp(x.life / 0.06, 0, 1); if (x.life <= 0) { scene.remove(x.sprite); x.sprite.material.dispose(); } }
    for (let i = flashes.length - 1; i >= 0; i--) if (flashes[i].life <= 0) flashes.splice(i, 1);

    if (prog) prog.style.width = `${Math.round(clamp(t / (total + HOLD_TIME), 0, 1) * 100)}%`;
    if (t >= total + HOLD_TIME) { document.body.classList.remove('killcam-replay'); reset(); }
    return { scale: 1, frozen: true };
  }

  return {
    record, noteShot, noteHit, begin, update, reset, skip,
    get active() { return phase !== 'off'; },
    get phase() { return phase; },
  };
}
