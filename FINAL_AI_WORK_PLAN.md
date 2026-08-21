# OVERRUN — FINAL AI WORK PLAN

**Repository:** `DH4410/shooting-game`  
**Planning branch:** `codex/shooter-audit-2026-08-21`  
**Default production branch:** `master` (NOT `main`)  
**Inputs merged:** `codexbugs.md` + `claudebugs.md` + direct verification of disputed findings  
**Purpose:** This is the single source of truth for Claude Code and Codex. Do not independently reinterpret the old audit files as separate task lists.

---

# 0. INSTRUCTIONS TO THE AI READING THIS FILE

If you are **Claude Code**, execute only tasks explicitly assigned to the **CLAUDE lane** for the current phase. Do not take Codex-owned work “while you are here.”

If you are **Codex**, execute only tasks explicitly assigned to the **CODEX lane** for the current phase. Do not take Claude-owned work “while you are here.”

Both agents must obey these rules:

1. **Do not implement directly on `codex/shooter-audit-2026-08-21`.** It is the shared planning baseline.
2. Create your own branch and your own worktree/directory from the same planning commit.
3. **Never let both agents edit `game.js` concurrently.** Until modularization, it has one owner at a time.
4. Never run two agents in the same working directory.
5. One logical bug/task per commit when practical.
6. Do not perform unrelated formatting, reindentation, renaming, or cleanup in a bug-fix commit.
7. Do not change gameplay tuning just because a value “looks wrong.” Reproduce/measure first when a task is marked PLAYTEST or BALANCE.
8. Do not delete the audit files or this plan.
9. Before completing a task, inspect the actual current code; line numbers in audits can drift.
10. Every gameplay change must be tested on both maps when the affected subsystem exists on both maps.
11. `master` is the final branch. Do not use instructions that refer to a nonexistent `main` branch.
12. If a task requires changing a file owned by the other agent, stop at the interface boundary and write the requested API/change in your handoff instead of editing that file.

---

# 1. MODEL SELECTION

Model availability changes, so use the strongest listed model available in the local tool.

## Claude Code

### Use **Claude Opus 5 — high effort** for:
- the initial monolithic `game.js` correctness pass;
- simulation/app-state changes;
- crouch/hitbox/collision work;
- combat/team-rule fixes;
- complex AI behavior after modules are extracted;
- any change that crosses multiple gameplay subsystems.

This project is exactly where higher reasoning is worth the usage: one ~226 KB gameplay file contains many shared globals and hidden coupling.

### Use **Claude Sonnet 5 — medium/high effort** for:
- `ui-overhaul.css` work;
- documentation;
- bounded HUD presentation work;
- small isolated fixes after module boundaries exist;
- repetitive low-risk cleanup.

Do **not** use a small/fast model for physics, timing, scoring, hit detection, state-machine, or merge-resolution changes.

## Codex

### Use **GPT-5.6 Sol — xhigh reasoning** for:
- test/CI architecture;
- final code review and integration review;
- simulation-clock verification;
- module extraction;
- player/physics/weapons/match modules after extraction;
- performance-sensitive refactors;
- difficult regressions or merge conflict resolution.

Use **max reasoning** only for the hardest architecture/integration pass if available and useful.

### Use **GPT-5.6 Terra — medium/high** for:
- routine test expansion;
- mechanical module cleanup after interfaces are settled;
- low-risk repetitive changes.

### Fallback
If GPT-5.6 Sol is not selectable inside the installed Codex product, use **GPT-5.3-Codex with high/xhigh reasoning** for coding-agent work.

Do not use Luna/mini-class models for the core correctness tasks in this plan.

---

# 2. IMPORTANT RECONCILIATION OF THE TWO AUDITS

The Claude audit found useful issues, but several claims must **not** be implemented as written.

## REJECTED / CORRECTED CLAUDE FINDINGS

### CL-CORR-01 — “Gamepad RT double-fires the AR” is NOT currently a double-fire bug
`pollGamepad()` does call `tryFire()` twice on the first held-RT frame for an automatic weapon, but the first successful call sets `player.cooldown`. The second call immediately returns because cooldown is now greater than zero.

**Action:** clean up the redundant call only if touching controller input anyway, and add a fire-rate regression test. Do **not** claim it currently doubles AR rate.

### CL-CORR-02 — COVER `stateTime === 0` check is dead, but COVER still calls `findCover()`
`setState(ST.COVER)` already calls `findCover()`. The `stateTime === 0` branch is ineffective/dead logic, but the audit conclusion that bots therefore fail to plan cover on entry is incorrect.

**Action:** remove/simplify the dead condition when refactoring the state machine; do not treat it as a P1 behavioral fix without reproduction.

### CL-CORR-03 — `_lastAimTarget` being undefined does NOT give perfect first-target aim
On first acquisition, the inequality resets `aimSettle` to zero. In the current aim formula, zero `aimSettle` produces the **maximum fresh-target snap penalty**, not perfect aim.

**Action:** initialize `_lastAimTarget = null` for clarity/testability only. No balance change is required for this finding.

### CL-CORR-04 — Bots having zero armor is a balance choice, not a correctness bug
The asymmetry is real, but changing it blindly changes TTK and difficulty. The previous report also overstated the magnitude.

**Action:** leave bot armor at zero until the TTK/balance benchmark task. Then decide intentionally whether visible bot classes should have armor.

### CL-CORR-05 — The reported missing GLB assets are PRESENT
The following current paths were directly verified in the repository:
- `assets/models/hopper-round.glb`
- `assets/models/machine-fortified.glb`
- `assets/models/machine.glb`
- `assets/models/piston-round.glb`
- `assets/models/dungeon/template-floor.glb`

**Action:** DO NOT replace these paths or substitute other models as a “bug fix.”

### CL-CORR-06 — Do not expose a general FOV slider as part of this bug pass
The repository UI contract explicitly treats player FOV as a deliberate gameplay constraint. The real bug is that the fixed-FOV idea is inconsistent in code: `settings.fov` is 68 while runtime hip fire targets 78 and ADS targets 68.

**Action:** define intentional HIP/ADS/SCOPE FOV constants/behavior and keep the setting contract honest. A user FOV slider is a separate product decision, not a bug fix.

### CL-CORR-07 — 22 m bot footstep range is tuning, not an objective bug
**Action:** include it in the audio playtest. Do not hard-change to 10/12/14 m without listening/measurement on both maps.

---

# 3. UNIFIED PROBLEM BACKLOG

This section covers every issue from `codexbugs.md`, incorporates the valid additions from `claudebugs.md`, and consolidates duplicates. IDs in parentheses refer to the original Codex audit.

## A. CORRECTNESS / STABILITY — FIX FIRST

### CORE-01 — Real app/pause/settings state
**Covers:** BUG-001, BUG-002, BUG-080  
**Priority:** P0  
**Current owner:** CLAUDE

Problems:
- Pause overlay does not pause simulation.
- Settings opened during a match does not pause simulation.
- State is spread across booleans (`match.running`, pointer lock, pause overlay, settings visibility, death state), allowing invalid combinations.

Required outcome:
- explicit application/simulation state such as MENU / PLAYING / PAUSED / SETTINGS / ENDED;
- manual pause freezes match clock, bots, bullets, grenades, player timers, pickups and gameplay simulation;
- death/respawn overlay is NOT treated as manual pause;
- settings opened from gameplay freezes gameplay until settings closes and pointer lock is reacquired;
- losing pointer lock intentionally produces pause, not continued combat.

### CORE-02 — One consistent simulation clock
**Covers:** BUG-003, BUG-030  
**Priority:** P0  
**Current owner:** CLAUDE implementation; CODEX verification

Problems:
- 120 Hz × 3 max substeps covers only 25 ms of simulation per render frame;
- at sustained low FPS, physics time can lag real/render time;
- bots advance gameplay timers on frame `dt` while player/bullets use fixed physics steps.

Required outcome:
- gameplay behavior should remain approximately consistent at 120/60/30 render FPS;
- player, bullets, bot gameplay timers/movement and relevant grenade simulation use a coherent simulation timeline;
- avoid spiral-of-death catch-up behavior;
- do not simply move one call into fixed step without checking update order (bot velocity must affect the intended physics step, animation can remain render-facing if separated).

Preferred validation:
- automated or scripted 10-second simulation comparison at multiple render-rate caps;
- compare player travel distance, bot cooldown elapsed, projectile distance and match time.

### CORE-03 — TDM explosive friendly-fire and scoring rules
**Covers:** BUG-005  
**Priority:** P0  
**Current owner:** CLAUDE

Problems:
- bullet path filters same-team hits;
- grenade radial damage does not;
- a grenade teamkill can increase the killer team's score.

Required outcome for current arcade TDM:
- friendly-fire OFF for allied damage to match gunfire behavior;
- self-damage may remain if intended;
- allied grenade kills must never award positive score;
- decide whether allied grenade knockback is also disabled; default recommendation is disable allied knockback with friendly fire off;
- add regression coverage.

### CORE-04 — Player crouch stance correctness
**Covers:** BUG-004, BUG-014, BUG-016; related BUG-015  
**Priority:** P0/P1  
**Current owner:** CLAUDE for safe current-controller fix; CODEX for later controller replacement

Problems:
- physics radius/camera change while combat hitbox profile stays standing-shaped;
- standing up has no overhead clearance test;
- crouching makes player narrower because the sphere radius shrinks;
- single-sphere controller creates many compensating hacks.

Immediate required outcome WITHOUT a risky full controller rewrite:
- standing/crouched combat hitbox and AI target point agree with camera/stance;
- standing is blocked under low ceilings;
- no solver launch/pop from uncrouching;
- add a crouch regression scenario.

Later outcome:
- replace sphere character body with capsule/compound/kinematic capsule after tests exist.

### CORE-05 — Rotated prop collision and nav-footprint consistency
**Covers:** BUG-006, BUG-042  
**Priority:** P0/P1  
**Current owner:** CLAUDE

Problems:
- visual GLB can rotate while Cannon box stays axis-aligned;
- arbitrary 0.4/0.6 rad and 45-degree props can disagree visibly with collision;
- ramp/nav blocker approximation is asymmetric.

Required outcome:
- physics collider rotation matches visual gameplay prop yaw;
- blocker/nav footprint either supports rotation correctly or uses a conservative documented approximation;
- verify warehouse diagonal shelf and other non-90-degree placements.

### CORE-06 — Input/settings correctness
**Covers:** BUG-008, BUG-009, BUG-010, BUG-011, BUG-012, BUG-013, BUG-018; Claude scoped-sensitivity/viewBob findings; CL-CORR-01  
**Priority:** P1  
**Current owner:** CLAUDE

Required fixes:
- wire `viewBob` so it actually controls viewmodel bob;
- make HIP/ADS/SCOPE FOV behavior explicit and internally consistent, without adding an FOV slider in this pass;
- make ADS setting affect scoped aiming predictably (or add a separate scope multiplier if product chooses it);
- implement gamepad toggle ADS with an edge-triggered latch;
- resolve controller crouch hold/toggle semantics cleanly;
- weapon switching must not force a toggle-crouched player to stand or silently clear stance;
- decide/document whether held Space auto-bunny-hop is intentional; recommendation for tactical feel is edge-triggered jump with a small input buffer;
- remove the redundant double `tryFire()` controller path while preserving correct weapon cooldown behavior;
- add controller fire-rate/ADS/crouch tests where feasible.

### CORE-07 — Time-limit, scoreboard and spawn-rule correctness
**Covers:** BUG-038, BUG-039, BUG-040, BUG-041  
**Priority:** P1  
**Current owner:** CLAUDE after CORE-01..06

Required fixes/decisions:
- one canonical leader score source in DM;
- ties must produce DRAW or explicit overtime, not automatic player/Blue win;
- spawn scoring should consider LOS/danger in addition to distance;
- spawn protection should end on offensive action (fire/throw) if retained, preventing invulnerable pushes.

### CORE-08 — DOM/name robustness
**Covers:** BUG-064, BUG-065; Claude BUG-09  
**Priority:** P2 correctness/security hygiene  
**Current owner:** CLAUDE only if already touching HUD JS; otherwise defer until `src/hud.js`

Required outcome:
- player names and bot names are inserted using `textContent`/DOM construction, not interpolated `innerHTML`;
- preserve styling without allowing markup injection.

### CORE-09 — Test/dev/CI baseline
**Covers:** BUG-071, BUG-072  
**Priority:** P0 for safe future work  
**Current owner:** CODEX

Required files should be new whenever possible:
- `package.json` for development tooling (production can remain build-free);
- browser smoke tests (Playwright preferred);
- unit tests for pure helpers as modules appear;
- `.github/workflows/...` CI;
- formatter/linter configuration if useful;
- no production bundler is required just to add tests.

Minimum smoke coverage:
- boot reaches DEPLOY;
- start Warehouse DM;
- movement changes position;
- fire decrements ammo at the correct rate;
- reload transfers ammo;
- weapon switching works;
- pause freezes match time;
- settings freezes gameplay;
- crouch/stand safe behavior;
- grenade team rules in TDM;
- both maps create valid spawns/nav;
- bot death/respawn behavior;
- Survival wave transition.

---

## B. SHOOTER FEEL — IMPLEMENT AFTER CORRECTNESS BASELINE

### FEEL-01 — Character movement model
**Covers:** BUG-015, BUG-017, BUG-018, BUG-054  
**Priority:** P1 experience  
**Owner after modularization:** CODEX (`src/player.js`, `src/physics.js`)

Tasks:
- capsule-like controller/stance;
- explicit ground acceleration, braking, air control and counter-strafe behavior;
- decide bunny-hop policy;
- crouch transition instead of instantaneous shape hack;
- landing event, landing sound/weapon response;
- benchmark movement rather than guessing constants.

### FEEL-02 — Accuracy, recoil and crosshair
**Covers:** BUG-019, BUG-020, BUG-021  
**Priority:** P1 experience  
**Owner after modularization:** CODEX (`src/weapons.js`, `src/player.js`); CLAUDE styles HUD only

Tasks:
- per-weapon standing/moving/crouched/airborne/ADS spread;
- first-shot accuracy and sustained-fire bloom/recovery;
- dynamic crosshair reflecting actual dispersion;
- deterministic/learnable recoil pattern plus limited noise;
- separate recoil reset delay and recovery;
- keep player compensation meaningful.

### FEEL-03 — Weapon role/timing model
**Covers:** BUG-022, BUG-023, BUG-024, BUG-025, BUG-026, BUG-027, BUG-028, BUG-055  
**Priority:** P1 experience  
**Owner after modularization:** CODEX (`src/weapons.js`)

Tasks:
- weapon-specific range falloff;
- controlled shotgun cone/pattern;
- equip/holster timing;
- reload state and interruption rules;
- shotgun shell-by-shell reload if keeping pump/shotgun identity;
- explicit auto-reload policy;
- sniper bolt/chamber cycle and scope behavior;
- dry-fire feedback;
- reduce/reshape ammo economy only after pacing measurement.

### FEEL-04 — TTK / armor benchmark before balance changes
**Covers:** BUG-029, BUG-034; Claude bot-armor suggestion  
**Priority:** P1 balance  
**Owners:** CODEX benchmark + CLAUDE design review

Benchmark at minimum:
- every gun at 5 m / 15 m / 30 m;
- body vs head where relevant;
- 0 / 50 / 100 armor;
- stationary and moving target hit-rate samples;
- medium/hard bot time-to-kill against player.

Do not add bot armor, reduce player armor, or change weapon damage until this table exists.

---

## C. AI / MAP GAMEPLAY

### AI-01 — Survival scalability
**Covers:** BUG-031, BUG-032, BUG-073  
**Priority:** P1  
**Owner after modules:** CLAUDE for gameplay design in `src/bots.js`; CODEX for profiling/optimization support

Tasks:
- hard cap simultaneous living enemies;
- increase later-wave challenge using spawn cadence/skill/roles/elites rather than unlimited concurrency;
- replace O(n²) separation with local spatial neighborhood if profile shows it needed;
- reduce bullet-vs-all-combatants scaling as bot counts rise.

Do not blindly set the cap to 16 without measuring target hardware; 16 is a candidate, not a law.

### AI-02 — Fair, readable bot rules
**Covers:** BUG-033, BUG-034, BUG-037; CL-CORR-02, CL-CORR-03, CL-CORR-07  
**Priority:** P1/P2  
**Owner after modules:** CLAUDE (`src/bots.js`, `src/audio.js` where allowed)

Tasks:
- remove unexplained passive 12 HP “cover healing” or make bots use visible pickups/resources;
- decide bot armor only through FEEL-04;
- improve hearing/occlusion instead of simple 20 m through-wall sphere;
- initialize `_lastAimTarget = null` for clarity when refactoring, but do not retune aim because of the false “perfect aim” claim;
- remove dead COVER-entry condition while preserving `setState(ST.COVER)` cover planning;
- playtest bot footstep range by map before changing 22 m threshold.

### AI-03 — 3D navigation and tactical behavior
**Covers:** BUG-035, BUG-036  
**Priority:** P1 major improvement  
**Owner after modules:** CLAUDE (`src/bots.js`, `src/maps.js`)

Tasks:
- elevated waypoint/nav links or navmesh so bots can use ramps/catwalks/perches;
- illumination-aware perception before Blackout Phase;
- later: role/loadout coordination, flanking, tactical cover selection.

### MAP-01 — Deterministic gameplay map generation
**Covers:** BUG-043, BUG-044  
**Priority:** P1/P2  
**Owner after modules:** CLAUDE (`src/maps.js`)

Tasks:
- gameplay-affecting random dungeon props should be authored or seeded;
- split gameplay RNG from cosmetic RNG;
- make nav/spawn bug reproduction deterministic.

---

## D. GRAPHICS / PERFORMANCE

### PERF-01 — Graphics settings must correspond to real behavior
**Covers:** BUG-045, BUG-046, BUG-047, BUG-048  
**Priority:** P2  
**Owner after module extraction:** CODEX renderer/settings side

Tasks:
- account for fixed world muzzle flash light in documented light budget;
- apply quality anisotropy rather than always `MAX_ANISO`;
- remove or replace nonfunctional runtime MSAA `antialias` knob;
- do not render minimap pass when UI intentionally disables it.

### PERF-02 — Mobile/product scope honesty
**Covers:** BUG-049  
**Priority:** P2 product decision  
**Owner:** CLAUDE UI/product lane

Choose one:
- add touch shooter controls later; OR
- clearly mark keyboard/mouse/gamepad desktop requirement and avoid implying touch playability.

### PERF-03 — Runtime hot paths
**Covers:** BUG-073, BUG-074, BUG-075, BUG-076, BUG-077  
**Priority:** P2; profile first  
**Owner:** CODEX

Tasks only after profiling:
- combatant broadphase for bullets;
- dense active particle indices if particle scan is material;
- smoke material/sprite pooling/instancing;
- reduce hot-path allocations;
- pool high-frequency combat DOM nodes only if layout/GC profiling justifies it.

---

## E. AUDIO / COMBAT FEEDBACK

### AUDIO-01 — Positional combat audio
**Covers:** BUG-050, BUG-051  
**Priority:** P2  
**Owner after module extraction:** CLAUDE (`src/audio.js`)

Tasks:
- pan/spatialize explosion audio;
- pan grenade bounce audio;
- preserve distance attenuation.

### AUDIO-02 — Movement and weapon feedback
**Covers:** BUG-052, BUG-053, BUG-054, BUG-055, BUG-056, BUG-057  
**Priority:** P2 shooter feel  
**Owner after modules:** CLAUDE audio; CODEX weapon-state hooks

Tasks:
- surface-aware footsteps;
- walk/sprint/crouch loudness identity;
- landing cue;
- dry-fire cue;
- stronger headshot/armor-hit differentiation;
- smoke visibility parity playtest (human visual gaps vs bot binary smoke block).

---

## F. UI / UX / PRESENTATION

### UI-01 — Fake/static profile presentation
**Covers:** BUG-058, BUG-059  
**Priority:** P2  
**Owner:** CLAUDE Sonnet 5 after core branch is complete, or later dedicated UI branch

Tasks:
- remove `DH4410 / LEVEL 12 / 48% XP` fake progression until real progression exists; OR
- wire it to actual persistent state in a future progression feature;
- callsign and displayed identity must agree.

### UI-02 — Settings performance and correctness
**Covers:** BUG-060, BUG-061  
**Priority:** P2  
**Owner after settings extraction:** CODEX

Tasks:
- avoid full renderer reconfiguration for sensitivity/crosshair/audio-only changes;
- debounce storage writes if useful;
- separate settings application by category/change.

### UI-03 — Scoreboard polish/correctness
**Covers:** BUG-062, BUG-063  
**Priority:** P2/P3  
**Owner:** CLAUDE UI lane

Tasks:
- K/D with zero deaths should display `∞`, `—`, or another intentional convention instead of `kills.toFixed(2)`;
- mode-appropriate scoreboard title if useful.

### UI-04 — Smoke inventory feedback
**Source:** valid Claude BUG-10 addition  
**Priority:** P2 UX  
**Owner:** CODEX gameplay/HUD data hook after `src/hud.js`; CLAUDE CSS styling

Task:
- show the one-life smoke count so `F` does not silently stop working after consumption.

### UI-05 — Dropped pickup animation phase
**Source:** valid Claude BUG-11 addition  
**Priority:** P3 polish  
**Owner:** CLAUDE/low-risk later

Task:
- add per-pickup bob phase so all drops do not move in perfect synchronization.

### UI-06 — Crosshair styles are optional; dynamic accuracy is higher priority
**Source:** Claude S4  
**Priority:** P3 preference  
**Owner:** CLAUDE styling after FEEL-02 data hook exists

Do not spend time on dot/circle presets before the crosshair can communicate actual weapon dispersion.

### UI-07 — CSS architecture cleanup
**Covers:** BUG-082  
**Priority:** P3 architecture  
**Owner:** CLAUDE UI lane, LAST

Do not migrate inline CSS during active gameplay refactors. It creates a huge conflict-prone diff.

---

## G. OFFLINE / DEPLOYMENT / DEPENDENCIES

### DEPLOY-01 — Make offline claim accurate
**Covers:** BUG-066, BUG-067  
**Priority:** P2  
**Owner after core stabilization:** CODEX

Tasks:
- critical CDN JS dependencies must be locally available/vendorable for genuine offline boot;
- precache `ui-overhaul.css` if offline support remains a product claim.

### DEPLOY-02 — Cache/dependency reliability
**Covers:** BUG-068, BUG-069, BUG-070  
**Priority:** P2/P3  
**Owner:** CODEX

Tasks:
- reduce stale asset risk via better version/hash strategy;
- consider vendoring critical runtime dependencies;
- keep Poly Haven textures optional/fallback;
- remove misleading unused `three-pathfinding` import-map entry until actually used.

---

## H. ARCHITECTURE / MAINTAINABILITY

### ARCH-01 — Break up `game.js` without changing behavior
**Covers:** BUG-007, BUG-078, BUG-079, BUG-081, BUG-083  
**Priority:** P0 for real parallel development; after initial correctness pass  
**Sequential owner:** CODEX GPT-5.6 Sol xhigh

Target modules (incremental, not one giant rewrite):

```text
src/
  config.js
  settings.js
  audio.js
  physics.js
  weapons.js
  player.js
  bots.js
  maps.js
  effects.js
  hud.js
  match.js
  input.js
  main.js
```

Rules:
- pure moves first;
- no tuning changes in extraction commits;
- one or a few tightly related modules per PR/commit;
- keep external boot behavior unchanged;
- preserve offline/plain-ES-module operation unless the project explicitly adopts a build step;
- move long historical postmortems to docs while preserving concise invariants near code;
- give each module private scratch vectors rather than global shared scratch state when safe.

### ARCH-02 — Explicit state machines/interfaces
**Covers:** BUG-080, BUG-081  
**Priority:** P1  
**Owner:** CODEX during/after extraction

Target concepts:
- app state: MENU / PLAYING / PAUSED / SETTINGS / ENDED;
- weapon state: IDLE / FIRING / RELOADING / EQUIPPING / COOKING;
- stance state: STAND / CROUCH / AIR;
- immutable gameplay constants separate from runtime quality settings and match rules.

### ARCH-03 — Blackout Phase only after foundation
**Covers:** BUG-083  
**Priority:** planning guardrail  
**Owner:** neither until tests/modules are in place

Do not implement Blackout economy/doors/destructibles/round system while the monolithic state model remains unstable.

---

# 4. PHASED TASK ALLOCATION

## PHASE 1 — RUN IN PARALLEL NOW

### CLAUDE LANE — `game.js` sole owner
**Model:** Claude Opus 5, high effort  
**Branch:** `claude/phase1-core-correctness`  
**Allowed files:** `game.js`; `index.html` ONLY if a correctness fix absolutely requires a new DOM hook.  
**Forbidden files:** `ui-overhaul.css`, `package.json`, `tests/**`, `.github/workflows/**`, `FINAL_AI_WORK_PLAN.md`.

Do in this order:
1. CORE-01 real pause/settings/app state.
2. CORE-02 simulation clock consistency.
3. CORE-03 TDM grenade/friendly-score rules.
4. CORE-04 stance hitbox + overhead clearance on current controller.
5. CORE-05 rotated prop collision/nav consistency.
6. CORE-06 input/settings correctness.
7. CORE-07 tie/spawn/protection correctness.
8. CORE-08 safe DOM name handling only if it remains low-risk in the same pass.

Do NOT:
- add bot armor;
- replace the supposedly “missing” GLBs;
- expose FOV slider;
- rewrite player controller to capsule yet;
- retune all weapon damage/recoil;
- do UI restyling;
- implement Blackout Phase.

### CODEX LANE — tests/CI, NO `game.js`
**Model:** GPT-5.6 Sol, xhigh reasoning  
**Branch:** `codex/phase1-test-harness`  
**Allowed files:** new `package.json`, test config, `tests/**`, `scripts/**`, `.github/workflows/**`, test docs.  
**Forbidden files:** `game.js`, `ui-overhaul.css`, gameplay `index.html` edits.

Tasks:
1. CORE-09 dev/test/CI baseline.
2. Build baseline smoke tests that pass on current code where possible.
3. Add skipped/expected-failure regression specs for current P0 bugs only if necessary; clearly mark them and unskip after integration.
4. Add render-rate test utilities so CORE-02 can be verified after Claude lands.
5. Do a read-only review of Claude's commits after integration; do not independently patch `game.js` on this branch.

---

# 5. WORKTREE / BRANCH SETUP

Run from a clean checkout:

```bash
git fetch origin
git checkout codex/shooter-audit-2026-08-21
git pull --ff-only

# Claude separate directory
git worktree add ../shooting-game-claude \
  -b claude/phase1-core-correctness \
  codex/shooter-audit-2026-08-21

# Codex separate directory
git worktree add ../shooting-game-codex \
  -b codex/phase1-test-harness \
  codex/shooter-audit-2026-08-21
```

Never launch Claude Code and Codex in the same directory.

---

# 6. PHASE 1 INTEGRATION ORDER

Create an integration branch from the planning baseline:

```bash
git checkout -b integration/shooter-stabilization codex/shooter-audit-2026-08-21
```

Recommended order:

1. Merge/rebase the **Codex test-harness** branch if baseline tests pass.
2. Rebase/update the Claude branch against the integration branch if necessary.
3. Merge the **Claude core-correctness** branch.
4. Run the full test suite.
5. Codex performs a **read-only first review**, then creates a small dedicated review-fix branch only if issues are found.
6. Run manual Warehouse + Dungeon checks.
7. Only then merge `integration/shooter-stabilization` into `master`.

Do not resolve feature conflicts directly on `master`.

---

# 7. PHASE 2 — MODULE EXTRACTION (SEQUENTIAL)

After Phase 1 is stable, **Codex owns `game.js` exclusively** for behavior-preserving extraction.

**Model:** GPT-5.6 Sol, xhigh; use max for hardest integration if needed.  
**Claude during this time:** Sonnet 5 may work only on `ui-overhaul.css`, docs, and explicitly non-overlapping assets.

Suggested extraction sequence:
1. config/settings
2. audio
3. effects
4. HUD
5. maps
6. weapons
7. bots
8. player/input/physics
9. match/main loop

After each extraction:
- tests pass;
- game boots;
- both maps start;
- no gameplay tuning change is bundled with the move.

---

# 8. PHASE 3 — TRUE PARALLEL GAMEPLAY WORK

Once modules exist, parallelism becomes safe.

## CODEX ownership
**Model:** GPT-5.6 Sol xhigh  
**Files:**
- `src/player.js`
- `src/physics.js`
- `src/weapons.js`
- `src/match.js`
- related tests

Tasks:
- FEEL-01 movement/controller upgrade;
- FEEL-02 recoil/accuracy mechanics and HUD data interface;
- FEEL-03 weapon timing/reload/falloff;
- FEEL-04 TTK benchmark tooling;
- PERF-01/03 systems work;
- UI-02 settings architecture;
- deployment tasks when gameplay is stable.

## CLAUDE ownership
**Model:** Opus 5 high for AI/maps; Sonnet 5 for UI/audio polish  
**Files:**
- `src/bots.js`
- `src/maps.js`
- `src/audio.js`
- `src/hud.js` presentation-facing portions by agreed interface
- `ui-overhaul.css`
- docs

Tasks:
- AI-01 survival design/cap behavior;
- AI-02 fair bot rules;
- AI-03 vertical/tactical navigation and lighting awareness;
- MAP-01 deterministic map gameplay content;
- AUDIO-01/02;
- UI-01/03/05/06/07;
- PERF-02 product-scope UI.

### Shared-interface rule
If Claude needs a weapon/player value, Codex exposes it through an agreed interface. Claude does not reach into `src/weapons.js` to change it. If Codex needs a bot/map API, Claude exposes it; Codex does not edit `src/bots.js` or `src/maps.js`.

---

# 9. SHARED INTERFACE EXAMPLES

Agree interfaces before dependent work, for example:

```js
// combat
applyDamage(target, amount, source, hitInfo)

// input
input.getMoveVector()
input.consumeJumpPressed()
input.isAimHeld()
input.consumeAimToggle()

// player
player.getStanceProfile()
player.getAccuracyState()

// weapons
weapons.getCurrentSpreadState()
weapons.getCurrentWeaponState()

// map
map.getSpawnCandidates(team)
map.raycastWorld(from, to)
map.getSurfaceAt(position)

// bots
bots.getLivingEnemies(team)
bots.notifySound(event)
```

The exact API can differ; the important part is that ownership is explicit.

---

# 10. CONFLICT-PREVENTION RULES

## Absolute rules
- One active owner per high-churn file.
- Separate worktrees.
- No drive-by formatting.
- No broad search/replace across shared files.
- No renaming runtime DOM IDs without coordinated migration.
- No changing the service-worker cache key casually just because source code changed; change it when cache behavior/assets require it.
- Never silently resolve a conflict by choosing “ours” or “theirs” for all of `game.js`.

## Commit discipline
Good commit examples:
- `fix: pause freezes simulation`
- `fix: reject allied frag damage in TDM`
- `fix: rotate prop colliders with visual yaw`
- `test: cover pause and TDM frag scoring`
- `refactor: extract audio module without behavior change`

Bad commit example:
- `fix gameplay and polish everything`

## Before merging any branch
```bash
git fetch origin
git rebase origin/master   # only when the branch is actually targeting current master
npm test
npm run test:e2e
```

For branches targeting the integration branch, rebase onto the integration branch instead of `origin/master`.

---

# 11. DEFINITION OF DONE FOR EVERY GAMEPLAY FIX

A gameplay PR/branch is not done because the code “looks right.” It must include:

- bug/task IDs addressed;
- exact reproduction or rationale;
- files changed;
- behavior before/after;
- automated regression test where feasible;
- Warehouse check;
- Dungeon check;
- relevant DM/TDM/Survival check;
- keyboard/mouse check;
- controller check if input changed;
- pause/settings/pointer-lock check if app-state input changed;
- no new console errors;
- no unexpected asset 404s;
- no unrelated file churn.

---

# 12. MANUAL SHOOTER PLAYTEST AFTER CORRECTNESS

Before changing balance values, record a baseline for:

- 60-second movement feel: start/stop, strafe reversal, sprint, crouch, jump, landing;
- AR 10-bullet and 30-bullet sprays at 10/20/30 m;
- pistol rapid-fire grouping;
- shotgun pellet grouping and kill distance;
- sniper body/head behavior with armor;
- TTK for each weapon vs 0/50/100 armor;
- bot hit rate and TTK on easy/medium/hard at 15/30 m;
- spawn safety on both maps;
- footstep audibility on both maps;
- smoke readability for human vs bot;
- 30 FPS vs 60 FPS behavior;
- Survival performance at increasing waves.

Use the results to tune. Do not tune from aesthetics alone.

---

# 13. PRIORITY ORDER — THE SHORT VERSION

If there is ever uncertainty about what to do next, use this order:

1. Tests/dev harness.
2. Real pause/settings state.
3. Simulation-clock consistency.
4. TDM grenade/scoring correctness.
5. Crouch/hitbox/stand-clearance correctness.
6. Rotated collision/nav correctness.
7. Controller/settings correctness.
8. Tie/spawn/protection rules.
9. Modularize `game.js` with behavior preserved.
10. Measure movement/gunplay/TTK baseline.
11. Character controller + recoil/accuracy + weapon timing.
12. Survival/bot/nav upgrades.
13. Audio/HUD feedback.
14. Performance hot paths.
15. Offline/dependency cleanup.
16. Only then begin Blackout Phase implementation.

---

# 14. FINAL NOTE TO CLAUDE CODE

You are likely receiving this file first. **Do not attempt to “complete the whole backlog” in one branch.** Your first assignment is the PHASE 1 CLAUDE lane only, using **Claude Opus 5 at high effort**. The purpose is to make `game.js` correct and stable while Codex independently builds the test/CI baseline.

Read `Agents.md`, `READMEFORUI.md`, `codexbugs.md`, and this file before editing. Treat this file as authoritative where it disagrees with `claudebugs.md`.

When Phase 1 is complete, report:
- commit SHAs;
- task IDs completed;
- tests/manual checks performed;
- any behavior you intentionally did NOT change;
- any requested interface/change that belongs to Codex.

Do not start module extraction or the shooter-feel rebalance in the same Phase 1 branch.