import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The service worker's PRECACHE is a hand-kept list. A module missing from it still loads
 * online (code is network-first) but breaks the offline boot, so: every list entry must exist,
 * and every module under src/ must be listed.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
const list = [...sw.slice(sw.indexOf('const PRECACHE'), sw.indexOf('];', sw.indexOf('const PRECACHE'))).matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

test('every PRECACHE entry exists', () => {
  for (const p of list) {
    if (p === '') continue;
    assert.ok(existsSync(join(ROOT, p)), `sw.js precaches a missing file: ${p}`);
  }
});

test('every module under src/ is precached', () => {
  const mods = walk(join(ROOT, 'src')).filter((f) => f.endsWith('.js')).map((f) => relative(ROOT, f).split(sep).join('/'));
  for (const m of mods) assert.ok(list.includes(m), `sw.js PRECACHE is missing ${m}`);
});
