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
const CACHE = 'overrun-v70';
const PRECACHE = [
  './',
  './index.html', './game.js', './ui-overhaul.css',
  './src/audio.js', './src/bots.js', './src/config.js', './src/effects.js', './src/gunicons.js', './src/gunmodels.js', './src/gunskins.js', './src/gunTextures.js', './src/crateDrop.js', './src/crateModel.js', './src/store.js', './assets/models/crate/supply-crate.glb', './assets/textures/crate/panel.jpg', './assets/textures/crate/bump.jpg', './assets/textures/crate/end.jpg', './assets/textures/crate/endbump.jpg', './assets/textures/guns/carbon.jpg', './assets/textures/guns/brushed.jpg', './assets/textures/guns/speckle.jpg', './assets/textures/guns/camo_wood.jpg', './assets/textures/guns/camo_desert.jpg', './assets/textures/guns/camo_urban.jpg', './assets/textures/guns/rust.jpg', './assets/textures/guns/scales.jpg', './assets/textures/guns/leather.jpg', './assets/textures/guns/magma.jpg', './assets/textures/guns/marble.jpg', './assets/textures/guns/hex.jpg', './assets/textures/guns/circuit.jpg', './assets/textures/guns/hazard.jpg', './assets/textures/guns/facets.jpg', './assets/textures/guns/damascus.jpg', './assets/textures/guns/swirl.jpg', './src/hardpoint.js', './src/friends.js', './src/hitflash.js', './src/hud.js',
  './src/keybinds.js', './src/killicons.js', './src/main.js', './src/mapArena.js', './src/mapBastion.js','./src/mapDepot.js','./src/mapDesert.js', './src/mapGlb.js', './src/mapMetro.js', './src/mapPort.js', './src/mapSnow.js', './src/mapWarzone.js', './src/maps.js', './src/match.js', './src/perf.js', './src/physics.js', './src/skins.js',
  './src/pickups.js', './src/loading.js', './src/loadout.js', './src/locker.js', './src/minimap.js', './src/emotes.js', './src/emoteMusic.js', './src/itemModels.js', './src/healAnim.js', './src/healProp.js',
  './src/profile.js', './src/playercard.js', './src/lobby.js', './src/lobbyBackdrop.js', './src/operators.js', './src/killcam.js', './src/rewards.js', './src/shop.js', './src/account.js', './src/career.js', './src/online.js',
  './src/player.js', './src/projectiles.js', './src/rendering.js', './src/settings.js',
  './src/typeAtlas.js', './src/ui.js', './src/utils.js', './src/weapons.js',
  // Shared with the multiplayer server (tests/unit/sw-precache.test.mjs keeps this list whole).
  './src/net/chat.js', './src/net/client.js', './src/net/flags.js', './src/net/lobby.js', './src/net/netQuality.js', './src/net/predict.js', './src/net/stage.js', './src/net/zone.js',
  './src/sim/colliders.js', './src/sim/combat.js', './src/sim/gridBroadphase.js', './src/sim/hitmath.js', './src/sim/killinfo.js', './src/sim/mapData.js', './src/sim/modes.js',
  './src/sim/items.js', './src/sim/movement.js', './src/sim/protocol.js', './src/sim/tick.js', './src/sim/weaponData.js', './src/sim/world.js',
  './assets/bots/anim/manifest.json',
  // Characters and their clips are cache-first assets; listing them here means the
  // first offline load has a full roster rather than falling back to blocky humanoids.
  './assets/bots/soldier.glb', './assets/bots/swat.glb', './assets/bots/trooper.glb',
  './assets/bots/gasmask.glb', './assets/bots/crypto.glb', './assets/bots/ely.glb',
  './assets/bots/steve.glb',
  // The healing items, ammo chest and first-person gloves (small; the game has stand-ins if they are late).
  './assets/items/bandage.glb', './assets/items/medkit.glb', './assets/items/mini.glb', './assets/items/big.glb', './assets/items/chest.glb', './assets/items/hands.glb',
  // The default map: without these an offline boot has nothing to play on.
  './assets/maps/port.glb', './assets/maps/port.json',
  './assets/maps/thumbs/port.jpg', './assets/maps/thumbs/desert.jpg', './assets/maps/thumbs/snow.jpg', './assets/maps/thumbs/warzone.jpg', './assets/maps/thumbs/depot.jpg', './assets/maps/thumbs/bastion.jpg', './assets/maps/thumbs/arena.jpg', './assets/maps/thumbs/metro.jpg',
];

// .fbx is here because the bot animation clips are FBX; without it the fetch handler fell
// through and never served them from the cache, so an offline load had no animation at all
// despite them being precached. .json covers the animation manifest, which is data rather
// than code and must not be network-first. WebSockets (/ws) never reach a service worker, and
// /stats matches neither pattern, so neither is ever cached.
const ASSET_RE = /\.(glb|gltf|fbx|bin|jpg|jpeg|png|webp|ktx2|hdr|json)(\?|$)/i;
const CODE_RE = /\.(js|mjs|css|html)(\?|$)/i;
// Map collider tables are data the multiplayer server must agree with byte for byte (the map
// hash), so they are network-first like code: "refresh to update" has to actually update.
const MAP_DATA_RE = /\/assets\/maps\/[^/]+\.json(\?|$)/i;

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

  if (req.mode === 'navigate' || CODE_RE.test(url.pathname) || MAP_DATA_RE.test(url.pathname)) {
    e.respondWith(networkFirst(req));
  } else if (ASSET_RE.test(url.pathname)) {
    e.respondWith(cacheFirst(req));
  }
});
