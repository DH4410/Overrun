# READMEFORUI — contract for anyone styling OVERRUN's interface

This file exists so that UI work and gameplay work can happen on separate branches and still
merge cleanly. If you are restyling the game, read this first. If you are changing gameplay,
keep this file honest.

---

## 1. Who owns what

| File | Owner | Rule |
|---|---|---|
| `ui-overhaul.css` | **UI agents** | Gameplay work must never touch this file. |
| `index.html` | **Shared** | Structure only. See §2 before editing. |
| `game.js` | **Gameplay** | UI work must never touch this file. |

`ui-overhaul.css` is the ONLY stylesheet. (Until session 4 there was also a large inline
`<style>` block in `index.html` with this file layered over it using `!important`; both were
replaced by one rewrite — the neon/glass/scanline look read as generic and AI-made.) Restyle
here; you should rarely need to touch `index.html`.

The look, so a later change keeps it (session 8 rework; the reasoning is in `docs/LOBBY_RESEARCH.md`):

- **One accent, amber (`--accent`)**, for "selected / yours / the thing to press". Team colours
  `--self`, `--ally`, `--enemy` mean the same thing everywhere.
- **Chamfered plates.** Panels are dark, slightly translucent and cut at one corner with
  `clip-path` (a `polygon(...)` that trims the bottom-right). Chips and strips trim two corners.
  Nothing is rounded except the operator arrows and the minimap.
- **Barlow Condensed** for everything labelled or numeric, **Barlow** for prose. Labels are small,
  wide-tracked capitals; numbers are big and tabular.
- **One primary action per screen**, the largest and brightest thing on it (DEPLOY, I SAVED IT).
- **No glows, gradients on text, scanlines or emoji icons.** `backdrop-filter` only on full-screen
  popouts, never on the HUD (see §4).
- **The HUD stays quiet.** Health and armour bottom-left, ammo and slot chips bottom-right beside the
  minimap, a slim score strip top-centre, the kill feed top-right. Information appears when it
  matters (the streak counter, the kill banner); nothing flashes while idle.

### Editing `index.html`

Only when you genuinely need a new element or a new class hook. If you do:

- **Add**, don't rewrite. Do not reflow, reformat or re-indent existing lines; a whitespace-only
  reflow turns a 3-line diff into a 600-line conflict.
- Never rename or remove an `id` in §3 — `game.js` looks all of them up by `id` at boot and
  several are written to every frame.
- Don't reorder existing blocks.

---

## 2. Properties `game.js` writes at runtime

These are set as **inline styles**, which beat normal stylesheet rules but lose to `!important`.
**If you mark any of these `!important` in CSS, you will break the feature.** They are listed
here precisely so you can avoid them.

| Element / class | Properties written every frame or on events |
|---|---|
| `.plate` (enemy nameplates) | `display`, `left`, `top`, `transform`, `opacity` |
| `.plate .ph` (the bar) | `display` |
| `.plate .ph > i` | `transform` (scaleX health) |
| `.ally-mark` | `display`, `left`, `top` |
| `.ally-mark .ahp > i` | `transform` |
| `#hpfill`, `#apfill` | `transform` (scaleX) |
| `#hptxt`, `#aptxt` | `textContent` |
| `#hitmarker`, `#toast`, `#lowhp`, `#ammo-prompt` | `opacity` |
| `#hitflash` | `opacity`, `transition` |
| `.dmg-num` | `left`, `top` (created and destroyed dynamically) |
| `#crosshair i` | reads `--xhair` and `--xhair-gap` custom properties |

**`transform` on `.plate` is load-bearing.** `game.js` sets `translateY(-100%)` to lift the
nameplate above the model's head; `top` alone places its *top edge* at the head, which made the
plate sit over the face. Do not override `transform` on `.plate`.

### Classes toggled by `game.js`

Style these freely — just don't rename them.

`.hidden` (on `#hud`, `#menu`, `#settings`) · `.on` (`#board`, `#scope`, `#slots div`) ·
`.off` (`#crosshair`, `.ally-mark`) · `.low` (`#vitals`, health critical) ·
`.hurt` (`.plate`) · `.kill` (`#hitmarker`) · `.active` (`.pill`, `.mode-btn`, `.set-choice button`) ·
`.empty` (`#slots div`) · `.head` / `.body` / `.arm` / `.leg` / `.kill` / `.armored` (`.dmg-num`) ·
`.head` / `.kill` (`#hitmarker`) · `.show` / `.headshot` (`#killbanner`) · `.mine` (`.kf`) ·
`.hs` (`.kf .arrow`) · `.locked` (`#diffgrp`)

---

## 3. Element inventory, with placement and size guidance

Sizes below are what the layout currently assumes. Treat them as **guidance, not law** — change
them if your design is better, but keep the *screen region* and keep the element visible, because
several of them are how the player reads the game state.

### Always-on HUD (inside `#hud`, which is `position:fixed; inset:0`)

| id | Region | Current size | Notes |
|---|---|---|---|
| `#vitals` | bottom-left | 300 x ~80 px | Health (big number + bar) and armour (thin bar). Must stay legible at a glance. |
| `#ammo` | bottom-right, left of the map | min 190 px wide | Big current-mag number, small reserve. |
| `#mapframe` | bottom-right corner | 180 x 180 px | **See §4 — special rules.** |
| `#topbar` | top-centre | auto | Mode, then a chamfered strip: your score, the clock, theirs. |
| `#streak` | top-centre, under the strip | auto | Kill-streak counter; `.on` shows it, `.ended` turns it red until you respawn. Never name a class `pop` (the menu popouts own it). |
| `#hsflash` | full screen | n/a | A brief gold edge bloom on a headshot kill. |
| `#feed` | top-right | 300 px wide | Kill feed; rows are `.kf`, added/removed by JS. |
| `#crosshair` | exact centre | 0 x 0 anchor | Arms positioned from centre via `--xhair-gap`. |
| `#hitmarker` | exact centre | 0 x 0 anchor | Four ticks round a gap. `.head` / `.kill` variants. |
| `#killbanner` | centre, ~64% down | auto | Kill confirmation; JS fills `#kb-name` and toggles `.show`. |
| `#ammo-prompt` | centre, ~58% down | auto | Shows `AMMO` / `HEALTH` / `SHIELD` near a pickup. |
| `#toast` | centre-ish | auto | Transient one-line messages. |

### Overlays (full-screen, `pointer-events:none`)

| id | Purpose |
|---|---|
| `#plates` | Container for enemy nameplates. Must be `inset:0`. Keep `overflow:hidden`. |
| `#allies` | Container for teammate markers. Must be `inset:0`. |
| `#dmgnums` | Floating damage numbers. Must be `inset:0`. |
| `#dmgwrap` | Damage-direction arcs (`.dmg`, rotated by JS). |
| `#hitflash` | Red vignette pulse when hit. |
| `#lowhp` | Low-health vignette. |
| `#scope` | Sniper scope; shown via `.on`. |

### Screens

| id | Purpose |
|---|---|
| `#menu` | The lobby, a 3-column grid over the live 3D arena: `#topnav` across the top (brand, tabs, `#account`), `#lobby-left` (player card, next unlock), the operator in the middle (the 3D hero is drawn by the game behind the menu; `#operator` is only its name plate and ‹ › picker), `#lobby-right` (mode, map, difficulty, loadout line, `#play`, multiplayer). Keep the middle column empty: the operator stands there. |
| `#career` | The career screen (built by `src/career.js` on first open): reward track and titles. |
| `#acct` | The sign-in card (`.pop` overlay). Views are `[data-view]` sections; `.on` shows one. |
| `#locker` | The loadout screen (built by `src/locker.js`): slots, finish row, armory. |
| `#settings` | Settings panel. **Rows are generated by JS** — see §5. |
| `#pause` | Pause overlay. Contains `#settings-open-pause` and `#quit-match`. |
| `#board` | Scoreboard (Tab). `#b-body` rows are generated by JS. |

---

## 4. Two hard constraints

**1. `#mapframe` must not have a backdrop filter, and must not be opaque.**

The minimap is **not** a DOM element. It is drawn by the WebGL canvas *underneath* the HUD, into
a scissored 180x180 rectangle in the bottom-right corner. `#mapframe` is only a border drawn on
top of it. So:

- `backdrop-filter` on it (or on any ancestor) blurs the actual minimap. This already shipped
  once as a bug — `.panel` carried `backdrop-filter: blur(3px)` and the map looked out of focus.
- An opaque `background` hides the map completely.
- If you move or resize it, tell gameplay: the rectangle is computed in `game.js` from
  `MAP_PX` (180) and `MAP_MARGIN` (20) and they must match, or the border and the map drift apart.

**2. Nothing in `#hud` may take pointer events** except deliberate buttons. `#hud` is
`pointer-events:none`; the game needs clicks to reach the canvas for pointer lock. Buttons that
*should* be clickable set `pointer-events:auto` explicitly.

---

## 5. The settings panel is generated, not written

`#settings-body` is empty in `index.html`. `game.js` builds it from a schema and injects:

```
.set-group                     section heading
.set-row  > .set-label + .set-ctl    one setting
.set-hint                      optional explanatory line
```

Inside `.set-ctl` you get `input[type=range]`, `input[type=checkbox]`, `input[type=color]`,
or `.set-choice > button` (with `.active` on the selected one). Style those selectors; do not
hand-write rows, they will be overwritten on open.

To add or remove a *setting*, edit `SETTINGS_SCHEMA` in `game.js` — that is gameplay's side.

---

## 6. Deliberate design decisions — please don't undo these

- **Enemy health bars are hidden by default.** Enemies show a callsign only; how hard you hit is
  communicated by the floating damage numbers. There is a setting to turn bars back on. Teammates
  *do* show health, on `.ally-mark`.
- **Ally markers are not occlusion-tested.** They clamp to the screen edge when the teammate is
  off-screen or behind you — that is the point of them.
- **Enemy nameplates are occlusion-tested** and hidden when there is no line of sight. Do not add
  an outline/glow that renders through walls; it would be an aimbot.
- **Field of view is not user-adjustable.** It changes how large enemies read on screen. Please
  don't add a control for it.

---

## 7. Merging

Suggested order, since `ui-overhaul.css` and `game.js` never overlap:

1. Merge the UI branch (`ui-overhaul.css`, plus any additive `index.html` hooks).
2. Merge the gameplay branch (`game.js`, plus additive `index.html` elements).
3. Only `index.html` can conflict. Resolve by **keeping both sides' additions** — the two
   branches add different elements and touch different rules.

Before opening a PR, load the game and confirm: health and ammo readable, crosshair centred,
minimap sharp and unblurred, a nameplate appears above an enemy's head when you can see them
and disappears behind a wall, and the settings panel opens with populated rows.

## 8. Added in session 9

New ids (do not rename; no `!important` on anything the game writes at runtime):

| Id / class | What | Notes |
|---|---|---|
| `#hp-chip` | Hardpoint distance chip under the top bar | Created by `src/hardpoint.js`; `data-state` is `open`, `mine`, `theirs` or `contested`; `.hp-arrow` is rotated by script |
| `#friends`, `#friends-btn`, `#fr-badge`, `#fr-add`, `#fr-name`, `#fr-msg`, `#fr-list`, `#fr-close` | Friends drawer and its button | `#friends.on` is open; rows are built by `src/friends.js` (`.fr-row` with `.on`/`.off`/`.req`/`.invite`/`.out`, `.fr-dot.online/lobby/solo`, `.fr-b.go/.inv/.no`) |
| `#fr-invite` | Invite banner, appended to `#menu` by script | `.on` shows it |
| `#wallet`, `#wallet-n`, `.coin` | Credits chip in the top bar | `.coin` is one glyph reused in the locker and podium |
| `#lk-buy`, `#lk-bal`, `.lk-price`, `.lk-gun.locked` | Locker buying | |
| `#locker-sum` | Now a row of gun pictures (`<img>`), not text | |
| `.mode-btn[data-mode="gg"]`, `[data-mode="hp"]` | Gun Game and Hardpoint tiles | |

Less text on purpose: the lobby cards no longer show a sentence under the mode and map names
(`.sc-desc` is hidden), the online pane has no standing explanation, and the loadout is pictures.
Please keep icons ahead of sentences.
