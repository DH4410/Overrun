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
- a dead Deathmatch bot respawns;
- Survival advances from wave one to wave two.

`tests/e2e/known-regressions.spec.mjs` also executes the current P0 regressions as Playwright
expected failures:

- CORE-01: pointer-lock pause freezes match time;
- CORE-01: in-match settings freeze match time;
- CORE-02: player travel stays within 5% at 60 and 30 render Hz;
- CORE-03: a TDM frag damages the enemy but not an allied bot, and awards only the enemy score;
- CORE-04: standing remains blocked under a low ceiling.

An expected failure counts as a passing test while the known bug is present. If the assertion
starts passing after the Claude correctness branch is integrated, Playwright reports
`Expected to fail, but passed`; remove the corresponding `test.fail(...)` annotation and keep the
assertion as the permanent regression test.

## Render-rate verification

`tests/support/render-rate.mjs` provides deterministic frame schedules and mirrors the current
fixed-step accumulator. It separates render-frame callbacks from fixed-physics callbacks and
reports simulated, dropped, and remainder time. After CORE-02 integration, use the same 10-second
120/60/30 Hz schedules to compare at least:

- player travel distance;
- bot cooldown elapsed;
- projectile distance;
- match time.

The unit test intentionally records the current three-substep baseline: a 10-second 30 Hz
schedule advances only about 7.5 seconds of fixed physics. That measurement validates the helper;
the live expected-failure spec defines the desired cross-rate behavior.

## Manual checks still required

Automation does not replace the Phase 1 Warehouse and Dungeon playtest. Before integration,
manually verify pointer-lock pause/resume, settings close and lock reacquisition, keyboard/mouse
and controller input, firing/reload/scoreboard behavior, both map modes, and the browser console
for unexpected errors or asset 404s.
