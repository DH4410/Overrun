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

/**
 * Render-rate caps offered in the settings panel; 0 means "as fast as the display".
 *
 * A cap is the bluntest battery lever there is. An uncapped loop on a 144 Hz laptop panel
 * draws 2.4x the frames of a 60 Hz cap for a difference most players cannot see, and the
 * simulation is untouched either way because it runs on its own fixed clock.
 */
export const FRAME_CAPS = [30, 60, 120, 0];

export const DEFAULT_SETTINGS = {
  quality: 'medium',
  frameCap: 60,
  adaptiveRes: true,
  powerSaver: false,
  sensitivity: 1.0,
  adsSensitivity: 0.75,
  fov: 78,
  invertY: false,
  crosshairColor: '#ffffff',
  crosshairGap: 8,
  showDamageNumbers: true,
  showEnemyHealth: false,
  masterVolume: 0.8,
  musicVolume: 0.6,
  viewBob: true,
  toggleAim: false,
  toggleCrouch: true,
  arrowKeys: false,
  touchpad: false,
  trackpadLook: false,
  aimAssist: 0.35,
  version: 2,
};

export const settings = { ...DEFAULT_SETTINGS };

/** The hip-fire vertical field of view the player chose; aiming narrows it in the same proportion. */
export const hipFov = () => settings.fov;
export const adsFov = (base) => base * (settings.fov / DEFAULT_SETTINGS.fov);

/**
 * "I am on a touchpad" is one switch for what a touchpad player would otherwise hunt down in five
 * places. Each helper is the effective value: the touchpad switch forces the friendly choice on,
 * and leaves the individual settings alone so turning it off puts everything back.
 */
export const aimToggles = () => settings.touchpad || settings.toggleAim;
export const lookBoost = () => settings.touchpad || settings.trackpadLook;
/** Friction-only assist is never below half strength on a touchpad; the pull above that stays the player's choice. */
export const assistLevel = () => (settings.touchpad ? Math.max(settings.aimAssist, 0.5) : settings.aimAssist);

export function loadSettings() {
  try {
    const raw = localStorage.getItem('overrun.settings');
    if (raw) Object.assign(settings, JSON.parse(raw));
  } catch { /* corrupt or unavailable storage just means defaults */ }
  // Version 2: the crosshair is white by default (an older profile carries the old green), and the
  // sprint switches are gone because sprint is always on.
  if (!(settings.version >= 2)) settings.crosshairColor = DEFAULT_SETTINGS.crosshairColor;
  delete settings.autoSprint; delete settings.toggleSprint;
  settings.version = DEFAULT_SETTINGS.version;
  if (!QUALITY[settings.quality]) settings.quality = DEFAULT_SETTINGS.quality;
  // A cap that is not one of the offered values would be paced against nonsense, and a profile
  // saved before the setting existed carries no cap at all.
  if (!FRAME_CAPS.includes(settings.frameCap)) settings.frameCap = DEFAULT_SETTINGS.frameCap;
  // A profile saved while the unused 68 default existed would otherwise zoom everyone in.
  if (!(settings.fov >= 60 && settings.fov <= 100) || settings.fov === 68) settings.fov = DEFAULT_SETTINGS.fov;
}

export function saveSettings() {
  try { localStorage.setItem('overrun.settings', JSON.stringify(settings)); } catch { /* ignore */ }
}
