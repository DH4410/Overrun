import { expect, test } from '@playwright/test';

import { bootGame } from './helpers/game.mjs';

/**
 * The lobby must read at any window size: no block of text on top of another, nothing pushed off
 * the screen. Checked as geometry (the boxes of the lobby's blocks), at the sizes people actually
 * have, on both panes of the play panel.
 */

const SIZES = [[1920, 1080], [1440, 810], [1366, 768], [1280, 720], [1024, 600], [800, 450]];
const BLOCKS = ['#topnav .brand', '#topnav .tabs', '#account', '#playercard', '#nextreward', '#operator .op-plate', '#operator #op-prev', '#operator #op-next', '#lobby-right', '#keyhelp'];

async function boxes(page) {
  return page.evaluate((sel) => sel.flatMap((s) => {
    const e = document.querySelector(s);
    if (!e) return [];
    const cs = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    if (cs.display === 'none' || cs.visibility === 'hidden' || r.width === 0 || r.height === 0) return [];
    return [{ s, x: r.left, y: r.top, r: r.right, b: r.bottom }];
  }), BLOCKS);
}

const overlap = (a, b) => Math.min(a.r, b.r) - Math.max(a.x, b.x) > 1 && Math.min(a.b, b.b) - Math.max(a.y, b.y) > 1;

for (const [w, h] of SIZES) {
  for (const pane of ['solo', 'online']) {
    test(`lobby at ${w}x${h}, ${pane}: nothing overlaps and nothing leaves the screen`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await bootGame(page);
      if (pane === 'online') await page.click('#ptab-online');
      const list = await boxes(page);
      expect(list.length).toBeGreaterThan(3);
      for (const b of list) {
        expect(b.x, `${b.s} left edge`).toBeGreaterThanOrEqual(-1);
        expect(b.y, `${b.s} top edge`).toBeGreaterThanOrEqual(-1);
        expect(b.r, `${b.s} right edge (${w} wide)`).toBeLessThanOrEqual(w + 1);
        expect(b.b, `${b.s} bottom edge (${h} tall)`).toBeLessThanOrEqual(h + 1);
      }
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          expect(overlap(list[i], list[j]), `${list[i].s} overlaps ${list[j].s}`).toBe(false);
        }
      }
      // Every control the player needs is reachable: the primary button is fully on screen.
      const primary = await page.locator(pane === 'solo' ? '#play' : '#mp-play').boundingBox();
      expect(primary.y + primary.height).toBeLessThanOrEqual(h);
      expect(primary.x + primary.width).toBeLessThanOrEqual(w);
    });
  }
}
