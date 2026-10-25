import test from 'node:test';
import assert from 'node:assert/strict';
import { InterpController, qualityReadout, effectiveInputRate, CALM_MIN_RATE, INTERP_CEIL, INTERP_FLOOR } from '../../src/net/netQuality.js';

function feed(ctl, late, n, t0 = 0) {
  for (let i = 0; i < n; i++) ctl.onSnapshot(typeof late === 'function' ? late(i) : late, 0, t0 + i * 50);
}
function settle(ctl, secs = 20) { let d = 0; for (let t = 0; t < secs; t += 1 / 60) d = ctl.step(1 / 60); return d; }

test('clean link settles near two snapshot intervals, under the old 100 ms', () => {
  const c = new InterpController(); c.onRtt(40);
  feed(c, 0, 64);
  const d = settle(c);
  assert.ok(d >= INTERP_FLOOR && d < 0.1, `delay ${d}`);
});

test('jitter raises the delay, and it never passes the ceiling', () => {
  const c = new InterpController(); c.onRtt(40);
  feed(c, (i) => (i % 5 === 0 ? 24 : 1), 64);   // up to 200 ms late
  const d = settle(c);
  assert.ok(d > 0.1 && d <= INTERP_CEIL + 1e-9, `delay ${d}`);
});

test('a missed snapshot adds a margin that later expires', () => {
  const c = new InterpController(); c.onRtt(40);
  feed(c, 0, 20);
  const calm = c.target;
  c.onSnapshot(0, 2, 2000);
  assert.ok(c.target > calm);
  c.onSnapshot(0, 0, 20000);
  assert.ok(c.target <= calm + 1e-9);
});

test('on a long ping the cap stops the delay eating the server rewind budget', () => {
  const c = new InterpController(); c.onRtt(300);
  feed(c, (i) => (i % 4 === 0 ? 24 : 0), 64);
  settle(c);
  assert.ok(c.cap <= 0.15 + 1e-9);
  assert.ok(c.delay <= 0.15 + 1e-9);
});

test('it rises faster than it falls, and never jumps', () => {
  const c = new InterpController(); c.onRtt(40);
  feed(c, 0, 20);
  settle(c, 5);
  const low = c.delay;
  feed(c, 24, 64);
  c.step(1 / 60);
  assert.ok(c.delay - low <= 0.3 / 60 + 1e-9);
});

test('readout levels', () => {
  assert.equal(qualityReadout({ rtt: 40, jitterMs: 5, lossPct: 0, delayMs: 70 }).level, 'good');
  assert.equal(qualityReadout({ rtt: 130, jitterMs: 5, lossPct: 0, delayMs: 70 }).level, 'warn');
  const lim = qualityReadout({ rtt: 350, jitterMs: 5, lossPct: 0, delayMs: 100 });
  assert.equal(lim.level, 'bad');
  assert.match(lim.text, /PING 350 ms/);
  assert.match(lim.text, /LAG-COMP LIMIT/);
});

test('input rate: full in a fight, about half outside one, never below the floor, never above what the server asked', () => {
  assert.equal(effectiveInputRate(20, true), 20);
  assert.equal(effectiveInputRate(20, false), 10);
  assert.equal(effectiveInputRate(15, false), 8);
  assert.equal(effectiveInputRate(10, false), 5 < CALM_MIN_RATE ? CALM_MIN_RATE : 5);
  assert.ok(effectiveInputRate(6, false) <= 6);   // a server asking for less is never exceeded
  for (const r of [6, 10, 15, 20]) assert.ok(effectiveInputRate(r, false) <= r);
});
