# OVERRUN — Bug Report & Task Allocation
**Repo:** `DH4410/shooting-game`  
**Analysed files:** `game.js` (5725 lines), `index.html`, `ui-overhaul.css`, `Agents.md`, `READMEFORUI.md`, `docs/BLACKOUT_PHASE_GDD.md`, `sw.js`

---

## Part 1 — Bug Catalogue

### Priority key
| P1 | Broken mechanic / wrong behaviour every time |
| P2 | Wrong behaviour under specific conditions |
| P3 | Polish / consistency / code-smell |

---

### BUG-01 · Gamepad RT double-fires on automatic weapons — **P1**
**File:** `game.js` ~line 5930  
**Description:**  
`pollGamepad()` has two separate `down(7)` (RT) branches. When RT is held for an auto weapon, `tryFire()` is called **twice in the same frame**: once inside the "first-press" guard, and again by the auto-weapon block below.

```js
// CURRENT (broken)
if (down(7)) { if (!firing) { firing = true; tryFire(); } }   // fires once
else firing = false;
if (down(7) && currentWeapon().auto) tryFire();                // fires AGAIN same frame
```

**Reproduction:** Use a gamepad, equip AR, hold RT — every frame logs two shots, doubling fire rate.  
**Fix:**
```js
if (down(7)) {
  if (!firing || currentWeapon().auto) tryFire();
  firing = true;
} else {
  firing = false;
}
```

---

### BUG-02 · Bot timers advance on frame-delta, not fixed physics-delta — **P1**
**File:** `game.js` ~line 5443 (`for (const b of bots) b.update(dt)`)  
**Description:**  
All bots are ticked with raw frame `dt` (capped at 250 ms), but the physics world only advances up to `MAX_SUBSTEPS * FIXED_DT = 3/120 ≈ 25 ms`. During any frame that takes >25 ms (e.g. a 60 fps normal frame = 16 ms, or a stall frame = 250 ms), bots' internal timers — `reactTimer`, `fireCd`, `aimSettle`, `nadeCd`, `stateTime` — advance faster than the simulated world. At a 30 fps frame (33 ms), bots react and fire ~30% faster than designed. At max-stall (250 ms), bots advance 10× faster than physics.

**Reproduction:** Cap framerate to 30 fps (`requestAnimationFrame` throttle) — bots become noticeably more aggressive and accurate compared to 120 fps.  
**Fix:** Tick bots inside the fixed-step loop:
```js
// Inside the while (accumulator >= FIXED_DT) loop, AFTER world.step():
for (const b of bots) b.update(FIXED_DT);
```
Remove the current variable-dt bot tick from `frame()`.

---

### BUG-03 · `stateTime === 0` is never true inside COVER state — **P2**
**File:** `game.js` ~line 3513 (COVER state handler in `Bot.update`)  
**Description:**  
`setState()` resets `this.stateTime = 0`. However, `this.stateTime += dt` runs at the top of `update()` **before** the state switch — so by the time the COVER case executes, `stateTime` is already `dt > 0`. The `stateTime === 0` entry guard is never triggered.

```js
// update() flow:
this.stateTime += dt;        // runs first
switch (this.state) {
  case 'COVER':
    if (this.stateTime === 0 || !this.path) { ... }  // never true
```

**Effect:** Bots entering COVER don't re-plan their path to a cover node on entry. They use stale path data, often standing still in the open instead of seeking cover.  
**Fix:** Change to `this.stateTime <= dt * 1.5` or track entry with a separate `_stateJustEntered` flag set in `setState()` and cleared at the top of `update()`.

---

### BUG-04 · `Bot._lastAimTarget` undefined in constructor — **P2**
**File:** `game.js` Bot constructor (~line 3161) and `update()` (~line 3425)  
**Description:**  
```js
if (this.hasLOS && this.target === this._lastAimTarget) this.aimSettle += dt;
```
`_lastAimTarget` is never initialised in the constructor. On the very first update frame, `this._lastAimTarget` is `undefined`, so `this.target === undefined` is always `false` even when a target exists. `aimSettle` never accumulates on first target acquisition — bots immediately have perfect aim on the first sighted enemy.

**Fix:** Add `this._lastAimTarget = null;` in the Bot constructor.

---

### BUG-05 · Survival wave size is uncapped — performance degrades past wave 8 — **P2**
**File:** `game.js` ~line 5237  
**Description:**  
```js
const n = 2 + match.wave * 2;   // wave 10 → 22 bots, wave 15 → 32 bots
```
No upper bound. Each bot has a full physics body, animations, and per-frame ray casts. Above ~16 bots the frame budget collapses on typical hardware, creating a death spiral (slow frames → bots tick on huge dt → bots become superhuman → player dies).

**Fix:**
```js
const n = Math.min(2 + match.wave * 2, 16);
```

---

### BUG-06 · Bots spawn with 0 armour vs player's 50 — balance bug — **P2**
**File:** `game.js` Bot constructor (~line 3161), `CONFIG.START_ARMOR = 50`  
**Description:**  
Armour absorbs 55% of incoming damage until depleted. A player with full armour effectively has ~107 effective HP (50 HP + 50 armour absorbing 55%). Bots spawn with `this.armor = 0`, making them dramatically weaker than the player by design — a pistol shot dealing 12 damage kills a bot 3× faster than it kills the player. On HARD difficulty where bots have accuracy = 0.92, the asymmetry is jarring.

**Fix:** Initialise with `this.armor = 25` (or scale by difficulty: `DIFFICULTY[level].armor ?? 25`).

---

### BUG-07 · Scoped/sniper ADS sensitivity ignores `settings.adsSensitivity` — **P2**
**File:** `game.js` ~line 2950 (`applyLook`)  
**Description:**  
```js
const adsMult = aiming && currentWeapon().zoom ? 0.4 : (aiming ? settings.adsSensitivity : 1);
```
When scoped, sensitivity is hardcoded to `0.4`. The user-facing ADS sensitivity slider is bypassed for the sniper. If a player sets ADS sensitivity to `0.5`, hip-fire and pistol-ADS use their setting, but sniper scope ignores it.

**Fix:**
```js
const adsMult = aiming && currentWeapon().zoom
  ? settings.adsSensitivity * 0.4
  : (aiming ? settings.adsSensitivity : 1);
```
Or expose a dedicated `settings.scopeSensitivity` slider.

---

### BUG-08 · `viewBob` setting is wired in schema but never read — **P2**
**File:** `game.js` — `DEFAULT_SETTINGS` (viewBob exists), `updateViewModel()` (never checks it)  
**Description:**  
The settings panel shows a "View Bob" toggle. `DEFAULT_SETTINGS.viewBob = true` exists. `updateViewModel()` applies the head-bob offset unconditionally without checking `settings.viewBob`. Toggling it in settings has zero effect.

**Fix:** In `updateViewModel()`, wrap the bob calculation:
```js
if (settings.viewBob) {
  // existing bob offset code
}
```

---

### BUG-09 · `addKillFeed` / `refreshBoard` embed player name via `innerHTML` — **P3 (XSS)**
**File:** `game.js` ~lines 5008, 5030  
**Description:**  
Player name is taken from a text input, uppercased, and sliced to 12 chars — but `<` and `>` are not stripped. A name like `<b>X</b>` renders as bold text inside the kill feed/scoreboard via innerHTML injection. While the game runs locally (no server), this is still a correctness issue.

**Fix:** Use `textContent` per node, or:
```js
function esc(s) { return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
```
Apply `esc()` on player name before embedding in template literals.

---

### BUG-10 · Smoke grenade count has no HUD indicator — **P3**
**File:** `game.js` — `player.smokeCount = 1`, HUD `updateAmmoHud()`  
**Description:**  
The player starts with 1 smoke grenade, thrown with `F`. After throwing it, `player.smokeCount = 0` and subsequent `F` presses silently do nothing. There is no HUD element or ammo display showing smoke count. Players have no feedback that the smoke is consumed.

**Fix:** Display `smokeCount` alongside the frag count in the slot strip, or add a small icon counter near the grenade slot.

---

### BUG-11 · All dropped weapon pickups float in phase synchrony — **P3**
**File:** `game.js` ~line 4388 (`updatePickups`)  
**Description:**  
```js
p.mesh.position.y = 0.75 + Math.sin(performance.now() * 0.003) * 0.09;
```
Every pickup uses the same global timestamp with no per-pickup phase offset. All pickups bob up and down in perfect sync, which looks artificial.

**Fix:** Store `p.phase = Math.random() * Math.PI * 2` when the pickup is created:
```js
p.mesh.position.y = 0.75 + Math.sin(performance.now() * 0.003 + p.phase) * 0.09;
```

---

### BUG-12 · Several PROP_FILES entries reference models that don't exist in `assets/` — **P3**
**File:** `game.js` ~lines 807–818 (PROP_FILES), cross-referenced against repo file tree  
**Description:**  
These entries fall back silently to procedural primitives because the GLB files are absent:
- `barrel` → `hopper-round.glb` ✗
- `tank` → `machine-fortified.glb` ✗
- `shelf` → `machine.glb` ✗
- `piston` → `piston-round.glb` ✗
- `dungeonFloor` → `dungeon/template-floor.glb` ✗

The warehouse and dungeon look substantially less detailed than intended.  
**Fix:** Either add the missing GLBs from the Kenney Factory/Dungeon kits, or update the PROP_FILES keys to reference the GLBs that ARE present (box-large, box-small, box-wide).

---

### BUG-13 · `camera.fov` set by `applySettings` is overridden each frame — **P3**
**File:** `game.js` ~line 3901 (`applySettings`), ~line 5378 (`updateCamera`)  
**Description:**  
`applySettings()` sets `camera.fov = settings.fov` (= 68). But `updateCamera()` runs every frame and lerps `camera.fov` toward a hardcoded `wantFov` of 78 (hip-fire) or 68 (ADS). The setting value of 68 is the ADS FOV, but the normal hip-fire FOV is hardcoded to 78 — `settings.fov` never governs the actual in-game FOV. If a FOV slider were later added, it would have no effect.

**Fix:** Replace hardcoded values:
```js
const wantFov = scoped ? w.zoomFov : (aiming ? settings.fov * 0.87 : settings.fov);
// 0.87 ≈ 68/78 — keeps ADS narrower by the same ratio regardless of settings.fov
```

---

### BUG-14 · Bot footstep audio distance threshold too generous (22 m) — **P3**
**File:** `game.js` ~line 3294 (`followPath`)  
**Description:**  
Footstep audio fires for all bots within 22 m. On the 100×100 m warehouse map, this encompasses much of the visible arena, so off-screen bots contribute to footstep audio clutter. The threshold is the same for both maps despite the dungeon being 23×23 m (where 22 m is almost the whole map).

**Fix:** Tune to ~12 m, or make the threshold map-dependent:
```js
const STEP_RANGE = currentMapKey === 'dungeon' ? 10 : 14;
```

---

## Part 2 — Settings That Detract From the Shooter Feel

| # | Setting / Behaviour | Issue | Quick fix |
|---|---|---|---|
| S1 | ADS sensitivity slider | Only affects non-scoped ADS (BUG-07) | See BUG-07 fix |
| S2 | View Bob toggle | Has zero in-game effect (BUG-08) | See BUG-08 fix |
| S3 | FOV | Not user-adjustable, hip-fire hardcoded to 78 (BUG-13) | Expose slider + fix BUG-13 |
| S4 | Crosshair | No style presets (dot, cross, circle) — only colour and gap | Add 4 preset shapes |
| S5 | Smoke count | Not shown anywhere in HUD (BUG-10) | See BUG-10 fix |
| S6 | Scoped sensitivity | No dedicated slider; shares/ignores ADS slider | Add `settings.scopeSensitivity` |

---

## Part 3 — Task Allocation: Claude Code vs. Codex

The **READMEFORUI.md** contract already defines a clean split. Use it as the ownership boundary:

| Domain | Owner | Files touched |
|---|---|---|
| Gameplay logic, physics, AI, weapons, match flow | **Claude Code** | `game.js` only |
| Visual polish, menu layout, HUD chrome, fonts, animations | **Codex** | `ui-overhaul.css` only |
| New HUD elements needed by gameplay fixes | **Claude Code adds ID** → **Codex styles it** | `index.html` (additive only) |

### Claude Code owns — gameplay bugs
Prioritised order:

1. **BUG-01** Gamepad double-fire (5-line fix, ~15 min)
2. **BUG-02** Bot variable-dt tick (move `b.update()` into fixed loop, ~30 min — high impact)
3. **BUG-04** `_lastAimTarget` null init (1-line fix, ~5 min)
4. **BUG-03** COVER state entry guard (change `=== 0` to `<= dt * 1.5`, ~10 min)
5. **BUG-06** Bot armour init (1-line fix, ~5 min)
6. **BUG-07** Scoped sensitivity (3-line fix, ~10 min)
7. **BUG-08** viewBob wiring (~10 min)
8. **BUG-05** Survival cap (1-line fix, ~5 min)
9. **BUG-09** innerHTML XSS (add `esc()` helper, ~20 min)
10. **BUG-11** Pickup phase offset (~10 min)
11. **BUG-10** Smoke HUD: **add a `<span id="smoke-count">` element in `index.html`**, then wire it in `updateAmmoHud()` (~15 min)
12. **BUG-13** FOV consistency (~15 min)
13. **BUG-12** Missing prop models: replace broken keys with existing GLBs (~20 min)
14. **BUG-14** Footstep range tuning (1-line, ~5 min)

### Codex owns — UI/polish bugs
All purely visual, no `game.js` changes needed:

- **S4** Crosshair presets: add radio buttons in the settings schema render and style them in `ui-overhaul.css`
- **S6** Scoped sensitivity slider: add entry to `SETTINGS_SCHEMA` in `game.js` (Claude Code), then Codex styles the slider
- **BUG-10 HUD styling**: once Claude Code adds `#smoke-count` to `index.html`, Codex styles its position and appearance
- General polish: typography, menu transitions, kill feed animations, scoreboard row hover states

---

## Part 4 — Parallel Work Strategy

### Branch structure

```
main
├── fix/gameplay-bugs      ← Claude Code works here
└── fix/ui-polish          ← Codex works here
```

### Ownership contract (zero-conflict guarantee)

| File | Who writes | Rule |
|---|---|---|
| `game.js` | Claude Code only | Codex must never modify this file |
| `ui-overhaul.css` | Codex only | Claude Code must never modify this file |
| `index.html` | Both — **additive only** | Claude Code may add new element IDs (e.g. `<span id="smoke-count">`); Codex may add new class names to existing elements. Neither may delete or reorder existing elements |
| `sw.js`, `Agents.md`, `READMEFORUI.md` | Neither (unless specifically required) | |

### Merge order

1. **Merge `fix/gameplay-bugs` first** (Claude Code). This is the riskier branch — AI and physics changes can break the game entirely and need to be verified before UI changes land on top.
2. **Merge `fix/ui-polish` second** (Codex). Style changes are safe to layer on top.
3. If `index.html` has a conflict (both branches added elements): keep **both additions** — all additions should be to different locations in the file.

### Preventing `index.html` conflicts

Before either branch starts:
1. Claude Code reserves element IDs it plans to add: `smoke-count`, any future HUD ids.
2. Codex is told which IDs Claude Code will add and should reference them by ID in CSS, not by position.
3. Both work in different regions of `index.html` (Claude Code: HUD `#hud` children; Codex: menu card, slot classes).

### Verification checklist before merge

**Claude Code PR must pass:**
- [ ] All 14 numbered bugs fixed with targeted, surgical edits
- [ ] No changes to `ui-overhaul.css` or cosmetic elements
- [ ] Game boots, match starts, bots move, player can fire and die
- [ ] Gamepad: RT fires at correct rate for auto and semi weapons
- [ ] Survival: wave 10+ doesn't exceed 16 bots

**Codex PR must pass:**
- [ ] No changes to `game.js` logic
- [ ] All `!important` declarations respect the READMEFORUI.md "never-!important" property list
- [ ] HUD remains readable at 1920×1080
- [ ] Game still boots with both CSS files present
