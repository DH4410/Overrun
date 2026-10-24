import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { applyGunSkin, buildGunModel } from './gunmodels.js';
import { gunSkinInfo } from './gunskins.js';
import { skinInfo } from './rewards.js';
import { WEAPONS } from './sim/weaponData.js';

/**
 * Side-on portraits of the procedural guns, rendered once into images with a throwaway WebGL
 * context. The same models as the first-person view, so the locker shows the gun you get.
 *
 * Two looks share the renderer: the locker's, in a finish (`gunIcons(skinId)`), and a flat light
 * silhouette for the HUD (`hudIcons()`), which has to read on a dark kill-feed bar at 20 px high.
 */
const iconCache = new Map();
const FLAT = { color: 0xeef2f6, roughness: 0.9, metalness: 0 };

/** One throwaway renderer with the light rig and camera the icons share. */
function rig(style) {
  let r;
  try { r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); } catch { return null; }
  const W = style.flat ? 320 : 480, H = style.flat ? 140 : 210;
  r.setPixelRatio(1);
  r.setSize(W, H, false);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3f48, style.flat ? 2.9 : 1.6));
  if (!style.flat) {
    // Metal shows what is around it: with nothing around it a chrome or steel finish draws black.
    const pm = new THREE.PMREMGenerator(r);
    scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.9;
    pm.dispose();
  }
  const light = new THREE.DirectionalLight(0xffffff, style.flat ? 1.6 : 2.6);
  light.position.set(2, 3, 1.5);
  scene.add(light);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 20);
  const box = new THREE.Box3(), size = new THREE.Vector3(), centre = new THREE.Vector3();
  const flatMat = style.flat ? new THREE.MeshStandardMaterial(FLAT) : null;
  /** Draw gun `id` in `skin` (a finish or a collection skin) and return the picture. */
  function shoot(id, skin) {
    const m = buildGunModel(id);
    if (flatMat) m.traverse((o) => { if (o.isMesh) o.material = flatMat; });
    else applyGunSkin(m, skin);
    m.rotation.y = style.flat ? 0 : -0.32;      // the HUD wants a clean side view; the locker a touch of three-quarter
    m.updateMatrixWorld(true);
    box.setFromObject(m).getSize(size);
    box.getCenter(centre);
    m.position.sub(centre);
    const half = Math.max(size.z, size.x) * 0.56;
    const halfW = Math.max(half, size.y * 0.62 * (W / H));
    cam.left = -halfW; cam.right = halfW;
    cam.top = halfW * (H / W); cam.bottom = -halfW * (H / W);
    cam.position.set(6, 0.4, 0);
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    scene.add(m);
    r.render(scene, cam);
    const url = r.domElement.toDataURL('image/png');
    scene.remove(m);
    m.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    return url;
  }
  const done = () => { r.dispose(); r.forceContextLoss?.(); };
  return { shoot, done };
}

/** A finish by id, from the level finishes or the collection. */
const paintOf = (id) => skinInfo(id) ?? gunSkinInfo(id);

function render(key, style) {
  if (iconCache.has(key)) return iconCache.get(key);
  const icons = {};
  iconCache.set(key, icons);
  const g = rig(style);
  if (!g) return icons;
  for (const { id } of WEAPONS) icons[id] = g.shoot(id, style.skin ? paintOf(style.skin) : null);
  g.done();
  return icons;
}

export const gunIcons = (skinId = 'stock') => render(`skin:${skinId}`, { skin: skinId });
export const hudIcons = () => render('hud', { flat: true });

/**
 * One gun in several skins at once, for the store and the crate: `{ skinId: image }`. Each picture is
 * kept, so reopening the store draws nothing new.
 */
export function skinShots(gunId, skinIds) {
  const out = {};
  const missing = skinIds.filter((s) => !iconCache.has(`${gunId}:${s}`));
  if (missing.length) {
    const g = rig({});
    if (g) {
      for (const s of missing) iconCache.set(`${gunId}:${s}`, g.shoot(gunId, paintOf(s)));
      g.done();
    }
  }
  for (const s of skinIds) out[s] = iconCache.get(`${gunId}:${s}`) ?? '';
  return out;
}
