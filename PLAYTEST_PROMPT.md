# Prompt for Sonnet: playtest OVERRUN end to end, then finish what's missing

Paste everything below the line into a fresh Claude Code session opened in the Overrun repo.

---

You are working on OVERRUN, a browser FPS (three.js, cannon-es, plain ES modules with no build step,
Cloudflare Worker plus Durable Objects for online play). Your job has two parts, in this order:
**(A) playtest the whole game like a player would and write down what is broken, ugly or missing;
(B) fix or build the things that are missing**, smallest-diff first, with tests.

## 0. Setup (do this first, keep it short)

1. `git fetch origin claude/overrun-cosmetics && git checkout claude/overrun-cosmetics && git pull`.
   Work and push only on that branch. Never push anywhere else, never open a PR, never deploy,
   never touch `wrangler.jsonc`, Durable Object migrations, or any Cloudflare credentials.
2. `npm ci` only if `node_modules` is missing. `npx playwright install chromium` only if the browser is missing.
3. Read, in this order: `readme.md`, `HANDOFF.md` (the latest session sections), `TESTING.md`,
   `codexbugs.md`, `claudebugs.md`. They list known bugs; do not re-report ones already fixed, check first.
4. Baseline before you change anything: `npm run lint` (0 errors expected), `npm test`, and a subset of
   `CI=1 TEST_PORT=4290 npx playwright test <spec>` for the areas you touch. Always run e2e with `CI=1`.
   Note: `match-modes.spec.mjs` Gun Game and Hardpoint tests already fail on this branch (the map-card click times
   out in `startMatch`). Find out why, it is probably a test-helper problem for modes that fix the map, and fix it.
5. Test helpers: `tests/e2e/helpers/game.mjs` (`bootGame`, `startMatch`, `pumpFrames`, `watchRuntimeErrors`) and a
   manual `__testClock`. `startMatch` parks every bot's `fireCd` at Infinity so bots do not shoot; set it to 0 in
   a test if you need a bot to fire. `startMatch` can only be called once per page.

## 1. Part A: playtest

You cannot hold a mouse, so playtest with Playwright scripts (put throwaway ones in the scratchpad or
`tests/e2e/zz-*.spec.mjs`, and delete them afterwards) that drive the real game, take screenshots, and read
state through `globalThis.__game`. **Look at the screenshots yourself** (use the Read tool on the PNGs). Judge
them as a player: is anything overlapping, clipped, touching a border, unreadable, tiny, off-centre, or ugly
at both 1920x1080 and a small laptop size (1280x720) and a phone-sized viewport (390x844)?

Go through this matrix and record a pass/fail/notes line for each cell:

**Modes** (all of them, solo against bots): Deathmatch, Team Deathmatch, Hardpoint, Survival, Gun Game, 1v1 Duel.
For each: does the match start, play, score, end, show the results/podium, award XP and credits, and return to
the lobby with no console errors? Is the objective readable on the HUD (score to win, timer, zone, wave, gun rung)?

**Maps** (all eight in the lobby): Port, Desert, Snow, Warzone, Metro, Depot, Bastion, Arena. For each: spawns are
finite and not inside geometry, no invisible walls, nothing floating, bots can cross it, no nav node inside a solid,
framerate is not terrible, the minimap matches the layout. Check which maps are allowed per mode.

**Weapons** (every id in `src/sim/weaponData.js` plus frag and smoke): fire, reload, empty-click, swap, ADS/scope,
recoil, crosshair, viewmodel position, sound, muzzle flash, shell/tracer, hit marker, headshot multiplier, kill icon in
the feed, ammo counter, and attachments or skins if present. Flag any gun with a missing sound, missing
viewmodel, wrong icon, or a stat that makes it useless or broken.

**Bots** (recently reworked in `src/bots.js`): each of the four styles (rusher, anchor, skirmisher, flanker) should look
different in a fight. Check they: switch to a sidearm on empty, crouch, turn on whoever shoots them, take cover,
do not get stuck, do not shoot through walls, do not aim at nothing, are beatable on EASY and MEDIUM, and are
genuinely tough on HARD and ELITE. Look for animation glitches when crouching or swapping guns.

**Player movement and feel**: walk, sprint, crouch, slide, jump, mantle low cover, stairs/ramps, fall damage, ladders if any.
Mouse and gamepad and touch control schemes, sensitivity, FOV, ADS sensitivity, view bob, keybind rebinding.

**Death and spectating**: kill cam (zoom, rewind, first-person replay of the killer's screen, damage numbers, skip),
respawn, spawn protection, death screen.

**HUD**: health/armor, ammo, minimap, kill feed, scoreboard (Tab), damage indicators, hit markers, streak counter,
medal toasts, objective prompts, pause menu, settings (every tab and every setting actually does something,
look for settings that are saved but unused).

**Meta**: lobby (every tab), accounts/login/signup/logout/persistence, career XP and ranks, credits economy,
shop, crates and the crate-opening reveal, locker and gun preview, gun skins, operator skins, emotes, friends and
party drawer, chat, player card, rewards/unlocks, loading screen, sounds and music, service worker offline start.

**Online** (`server/`, `src/net/`, see `MULTIPLAYER.md`): run `npm run test:mp` and the multiplayer specs. Compare against
solo: do online bots have the same behaviours as solo bots? Does the online kill cam match the solo first-person kill cam?
Is every solo mode available online? Is there reconnect handling, ping display, and sensible behaviour on packet loss?

## 2. Part B: improve what is missing

Triage everything from Part A into three buckets and write them to `PLAYTEST_REPORT.md` in the repo root
(commit it) before you start fixing:

1. **Bugs** (broken behaviour, console errors, stuck states, visual overlap).
2. **Missing features** (something the game implies it has but does not, or that players of a shooter expect).
3. **Polish** (feel, sound, animation, readability).

Rank each item by player impact and effort. Then work down the list, highest impact for lowest effort first.
Candidates I already suspect (verify each before building, some may exist):

- Online bots lack the new human behaviours (sidearm swaps, crouching, hurt reactions, personalities) that solo
  bots have, and the online kill cam is not the killer's-eye first-person replay yet.
- Operator skins are heavy and look alike; gun models are low detail; the tab spacing and border-touching text audit
  across all screens is unfinished.
- Settings that are stored but not wired up (`viewBob`, FOV mismatch, ADS sensitivity for non-sniper scopes),
  and the P0/P1 entries still open in `codexbugs.md` (pause not pausing the sim, grenade team damage in TDM,
  stand-up clearance check when crouched, crouch hitbox, rotated props colliding as axis-aligned boxes).
- Anything a modern arena shooter has that this one lacks: a proper pause that really freezes the sim, damage
  direction indicators, ping/FPS counter option, hit sounds that differ for head/body/kill, footstep sounds by surface,
  bullet impacts and decals per material, weapon inspect, quick-melee, sprint-out animation, low-health warning,
  end-of-match stats screen, accessibility options (colour-blind crosshair/teams, reduce motion, subtitles for
  audio cues), mobile layout.

For every change:

- Keep the diff minimal and match the surrounding code's style and comment density. No refactors for their own sake.
- Add or update a Playwright or unit test that would have caught it. Do not skip, loosen, or delete existing tests to
  get green. Never commit `node_modules` or `test-results/`.
- Run `npm run lint`, `npm test`, and the relevant `CI=1` e2e specs before each commit. Before the final push run the
  whole e2e suite once and report the result honestly, including any tests that fail for reasons not caused by you.
- Bump the `CACHE` name in `sw.js` (currently `overrun-v82`) whenever a precached file changes.
- Online bots in `server/bots.js` and the wire protocol are shared with the live server. Do not change message
  formats or Durable Object classes/migrations without telling me first. Ask before doing anything outward-facing.
- Commit in small logical commits to `claude/overrun-cosmetics` and push after each green batch. Commit messages end with:

```
Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: <your session url if you have one>
```

## 3. When you finish

Reply with:

1. A table of the matrix from Part A (pass/fail per cell, one line of notes for failures).
2. What you fixed or built (one line each, with commit hashes), what you deliberately left, and why.
3. Anything you could not verify without a real human at a real keyboard (feel, audio, how things look in motion),
   so I can check it by hand.
4. Test status: lint, unit, e2e totals, and any failures that existed before you started.
5. The final commit hash on `claude/overrun-cosmetics`, so I can deploy it.

Do not claim something works unless you ran it and looked at the result.
