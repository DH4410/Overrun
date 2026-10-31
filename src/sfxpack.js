import { settings } from './settings.js';
import { rand } from './utils.js';
import { HIT_PITCH } from './audio.js';

/**
 * The optional sound pack: recorded sound effects and menu music (assets/audio, built by
 * tools/audio/build_pack.py from the sources in assets/LICENSES.md) laid over the synthesized audio in
 * audio.js. Nothing here is fetched, decoded or played unless the player turns it on in settings:
 * `soundPack` for the effects, `menuMusic` for the lobby and shop tracks. With both off this file only
 * installs wrappers that call straight through.
 *
 * Every wrapper below follows one rule: if the pack is on and the clip is loaded, play the recording;
 * otherwise run the original procedural sound. So a missing file, a slow connection or a failed
 * decode costs nothing but the nicer sound.
 */

/** Per-sound level trims. Every clip is normalised to the same peak, so these set how loud each should sit. */
const MIX = {
  step_concrete: 0.5, step_tile: 0.5, step_metal: 0.5, step_grass: 0.55, step_gravel: 0.55, step_wood: 0.55,
  step_water: 0.6, step_sand: 0.55, step_snow: 0.55, land: 0.7, jump: 0.35, slide: 0.35,
  equip: 0.5, foley_magOut: 0.55, foley_magIn: 0.6, foley_charge: 0.6, foley_slide: 0.55, foley_shell: 0.5,
  foley_pump: 0.65, foley_boltUp: 0.5, foley_boltDown: 0.5, empty: 0.5, lowammo: 0.35, reloadclick: 0.35,
  hit: 0.45, headshot: 0.5, hurt: 0.7, die: 0.8, kill: 0.45, killhs: 0.5, streak: 0.5, revenge: 0.6,
  shieldhit: 0.4, shieldbreak: 0.6, heartbeat: 0.7, pickup: 0.45,
  nade_pin: 0.5, nade_throw: 0.5, nade_bounce: 0.6, nade_boom: 1, smoke_pop: 0.7,
  crate_fall: 0.5, crate_thud: 0.9, crate_lock: 0.6, crate_burst: 0.8,
  ui_click: 0.45, ui_hover: 0.22, ui_select: 0.45, ui_back: 0.45, ui_open: 0.45, ui_close: 0.4, ui_toggle: 0.45,
  ui_switch: 0.4, ui_scroll: 0.3, ui_confirm: 0.5, ui_error: 0.5, ui_buy: 0.55, ui_equip: 0.55, ui_skin: 0.55,
  ui_tab: 0.4, ui_locked: 0.45, countdown: 0.6, go: 0.7, win: 0.7, loss: 0.6, draw: 0.55, level_up: 0.55,
  objective: 0.6, zone_tick: 0.3,
};
/** Level trims for whole families of sounds, by name prefix. */
const PREFIX_MIX = [['empty_', 0.5], ['equip_', 0.5], ['reloadclick_', 0.4], ['lowammo_', 0.35], ['foley_', 0.6], ['casing_', 0.3],
  ['impact_', 0.5], ['ambience_', 0.3]];
Object.assign(MIX, {
  whiz: 0.55, nade_far: 0.9, ring: 0.2, ads_in: 0.3, ads_out: 0.3, crouch: 0.3, stand: 0.3,
  ui_slider: 0.25, spawn: 0.45, countdown_final: 0.7,
});
/** Guns sit at one level whatever the recording's own loudness, a little apart: a pistol is quieter than a shotgun. */
const GUN_GAIN = 0.8;
const GUN_LEVEL = { pistol: 0.62, mp: 0.62, smg: 0.68, revolver: 0.85, ar: 0.78, dmr: 0.88, ashotgun: 0.9, shotgun: 0.95, lmg: 0.88, sniper: 1 };
const mixOf = (name) => MIX[name]
  ?? (name.startsWith('gunfar_') ? GUN_LEVEL[name.slice(7)] : name.startsWith('gun_') ? GUN_LEVEL[name.slice(4)] : undefined)
  ?? PREFIX_MIX.find(([p]) => name.startsWith(p))?.[1] ?? GUN_GAIN;
/** What a bullet sounds like hitting each map's ground and walls. */
const IMPACT_OF = { concrete: 'concrete', tile: 'concrete', metal: 'metal', gravel: 'dirt', sand: 'dirt', snow: 'snow', grass: 'dirt', wood: 'wood' };
/** Past this distance (m) a shot uses the far recording, which has the room and the air in it. */
const FAR = 40;

/** Which healing item makes which sound. */
const ITEM_SOUND = { bandage: 'bandage', medkit: 'medkit', mini: 'shield', big: 'drink' };

const MUSIC_FADE = 0.8;

export function attachSoundPack(audio, { base = 'assets/audio/' } = {}) {
  const pack = {
    manifest: null, manifestLoading: null, bufs: new Map(), loadStarted: false, loaded: false,
    last: new Map(), musicBufs: new Map(), track: null, wantMusic: null, musicIndex: 0, musicToken: 0,
    gun: null,                      // the gun whose handling sounds the foley should use
    amb: null, ambName: null, ambWanted: false,
  };

  const wantsEffects = () => !!settings.soundPack;
  const wantsMusic = () => !!settings.menuMusic;
  const active = () => pack.loaded && wantsEffects() && audio.ready;

  const getJson = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); };

  function loadManifest() {
    pack.manifestLoading ??= getJson(`${base}manifest.json`).then((m) => { pack.manifest = m; return m; })
      .catch((e) => { pack.manifestLoading = null; console.warn('[sfxpack]', e.message); return null; });
    return pack.manifestLoading;
  }

  async function decode(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return audio.ctx.decodeAudioData(await r.arrayBuffer());
  }

  /** Fetch and decode every clip, a few at a time. Idempotent; runs only once the player has switched the pack on. */
  async function loadEffects() {
    if (pack.loadStarted || !wantsEffects() || !audio.ready) return;
    pack.loadStarted = true;
    const m = await loadManifest();
    if (!m) { pack.loadStarted = false; return; }
    const jobs = [];
    for (const [name, files] of Object.entries(m.clips)) for (const f of files) jobs.push([name, f]);
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const [name, f] = jobs[next++];
        try {
          const buf = await decode(base + f);
          if (!pack.bufs.has(name)) pack.bufs.set(name, []);
          pack.bufs.get(name).push(buf);
          pack.loaded = true;       // playable as soon as the first clips are in; the rest fill in
        } catch (e) { console.warn('[sfxpack]', e.message); }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    syncAmbience();
  }

  /** Play one clip of `name`. `pos` places it in the world; returns false if there was nothing to play. */
  function play(name, { pos = null, gain = 1, rate = 1, delay = 0, jitter = 0.04 } = {}) {
    if (!active()) return false;
    const list = pack.bufs.get(name);
    if (!list?.length) return false;
    let i = Math.floor(Math.random() * list.length);
    if (list.length > 1 && i === pack.last.get(name)) i = (i + 1) % list.length;   // never the same take twice running
    pack.last.set(name, i);
    const src = audio.ctx.createBufferSource();
    src.buffer = list[i];
    src.playbackRate.value = rate * (1 + rand(-jitter, jitter));
    const g = audio.ctx.createGain();
    g.gain.value = gain * mixOf(name);
    src.connect(g);
    g.connect(audio._out(pos) ?? audio.sfx);
    src.start(audio.ctx.currentTime + delay);
    return true;
  }

  /** Replace `method` so it plays `fn(...args)`'s clip when the pack is on, and the original sound when it is not or `fn` declines. */
  function wrap(method, fn) {
    const orig = audio[method].bind(audio);
    audio[method] = (...args) => {
      if (active() && fn(...args) !== false) return undefined;
      return orig(...args);
    };
  }

  /* ------------------------------ effects ------------------------------ */

  const SHOT_FOLEY = { shotgun: [['pump', 0.42]], ashotgun: [['charge', 0.35]], sniper: [['boltUp', 0.55], ['boltDown', 0.78]] };
  const NO_CASING = new Set(['revolver', 'sniper']);
  let lastCasing = 0;
  wrap('gunshot', (id, pos = null) => {
    const cam = pos ? audio.camPos() : null;
    const far = pos && cam && Math.hypot(pos.x - cam.x, pos.y - cam.y, pos.z - cam.z) > FAR;
    const ok = (far && play(`gunfar_${id}`, { pos })) || play(`gun_${id}`, { pos });
    if (!ok) return false;
    if (!pos) {
      pack.gun = id;
      for (const [kind, d] of SHOT_FOLEY[id] ?? []) audio.foley(kind, d);   // your own gun works its action
      const now = audio.ctx.currentTime;
      if (!NO_CASING.has(id) && now - lastCasing > 0.12) {
        lastCasing = now;
        play(id === 'shotgun' || id === 'ashotgun' ? 'casing_shell' : 'casing_brass', { delay: 0.3 + Math.random() * 0.25, jitter: 0.12 });
      }
    }
    return true;
  });
  /** A handling sound: this gun's own recording if the pack has one, else the common one. */
  const handling = (kind, id, opts) => play(`${kind}_${id}`, opts) || play(kind, opts);
  wrap('foley', (kind, delay = 0) => play(`foley_${pack.gun}_${kind}`, { delay }) || play(`foley_${kind}`, { delay }));
  const reloadProgress = audio.reloadProgress.bind(audio);
  audio.reloadProgress = (id, from, to) => { pack.gun = id; return reloadProgress(id, from, to); };
  wrap('equip', (id) => { if (id) pack.gun = id; return handling('equip', id ?? pack.gun); });
  wrap('explosion', (pos) => {
    if (!pack.bufs.has('nade_boom')) return false;
    let d = 0;
    if (pos) {
      const c = audio.camPos();
      d = Math.hypot(pos.x - c.x, pos.y - c.y, pos.z - c.z);
      if (d < 25) audio.duck(0.3, 1.4);
    }
    if (d > 45 && pack.bufs.has('nade_far')) return play('nade_far', { pos });
    const ok = play('nade_boom', { pos });
    if (pos && d < 8) play('ring', { delay: 0.2, jitter: 0 });       // the ringing after a close one
    return ok;
  });
  wrap('pinPull', () => play('nade_pin'));
  wrap('bounce', (pos) => play('nade_bounce', { pos }));
  wrap('smokePop', (pos) => play('smoke_pop', { pos }));
  wrap('slide', () => play('slide'));
  wrap('step', (pos = null) => {
    const surf = audio.surface?.() ?? 'concrete';
    return play(`step_${surf}`, { pos, gain: pos ? 1.3 : 1, rate: 0.95, jitter: 0.1 }) || play('step_concrete', { pos, gain: pos ? 1.3 : 1, jitter: 0.1 });
  });
  wrap('hit', (id) => play('hit', { rate: Math.min(1.25, Math.max(0.8, (HIT_PITCH[id] ?? 1500) / 1500)), jitter: 0.02 }));
  wrap('headshot', () => play('headshot'));
  wrap('shieldHit', (incoming) => play('shieldhit', { gain: incoming ? 0.8 : 1, rate: incoming ? 0.85 : 1 }));
  wrap('shieldBreak', (incoming) => play('shieldbreak', { gain: incoming ? 0.8 : 1 }));
  wrap('hurt', () => play('hurt'));
  wrap('kill', (streak = 0) => play('kill', { rate: 2 ** (Math.min(Math.max(streak - 1, 0), 7) * 1.5 / 12), jitter: 0 }));
  wrap('headshotKill', () => play('killhs'));
  wrap('streakReward', () => play('streak'));
  wrap('revenge', () => play('revenge'));
  wrap('reloadClick', (id) => handling('reloadclick', id ?? pack.gun));
  wrap('lowAmmo', (id) => handling('lowammo', id ?? pack.gun));
  wrap('pickup', () => play('pickup'));
  wrap('uiHover', () => play('ui_hover'));
  /** Which click a button makes, from what it says and where it sits. */
  const clickFor = (el) => {
    const b = el?.closest?.('button');
    const t = (b?.textContent ?? '').trim();
    if (!b || !t) return 'ui_click';
    if (b.closest('.tabs')) return 'ui_tab';
    if (/^(back|close|cancel|leave|exit|no|resume|done|skip)\b/i.test(t) || /^[\u00d7x]$/i.test(t)) return 'ui_back';
    if (/^(play|start|deploy|join|create|host|ready|confirm|yes|apply|save|launch)\b/i.test(t)) return 'ui_confirm';
    return 'ui_click';
  };
  wrap('uiClick', (el) => play(clickFor(el)));
  wrap('roundStart', () => play('go'));
  wrap('stinger', (outcome) => {
    if (!pack.bufs.has(outcome === 'win' ? 'win' : outcome === 'loss' ? 'loss' : 'draw')) return false;
    audio.playMusic(null);
    return play(outcome === 'win' ? 'win' : outcome === 'loss' ? 'loss' : 'draw');
  });
  wrap('heartbeat', (dt, low) => {
    if (!low) { audio._heart = 0; return true; }
    audio._heart -= dt;
    if (audio._heart > 0) return true;
    audio._heart = 0.9;
    return play('heartbeat', { jitter: 0.02 }) && play('heartbeat', { delay: 0.2, gain: 0.7, rate: 0.9, jitter: 0.02 });
  });

  /**
   * Named cues for things audio.js never had a sound for (menus, jumping, healing, crates...).
   * Returns true when a recording played, so a caller can fall back to its own sound otherwise.
   */
  let lastTick = 0;
  audio.cue = (name, arg = null) => {
    if (!active()) return false;
    switch (name) {
      case 'land': return play('land');
      case 'jump': return play('jump');
      case 'empty': return handling('empty', arg ?? pack.gun);
      case 'ui_slider': {            // a dragged slider ticks, not buzzes
        const now = audio.ctx.currentTime;
        if (now - lastTick < 0.06) return true;
        lastTick = now;
        return play('ui_slider', { jitter: 0.1 });
      }
      case 'reveal': return play(`reveal_${arg ?? 'common'}`);
      case 'crate': return play(`crate_${arg}`);
      case 'item_start': return play(`use_${ITEM_SOUND[arg] ?? arg}`);
      case 'item_done': return play(`done_${ITEM_SOUND[arg] ?? arg}`);
      default: return play(name);
    }
  };
  audio.surface = null;     // main.js sets this to a function returning the floor material of the current map
  audio.ambient = null;     // ... and this one the name of the map's ambience loop (or null)

  let lastImpact = 0, lastWhiz = 0;
  /** A bullet hitting the world at `pos`. A shotgun's pellets land together, so they share one sound. */
  audio.impact = (pos) => {
    if (!active()) return false;
    const now = audio.ctx.currentTime;
    if (now - lastImpact < 0.05) return true;
    const c = audio.camPos();
    const d = Math.hypot(pos.x - c.x, pos.y - c.y, pos.z - c.z);
    if (d > 70) return true;
    lastImpact = now;
    const surf = audio.surface?.() ?? 'concrete', r = Math.random();
    const kind = r < 0.2 ? 'metal' : r < 0.28 ? 'wood' : (surf === 'tile' && r < 0.4) ? 'glass' : IMPACT_OF[surf] ?? 'concrete';
    return play(`impact_${kind}`, { pos, gain: d > 30 ? 0.6 : 1, jitter: 0.1 });
  };
  /** A bullet passing close by your head. */
  audio.whiz = (pos) => {
    if (!active()) return false;
    const now = audio.ctx.currentTime;
    if (now - lastWhiz < 0.12) return true;
    lastWhiz = now;
    return play('whiz', { pos, jitter: 0.15 });
  };

  /* ---------------------------- map ambience ---------------------------- */

  function stopAmbience() {
    const a = pack.amb;
    pack.amb = null;
    pack.ambName = null;
    if (!a) return;
    a.gain.gain.cancelScheduledValues(audio.ctx.currentTime);
    a.gain.gain.setTargetAtTime(0, audio.ctx.currentTime, 0.4);
    setTimeout(() => { try { a.src.stop(); } catch { /* already stopped */ } a.gain.disconnect(); }, 2500);
  }
  /** Keep the right ambience loop running for this map: started by a match, changed by the next one, ended by switching the pack off. */
  function syncAmbience() {
    if (!audio.ready) return;
    const want = pack.ambWanted && wantsEffects() ? audio.ambient?.() ?? null : null;
    if (want === pack.ambName) return;
    stopAmbience();
    const buf = want && pack.bufs.get(`ambience_${want}`)?.[0];
    if (!buf) return;
    const now = audio.ctx.currentTime;
    const gain = audio.ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.setTargetAtTime(mixOf(`ambience_${want}`), now, 1.2);
    gain.connect(audio.sfx);
    const src = audio.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(gain);
    src.start();
    pack.amb = { src, gain };
    pack.ambName = want;
  }
  const startAmbient = audio.startAmbient.bind(audio);
  audio.startAmbient = () => { startAmbient(); pack.ambWanted = true; syncAmbience(); };

  /* ------------------------------ music ------------------------------ */

  function stopTrack(t) {
    if (!t) return;
    t.stopped = true;
    const now = audio.ctx.currentTime;
    t.gain.gain.cancelScheduledValues(now);
    t.gain.gain.setTargetAtTime(0, now, MUSIC_FADE / 3);
    setTimeout(() => { try { t.src.stop(); } catch { /* already ended */ } t.gain.disconnect(); }, MUSIC_FADE * 1500);
  }

  async function playTrack(kind) {
    const token = ++pack.musicToken;
    const m = await loadManifest();
    const files = m?.music?.[kind];
    if (!files?.length || token !== pack.musicToken) return;
    const file = files[pack.musicIndex++ % files.length];
    let buf = pack.musicBufs.get(file);
    if (!buf) {
      try { buf = await decode(base + file); } catch (e) { console.warn('[sfxpack]', e.message); return; }
      pack.musicBufs.set(file, buf);
    }
    if (token !== pack.musicToken || !wantsMusic() || pack.wantMusic !== kind) return;
    stopTrack(pack.track);
    const now = audio.ctx.currentTime;
    const gain = audio.ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.setTargetAtTime(0.8, now, MUSIC_FADE / 3);
    gain.connect(audio.music);
    const src = audio.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(gain);
    src.start();
    const t = { kind, src, gain, stopped: false };
    src.onended = () => { if (!t.stopped && pack.track === t && pack.wantMusic === kind) playTrack(kind); };   // the next track in the list
    pack.track = t;
  }

  /** Which menu music should be playing right now: 'lobby', 'shop' or null. Safe to call at any time. */
  audio.menuMusic = (kind) => {
    pack.wantMusic = kind;
    syncMusic();
  };
  function syncMusic() {
    if (!audio.ready) return;
    const want = wantsMusic() ? pack.wantMusic : null;
    if (!want) {
      pack.musicToken++;
      if (pack.track) { stopTrack(pack.track); pack.track = null; }
      return;
    }
    if (pack.track?.kind === want && !pack.track.stopped) return;
    playTrack(want);
  }

  /** Call when a setting changes, and once audio has started: begins loading what has been switched on. */
  audio.syncSoundPack = () => {
    if (wantsEffects()) loadEffects();
    syncMusic();
    syncAmbience();
  };

  /** How much of the pack has decoded, for tests and the console. */
  audio.packStats = () => ({ names: pack.bufs.size, clips: [...pack.bufs.values()].reduce((n, l) => n + l.length, 0) });

  const init = audio.init.bind(audio);
  audio.init = () => { init(); audio.syncSoundPack(); };
  return pack;
}
