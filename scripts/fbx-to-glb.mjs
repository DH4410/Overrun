/**
 * Convert a Mixamo character FBX into a web-sized GLB.
 *
 * Why this exists: Mixamo serves characters as FBX with uncompressed embedded textures.
 * "Swat Guy" arrives at 115 MB against the 2.1 MB of the soldier.glb it would replace — a
 * 55x regression on first load, on a game whose whole point is that it boots from static
 * files with no build step. Shipping that is not an option, and neither is hand-editing an
 * FBX.
 *
 * The conversion runs in a real browser, because that is where the tools actually work:
 * three's GLTFExporter encodes textures through canvas.toBlob, which has no Node equivalent
 * worth reproducing. Playwright is already a dev dependency and three is already installed,
 * so this adds no new tooling. It is a dev script: nothing in the shipped game imports it.
 *
 * Two knobs do the work:
 *   --max-texture  caps every image's longest edge, applied in-page rather than left to
 *                  the exporter so the resulting dimensions are ours
 *
 * Colour maps are re-encoded as JPEG rather than the exporter's default PNG, which is what
 * actually collapses the size for photographic skin and fabric. Normal maps stay PNG.
 *
 * Usage:
 *   node scripts/fbx-to-glb.mjs <input.fbx> <output.glb> [--max-texture=1024]
 */
import { chromium } from '@playwright/test';
import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const positional = [];
  const flags = { maxTexture: 1024 };
  for (const arg of argv) {
    const m = /^--([\w-]+)=(.*)$/.exec(arg);
    if (!m) { positional.push(arg); continue; }
    if (m[1] === 'max-texture') flags.maxTexture = Number(m[2]);
    else throw new Error(`unknown flag --${m[1]}`);
  }
  if (positional.length !== 2) {
    throw new Error('usage: node scripts/fbx-to-glb.mjs <input.fbx> <output.glb> [--max-texture=N]');
  }
  return { input: positional[0], output: positional[1], ...flags };
}

/** Serve the repo plus the input file's own directory, so the page can fetch both. */
function serve(extraRoot) {
  const types = new Map([
    ['.js', 'text/javascript; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.html', 'text/html; charset=utf-8'],
    ['.fbx', 'application/octet-stream'],
    ['.glb', 'model/gltf-binary'],
    ['.json', 'application/json; charset=utf-8'],
  ]);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const name = decodeURIComponent(url.pathname);
    const root = name.startsWith('/input/') ? extraRoot : repoRoot;
    const rel = name.startsWith('/input/') ? name.slice('/input/'.length) : name.replace(/^\/+/, '');
    const file = path.resolve(root, rel);
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) { res.writeHead(403).end(); return; }
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error('not a file');
      res.writeHead(200, {
        'content-type': types.get(path.extname(file)) || 'application/octet-stream',
        'content-length': info.size,
      });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const PAGE = `<!doctype html><meta charset="utf-8">
<script type="importmap">{"imports":{
  "three":"/node_modules/three/build/three.module.js",
  "three/addons/":"/node_modules/three/examples/jsm/"
}}</script>
<script type="module">
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeGroups, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/** Bind-pose height every character is scaled to, measured from assets/bots/soldier.glb
 *  so the runtime's existing fitting maths applies unchanged to every character. */
const TARGET_HEIGHT = 1.832;

const TEXTURE_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap',
                       'emissiveMap', 'aoMap', 'specularMap'];

function collectTextures(root) {
  const found = new Map();
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const mat of mats) {
      if (!mat) continue;
      for (const slot of TEXTURE_SLOTS) {
        const tex = mat[slot];
        if (tex && tex.isTexture && !found.has(tex)) found.set(tex, slot);
      }
    }
  });
  return found;
}

/**
 * FBXLoader decodes embedded textures ASYNCHRONOUSLY: it creates the Texture objects
 * during parse and fills in .image from a blob URL later. Traversing straight after the
 * load therefore sees .image === null on every slot, so the JPEG hint below never gets
 * applied and the exporter falls back to PNG - which is how a 46k-triangle character came
 * out at 17 MB.
 */
async function awaitTextureImages(textures, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const pending = [...textures.keys()].filter((t) => !t.image || !t.image.width);
    if (!pending.length || performance.now() > deadline) return pending.length;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Index and de-duplicate the geometry, and collapse its material groups.
 *
 * This is where the file size actually lives, which was not obvious: after downscaling all
 * seven 4096-square textures to 512 the images came to 1.53 MB of a 10 MB file. The other
 * 8.5 MB was one mesh carrying 138,891 vertices for 46,297 triangles -- FBXLoader hands back
 * fully unindexed geometry, so every triangle owns three private vertices and nothing is
 * shared. mergeVertices welds them back together.
 *
 * FBX multi-material meshes also arrive split into hundreds of tiny draw groups (index
 * counts of 5382, 126, 18, 6, 3...), and GLTFExporter emits one primitive per group, so the
 * character costs hundreds of draw calls a frame. mergeGroups sorts them back into one
 * group per material.
 */
function optimiseGeometry(root) {
  const stats = { before: 0, after: 0, groupsBefore: 0, groupsAfter: 0 };
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    let geo = o.geometry;
    if (!geo?.attributes?.position) return;
    stats.before += geo.attributes.position.count;
    stats.groupsBefore += geo.groups.length;
    try {
      geo = mergeVertices(geo);
      if (geo.groups.length > 1) geo = mergeGroups(geo);
      o.geometry = geo;
    } catch (err) {
      console.warn('geometry optimise skipped:', err.message);
    }
    stats.after += o.geometry.attributes.position.count;
    stats.groupsAfter += o.geometry.groups.length;
  });
  return stats;
}

/** Downscale here rather than leaving it to the exporter, so the dimensions are ours. */
function downscale(texture, maxSize) {
  const img = texture.image;
  if (!img || !img.width) return null;
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
  const before = { w: img.width, h: img.height };
  if (scale >= 1) return { ...before, scaled: false };
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const to = canvas.width + 'x' + canvas.height;
  texture.image = canvas;
  texture.needsUpdate = true;
  return { ...before, to, scaled: true };
}

window.THREE = THREE;
window.convert = async (url, maxTexture) => {
  const root = await new FBXLoader().loadAsync(url);

  /**
   * Put the colon back into the Mixamo bone names.
   *
   * three's FBXLoader delivers bones as 'mixamorigHips', but soldier.glb -- and therefore
   * every animation clip the game binds, which is retargeted to match it -- uses
   * 'mixamorig:Hips'. AnimationMixer binds by exact name and silently ignores a track that
   * matches nothing, so a character exported with the stripped names would load, show up in
   * the world, and then stand frozen in its T-pose while every clip played into the void.
   *
   * The digit allows for rigs re-processed by Mixamo, which come back as 'mixamorig1',
   * 'mixamorig2' and so on; they are the same bones under a different label.
   *
   * NOTE the doubled backslash: this whole page is a JS template literal in the Node file,
   * so a lone backslash-d is eaten before the browser ever sees it and the pattern quietly
   * degrades to 'mixamorig' followed by literal d's, which matches nothing.
   */
  let renamed = 0;
  root.traverse((o) => {
    const fixed = o.name.replace(/^mixamorig\\d*(?=[A-Z])/, 'mixamorig:');
    if (fixed !== o.name) { o.name = fixed; renamed++; }
  });

  /**
   * Normalise the height, rather than assuming a unit.
   *
   * Mixamo mostly authors in centimetres, but not always: of three characters pulled from
   * the same library, two arrived ~180 units tall and one arrived under 1. A blanket 0.01
   * scale therefore produced one character the size of a coin. Measuring the bind pose and
   * scaling to a known height works whatever the source unit was, and matching soldier.glb
   * exactly means the runtime keeps using the fitting maths it already has.
   */
  root.scale.setScalar(1);
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root);
  const rawHeight = bounds.max.y - bounds.min.y;
  if (rawHeight > 1e-6) root.scale.setScalar(TARGET_HEIGHT / rawHeight);
  root.updateMatrixWorld(true);

  /**
   * Duplicate bone names are fatal, quietly.
   *
   * Some Mixamo characters (Exo Gray, for one) are assembled from several skinned parts
   * that each carry their own full copy of the skeleton. glTF has no problem storing that,
   * but GLTFLoader must make node names unique, so the copies come back as
   * 'mixamorigHips_1', '_2' and so on. Clip tracks only name 'mixamorigHips', so exactly
   * one copy animates and every other part of the character stands frozen in bind pose.
   * Better to refuse the asset than ship a character that T-poses from the waist up.
   *
   * Not every duplicate is a copy of the skeleton, though. When two meshes of one character
   * share a bone, FBXLoader gives the second mesh its own bone of the same name, parented to
   * the first at the identity transform, so it moves with it exactly (measured in a live match:
   * 0 mm apart while animating). Those nested twins are harmless; only a detached duplicate,
   * one that is not the child of its namesake, means a second skeleton.
   */
  const boneNames = [];
  const detached = [];
  root.traverse((o) => {
    if (!o.isBone) return;
    if (boneNames.includes(o.name)) {
      const nested = o.parent?.name === o.name && o.position.lengthSq() < 1e-10
        && Math.abs(Math.abs(o.quaternion.w) - 1) < 1e-6;
      if (!nested) detached.push(o.name);
    }
    boneNames.push(o.name);
  });
  const duplicateBones = detached.length;
  const duplicateNames = [...new Set(detached)];
  const nestedTwins = boneNames.length - new Set(boneNames).size - detached.length;

  const textures = collectTextures(root);
  const stillPending = await awaitTextureImages(textures, 60000);
  const geometry = optimiseGeometry(root);

  const report = { meshes: 0, triangles: 0, textures: [], pending: stillPending, geometry,
                   renamedBones: renamed, rawHeight, targetHeight: TARGET_HEIGHT,
                   bones: boneNames.length, duplicateBones, duplicateNames, nestedTwins };
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    report.meshes++;
    const pos = o.geometry?.attributes?.position;
    if (pos) report.triangles += (o.geometry.index ? o.geometry.index.count : pos.count) / 3;
  });

  for (const [tex, slot] of textures) {
    // JPEG for colour, PNG for normals: JPEG chroma subsampling puts visible blocking
    // into surface normals, which reads as dirty shading across the whole model.
    tex.userData.mimeType = slot === 'normalMap' ? 'image/png' : 'image/jpeg';
    const info = downscale(tex, maxTexture);
    report.textures.push({ slot, ...(info || { missing: true }) });
  }

  const glb = await new GLTFExporter().parseAsync(root, {
    binary: true,
    maxTextureSize: maxTexture,
    onlyVisible: false,        // keep every submesh; visibility is a runtime concern
    animations: [],            // clips come from assets/bots/anim, not from the character
  });
  window.__report = report;
  return new Blob([glb], { type: 'model/gltf-binary' });
};
window.__ready = true;
</script>`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const inputAbs = path.resolve(opts.input);
  const inputDir = path.dirname(inputAbs);
  const inputName = path.basename(inputAbs);
  const outputAbs = path.resolve(opts.output);
  await mkdir(path.dirname(outputAbs), { recursive: true });

  const srcInfo = await stat(inputAbs);
  const { server, port } = await serve(inputDir);
  // A 115 MB FBX with 4K embedded textures blows past Chromium's default heap while it is
  // being decoded to RGBA — the tab dies and the download never fires. Give it room.
  const browser = await chromium.launch({
    args: [
      '--js-flags=--max-old-space-size=8192',
      '--disable-dev-shm-usage',
      '--max-old-space-size=8192',
    ],
  });
  try {
    const page = await browser.newPage();
    page.on('console', (m) => { if (m.type() === 'error') console.error('  [page]', m.text()); });
    page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
    page.on('crash', () => console.error('  [crash] the conversion tab ran out of memory'));
    await page.route('**/convert.html', (route) => route.fulfill({ body: PAGE, contentType: 'text/html' }));
    await page.goto(`http://127.0.0.1:${port}/convert.html`);
    await page.waitForFunction(() => window.__ready, null, { timeout: 60_000 });

    console.log(`converting ${inputName} (${(srcInfo.size / 1e6).toFixed(1)} MB)…`);
    const downloadPromise = page.waitForEvent('download', { timeout: 600_000 });
    await page.evaluate(async ({ url, maxTexture, quality }) => {
      const blob = await window.convert(url, maxTexture);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'out.glb';
      document.body.appendChild(a);
      a.click();
    }, { url: `/input/${encodeURIComponent(inputName)}`, maxTexture: opts.maxTexture });

    const download = await downloadPromise;
    await download.saveAs(outputAbs);
    const report = await page.evaluate(() => window.__report);
    const outInfo = await stat(outputAbs);

    console.log(`  meshes ${report.meshes}, triangles ${Math.round(report.triangles)}`);
    const g = report.geometry;
    console.log(`  vertices ${g.before} -> ${g.after}, draw groups ${g.groupsBefore} -> ${g.groupsAfter}`);
    console.log(`  bones renamed to mixamorig:* ${report.renamedBones}`);
    console.log(`  height ${report.rawHeight.toFixed(2)} source units -> ${report.targetHeight} m`);
    if (!report.renamedBones) console.warn('  WARNING: no mixamorig bones -- clips will not bind');
    console.log(`  bones ${report.bones}, nested twins ${report.nestedTwins} (harmless), detached duplicates ${report.duplicateBones}`);
    if (report.duplicateBones) {
      console.error(`  REJECTED: ${report.duplicateBones} duplicate bone names (${report.duplicateNames.join(', ')}) — this character`);
      console.error('  carries several copies of its skeleton, so only one part would animate.');
      process.exitCode = 1;
    }
    if (report.pending) console.warn(`  WARNING: ${report.pending} texture(s) never decoded`);
    for (const t of report.textures) {
      const size = t.missing ? 'MISSING' : `${t.w}x${t.h}${t.scaled ? ` -> ${t.to}` : ' (kept)'}`;
      console.log(`  texture ${t.slot} ${size}`);
    }
    console.log(`  ${(srcInfo.size / 1e6).toFixed(1)} MB -> ${(outInfo.size / 1e6).toFixed(2)} MB  ${outputAbs}`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
