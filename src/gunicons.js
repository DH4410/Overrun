import * as THREE from 'three';

import { applyGunSkin, buildGunModel } from './gunmodels.js';
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

function render(key, style) {
  if (iconCache.has(key)) return iconCache.get(key);
  const icons = {};
  iconCache.set(key, icons);
  let r;
  try {
    r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch {
    return icons;
  }
  const W = 320, H = 140;
  r.setPixelRatio(1);
  r.setSize(W, H, false);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3f48, style.flat ? 2.9 : 2.4));
  const light = new THREE.DirectionalLight(0xffffff, style.flat ? 1.6 : 2.6);
  light.position.set(2, 3, 1.5);
  scene.add(light);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 20);
  const box = new THREE.Box3(), size = new THREE.Vector3(), centre = new THREE.Vector3();
  const flatMat = style.flat ? new THREE.MeshStandardMaterial(FLAT) : null;
  for (const { id } of WEAPONS) {
    const m = buildGunModel(id);
    if (flatMat) m.traverse((o) => { if (o.isMesh) o.material = flatMat; });
    else applyGunSkin(m, skinInfo(style.skin));
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
    icons[id] = r.domElement.toDataURL('image/png');
    scene.remove(m);
    m.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
  }
  r.dispose();
  r.forceContextLoss?.();
  return icons;
}

export const gunIcons = (skinId = 'stock') => render(`skin:${skinId}`, { skin: skinId });
export const hudIcons = () => render('hud', { flat: true });
