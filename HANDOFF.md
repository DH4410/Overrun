# HANDOFF — read this first

Say **"read HANDOFF.md"** to pick this up in a new session.

Written 2026-09-27 at the end of a session that reworked bot AI, game modes, gunplay,
physics, the map roster and the character/animation pipeline.

---

## Where things stand

| | |
|---|---|
| Branch | `claude/game-improvements-ai-modes-9f6246` |
| Worktree | `C:\Users\dimah\shooting-game\.claude\worktrees\game-improvements-ai-modes-9f6246` |
| Commits ahead of `origin/master` | 40 |
| Pushed? | **No.** Nothing has been pushed and no PR exists. |
| Working tree | Clean |
| Tests | 39/39 Playwright, 3/3 unit, lint 0 errors (16 warnings, all pre-existing unused-export noise) |

```bash
npm ci && npx playwright install chromium
npm run lint && npm test && CI=1 npm run test:e2e
```

**Always run e2e with `CI=1`.** The Playwright config sets `reuseExistingServer: !CI`, and
there are other checkouts of this repo on this machine — without `CI=1` a stale server on
`:4173` can serve a different tree and give a false green.

---

## The three things most worth your attention

1. **Nothing has been playtested by hand.** Everything was verified by automated test and by
   loading the real page in a browser. How it *feels* is unverified.

2. **AR damage went 18 → 26, pistol 12 → 15.** Bots use the same weapon table as the player,
   so this made every bot at every difficulty in every mode roughly 45% deadlier — that was
   not the stated intent of the gunplay change, it is a side effect. If the game feels
   punishing, revert this first: `src/weapons.js`, `WEAPONS[].damage`.

3. **The e2e harness cannot tell you the game looks right.** Every test reroutes the CDN and
   stubs the Poly Haven textures with a 1×1 image, so every scene looks wrong in the same
   way. Foundry shipped as a literally black screen and the whole suite stayed green. Visual
   checks must go through the real page (see below).

---

## What was built

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

**Bump `CACHE` in `sw.js` whenever assets change.** It is at `overrun-v11`. The fetch handler
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
