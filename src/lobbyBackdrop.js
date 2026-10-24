import * as THREE from 'three';

/**
 * The picture behind the lobby: the picked map, drawn ONCE from a high corner, shrunk, and shown
 * blurred by CSS. The map is not rendered again until the picked map or the window changes, so the
 * lobby costs a pad and a character per frame instead of a whole map, its lights and its shadows.
 * It is also the "fully blurred" background: nothing in it moves, nothing in it competes with the menu.
 *
 * The map can finish arriving a moment after the switch (textures), so a capture is taken shortly
 * after the change and once more a little later.
 */

const WIDTH = 480;                         // the still's width in pixels: it is blurred, so small is right
const FIRST = 6, SECOND = 45;              // frames after a change: the first capture, and the one that picks up late textures
const FOV = 52;

export function createLobbyBackdrop({ renderer, scene, canvas }) {
  const ctx = canvas.getContext('2d');
  const cam = new THREE.PerspectiveCamera(FOV, 1, 0.1, 500);
  const size = new THREE.Vector2();
  let orbitR = 52, orbitH = 21;
  let frames = -1;                         // -1: nothing pending

  /** Something changed (a new map, the window): take a fresh picture soon. */
  function invalidate() { frames = 0; }

  /** The picked map's half-extent in metres: stand far enough back to see over its walls. */
  function setExtent(extent) {
    orbitR = Math.min(90, Math.max(38, extent * 1.05));
    orbitH = orbitR * 0.4;
    invalidate();
  }

  function capture() {
    const w = innerWidth, h = innerHeight;
    canvas.width = WIDTH;
    canvas.height = Math.max(1, Math.round(WIDTH * h / w));
    const angle = Math.atan2(-40, 40);
    cam.aspect = w / h;
    cam.position.set(Math.sin(angle) * orbitR, orbitH, Math.cos(angle) * orbitR);
    cam.lookAt(0, 1, 0);
    cam.updateProjectionMatrix();
    renderer.setScissorTest(false);
    renderer.getSize(size);
    renderer.setViewport(0, 0, size.x, size.y);
    renderer.clear(true, true, true);
    renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, cam);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // Same task as the render: the drawing buffer is not preserved past it.
    ctx.drawImage(renderer.domElement, 0, 0, canvas.width, canvas.height);
  }

  /** Once a frame while the lobby is up, before it draws its own scene. */
  function update() {
    if (frames < 0) return;
    frames++;
    if (frames === FIRST || frames === SECOND) capture();
    if (frames >= SECOND) frames = -1;
  }

  addEventListener('resize', invalidate);
  return { update, invalidate, setExtent };
}
