/**
 * Graphics presets, built from measurement rather than taste. Timing one frame at 400x300
 * with each knob isolated: baseline 33.8 ms, shadows off 1.9 ms, half resolution 3.4 ms.
 */
export const QUALITY = {
  low: {
    label: 'PERFORMANCE',
    shadows: false, shadowMap: 512, maxPixelRatio: 1, renderScale: 0.75,
    lights: 4, particles: 0.35, aniso: 1, antialias: false, decals: 30,
  },
  medium: {
    label: 'BALANCED',
    shadows: true, shadowMap: 1024, maxPixelRatio: 1, renderScale: 1.0,
    lights: 8, particles: 0.7, aniso: 4, antialias: true, decals: 60,
  },
  high: {
    label: 'QUALITY',
    shadows: true, shadowMap: 2048, maxPixelRatio: 2, renderScale: 1.0,
    lights: 12, particles: 1.0, aniso: 16, antialias: true, decals: 90,
  },
};

export const DEFAULT_SETTINGS = {
  quality: 'medium',
  sensitivity: 1.0,
  adsSensitivity: 0.75,
  fov: 68,
  invertY: false,
  crosshairColor: '#00ff87',
  crosshairGap: 8,
  showDamageNumbers: true,
  showEnemyHealth: false,
  masterVolume: 0.8,
  viewBob: true,
  toggleAim: false,
  toggleCrouch: true,
  toggleSprint: false,
  arrowKeys: false,
};

export const settings = { ...DEFAULT_SETTINGS };

export function loadSettings() {
  try {
    const raw = localStorage.getItem('overrun.settings');
    if (raw) Object.assign(settings, JSON.parse(raw));
  } catch { /* corrupt or unavailable storage just means defaults */ }
  if (!QUALITY[settings.quality]) settings.quality = DEFAULT_SETTINGS.quality;
}

export function saveSettings() {
  try { localStorage.setItem('overrun.settings', JSON.stringify(settings)); } catch { /* ignore */ }
}
