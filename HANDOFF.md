# HANDOFF — read this first

Say **"read HANDOFF.md"** to pick this up in a new session.

Session 1 (2026-09-27) reworked bot AI, game modes, gunplay, physics, the map roster and the
character/animation pipeline. Session 2 (2026-09-28) was laptop work: frame rate, battery, and
the two bugs a real playtest turned up.

---

## Where things stand

| | |
|---|---|
| Branch | `claude/game-improvements-ai-modes-9f6246` |
| Worktree | `C:\Users\dimah\shooting-game\.claude\worktrees\game-improvements-ai-modes-9f6246` |
| Pushed? | **No.** Nothing has been pushed and no PR exists. |
| Tests | 38 passed + 1 flaky of 39 Playwright (exit 0), 16/16 unit, lint 0 errors (16 warnings, all pre-existing) |

```bash
npm ci && npx playwright install chromium
npm run lint && npm test && CI=1 npm run test:e2e
```

**One test is flaky as of 2026-09-28:** `duel.spec.mjs:12 Duel starts one elite bot on a
mirrored loadout` failed its first attempt and passed on retry, and the reason was not
captured. The session-2 changes alter frame cadence (a 60 fps cap, 15 fps menus), so treat
it as suspect rather than as noise: run that spec a few times and look at why.

**Always run e2e with `CI=1`.** The Playwright config sets `reuseExistingServer: !CI`, and
there are other checkouts of this repo on this machine — without `CI=1` a stale server on
`:4173` can serve a different tree and give a false green.

---

## Session 2: what the playtest found

You reported: *the AI moves weird, the animation does not match the actual movement, and they
lag like they move at 2 fps*. That turned out to be one bug, plus a second one underneath it.

**1. The loop threw simulation time away below 30 fps.** `CONFIG.MAX_SUBSTEPS` was 4, covering
33.3 ms — exactly one frame at 30 fps, so no headroom at all, and below that the accumulator
guard discarded the remainder every single frame. Measured in the real game, loaded down to
10 fps: the simulation ran at **0.32x real time**. That is the "2 fps". It is also half of the
animation complaint, because a bot's legs are paced off its *velocity* while its body was only
covering a third of that per second, so the feet skated. Now 16 substeps (133 ms, real time
down to 7.5 fps). One fixed step measures 0.407 ms, so the worst case is 6.5 ms of catch-up on
a frame already over 130 ms long, and the frame rate was identical at 4, 8 and 16 substeps —
which is the evidence that this cannot spiral.

**2. Locomotion clips were paced by total speed, not by direction.** A bot closing while
side-stepping travels ~5.2 m/s in total but only ~3.5 m/s sideways, and feeding the total to a
strafe clip authored for 1.6 m/s asks for 3.2x, which hit the old 1.8 ceiling. Measured across
a live match: **30% of all moving frames were pinned to that clamp**, meaning legs covering 56%
of the ground the body did. Each clip is now paced by the component of travel it is responsible
for, the ceiling is 2.6, and the walk/run crossfade was re-centred on the two clips' real
speeds. Re-measured after the fix: **1.5%**.

**Still open, and you will see it in any close-up:** the green team kit — chest band and
shoulder pads — is parented to the mesh group rather than to bones, and was sized for the old
blocky humanoid. On the rigged characters it reads as large green blocks that do not move with
the body at all. Fix: parent it to `Spine2` and the shoulder bones in `buildSoldierMesh`
(`src/bots.js`) and scale it to the character. This is the next thing I would do.

## Carried over from session 1, still true

1. **Very little has been playtested by hand.** Session 2 playtested the bots specifically. How
   the rest *feels* — the elite bot, the new TTK — is still unverified.

2. **AR damage went 18 → 26, pistol 12 → 15.** Bots use the same weapon table as the player,
   so this made every bot at every difficulty in every mode roughly 45% deadlier — that was
   not the stated intent of the gunplay change, it is a side effect. If the game feels
   punishing, revert this first: `src/weapons.js`, `WEAPONS[].damage`.

3. **The e2e harness cannot tell you the game looks right.** Every test reroutes the CDN and
   stubs the Poly Haven textures with a 1×1 image, so every scene looks wrong in the same
   way. Foundry shipped as a literally black screen and the whole suite stayed green. Visual
   checks must go through the real page (see below).

---

## What was built — session 2 (laptop and battery)

All of it is in the settings panel, under a new **LAPTOP & BATTERY** group and in CONTROLS.

- **Frame cap** (`settings.frameCap`, default 60), gate in the new `src/perf.js`. It advances
  its timestamp by the budget instead of snapping to now, which is what makes a 60 cap actually
  land on 60 on a 144 Hz or 75 Hz panel rather than 48 or 37.5.
- **Menus render at 15 fps.** Nothing behind the pause and settings overlays updates, so drawing
  it at panel rate was pure battery.
- **One shadow pass per frame instead of three.** `shadowMap.autoUpdate` is off and
  `needsUpdate` is set once, just before the world pass. The minimap renders the same scene
  through a layer mask, so it had been paying for a full second shadow pass every frame to draw
  a floor plan with no shadows in it. Battery saver halves the refresh again.
- **`antialias` now comes from the quality preset.** It was hardcoded `true`, so
  `QUALITY.low.antialias: false` had never done anything at all. Battery saver also asks for the
  integrated GPU. Both are fixed at context creation, so both apply on reload; the panel says so.
- **Adaptive resolution** (default on). Steps down when frames run late, then *verifies its own
  step*: if the next window is not 6% faster it puts the pixels back and stops. Without that
  check it walked to the 0.6 floor on a CPU-bound machine and bought nothing — measured, in the
  real game, before the check existed.
- **Fire rate no longer depends on frame rate.** The cooldown carries its overshoot past zero
  into the next shot. Without it a 30 fps cap rounds the AR's 0.09 s cooldown up to 0.1 and the
  player loses a tenth of their rate of fire to a graphics setting, while bots — which fire on
  the fixed clock — keep all of theirs.
- **Trackpad look boost** (off by default), **auto-sprint** (off by default, because sprinting
  is the widest accuracy cone in the game), and **aim assist** (`settings.aimAssist`, default
  0.35). Assist is friction-only up to 0.5: it slows the crosshair while it is over a visible
  enemy so you stop on target instead of overshooting, and never moves your aim. Above 0.5 it
  also pulls, gently. Visibility is a real line-of-sight and smoke test, deliberately not
  `bot.spotted`, which marks anything within 30 m as seen whether or not a wall is in the way.

**Not finished:** there is no e2e spec for any of the session-2 input work. `src/perf.js` has 13
unit tests, and the substep fix has a regression pair in `tests/unit/render-rate.test.mjs` (one
test pins the shipped constant, the other states what the old value did, so the first cannot
pass vacuously). But aim assist, trackpad boost and auto-sprint have only been read and reasoned
about, never executed by a test. Write that spec first.

## What was built — session 1

- **1v1 Duel** — round-based, one life each, first to `CONFIG.DUEL_ROUNDS` (7), mirrored
  spawns, mirrored loadout, always the ELITE tier. `src/match.js`.
- **ELITE bot** — per-tier aim profiles in `src/bots.js`. Measured at 20 m against a
  stationary target: hard 0.72 hit / 0.02 headshot, elite 1.00 / 0.75, elite-while-strafing
  0.03. That last number is the counter-play and `tests/e2e/duel.spec.mjs` asserts it holds.
- **AI movement** — acceleration-limited locomotion, counter-strafing, cover peeking instead
  of a magic heal, string-pulled paths, pre-aimed angles.
- **Gunplay** — additive accuracy cone (rest / move / air / spray bloom), deterministic
  recoil patterns, crosshair that tracks the live cone.
- **FOUNDRY** — mirrored three-lane map with a contested raised mid.
- **Grenades** — inherit thrower velocity, tumble, roll to a stop; underhand lob on RMB.
- **Characters** — Swat Guy, Crypto, Ely and the original soldier, split by team.
- **Animation** — eight Mixamo clips, directional blending, spine-driven aiming, authored
  death, weapon carried in the hand bone.

Branch triage: only `codex/phase2-modularization` had anything to merge (it splits the old
5,822-line `game.js` into `src/` modules and adds an ESLint `no-undef` gate). Everything else
was already contained in it or zero commits ahead. **Nothing was deleted.**

---

## Open items

- [ ] **Decide what to do with the branch** — push, open a PR, or keep local. Waiting on you.
- [ ] **Bones for the team kit.** See session 2 above — the green blocks on every bot.
- [ ] **An e2e spec for aim assist, trackpad boost and auto-sprint.** None of them are executed
      by any test yet.
- [ ] **Playtest.** Especially the elite bot's difficulty and the new TTK.
- [ ] **Blender MCP is not connected.** The addon's socket is listening on `localhost:9876`,
      but Claude Code has no bridge to it, so there are no Blender tools. To fix, run this
      and start a new session: `claude mcp add blender -- uvx blender-mcp`
- [ ] **More animation, if wanted.** Hit reactions were discussed but not added — the bot has
      no hit-reaction hook yet, so it needs code as well as a clip.
- [ ] **Clean up ~170 MB of source FBX in `C:\Users\dimah\Downloads`** (`Ch15_nonPBR`,
      `Ch45_nonPBR`, `Exo Gray`, `Ely By K.Atienza`, and the eight clip files). Safe to
      delete; the converted assets are committed in the repo.

---

## Gotchas discovered the hard way

Each of these cost real time. They are written down so they cost nothing next time.

**Mixamo bone names are spelled four different ways.** Mixamo writes `mixamorig:Hips`;
three's `FBXLoader` drops the colon; three's `GLTFLoader` runs names through
`sanitizeNodeName` and also drops it; and characters re-rigged through Mixamo come back as
`mixamorig1Hips`. So the GLB *on disk* says one thing and the same file *loaded in the
browser* says another. Retargeting is now done against the live skeleton
(`retargetClips` in `src/bots.js`), never against an assumed spelling. An earlier attempt
validated against the file rather than the loaded scene and "fixed" the names backwards.

**Animation failures are silent.** `AnimationMixer` binds the tracks it can resolve and
ignores the rest, so a completely broken retarget looks identical to a working one until you
watch a bot stand frozen in its T-pose. `tests/e2e/characters.spec.mjs` asserts that *every*
track of *every* clip binds for *every* character. Keep that.

**A measurement harness must validate its own fixture.** The first bot-accuracy test reported
a 98% hit rate for every difficulty tier. It was measuring nothing: `player.pos` is only
refreshed inside `stepPlayer`, so the bot aimed at a stale origin, and the firing lane ran
through that origin so stray rounds swept the target anyway. `duel.spec.mjs` now steps
physics once before aiming, faces the bot so the muzzle is on the lane, checks line of sight
from the real muzzle, and rejects lane endpoints that resolve inside geometry.

**A regression test that passes on the bug is worse than none.** The Foundry ramp test
originally asserted "peak height > 1.3 m", which passed with the ramp mouth completely walled
off, because the ramp already reaches 1.37 m before it meets the wall. Always re-break the
bug and confirm the test goes red.

**Sealed maps need their own interior lights.** The warehouse is only lit because
`buildArena()` calls `buildLights()`. Foundry has a roof at y=8, so the sun does nothing
indoors and ambient alone is black. Any new map needs a `build*Lights()`.

**The in-app browser pane does not run requestAnimationFrame.** It reports
`document.visibilityState === 'visible'` and it paints when you take a screenshot, but rAF
never fires on its own, so the game loop sits frozen at one frame and every measurement reads
zero. To playtest through it, replace `requestAnimationFrame` with a `setTimeout(cb, 16)` shim
*and* take one screenshot to force the pending native callback to fire — the loop then
re-registers through the shim and runs. Everything measured in session 2 was measured that way.
Note that the shim pins every frame to >=16 ms, so it looks CPU-bound to the adaptive scaler;
that is an artefact of the harness, not of the game.

**To load the game in the pane at all**, `.claude/launch.json` now has an `overrun` entry, so
`preview_start` with name `overrun` serves it on :4173. Stop that server before running e2e or
Playwright cannot bind the port.

**Bump `CACHE` in `sw.js` whenever assets change.** It is at `overrun-v12`. The fetch handler
matches by extension: `.fbx` and `.json` had to be added to `ASSET_RE` or the precached clips
and manifest were never actually served offline.

---

## Asset pipeline

Both documented in `readme.md`, summarised here.

**Add a character:** download from Mixamo as FBX (T-pose), then

```bash
node scripts/fbx-to-glb.mjs "<input.fbx>" assets/bots/<name>.glb --max-texture=512
```

It normalises height to 1.832 m, restores `mixamorig:` names, indexes the geometry, merges
draw groups and re-encodes textures — typically 115 MB → under 4 MB. It **rejects**
characters whose parts each carry their own copy of the skeleton (Exo Gray: 896 bones, 784
duplicates), because only one part of those would animate. Then add the file to `CHARACTERS`
in `src/bots.js`.

**Add an animation:** download as FBX **Without Skin**, with **In Place** ticked for anything
locomotive (bots are physics-driven, so root motion makes them slide). Drop it in
`assets/bots/anim/` and name it in `manifest.json`.

---

## Running the real game

```bash
node scripts/serve-tests.mjs
```

Then open `http://localhost:4173`. `window.__game` is exposed on localhost only and is the
fastest way to drive a scenario — e.g. `__game.startMatch('duel','medium','PLAYER','foundry')`.
Pointer lock fails inside an embedded preview pane; that error is the pane, not the game.
