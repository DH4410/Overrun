# HANDOFF — read this first

Say **"read HANDOFF.md"** to pick this up in a new session.

Session 1 (2026-09-27) reworked bot AI, game modes, gunplay, physics, the map roster and the
character/animation pipeline. Session 2 (2026-09-28) was laptop work: frame rate, battery, and
the two bugs a real playtest turned up. Session 3 (2026-09-28) was a full playtest of every
mode and map, then a code review after you reported movement and animation looking wrong and
dead bots floating — it found the bots were being drawn backwards. Session 4 (2026-09-28)
worked through your ten-point list: bot jitter, animation, weapons, jumping through ramps, stuck
bots, hitboxes and damage feedback, the UI, and movement. Session 5 (2026-09-29) did the last
two: **PORT**, a new default map modelled in Blender, and **three more Mixamo characters**.

---

## Where things stand

| | |
|---|---|
| Branch | `claude/game-improvements-ai-modes-9f6246` |
| Worktree | `C:\Users\dimah\shooting-game\.claude\worktrees\game-improvements-ai-modes-9f6246` |
| Pushed? | **No.** Nothing has been pushed and no PR exists. |
| Tests | 65/65 Playwright, 19/19 unit, lint 0 errors (16 warnings, all pre-existing) |

```bash
npm ci && npx playwright install chromium
npm run lint && npm test && CI=1 npm run test:e2e
```

**The duel spec flaked once in session 2** (`duel.spec.mjs:12`, passed on retry, cause not
captured) and did not recur in any of the four full runs in session 3. Still worth a look if
it comes back.

**Always run e2e with `CI=1`.** The Playwright config sets `reuseExistingServer: !CI`, and
there are other checkouts of this repo on this machine — without `CI=1` a stale server on
`:4173` can serve a different tree and give a false green.

---

## Next session — start here

1. **Playtest PORT and the new characters** in a real browser (`node scripts/serve-tests.mjs`,
   then http://localhost:4173, Ctrl+Shift+R once — the cache is now `overrun-v14`). Everything
   visual was checked headless; see "Session 5" for what that did and did not cover.
2. Map tweaks are a script edit and one Blender run away — see "Changing PORT" below.

---

## Session 5: the map, and more characters

**PORT** (`scripts/blender/build_port.py` -> `assets/maps/port.glb` + `port.json`, loaded by
`src/mapPort.js`) is now the map the game boots into and the first one in the menu; the other
three are unchanged. A container port in daylight: a raised concrete dock in the middle with a
ramp up each end, a spawn shed at each end, a container yard with a gantry crane on one flank
and a warehouse with racking on the other, mirrored by 180 degrees for the duel. Beyond the
wall: stacked containers, sheds, a quay, a ship and ship-to-shore cranes (visual only).

- **Built for movement.** Crates are 1.0 m (a hop), the dock is 1.4 m (reached by the ramp, or by
  hopping off the crate beside it), containers are 2.59 m (walls). All pinned by
  `tests/e2e/port-map.spec.mjs`, which stands the player against each and jumps.
- **Colliders equal meshes, by construction.** Every piece function in the Blender script emits
  its mesh and its collider together. The spec checks both directions: every collider top shows
  a mesh within 3 cm, and a 2,000-point grid finds no invisible wall and no walk-through prop
  (re-broken by deleting one crate's collider: both checks and the hop test went red).
- **Textures** are Poly Haven, loaded at runtime like the other maps; the GLB (3 MB, 16 draw
  calls, 38k triangles) carries world-scaled UVs only. Containers share one rusty-metal photo
  used as luminance (`pbrMat({ detail: true })`) and take their colour from vertex colours.
- Bots path onto the dock, through the yard and into the warehouse
  (`bot-movement.spec.mjs`); no nav node sits in a solid or on a roof or container.
- `ceilY` is 6.0 (the spawn sheds' roof underside) so spawn and pickup casts start under the
  roofs — the Foundry bug from session 1 would otherwise have put the spawns on the roof.

**Characters.** Added from Mixamo: **Trooper** (Mixamo "Swat", blue camo) and **Gas Mask** to
blue, **Steve** (army fatigues) to red. Blue is now police tactical (SWAT, Trooper, Gas Mask),
red military/mercenary (Crypto, Ely, Steve). The converter used to reject Trooper and Steve for
"duplicate bones": measured in a live match, those are FBXLoader's nested twins (a second bone
of the same name, parented to the first at identity, wherever two meshes share a bone) and move
with it exactly. `scripts/fbx-to-glb.mjs` now rejects only detached duplicates, and
`characters.spec.mjs` plays a clip on every character and checks each twin stays on its bone.
Exo Gray passes the new check too (all 784 duplicates are nested twins) but is left out: 896
bones per bot is a lot of skinning for a laptop.

### Changing PORT

1. Edit `scripts/blender/build_port.py` (layout functions at the bottom: `dock()`, `approach()`,
   `container_yard()`, ...; wrap a piece in `both()` to keep the symmetry).
2. In Blender (Scripting tab, or via the Blender MCP):
   `OVERRUN_REPO = r"<repo>"; exec(open(OVERRUN_REPO + "/scripts/blender/build_port.py").read())`
3. `CI=1 npx playwright test tests/e2e/port-map.spec.mjs`, and bump `CACHE` in `sw.js`.

Spawns, pickups and interior lamps are gameplay, not geometry: they live in `src/mapPort.js`.
Spawn candidates must clear `buildSpawnPoints`' 2 m blocker pad — 14 of the first 18 did not.

---

## Session 4: your ten points

Numbers are measured, before -> after. Each fix has a regression test that was re-broken and
seen to fail on the old code.

1. **"The AI lags and teleports when I aim."** Two causes, both in how bots move.
   - *The animation clips carry root motion* — despite the manifest saying "In Place". The drawn
     hips walked forward 1.7 m per Walk cycle, 2.5 m per Run cycle (every 0.73 s) and 1.2-1.6 m
     per strafe, then snapped back when the clip looped. The physics body already moves the
     bot, so every bot ran ahead of itself and teleported back. Now stripped at load
     (`stripRootMotion` in `src/bots.js`); hips stay within 0.1 m of the body.
   - *Bots vibrated in firefights.* The "blocked" test (speed < 0.6 m/s) fired on every
     deliberate strafe reversal, which triggered the next reversal: 17-26 reversals a second,
     near-stationary 74% of the time -> ~0.5/s and 2-14%. And the separation push compounded
     through the velocity (+1 m/s per step), flinging bunched bots apart; peak 6.9 -> <2 m/s.
   - `tests/e2e/bot-movement.spec.mjs`.
2. **"The animation doesn't match."** Clips are now paced by their real speed, measured from the
   root motion per character — the planted foot used to move at up to 15 m/s while chasing, now
   0.4-0.7 m/s (measurement noise from heel lift). The gun is posed procedurally (shouldered on
   the target when engaging, a ready carry otherwise) and both arms are solved onto it with
   two-bone IK: a bot shoots you with a gun pointing at you, 0-1 degrees off. Fast strafes turn
   the legs into a run while the torso twists back to the target. The floating armbands are gone.
3. **Weapons.** The Kenney toy blasters are replaced by procedural real guns
   (`src/gunmodels.js`): M4-pattern carbine with a red dot, striker pistol, walnut pump shotgun,
   olive bolt-action sniper, gloved hands. Aiming puts each gun's own sight on the screen centre
   with the rest below it (`tests/e2e/viewmodel.spec.mjs`). Bots carry the same models. The
   Kenney blaster GLBs in `assets/models/blaster/` are now unused.
5. **"Under a ramp I can jump through it."** The player was one sphere at the feet with the
   camera 1.6 m above; nothing collided above ~1 m. The player now has narrow upper spheres to
   the top of the head (narrower than the feet, so they never snag a ledge), and ramps are solid
   wedges. Camera under a 2.7 m slab: reached 3.24 m -> stops at 2.65 m.
6. **"Bots get stuck running into walls."** Navigation rebuilt: nodes on every walkable surface
   (found by raycasting), edges only where a body-wide sweep clears, A*, reachable start nodes,
   a progress watchdog with unstick, paths that end at the real destination. The old path
   straightening tested ~1.7 m up — over every low wall and crate. Stuck episodes per 240
   bot-seconds: 49-75 -> 0 on all three maps.
7. **Hitboxes and "why didn't the headshot kill?"** Bots are hit on capsules on their posed
   skeleton: head x4 (an AR headshot now kills an unarmoured bot; it did 62), body and arms x1,
   legs x0.75 (`tests/e2e/hitboxes.spec.mjs`). The player's own hitbox had a "limb" cylinder
   that enclosed the torso, scoring most chest hits at 0.6x — fixed. Feedback: gold hitmarker +
   metallic sound for a headshot, red for a kill, zone-coloured damage numbers, a kill banner
   (with HEADSHOT), and an enemy you just hit shows its health for 2.5 s. Sniper body shots kill.
8. & 9. **UI.** One stylesheet replaces the inline block and the override layer: text over the
   game instead of glass panels, Barlow Condensed instead of Orbitron, one amber accent instead
   of neon cyan; scanlines, gradient title, emoji icons, the fake player card and the debug
   loading line are gone. READMEFORUI.md is updated.
10. **Movement.** Acceleration + friction (full speed in 0.19 s, stop in 0.21 s — it was ~0.05 s
    both ways), a quicker committed jump (same 1.25 m apex, 0.74 s in the air instead of 0.96 s,
    via extra player-only gravity), weak air control, a landing dip. `tests/e2e/player-movement.spec.mjs`.

Knock-on: hard bots now land 38% of rounds on a standing target at 20 m (was 72% — the old
player limb cylinder caught near misses), but each torso hit counts in full. Elite unchanged.

---

## Session 3: what was wrong with the bots, and why the tests never saw it

Every one of these passed the whole suite, because a bot that is drawn wrong still fights,
scores and dies correctly. `tests/e2e/bot-presentation.spec.mjs` now asserts each visible
property directly, and each test was re-broken and confirmed red.

1. **Every Mixamo-converted character was drawn facing backwards.** Bots are rotated
   `yaw + PI` for a model that faces -Z (the old blocky mesh, the three.js soldier), and every
   Mixamo export faces +Z. Toes pointed against the heading at a dot product of -0.97 on all of
   them. A bot running at you moonwalked; a bot shooting at you had its back turned. This is
   most of what "the animation doesn't match the movement" was. `facingCorrection()` now
   measures each character's facing from its own skeleton — on the *posed* rig, because the
   SWAT's rest pose faces the other way from its clips. The mesh rotation is also written
   every frame now; before, only a turn wrote it, so a fresh spawn faced anywhere until it
   moved.
2. **The original three.js soldier was a heap on the floor.** Under the shared Mixamo clips it
   stood with its head 0.3 m below its feet, with Idle at 0.99 weight. Every track bound, so
   `characters.spec.mjs` was green. It is fallback-only now (`teams: []`). Ely is the same
   Vanguard character, converted properly. Blue is SWAT-only until another character is added,
   because the casts must stay disjoint (a test asserts it).
3. **Corpses fell through the floor and then floated.** `die()` switched collisions off but
   left the body dynamic, so gravity took it through the floor, and at y = -20 the fall-out
   guard — which ran before the alive check — teleported it to a spawn point in mid-air while
   it faded. Frags launched corpses through walls too, because the explosion impulse hit every
   body with mass. Corpses are now kinematic and settled on the floor, and the impulse only
   touches dynamic bodies.
4. **Movement stuttered at every frame rate.** Nothing interpolated between the 120 Hz physics
   steps, so the camera and every bot advanced 1, 2 or 3 steps' worth per frame. Drawn-speed
   jitter on a bot held at a constant 3 m/s: 14.2% before, 3.0% after (`Bot.placeMesh`,
   `renderAlpha` in main.js). Crouch used to drop the camera 0.77 m in one frame and step-ups
   popped it; both are eased now.
5. **The session-2 frame cap caused judder.** It aimed at exactly 60, which a 144 Hz panel can
   only give by alternating 14 ms and 21 ms frames. It now runs every Nth refresh — evenly
   spaced, landing at or a little above the cap (72 on 144 Hz).
6. **Aim pitch overwrote the animation.** It assigned the spine, neck and head X rotation
   instead of adding to it, throwing away the clips' torso lean. It also bent the wrong way
   once the models faced forward — measured, and flipped (`AIM_PITCH_SIGN`).
7. **Team kit** — the chest band and pads floated off the body. Now an armband on each upper
   arm, fitted from that bone's own vertices and carried by the animation.

UI fixed in the same pass: final standings on the menu after a match (there was no results
screen), the result line no longer drawn over CALLSIGN in short windows, the HUD scales down
below ~1280x720 (at 800x450 it covered half the screen), allies labelled once instead of
twice, no "walk in to collect" when you are already full, pointer-lock rejection handled.

**What the playtest found and did not fix — worth your call:**
- **The guns are toy blasters.** The viewmodels are the Kenney Blaster Kit — bright orange,
  green and white plastic. That clashes with "Valorant / professional shooter" more than
  anything else on screen. Blender MCP is connected now; swapping in realistic weapon models is
  an art task, and a good use of it.
- The maps are functional but plain, and Foundry's ceiling lamps render as flat white discs.
- The menu's player card is hard-coded ("DH4410 / LEVEL 12") and the loading status line
  ("96 nav nodes · 8/8 prop models") is debug text shown to the player.

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
- [ ] **An e2e spec for aim assist, trackpad boost and auto-sprint.** None of them are executed
      by any test yet.
- [ ] **Playtest.** Especially the elite bot's difficulty and the new TTK.
- [ ] **Scene lighting from the sky** (a PMREM environment for PORT) would make metal and paint
      read better in daylight. Left out for now: it costs every fragment, and battery was the
      point of session 2.
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

**The Mixamo clips carry root motion, whatever the manifest says.** Check any new clip: the
Hips position track's horizontal drift over one cycle should be ~0. `stripRootMotion` handles it
at load; its "which axis is up" test is the axis that never nears zero — the largest average is
wrong, because a Run cycle's forward drift averages more than the hip height.

**The e2e harness fakes requestAnimationFrame**, so Playwright's actionability "stable" check
never passes for a click inside a match: use `element.click()` in `page.evaluate`. Its fake
gamepad also rewrites `aiming` every frame — hold LT (button 6) to aim in a test.

**A ray exactly along a face or through a corner can go either way.** Two symmetric sight
lines disagreed on PORT because both grazed a box corner. The layout's edges are all at round
numbers, so the specs' probe grids sit at 3-decimal offsets. Keep them off-grid.

**The built-in browser does download, but leaves the file as a GUID `.tmp`** in Downloads
(apparently waiting on a save prompt). The file is complete (FBX ends with the magic footer
`f85a8c6adef5d97eece90ce3758f290b`), so copy it under a proper name and convert.

**Blender's glTF exporter with `export_vertex_color='ACTIVE'` writes an extra all-white COLOR_0**
ahead of the real set, and three reads COLOR_0: every container came out white. The script
exports the colour set by name.

**"Every track binds" is not "the pose is right".** The crushed soldier bound every track of
every clip. Measure the pose itself — head above feet, toes along the heading — as
`bot-presentation.spec.mjs` does.

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

**The pane's screenshots lag one step.** A screenshot taken straight after a state change
often shows the previous frame. Take a second one before believing anything odd.

**To load the game in the pane at all**, `.claude/launch.json` now has an `overrun` entry, so
`preview_start` with name `overrun` serves it on :4173. Stop that server before running e2e or
Playwright cannot bind the port.

**Bump `CACHE` in `sw.js` whenever assets change.** It is at `overrun-v14`. The fetch handler
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

**Add a map made in Blender:** follow PORT — a generator script that emits meshes and colliders
together, a GLB named by material key plus a collider JSON, and a `src/map*.js` that loads both
at boot (`loadPort` in `main.js` runs alongside the character loads) and is marked `available`
in `MAPS` only once they arrive.

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
