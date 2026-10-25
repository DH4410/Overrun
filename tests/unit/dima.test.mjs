import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, chipText, fmtSpan } from '../../src/dima.js';

const stats = (messages, extra = {}) => ({
  players: 2, spectators: 1,
  budget: { messages, limit: 2_000_000, used: messages / 2_000_000, billedRequests: Math.ceil(messages / 20), inputRate: 20, lastRound: false, exhausted: false, resetInSec: 5 * 3600, ...extra },
});

test('fmtSpan reads as hours and minutes', () => {
  assert.equal(fmtSpan(20), '<1m');
  assert.equal(fmtSpan(42 * 60), '42m');
  assert.equal(fmtSpan(3 * 3600 + 5 * 60), '3h 05m');
  assert.equal(fmtSpan(Infinity), '--');
});

test('the load is the slope of the history and the time left follows from it', () => {
  const hist = [{ at: 0, messages: 100_000 }, { at: 10_000, messages: 100_100 }];   // 10 msg/s
  const s = summarize(stats(100_100), hist);
  assert.ok(Math.abs(s.rate - 10) < 1e-9);
  assert.equal(s.requests, 5005);
  assert.equal(s.requestLimit, 100_000);
  assert.ok(Math.abs(s.etaSec - (2_000_000 - 100_100) / 10) < 1e-6);
  assert.equal(s.next.label, '15/s');            // 60 % comes first
  assert.ok(Math.abs(s.next.sec - (1_200_000 - 100_100) / 10) < 1e-6);
});

test('no load means no estimate; a budget that outlasts the day says so', () => {
  const idle = summarize(stats(500), [{ at: 0, messages: 500 }, { at: 5000, messages: 500 }]);
  assert.equal(idle.rate, 0);
  assert.equal(idle.etaSec, Infinity);
  assert.match(chipText(idle), /IDLE/);
  const slow = summarize(stats(500), [{ at: 0, messages: 0 }, { at: 10_000, messages: 500 }]);   // 50 msg/s: ~11 h left, 5 h to reset
  assert.equal(slow.lastsPastReset, true);
  assert.match(chipText(slow), /LASTS TO RESET/);
});

test('a heavy load shows the hours left, and a spent budget says closed', () => {
  const heavy = summarize(stats(1_000_000), [{ at: 0, messages: 0 }, { at: 1000, messages: 100 }]);   // 100 msg/s: 10 000 s
  assert.match(chipText(heavy), /LEFT$/);
  const closed = summarize(stats(2_000_000, { exhausted: true }), []);
  assert.match(chipText(closed), /CLOSED/);
});

test('no /stats means the chip says so rather than inventing numbers', () => {
  assert.equal(summarize({}, []), null);
  assert.match(chipText(null), /NO SERVER STATS/);
});
