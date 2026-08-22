# Phase 3 Playtest Plan

Authored after Phase 2 validation was completed. Phase 2 is stable:
- 3 unit tests pass
- 14 Playwright tests pass
- Two extraction regressions found and fixed (`_rayFrom` in maps.js, `_v1` in main.js)
- Test harness hardened against false-green stale-server scenario

## Playtest Findings

| # | Finding | Priority |
|---|---------|----------|
| P1 | Sprint is unlimited — holding Shift is always optimal, removes decision | High |
| P2 | Damage numbers (e.g. "6") are unclear; no remaining-HP or heavy-hit feedback | High |
| P3 | Kill feed too far right; want centered "YOU ELIMINATED …" confirmation | Medium |
| P4 | Scoreboard goes behind death overlay | Medium |
| P5 | Text/UI contrast poor, especially leaderboard | Medium |
| P6 | Bot movement/animation mismatch; no dodge/crouch/jump AI | High |
| P7 | Smoke too small/weak; enemy names visible through smoke | Medium |
| P8 | Grenade VFX weak; no clear damage-occurred feedback | Medium |
| P9 | Grenade trajectory unpredictable; no arc preview | Medium |
| P10 | Too much floor loot; ammo useless (spawn reserves huge), weapon pickups redundant | Low |
| P11 | Ground weapon/ammo visuals poor | Low |
| P12 | Player movement functional but lacks "feel" polish | Medium |
| P13 | No first-person hand/arm on weapon | Low |
| P14 | UI feels generic/AI-generated | Medium |

---

## Module Ownership Map

| Module | Lines | Owner | Relevant Findings |
|--------|-------|-------|-------------------|
| `src/bots.js` | 853 | Claude | P6 (AI movement/dodge/crouch/jump) |
| `src/player.js` | 626 | Codex | P1 (sprint system), P12 (movement feel) |
| `src/effects.js` | 454 | Claude | P7 (smoke), P8 (grenade VFX) |
| `src/hud.js` | 368 | Claude | P2 (damage feedback), P3 (kill feed), P4 (scoreboard z-order), P5 (contrast) |
| `src/ui.js` | 194 | Claude | P14 (UI polish), P5 (contrast) |
| `src/projectiles.js` | 337 | Codex | P9 (grenade trajectory) |
| `src/pickups.js` | 363 | Codex | P10 (loot rules), P11 (visuals) |
| `src/match.js` | 326 | Codex | P10 (spawn-reserve tuning) |
| `src/weapons.js` | 424 | Codex | P13 (viewmodel hand) |
| `src/rendering.js` | 53 | — | — |
| `src/maps.js` | 1332 | — | — |
| `src/main.js` | 1069 | — | orchestration only |
| `src/audio.js` | 142 | Claude | P8 (explosion audio feedback) |
| `src/config.js` | 72 | Codex | P1 (sprint constants), P10 (reserve ammo) |

---

## Task Breakdown

### PHASE3-01 — Sprint redesign [Codex] [P1]
**Module:** `src/player.js`, `src/config.js`
**Behavior:** Replace unlimited sprint with a stamina model. Sprint depletes over ~3 s, recovers over ~4 s while walking/idle. HUD stamina bar (small, below ammo). Crouching does not drain. Sprint cancel on crouch.
**Interfaces:** `player.stamina` state added; `src/hud.js` reads it to show bar.
**Tests:** Unit: stamina drains at correct rate; recovers while not sprinting. E2E: player cannot maintain sprint indefinitely.
**No overlap with:** P12 (movement feel) — that is a feel pass, not a design change.

### PHASE3-02 — Damage feedback overhaul [Claude] [P2]
**Module:** `src/hud.js`
**Behavior:**
- Floating damage numbers: scale by damage amount (small font < 20, large font ≥ 40, red for heavy)
- "CRITICAL" flash for headshots
- Target HP bar briefly appears above enemy nameplate after being hit
- Screen-edge pulse color intensity scales with damage magnitude
**Interfaces:** `spawnDamageNumber(worldPos, amount, isHead)` already exists — extend parameters.
**Tests:** E2E: after bot is hit, damage number > threshold gets visual class; HP bar appears on nameplate.
**No overlap with:** P3/P4 (layout changes in same file — coordinate commit order, do P2 first).

### PHASE3-03 — Kill confirmation + scoreboard z-order [Claude] [P3, P4]
**Module:** `src/hud.js`, `src/ui.js`
**Behavior:**
- Kill feed moves to center (bottom-third of screen), shows "YOU ELIMINATED [name]" for 2.5 s, then fades. Enemy kills remain in top-right feed.
- Scoreboard (#board) z-index raised above death overlay (#death or equivalent) so Tab always shows scores.
**Interfaces:** Death overlay z-index defined in index.html inline CSS — check and coordinate.
**Tests:** E2E: after player scores a kill, `#kill-confirm` text contains victim name and fades after 2.5 s.
**No overlap with:** P5 (contrast) — separate CSS-only pass.

### PHASE3-04 — UI contrast + polish [Claude] [P5, P14]
**Module:** `src/ui.js`, `ui-overhaul.css`
**Behavior:**
- Leaderboard: increase font size, use colored separators, add subtle background per row.
- All text elements: minimum contrast ratio 4.5:1 against their background.
- Menu: replace generic layout with a styled header, subtle particle or scanline effect in background canvas layer.
**Interfaces:** CSS only — no JS interface changes.
**Tests:** Visual regression baseline (screenshot comparison) against agreed reference.
**No overlap with:** P3 (same file but different DOM sections — do P3 first, P4 after).

### PHASE3-05 — Bot AI: dodge/crouch/jump [Claude] [P6]
**Module:** `src/bots.js`
**Behavior:**
- Dodge: when `incomingProjectile` event fires within 8 m, bot strafes left or right for 0.4–0.8 s (random).
- Crouch: bot crouches when taking fire and cover is within 3 m (uses existing `losClear` for cover check).
- Jump: bot randomly jumps while strafing (10 % chance per 0.8 s while moving).
- Animation speed: `mixer.timeScale` driven by `Math.hypot(vel.x, vel.z)` / WALK_SPEED — clamp 0.3..2.
**Interfaces:** `bot.dodge()`, `bot.tryCrouch()` — internal. No interface change to callers.
**Tests:** E2E: after projectile passes within 8 m of a bot, bot x/z position changes within 0.8 s.

### PHASE3-06 — Smoke overhaul + perception [Claude] [P7]
**Module:** `src/effects.js`, `src/bots.js`
**Behavior:**
- Smoke cloud: expand radius from current to ~5 m over 2.5 s; opacity ramps up then slowly down.
- Enemy nameplates (`#plates` entries) hidden when `losClear(camera, bot.pos)` returns false AND smoke particle overlaps line-of-sight.
- Bots: treat smoke-blocked path as `losClear = false` for targeting — `smokeBlocks()` already exported.
**Interfaces:** `smokeBlocks(from, to)` already exists in effects — use it in bots targeting check.
**Tests:** E2E: after smoke grenade deploys, `bot.target` changes if target is in smoke.

### PHASE3-07 — Grenade VFX + audio [Claude] [P8]
**Module:** `src/effects.js`, `src/audio.js`
**Behavior:**
- Explosion: add a shockwave ring mesh (flat torus, expands 0→6 m, fades over 0.3 s).
- Screen shake magnitude scales with `damage / 100`.
- "DAMAGE" toast shown at screen center when player takes grenade damage ≥ 30.
- Audio: layered explosion — sharp crack + low rumble, distinct from gunfire.
**Interfaces:** `spawnExplosion(pos, radius, damage)` — add `damage` param.
**Tests:** Unit: spawnExplosion with damage≥30 adds damage toast to DOM within 1 frame.

### PHASE3-08 — Grenade trajectory preview [Codex] [P9]
**Module:** `src/projectiles.js`, `src/hud.js`
**Behavior:**
- While cooking a grenade (G held), render a dotted arc using `parabolicArcPoints(origin, dir, power, steps=12)`.
- Arc drawn as THREE.Points in the scene (no UI overlay needed) — auto-removed on release.
- Arc reflects current throw power (cook time) and gravity.
**Interfaces:** `getArcPoints(origin, euler, power)` exported from projectiles.js, consumed by main.js on cook tick.
**Tests:** Unit: `getArcPoints` returns array of Vector3s whose y-values follow parabola. E2E: while cooking, arc geometry is visible in scene.

### PHASE3-09 — Pickup/loot rebalance [Codex] [P10, P11]
**Module:** `src/pickups.js`, `src/match.js`, `src/config.js`
**Behavior:**
- Spawn reserves reduced (config): rifles 1×clip, shotgun 1×clip, pistol 2×clips — force ammo scavenging.
- Ammo pickups: each gives 0.5 magazine only (currently gives full mag).
- Weapon pickups: only spawn if player doesn't already carry that weapon.
- Ground visuals: replace box placeholder with weapon icon billboard (canvas texture, 1 draw call per weapon type).
**Interfaces:** `PICKUP_TYPES` config in `src/config.js` gains `grantAmmo` fractional field.
**Tests:** E2E: player starts with reduced reserves; ammo pickup increments ammo by ≤0.5 mag.

### PHASE3-10 — Movement feel [Codex] [P12]
**Module:** `src/player.js`
**Behavior:**
- Acceleration/deceleration curve: instant velocity → lerp over 4 frames (ground), 8 frames (air).
- Landing squash: 30 ms scale(1, 0.92, 1) → back to (1,1,1) on landing event.
- Head-bob: existing bob already present — increase amplitude slightly for walk (0.012→0.018) when not scoped.
- Footstep audio: trigger audio.play('step', 0.3) every 0.45 s while grounded and moving > 0.5 m/s.
**Interfaces:** `player.velocity` lerp — internal. No public interface change.
**Tests:** E2E: after key-down, player velocity at frame 2 is between 0 and max (not instant max).

---

## Parallelism & Sequencing

```
Wave 1 (independent, run in parallel):
  Claude:  PHASE3-01 sprint — player.js only, no HUD
  Codex:   PHASE3-08 grenade arc — projectiles.js only
  Codex:   PHASE3-09 pickup rebalance — pickups.js/config.js
  Codex:   PHASE3-10 movement feel — player.js only

Wave 2 (after Wave 1 merges):
  Claude:  PHASE3-05 bot AI — bots.js only
  Claude:  PHASE3-06 smoke — effects.js + bots.js (after bots.js stabilizes)

Wave 3 (after Wave 2):
  Claude:  PHASE3-02 damage feedback — hud.js
  Claude:  PHASE3-03 kill confirm + scoreboard z — hud.js, ui.js  [after P2]
  Claude:  PHASE3-04 UI contrast — ui.js, CSS only               [after P3]
  Claude:  PHASE3-07 grenade VFX — effects.js, audio.js
```

### Files that MUST NOT overlap between agents at the same time

| File | Wave 1 owner | Wave 2 owner | Wave 3 owner |
|------|-------------|-------------|-------------|
| `src/player.js` | Codex (P10) | — | — |
| `src/bots.js` | — | Claude (P5, P6) | — |
| `src/effects.js` | — | Claude (P6) | Claude (P7) |
| `src/hud.js` | — | — | Claude (P2→P3) |
| `src/ui.js` | — | — | Claude (P3→P4) |
| `src/projectiles.js` | Codex (P8) | — | — |
| `src/pickups.js` | Codex (P9) | — | — |
| `src/config.js` | Codex (P1, P9) | — | — |

---

## Regression Test Requirements per Task

Each task must ship with:
- At minimum one E2E or unit test covering the new behavior
- Must not break any of the 14 existing passing tests
- Run `npm run test:ci` before PR

---

## What Claude Should NOT Touch in Phase 3
- `src/projectiles.js` (Codex owns trajectory)
- `src/player.js` (Codex owns sprint + movement feel)
- `src/pickups.js` / `src/match.js` loot rules (Codex owns)
- `src/maps.js` (no playtest finding maps to this)

## What Codex Should NOT Touch in Phase 3
- `src/hud.js` kill feed and damage display
- `src/bots.js` AI behavior
- `src/effects.js` smoke and explosion VFX
- `ui-overhaul.css` contrast and layout

---

## Definition of Phase 3 Done

- All 14 current tests still pass
- New tests added per task (listed above) all pass
- Manual verification: sprint stamina depletes; damage numbers scale; bots dodge; smoke obscures; grenade shows arc; kill confirmation appears centered
- No console errors during any of the above flows
