import { settings } from './settings.js';
import { clamp, rand } from './utils.js';

const midi = (n) => 440 * 2 ** ((n - 69) / 12);

/**
 * Reload foley: which sound plays at which fraction of the reload. Driven by reloadProgress from
 * the frame loop rather than scheduled up front, so a reload cut short by a weapon switch stops
 * making noise the moment it is cancelled.
 */
const RELOAD_STEPS = {
  pistol:  [[0.12, 'magOut'], [0.55, 'magIn'], [0.86, 'slide']],
  ar:      [[0.12, 'magOut'], [0.55, 'magIn'], [0.86, 'charge']],
  smg:     [[0.12, 'magOut'], [0.5, 'magIn'], [0.84, 'charge']],
  shotgun: [[0.18, 'shell'], [0.34, 'shell'], [0.5, 'shell'], [0.66, 'shell'], [0.9, 'pump']],
  sniper:  [[0.1, 'boltUp'], [0.28, 'magOut'], [0.6, 'magIn'], [0.88, 'boltDown']],
};

/** Hit-marker pitch per gun, so a sniper hit lands heavier than an SMG graze. */
const HIT_PITCH = { pistol: 1500, ar: 1400, smg: 1700, shotgun: 1100, sniper: 950 };

// The four chords every song here walks through: Am, F, C, G.
const CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
const ROOTS = [45, 41, 48, 43];

/**
 * Songs are step sequencers: play(audio, step, time, out) is called once per sixteenth note,
 * a quarter-second ahead of time, and schedules whatever falls on that step.
 */
const SONGS = {
  // The lobby: slow pads and a soft arpeggio.
  lobby: {
    bpm: 84,
    play(a, step, t, out) {
      const bar = Math.floor(step / 16) % 4, s = step % 16, chord = CHORDS[bar];
      const barLen = (60 / 84) * 4;
      if (s === 0) for (const n of chord) a.pad(midi(n), t, barLen, 0.05, out);
      if (s % 2 === 0) {
        const n = chord[[0, 1, 2, 1, 0, 2, 1, 2][s / 2]] + 12;
        a.tone({ f0: midi(n), f1: midi(n), dur: 0.5, gain: 0.035, type: 'triangle', at: t, out });
      }
      if (s === 0) a.tone({ f0: midi(ROOTS[bar] - 12), f1: midi(ROOTS[bar] - 12), dur: barLen * 0.9, gain: 0.08, type: 'sine', at: t, out });
    },
  },
  // Emoting: a bouncy, swung groove with a hand-clap.
  emote: {
    bpm: 108,
    play(a, step, t, out) {
      const bar = Math.floor(step / 16) % 2, s = step % 16;
      const swing = s % 2 === 1 ? 0.045 : 0;
      if (s === 0 || s === 7 || s === 10) a.tone({ f0: 140, f1: 45, dur: 0.2, gain: 0.3, type: 'sine', at: t, out });
      if (s === 4 || s === 12) a.burst({ dur: 0.1, gain: 0.14, type: 'bandpass', freq: 1500, q: 1.2, decay: 0.08, at: t, out });
      if (s % 2 === 0) a.burst({ dur: 0.025, gain: 0.03, type: 'highpass', freq: 8000, decay: 0.02, at: t, out });
      const line = bar ? [41, 0, 41, 48, 0, 53, 0, 51, 41, 0, 41, 48, 0, 46, 48, 0] : [45, 0, 45, 52, 0, 57, 0, 55, 45, 0, 45, 52, 0, 50, 52, 0];
      if (line[s]) a.bass(midi(line[s]), t + swing, 0.14, 0.12, out);
      if (s === 2 || s === 6 || s === 14) {
        for (const n of CHORDS[bar ? 1 : 0]) a.tone({ f0: midi(n + 12), f1: midi(n + 12), dur: 0.12, gain: 0.025, type: 'square', at: t + swing, out });
      }
    },
  },
  // In a match: four-on-the-floor, offbeat hats, a pumping bass. Kept low under the gunfire.
  match: {
    bpm: 124,
    play(a, step, t, out) {
      const bar = Math.floor(step / 16) % 4, s = step % 16;
      if (s % 4 === 0) a.tone({ f0: 150, f1: 42, dur: 0.22, gain: 0.34, type: 'sine', at: t, out });
      if (s === 4 || s === 12) {
        a.burst({ dur: 0.14, gain: 0.12, type: 'bandpass', freq: 1900, q: 0.9, decay: 0.12, at: t, out });
        a.tone({ f0: 220, f1: 130, dur: 0.08, gain: 0.08, type: 'triangle', at: t, out });
      }
      if (s % 2 === 1) a.burst({ dur: 0.03, gain: s % 4 === 3 ? 0.05 : 0.03, type: 'highpass', freq: 7500, decay: 0.025, at: t, out });
      if ([0, 3, 6, 8, 10, 11, 14].includes(s)) {
        const n = ROOTS[bar] - 12 + (s === 10 || s === 14 ? 12 : 0);
        a.bass(midi(n), t, 0.16, 0.11, out);
      }
      if (s === 0 && bar % 2 === 0) for (const n of CHORDS[bar]) a.pad(midi(n + 12), t, 1.9, 0.018, out);
    },
  },
};

/** WebAudio runtime. Camera and player access stay explicit so audio has no game-state globals. */
export function createAudio({ getCamera }) {
  return {
    ctx: null, master: null, sfx: null, music: null, noise: null, ambientGain: null, ready: false,
    _song: null, _wantSong: null, _heart: 0,

    init() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      // A gentle compressor on the way out, so a firefight with a grenade in it gets loud
      // without clipping.
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 4;
      comp.attack.value = 0.004; comp.release.value = 0.2;
      comp.connect(this.ctx.destination);
      this.master = this.ctx.createGain();
      this.master.connect(comp);
      this.sfx = this.ctx.createGain();
      this.sfx.connect(this.master);
      this.music = this.ctx.createGain();
      this.music.connect(this.master);
      this.setVolume(settings?.masterVolume ?? 0.8);
      this.setMusicVolume(settings?.musicVolume ?? 0.6);

      const len = Math.floor(this.ctx.sampleRate * 2.5);
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.ready = true;
      if (this._wantSong) this.playMusic(this._wantSong);
    },

    setVolume(v) {
      if (this.master) this.master.gain.value = 0.5 * clamp(v, 0, 1);
    },
    setMusicVolume(v) {
      if (this.music) this.music.gain.value = 0.7 * clamp(v, 0, 1);
    },

    /**
     * Where a voice goes. With no position it is your own sound and goes straight to the bus.
     * With a world position it goes through an HRTF panner placed there, which gives both the
     * direction and the fall-off with distance, after a low-pass that closes with distance
     * the way air dulls a far-off shot.
     */
    _out(pos) {
      if (!pos || !this.ready) return this.sfx;
      const cam = getCamera().position;
      const d = Math.hypot(pos.x - cam.x, pos.y - cam.y, pos.z - cam.z);
      const air = this.ctx.createBiquadFilter();
      air.type = 'lowpass';
      air.frequency.value = 16000 / (1 + d / 14);
      const p = this.ctx.createPanner();
      // HRTF is a convolution per voice; power saver trades it for plain equal-power panning.
      p.panningModel = settings?.powerSaver ? 'equalpower' : 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = 8; p.rolloffFactor = 1; p.maxDistance = 200;
      if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; }
      else p.setPosition(pos.x, pos.y, pos.z);
      air.connect(p); p.connect(this.sfx);
      return air;
    },

    /** Put the listener where the camera is, facing where it faces. Called once a frame. */
    updateListener() {
      if (!this.ready) return;
      const m = getCamera().matrixWorld.elements;
      const L = this.ctx.listener;
      if (L.positionX) {
        L.positionX.value = m[12]; L.positionY.value = m[13]; L.positionZ.value = m[14];
        L.forwardX.value = -m[8]; L.forwardY.value = -m[9]; L.forwardZ.value = -m[10];
        L.upX.value = m[4]; L.upY.value = m[5]; L.upZ.value = m[6];
      } else {
        L.setPosition(m[12], m[13], m[14]);
        L.setOrientation(-m[8], -m[9], -m[10], m[4], m[5], m[6]);
      }
    },

    /** One-shot filtered noise burst. `at` is an absolute context time, `delay` is relative. */
    burst({ dur = 0.18, gain = 0.5, type = 'lowpass', freq = 1800, q = 1, decay = null, delay = 0, at = null, out = null }) {
      if (!this.ready) return;
      const t = (at ?? this.ctx.currentTime) + delay;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      src.playbackRate.value = rand(0.85, 1.15);
      const flt = this.ctx.createBiquadFilter();
      flt.type = type; flt.frequency.value = freq; flt.Q.value = q;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + (decay ?? dur));
      src.connect(flt); flt.connect(g); g.connect(out ?? this.sfx);
      src.start(t, rand(0, 0.3)); src.stop(t + dur + 0.05);
    },

    /** One-shot pitch-swept oscillator. */
    tone({ f0 = 200, f1 = 40, dur = 0.2, gain = 0.4, type = 'sine', delay = 0, at = null, out = null }) {
      if (!this.ready) return;
      const t = (at ?? this.ctx.currentTime) + delay;
      const o = this.ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
      o.connect(g); g.connect(out ?? this.sfx);
      o.start(t); o.stop(t + dur + 0.02);
    },

    /** A soft sawtooth chord tone: slow attack, low-passed, for pads. */
    pad(f, t, dur, gain, out) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = rand(-8, 8);
      const flt = this.ctx.createBiquadFilter();
      flt.type = 'lowpass'; flt.frequency.value = 900;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(gain, t + dur * 0.3);
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
      o.connect(flt); flt.connect(g); g.connect(out);
      o.start(t); o.stop(t + dur + 0.05);
    },

    /** A plucked bass note: a sawtooth through a low-pass that snaps shut. */
    bass(f, t, dur, gain, out) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f;
      const flt = this.ctx.createBiquadFilter();
      flt.type = 'lowpass'; flt.Q.value = 6;
      flt.frequency.setValueAtTime(1400, t);
      flt.frequency.exponentialRampToValueAtTime(180, t + dur);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
      o.connect(flt); flt.connect(g); g.connect(out);
      o.start(t); o.stop(t + dur + 0.02);
    },

    /** Switch the music: 'lobby', 'match', or null for silence. The old song fades out. */
    playMusic(kind) {
      this._wantSong = kind;
      if (!this.ready || this._song?.kind === kind) return;
      const now = this.ctx.currentTime;
      if (this._song) {
        const old = this._song;
        clearInterval(old.timer);
        old.gain.gain.setTargetAtTime(0, now, 0.35);
        setTimeout(() => old.gain.disconnect(), 3000);
        this._song = null;
      }
      const song = SONGS[kind];
      if (!song) return;
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.setTargetAtTime(1, now, 0.6);
      gain.connect(this.music);
      const s = { kind, gain, step: 0, next: now + 0.05 };
      const sixteenth = 60 / song.bpm / 4;
      s.timer = setInterval(() => {
        while (s.next < this.ctx.currentTime + 0.25) {
          song.play(this, s.step, s.next, gain);
          s.next += sixteenth; s.step++;
        }
      }, 50);
      this._song = s;
    },

    /* ------------------------------ guns ------------------------------ */

    /** A shot. `pos` is where it was fired from; null means it is your own gun. */
    gunshot(id, pos = null) {
      if (!this.ready) return;
      const out = this._out(pos);
      const P = { out };
      switch (id) {
        case 'pistol':
          this.burst({ dur: 0.10, gain: 0.42, type: 'highpass', freq: 1400, decay: 0.07, ...P });
          this.tone({ f0: 320, f1: 70, dur: 0.09, gain: 0.30, type: 'square', ...P });
          this.burst({ dur: 0.12, gain: 0.2, type: 'lowpass', freq: 600, decay: 0.1, ...P });
          break;
        case 'ar':
          this.burst({ dur: 0.13, gain: 0.36, type: 'bandpass', freq: 1100, q: 0.8, decay: 0.09, ...P });
          this.tone({ f0: 240, f1: 55, dur: 0.11, gain: 0.30, type: 'sawtooth', ...P });
          this.tone({ f0: 120, f1: 40, dur: 0.12, gain: 0.3, type: 'sine', ...P });
          break;
        case 'smg':
          this.burst({ dur: 0.08, gain: 0.3, type: 'bandpass', freq: 1700, q: 0.9, decay: 0.06, ...P });
          this.tone({ f0: 300, f1: 90, dur: 0.07, gain: 0.22, type: 'sawtooth', ...P });
          this.burst({ dur: 0.04, gain: 0.12, type: 'highpass', freq: 4000, decay: 0.03, ...P });
          break;
        case 'shotgun':
          this.burst({ dur: 0.34, gain: 0.55, type: 'lowpass', freq: 900, decay: 0.28, ...P });
          this.tone({ f0: 150, f1: 32, dur: 0.28, gain: 0.42, type: 'sine', ...P });
          this.burst({ dur: 0.06, gain: 0.3, type: 'highpass', freq: 2200, decay: 0.05, ...P });
          if (!pos) this.foley('pump', 0.42);          // rack the next shell
          break;
        case 'sniper':
          this.burst({ dur: 0.09, gain: 0.6, type: 'highpass', freq: 2600, decay: 0.05, ...P });
          this.tone({ f0: 420, f1: 40, dur: 0.30, gain: 0.5, type: 'square', ...P });
          this.burst({ dur: 0.6, gain: 0.24, type: 'lowpass', freq: 420, decay: 0.55, delay: 0.04, ...P });
          if (!pos) { this.foley('boltUp', 0.55); this.foley('boltDown', 0.78); }
          break;
      }
    },

    /** Mechanical gun noises: magazines, bolts, pumps, shells. Always your own gun. */
    foley(kind, delay = 0) {
      const D = { delay };
      switch (kind) {
        case 'magOut':
          this.burst({ dur: 0.06, gain: 0.16, type: 'bandpass', freq: 1800, q: 3, decay: 0.05, ...D });
          this.tone({ f0: 620, f1: 300, dur: 0.07, gain: 0.07, type: 'triangle', ...D });
          break;
        case 'magIn':
          this.burst({ dur: 0.04, gain: 0.2, type: 'bandpass', freq: 2600, q: 5, decay: 0.035, ...D });
          this.burst({ dur: 0.08, gain: 0.2, type: 'lowpass', freq: 500, decay: 0.07, delay: delay + 0.03 });
          break;
        case 'charge':
          this.burst({ dur: 0.04, gain: 0.18, type: 'bandpass', freq: 3000, q: 4, decay: 0.035, ...D });
          this.burst({ dur: 0.05, gain: 0.22, type: 'bandpass', freq: 2100, q: 4, decay: 0.045, delay: delay + 0.09 });
          break;
        case 'slide':
          this.burst({ dur: 0.07, gain: 0.14, type: 'highpass', freq: 2500, decay: 0.06, ...D });
          this.burst({ dur: 0.04, gain: 0.2, type: 'bandpass', freq: 2300, q: 5, decay: 0.035, delay: delay + 0.06 });
          break;
        case 'shell':
          this.burst({ dur: 0.05, gain: 0.16, type: 'bandpass', freq: 1400, q: 3, decay: 0.045, ...D });
          this.tone({ f0: 900, f1: 520, dur: 0.04, gain: 0.05, type: 'triangle', ...D });
          break;
        case 'pump':
          this.burst({ dur: 0.07, gain: 0.2, type: 'lowpass', freq: 1300, decay: 0.06, ...D });
          this.burst({ dur: 0.06, gain: 0.22, type: 'bandpass', freq: 1900, q: 3, decay: 0.05, delay: delay + 0.13 });
          break;
        case 'boltUp':
          this.burst({ dur: 0.05, gain: 0.16, type: 'bandpass', freq: 2000, q: 4, decay: 0.04, ...D });
          break;
        case 'boltDown':
          this.burst({ dur: 0.06, gain: 0.2, type: 'bandpass', freq: 1500, q: 4, decay: 0.05, ...D });
          break;
      }
    },

    /** Called every frame of a reload with the fraction done before and after this frame. */
    reloadProgress(id, from, to) {
      for (const [f, kind] of RELOAD_STEPS[id] ?? []) if (from < f && to >= f) this.foley(kind);
    },

    equip() {
      this.burst({ dur: 0.06, gain: 0.12, type: 'bandpass', freq: 2200, q: 3, decay: 0.05 });
      this.burst({ dur: 0.05, gain: 0.1, type: 'lowpass', freq: 700, decay: 0.04, delay: 0.05 });
    },

    explosion(pos) {
      const out = this._out(pos);
      this.tone({ f0: 110, f1: 24, dur: 0.7, gain: 0.8, type: 'sine', out });
      this.burst({ dur: 0.8, gain: 0.7, type: 'lowpass', freq: 700, decay: 0.7, out });
      this.burst({ dur: 0.25, gain: 0.4, type: 'highpass', freq: 1800, decay: 0.2, out });
      this.burst({ dur: 1.4, gain: 0.25, type: 'lowpass', freq: 260, decay: 1.3, delay: 0.1, out });
    },
    pinPull()   { this.burst({ dur: 0.07, gain: 0.3, type: 'bandpass', freq: 3600, q: 6, decay: 0.06 }); },
    bounce(pos) { this.tone({ f0: 900, f1: 420, dur: 0.06, gain: 0.2, type: 'square', out: this._out(pos) }); },
    smokePop(pos) {
      const out = this._out(pos);
      this.burst({ dur: 0.12, gain: 0.3, type: 'bandpass', freq: 900, q: 2, decay: 0.1, out });
      this.burst({ dur: 1.6, gain: 0.3, type: 'lowpass', freq: 1400, decay: 1.5, delay: 0.05, out });
    },
    /** A footstep: yours with no position, anyone else's placed where they are. */
    step(pos = null) {
      this.burst({ dur: 0.07, gain: pos ? 0.16 : 0.09, type: 'lowpass', freq: 420, decay: 0.06, out: this._out(pos) });
    },
    slide()     { this.burst({ dur: 0.45, gain: 0.12, type: 'bandpass', freq: 900, q: 0.7, decay: 0.42 }); },

    /* ------------------------------ hits ------------------------------ */

    hit(id)     { const f = HIT_PITCH[id] ?? 1500;
                  this.tone({ f0: f, f1: f * 0.6, dur: 0.05, gain: 0.2, type: 'sine' });
                  if (id === 'shotgun' || id === 'sniper') this.burst({ dur: 0.06, gain: 0.18, type: 'lowpass', freq: 500, decay: 0.05 }); },
    // A headshot has to be told apart from a body hit by ear alone: a bright metallic tink.
    headshot()  { this.tone({ f0: 3200, f1: 2600, dur: 0.07, gain: 0.2, type: 'triangle' });
                  this.burst({ dur: 0.03, gain: 0.16, type: 'highpass', freq: 5000, decay: 0.025 }); },
    /** A shield taking a hit: a glassy ping and a scatter of tiny cracks. */
    shieldHit(incoming = false) {
      const g = incoming ? 0.75 : 1, lo = incoming ? 0.8 : 1;
      this.tone({ f0: 2400 * lo, f1: 1900 * lo, dur: 0.12, gain: 0.12 * g, type: 'triangle' });
      this.tone({ f0: 3700 * lo, f1: 3100 * lo, dur: 0.08, gain: 0.07 * g, type: 'sine' });
      let d = 0;
      for (let i = 0; i < 6; i++) {
        this.burst({ dur: 0.025, gain: rand(0.08, 0.16) * g, type: 'bandpass', freq: rand(3500, 8000) * lo, q: 9, decay: 0.02, delay: d });
        d += rand(0.01, 0.025);
      }
    },
    /** The shield gone: a falling shatter and a long spray of glass. */
    shieldBreak(incoming = false) {
      const g = incoming ? 0.8 : 1;
      this.tone({ f0: 1900, f1: 260, dur: 0.4, gain: 0.14 * g, type: 'triangle' });
      this.tone({ f0: 2900, f1: 700, dur: 0.3, gain: 0.08 * g, type: 'sine', delay: 0.02 });
      this.burst({ dur: 0.45, gain: 0.3 * g, type: 'highpass', freq: 3000, decay: 0.4 });
      let d = 0;
      for (let i = 0; i < 14; i++) {
        this.burst({ dur: 0.03, gain: rand(0.08, 0.18) * g, type: 'bandpass', freq: rand(2500, 9500), q: 10, decay: 0.025, delay: d });
        d += rand(0.012, 0.035);
      }
    },
    hurt()      { this.burst({ dur: 0.14, gain: 0.3, type: 'lowpass', freq: 500, decay: 0.12 });
                  this.tone({ f0: 160, f1: 70, dur: 0.16, gain: 0.2, type: 'sine' }); },
    kill()      { this.tone({ f0: 880, f1: 880, dur: 0.09, gain: 0.22, type: 'triangle' });
                  this.tone({ f0: 1320, f1: 1320, dur: 0.16, gain: 0.2, type: 'triangle', delay: 0.07 }); },
    /** A heartbeat while you are low; call every frame. */
    heartbeat(dt, low) {
      if (!low) { this._heart = 0; return; }
      this._heart -= dt;
      if (this._heart > 0) return;
      this._heart = 0.9;
      this.tone({ f0: 70, f1: 45, dur: 0.14, gain: 0.35, type: 'sine' });
      this.tone({ f0: 62, f1: 40, dur: 0.16, gain: 0.26, type: 'sine', delay: 0.2 });
    },

    reloadClick(){ this.burst({ dur: 0.05, gain: 0.14, type: 'bandpass', freq: 2400, q: 4, decay: 0.04 }); },
    pickup()    { this.tone({ f0: 660, f1: 1320, dur: 0.14, gain: 0.18, type: 'triangle' }); },

    /* ------------------------------ match ------------------------------ */

    uiHover()   { this.tone({ f0: 1800, f1: 1800, dur: 0.03, gain: 0.03, type: 'sine' }); },
    uiClick()   { this.tone({ f0: 900, f1: 1400, dur: 0.06, gain: 0.08, type: 'triangle' }); },
    /** A rising horn as a match starts. */
    roundStart() {
      for (const [n, d] of [[57, 0], [64, 0.12], [69, 0.24]]) {
        this.tone({ f0: midi(n), f1: midi(n), dur: 0.5, gain: 0.1, type: 'sawtooth', delay: d, out: this.music });
      }
    },
    /** The end of a match: a fanfare, a fall, or a shrug. */
    stinger(outcome) {
      this.playMusic(null);
      const notes = outcome === 'win' ? [[60, 0], [64, 0.14], [67, 0.28], [72, 0.42], [76, 0.62], [79, 0.62], [84, 0.62]]
        : outcome === 'loss' ? [[64, 0], [62, 0.25], [60, 0.5], [57, 0.8], [52, 0.8]]
        : [[60, 0], [67, 0.3], [62, 0.6]];
      const long = outcome === 'win' ? 2.4 : 1.8;
      for (const [n, d] of notes) {
        const last = d === notes[notes.length - 1][1];
        this.tone({ f0: midi(n), f1: midi(n), dur: last ? long : 0.3, gain: 0.12, type: 'triangle', delay: d, out: this.music });
        this.tone({ f0: midi(n), f1: midi(n), dur: last ? long : 0.25, gain: 0.05, type: 'square', delay: d, out: this.music });
      }
      if (outcome === 'win') this.burst({ dur: 1.6, gain: 0.12, type: 'highpass', freq: 6000, decay: 1.5, delay: 0.62, out: this.music });
    },

    startAmbient() {
      if (!this.ready || this.ambientGain) return;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise; src.loop = true;
      const flt = this.ctx.createBiquadFilter();
      flt.type = 'lowpass'; flt.frequency.value = 40; flt.Q.value = 0.7;
      const g = this.ctx.createGain();
      g.gain.value = 0.0;
      g.gain.linearRampToValueAtTime(0.35, this.ctx.currentTime + 3);
      src.connect(flt); flt.connect(g); g.connect(this.sfx);
      src.start();
      this.ambientGain = g;
    },
  };
}
