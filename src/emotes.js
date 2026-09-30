import * as THREE from 'three';

import { CONFIG } from './config.js';

/**
 * Emotes, for the player only: hold B for the wheel, point the mouse at one, let go to dance.
 *
 * The player has no body in first person, so an emote builds one (a roster character, the same
 * rig the bots use), swings the camera out in front of it, and plays a Mixamo clip on it.
 * Moving, jumping, firing, dying or the match ending puts the camera back. Bots never emote.
 *
 * The clips are 8 MB of FBX, so nothing is fetched until the wheel is first opened.
 */
export const EMOTES = [
  { id: 'wave', name: 'Wave' },
  { id: 'hiphop', name: 'Hip Hop' },
  { id: 'robot', name: 'Robot' },
  { id: 'chicken', name: 'Chicken' },
  { id: 'macarena', name: 'Macarena' },
  { id: 'ymca', name: 'YMCA' },
  { id: 'thriller', name: 'Thriller' },
  { id: 'victory', name: 'Victory' },
];

const MIXAMO_PREFIX = /^mixamorig\d*[:_]?/i;
const boneKey = (name) => name.replace(MIXAMO_PREFIX, '').toLowerCase();
const AVATAR_SCALE = 1.2;       // BOT_MESH_SCALE: the avatar is drawn exactly as a bot is
const AVATAR_FOOT = 0.78;       // soles below the mesh origin at that scale
const CAM_DIST = 3.4, CAM_HEIGHT = 1.5, LOOK_HEIGHT = 1.1;

export function createEmotes({ scene, camera, player, blockers, buildCharacterMesh, loadedCharacters, wheel, Audio }) {
  const clips = {};
  let loading = null;
  let avatar = null, action = null, active = null;
  let startYaw = 0, camDist = CAM_DIST;
  let wheelOpen = false, pick = -1, mx = 0, my = 0;

  /* ---------------------------- loading ---------------------------- */

  function load() {
    if (loading) return loading;
    loading = (async () => {
      const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
      const loader = new FBXLoader();
      await Promise.all(EMOTES.map(async (e) => {
        try {
          const group = await loader.loadAsync(`./assets/player/emotes/${e.id}.fbx`);
          const clip = group.animations?.[0];
          if (clip) { clip.name = e.id; pinHips(clip); clips[e.id] = clip; }
        } catch {
          // A missing emote just greys out on the wheel.
        }
      }));
      buildWheel();
    })();
    return loading;
  }

  /** Keep a dance on the spot: the hips start over the origin, whatever the clip was authored at. */
  function pinHips(clip) {
    const t = clip.tracks.find((tr) => /Hips\.position$/.test(tr.name));
    if (!t) return;
    const v = t.values, x0 = v[0], z0 = v[2];
    for (let i = 0; i < v.length; i += 3) { v[i] -= x0; v[i + 2] -= z0; }
  }

  /** Point each track at the bone of the same name in this rig, however the prefix is spelled. */
  function retarget(clip, root) {
    const byKey = new Map();
    root.traverse((o) => { if (o.isBone) byKey.set(boneKey(o.name), o.name); });
    const copy = clip.clone();
    for (const track of copy.tracks) {
      const dot = track.name.lastIndexOf('.');
      const target = byKey.get(boneKey(track.name.slice(0, dot)));
      if (target) track.name = target + track.name.slice(dot);
    }
    return copy;
  }

  function makeAvatar() {
    const ids = loadedCharacters();
    const id = ['swat', 'soldier', ...ids].find((c) => ids.includes(c));
    const g = id ? buildCharacterMesh(id) : null;
    if (!g) return null;
    g.scale.setScalar(AVATAR_SCALE);
    // Its locomotion clips stay bound but silent; the emote takes the whole body.
    for (const a of Object.values(g.userData.clips)) a.weight = 0;
    g.visible = false;
    scene.add(g);
    return g;
  }

  /* ------------------------------ wheel ------------------------------ */

  function buildWheel() {
    wheel.innerHTML = '<div class="ew-hub"><b>EMOTE</b><span id="ew-name"></span></div>' + EMOTES.map((e, i) => {
      const a = (i / EMOTES.length) * Math.PI * 2;
      const x = Math.sin(a) * 38 + 50, y = -Math.cos(a) * 38 + 50;
      return `<div class="ew-slot${clips[e.id] || !loading ? '' : ' off'}" data-i="${i}" style="left:${x}%;top:${y}%">${e.name}</div>`;
    }).join('');
  }

  function highlight() {
    wheel.querySelectorAll('.ew-slot').forEach((s, i) => s.classList.toggle('on', i === pick));
    const name = wheel.querySelector('#ew-name');
    if (name) name.textContent = pick >= 0 ? EMOTES[pick].name : (Object.keys(clips).length ? '' : 'loading…');
  }

  function openWheel() {
    if (wheelOpen || !player.alive) return;
    wheelOpen = true; pick = -1; mx = 0; my = 0;
    if (!wheel.firstChild) buildWheel();
    load().then(highlight);
    wheel.classList.add('on');
    highlight();
  }

  function closeWheel(play) {
    if (!wheelOpen) return;
    wheelOpen = false;
    wheel.classList.remove('on');
    if (play && pick >= 0) start(EMOTES[pick].id);
  }

  // While the wheel is open the mouse picks a slice instead of turning the view. This runs in
  // the capture phase so player.js never sees the movement.
  addEventListener('mousemove', (e) => {
    if (!wheelOpen) return;
    e.stopImmediatePropagation();
    mx += e.movementX; my += e.movementY;
    const len = Math.hypot(mx, my);
    if (len > 60) { mx *= 60 / len; my *= 60 / len; }
    if (len > 24) {
      const a = (Math.atan2(mx, -my) + Math.PI * 2) % (Math.PI * 2);
      const i = Math.round(a / (Math.PI * 2 / EMOTES.length)) % EMOTES.length;
      if (clips[EMOTES[i].id]) pick = i;
    }
    highlight();
  }, true);
  wheel.addEventListener('click', (e) => {
    const s = e.target.closest('.ew-slot');
    if (s) { pick = Number(s.dataset.i); closeWheel(true); }
  });

  /* ----------------------------- playing ----------------------------- */

  function start(id) {
    const clip = clips[id];
    if (!clip || !player.alive) return;
    avatar ??= makeAvatar();
    if (!avatar) return;
    stop();
    const mixer = avatar.userData.mixer;
    action = mixer.clipAction(retarget(clip, avatar));
    action.reset().play();
    active = id;
    startYaw = player.yaw;
    camDist = CAM_DIST;
    avatar.visible = true;
    document.body.classList.add('emoting');
    Audio.playMusic('emote');
  }

  /** End the dance. `resume` puts the match music back; not when the match itself is over. */
  function stop(resume = true) {
    if (!active) return;
    action?.stop();
    avatar.userData.mixer.uncacheAction(action.getClip());
    action = null;
    active = null;
    avatar.visible = false;
    document.body.classList.remove('emoting');
    if (resume) Audio.playMusic('match');
  }

  const _look = new THREE.Vector3(), _want = new THREE.Vector3();

  /** Distance from `o` along unit `d` to the first blocker wall, or `max`. Slab test, 2D. */
  function wallDist(o, d, max) {
    let best = max;
    for (const b of blockers) {
      let t0 = 0, t1 = best;
      for (const [p, v, c, h] of [[o.x, d.x, b.x, b.hx], [o.z, d.z, b.z, b.hz]]) {
        if (Math.abs(v) < 1e-6) { if (Math.abs(p - c) > h) { t0 = Infinity; break; } continue; }
        let a = (c - h - p) / v, e = (c + h - p) / v;
        if (a > e) [a, e] = [e, a];
        t0 = Math.max(t0, a); t1 = Math.min(t1, e);
        if (t0 > t1) break;
      }
      if (t0 <= t1 && t0 < best && t0 > 0) best = t0;
    }
    return best;
  }

  /**
   * Once a frame, after the first-person camera has been placed: cancel on any action, advance
   * the dance, and put the camera out in front of the avatar. The mouse still turns the player,
   * so it orbits the camera around the dancer.
   */
  function update(dt, { running, firing }) {
    if (!active) return;
    const v = player.body.velocity;
    if (!running) { stop(false); return; }
    if (!player.alive || firing || Math.hypot(v.x, v.z) > 1.2 || v.y > 1.5) { stop(); return; }
    const p = player.body.position;
    const feet = p.y - CONFIG.PLAYER_RADIUS;
    avatar.position.set(p.x, feet + AVATAR_FOOT, p.z);
    avatar.rotation.y = startYaw;
    avatar.userData.mixer.update(dt);

    // Out along the player's view direction: in front of the avatar to begin with, since it
    // faces where you were looking, then wherever the mouse has swung it.
    const dx = -Math.sin(player.yaw), dz = -Math.cos(player.yaw);
    _look.set(p.x, feet + LOOK_HEIGHT, p.z);
    const room = wallDist(_look, { x: dx, z: dz }, CAM_DIST) - 0.3;
    camDist += (Math.max(0.8, room) - camDist) * Math.min(1, dt * 10);
    _want.set(p.x + dx * camDist, feet + CAM_HEIGHT, p.z + dz * camDist);
    camera.position.copy(_want);
    camera.lookAt(_look);
  }

  return {
    openWheel, closeWheel, update, stop, load,
    get active() { return active; },
    get wheelOpen() { return wheelOpen; },
  };
}
