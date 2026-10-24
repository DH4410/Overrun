import * as THREE from 'three';
import { PATTERNS } from './gunskins.js';

/**
 * Surface patterns for gun skins: carbon weave, brushed steel, camouflage, scales, cracked magma and
 * so on. Each is a small tileable JPG in assets/textures/guns/, baked from tools/gunTextureDraw.js
 * by `npm run bake:textures` (or replace a file with any other tileable image, e.g. a CC0 material).
 * A texture is fetched once, the first time a skin shows it, and stays in the service-worker cache.
 *
 * The guns have no hand-painted UV layout (they are built from extruded profiles and boxes), so
 * `patchMaterial` makes the pattern follow each part's own shape by projecting it along whichever
 * axis the surface faces most. That keeps the weave the same size on a long receiver and a short
 * grip, and nothing stretches.
 */

export const textureUrl = (name) => `assets/textures/guns/${name}.jpg`;

const cache = new Map();
let pending = 0;
let waiters = [];

/** Resolves once every pattern asked for so far has loaded (or failed: a skin then keeps its flat colour). */
export function texturesReady() {
  return pending === 0 ? Promise.resolve() : new Promise((r) => waiters.push(r));
}
export const texturesPending = () => pending > 0;

function settle() {
  pending -= 1;
  if (pending === 0) { const w = waiters; waiters = []; for (const r of w) r(); }
}

/** A one-pixel stand-in in the pattern's average colour, so a skin never flashes black while its file loads. */
function stand(name) {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const g = c.getContext('2d');
  g.fillStyle = `#${PATTERNS[name].c.toString(16).padStart(6, '0')}`;
  g.fillRect(0, 0, 1, 1);
  return c;
}

/**
 * A new texture for pattern `name`, for a caller that wants its own repeat or offset (the shared one
 * from `patternTexture` must not be changed). Repeats in both directions.
 */
export function freshPattern(name) {
  if (!PATTERNS[name]) return null;
  const t = new THREE.CanvasTexture(stand(name));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  pending += 1;
  new THREE.TextureLoader().load(textureUrl(name), (real) => {
    t.image = real.image;
    t.needsUpdate = true;
    settle();
  }, undefined, settle);
  return t;
}

/** The shared texture for pattern `name`, loaded on first use. */
export function patternTexture(name) {
  if (!PATTERNS[name]) return null;
  let t = cache.get(name);
  if (!t) { t = freshPattern(name); cache.set(name, t); }
  return t;
}

/**
 * Teach a gun material to draw its `map` projected along the surface's dominant axis in the part's own
 * space, scaled by the `value` of `uniform` (repeats per metre). The geometry's own UVs are not used.
 */
export function patchMaterial(mat, uniform) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTexScale = uniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjP;\nvarying vec3 vObjN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjP = position;\nvObjN = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjP;\nvarying vec3 vObjN;\nuniform float uTexScale;')
      .replace('#include <map_fragment>', `
        #ifdef USE_MAP
          vec3 an = abs(vObjN);
          vec2 puv = (an.x >= an.y && an.x >= an.z) ? vObjP.zy : (an.y >= an.z ? vObjP.xz : vObjP.xy);
          diffuseColor *= texture2D(map, puv * uTexScale);
        #endif`);
  };
  mat.customProgramCacheKey = () => 'gun-pattern';
}
