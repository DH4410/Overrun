import { settings } from './settings.js';
import { clamp, rand } from './utils.js';

/** WebAudio runtime. Camera and player access stay explicit so audio has no game-state globals. */
export function createAudio({ getCamera, getPlayer }) {
  return {
    ctx: null, master: null, noise: null, ambientGain: null, ready: false,

    init() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5 * (settings?.masterVolume ?? 1);
      this.master.connect(this.ctx.destination);

      const len = Math.floor(this.ctx.sampleRate * 1.0);
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.ready = true;
    },

    setVolume(v) {
      if (this.master) this.master.gain.value = 0.5 * clamp(v, 0, 1);
    },

    /** One-shot filtered noise burst. */
    burst({ dur = 0.18, gain = 0.5, type = 'lowpass', freq = 1800, q = 1, decay = null, delay = 0, pan = 0 }) {
      if (!this.ready) return;
      const t = this.ctx.currentTime + delay;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      src.playbackRate.value = rand(0.85, 1.15);
      const flt = this.ctx.createBiquadFilter();
      flt.type = type; flt.frequency.value = freq; flt.Q.value = q;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + (decay ?? dur));
      src.connect(flt); flt.connect(g); g.connect(this._panner(pan) ?? this.master);
      src.start(t); src.stop(t + dur + 0.05);
    },

    /** One-shot pitch-swept oscillator. */
    tone({ f0 = 200, f1 = 40, dur = 0.2, gain = 0.4, type = 'sine', delay = 0, pan = 0 }) {
      if (!this.ready) return;
      const t = this.ctx.currentTime + delay;
      const o = this.ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
      o.connect(g); g.connect(this._panner(pan) ?? this.master);
      o.start(t); o.stop(t + dur + 0.02);
    },

    /** Distance attenuation for anything that did not happen at the camera. */
    atten(dist) { return clamp(1 - dist / 70, 0.06, 1); },

    /** Project a world-space sound onto the camera/player stereo axis. */
    spatial(worldPos) {
      const camera = getCamera();
      const player = getPlayer();
      const dx = worldPos.x - camera.position.x;
      const dy = worldPos.y - camera.position.y;
      const dz = worldPos.z - camera.position.z;
      const dist = Math.hypot(dx, dy, dz) || 0.001;
      const cy = Math.cos(player.yaw), sy = Math.sin(player.yaw);
      const pan = clamp(((dx * cy) + (dz * -sy)) / dist, -1, 1);
      return { dist, pan: pan * 0.85 };
    },

    /** Optional stereo panner in front of the master bus. */
    _panner(pan) {
      if (!pan || !this.ctx.createStereoPanner) return null;
      const p = this.ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      p.connect(this.master);
      return p;
    },

    gunshot(id, dist = 0, pan = 0) {
      const v = this.atten(dist);
      const P = { pan };
      if (v <= 0.06 && dist > 90) return;
      switch (id) {
        case 'pistol':
          this.burst({ dur: 0.10, gain: 0.42 * v, type: 'highpass', freq: 1400, decay: 0.07, ...P });
          this.tone({ f0: 320, f1: 70, dur: 0.09, gain: 0.30 * v, type: 'square', ...P });
          break;
        case 'ar':
          this.burst({ dur: 0.13, gain: 0.36 * v, type: 'bandpass', freq: 1100, q: 0.8, decay: 0.09, ...P });
          this.tone({ f0: 240, f1: 55, dur: 0.11, gain: 0.30 * v, type: 'sawtooth', ...P });
          break;
        case 'shotgun':
          this.burst({ dur: 0.34, gain: 0.55 * v, type: 'lowpass', freq: 900, decay: 0.28, ...P });
          this.tone({ f0: 150, f1: 32, dur: 0.28, gain: 0.42 * v, type: 'sine', ...P });
          break;
        case 'sniper':
          this.burst({ dur: 0.09, gain: 0.6 * v, type: 'highpass', freq: 2600, decay: 0.05, ...P });
          this.tone({ f0: 420, f1: 40, dur: 0.30, gain: 0.5 * v, type: 'square', ...P });
          this.burst({ dur: 0.6, gain: 0.24 * v, type: 'lowpass', freq: 420, decay: 0.55, delay: 0.04, ...P });
          break;
      }
    },

    explosion(dist = 0) {
      const v = this.atten(dist * 0.55);
      this.tone({ f0: 110, f1: 24, dur: 0.7, gain: 0.7 * v, type: 'sine' });
      this.burst({ dur: 0.8, gain: 0.6 * v, type: 'lowpass', freq: 700, decay: 0.7 });
      this.burst({ dur: 0.25, gain: 0.35 * v, type: 'highpass', freq: 1800, decay: 0.2 });
    },
    pinPull()   { this.burst({ dur: 0.07, gain: 0.3, type: 'bandpass', freq: 3600, q: 6, decay: 0.06 }); },
    bounce(d)   { const v = this.atten(d); this.tone({ f0: 900, f1: 420, dur: 0.06, gain: 0.16 * v, type: 'square' }); },
    step()      { this.burst({ dur: 0.07, gain: 0.09, type: 'lowpass', freq: 420, decay: 0.06 }); },
    hit()       { this.tone({ f0: 1500, f1: 900, dur: 0.05, gain: 0.2, type: 'sine' }); },
    // A headshot has to be told apart from a body hit by ear alone: a bright metallic tink.
    headshot()  { this.tone({ f0: 3200, f1: 2600, dur: 0.07, gain: 0.2, type: 'triangle' });
                  this.burst({ dur: 0.03, gain: 0.16, type: 'highpass', freq: 5000, decay: 0.025 }); },
    hurt()      { this.burst({ dur: 0.14, gain: 0.3, type: 'lowpass', freq: 500, decay: 0.12 });
                  this.tone({ f0: 160, f1: 70, dur: 0.16, gain: 0.2, type: 'sine' }); },
    kill()      { this.tone({ f0: 880, f1: 880, dur: 0.09, gain: 0.22, type: 'triangle' });
                  this.tone({ f0: 1320, f1: 1320, dur: 0.16, gain: 0.2, type: 'triangle', delay: 0.07 }); },
    reloadClick(){ this.burst({ dur: 0.05, gain: 0.14, type: 'bandpass', freq: 2400, q: 4, decay: 0.04 }); },
    pickup()    { this.tone({ f0: 660, f1: 1320, dur: 0.14, gain: 0.18, type: 'triangle' }); },
    smokePop(d) { const v = this.atten(d); this.burst({ dur: 0.9, gain: 0.3 * v, type: 'lowpass', freq: 600, decay: 0.85 }); },

    startAmbient() {
      if (!this.ready || this.ambientGain) return;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise; src.loop = true;
      const flt = this.ctx.createBiquadFilter();
      flt.type = 'lowpass'; flt.frequency.value = 40; flt.Q.value = 0.7;
      const g = this.ctx.createGain();
      g.gain.value = 0.0;
      g.gain.linearRampToValueAtTime(0.35, this.ctx.currentTime + 3);
      src.connect(flt); flt.connect(g); g.connect(this.master);
      src.start();
      this.ambientGain = g;
    },
  };
}
