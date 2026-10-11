import { settings } from './settings.js';

/**
 * A hit enemy blinks solid white for a fraction of a second, so a landed shot reads on the model
 * itself and not only in the hit marker. It is the emissive channel: no extra draw, no shader
 * change, and the colour it overwrites is put back exactly.
 *
 * Soldiers own their materials (bots.js clones them per bot), so writing emissive here touches
 * only the one that was hit.
 */
const FLASH_TIME = 0.09;
const flashing = new Map();   // root -> { t, saved: [{ m, r, g, b, i }] }

export function flashHit(root) {
  if (!root || !settings.fxHitFlash) return;
  const f = flashing.get(root);
  if (f) { f.t = 0; return; }
  const saved = [];
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m.emissive || saved.some((s) => s.m === m)) continue;
      saved.push({ m, r: m.emissive.r, g: m.emissive.g, b: m.emissive.b, i: m.emissiveIntensity });
      m.emissive.setRGB(1, 1, 1);
      m.emissiveIntensity = 1.4;
    }
  });
  if (saved.length) flashing.set(root, { t: 0, saved });
}

export function updateHitFlash(dt) {
  if (!flashing.size) return;
  for (const [root, f] of flashing) {
    f.t += dt;
    if (f.t < FLASH_TIME) continue;
    for (const s of f.saved) { s.m.emissive.setRGB(s.r, s.g, s.b); s.m.emissiveIntensity = s.i; }
    flashing.delete(root);
  }
}
