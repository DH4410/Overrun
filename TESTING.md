# OVERRUN test harness

The Phase 1 harness keeps production build-free. Node.js and Playwright are development-only;
the game still boots as plain HTML and ES modules.

## Install and run

```bash
npm ci
npx playwright install chromium
npm test
npm run test:e2e
```

`npm run test:ci` runs the unit suite followed by all browser smoke tests. Playwright starts the
local static server automatically on `127.0.0.1:4173`.

The browser helper intercepts the exact Three.js and cannon-es CDN URLs from `index.html` and
serves the matching locked npm packages. This removes external CDN availability from the smoke
tests without changing production imports. Optional Poly Haven textures receive a tiny local
image so the procedural/fallback boot path stays deterministic.

## Coverage

Baseline browser coverage currently verifies:

- boot reaches `DEPLOY` without page or console errors;
- Warehouse and Dungeon create finite spawn points and navigation nodes;
- Warehouse Deathmatch starts and supports movement, firing, reload, and weapon switching;
- a dead Deathmatch bot respawns through the split `simStep()` / `renderStep()` API;
- Deathmatch HUD and time-limit results agree on the canonical `dmLeader()` outcome;
- Survival advances from wave one to wave two;
- Duel starts one ELITE bot on a mirrored loadout and ends at `CONFIG.DUEL_ROUNDS`;
- Foundry is symmetric under a 180-degree rotation (~5800 mirrored line-of-sight pairs);
- every animation track of every clip binds to every roster character's skeleton;
- the player's firing cone widens with movement, air time and spray, and recovers;
- thrown grenades inherit the thrower's velocity and come to rest.

Several of these guard failures that are otherwise **silent**. A clip whose track names do
not match the skeleton is not an error — AnimationMixer binds what it can and ignores the
rest — so a fully broken retarget looks exactly like a working one until you watch a bot
stand frozen in its T-pose. Likewise, an un-mirrored crate on Foundry quietly hands one
spawn a better angle and nothing else would notice.

Measurement specs (`duel.spec.mjs`) validate their own fixture before trusting it: they step
physics once so `player.pos` is live, face the bot so the muzzle is on the firing lane, check
line of sight from the real muzzle, and reject lane endpoints that resolve inside geometry.
Each of those was a false positive first — without them the harness reported a 98% hit rate
for every difficulty tier, from bullets that merely swept past a stale origin.

`tests/e2e/known-regressions.spec.mjs` executes the integrated P0 regressions as ordinary,
permanent assertions:

- CORE-01: pointer-lock pause freezes match time;
- CORE-01: in-match settings freeze match time;
- CORE-02: player travel stays within 5% at 60 and 30 render Hz;
- CORE-03: a TDM frag damages the enemy but not an allied bot, and awards only the enemy score;
- CORE-04: standing remains blocked under a low ceiling.

The pause and settings cases observe the public UI behavior of the module-private
`APP_STATE`/`appState` pair. The harness has no `test.fail(...)` markers; a regression fails the
suite directly.

## Render-rate verification

`tests/support/render-rate.mjs` provides deterministic frame schedules and mirrors the current
four-substep fixed-step accumulator. It separates render-frame callbacks from fixed-physics
callbacks and reports simulated, dropped, and remainder time. The 10-second 120/60/30 Hz
schedules can compare at least:

- player travel distance;
- bot cooldown elapsed;
- projectile distance;
- match time.

The unit test requires a 10-second 30 Hz schedule to advance all 1,200 fixed-physics steps. The
browser regression also requires player travel at 30 and 60 render Hz to remain within 5%.

## Manual checks still required

Automation does not replace the Phase 1 Warehouse and Dungeon playtest. Before integration,
manually verify pointer-lock pause/resume, settings close and lock reacquisition, keyboard/mouse
and controller input, firing/reload/scoreboard behavior, both map modes, and the browser console
for unexpected errors or asset 404s.
