import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/**
 * The supply crate itself: a steel body with pressed side panels (stencilled, scuffed, baked into
 * assets/textures/crate/), corner posts and feet, skid rails, rivet rows, end handles, a vent, light
 * strips, and a lid with ribs, latches and a grab handle. Used by the supply-drop window and, as a
 * still picture, on the store page.
 */

/** One of the crate's baked textures (assets/textures/crate/<name>.jpg). */
function crateTexture(name, onLoad) {
  const t = new THREE.TextureLoader().load(`assets/textures/crate/${name}.jpg`, onLoad);
  t.colorSpace = name.endsWith('bump') ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** `{ crate, lid, seamMat, dispose }`. `onLoad` runs when a texture has arrived (a still may want to redraw). */
export function buildCrate(onLoad) {
  const own = [];
  const track = (o) => { own.push(o); return o; };
  const mat = track;
  const crate = new THREE.Group();
  const hull = mat(new THREE.MeshStandardMaterial({ color: 0x35404f, roughness: 0.5, metalness: 0.65 }));
  const frame = mat(new THREE.MeshStandardMaterial({ color: 0x9aa8bb, roughness: 0.32, metalness: 0.95 }));
  const panelTex = track(crateTexture('panel', onLoad)), bumpTex = track(crateTexture('bump', onLoad));
  const endTex = track(crateTexture('end', onLoad)), endBump = track(crateTexture('endbump', onLoad));
  const decal = (map, bump) => mat(new THREE.MeshStandardMaterial({ map, bumpMap: bump, bumpScale: 2.2, roughness: 0.52, metalness: 0.7 }));
  const decalFace = decal(panelTex, bumpTex), decalEnd = decal(endTex, endBump);
  const body = new THREE.Mesh(track(new RoundedBoxGeometry(1.5, 0.9, 1.05, 4, 0.045)), hull);
  body.position.y = 0.45;
  crate.add(body);
  // Pressed side panels with the stencilling on them
  for (const sz of [1, -1]) {
    const p = new THREE.Mesh(track(new THREE.PlaneGeometry(1.34, 0.67)), decalFace);
    p.position.set(0, 0.46, sz * 0.5275); p.rotation.y = sz > 0 ? 0 : Math.PI;
    crate.add(p);
  }
  for (const sx of [1, -1]) {
    const p = new THREE.Mesh(track(new THREE.PlaneGeometry(0.9, 0.67)), decalEnd);
    p.position.set(sx * 0.7525, 0.46, 0); p.rotation.y = sx > 0 ? Math.PI / 2 : -Math.PI / 2;
    crate.add(p);
  }
  // Corner posts, with a cap and a foot on each
  const capGeo = track(new THREE.BoxGeometry(0.15, 0.06, 0.15));
  for (const sx of [-0.76, 0.76]) for (const sz of [-0.53, 0.53]) {
    const post = new THREE.Mesh(track(new THREE.BoxGeometry(0.1, 0.96, 0.1)), frame);
    post.position.set(sx, 0.48, sz);
    const foot = new THREE.Mesh(capGeo, frame); foot.position.set(sx, 0.03, sz);
    crate.add(post, foot);
  }
  // Skid rails underneath
  for (const sz of [-0.36, 0.36]) {
    const rail = new THREE.Mesh(track(new THREE.BoxGeometry(1.32, 0.05, 0.1)), frame);
    rail.position.set(0, -0.005, sz);
    crate.add(rail);
  }
  // Rivets along the frame of each long face
  const rivetGeo = track(new THREE.SphereGeometry(0.018, 8, 6));
  const rivets = new THREE.InstancedMesh(rivetGeo, frame, 4 * 17);
  const m4 = new THREE.Matrix4();
  let ri = 0;
  for (const sz of [0.54, -0.54]) for (const y of [0.1, 0.84]) for (let i = 0; i < 17; i++) {
    m4.makeTranslation(-0.64 + (i * 1.28) / 16, y, sz);
    rivets.setMatrixAt(ri++, m4);
  }
  crate.add(rivets);
  // Carry handles and a vent grille on the ends
  for (const sx of [1, -1]) {
    const h = new THREE.Mesh(track(new THREE.TorusGeometry(0.15, 0.022, 8, 18, Math.PI)), frame);
    h.position.set(sx * 0.775, 0.5, 0); h.rotation.set(0, sx > 0 ? Math.PI / 2 : -Math.PI / 2, Math.PI / 2);
    crate.add(h);
  }
  const slatGeo = track(new THREE.BoxGeometry(0.02, 0.012, 0.3));
  for (let i = 0; i < 6; i++) {
    const slat = new THREE.Mesh(slatGeo, frame);
    slat.position.set(0.765, 0.2 + i * 0.026, 0);
    crate.add(slat);
  }
  // The seam glows with the crate's rarity once it charges; light strips run with it
  const seamMat = mat(new THREE.MeshBasicMaterial({ color: 0x59657a, toneMapped: false }));
  const seam = new THREE.Mesh(track(new THREE.BoxGeometry(1.46, 0.045, 1.01)), seamMat);
  seam.position.y = 0.915;
  crate.add(seam);
  const stripGeo = track(new THREE.BoxGeometry(1.0, 0.016, 0.012));
  for (const sz of [0.532, -0.532]) {
    const strip = new THREE.Mesh(stripGeo, seamMat);
    strip.position.set(0, 0.075, sz);
    crate.add(strip);
  }
  // The lid: a raised plate, ribs, two latches and a grab handle
  const lid = new THREE.Group();
  const lidTop = new THREE.Mesh(track(new RoundedBoxGeometry(1.58, 0.17, 1.13, 3, 0.04)), frame);
  lidTop.position.y = 1.02;
  const plate = new THREE.Mesh(track(new RoundedBoxGeometry(1.2, 0.03, 0.74, 2, 0.012)), hull);
  plate.position.y = 1.115;
  const ribGeo = track(new THREE.BoxGeometry(0.03, 0.02, 0.9));
  lid.add(lidTop, plate);
  for (const x of [-0.5, 0.5]) { const rib = new THREE.Mesh(ribGeo, frame); rib.position.set(x, 1.115, 0); lid.add(rib); }
  const handle = new THREE.Mesh(track(new THREE.TorusGeometry(0.2, 0.032, 8, 20, Math.PI)), frame);
  handle.position.y = 1.13;
  lid.add(handle);
  const latchGeo = track(new THREE.BoxGeometry(0.14, 0.2, 0.05));
  const pinGeo = track(new THREE.CylinderGeometry(0.02, 0.02, 0.09, 10));
  for (const x of [-0.45, 0.45]) {
    const latch = new THREE.Mesh(latchGeo, hull); latch.position.set(x, 0.9, 0.585);
    const pin = new THREE.Mesh(pinGeo, frame); pin.rotation.x = Math.PI / 2; pin.position.set(x, 0.93, 0.62);
    lid.add(latch, pin);
  }
  crate.add(lid);
  return { crate, lid, seamMat, dispose: () => { while (own.length) own.pop().dispose?.(); } };
}

/**
 * A picture of the crate for the store page, drawn once (so the page costs no WebGL while it is open).
 * It is drawn at once with whatever has loaded, and again, through `onUpdate(url)`, when the panel
 * textures arrive. '' when WebGL is not available.
 */
let still = '';
export function crateStill(onUpdate) {
  if (still) return still;
  let r;
  try { r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); } catch { return ''; }
  const W = 720, H = 540;
  r.setPixelRatio(1);
  r.setSize(W, H, false);
  r.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  const pm = new THREE.PMREMGenerator(r);
  scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.8;
  pm.dispose();
  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x252a36, 1.2));
  const key = new THREE.DirectionalLight(0xfff1dc, 2.4);
  key.position.set(3, 4, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x7fb0ff, 1.4);
  rim.position.set(-4, 2, -3);
  scene.add(rim);
  const cam = new THREE.PerspectiveCamera(32, W / H, 0.1, 30);
  cam.position.set(2.5, 1.65, 3.2);
  cam.lookAt(0, 0.62, 0);
  let built = null;
  const draw = () => {
    r.render(scene, cam);
    return r.domElement.toDataURL('image/png');
  };
  let settled = false;
  built = buildCrate(() => { if (settled) return; still = draw(); onUpdate?.(still); });
  built.crate.rotation.y = -0.5;
  scene.add(built.crate);
  still = draw();
  setTimeout(() => { settled = true; }, 15000);
  return still;
}
