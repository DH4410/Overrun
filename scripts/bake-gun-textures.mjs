// Draws every gun-skin pattern (tools/gunTextureDraw.js) and the crate panel (tools/crateTextureDraw.js)
// and saves them as JPGs in assets/textures/guns/ and assets/textures/crate/.
// Run: npm run bake:textures   (needs the Playwright Chromium that the e2e tests use)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

import { PATTERNS } from '../src/gunskins.js';

const out = new URL('../assets/textures/guns/', import.meta.url);
mkdirSync(out, { recursive: true });
const code = readFileSync(new URL('../tools/gunTextureDraw.js', import.meta.url), 'utf8').replace('export { DRAW, N };', 'window.DRAW = DRAW;');

const crateOut = new URL('../assets/textures/crate/', import.meta.url);
mkdirSync(crateOut, { recursive: true });
const crateCode = readFileSync(new URL('../tools/crateTextureDraw.js', import.meta.url), 'utf8').replace('export const CRATE_TEXTURES', 'window.CRATE_TEXTURES');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<canvas></canvas>');
await page.addScriptTag({ content: code });
let total = 0;
for (const name of Object.keys(PATTERNS)) {
  const url = await page.evaluate((n) => window.DRAW[n]().toDataURL('image/jpeg', 0.9), name);
  const buf = Buffer.from(url.split(',')[1], 'base64');
  writeFileSync(new URL(`${name}.jpg`, out), buf);
  total += buf.length;
  console.log(name.padEnd(12), `${(buf.length / 1024).toFixed(1)} KB`);
}
await page.addScriptTag({ content: crateCode });
for (const name of ['panel', 'bump', 'end', 'endbump']) {
  const url = await page.evaluate((n) => window.CRATE_TEXTURES[n]().toDataURL('image/jpeg', 0.88), name);
  const buf = Buffer.from(url.split(',')[1], 'base64');
  writeFileSync(new URL(`${name}.jpg`, crateOut), buf);
  console.log(`crate/${name}`.padEnd(12), `${(buf.length / 1024).toFixed(1)} KB`);
}
console.log(`${Object.keys(PATTERNS).length} textures, ${(total / 1024).toFixed(0)} KB in total`);
await browser.close();
