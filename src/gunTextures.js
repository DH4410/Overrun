import * as THREE from 'three';
import { PATTERNS } from './gunskins.js';
import { saverActive } from './settings.js';

/**
 * Surface patterns for gun skins: carbon weave, brushed steel, camouflage, scales, lava cracks and
 * so on. Every pattern is generated here, procedurally, on a 256 px canvas the first time a skin
 * asks for it: tileable value noise, fBm, Voronoi cells and a few stripe and weave formulas. No
 * image files are fetched, so nothing can fail to load and nothing waits on the network.
 *
 * `patternTexture(name)` is the shared colour map (multiplied into the role's colour). `glowTexture(name)`
 * is a mask of the pattern's bright lines, which lights a skin's emissive colour only where the lines are
 * (a skin's `fx.glowTex`). The two are derived from the same field, so they always line up.
 *
 * The guns have no hand-painted UV layout (they are built from extruded profiles and boxes), so
 * `patchMaterial` makes the pattern follow each part's own shape by projecting it along whichever
 * axis the surface faces most. That keeps the weave the same size on a long receiver and a short
 * grip, and nothing stretches.
 *
 * Animation (`fx.anim`: 'pulse' breathes the glow, 'flow' scrolls the pattern) runs on one shared
 * clock, `FX_TIME`, which `fxTick` sets from the page clock. With the battery saver on it stays at 0,
 * so every animated skin holds one still frame.
 */

const SIZE = 256;
const cache = new Map();
const cacheKey = (name, glow) => `${name}:${glow ? 'g' : 'c'}`;

export const FX_TIME = { value: 0 };
/** Sets the shared animation clock. Call before drawing; idempotent within a frame. */
export function fxTick() {
  FX_TIME.value = saverActive() ? 0 : performance.now() / 1000;
}

/** Procedures are ready the moment they are asked for, so nothing is ever pending. Kept for callers that wait. */
export const texturesReady = () => Promise.resolve();
export const texturesPending = () => false;

/* ------------------------------ noise ------------------------------ */

/** A deterministic 0..1 value for integer lattice point (x, y) and seed s. */
function hash(x, y, s = 0) {
  let h = (Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise on a lattice that wraps every px x py cells, so the tile seams disappear. */
function vnoise(x, y, px, py, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const x0 = ((xi % px) + px) % px, x1 = (x0 + 1) % px;
  const y0 = ((yi % py) + py) % py, y1 = (y0 + 1) % py;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0, s), b = hash(x1, y0, s), c = hash(x0, y1, s), d = hash(x1, y1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal noise over the unit tile: `bx` by `by` base cells, each octave twice as fine. */
function fbm(u, v, bx, by, s, oct = 4) {
  let sum = 0, amp = 0.5, norm = 0, px = bx, py = by;
  for (let o = 0; o < oct; o++) {
    sum += amp * vnoise(u * px, v * py, px, py, s + o * 17);
    norm += amp;
    amp *= 0.5;
    px *= 2;
    py *= 2;
  }
  return sum / norm;
}

/** Voronoi over the unit tile with G x G cells: the distances to the nearest two feature points and a cell id. */
function voronoi(u, v, G, s) {
  const x = u * G, y = v * G;
  const cx = Math.floor(x), cy = Math.floor(y);
  let f1 = 9, f2 = 9, id = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const gx = cx + i, gy = cy + j;
      const wx = ((gx % G) + G) % G, wy = ((gy % G) + G) % G;
      const px = gx + hash(wx, wy, s), py = gy + hash(wx, wy, s + 101);
      const d = Math.hypot(px - x, py - y);
      if (d < f1) { f2 = f1; f1 = d; id = hash(wx, wy, s + 7); } else if (d < f2) f2 = d;
    }
  }
  return [f1, f2, id];
}

const grain = (u, v, s) => hash(Math.floor(u * SIZE), Math.floor(v * SIZE), s);
const TAU = Math.PI * 2;

/* ---------------------------- the fields ---------------------------- */

/**
 * Each field maps a point of the unit tile to 0..1 (its brightness). Per pattern: `amp` is how far
 * the brightness swings around the pattern's average colour in `PATTERNS`.
 */
const FIELD = {
  carbon(u, v) {
    const x = u * 16, y = v * 16;
    const fx = x % 1, fy = y % 1;
    const weave = (Math.floor(x) + Math.floor(y)) & 1
      ? 0.5 + 0.5 * Math.sin(Math.PI * fx)
      : 0.5 + 0.5 * Math.sin(Math.PI * fy);
    return 0.8 * weave + 0.2 * grain(u, v, 5);
  },
  brushed(u, v) {
    const streak = hash(0, Math.floor(v * SIZE), 9);
    return 0.55 * streak + 0.45 * fbm(u, v, 4, 64, 3, 3);
  },
  speckle(u, v) {
    const h = grain(u, v, 21);
    return 0.5 * (h > 0.93 ? 1 : 0.4) + 0.5 * fbm(u, v, 8, 8, 4, 3);
  },
  camo_wood(u, v) {
    const n = fbm(u, v, 3, 3, 11, 4);
    return n < 0.44 ? 0.1 : n < 0.58 ? 0.5 : 0.92;
  },
  rust(u, v) {
    const sp = hash(Math.floor(u * 128), Math.floor(v * 128), 33);
    return 0.75 * fbm(u, v, 4, 4, 31, 5) + (sp > 0.85 ? 0.25 : 0);
  },
  scales(u, v) {
    const x = u * 8, y = v * 8;
    const row = Math.floor(y);
    const x2 = x + (row & 1) * 0.5;
    const fx = x2 % 1, fy = y % 1;
    const d = Math.hypot(fx - 0.5, fy - 1);
    return 0.25 + 0.75 * Math.max(0, 1 - Math.abs(d - 0.7) * 4);
  },
  leather(u, v) {
    const [f1, f2] = voronoi(u, v, 12, 41);
    return 0.8 * Math.min(1, (f2 - f1) * 2.2) + 0.2 * grain(u, v, 43);
  },
  lava(u, v) {
    const [f1, f2] = voronoi(u, v, 6, 51);
    const crack = Math.max(0, 1 - (f2 - f1) / 0.12);
    return 0.9 * crack * crack + 0.1 * fbm(u, v, 4, 4, 52, 3);
  },
  marble(u, v) {
    const n = fbm(u, v, 2, 2, 61, 3);
    return 0.5 + 0.5 * Math.sin(TAU * (4 * u + 2 * v + 3 * n));
  },
  hex(u, v) {
    const [f1, f2, id] = voronoi(u, v, 8, 71);
    const edge = Math.max(0, 1 - (f2 - f1) / 0.1);
    return 0.85 * edge + 0.15 * id;
  },
  circuit(u, v) {
    const x = u * 16, y = v * 16;
    const fx = x % 1, fy = y % 1;
    const h = hash(Math.floor(x), Math.floor(y), 81);
    const trace = (h < 0.5 && Math.abs(fy - 0.5) < 0.07) || (h > 0.4 && Math.abs(fx - 0.5) < 0.07);
    const pad = Math.hypot(fx - 0.5, fy - 0.5) < 0.12;
    return trace || pad ? 0.9 : 0.15 + 0.1 * grain(u, v, 83);
  },
  hazard(u, v) {
    return (((u + v) * 8) % 1) < 0.5 ? 0.95 : 0.1;
  },
  facets(u, v) {
    const [, , id] = voronoi(u, v, 10, 91);
    return 0.2 + 0.8 * id;
  },
  damascus(u, v) {
    const n = fbm(u, v, 2, 2, 101, 3);
    return 0.5 + 0.5 * Math.sin(TAU * (6 * v + 2.5 * n)) * 0.9 + 0.1 * grain(u, v, 103);
  },
  swirl(u, v) {
    const n = fbm(u, v, 2, 2, 111, 3);
    return 0.5 + 0.5 * Math.sin(TAU * (3 * u + 3 * v + 2 * n));
  },
};
const AMP = { hazard: 0.4, camo_wood: 0.3, lava: 0.22, circuit: 0.22 };

function paint(name, glow) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const g = canvas.getContext('2d');
  const img = g.createImageData(SIZE, SIZE);
  const d = img.data;
  const field = FIELD[name];
  const mean = PATTERNS[name].c / 255;
  const amp = AMP[name] ?? 0.28;
  const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const t = clamp(field((x + 0.5) / SIZE, (y + 0.5) / SIZE));
      // The glow mask keeps only the bright lines; the colour map swings around the pattern's mean.
      const v = glow ? t * t * t : clamp(mean + amp * (2 * t - 1));
      const k = (y * SIZE + x) * 4;
      const b = Math.round(v * 255);
      d[k] = d[k + 1] = d[k + 2] = b;
      d[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return canvas;
}

function canvasOf(name, glow) {
  const key = cacheKey(name, glow);
  let c = cache.get(key);
  if (!c) { c = paint(name, glow); cache.set(key, c); }
  return c;
}

function textureOf(name, glow) {
  const t = new THREE.CanvasTexture(canvasOf(name, glow));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = glow ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** A new texture for pattern `name`, for a caller that wants its own repeat or offset. Repeats in both directions. */
export function freshPattern(name) {
  if (!FIELD[name]) return null;
  return textureOf(name, false);
}

const shared = new Map();
/** The shared colour texture for pattern `name`. */
export function patternTexture(name) {
  if (!FIELD[name]) return null;
  let t = shared.get(name);
  if (!t) { t = textureOf(name, false); shared.set(name, t); }
  return t;
}

/** The shared glow mask for pattern `name`: white where its bright lines are. */
export function glowTexture(name) {
  if (!FIELD[name]) return null;
  const key = `glow:${name}`;
  let t = shared.get(key);
  if (!t) { t = textureOf(name, true); shared.set(key, t); }
  return t;
}

let blank = null;
const blankTexture = () => {
  if (!blank) {
    blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    blank.needsUpdate = true;
  }
  return blank;
};

/**
 * Teach a gun material to draw its `map` projected along the surface's dominant axis in the part's own
 * space, scaled by the `value` of `uniform` (repeats per metre). The geometry's own UVs are not used.
 *
 * Also adds the skin's glow and motion: `mat.userData.fx` holds the uniforms a skin sets (`glowOn`, the
 * glow mask `glowMap`, and `anim`: 0 still, 1 pulse, 2 flow). The emissive colour is masked by the
 * glow mask where `glowOn` is set, and the shared clock `FX_TIME` drives both motions.
 */
export function patchMaterial(mat, uniform) {
  const fx = (mat.userData.fx ??= { glowOn: { value: 0 }, glowMap: { value: blankTexture() }, anim: { value: 0 } });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTexScale = uniform;
    shader.uniforms.uGlowOn = fx.glowOn;
    shader.uniforms.uGlowMap = fx.glowMap;
    shader.uniforms.uAnim = fx.anim;
    shader.uniforms.uTime = FX_TIME;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjP;\nvarying vec3 vObjN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjP = position;\nvObjN = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vObjP;
        varying vec3 vObjN;
        uniform float uTexScale;
        uniform float uGlowOn;
        uniform float uAnim;
        uniform float uTime;
        uniform sampler2D uGlowMap;
        vec2 gunProj() {
          vec3 an = abs(vObjN);
          return (an.x >= an.y && an.x >= an.z) ? vObjP.zy : (an.y >= an.z ? vObjP.xz : vObjP.xy);
        }
        vec2 gunFlow() { return uAnim > 1.5 ? vec2(uTime * 0.03, uTime * 0.011) : vec2(0.0); }
        float gunPulse() { return (uAnim > 0.5 && uAnim < 1.5) ? 0.55 + 0.45 * sin(uTime * 2.2) : 1.0; }`)
      .replace('#include <map_fragment>', `
        #ifdef USE_MAP
          diffuseColor *= texture2D(map, gunProj() * uTexScale + gunFlow());
        #endif`)
      .replace('#include <emissivemap_fragment>', `
        #include <emissivemap_fragment>
        float gunGlow = uGlowOn > 0.5 ? texture2D(uGlowMap, gunProj() * uTexScale + gunFlow()).r : 1.0;
        totalEmissiveRadiance = emissive * gunGlow * gunPulse();`);
  };
  mat.customProgramCacheKey = () => 'gun-pattern';
}
