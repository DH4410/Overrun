/**
 * Renders the locker portraits: assets/skins/<id>.jpg, 240 x 320, one per skin in src/skins.js.
 * Each is the real rig in its idle pose, lit like the lobby stage, so a new skin only needs its
 * GLB in assets/bots/ and its line in src/skins.js:
 *
 *     node scripts/skin-portraits.mjs            every skin
 *     node scripts/skin-portraits.mjs ninja      just that one
 */
import { chromium } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startServer } from '../server/node.js';
import { SKINS } from '../src/skins.js';

const repo = process.cwd();
const only = process.argv.slice(2);
const ids = SKINS.map((s) => s.id).filter((id) => !only.length || only.includes(id));
const PORT = 8796, BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(repo, 'assets', 'skins');
mkdirSync(OUT, { recursive: true });

const server = await startServer({ port: PORT, budgetFile: path.join(mkdtempSync(path.join(tmpdir(), 'ovr-')), 'b.json'), log: () => {} });
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlXUAAAAASUVORK5CYII=', 'base64');
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 960, height: 540 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.route('https://unpkg.com/three@0.169.0/**', (r) => r.fulfill({ path: path.join(repo, 'node_modules', 'three', new URL(r.request().url()).pathname.split('/three@0.169.0/')[1]), contentType: 'text/javascript; charset=utf-8', headers: { 'Access-Control-Allow-Origin': '*' } }));
await page.route('https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/+esm', (r) => r.fulfill({ path: path.join(repo, 'node_modules', 'cannon-es', 'dist', 'cannon-es.js'), contentType: 'text/javascript; charset=utf-8', headers: { 'Access-Control-Allow-Origin': '*' } }));
await page.route('https://dl.polyhaven.org/**', (r) => r.fulfill({ body: tinyPng, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' } }));
await page.addInitScript(() => localStorage.setItem('overrun.settings', JSON.stringify({ quality: 'low', masterVolume: 0 })));
await page.goto(BASE);
await page.waitForFunction(() => window.__game?.assets, null, { timeout: 90000 });

for (const id of ids) {
  const url = await page.evaluate(async (skin) => {
    const g = window.__game, T = g.THREE;
    await g.loadCharacter(skin);
    const mesh = g.buildCharacterMesh(skin);
    if (!mesh) return null;
    const { clips, mixer } = mesh.userData;
    for (const a of Object.values(clips)) a.weight = 0;
    clips.Idle.weight = 1;
    mixer.update(0.4);
    const W = 240, H = 320;
    const r = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    r.setPixelRatio(2);
    r.setSize(W, H, false);
    r.outputColorSpace = T.SRGBColorSpace;
    const scene = new T.Scene();
    const bg = document.createElement('canvas'); bg.width = 4; bg.height = 256;
    const c2 = bg.getContext('2d'), grad = c2.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#26323f'); grad.addColorStop(0.7, '#141b23'); grad.addColorStop(1, '#0b0f14');
    c2.fillStyle = grad; c2.fillRect(0, 0, 4, 256);
    const tex = new T.CanvasTexture(bg); tex.colorSpace = T.SRGBColorSpace;
    scene.background = tex;
    scene.add(new T.HemisphereLight(0xdfe8f5, 0x3a3f48, 1.9));
    const key = new T.DirectionalLight(0xfff0dc, 2.8); key.position.set(-2.5, 3, -4); scene.add(key);
    const rim = new T.DirectionalLight(0x7fb2ff, 2.2); rim.position.set(3, 2.5, 3); scene.add(rim);
    scene.add(mesh);
    mesh.updateMatrixWorld(true);
    const box = new T.Box3().setFromObject(mesh), size = box.getSize(new T.Vector3()), mid = box.getCenter(new T.Vector3());
    // Three-quarter view, a little above the waist so the face and the gear read.
    const cam = new T.PerspectiveCamera(24, W / H, 0.1, 50);
    const dist = (size.y * 0.5) / Math.tan(T.MathUtils.degToRad(12)) * 1.12;
    const dir = new T.Vector3(-0.35, 0.08, -1).normalize();
    cam.position.copy(mid).addScaledVector(dir, dist);
    cam.lookAt(mid.x, mid.y + size.y * 0.02, mid.z);
    r.render(scene, cam);
    const out = r.domElement.toDataURL('image/jpeg', 0.86);
    r.dispose();
    return out;
  }, id);
  if (!url) { console.log(id, 'did not load'); continue; }
  writeFileSync(path.join(OUT, `${id}.jpg`), Buffer.from(url.split(',')[1], 'base64'));
  console.log('wrote', id);
}
await browser.close();
await server.stop();
process.exit(0);
