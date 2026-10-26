/**
 * Picking a graphics preset for the machine in front of us.
 *
 * A web page cannot read CPU or memory load, and the figures it can read are coarse: the logical
 * core count, a memory size rounded and capped at 8 GB, and the name of the GPU. So AUTO works in
 * two stages. classifyDevice() makes a first guess from those, plus how many pixels the window
 * will draw (the cost that matters most on an integrated GPU), and createAutoGovernor() then
 * watches real frame times and steps the preset down if the guess was too generous. It only ever
 * steps down: stepping back up would recompile shaders mid-match to chase a few frames.
 */

export const TIER_ORDER = ['high', 'medium', 'low'];

const SOFTWARE = /swiftshader|llvmpipe|softpipe|basic render|software/i;
const DISCRETE = /\b(rtx|gtx|geforce|quadro|titan|radeon (rx|pro|vii)|arc [ab]\d|apple m\d)/i;
const INTEGRATED = /(intel.*(uhd|hd graphics|iris|xe)|radeon\s*\(tm\)\s*graphics|radeon graphics|radeon.*vega \d+ graphics|mali|adreno|powervr|apple gpu)/i;

/** Pixels an integrated GPU can fill at Balanced and still hold 60: about a 1366x768 laptop panel at 1.25x. */
export const INTEGRATED_BALANCED_MAX_PIXELS = 1.4e6;

const rank = (tier) => TIER_ORDER.indexOf(tier);
const atMost = (tier, cap) => (rank(tier) < rank(cap) ? cap : tier);

/**
 * @param {{gpu?: string, cores?: number, memoryGB?: number, pixels?: number, mobile?: boolean}} device
 *   `cores` and `memoryGB` are 0 when the browser would not say, which never lowers the result.
 * @returns {{tier: 'high'|'medium'|'low', gpuClass: string, reasons: string[]}}
 */
export function classifyDevice({ gpu = '', cores = 0, memoryGB = 0, pixels = 0, mobile = false } = {}) {
  const reasons = [];
  let gpuClass = 'unknown';
  if (SOFTWARE.test(gpu)) gpuClass = 'software';
  else if (INTEGRATED.test(gpu)) gpuClass = 'integrated';
  else if (DISCRETE.test(gpu)) gpuClass = 'discrete';

  let tier = 'medium';
  if (gpuClass === 'software') { tier = 'low'; reasons.push('software rendering'); }
  else if (mobile) { tier = 'low'; reasons.push('phone or tablet'); }
  else if (gpuClass === 'discrete') { tier = 'high'; reasons.push('dedicated GPU'); }
  else if (gpuClass === 'integrated') {
    if (pixels > INTEGRATED_BALANCED_MAX_PIXELS) { tier = 'low'; reasons.push('integrated GPU on a large screen'); }
    else reasons.push('integrated GPU');
  } else reasons.push('GPU not recognised');

  if ((cores && cores <= 2) || (memoryGB && memoryGB <= 2)) { tier = 'low'; reasons.push('2 cores or 2 GB of memory'); }
  else if ((cores && cores <= 4) || (memoryGB && memoryGB <= 4)) { tier = atMost(tier, 'medium'); reasons.push('4 cores or 4 GB of memory'); }
  return { tier, gpuClass, reasons };
}

/** Reads what the browser will tell us. Safe to call anywhere; whatever is missing comes back empty. */
export function readDevice(win = globalThis) {
  const nav = win.navigator || {};
  let gpu = '';
  try {
    const canvas = win.document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    if (info) gpu = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) || '');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();   // a spare context would count against the page's limit
  } catch { /* the name is only a hint */ }
  const dpr = Math.min(win.devicePixelRatio || 1, 2);
  let mobile = /Android|iPhone|iPad|Mobile/i.test(nav.userAgent || '');
  try { mobile = mobile || !!win.matchMedia?.('(pointer: coarse) and (hover: none)').matches; } catch { /* no media queries */ }
  return {
    gpu,
    cores: nav.hardwareConcurrency || 0,
    memoryGB: nav.deviceMemory || 0,
    pixels: (win.innerWidth || 0) * (win.innerHeight || 0) * dpr * dpr,
    mobile,
  };
}

/**
 * Steps the preset down when frames stay late after adaptive resolution has nothing left to give.
 * `sample()` returns the next tier down once it has seen `patience` full windows of late frames in
 * a row, then stays quiet for `cooldown` seconds so the new preset gets a fair look.
 */
export function createAutoGovernor({ window = 120, over = 1.3, patience = 2, cooldown = 20 } = {}) {
  let frames = 0, sum = 0, strikes = 0, quiet = 0;
  const clear = () => { frames = 0; sum = 0; strikes = 0; };
  return {
    reset: clear,
    /**
     * @param {number} interval   seconds since the previous drawn frame
     * @param {number} budget     seconds per frame being targeted
     * @param {boolean} exhausted adaptive resolution has no pixels left to take (or is off)
     * @param {string} tier       the preset in force now
     * @returns {string|null} the next tier down, or null
     */
    sample(interval, budget, exhausted, tier) {
      if (quiet > 0 && interval > 0) quiet -= interval;
      if (!(budget > 0) || !(interval > 0) || interval > 0.5) return null;   // a pause or load says nothing
      if (quiet > 0 || !exhausted) { clear(); return null; }
      frames += 1; sum += interval;
      if (frames < window) return null;
      const late = sum / frames > budget * over;
      frames = 0; sum = 0;
      strikes = late ? strikes + 1 : 0;
      if (strikes < patience) return null;
      strikes = 0;
      const next = TIER_ORDER[rank(tier) + 1];
      if (!next) return null;
      quiet = cooldown;
      return next;
    },
  };
}
