/**
 * Offline cache for OVERRUN.
 *
 * Two strategies, deliberately split:
 *
 *  - Code (.js, .html, and the navigation request itself) is NETWORK-FIRST. A cache-first
 *    service worker over your own source is a debugging trap: after one visit the browser
 *    stops fetching game.js entirely and every subsequent edit looks like it silently failed.
 *    We go to the network, fall back to the cache only when offline.
 *
 *  - Assets (.glb, .gltf, .bin, images) are CACHE-FIRST. They are large, immutable in
 *    practice, and they are what actually makes a cold load slow.
 */
const CACHE = 'overrun-v15';
const PRECACHE = [
  './',
  './index.html', './game.js', './ui-overhaul.css',
  './src/audio.js', './src/bots.js', './src/config.js', './src/effects.js', './src/gunmodels.js', './src/hud.js',
  './src/main.js', './src/mapPort.js', './src/maps.js', './src/match.js', './src/perf.js', './src/physics.js',
  './src/pickups.js', './src/loadout.js', './src/locker.js',
  './src/player.js', './src/projectiles.js', './src/rendering.js', './src/settings.js',
  './src/ui.js', './src/utils.js', './src/weapons.js',
  './assets/bots/anim/manifest.json',
  // Characters and their clips are cache-first assets; listing them here means the
  // first offline load has a full roster rather than falling back to blocky humanoids.
  './assets/bots/soldier.glb', './assets/bots/swat.glb', './assets/bots/trooper.glb',
  './assets/bots/gasmask.glb', './assets/bots/crypto.glb', './assets/bots/ely.glb',
  './assets/bots/steve.glb',
  // The default map: without these an offline boot falls back to the warehouse.
  './assets/maps/port.glb', './assets/maps/port.json',
];

// .fbx is here because the bot animation clips are FBX; without it the fetch handler fell
// through and never served them from the cache, so an offline load had no animation at all
// despite them being precached. .json covers the animation manifest, which is data rather
// than code and must not be network-first.
const ASSET_RE = /\.(glb|gltf|fbx|bin|jpg|jpeg|png|webp|ktx2|hdr|json)(\?|$)/i;
const CODE_RE = /\.(js|mjs|css|html)(\?|$)/i;

self.addEventListener('install', (e) => {
  // Precache is best-effort: one 404 must not abort the whole install.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(PRECACHE.map((u) => c.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(req) {
  try {
    const resp = await fetch(req);
    if (resp && resp.ok) {
      const clone = resp.clone();
      caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {});
    }
    return resp;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    throw new Error('offline and not cached');
  }
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const resp = await fetch(req);
  if (resp && resp.ok) {
    const clone = resp.clone();
    caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {});
  }
  return resp;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only ever handle same-origin traffic. The CDN import map and the Poly Haven textures are
  // cross-origin and opaque; caching them here buys nothing and can poison the cache.
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate' || CODE_RE.test(url.pathname)) {
    e.respondWith(networkFirst(req));
  } else if (ASSET_RE.test(url.pathname)) {
    e.respondWith(cacheFirst(req));
  }
});
