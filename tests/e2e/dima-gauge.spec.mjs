import { expect, test } from '@playwright/test';
import { bootGame, startMatch } from './helpers/game.mjs';

const SHOT = process.env.DIMA_SHOTS || '';
let served = 0;
const mockStats = (page) => page.route('**/stats', (route) => {
  served += 1;
  const messages = 300_000 + served * 3_000;   // grows between polls, so there is a load to read
  route.fulfill({ contentType: 'application/json', body: JSON.stringify({
    players: 3, spectators: 0,
    budget: { messages, limit: 2_000_000, used: messages / 2_000_000, billedRequests: Math.ceil(messages / 20), inputRate: 20, lastRound: false, exhausted: false, resetInSec: 4 * 3600 },
  }) });
});

test('the Cloudflare gauge shows for the callsign DIMA only, and opens into the numbers', async ({ page }) => {
  await mockStats(page);
  await bootGame(page);
  const field = page.locator('#nameinput:visible, #nameinput2:visible').first();
  await expect(page.locator('#dima-panel')).toHaveCount(0);   // not built for anyone else

  await field.fill('someone');
  await expect(page.locator('#dima-panel')).toHaveCount(0);

  await field.fill('dima');
  const chip = page.locator('#dima-panel .dp-chip');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText(/CLOUDFLARE \d+(\.\d)?% ·/);
  await chip.click();
  const body = page.locator('#dima-panel .dp-body');
  await expect(body).toBeVisible();
  await expect(body).toContainText('REQUESTS TODAY');
  await expect(body).toContainText('/ 100,000');
  await expect(body).toContainText('RESETS (00:00 UTC)');
  if (SHOT) await page.screenshot({ path: `${SHOT}/dima-lobby.png` });

  await field.fill('PLAYER');
  await expect(page.locator('#dima-panel')).toBeHidden();
});

test('the gauge is still there in a match and says so when the host has no /stats', async ({ page }) => {
  await page.route('**/stats', (route) => route.fulfill({ status: 404, body: 'no' }));
  await bootGame(page);
  await page.locator('#nameinput:visible, #nameinput2:visible').first().fill('Dima');
  await expect(page.locator('#dima-panel .dp-chip')).toContainText('NO SERVER STATS');
  await startMatch(page, { map: 'port' });
  await expect(page.locator('#dima-panel .dp-chip')).toBeVisible();
  if (SHOT) await page.screenshot({ path: `${SHOT}/dima-match.png` });
});
