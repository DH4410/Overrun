# OVERRUN — Shooter Audit / Bug Backlog

**Audit date:** 2026-08-21  
**Audited revision:** `69dcb15d73431a67e5250b5eac61688e6da6a52a` (`master`)  
**Scope:** repository structure, `game.js`, `index.html`, `ui-overhaul.css`, `sw.js`, README/docs, gameplay rules, FPS feel, controls, AI, physics, maps, UI/HUD, performance, maintainability, and parallel-agent workflow.

> This is primarily a static code audit. Items marked **CONFIRMED** follow directly from the current source. Items marked **VERIFY IN PLAYTEST** are strong code-level concerns that should be reproduced in-browser before changing behavior.

---

## Executive summary

OVERRUN already contains a surprisingly complete browser FPS, but it has one architectural weakness that amplifies almost every other problem: **nearly all gameplay, rendering, AI, maps, input, weapons, HUD logic, effects, match flow, settings, and boot code live in a single ~226 KB `game.js`.** That makes regressions hard to isolate and makes two coding agents editing gameplay in parallel very likely to conflict.

The highest-priority problems are not cosmetic. They affect basic shooter correctness and feel:

1. Pause/settings do not actually pause simulation.
2. Crouch changes the physics sphere and camera but not the player's combat hitboxes consistently.
3. TDM friendly-fire filtering exists for bullets but not grenade radial damage, and kill bookkeeping can reward the thrower's team for friendly kills.
4. Several settings are inconsistent or unused (`viewBob`, fixed FOV behavior vs runtime FOV behavior).
5. Controller toggle-ADS behavior can remain latched unexpectedly.
6. Physics simulation is capped to only 3 × 1/120 s = 25 ms of simulation per rendered frame, so ordinary low-FPS frames cause the game world to run slower than real time.
7. Rotated visual props use axis-aligned collision boxes, producing visible/collision mismatch.
8. Map/player movement and crouch logic depend on a sphere body, producing non-FPS-like character behavior and several geometry edge cases.
9. The weapon model is missing important modern FPS concepts: movement inaccuracy progression, recoil pattern/state, per-weapon falloff, reload interruption rules, weapon swap timing, aim transition state, and distinct handling roles.
10. There is no automated test or smoke-test setup despite a large, tightly coupled real-time codebase.

The best parallel strategy is **not** “Claude fixes half the bugs and Codex fixes half the bugs in `game.js`.” First establish modules / ownership boundaries, then divide work by files. Until that extraction is complete, only one assistant should own `game.js` at a time.

---

# P0 — Critical correctness / merge-risk issues

## BUG-001 — Pause overlay does not pause the game simulation
**Status:** CONFIRMED  
**Area:** Match loop / input / UX  
**Severity:** P0

`pointerlockchange` shows the pause overlay when pointer lock is lost, but `match.running` stays true. `frame()` therefore continues updating player timers, bots, bullets, grenades, particles, pickups, match timer, AI, and damage while the screen says **PAUSED**.

### Why this is bad for a shooter
- Player can be killed while reading settings.
- Match clock continues counting down.
- Bots continue repositioning.
- Grenades continue cooking/exploding.
- A “pause” label becomes misleading and feels broken immediately.

### Recommended fix
Add an explicit `match.paused` or simulation-state enum. Skip simulation updates while paused but continue rendering the paused scene/UI. Distinguish **death screen** from **manual pause**, because death should continue the match.

---

## BUG-002 — Opening Settings during a match still leaves simulation active
**Status:** CONFIRMED  
**Area:** Settings / pause  
**Severity:** P0

`showSettings(true)` exits pointer lock, but there is no simulation pause. It therefore compounds BUG-001: the player is in a full-screen settings panel while bots continue fighting and the timer continues.

### Recommended fix
Settings opened from an active match should set the same manual-pause state as Escape/pointer-lock release. Closing settings should resume only after pointer lock is reacquired.

---

## BUG-003 — Physics time falls behind at common low frame rates
**Status:** CONFIRMED  
**Area:** Main loop / physics  
**Severity:** P0

Physics runs at 120 Hz with `MAX_SUBSTEPS = 3`. That allows only `3 / 120 = 0.025 s` of physics simulation per rendered frame. At 30 FPS each render frame is ~0.0333 s; at 20 FPS it is 0.05 s. The code runs only 25 ms of physics and retains or eventually drops the rest.

This means on a machine that cannot hold ~40+ FPS, physics-based movement/projectiles can effectively become time-dilated relative to render-time systems such as AI and match timers, which use full render `dt`.

### Consequences
- Movement speed and gravity can diverge from bot timers and match time.
- Bullets are stepped in `fixedStep`, while bots and many timers use render `dt`.
- Performance drops alter gameplay, not merely visual smoothness.

### Recommended fix
Either:
- lower fixed physics frequency to 60 Hz and allow 4–5 catch-up steps, or
- keep 120 Hz but allow enough steps for realistic worst-case frame time and cap accumulated debt carefully.

A competitive shooter should not change simulation speed because the GPU is slow.

---

## BUG-004 — Player crouch changes the physics body but not the combat hitbox definition
**Status:** CONFIRMED  
**Area:** Player / hit detection  
**Severity:** P0

`setCrouch()` changes the player's Cannon sphere radius and body Y position. `player.eye` also lowers while crouched. But `player.hb` remains `HB_PLAYER` with the same torso/head offsets and radii regardless of crouch.

### Consequences
- Visual/camera posture and bullet hit volumes disagree.
- A crouching player can potentially be hit where their head/body no longer visually appears.
- AI aiming at `player.pos` also does not fully represent the crouched silhouette.

### Recommended fix
Define standing and crouched hitbox profiles, and update `player.pos`, head offset, body height, and AI target point from the same stance definition.

---

## BUG-005 — TDM grenade damage can hit teammates despite bullet team filtering
**Status:** CONFIRMED  
**Area:** Grenades / team rules  
**Severity:** P0

Bullet collision calls `nearestCombatantHit()`, which skips same-team targets in non-solo modes. Grenade `explode()` iterates every living combatant and applies damage without a team check.

### Why this is inconsistent
The game implicitly presents team damage as disabled for gunfire but enabled for explosives, without any communicated rule.

### Worse: scoring
`killCombatant()` awards `source.kills++` whenever `source && source !== target`. In TDM it then increments the source's team score. Therefore a teammate killed by your grenade can increase your team's score.

### Recommended fix
Choose one explicit rule:
- **Friendly fire off:** skip allied grenade damage entirely.
- **Friendly fire on:** apply damage, but never award positive score for teamkills; likely subtract score and show teamkill feed styling.

For the current arcade/team-deathmatch design, friendly fire off is the least surprising.

---

## BUG-006 — Rotated props render rotated but collide axis-aligned
**Status:** CONFIRMED  
**Area:** Map collision  
**Severity:** P0/P1

`placeProp()` visually rotates GLB/fallback props with `inst.rotation.y = yaw`, but then calls:

`addStaticBox(hx, hy, hz, { x, y: hy, z });`

without passing a quaternion.

The code swaps X/Z extents for odd 90° rotations, but several placements use non-90° values such as `Math.PI / 4` and arbitrary values like `0.4`/`0.6` radians. Their collider remains an unrotated box.

### Consequences
- Invisible corners block the player.
- Player can visually clip into the prop on the opposite side.
- Bullet/world raycasts hit geometry where the model is not.
- Bot blockers and real physics can disagree.

### Recommended fix
Pass a Cannon quaternion matching yaw to the static body, or restrict gameplay props to rotations the current approximation supports.

---

## BUG-007 — One giant `game.js` makes safe two-agent parallel gameplay work impractical
**Status:** CONFIRMED  
**Area:** Architecture / development process  
**Severity:** P0 for parallel work

The repository's own UI contract already separates CSS ownership, but gameplay remains one massive module. Two agents changing AI, weapons, movement, match flow, or maps will repeatedly modify overlapping regions and shared globals.

### Recommended fix
Before large parallel implementation, extract modules in a dedicated refactor PR without gameplay changes. Suggested first boundaries:

- `src/config.js`
- `src/settings.js`
- `src/audio.js`
- `src/physics.js`
- `src/weapons.js`
- `src/player.js`
- `src/bots.js`
- `src/maps.js`
- `src/effects.js`
- `src/hud.js`
- `src/match.js`
- `src/input.js`
- `src/main.js`

Do this incrementally, not as one enormous rewrite.

---

# P1 — Major gameplay / shooter-feel problems

## BUG-008 — `viewBob` setting is unused
**Status:** CONFIRMED  
**Area:** Settings / camera / viewmodel  
**Severity:** P1

`DEFAULT_SETTINGS.viewBob` exists and a Settings toggle is generated, but `updateViewModel()` always applies walking bob. No branch checks `settings.viewBob`.

### Fix
Gate viewmodel bob and any future camera bob using this option.

---

## BUG-009 — FOV setting/comments disagree with actual gameplay FOV
**Status:** CONFIRMED  
**Area:** Camera / settings  
**Severity:** P1

The settings object says FOV is fixed at 68 and `applySettings()` sets `camera.fov = settings.fov`. But every gameplay frame `updateCamera()` targets:

- hip fire: **78°**
- non-scope ADS: **68°**
- sniper: `zoomFov`

Therefore the “fixed 68” concept is not actually the normal FOV; it is effectively ADS FOV.

### Shooter impact
FOV strongly changes perceived movement speed, target size, sensitivity feel, recoil appearance, and weapon framing. The current code/documentation make calibration confusing.

### Fix
Rename settings/constants explicitly (`HIP_FOV`, `ADS_FOV`) and derive sensitivity behavior intentionally.

---

## BUG-010 — ADS sensitivity logic is inconsistent for sniper vs normal ADS
**Status:** CONFIRMED  
**Area:** Input / aiming  
**Severity:** P1

Mouse look multiplier is:
- sniper scoped: hardcoded `0.4`
- normal ADS: `settings.adsSensitivity`

So the user's ADS sensitivity setting does not control scoped sensitivity in a predictable way.

### Fix
Use a clear sensitivity model, ideally monitor-distance or explicit hip/ADS/scope multipliers. At minimum expose `scopeSensitivity` or multiply scope by the ADS preference.

---

## BUG-011 — Gamepad aim-toggle implementation can latch aiming in confusing ways
**Status:** CONFIRMED  
**Area:** Controller input  
**Severity:** P1

`pollGamepad()` uses:

`aiming = down(6) || (settings.toggleAim && aiming);`

When toggle aim is enabled, this preserves prior `aiming` forever unless some unrelated code resets it; pressing LT does not implement a proper edge-triggered toggle.

### Fix
Use `pressed(6)` to flip an ADS latch when toggle mode is enabled; use `down(6)` only for hold mode.

---

## BUG-012 — Controller crouch conflicts with hold/toggle settings model
**Status:** CONFIRMED  
**Area:** Controller input  
**Severity:** P1

Controller B both flips `crouchLatch` and sets `keys.KeyC = down(1)`. `stepPlayer()` then chooses latch vs held key depending on `settings.toggleCrouch`.

The result is two overlapping semantics that can behave differently from keyboard and make state transitions hard to reason about.

### Fix
Implement input actions (`crouchPressed`, `crouchHeld`) separately from device keys, then resolve setting behavior once.

---

## BUG-013 — Sprint toggle/crouch latches are reset on weapon switch
**Status:** CONFIRMED  
**Area:** Input / movement  
**Severity:** P1

`switchWeapon()` sets both `crouchLatch = false` and `sprintLatch = false`.

A player using toggle crouch can stand up simply because they switched weapons. That is unexpected and can expose them behind cover.

### Fix
Weapon switching should not alter stance unless there is an intentional gameplay restriction.

---

## BUG-014 — Standing from crouch does not check overhead clearance
**Status:** CONFIRMED / VERIFY IN PLAYTEST  
**Area:** Movement / collision  
**Severity:** P1

`setCrouch(false)` immediately increases the sphere radius and shifts the body upward. There is no upward clearance test.

### Consequences
- Standing under low geometry can cause solver penetration correction.
- Player may clip, pop, or be pushed unexpectedly.

### Fix
Before uncrouching, sweep/raycast the intended standing volume and remain crouched if blocked.

---

## BUG-015 — Character controller uses a sphere rather than a capsule
**Status:** DESIGN/TECH DEBT with concrete feel consequences  
**Area:** Movement  
**Severity:** P1

A single sphere is simple, but FPS movement generally needs a capsule/cylinder-like footprint with stable vertical extent.

### Current side effects visible in code
- custom ledge step-up workaround exists because sphere catches on lips;
- crouching changes radius, meaning crouching also makes the player narrower;
- camera/body/hitbox offsets require special correction;
- standing-up behavior depends on resizing around the sphere center.

### Improvement
Use a capsule-like compound body or kinematic capsule controller. Crouch should primarily change height, not shoulder width/radius.

---

## BUG-016 — Crouching makes the player narrower, not merely shorter
**Status:** CONFIRMED  
**Area:** Movement / combat fairness  
**Severity:** P1

Player radius changes from `0.5` to `0.38` while crouched.

That allows crouching to fit through narrower horizontal spaces and potentially changes corner peeking/cover behavior in a way players do not expect.

### Fix
Keep horizontal radius stable; reduce capsule/collider height.

---

## BUG-017 — Movement acceleration is effectively near-instant on the ground
**Status:** CONFIRMED / shooter-feel issue  
**Area:** Movement tuning  
**Severity:** P1

At 120 Hz, `MOVE_ACCEL * dt = 60 / 120 = 0.5`, so horizontal velocity lerps halfway to the target every physics tick. This reaches near-full speed extremely quickly.

### Shooter impact
- Little acceleration/deceleration identity.
- Strafing direction changes feel digital.
- Movement lacks weight compared with tactical/arena shooters that deliberately tune acceleration curves.

### Improvement
Define explicit ground acceleration, braking/deceleration, air acceleration, and counter-strafe behavior.

---

## BUG-018 — Jump can retrigger from held Space immediately on landing
**Status:** CONFIRMED  
**Area:** Movement  
**Severity:** P1/P2

`if (keys.Space && player.grounded)` jumps. There is no key-edge requirement.

Holding Space therefore implements automatic bunny-hop behavior.

### Shooter impact
If intentional, document it. If aiming for Valorant/CS-like grounded tactical gunplay, it is wrong.

### Fix
Jump on press edge, optionally with a short configurable input buffer.

---

## BUG-019 — ADS can be active while airborne with only a generic spread multiplier
**Status:** CONFIRMED / design issue  
**Area:** Weapon accuracy  
**Severity:** P1

Spread uses only a few global multipliers. There is no per-weapon movement/airborne accuracy model or recovery curve.

### Shooter impact
A true shooter benefits from readable accuracy states: standing, moving, crouched, airborne, ADS, sustained fire. Current behavior is simplistic and identical in structure across weapons.

### Improvement
Give each gun per-state base spread and recovery rates. Show current spread through crosshair expansion.

---

## BUG-020 — Crosshair does not communicate actual weapon spread/recoil state
**Status:** CONFIRMED  
**Area:** HUD / gunplay feedback  
**Severity:** P1

The crosshair gap is static and user-configured. Actual spread changes with ADS/sprint/airborne state, but the crosshair does not react.

### Shooter impact
The player cannot visually learn when a shot is accurate.

### Fix
Combine user base gap with dynamic firing/movement spread expansion and smooth recovery.

---

## BUG-021 — Recoil is mostly random camera kick with exponential reset, not a learnable recoil model
**Status:** CONFIRMED / shooter-feel issue  
**Area:** Weapons  
**Severity:** P1

Each shot increments pitch by a constant and yaw by random ±40% recoil. Recovery exponentially returns aim automatically.

### Shooter impact
- weak mastery ceiling;
- recoil cannot be learned as a pattern;
- automatic rifle spray becomes random rather than skill-controlled;
- automatic recovery may fight player compensation.

### Improvement
Track recoil index / spray duration per weapon, use a deterministic base pattern plus limited random noise, and tune reset delay/recovery separately.

---

## BUG-022 — No damage falloff by weapon/range
**Status:** CONFIRMED  
**Area:** Weapon balance  
**Severity:** P1

Bullet damage is constant until max projectile range. A pistol, shotgun pellet, and AR round have no explicit distance falloff.

### Shooter impact
Weapon roles are mostly enforced by spread and bot range preference, not player-facing ballistic effectiveness.

### Improvement
Add per-weapon falloff start/end and minimum damage. Shotgun particularly needs range shaping.

---

## BUG-023 — Shotgun uses independent square-component spread rather than a controlled pellet pattern/cone
**Status:** CONFIRMED  
**Area:** Weapons  
**Severity:** P1/P2

Spread adds independent random offsets to x/y/z, then normalizes. This is not a uniform angular cone and can produce uneven density.

### Improvement
Generate directions uniformly within a cone, or use a deterministic pellet pattern with slight random rotation.

---

## BUG-024 — No weapon equip/holster time
**Status:** CONFIRMED  
**Area:** Weapons  
**Severity:** P1

`switchWeapon()` changes the active weapon immediately, with only a generic `cooldown >= 0.25` preventing instant fire.

### Shooter impact
Weapon swapping lacks physical timing and weapon-specific handling. Switching to a sniper should not feel identical to switching to a pistol.

### Fix
Add per-weapon equip/unequip timing and animations; cancel/restrict firing/reloading deliberately.

---

## BUG-025 — Reload is timer-only and cannot model magazine state or interruption cleanly
**Status:** CONFIRMED / design debt  
**Area:** Weapons  
**Severity:** P1

Reload starts a countdown; ammo transfers only at completion. There are no reload phases, tactical reload differences, shell-by-shell shotgun reload, or interruption rules beyond weapon switch cancelling the timer.

### Improvement
At minimum add per-weapon reload style. Shotgun should usually load shells individually if aiming for a recognizable shooter feel.

---

## BUG-026 — Auto-reload begins immediately when magazine reaches zero
**Status:** CONFIRMED  
**Area:** Weapons  
**Severity:** P1/P2

After firing the last shot, `tryFire()` automatically calls `startReload()`.

This removes player choice and can conflict with weapon swapping or tactical timing. Many shooters auto-reload only on another trigger press, or expose the behavior as an option.

---

## BUG-027 — Sniper can deal enormous headshot damage with armor model but lacks bolt/unscope handling
**Status:** CONFIRMED / shooter-feel issue  
**Area:** Sniper  
**Severity:** P1/P2

Sniper has 95 base × 2.4 head multiplier before armor = 228 raw. That is fine for lethal headshots, but the weapon lacks bolt cycling, scoped firing recovery, automatic unscope or chambering state.

### Improvement
Add a chamber/bolt phase after each shot and decide whether the scope remains up. This is a major part of sniper feel.

---

## BUG-028 — Weapon ammo economy is extremely generous
**Status:** CONFIRMED / balance issue  
**Area:** Match pacing  
**Severity:** P1/P2

Examples:
- AR starts 30 + 180 rounds.
- Pistol starts 15 + 90.
- Ammo chests replenish magazine + 30% reserve and grenades.
- Dropped guns add ~1.5 magazines and can refill an empty mag.

This makes ammunition management nearly irrelevant in 5-minute matches.

### Improvement
Reduce reserves or make ammo resupply more contested/less frequent.

---

## BUG-029 — Armor + health pickups create high effective HP without strong feedback in core HUD/combat
**Status:** CONFIRMED / balance issue  
**Area:** TTK  
**Severity:** P1

Player starts at 100 HP + 50 armor, with 55% absorption, and can reach 100 armor. This significantly increases effective durability while many weapon damage values are low.

Example: pistol body damage 12 before armor can feel spongey, especially with movement and projectile travel.

### Improvement
Measure actual time-to-kill by weapon at 5/15/30 m, armored/unarmored. Tune around target combat pacing rather than isolated damage values.

---

# P1 — AI / match issues

## BUG-030 — Bot update runs at render rate while bullets/player physics run fixed-step
**Status:** CONFIRMED  
**Area:** AI / timing  
**Severity:** P1

Bots decrement fire cooldowns, reaction time, reload, movement decisions, and state timers using render-frame `dt`, while projectile/player simulation is fixed-step.

When frame rate degrades and physics hits the substep cap, AI time and physics time diverge.

### Fix
Move gameplay-critical bot timers/movement into the fixed simulation, or resolve BUG-003 and adopt one consistent simulation clock.

---

## BUG-031 — Bot separation is O(n²) every bot movement call
**Status:** CONFIRMED  
**Area:** AI performance  
**Severity:** P1 in Survival

`setPlanarVelocity()` loops over every bot. Each bot update calls it, making separation quadratic.

Survival waves grow `4, 6, 8, ...` indefinitely, so cost rises rapidly.

### Fix
Use a spatial hash/grid, neighborhood buckets, or cap survival population.

---

## BUG-032 — Survival wave population grows without a hard limit
**Status:** CONFIRMED  
**Area:** Match mode / performance  
**Severity:** P1

Wave enemy count is `2 + wave * 2`. There is no maximum.

### Consequences
Eventually:
- quadratic bot separation grows expensive;
- more skinned meshes/mixers are active;
- more combatants are tested by every bullet;
- more UI/minimap/nameplate work occurs.

### Fix
Cap simultaneous enemies and increase difficulty using spawn cadence, skill, HP, roles, or elite enemies instead of infinite concurrency.

---

## BUG-033 — Bots can heal themselves by reaching “cover”
**Status:** CONFIRMED / design issue  
**Area:** AI fairness  
**Severity:** P1

In `ST.COVER`, when done or after 2 seconds, bot health increases by 12 without any pickup, animation, item, or player-readable explanation.

### Shooter impact
This can feel like cheating because player healing requires map pickups.

### Fix
Either remove passive bot healing or make bots use the same health pickups/resources as the player.

---

## BUG-034 — Bots have no armor while player begins with armor
**Status:** CONFIRMED / balance asymmetry  
**Area:** AI fairness  
**Severity:** P1/P2

Bots initialize `armor = 0`; player starts with 50. This may be intentional difficulty tuning, but combined with bot accuracy and player pickups it produces asymmetric damage rules.

### Improvement
Document intentional asymmetry or give bot classes visible armor states.

---

## BUG-035 — Bot navigation intentionally cannot use vertical routes/perches
**Status:** CONFIRMED / shooter-experience issue  
**Area:** AI / map design  
**Severity:** P1

Comments explicitly state bots stay on floor-plane waypoints and never use perches/catwalks.

### Consequences
- Human can exploit vertical positions.
- Maps contain traversal options the AI cannot understand.
- Combat reads more like targets moving on a plane than opponents controlling a 3D arena.

### Improvement
For a stronger shooter, use authored navmesh/nav links or a more capable waypoint graph with elevation and jump/ramp links.

---

## BUG-036 — Bot perception does not model lighting even though maps emphasize darkness
**Status:** CONFIRMED for current modes; future-critical for Blackout GDD  
**Area:** AI perception  
**Severity:** P1

Bots use distance + view cone + static-world LOS + smoke. Light level does not affect detection.

The Blackout GDD itself recognizes this will become a major fairness issue.

### Improvement
Add visibility score based on distance, target movement, firing, local illumination, and smoke rather than binary geometry LOS alone.

---

## BUG-037 — Bots hear all gunshots within a simple 20 m sphere through walls
**Status:** CONFIRMED  
**Area:** AI audio perception  
**Severity:** P1/P2

`alertBots()` uses only Euclidean distance. No material/occlusion attenuation is considered.

### Improvement
At least ray-test heavy occlusion or use map-area propagation so walls meaningfully reduce hearing.

---

## BUG-038 — Deathmatch scoreboard/topbar opponent score is not necessarily the true leader logic at all times
**Status:** VERIFY IN PLAYTEST  
**Area:** Match UI  
**Severity:** P2

`match.scoreB` is updated using `Math.max(match.scoreB, source.kills)` when non-player sources kill in DM, while topbar also independently finds top bot in `updateMatch()`. There are duplicated representations of essentially the same score state.

### Improvement
Use one canonical leaderboard computation to avoid future desync.

---

## BUG-039 — Time-limit ties are automatically awarded as wins
**Status:** CONFIRMED  
**Area:** Match rules  
**Severity:** P1/P2

DM time expiry uses `player.kills >= top.kills ? YOU WIN : YOU LOSE`. Ties therefore give the player a win.

TDM time expiry similarly uses `scoreA >= scoreB`, giving Blue the win on a tie.

### Fix
Show DRAW, or implement overtime/tiebreak rules.

---

## BUG-040 — Spawn algorithm optimizes distance only, not line of sight / facing / recent danger
**Status:** CONFIRMED  
**Area:** Spawn system  
**Severity:** P1

`pickSpawn()` maximizes minimum squared distance to living enemies with random jitter. It does not evaluate:
- direct LOS from enemies;
- nearby projectiles/grenades;
- recent death location;
- enemy facing;
- teammate clustering in TDM.

Spawn invulnerability hides some failures but does not solve spawn quality.

### Improvement
Score candidate spawns using distance + visibility + enemy view direction + recent combat heat.

---

## BUG-041 — Spawn invulnerability lasts 3 seconds, which can be abused offensively
**Status:** CONFIRMED / balance issue  
**Area:** Spawn system  
**Severity:** P1/P2

Bots cannot acquire protected players and `applyDamage()` rejects all incoming damage during the timer, but protected players remain free to move and fire.

### Improvement
End protection on firing, grenade throw, or after leaving a small spawn radius; otherwise an invulnerable player can initiate a fight.

---

# P1/P2 — Map / collision / rendering issues

## BUG-042 — `addRamp()` blocker approximation can incorrectly block navigation around rotated ramps
**Status:** CONFIRMED / VERIFY IN PLAYTEST  
**Area:** Navigation  
**Severity:** P1/P2

The actual ramp receives a rotated Cannon collider, but `addBlocker()` receives an axis-aligned footprint approximation using width and `abs(dz)` only. East/west and angled cases are not represented symmetrically.

Bot waypoint generation may therefore remove valid nodes or permit problematic edges around ramps.

---

## BUG-043 — Dungeon decorative props can carve navigation unpredictably because placement is randomized on each build
**Status:** CONFIRMED  
**Area:** Maps / reproducibility  
**Severity:** P1/P2

Dungeon dressing randomly places collidable props each build, and those props add blockers before waypoints are generated.

### Consequences
- Nav graph changes every match/rebuild.
- A bug may be hard to reproduce.
- Spawn/path quality can vary randomly.

### Improvement
Use seeded randomness per match/map, or authored prop locations for gameplay-affecting cover.

---

## BUG-044 — Cosmetic randomness and gameplay randomness share global `Math.random()`
**Status:** CONFIRMED  
**Area:** Reproducibility / testing  
**Severity:** P2

AI names, aim error, map dressing, lights, effects, spawn jitter, and particles all consume the same non-seeded random source.

### Improvement
Separate seeded gameplay RNG from cosmetic RNG. This makes bugs reproducible and tests deterministic.

---

## BUG-045 — World muzzle flash bypasses the fixed point-light pool
**Status:** CONFIRMED / performance concern  
**Area:** Rendering  
**Severity:** P1/P2

The code carefully explains that adding/removing lights causes expensive shader recompilation, then creates a permanent `worldFlash` PointLight outside the 12-slot pool. Because it is permanent this does not change light count at runtime, so it avoids the compile problem, but it means actual scene light count is `pool + flash + rig`, while quality settings only budget `q.lights` from the pool.

### Improvement
Account for fixed gameplay lights in the quality budget/documentation so “4 lights” really means what the performance UI claims.

---

## BUG-046 — `pbrMat()` always sets texture anisotropy to device maximum, ignoring quality preset
**Status:** CONFIRMED  
**Area:** Graphics settings  
**Severity:** P2

QUALITY defines `aniso` values (1/4/16), but loaded PBR textures use `MAX_ANISO`. The setting is never applied to these textures.

### Fix
Track loaded textures and set anisotropy to `min(q.aniso, MAX_ANISO)` in `applySettings()`.

---

## BUG-047 — Renderer antialias quality setting cannot actually switch WebGL context MSAA
**Status:** CONFIRMED  
**Area:** Graphics settings  
**Severity:** P2

QUALITY includes `antialias: false/true`, but the renderer is constructed once with `{ antialias: true }`. That WebGL context option cannot be toggled by merely changing a setting later, and `applySettings()` never references `q.antialias` anyway.

### Fix
Remove misleading setting metadata or implement a post-process AA strategy that can be toggled at runtime.

---

## BUG-048 — Minimap is hidden via CSS on narrow screens but still rendered every gameplay frame
**Status:** CONFIRMED  
**Area:** Performance / responsive UI  
**Severity:** P2

At `max-width: 680px`, `#mapframe { display:none; }`, but `renderMinimap()` still renders the extra scene pass.

### Fix
Skip minimap rendering when disabled/hidden.

---

## BUG-049 — Mobile layout exists, but the game has no touch shooter controls
**Status:** CONFIRMED / product mismatch  
**Area:** Responsive / input  
**Severity:** P2

CSS contains mobile breakpoints, but gameplay requires pointer lock, keyboard/mouse or gamepad. A phone/tablet visitor sees responsive UI but cannot actually play using touch.

### Improvement
Either add touch controls or explicitly mark desktop/gamepad requirement and avoid pretending full mobile support.

---

# P2 — Audio / feedback / immersion

## BUG-050 — Explosion audio is not spatially panned
**Status:** CONFIRMED  
**Area:** Audio  
**Severity:** P2

Gunshots use `Audio.spatial()` and stereo panning. `Audio.explosion()` accepts only distance and plays centered audio.

### Shooter impact
Explosions are important directional information and should be at least left/right localized.

---

## BUG-051 — Grenade bounce audio uses distance but no pan
**Status:** CONFIRMED  
**Area:** Audio  
**Severity:** P2

A grenade bouncing nearby is a critical positional cue, yet bounce sound has no stereo positioning.

---

## BUG-052 — Player footsteps are non-spatial/identical and ignore surface/material
**Status:** CONFIRMED  
**Area:** Audio  
**Severity:** P2

One synthesized low-pass burst represents all player footsteps. No concrete/metal/stone distinction, left/right cadence, jump landing cue, or crouch/sprint loudness model is present.

### Improvement
Surface-aware footsteps would dramatically improve shooter feel for relatively modest complexity.

---

## BUG-053 — Bot footsteps are generated from movement timer but do not distinguish walk/run surfaces
**Status:** CONFIRMED  
**Area:** Audio / AI readability  
**Severity:** P2

Bots use one filtered burst. Tactical information is therefore weak compared with modern shooters.

---

## BUG-054 — No landing sound/impact feedback
**Status:** CONFIRMED  
**Area:** Movement feedback  
**Severity:** P2

Jumping has no explicit landing event, landing sound, camera response, or weapon bob. This makes movement feel weightless even if the jump arc itself is tuned.

---

## BUG-055 — No dry-fire sound
**Status:** CONFIRMED  
**Area:** Weapon feedback  
**Severity:** P2

Firing an empty magazine starts reload immediately. There is no click/dry-fire feedback.

---

## BUG-056 — No distinct headshot hitmarker/audio path until kill feed/damage number
**Status:** CONFIRMED / UX  
**Area:** Combat feedback  
**Severity:** P2

Headshot color is shown in damage numbers, but hitmarker/audio does not appear to use a dedicated headshot cue. A strong shooter normally makes a critical hit immediately legible.

---

## BUG-057 — Smoke is visual sprites but bullets pass through normally with no visibility penalty for player aim
**Status:** CONFIRMED / design issue  
**Area:** Smoke  
**Severity:** P2

Bots are prevented from seeing through smoke, but human shooting mechanics receive no dispersion/visibility mechanic beyond the visual obstruction. This is reasonable, but smoke opacity/sprite density should be playtested for whether players can exploit gaps more easily than AI.

---

# P2 — UI / product issues

## BUG-058 — Player card is fake/static profile data
**Status:** CONFIRMED  
**Area:** Menu UX  
**Severity:** P2

`index.html` hardcodes:
- name `DH4410`
- `LEVEL 12`
- XP 48%

None is connected to actual game state.

### Shooter/product impact
Fake progression UI makes the game look unfinished or deceptive.

### Fix
Remove until progression exists, or wire it to real persistent stats.

---

## BUG-059 — Callsign field and player card show different identities
**Status:** CONFIRMED  
**Area:** Menu UX  
**Severity:** P2

The player can enter a callsign, but the static profile card always says `DH4410`.

---

## BUG-060 — Settings are saved on every slider `input` event
**Status:** CONFIRMED  
**Area:** UI/settings  
**Severity:** P2

Moving a slider repeatedly triggers `applySettings()` and `saveSettings()`, including expensive graphics operations depending on the setting.

### Improvement
Separate cheap live settings from expensive graphics reconfiguration; debounce persistence.

---

## BUG-061 — Any settings change calls the entire graphics apply path
**Status:** CONFIRMED  
**Area:** Performance / settings  
**Severity:** P2

Changing crosshair color or mouse sensitivity still executes shadow, pixel ratio, render resize, camera projection, audio, crosshair, and save logic.

### Fix
Apply settings by category or only when a relevant value changes.

---

## BUG-062 — Scoreboard K/D displays kills as a decimal with two places when deaths are zero
**Status:** CONFIRMED  
**Area:** UI  
**Severity:** P2

`c.deaths === 0 ? c.kills.toFixed(2) : ...` displays e.g. `3.00` K/D for 3 kills and 0 deaths. K/D is mathematically undefined/infinite, not 3.00.

### Fix
Display `—`, `∞`, or use KDA-style convention.

---

## BUG-063 — Scoreboard title element is never meaningfully updated
**Status:** CONFIRMED / minor  
**Area:** UI  
**Severity:** P3

`b-title` is looked up, but current code primarily updates subtitle. Different modes could provide clearer titles.

---

## BUG-064 — Damage feed uses `innerHTML` with player/bot names
**Status:** CONFIRMED  
**Area:** DOM robustness/security  
**Severity:** P2

Player name is inserted into kill-feed HTML. It is uppercased and length-limited but not HTML-escaped.

A callsign containing markup-like characters can affect DOM rendering.

### Fix
Construct feed elements with `textContent`, not string HTML.

---

## BUG-065 — Scoreboard also uses `innerHTML` for player name
**Status:** CONFIRMED  
**Area:** DOM robustness/security  
**Severity:** P2

Same issue as BUG-064 in scoreboard row construction.

---

# P2 — Loading, offline, dependency, deployment

## BUG-066 — Offline claim is incomplete because CDN JS dependencies are not cached
**Status:** CONFIRMED  
**Area:** Service worker / offline  
**Severity:** P2

Service worker intentionally handles only same-origin traffic. However the app imports Three.js and Cannon from CDNs. A fresh/offline launch therefore cannot load the engine even if local source is cached.

### Fix
Vendor/pin engine dependencies locally or precache them through a controlled build/deployment strategy.

---

## BUG-067 — `ui-overhaul.css` is not in precache list
**Status:** CONFIRMED  
**Area:** Service worker  
**Severity:** P2

`PRECACHE` includes only `./`, `index.html`, and `game.js`. CSS can be cached after one network request through network-first handling, but it is not guaranteed for first offline use after installation.

---

## BUG-068 — Service-worker cache versioning is manual and asset cache is cache-first indefinitely
**Status:** CONFIRMED / operational risk  
**Area:** Deployment  
**Severity:** P2

Same-origin assets are cache-first and cache key is a manually incremented constant (`overrun-v4`). If an asset file changes under the same URL and cache version is not bumped, users keep the stale asset.

### Fix
Use content-hashed assets/build manifest or robust stale-while-revalidate/version strategy.

---

## BUG-069 — Runtime depends on multiple external CDNs without integrity/fallback pinning
**Status:** CONFIRMED  
**Area:** Dependency reliability  
**Severity:** P2

Import map loads from unpkg/jsDelivr. Poly Haven textures are another external origin.

### Consequences
- cold-start availability depends on third parties;
- offline launch is incomplete;
- CSP/SRI/version management is weak;
- performance varies by network.

### Improvement
Vendor critical runtime dependencies and core art; treat remote textures as optional enhancements only.

---

## BUG-070 — `three-pathfinding` is in the import map but deliberately unused
**Status:** CONFIRMED  
**Area:** Loading/config  
**Severity:** P3

Unused import-map entry is harmless by itself because imports are demand-loaded, but it creates misleading architecture/documentation and suggests a dependency that is not actually part of runtime.

### Fix
Remove until used or keep only in design docs.

---

## BUG-071 — No package/build/test manifest
**Status:** CONFIRMED  
**Area:** Engineering  
**Severity:** P1/P2

No `package.json` or automated test setup is present.

### Consequences
- no linting;
- no deterministic dependency install;
- no unit tests;
- no browser smoke test;
- no CI validation;
- agents can silently regress core systems.

### Improvement
Even if production stays build-free, add dev tooling with Playwright and a small unit-test layer.

---

## BUG-072 — No CI checks or executable regression suite are visible in repo
**Status:** CONFIRMED from audit scope  
**Area:** Engineering  
**Severity:** P1

`Agents.md` asks contributors to manually check startup, controls, firing, reloads, scoreboard, asset paths, etc., which is exactly the set of tasks an automated browser smoke test should cover.

### Minimum recommended smoke suite
1. Boot reaches enabled DEPLOY button.
2. Start DM Warehouse.
3. Pointer lock/request path does not throw.
4. Movement changes player position.
5. Fire decrements ammo.
6. Reload restores magazine and consumes reserve.
7. Switching weapons works.
8. Crouch/stand changes expected posture safely.
9. Grenade creates/removes body and can damage enemy.
10. Pause freezes match timer.
11. Settings opens/closes without simulation advancing.
12. Map switch builds valid spawn points and nav nodes.
13. Bot dies/respawns in DM but does not respawn in Survival wave logic incorrectly.
14. TDM friendly fire rules are enforced.

---

# P2 — Performance / memory engineering

## BUG-073 — Bullet collision cost grows with every combatant for every bullet step
**Status:** CONFIRMED  
**Area:** Performance  
**Severity:** P2 now, P1 in large Survival waves

Every bullet fixed-step checks every combatant analytically. With high AR fire rate + many bots + 120 Hz simulation this scales quickly.

### Improvement
Spatially partition combatants, or raycast/sweep against a broad-phase structure.

---

## BUG-074 — Particle pool update scans full capacity whenever any particle is alive
**Status:** CONFIRMED  
**Area:** Performance  
**Severity:** P2

Each active pool loops all 900/500 slots rather than only active indices.

At current scale this may be acceptable, but it is easy to optimize with dense active lists if effects expand.

---

## BUG-075 — Smoke allocates 20 SpriteMaterials per smoke grenade
**Status:** CONFIRMED  
**Area:** Performance / memory  
**Severity:** P2

Smoke correctly disposes materials at end, but each cloud creates 20 unique SpriteMaterials. Multiple simultaneous smokes cause allocation churn and draw-call growth.

### Improvement
Use instancing, shared material/texture with per-instance opacity/rotation data, or a pooled sprite system.

---

## BUG-076 — Several gameplay effects allocate vectors/objects on hot paths
**Status:** CONFIRMED  
**Area:** Performance  
**Severity:** P2/P3

Examples include clones/new vectors during firing, grenade AI throws, and viewmodel muzzle queries. Many scratch vectors already exist, so this codebase clearly values allocation reduction, but the pattern is inconsistent.

### Improvement
Profile before micro-optimizing, but keep hot-path allocations low, especially before increasing bot counts.

---

## BUG-077 — Dynamic UI creates/removes DOM nodes frequently during combat
**Status:** CONFIRMED  
**Area:** Performance  
**Severity:** P2/P3

Damage numbers, damage-direction arcs, kill feed rows, and slot elements are created/destroyed repeatedly.

For current bot counts it is likely acceptable, but if combat density rises, pooling or CSS-only reuse can reduce GC/layout churn.

---

# P2/P3 — Maintainability and design consistency

## BUG-078 — Large sections contain historical bug narratives inline with production code
**Status:** CONFIRMED  
**Area:** Maintainability  
**Severity:** P3

The comments are useful, but many are long postmortems with measured historical behavior. In a 5k+ line single module this makes scanning and editing harder.

### Improvement
Keep concise invariants in code and move deep postmortems/benchmarks to `docs/engineering-notes.md`.

---

## BUG-079 — Shared mutable global scratch vectors make functions non-reentrant and fragile
**Status:** CONFIRMED  
**Area:** Architecture  
**Severity:** P2

Functions across bullets, AI, LOS, smoke, effects, UI projection, etc. reuse `_v1`, `_v2`, `_v3` and other globals. Comments already document one prior bug caused by scratch-vector aliasing in `fireWeapon()`.

### Consequences
- easy accidental state corruption during nested calls;
- hard parallel refactoring;
- difficult testing.

### Improvement
Give modules private scratch state or pass explicit temporaries in complex/nested paths.

---

## BUG-080 — Gameplay state is represented by many independent booleans/latches rather than explicit states
**Status:** CONFIRMED  
**Area:** Input/player state  
**Severity:** P2

Examples: `firing`, `aiming`, `pointerLocked`, `crouchLatch`, `sprintLatch`, `player.cooking`, `player.reloading`, `match.running`.

Invalid combinations are possible (settings open + match running + pointer unlocked + simulation active, for example).

### Improvement
Use small state machines:
- app screen state: MENU / PLAYING / PAUSED / SETTINGS / SCOREBOARD / ENDED
- weapon state: IDLE / FIRING / RELOADING / EQUIPPING / COOKING
- stance state: STAND / CROUCH / AIR

---

## BUG-081 — Config values mix units, tuning, and hard engine constraints in one mutable object
**Status:** CONFIRMED  
**Area:** Architecture  
**Severity:** P3

`CONFIG` contains physics, player, bullets, grenades, match rules, rendering decal counts and sensitivity. `applySettings()` even mutates `CONFIG.MAX_DECALS`.

### Improvement
Split immutable gameplay constants from runtime quality settings and per-match rules.

---

## BUG-082 — UI styling exists both inline in `index.html` and in a 31 KB override stylesheet
**Status:** CONFIRMED  
**Area:** UI maintainability  
**Severity:** P2/P3

The contract explains why this works, but it creates cascade complexity and duplicate definitions.

### Improvement
Long term, migrate stable base styles out of inline HTML. Do not do this in parallel with gameplay changes because it would cause huge diffs.

---

## BUG-083 — GDD describes systems far beyond current architecture without an implementation staging plan in code
**Status:** CONFIRMED  
**Area:** Product planning  
**Severity:** P2

`BLACKOUT_PHASE_GDD.md` proposes round economy, interactables, destructible props, doors, light gadgets, no-respawn flow, blackout perception, etc. The GDD itself correctly flags that these systems will stress the monolithic architecture.

### Improvement
Do architecture/refactor + test harness before implementing Blackout Phase.

---

# Shooter-experience improvements (not necessarily bugs)

These are the main reasons the current project may feel like a technically impressive demo rather than a polished FPS.

## Movement
- Replace sphere controller with capsule/kinematic character controller.
- Separate acceleration, braking, air control, crouch speed and sprint acceleration.
- Add landing response.
- Decide explicitly whether bunny hopping is allowed.
- Add crouch transition time rather than instant radius swap.
- Add overhead stand-up blocking.
- Consider sprint only while moving forward, depending on intended style.
- Add weapon sway based on velocity/acceleration, not only raw mouse delta.

## Gunplay
- Dynamic crosshair matching actual dispersion.
- Per-weapon recoil state/pattern.
- First-shot accuracy and sustained-fire bloom.
- Movement accuracy curves.
- Range-based damage falloff.
- Distinct ADS transition time.
- Equip/holster timing.
- Shotgun shell reload.
- Sniper bolt/chamber cycle.
- Dry-fire feedback.
- Per-weapon reload/equip/fire animations.
- Better muzzle flash/smoke/ejection direction.
- Distinct hit/headshot/armor sounds.

## TTK / armor
- Benchmark actual TTK rather than tuning by individual damage numbers.
- Decide whether the desired identity is tactical (short TTK) or arena (longer TTK).
- Current armor + pickups + low pistol damage tends toward spongey engagements.

## AI
- Vertical navigation.
- Cover selection based on tactical geometry, not nearby blocker heuristic alone.
- Visibility/light awareness.
- Better hearing/occlusion.
- Reaction based on surprise angle.
- Roles/loadouts instead of random gun only.
- Team coordination/flanking instead of independent nearest-target behavior.
- Use common pickup/heal/ammo systems so AI follows player-visible rules.

## Maps
- More intentional sightline lengths tied to weapon roles.
- Predictable, authored cover for competitive readability.
- Seed or remove random collidable dungeon dressing.
- Add callouts/location identity if Blackout mode is pursued.
- More bot-valid vertical traversal.

## Audio
- Spatial explosions/grenades.
- Surface-aware footsteps and landing sounds.
- Occluded gunfire filtering.
- Reload magazine/bolt/slide layers.
- Room/reverb variation.

## HUD
- Dynamic crosshair.
- Remove fake progression card until real.
- Stronger armor-hit/headshot differentiation.
- Optional damage numbers for a more grounded shooter style.
- Clear spawn-protection indicator if protection remains.

---

# Recommended implementation order

## Phase 0 — Protect the project before changing feel
1. Add Playwright smoke tests.
2. Add formatter/linter and `package.json` for development only.
3. Fix pause/settings simulation state.
4. Fix team grenade/scoring rules.
5. Fix rotated prop colliders.
6. Fix crouch hitbox/clearance.
7. Fix simulation-clock/substep problem.

## Phase 1 — Extract merge-safe modules
Do **pure moves first** with no tuning changes. Keep each extraction in its own PR:
1. settings/config
2. audio
3. effects
4. maps
5. HUD
6. weapons
7. bots
8. player/input
9. match/main loop

After each extraction, run smoke tests and merge to `master` before starting the next overlapping extraction.

## Phase 2 — Shooter feel
1. Character controller / stance.
2. Recoil + accuracy model.
3. weapon timing/reload behaviors.
4. TTK/armor pass.
5. audio feedback.
6. AI/nav upgrade.
7. map balance.

## Phase 3 — Larger game modes such as Blackout
Only after modules/tests exist.

---

# Claude Code vs Codex task allocation

The most important rule is **file ownership beats feature ownership**. Two assistants should not simultaneously make broad edits to `game.js`.

## Recommended roles

### Codex — core correctness, systems, tests, refactors
Best initial ownership:
- simulation clock / fixed timestep
- player collision/crouch correctness
- weapons/damage/team-rule correctness
- test harness and deterministic smoke tests
- module extraction
- performance-sensitive structural work
- merge/integration reviews

Suggested Codex branch series:
- `codex/test-harness`
- `codex/pause-simulation`
- `codex/combat-correctness`
- `codex/player-controller`
- `codex/module-<name>`

### Claude Code — UI/UX, content, isolated presentation systems, then AI/maps after extraction
Best initial ownership while Codex is still in core `game.js`:
- `ui-overhaul.css`
- additive `index.html` hooks only
- menu/HUD visual polish
- accessibility/readability
- docs/GDD cleanup
- asset selection/presentation

After modules exist, Claude can own isolated gameplay files such as:
- `src/bots.js`
- `src/maps.js`
- `src/hud.js`

while Codex owns, for example:
- `src/player.js`
- `src/weapons.js`
- `src/physics.js`
- `src/match.js`

This avoids both agents editing the same file.

---

# Parallel-work protocol to prevent merge conflicts

## Rule 1 — Never let both agents edit the same high-churn file
Until modularization:
- only one assistant edits `game.js` at a time;
- the other works on CSS/docs/tests or waits for a merged boundary extraction.

## Rule 2 — Branch from the same fresh `master`
Before assigning work:

```bash
git checkout master
git pull --ff-only
git checkout -b codex/<task>
# separate worktree for Claude
git worktree add ../shooting-game-claude -b claude/<task> master
```

Use **separate worktrees/directories**. Never point two agents at the same working tree.

## Rule 3 — Write explicit file ownership into each task prompt
Example:

**Codex task:**
> Own only `src/player.js`, `src/physics.js`, and related tests. Do not edit `src/bots.js`, `src/maps.js`, CSS, or unrelated files.

**Claude task:**
> Own only `src/bots.js` and `src/maps.js`. Do not edit player/physics/weapons files. If an API change is needed, document the requested interface instead of editing the other owner's file.

## Rule 4 — Integrate through small PRs, never giant parallel branches
Ideal PR size:
- one bug or one module extraction;
- no unrelated formatting;
- no drive-by renames;
- no “while I was here” changes.

## Rule 5 — Define interfaces before coding dependent features
Example shared contract:

```js
// combat API
applyDamage(target, amount, source, hitInfo)

// input API
input.getMoveVector()
input.consumeJumpPressed()
input.isAimHeld()

// map API
map.getSpawnCandidates(team)
map.raycastWorld(from, to)
```

Both agents code against the contract instead of reaching into each other's globals.

## Rule 6 — Rebase/update before requesting merge
Before PR review:

```bash
git fetch origin
git rebase origin/master
npm test
npm run test:e2e
```

Resolve conflicts on the feature branch, not during the final merge.

## Rule 7 — Merge foundational changes first
Recommended order when two PRs depend on shared code:
1. contracts/module extraction
2. tests
3. core correctness
4. isolated feature branches
5. UI polish

## Rule 8 — Use one integration owner
Have Codex (or you) perform the final integration review after both assistants finish. The integration owner checks:
- changed file overlap;
- duplicate implementations;
- conflicting constants;
- gameplay clock assumptions;
- settings schema changes;
- DOM ID changes;
- service-worker cache version if source/asset behavior changed.

---

# Concrete two-assistant plan for the next sprint

## Sprint A — can run mostly in parallel

### Codex
1. Add automated smoke-test/dev tooling.
2. Fix BUG-001/002 pause/settings simulation.
3. Fix BUG-005 grenade friendly fire/scoring.
4. Fix BUG-006 rotated colliders.
5. Add regression tests for those cases where possible.

**Files:** `game.js`, new test/dev files.  
**Do not edit:** `ui-overhaul.css`; avoid `index.html` unless a test hook is truly required.

### Claude Code
1. Audit UI readability/responsiveness only.
2. Remove/fix fake profile presentation (BUG-058/059) if desired.
3. Polish HUD/menu in `ui-overhaul.css`.
4. Do not alter runtime IDs or gameplay JS.

**Files:** `ui-overhaul.css`; additive `index.html` only if necessary.

These two branches have minimal overlap.

## Sprint B — sequential foundation, then parallel

### Codex first
Extract player/physics/weapons/bots/maps into modules without changing behavior.

### Then parallel
**Codex:** player controller + recoil/weapon correctness.  
**Claude:** bot AI + maps/navigation.  

Because they now own different files, both can move quickly with low merge risk.

---

# Definition of done for bug fixes

Every gameplay PR should state:
- exact bug ID(s) fixed;
- files owned/changed;
- reproduction before fix;
- behavior after fix;
- automated test added where feasible;
- Warehouse tested;
- Dungeon tested;
- DM tested;
- TDM tested when combat/scoring affected;
- Survival tested when bots/performance affected;
- mouse/keyboard tested;
- controller tested if input changed;
- pause/settings/pointer lock tested if UI/input changed.

---

# Highest-value first 12 tickets

1. **BUG-001/002** Real pause state.
2. **BUG-003/030** Unified simulation timing / fixed-step correction.
3. **BUG-005** Friendly grenade/scoring rules.
4. **BUG-004/014/016** Crouch collider + hitbox + clearance correctness.
5. **BUG-006** Rotated prop colliders.
6. **BUG-008/009/010** Settings/FOV/view-bob correctness.
7. **BUG-011/012/013** Controller/toggle input cleanup.
8. **BUG-071/072** Test harness + CI.
9. **BUG-007/079/080** Module/state refactor.
10. **BUG-020/021** Dynamic crosshair + recoil model.
11. **BUG-022/023/024/025** Weapon role/timing pass.
12. **BUG-031/032/035** Survival scalability + AI navigation.

---

## Final assessment

The game does **not** need a rewrite to become much better. It needs a short correctness/stability phase, then modularization, then a deliberate shooter-feel pass. The current code already shows good engineering instincts in several places (swept projectile collision, light pooling, particle pooling, map fallbacks, LOS-gated nameplates, per-map nav tuning). The next gains will come less from adding more features and more from making timing, movement, combat state, feedback, and architecture consistent.
