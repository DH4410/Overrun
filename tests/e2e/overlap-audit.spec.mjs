import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { bootGame, startMatch } from './helpers/game.mjs';

/**
 * Text must never collide: not with other text, not with the edge of the panel or button it sits
 * in (or the cut corner of one), and never be clipped. This walks every screen at a few window
 * sizes and reports what it finds; with AUDIT_OUT set it also writes the findings to a file.
 */

const seed = (page, profile) => page.addInitScript((p) => {
  if (!globalThis.sessionStorage.getItem('seeded')) { localStorage.setItem('overrun.profile', JSON.stringify(p)); globalThis.sessionStorage.setItem('seeded', '1'); }
}, profile);

/** Runs in the page: every way text can collide with something. */
function scan() {
  const vw = innerWidth, vh = innerHeight;
  const hiddenUp = (e) => {
    for (let n = e; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return true;
    }
    return false;
  };
  const name = (e) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${typeof e.className === 'string' && e.className.trim() ? `.${e.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}`;
  const items = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent.trim();
    const p = n.parentElement;
    if (!text || !p || ['SCRIPT', 'STYLE', 'OPTION', 'TITLE'].includes(p.tagName) || hiddenUp(p)) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    // the glyphs sit in the line box, which can be tighter than the font's own box: use the smaller
    const lh = parseFloat(getComputedStyle(p).lineHeight);
    const rs = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5)
      .map((r) => (lh > 0 && r.height > lh + 1 ? { left: r.left, right: r.right, top: r.top + (r.height - lh) / 2, bottom: r.bottom - (r.height - lh) / 2 } : r));
    if (!rs.length) continue;
    const r = { left: Math.min(...rs.map((x) => x.left)), top: Math.min(...rs.map((x) => x.top)), right: Math.max(...rs.map((x) => x.right)), bottom: Math.max(...rs.map((x) => x.bottom)) };
    // Fully inside a scrolled-away or clipped region: not on screen, so not a collision.
    let gone = false;
    for (let a = p; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const b = a.getBoundingClientRect();
        if (r.right <= b.left || r.left >= b.right || r.bottom <= b.top || r.top >= b.bottom) { gone = true; break; }
      }
    }
    if (gone || r.right < 0 || r.left > vw || r.bottom < 0 || r.top > vh) continue;
    // Covered by something else on top (a page under a page): not seen, so not a collision.
    const hit = [[0.5, 0.5], [0.15, 0.5], [0.85, 0.5]].map(([fx, fy]) => document.elementFromPoint(Math.min(vw - 1, Math.max(0, r.left + (r.right - r.left) * fx)), Math.min(vh - 1, Math.max(0, r.top + (r.bottom - r.top) * fy))));
    if (hit.every((h) => !h || !(h === p || p.contains(h) || h.contains(p)))) continue;
    items.push({ el: p, r, text: text.slice(0, 28) });
  }
  const found = new Map();
  const add = (kind, it, extra = '') => { const k = `${kind}|${name(it.el)}|${it.text}`; if (!found.has(k)) found.set(k, `${kind}: ${name(it.el)} "${it.text}" ${extra}`.trim()); };

  for (const it of items) {
    const { r, el } = it;
    // off the window is only a fault where nothing scrolls to it
    const scrolls = (() => { for (let a = el; a; a = a.parentElement) { if (a.scrollHeight > a.clientHeight + 2 && ['auto', 'scroll'].includes(getComputedStyle(a).overflowY)) return true; } return document.scrollingElement.scrollHeight > vh + 2; })();
    if (!scrolls && (r.left < -1 || r.right > vw + 1 || r.top < -1 || r.bottom > vh + 1)) add('offscreen', it, `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}`);
    // clipped by an ancestor that hides its overflow
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (a !== document.body && (cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.overflowY === 'hidden' || cs.overflowY === 'clip')) {
        const b = a.getBoundingClientRect();
        if (r.left < b.left - 1.5 || r.right > b.right + 1.5 || r.top < b.top - 1.5 || r.bottom > b.bottom + 1.5) { add('clipped', it, `by ${name(a)}`); break; }
      }
    }
    // the frame the text sits in: the nearest box with a border, a background or a cut shape
    let frame = null;
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a), b = a.getBoundingClientRect();
      if (b.width > vw * 0.92 && b.height > vh * 0.6) break;
      const bg = cs.backgroundColor.match(/[\d.]+/g);
      const hasBg = bg && (bg.length < 4 || Number(bg[3]) > 0.2) && cs.backgroundColor !== 'transparent';
      // a box-shaped border: three or four sides, or an inset shadow; an underline or a rule is not a frame
      const sides = ['Top', 'Right', 'Bottom', 'Left'].filter((s) => parseFloat(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== 'none').length;
      if (hasBg || sides >= 3 || cs.boxShadow.includes('inset') || cs.clipPath !== 'none') { frame = { a, cs, b }; break; }
    }
    if (!frame) continue;
    const { b, cs, a } = frame;
    const gap = { l: r.left - b.left, t: r.top - b.top, rr: b.right - r.right, bb: b.bottom - r.bottom };
    const tight = Math.min(gap.l, gap.t, gap.rr, gap.bb);
    if (tight < -1) add('spills out of', it, `${name(a)} by ${Math.round(-tight)}px`);
    else if (tight < 3 && b.height > 14) add('touches edge of', it, `${name(a)} (${Math.round(tight)}px)`);
    if (cs.clipPath !== 'none') {
      const cut = Math.max(0, ...[...cs.clipPath.matchAll(/([\d.]+)px/g)].map((m) => Number(m[1])));
      if (cut) {
        const corners = [[gap.l, gap.t], [gap.rr, gap.t], [gap.l, gap.bb], [gap.rr, gap.bb]];
        // a cut corner is a 45 degree slice: text whose nearest corner is inside it is being cut
        if (corners.some(([x, y]) => x + y < cut - 1 && x < cut && y < cut)) add('in cut corner of', it, `${name(a)} (${cut}px cut)`);
      }
    }
  }
  // a text field whose value is wider than the field shows only part of it
  for (const inp of document.querySelectorAll('input[type=text], input:not([type])')) {
    if (!hiddenUp(inp) && inp.clientWidth > 0 && inp.scrollWidth > inp.clientWidth + 1) found.set(`input|${name(inp)}`, `input text cut: ${name(inp)} "${inp.value}" (${inp.scrollWidth} > ${inp.clientWidth})`);
  }
  // text against other text
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const A = items[i], B = items[j];
      if (A.el === B.el || A.el.contains(B.el) || B.el.contains(A.el)) continue;
      const w = Math.min(A.r.right, B.r.right) - Math.max(A.r.left, B.r.left), h = Math.min(A.r.bottom, B.r.bottom) - Math.max(A.r.top, B.r.top);
      if (w > 2 && h > 3) add('text overlaps text', A, `with ${name(B.el)} "${B.text}" (${Math.round(w)}x${Math.round(h)})`);
    }
  }
  return [...found.values()];
}

const SIZES = [[1920, 1080], [1366, 768], [1280, 650], [1024, 600]];
const report = {};
const record = (size, screen, list) => { (report[size] ||= {})[screen] = list; };

for (const [w, h] of SIZES) {
  test(`overlap audit ${w}x${h}`, async ({ page }) => {
    test.setTimeout(240_000);
    await seed(page, { xp: 9000, credits: 123456, spent: 0 });
    await page.setViewportSize({ width: w, height: h });
    await bootGame(page);
    page.setDefaultTimeout(12000);
    const size = `${w}x${h}`;
    const look = async (screen) => { await page.waitForTimeout(250); record(size, screen, await page.evaluate(scan)); };
    const tryStep = async (screen, fn) => { try { await fn(); await look(screen); } catch (e) { record(size, screen, [`could not open: ${String(e.message).split('\n')[0]}`]); } };

    await look('lobby');
    await tryStep('lobby-online', async () => { await page.click('#ptab-online'); });
    await page.click('#ptab-solo').catch(() => {});
    for (const [id, label] of [['#tab-operators', 'operators'], ['#tab-career', 'career'], ['#locker-open', 'locker'], ['#tab-store', 'store'], ['#tab-market', 'market']]) {
      await tryStep(label, async () => { await page.click(id); });
    }
    await tryStep('store-crate-drop', async () => {
      await page.click('#tab-store');
      await page.click('#st-open');
      await page.evaluate(() => globalThis.__testClock.pump(1, 11000));   // a legendary show runs 10 s
      await page.waitForTimeout(400);
    });
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await page.click('#tab-play').catch(() => {});
    // the friends button only shows for a signed-in player
    if (await page.locator('#friends-btn').isVisible()) await tryStep('friends', async () => { await page.click('#friends-btn'); });
    await page.keyboard.press('Escape');
    await page.click('#fr-close').catch(() => {});
    await tryStep('account', async () => { await page.click('#account'); });
    await page.keyboard.press('Escape');
    await tryStep('settings', async () => { await page.click('#settings-open'); });
    const tabs = await page.locator('#set-nav button').allInnerTexts().catch(() => []);
    for (const t of tabs) await tryStep(`settings-${t}`, async () => { await page.locator('#set-nav button', { hasText: t }).click(); });
    await page.evaluate(() => document.querySelector('#settings-close')?.click());
    await page.keyboard.press('Escape');

    await startMatch(page, { mode: 'dm', map: 'port', diff: 'easy' });
    await page.evaluate(() => {
      const g = globalThis.__game;
      g.player.ammo.pistol.mag = 3;
    });
    await look('match-hud');
    await page.keyboard.down('Tab');
    await look('match-scoreboard');
    await page.keyboard.up('Tab');
    await page.keyboard.press('Escape');
    await look('match-pause');
    await page.click('#resume-btn').catch(() => {});

    const all = Object.entries(report[size] ?? {});
    const bad = all.filter(([, l]) => l.length);
    if (process.env.AUDIT_OUT) {
      mkdirSync(path.dirname(process.env.AUDIT_OUT), { recursive: true });
      writeFileSync(process.env.AUDIT_OUT.replace('.json', `-${size}.json`), JSON.stringify(Object.fromEntries(all), null, 1));
    }
    console.log(`AUDIT ${size}: ${bad.reduce((n, [, l]) => n + l.length, 0)} findings on ${bad.length} screens`);
    if (process.env.AUDIT_STRICT) expect(Object.fromEntries(bad)).toEqual({});
  });
}
