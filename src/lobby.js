import * as THREE from 'three';

import { clamp } from './utils.js';

/**
 * The lobby as a scene: the chosen map drifts past behind the menu, and your operator stands on a
 * lit pad in front of it, idling and now and then breaking into an emote. The operator is also
 * the body you see when you emote in a match. Presentation only: nothing here touches the sim.
 */

/** Roster order for the picker. The stock 'soldier' is fallback-only and never offered. */
const OPERATORS = [
  { id: 'swat', name: 'SWAT', role: 'POLICE TACTICAL' },
  { id: 'trooper', name: 'TROOPER', role: 'POLICE TACTICAL' },
  { id: 'gasmask', name: 'GAS MASK', role: 'POLICE TACTICAL' },
  { id: 'crypto', name: 'CRYPTO', role: 'MERCENARY' },
  { id: 'ely', name: 'ELY', role: 'MILITARY' },
  { id: 'steve', name: 'STEVE', role: 'MILITARY' },
];
const KEY = 'overrun.operator';

export function loadOperator() {
  try { const v = localStorage.getItem(KEY); if (OPERATORS.some((o) => o.id === v)) return v; } catch { /* default */ }
  return 'swat';
}
function saveOperator(id) { try { localStorage.setItem(KEY, id); } catch { /* not persisted */ } }

const HERO_SCALE = 1.2;                    // BOT_MESH_SCALE: drawn exactly as a bot is
const HERO_FOOT = 0.78;                    // soles below the mesh origin at that scale
const ORBIT_RADIUS = 56, ORBIT_HEIGHT = 13, ORBIT_SPEED = 0.035;   // rad/s: a full lap in ~3 minutes
const LOBBY_FOV = 52;
const LOBBY_EMOTES = ['wave', 'victory', 'hiphop', 'macarena', 'robot', 'ymca'];

export function createLobby({ scene, camera, buildCharacterMesh, loadedCharacters, emotes, getElement: $ }) {
  let angle = Math.atan2(-40, 40);         // starts where the old fixed camera sat
  let shown = false;
  let hero = null, heroId = null;
  let idleW = 1, emoteAct = null, nextEmote = 4;

  /* ---- the pad: a dark disc with an amber ring, so the operator stands on something ---- */
  const pad = new THREE.Group();
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(1.05, 1.1, 0.06, 48),
    new THREE.MeshStandardMaterial({ color: 0x15191f, roughness: 0.55, metalness: 0.6 }),
  );
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.02, 0.025, 12, 64),
    new THREE.MeshBasicMaterial({ color: 0xf3b53f }),
  );
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.035;
  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(1.9, 48),
    new THREE.MeshBasicMaterial({ color: 0xf3b53f, transparent: true, opacity: 0.13, depthWrite: false }),
  );
  glow.rotation.x = -Math.PI / 2; glow.position.y = -0.02;
  pad.add(disc, ring, glow);
  pad.visible = false;
  scene.add(pad);

  const ids = () => OPERATORS.filter((o) => loadedCharacters().includes(o.id));

  function build(id) {
    if (hero) { scene.remove(hero); hero = null; emoteAct = null; }
    const g = buildCharacterMesh(id);
    if (!g) return;
    g.scale.setScalar(HERO_SCALE);
    g.visible = shown;
    scene.add(g);
    hero = g; heroId = id; idleW = 1; nextEmote = 3 + Math.random() * 3;
    syncLabel();
  }

  function syncLabel() {
    const o = OPERATORS.find((x) => x.id === heroId);
    const n = $('op-name'), r = $('op-role');
    if (n) n.textContent = o?.name ?? '';
    if (r) r.textContent = o?.role ?? '';
  }

  function cycle(step) {
    const list = ids();
    if (list.length < 2) return;
    const i = list.findIndex((o) => o.id === heroId);
    const next = list[(i + step + list.length) % list.length];
    saveOperator(next.id);
    build(next.id);
  }
  $('op-prev')?.addEventListener('click', () => cycle(-1));
  $('op-next')?.addEventListener('click', () => cycle(1));

  /** Begin the lobby: pick the saved operator (or the first one that loaded) and warm the dances. */
  function init() {
    const list = ids();
    if (!list.length) return;
    const want = loadOperator();
    build(list.some((o) => o.id === want) ? want : list[0].id);
    const bar = $('operator');
    if (bar && list.length > 1) bar.classList.add('on');
    // The dance clips are big; fetch them once the lobby is up rather than at boot.
    setTimeout(() => emotes.load(), 1500);
  }

  function setShown(on) {
    shown = on;
    pad.visible = on && !!hero;
    if (hero) hero.visible = on;
    $('operator')?.classList.toggle('shown', on);
  }

  const _f = new THREE.Vector3(), _r = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

  /** Once a frame while the lobby is up. */
  function update(dt) {
    angle += dt * ORBIT_SPEED;
    camera.position.set(Math.sin(angle) * ORBIT_RADIUS, ORBIT_HEIGHT, Math.cos(angle) * ORBIT_RADIUS);
    camera.lookAt(0, 3, 0);
    if (camera.fov !== LOBBY_FOV) { camera.fov = LOBBY_FOV; camera.updateProjectionMatrix(); }
    if (!hero) return;
    // On the right of the frame, clear of the menu column, a few metres in front of the lens.
    const wide = innerWidth / innerHeight;
    camera.getWorldDirection(_f);
    _r.crossVectors(_f, _up).normalize();
    const side = clamp(0.42 * wide, 0.5, 1.15);
    const base = camera.position.clone().addScaledVector(_f, 4.6).addScaledVector(_r, 4.6 * side * Math.tan(camera.fov * Math.PI / 360) * 1.0)
      .addScaledVector(_up, -1.75);
    pad.position.copy(base);
    hero.position.set(base.x, base.y + HERO_FOOT + 0.03, base.z);
    // Faces the lens, turned a little toward the menu so the shoulder leads.
    hero.rotation.y = Math.atan2(-(camera.position.x - base.x), -(camera.position.z - base.z)) + 0.4;
    ring.material.opacity = 1;

    // Idle between dances; a dance fades the idle out and back in around itself.
    const clips = hero.userData.clips;
    if (emoteAct && !emoteAct.isRunning()) { emotes.stopOn(hero, emoteAct); emoteAct = null; nextEmote = 6 + Math.random() * 6; }
    if (!emoteAct) {
      nextEmote -= dt;
      if (nextEmote <= 0) {
        const id = LOBBY_EMOTES[Math.floor(Math.random() * LOBBY_EMOTES.length)];
        const a = emotes.playOn(hero, id);
        if (a) {
          a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = false; a.fadeIn(0.35);
          emoteAct = a;
        } else nextEmote = 2;                      // clips still loading
      }
    }
    const want = emoteAct ? 0 : 1;
    idleW += (want - idleW) * Math.min(1, dt * 6);
    if (clips?.Idle) clips.Idle.weight = idleW;
    for (const [name, a] of Object.entries(clips ?? {})) if (name !== 'Idle') a.weight = 0;
    hero.userData.mixer.update(dt);
  }

  return { init, update, setShown, cycle, get operatorId() { return heroId; } };
}
