import test from 'node:test';
import assert from 'node:assert/strict';
import { SONG_IDS, SONG_FOR_EMOTE, renderSong, createEmoteMusic } from '../../src/emoteMusic.js';

test('every song renders: finite, bounded, audible and deterministic', async () => {
  for (const id of SONG_IDS) {
    const a = await renderSong(id, 8000);
    const b = await renderSong(id, 8000);
    let peak = 0, sum = 0;
    for (let i = 0; i < a.length; i++) {
      assert.ok(Number.isFinite(a[i]), `${id} sample ${i}`);
      peak = Math.max(peak, Math.abs(a[i])); sum += a[i] * a[i];
    }
    assert.ok(peak <= 1 && peak > 0.05, `${id} peak ${peak}`);
    assert.ok(Math.sqrt(sum / a.length) > 0.05, `${id} rms`);
    assert.deepEqual(a, b, `${id} deterministic`);
  }
});

test('every emote with a song names a song that exists', () => {
  for (const song of Object.values(SONG_FOR_EMOTE)) assert.ok(SONG_IDS.includes(song), song);
});

function fakeAudio() {
  const made = [];
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} });
  const node = () => ({ connect() {}, disconnect() {} });
  const ctx = {
    state: 'running', currentTime: 0,
    createBuffer: (c, n) => ({ duration: n / 22050, copyToChannel() {} }),
    createBufferSource() { const n = { ...node(), start() {}, stop() { this.stopped = true; }, buffer: null }; made.push(n); return n; },
    createGain: () => ({ ...node(), gain: param() }),
    createPanner: () => ({ ...node(), positionX: param(), positionY: param(), positionZ: param() }),
  };
  return { Audio: { ready: true, ctx, music: node() }, made };
}

test('at most three songs sound, the nearest three, and they stop when the dancer does', async () => {
  const { Audio, made } = fakeAudio();
  const music = createEmoteMusic({ Audio, getCamera: () => ({ position: { x: 0, y: 0, z: 0 } }), pause: () => null });
  const feed = () => { for (let i = 0; i < 5; i++) music.play(i, 'ymca', 5 + i * 3, 0, 0); };
  feed(); music._tick();
  await new Promise((r) => setTimeout(r, 400));   // the first render finishes
  feed(); music._tick();
  assert.equal(music.dancers, 5);
  assert.equal(music.voices, 3);
  music.stop(0);
  assert.equal(music.voices, 2);
  music.stopAll();
  assert.equal(music.dancers, 0);
  music._tick();
  assert.equal(music.timerRunning, false);
  assert.ok(made.length >= 3);
});

test('a dancer that stops being refreshed goes quiet, and an emote without a song is ignored', async () => {
  const { Audio } = fakeAudio();
  const music = createEmoteMusic({ Audio, getCamera: () => ({ position: { x: 0, y: 0, z: 0 } }), pause: () => null });
  music.play('a', 'wave', 1, 0, 0);
  assert.equal(music.dancers, 0);
  music.play('b', 'macarena', 1, 0, 0);
  assert.equal(music.dancers, 1);
  await new Promise((r) => setTimeout(r, 800));
  music._tick();
  assert.equal(music.dancers, 0);
  assert.equal(music.timerRunning, false);
});
