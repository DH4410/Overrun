import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/**
 * The lobby's 3D part: your operator, standing on a lit pad. Presentation only, nothing here
 * touches the sim.
 *
 * It is its own tiny scene with its own camera. The map behind the menu is NOT drawn every frame:
 * src/lobbyBackdrop.js captures it once, blurred, into a still image. That is what keeps the lobby
 * light on a battery (a pad and one character, not a whole map and its shadows) and it is why the
 * operator can be lit properly without touching the map's lights.
 *
 * The operator only changes on the OPERATORS page. The Play view just shows who you are; it has
 * no arrows, no dances and no way to swap.
 */

import { OPERATORS, isUnlocked } from './rewards.js';

const HERO_SCALE = 1.2;                    // BOT_MESH_SCALE: drawn exactly as a bot is
const PAD_R = 0.95, PAD_H = 0.07;          // the pad: its top is at y = PAD_H

/** Where the operator sits in the frame. `x`/`y` are fractions of the screen width/height; `zoom` scales the whole picture. */
const VIEW = {
  play: { x: 0, y: 0.04, zoom: 1 },
  ops: { x: -0.255, y: -0.085, zoom: 0.8 },
};

/** A soft round glow, drawn once: the light the pad throws on the floor around it. */
function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255, 200, 110, 0.55)');
  grad.addColorStop(0.5, 'rgba(255, 190, 90, 0.16)');
  grad.addColorStop(1, 'rgba(255, 190, 90, 0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createLobby({
  renderer, buildCharacterMesh, isCharacterLoaded, loadCharacter,
  // What the player owns and wears (src/profile.js), and how to wear another operator.
  getProfile = () => ({ xp: 0, equipped: { operator: 'swat' } }), onEquip = () => {},
}) {
  const scene = new THREE.Scene();         // transparent: the blurred map is a page element behind the canvas
  const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.1, 40);
  camera.position.set(0, 2.55, 6.1);
  camera.lookAt(0, 0.95, 0);

  let shown = false;
  let hero = null, heroId = null, wanted = null;
  let view = 'play';
  const cur = { ...VIEW.play };            // eased towards VIEW[view]
  let viewDirty = true;

  /* ---- light: bright and even, so legs and dark uniforms read ---- */
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.9;
  const hemi = new THREE.HemisphereLight(0xdfeaff, 0x626c7b, 1.25);
  const key = new THREE.DirectionalLight(0xfff0dc, 2.8);
  key.position.set(-2.6, 4.6, 3.8);
  key.target.position.set(0, 0.9, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(512, 512);
  Object.assign(key.shadow.camera, { left: -2.2, right: 2.2, top: 2.6, bottom: -1.4, near: 1, far: 12 });
  key.shadow.bias = -0.0006; key.shadow.radius = 4;
  const fill = new THREE.DirectionalLight(0xb4ccff, 1.1);
  fill.position.set(3.4, 1.8, 2.6);
  const rim = new THREE.DirectionalLight(0xffc88c, 2.0);
  rim.position.set(1.6, 3.0, -3.6);
  scene.add(hemi, key, key.target, fill, rim);

  /* ---- the pad: a light steel disc with an amber ring, so the operator stands on something ---- */
  const pad = new THREE.Group();
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(PAD_R, PAD_R + 0.06, PAD_H, 56),
    new THREE.MeshStandardMaterial({ color: 0x7b8798, roughness: 0.46, metalness: 0.3 }),
  );
  disc.position.y = PAD_H / 2;
  disc.receiveShadow = true;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(PAD_R - 0.03, 0.026, 12, 72), new THREE.MeshBasicMaterial({ color: 0xf3b53f }));
  ring.rotation.x = Math.PI / 2; ring.position.y = PAD_H + 0.002;
  const inner = new THREE.Mesh(new THREE.TorusGeometry(PAD_R * 0.62, 0.008, 8, 64), new THREE.MeshBasicMaterial({ color: 0xf3b53f, transparent: true, opacity: 0.4 }));
  inner.rotation.x = Math.PI / 2; inner.position.y = PAD_H + 0.002;
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(4.2, 4.2),
    new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  glow.rotation.x = -Math.PI / 2; glow.position.y = 0.004;
  pad.add(glow, disc, ring, inner);
  scene.add(pad);

  const owned = (id) => isUnlocked(getProfile(), 'operator', id);
  const wornId = () => { const e = getProfile().equipped?.operator; return owned(e) ? e : 'swat'; };

  /** Light, a little satin, no black metal: a character with no environment to reflect goes near-black. */
  function brighten(g) {
    g.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      const fix = (m) => {
        const c = m.clone();
        if ('metalness' in c) c.metalness = Math.min(c.metalness, 0.18);
        if ('roughness' in c) c.roughness = Math.max(c.roughness, 0.62);
        c.envMapIntensity = 1;
        return c;
      };
      o.material = Array.isArray(o.material) ? o.material.map(fix) : fix(o.material);
    });
  }

  function build(id) {
    if (hero) { scene.remove(hero); hero = null; }
    const g = buildCharacterMesh(id);
    if (!g) return;
    brighten(g);
    g.scale.setScalar(HERO_SCALE);
    g.updateMatrixWorld(true);
    // Stand on the pad by measuring the actual soles, so every character is on it and in the middle of it.
    const box = new THREE.Box3().setFromObject(g);
    g.position.set(-(box.min.x + box.max.x) / 2, PAD_H - box.min.y, -(box.min.z + box.max.z) / 2);
    g.rotation.y = 0.28;                   // a little turned so the shoulder leads
    g.visible = shown;
    scene.add(g);
    hero = g; heroId = id;
    document.dispatchEvent(new CustomEvent('overrun:operator', { detail: { id } }));
  }

  /** Show `id` on the pad (fetching it first if it is a character that loads on demand). Does not wear it. */
  async function preview(id) {
    wanted = id;
    if (!OPERATORS.some((o) => o.id === id)) return;
    if (!isCharacterLoaded(id)) await loadCharacter(id);
    if (wanted === id && isCharacterLoaded(id) && id !== heroId) build(id);
  }

  /** Wear what is on the pad, if it is earned. */
  function equipShown() { if (heroId && owned(heroId)) onEquip(heroId); }

  function init() { preview(wornId()); }

  function setShown(on) {
    if (on === shown) return;
    shown = on;
    document.body.classList.toggle('lobby-on', on);
    if (on) refresh();                       // a match may have unlocked something
    if (hero) hero.visible = on;
  }

  function applyView() {
    const w = innerWidth, h = innerHeight;
    camera.zoom = cur.zoom;
    camera.aspect = w / h;
    camera.setViewOffset(w, h, -cur.x * w, -cur.y * h, w, h);
    camera.updateProjectionMatrix();
  }

  /** Once a frame while the lobby is up. */
  function update(dt) {
    const to = VIEW[view];
    const k = Math.min(1, dt * 7);
    const moved = Math.abs(to.x - cur.x) + Math.abs(to.y - cur.y) + Math.abs(to.zoom - cur.zoom);
    if (moved > 0.0005) {
      cur.x += (to.x - cur.x) * k; cur.y += (to.y - cur.y) * k; cur.zoom += (to.zoom - cur.zoom) * k;
      viewDirty = true;
    } else if (moved > 0) {
      Object.assign(cur, to); viewDirty = true;
    }
    if (viewDirty) { applyView(); viewDirty = false; }
    if (!hero) return;
    const clips = hero.userData.clips;
    if (clips) for (const [name, a] of Object.entries(clips)) a.weight = name === 'Idle' ? 1 : 0;
    hero.userData.mixer?.update(dt);
  }

  const _size = new THREE.Vector2();
  /** Draw the pad and the operator over a cleared, transparent canvas. */
  function render() {
    renderer.setScissorTest(false);
    const size = renderer.getSize(_size);
    renderer.setViewport(0, 0, size.x, size.y);
    renderer.clear(true, true, true);
    renderer.shadowMap.needsUpdate = true;   // one character: refreshing the shadow every frame is cheap
    renderer.render(scene, camera);
  }

  /** The career changed (signed in, levelled up): show the operator you now wear. */
  function refresh() {
    if (document.body.classList.contains('ops-up')) return;   // browsing the pass: leave the pad alone
    preview(wornId());
  }

  /** PLAY shows who you are; OPERATORS slides the operator aside to make room for the pass. */
  function setView(next) {
    view = next === 'ops' ? 'ops' : 'play';
    document.body.classList.toggle('ops-up', view === 'ops');
    if (view === 'play') preview(wornId());   // leaving the page puts back what you actually wear
  }

  addEventListener('resize', () => { viewDirty = true; });

  return { scene, camera, init, update, render, setShown, preview, equipShown, refresh, setView, get operatorId() { return heroId; } };
}
