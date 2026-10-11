# HANDOFF â€” read this first

Say **"read HANDOFF.md"** to pick this up in a new session.

Session 1 (2026-09-27) reworked bot AI, game modes, gunplay, physics, the map roster and the
character/animation pipeline. Session 2 (2026-09-28) was laptop work: frame rate, battery, and
the two bugs a real playtest turned up. Session 3 (2026-09-28) was a full playtest of every
mode and map, then a code review after you reported movement and animation looking wrong and
dead bots floating â€” it found the bots were being drawn backwards. Session 4 (2026-09-28)
worked through your ten-point list: bot jitter, animation, weapons, jumping through ramps, stuck
bots, hitboxes and damage feedback, the UI, and movement. Session 5 (2026-09-29) did the last
two: **PORT**, a new default map modelled in Blender, and **three more Mixamo characters**.
Session 6 (2026-09-30) worked through a fifteen-point list: locker, crouch dodge, cooked
throws, bot height, per-gun crosshairs, minimap, health bars, win screen, lobby, sound and
music, and emotes. See "Session 6". Session 7 (2026-09-30) was the maps: the three old
procedural maps are gone, replaced by **DESERT** and **SNOW**, both modelled in Blender like
PORT, and clicking back in from the pause screen no longer leaves it over the game. See
"Session 7".

---

## Where things stand

| | |
|---|---|
| Branch | `claude/game-improvements-ai-modes-9f6246` |
| Worktree | `C:\Users\dimah\shooting-game\.claude\worktrees\game-improvements-ai-modes-9f6246` |
| Pushed? | Sessions 1-5 were merged to master by PR DH4410/Overrun#7. **Sessions 6 and 7 were pushed straight to master on 2026-10-01, with no PR.** |
| Tests | 98/98 Playwright, 19/19 unit, lint 0 errors (12 warnings, all pre-existing) |

```bash
npm ci && npx playwright install chromium
npm run lint && npm test && CI=1 npm run test:e2e
```

**The duel spec flaked once in session 2** (`duel.spec.mjs:12`, passed on retry, cause not
captured) and did not recur in any of the four full runs in session 3. Still worth a look if
it comes back.

**Always run e2e with `CI=1`.** The Playwright config sets `reuseExistingServer: !CI`, and
there are other checkouts of this repo on this machine â€” without `CI=1` a stale server on
`:4173` can serve a different tree and give a false green.

---

## Map detail pass (2026-10-10, after session 9): "too dark, too blocky"

User complaint: maps too dark (metro, arena), too blocky, castle undetailed, heal animation bad.
Visuals only: collider JSONs and the map hash are untouched (`git status` must never show
`assets/maps/*.json` changed by a visual pass).

- Done and committed: metro/port/depot lighting and detail, item art, first-person heal animation.
- **Castle (bastion)**: `build_bastion.py` now uses `roundkit_dh.py` (rounded boxes, lathe towers with
  corbels and conical roofs, tori, tubes, wear vertex colours) and new keys `cut`, `timber`, `plaster`,
  `shingle`, `thatch`, `flame` (materials in `src/mapBastion.js`). GLB 1.9 -> 4.7 MB (150k tris); trim
  `cut` and `pine` first if it must shrink. Ghost-probe lesson: a tapering collider-backed shape that
  widens downward (the pine trunk) makes a sliver a vertical ray can graze above 0.3 m; keep it
  straight from 0.3 m to the 4.2 m cast height. Far ranges are now thin multi-peak ridges.
- **Arena, warzone, desert, snow, depot**: all rebuilt on `roundkit_dh.py` the same way (rounded boxes,
  lathes, tubes, wear vertex colours; one commit each). New non-touch keys carry the detail: `trim`
  (copings, cornices, plinths, hoods) and `metal` (pipes, frames, hangers) on depot/snow/warzone,
  `trim` and `clay` on desert. GLB sizes: warzone 3.0 -> 5.2 MB, desert 2.4 -> 5.4 MB, snow 2.4 -> 3.9 MB,
  depot 0.8 -> 2.1 MB. If load time matters, `trim` and the lathe-heavy props are where to cut.
  Wear keys must be in `TINTED`, and the JS material needs `extra: { vertexColors: true }` for every
  key that has them, or those meshes draw black (keys sharing one JS material must all carry them).
- Depot: the loading-door leaves in the side walls had been wound backwards and were culled, so
  they never showed; they now face into the hall. Its ghost probe step is 0.517 (was 0.513): with
  chamfered edges three probes landed in the 3 cm band at an edge and slipped through, a sampling
  artefact, not a ghost. Snow's heights test lets go of W at step 18 because always-on sprint now
  carries a jump over a 0.9 m berm.
- **Open design question (needs the user):** the damage rework (8727b8a) set the AR to 24, so a
  headshot on a bot is 24 x 4 = 96 and leaves it on 4 hp; the docs and the old hitboxes spec said an
  AR headshot kills. I did not touch balance: the spec now asserts 96. Making it kill again is
  `ZONE_MULT.head` 4.0 -> 4.2 in `src/sim/hitmath.js` (or AR 25).
- Full `CI=1` e2e on 2026-10-10: 138 tests, the four failures were stale tests, not regressions
  (depot nav nodes 121 vs a 250 floor meant for the big maps; PORT crate hop under always-on
  sprint; the two AR-headshot specs). All fixed in the specs. `hitboxes.spec.mjs` "hit zones
  follow the animation" still fails about one run in three with `undefined.matrixWorld` (a bone
  lookup on the bot's mesh; probably a lazily loaded skin) - an old flake, not chased.
- Heal: remote players now show a green pulse while opening a medkit (`src/healProp.js`,
  `src/net/client.js`), no protocol change.
- Preview shots with real GPU and textures: `spike/shot-map.mjs` (untracked; mode `tdm` for bastion,
  CTF is multiplayer only). The e2e harness stubs textures so those screenshots look black.
- **PORT deep detail pass** (`scripts/blender/portdetail.py`, exec'd by `build_port.py`; visual only,
  `port.json` unchanged): windows with frames and sills, hazard jambs, bay and dock labels, container
  names and codes, castings, forklift pockets, ladders, X-bracing and a hung container on the
  gantries, floor cracks, joints, drains, lane arrows, razor wire, cameras, backdrop crane lattice.
  New keys: `fit` (fittings, standard material, no shadow) and `mark` (decals and text, Lambert, no
  shadow, polygonOffset); both are in the spec's SKIP set, so they may stick out past colliders.
  All `mark` decals share one polygonOffset, so overlapping decals need >= 5 mm of separation.
  GLB 4.1 -> 6.4 MB (117k -> 168k tris). `fit` is out of the shadow pass and `mark` is Lambert;
  do the same on every further detail pass (new fittings and decals must not cast).
- **ARENA deep detail pass** (`scripts/blender/arenadetail.py`, exec'd by `build_arena.py`; visual
  only, `arena.json` unchanged): advertising hoardings and sector plates on the wall, gate signs and
  shutter slats, hose cabinets, extinguishers, first aid, cameras, conduit, downpipes, water streaks,
  a crowd of flat cut-outs and brand fascia on the stands, a scoreboard, lens cans and ladders on the
  towers, painted text on the dais and floor, rails and bollards on the dais steps, straps and seams on
  the crates, hazard ends and plates on the barriers, louvres and signs on the sub-station blocks,
  manholes, stains and drag marks. Same `fit` / `mark` keys as PORT (`mapArena.js` adds the materials
  and puts both in `noCast`). The scoreboard frame is in `stands` (no shadow) so a 24 m board does not
  stripe the pit. GLB 1.3 -> 4.9 MB (the stands text and crowd are most of it). Shared text and decal
  helpers moved to `scripts/blender/markkit.py` (PORT rebuilds byte-identical). Tests: blender-maps
  arena 4/4, grenade-physics 8/8.
- **Performance findings (user asked for no lag, no battery cost):** measured on the dev laptop (AMD
  Radeon iGPU, medium, 720p) with GPU timer queries (`EXT_disjoint_timer_query_webgl2`; do not time
  with readPixels, it measures sync latency, not the GPU). The whole frame is ~6-8 ms GPU and ~13 ms
  main thread, and **hiding half of PORT's triangles changed nothing**, so geometry is not the cost:
  fragment work is. Do not chunk meshes for frustum culling or chase triangle counts. What did show:
  the 12 pooled point lights were compiled into every lit shader even on tiers that lease 4 or 8
  (about 1 ms of 7); `applySettings` now hides the slots past `QUALITY[..].lights`. The CPU profile
  (CDP `Profiler`) is flat: 33% idle, `updateMatrixWorld` ~5%, one-time `fflate` inflate at load. The
  frame cap, idle/lobby fps, adaptive resolution and half-rate shadows in battery saver already exist
  (see "What was built - session 2"). Measurement scripts live in untracked `spike/perf-*.mjs`.
  Not done, would need a decision: auto battery-saver from `navigator.getBattery()`; caching the
  static-map shadow map (only worth it at the QUALITY tier, shadows cost ~1 ms at 1024).
- **Sticky aim fix** (`src/player.js`, committed 710b276): the pad poll used to write `aiming` and
  `firing` every frame from an idle pad and a lost `mouseup` (alt-tab, release outside the window) left
  the mouse latched. A pad button now only counts once it has been seen up (`gpArmed`), LT/RT are
  edge-driven, and the mouse held-state is resynced from `e.buttons` on mousemove and cleared on window
  blur. Test: `controls.spec.mjs` "an idle pad leaves a held aim alone". `__game.isAiming()` is the
  debug hook.
- **METRO deep detail pass** (`scripts/blender/metrodetail.py`, exec'd by `build_metro.py`; visual
  only, `metro.json` unchanged): wall friezes, posters, clocks, line maps, timetables, fire and first-aid
  points, phones, louvres, speakers, cameras, cable trays, tunnel rings, floor joints and stains,
  tactile studs, rail clips and sleepers, train interiors (seats, passengers, door gear, destination
  boards, roundels), ceiling sprinklers, vents and conduit, column bases and capitals, bench/vending/
  planter/barrier/kiosk details, hanging signs. **Sign text is now an atlas, not pixel rectangles**:
  `markkit.py` `type_label` / `type_floor` emit one quad per character with UVs into
  `src/typeAtlas.js` (canvas texture, `TYPE_CHARS` on an 8 x 8 grid; both sides share that contract,
  keep the order). Keys `tmark` (Lambert, painted) and `tglyph` (Basic, lamp) carry it with
  `alphaTest 0.4`; `fit`, `mark`, `glyph`, `tmark`, `tglyph` are tinted per vertex, bevel-skipped and
  in `noCast`. Doing text as pixel rects was 79k faces / 13.6 MB; as atlas quads 41k faces / 5.4 MB
  after `node scripts/glbquant.mjs` (run it by hand after every Blender build). ARENA and PORT could be
  moved to the atlas too to shrink them. Tests: blender-maps metro 6/6, units 144, lint 0 errors.
- **DEPOT deep detail pass** (`scripts/blender/depotdetail.py`, exec'd at the end of `build_depot.py`;
  visual only, `depot.json` unchanged, GLB 2.2 -> 3.4 MB / 41.7k faces): bay numbers, pilaster
  plates and height ticks, safety signs, DB/fire plates, coloured pipe bands, roller-door ribs,
  signals and hatched no-go zones, DOCK n text, floor paint (route arrows, pedestrian strip, lane
  names, roundels, gratings, oil, tyre tracks, cracks, patches), container names/IDs/roof text/locks,
  crate straps/labels, barrier names, column ID plates and hose cabinets, truss gussets, skylight
  astragals, two gantry cranes, a safety banner, site-office frames and signs. Same five keys and
  atlas as METRO (`fit`, `mark`, `glyph`, `tmark`, `tglyph`). Wraps the urbankit `crate` and
  `container` after the layout is defined, so the layout's calls and colliders are untouched.
- **SNOW deep detail pass** (`scripts/blender/snowdetail.py`, exec'd at the end of `build_snow.py`, called
  from `build_layout()` just before `rk_finalize()`; visual only, `snow.json` unchanged, GLB 4.0 -> 6.4 MB
  / 73k faces): cabin names/numbers, downspouts, junction boxes, vent grilles, extinguishers, notice
  boards, cage lamps, blinds and window glare, sill snow (key `mound`, not `snowcap`: the collider
  probe treats `snowcap` as touchable), icicles, solar panel/hatch/flue/aerial on the roofs; fence
  seams, kick rail, signs, post numbers, floodlights, insulators, gate bracing/lock/name, four
  watchtowers; mast guy wires and plates; station facade/entrance names, meters, vents, interior
  wainscot, posters, clock, exit signs, ceiling plant, desk and bench kit, floor paint; tank names,
  gauges, hazard diamonds, rails, bolts, transfer lines, bund stencils and stripes; motor pool
  name boards, tool wall, bay lines, oil, tread marks, bench; snowcat numbers/plough stripes/
  lamps/mirrors; container names, IDs, data plates; crate stencils; lamp-post stripes; woodpile tarp;
  road ruts and STOP/SLOW, pond cracks, THIN ICE posts, wind ripples. Same five keys and atlas as
  METRO/DEPOT. Wraps `cabin`, `window`, `container`, `crate`, `tank`, `snowcat`, `lamp_post`,
  `woodpile` after the layout defines them. Tests: snow-map 7/7, units 144, lint 0 errors.
- **BASTION deep detail pass** (`scripts/blender/bastiondetail.py`, exec'd before `run_round` in
  `build_bastion.py`, called from `build_layout()` just before `rk_finalize()`; visual only, `bastion.json`
  unchanged, GLB 4.8 -> 7.1 MB / 98k faces): shield, keep name and year on both faces of the gate
  lintel, studs/rings/plank seams on the doors, spiked portcullis, doors in the gate towers, POSTERN
  plates; flag hall dado, team frieze, shield and name on the back wall, trophies, weapon rack, lanterns,
  bunting, purlins, roof courses, team ring and name inlaid in the floor; barracks door leaf, name plate,
  window boxes, gutters/downpipes, gable round windows, chimney pots; crate stencils/nails/seams, well
  sign and courses; banner borders and charges (tower for blue, saltire for red); torch plates and soot;
  tower course ridges, roof ribs and vines; flank and back wall rain stains, repairs, slits, vines,
  banners, copings; ruin windows; causeway joints and team ring; cart ruts; grass tufts and flowers.
  Six new keys (`fit`, `mark`, `glyph`, `tmark`, `tglyph`, plus `tuft`, which is Lambert vertex-coloured
  and out of the shadow pass). Wraps `slit`, `torch`, `hang_banner`, `window`, `brazier`, `crate`,
  `well`, `stone`, `pine`, `tower_viz`, `house_far`, `windmill`. Lesson: rain streaks and ground moss
  as light/opaque `mark` decals read as bars and hexagons; keep them dark, thin and small, and leave
  grass bare. Tests: blender-maps 21/21 (bastion 5), units 144, lint 0 errors.
- **Battery/detail/feel settings** (user asked for a "disable heavy features" switch plus the
  shooter-feel list): `src/settings.js` now owns `tuning()`/`saverActive()`/`initPower()`. The saver is
  the manual `powerSaver` OR (`powerAuto` and `navigator.getBattery()` says not charging); it only lowers
  the preset (render scale <= 0.85, pixel ratio 1, particles x0.5, lights <= 6, decals x0.5, scenery
  detail off, frame cap <= 60 and 30 at <= 15% charge, shadows every other frame, HRTF -> equalpower).
  `initPower(applySettings)` re-applies on plug/unplug. `sceneryDetail` hides meshes whose material key is
  `fit/mark/glyph/tmark/tglyph/tuft` (tagged `userData.detail` in mapGlb.js). Feel: low-health
  desaturation (CSS `saturate()` on `#view`, quantised, skipped in saver), +4 deg FOV on sprint, white
  `#blastflash` on close explosions, fast sparks + heavy debris in `spawnExplosion`, low-ammo tick
  (`Audio.lowAmmo`, last 20% of the mag), raw mouse (`requestPointerLock({unadjustedMovement})` with
  fallback), sensitivity step 0.01, minimap redrawn every other frame in the saver. Later in the
  session: enemy hit flash (`src/hitflash.js`, emissive blink, bots and online puppets own their
  materials; ticked from `updateExplosionFx`), diegetic ammo counter (canvas plane beside each gun's
  receiver, `setAmmoCounter` in weapons.js, fades out while aiming; `diegeticAmmo`), audio occlusion
  (`Audio.setOccluder(losClear)`: lowpass 1.4 kHz and x0.6 behind a wall) and music ducking
  (`Audio.duck`, on explosions within 25 m). Unit tests: `tests/unit/power-tuning.test.mjs`.
  NOT done: progression/unlocks (locker, loadout and skins already exist), 30 s pacing loop, static
  shadow cache, per-weapon muzzle-flash colour grading. Research notes: game feel = instant, layered
  input -> flash/sound -> recoil -> hit confirm (marker 50-100 ms, distinct headshot, kill sting);
  battery = cap fps, cap pixel ratio, no MSAA, low-power GPU hint, render only when needed.
- **WARZONE deep detail pass** (`scripts/blender/warzonedetail.py`, exec'd before `run_round` in
  `build_warzone.py`, `warzone_detail()` called just before `rk_finalize()`; visual only, `warzone.json`
  hash unchanged, GLB 5.5 -> 8.1 MB raw / 2.8 MB gzip, ~95k detail verts): building names/numbers,
  window frames, boards, sills, shutters, curtains, door posts/thresholds/hinges, soot, bullet pocks,
  cracks, rain streaks, render repairs, downpipes, aerials/dishes on roofs, shop awnings; wreck/bus
  decals and hardware; container names and codes; crate stencils; lamp-post bands; rubble chunks; road
  cracks, patches, manholes, zebra and skid marks; plaza/base/fuel station signage; perimeter wall
  plates. Same five keys and atlas as the other maps (`fit`, `mark`, `glyph`, `tmark`, `tglyph`).
  Lesson: **Lambert does not receive `scene.environment`**, so on a map with real IBL (warzone env 0.5)
  Lambert decals render ~10x darker than the Standard wall under them; warzone's `mark`/`tmark` are
  Standard for that reason (the older maps' Lambert marks are fine only because their IBL is weaker).
  Dark soot/streak/skid values must be mid-tone (soot 0x58524c with a 0x71695f halo), never near-black.
  Also fixed: e2e `setGamepadButton`/`tapGamepadButton` pump two idle frames first (the game now counts
  a pad button only once seen up); the diegetic ammo counter plane is `visible = false` while faded out.
- Needs a second `npx wrangler deploy` (user's call) plus a hard refresh; sw cache is v57. The live
  site is still on v43. Not yet run: the full e2e suite (30+ min, `CI=1`); each map's own spec and
  the unit tests (144) and lint (0 errors) were green per commit.

## Session 9 (2026-10-07): playtest fixes, new modes, more maps (in progress)

Source: the user's playtest list. `npx wrangler deploy` is blocked for me; the user deploys. Work
on `claude/overrun-mp-lobby-modes`, one commit per step, never push, never commit `spike/`.
Protocol bumps to v5 once, with the combat/items wire changes (not yet done).

- [x] 1. Host powers and seat robustness: token takeover (no doubled players), silent sockets reaped
  (LIVENESS 75 s), host kick (`{t:'kick', id}`, 120 s token ban, `CLOSE.KICKED`/`REPLACED`), host
  `{t:'lobby'}` from any phase, everyone-left â†’ lobby after ALONE_GRACE 8 s. UI: roster with âœ• in the
  lobby, RETURN TO LOBBY + REMOVE buttons in the pause menu. Tests: `tests/unit/mp-host-powers.test.mjs`.
- [x] 2. Always-on sprint (forward runs; drops while the trigger is held; the autoSprint/toggleSprint
  settings are gone), white crosshair (settings `version` 2 migration), all lobby/match music removed
  (only the emote groove remains until step 9), snappy emote wheel (6 px deadzone, 36 px leash,
  clips preloaded after 12 s idle). sw cache v36.
- [x] 3. Crouch depth: eye 1.8 m standing, 0.95 m crouched (was 1.15). CROUCH_HEIGHT .57, chest .2, HB_PLAYER_CROUCH
  {halfH .2, headY .35, leg .38}, BODY_OFFSETS.crouch [.2,.52]. (In-pane screenshots of the 3D canvas were stale
  in headless, so it was verified by camera Y numbers: 1.80 -> 0.95.)
- [x] 4. Damage balance (distance falloff `damageAt`, pump strong close, sniper one-shot body, AR nerfed), the shield
  as a separate pool, Fortnite-style items (bandage +15 to 75 / 3 s, medkit +100 / 6 s, mini shield +25 to 50 / 2 s,
  big shield +50 to 100 / 4 s; `src/sim/items.js`; channelled, cancelled by fire/frag/smoke/emote/weapon swap),
  weapon tiers 0-3 (x1 / 1.08 / 1.16 / 1.25) on gun drops, kill drops, item bar + use bar HUD, first-person use
  animation, puppet heal spark (protocol v5). Health lag fix: `takeAuthority` copies health/armor/items from every
  you-block (before, `agrees()` ignored health so the HUD lagged until the next correction): test in mp-predict.
  The Mixamo heal clip is not done (needs the user to sign in); the procedural animation stands in for it.
- [x] 5. Zombie Escape (`mode 'zombie'`, protocol v6): see MULTIPLAYER.md. Melee zombies (walker / runner / brute),
  extraction zone (a far, reachable spawn) opens at 60 s and must be held 10 s, reinforcements after 25 s while a
  friend lives, OVERRUN when everyone is down or the clock ends. Tests: `tests/unit/mp-zombie.test.mjs`, e2e in
  multiplayer.spec. `claw` is appended to WEAPON_IDS; the input weapon byte is clamped to `frag` so it is never selectable.
- [ ] 6. Network: adaptive interpolation, bigger input queue, colo in /stats
- [~] 7. Lobby polish only so far (calmer spotlight column, map card scrim, zombie tile); a full redesign is open.
- [ ] 8. Lazy map loading, then new Blender maps (one per commit)
- [~] 9. Battery: the online lobby renders at 30 fps (`LOBBY_FPS`, `net.inLobby`); menus were already 15 fps and
  Battery saver already exists. Emote songs: handed to a worktree agent (see the merge notes at the end of the session).

---

## Session 8 (2026-10-04): multiplayer lobby, skins, controls, physics cost

The multiplayer work is documented in MULTIPLAYER.md; this is what else changed on
`claude/overrun-mp-lobby-modes` (live at https://overrun.dimahuang8.workers.dev, deploy with
`npx wrangler deploy`; the branch is not pushed).

- **Skins locker.** 20 Mixamo characters (`src/skins.js`, `assets/bots/*.glb`, portraits in
  `assets/skins/*.jpg`). Six `boot` skins load at start and feed the bots; the rest lazy-load the
  first time anyone wears one (`loadCharacter(id)`; `puppetFor` returns null until it is in). Online,
  a skin change in the lobby goes to the server as `{t:'gear', character, loadout}`. Adding a
  skin: Mixamo FBX with a skin, `node scripts/fbx-to-glb.mjs`, `node scripts/skin-portraits.mjs <id>`,
  one line in `SKINS`; `tests/e2e/skins.spec.mjs` checks every lazy skin binds the shared clips
  (finger bones may be missing, anything else may not).
- **Keybinds** (`src/keybinds.js`, settings panel): the one place keys enter (`player.js` keydown/up,
  the emote key in `main.js`) runs the code through `canon()`, so the rest of the game still reads
  the default codes. Bindings are one to one (binding a taken key swaps), saved under
  `overrun.keybinds`. The menu help, pause help, ammo hint and slot strip follow the bindings.
- **Touchpad switch** (`settings.touchpad`, helpers in `settings.js`): forces look boost, toggle aim,
  auto-sprint and a friction-only aim-assist floor without overwriting the individual settings.
- **Physics cost.** `src/sim/gridBroadphase.js` replaces cannon's sweep-and-prune (a grid over the
  static level, every raycast's AABB query goes through it) and the O(N^2) collision matrix (sparse
  now). Warzone (~900 bodies) cost 3.2 ms per physics step in the browser and 7.5 ms per server
  tick with 8 players (`spike/bench-room.mjs`-style run); both are now ~0.1-0.2 ms. `tests/unit/grid-broadphase.test.mjs`.
- **Fixed:** a player who joined mid-match never got the lobby stage when the room fell back to the
  lobby (lobby panel over the live world); lobby name-plate CSS was unscoped and broke the in-game
  enemy plates (health bar fill, corner placement).
- **UX:** secondary buttons (Settings, Spectate, Locker, Leave) have visible edges; the pause screen
  has a RESUME button and the key help; LEAVE MATCH is red.
- **Kill context, feed and killcam** (protocol v3). `src/sim/killinfo.js` turns a kill into flags
  (NOSCOPE = zoom weapon fired unscoped, LONGSHOT >= 45 m, MIDAIR = killer off the ground) plus a
  distance; the server fills them (`room.kill`), the KILL event carries `flags`+`dist`, and the single
  player path (`player.applyDamage` -> `killCombatant`) computes the same. Bots never get NOSCOPE
  (they have no scope). `src/killicons.js` has an SVG silhouette per weapon for the feed
  (`.kf .kicon`), with chips for HEADSHOT/NOSCOPE/MIDAIR/distance. The killcam now draws the killer
  (a puppet from the recorded frames), replays their shots as cosmetic bullets, and sits an
  over-the-shoulder camera behind them with a line-of-sight pull-in; the death text reads
  `KILLED BY name Â· weapon Â· tags`, and your own HUD hides while dead. The map hash folds in
  PROTOCOL_VERSION, so client and server must be deployed together.
- **FOV setting** (`settings.fov`, 60-100, default 78; ADS scales in proportion).
- **Playthrough findings (real GPU, headless Chromium):** WARZONE referenced a Poly Haven texture
  that has no `diff` map (`fabric_pattern_07`), a 404 on every load; sandbags now use `hessian_230`.
  Drivers must fake pointer lock (define `document.pointerLockElement` as the renderer canvas and
  fire `pointerlockchange` *before* the countdown ends), or the game shows GET READY / CLICK TO
  RESUME and nothing fires. `spike/play-mp.mjs` does this. Do not stub the CDN with a 1x1 PNG for
  visual checks: it renders every surface black.
- **Done since (protocol v4, sw cache v35):** MP survival (server-driven hostiles, waves scaled by
  player count, grid A* nav), and three Blender maps: DEPOT (duel/DM/TDM), BASTION (CTF/DM/TDM) and
  ARENA (survival only, 64 x 64 m, dusk, central dais for the people, gates for the hostiles). See
  MULTIPLAYER.md for the checklist a new map needs. `spike/` is scratch and is never committed.
- **Still open:** the server still accepts `soldier` in hello; gamepad grenades/aim assist and dropped weapons are not
  online; `desert-map.spec` ("a sv match on DESERT starts cleanly") and `hitboxes.spec.mjs:85` flake.
- **Crouch cancelled by a jump** could not be reproduced; ask for exact steps.

## Next session â€” start here

1. **Playtest sessions 6 and 7** in a real browser (`node scripts/serve-tests.mjs`, then
   http://localhost:4173, Ctrl+Shift+R once â€” the cache is now `overrun-v17`). Sound and music
   in particular were only checked for "runs without errors": nobody has listened to them.
   DESERT and SNOW were checked from headless screenshots and the specs, not played.
2. Map tweaks are a script edit and one Blender run away â€” see "Changing PORT" below; DESERT
   and SNOW work the same way with `build_desert.py` and `build_snow.py`.

---

## Session 7: the maps

WAREHOUSE, FOUNDRY and DUNGEON are retired, with everything only they used (the arena, prop
and dungeon builders in `maps.js`, their config constants, tiles and tile art, the foundry
spec). The lobby now has three maps, all modelled in Blender, all 180-degree symmetric:

| Map | Script | Loaded by |
|---|---|---|
| PORT (default) | `scripts/blender/build_port.py` | `src/mapPort.js` |
| DESERT â€” a walled town at mid-afternoon: market square, souk and caravanserai on each flank | `scripts/blender/build_desert.py` | `src/mapDesert.js` |
| SNOW â€” a research outpost at dusk: frozen pond round a radio mast, a station and a garage on each flank | `scripts/blender/build_snow.py` | `src/mapSnow.js` |

- **One loader.** `src/mapGlb.js` loads any Blender map: the GLB (one mesh per material key),
  the collider JSON, a sky dome with clouds, a PMREM environment from the same sky, and the
  map's lamps. A map's `src/map*.js` is only what differs: materials, look, spawns, pickups,
  lamps. `GLB_MAPS` in `maps.js` lists them.
- **A shared piece kit.** `scripts/blender/mapkit.py` has the export, the collider table and the
  Poly Haven prop import; each map script is its layout. Props take their colliders from their
  measured bounds.
- **Textures** are Poly Haven CC0, 2k on the Quality preset and 1k otherwise. Coloured cladding,
  snow and paint use a texture's luminance over a chosen colour (`pbrMat({ detail: true })`).
- **Poly Haven units.** `steel_frame_shelves_01` ships in decimetres and imported 21 m tall â€”
  on SNOW that was the "four tall towers" over the buildings. The importer now rescales a model
  that is off its listed size by a power of ten.
- **Specs.** `desert-map.spec.mjs` and `snow-map.spec.mjs` are PORT's checks per map: colliders
  equal meshes both ways, symmetry, heights (a berm or crate is a hop, a cabin or container a
  wall), TDM/Survival/Duel start cleanly. Bots cross all three maps end to end.
- **Pause fix** (`4140d6b`): regaining pointer lock resumed the match but never hid the pause
  overlay, so you played blind behind it. The lock handler in `player.js` now hides it (unless
  you are dead: the death screen shares that overlay).
- Unused now: the Kenney models in `assets/models/` (12 MB: factory and dungeon kits, and the
  blasters), still in the repo, not referenced by any code or the service worker.

---

## Session 6: the fifteen-point list

| Ask | Where |
|---|---|
| Fortnite-style locker | `src/locker.js`, `src/loadout.js` (saved to localStorage). Lobby card and pause button. Four guns from five, SMG added. |
| Crouch to dodge | Crouch slide from a sprint, lower hitbox (`PLAYER_CHEST_CROUCH`). |
| Hold G to throw further | Cook time sets the throw speed, with a drawn arc. Three frags in a row all go off. |
| Bots looked short | Player eye lowered to 1.8 m (`CONFIG.EYE_HEIGHT` 1.3 above the foot sphere). |
| Crosshair per gun | `#crosshair` classes per weapon in `ui-overhaul.css`. |
| Minimap | `src/minimap.js`: a rotating 2D radar drawn from `blockers`, not a second WebGL render. |
| Health you can read | Thick bottom-centre bars; a pale chip trails each hit for a moment. |
| Win screen | 5 s slow motion (`OUTRO_TIME_SCALE`) under VICTORY/DEFEAT, then a podium. |
| No scrollbars | Hidden everywhere; `match-end.spec` checks every screen at two sizes. |
| Lobby | Mode and map are cards that open popouts of big tiles (`#mode-pop`, `#map-pop`). |
| Standings while dead | The pause-screen board during the respawn wait shows your place. |
| Smoke | Denser and longer. |
| Sound | `src/audio.js` rewritten. Other people's sounds go through an HRTF panner at their world position (direction + distance fall-off + an air low-pass). Per-gun shots, a pump/bolt after your own shotgun/sniper shot, reload foley stepped through `reloadProgress`, per-gun hit ticks, a shield crack and a shield break (hitting a shielded bot, or being hit on your shield), low-health heartbeat, UI ticks. |
| Music | Synthesised step sequencers (`SONGS` in `audio.js`): lobby, match, emote, and a win/loss stinger. Own volume slider in Settings. |
| Emotes | `src/emotes.js`. Hold **B**, point, let go. Eight Mixamo clips in `assets/player/emotes/` (not precached, loaded on first wheel open). Plays on a roster character in third person; moving, jumping, firing or dying ends it. Bots never emote. |

Notes:
- Bots only carry shields in Duel (they copy yours), so the shield crack on a hit is a Duel
  sound; the incoming crack plays in every mode. Giving bots shields elsewhere would change
  time-to-kill, so it was left alone.
- The lobby music needs a gesture before a browser will play it; it starts on the first click
  or key press.

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
  roofs â€” the Foundry bug from session 1 would otherwise have put the spawns on the roof.
- TDM, Survival and Duel each start cleanly on PORT, nobody on a roof. **A duel opens 114 m
  apart** â€” the duel takes the two furthest spawns, which on a 100 x 76 m map are opposite
  corners. Playable, but a long walk; a duel-only spawn pair (the two sheds, 62 m apart) would
  fix it if it feels slow.

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
Spawn candidates must clear `buildSpawnPoints`' 2 m blocker pad â€” 14 of the first 18 did not.

---

## Session 4: your ten points

Numbers are measured, before -> after. Each fix has a regression test that was re-broken and
seen to fail on the old code.

1. **"The AI lags and teleports when I aim."** Two causes, both in how bots move.
   - *The animation clips carry root motion* â€” despite the manifest saying "In Place". The drawn
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
   root motion per character â€” the planted foot used to move at up to 15 m/s while chasing, now
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
   straightening tested ~1.7 m up â€” over every low wall and crate. Stuck episodes per 240
   bot-seconds: 49-75 -> 0 on all three maps.
7. **Hitboxes and "why didn't the headshot kill?"** Bots are hit on capsules on their posed
   skeleton: head x4 (an AR headshot now kills an unarmoured bot; it did 62), body and arms x1,
   legs x0.75 (`tests/e2e/hitboxes.spec.mjs`). The player's own hitbox had a "limb" cylinder
   that enclosed the torso, scoring most chest hits at 0.6x â€” fixed. Feedback: gold hitmarker +
   metallic sound for a headshot, red for a kill, zone-coloured damage numbers, a kill banner
   (with HEADSHOT), and an enemy you just hit shows its health for 2.5 s. Sniper body shots kill.
8. & 9. **UI.** One stylesheet replaces the inline block and the override layer: text over the
   game instead of glass panels, Barlow Condensed instead of Orbitron, one amber accent instead
   of neon cyan; scanlines, gradient title, emoji icons, the fake player card and the debug
   loading line are gone. READMEFORUI.md is updated.
10. **Movement.** Acceleration + friction (full speed in 0.19 s, stop in 0.21 s â€” it was ~0.05 s
    both ways), a quicker committed jump (same 1.25 m apex, 0.74 s in the air instead of 0.96 s,
    via extra player-only gravity), weak air control, a landing dip. `tests/e2e/player-movement.spec.mjs`.

Knock-on: hard bots now land 38% of rounds on a standing target at 20 m (was 72% â€” the old
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
   measures each character's facing from its own skeleton â€” on the *posed* rig, because the
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
   guard â€” which ran before the alive check â€” teleported it to a spawn point in mid-air while
   it faded. Frags launched corpses through walls too, because the explosion impulse hit every
   body with mass. Corpses are now kinematic and settled on the floor, and the impulse only
   touches dynamic bodies.
4. **Movement stuttered at every frame rate.** Nothing interpolated between the 120 Hz physics
   steps, so the camera and every bot advanced 1, 2 or 3 steps' worth per frame. Drawn-speed
   jitter on a bot held at a constant 3 m/s: 14.2% before, 3.0% after (`Bot.placeMesh`,
   `renderAlpha` in main.js). Crouch used to drop the camera 0.77 m in one frame and step-ups
   popped it; both are eased now.
5. **The session-2 frame cap caused judder.** It aimed at exactly 60, which a 144 Hz panel can
   only give by alternating 14 ms and 21 ms frames. It now runs every Nth refresh â€” evenly
   spaced, landing at or a little above the cap (72 on 144 Hz).
6. **Aim pitch overwrote the animation.** It assigned the spine, neck and head X rotation
   instead of adding to it, throwing away the clips' torso lean. It also bent the wrong way
   once the models faced forward â€” measured, and flipped (`AIM_PITCH_SIGN`).
7. **Team kit** â€” the chest band and pads floated off the body. Now an armband on each upper
   arm, fitted from that bone's own vertices and carried by the animation.

UI fixed in the same pass: final standings on the menu after a match (there was no results
screen), the result line no longer drawn over CALLSIGN in short windows, the HUD scales down
below ~1280x720 (at 800x450 it covered half the screen), allies labelled once instead of
twice, no "walk in to collect" when you are already full, pointer-lock rejection handled.

**What the playtest found and did not fix â€” worth your call:**
- **The guns are toy blasters.** The viewmodels are the Kenney Blaster Kit â€” bright orange,
  green and white plastic. That clashes with "Valorant / professional shooter" more than
  anything else on screen. Blender MCP is connected now; swapping in realistic weapon models is
  an art task, and a good use of it.
- The maps are functional but plain, and Foundry's ceiling lamps render as flat white discs.
- The menu's player card is hard-coded ("DH4410 / LEVEL 12") and the loading status line
  ("96 nav nodes Â· 8/8 prop models") is debug text shown to the player.

## Session 2: what the playtest found

You reported: *the AI moves weird, the animation does not match the actual movement, and they
lag like they move at 2 fps*. That turned out to be one bug, plus a second one underneath it.

**1. The loop threw simulation time away below 30 fps.** `CONFIG.MAX_SUBSTEPS` was 4, covering
33.3 ms â€” exactly one frame at 30 fps, so no headroom at all, and below that the accumulator
guard discarded the remainder every single frame. Measured in the real game, loaded down to
10 fps: the simulation ran at **0.32x real time**. That is the "2 fps". It is also half of the
animation complaint, because a bot's legs are paced off its *velocity* while its body was only
covering a third of that per second, so the feet skated. Now 16 substeps (133 ms, real time
down to 7.5 fps). One fixed step measures 0.407 ms, so the worst case is 6.5 ms of catch-up on
a frame already over 130 ms long, and the frame rate was identical at 4, 8 and 16 substeps â€”
which is the evidence that this cannot spiral.

**2. Locomotion clips were paced by total speed, not by direction.** A bot closing while
side-stepping travels ~5.2 m/s in total but only ~3.5 m/s sideways, and feeding the total to a
strafe clip authored for 1.6 m/s asks for 3.2x, which hit the old 1.8 ceiling. Measured across
a live match: **30% of all moving frames were pinned to that clamp**, meaning legs covering 56%
of the ground the body did. Each clip is now paced by the component of travel it is responsible
for, the ceiling is 2.6, and the walk/run crossfade was re-centred on the two clips' real
speeds. Re-measured after the fix: **1.5%**.

**Still open, and you will see it in any close-up:** the green team kit â€” chest band and
shoulder pads â€” is parented to the mesh group rather than to bones, and was sized for the old
blocky humanoid. On the rigged characters it reads as large green blocks that do not move with
the body at all. Fix: parent it to `Spine2` and the shoulder bones in `buildSoldierMesh`
(`src/bots.js`) and scale it to the character. This is the next thing I would do.

## Carried over from session 1, still true

1. **Very little has been playtested by hand.** Session 2 playtested the bots specifically. How
   the rest *feels* â€” the elite bot, the new TTK â€” is still unverified.

2. **AR damage went 18 â†’ 26, pistol 12 â†’ 15.** Bots use the same weapon table as the player,
   so this made every bot at every difficulty in every mode roughly 45% deadlier â€” that was
   not the stated intent of the gunplay change, it is a side effect. If the game feels
   punishing, revert this first: `src/weapons.js`, `WEAPONS[].damage`.

3. **The e2e harness cannot tell you the game looks right.** Every test reroutes the CDN and
   stubs the Poly Haven textures with a 1Ã—1 image, so every scene looks wrong in the same
   way. Foundry shipped as a literally black screen and the whole suite stayed green. Visual
   checks must go through the real page (see below).

---

## What was built â€” session 2 (laptop and battery)

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
  check it walked to the 0.6 floor on a CPU-bound machine and bought nothing â€” measured, in the
  real game, before the check existed.
- **Fire rate no longer depends on frame rate.** The cooldown carries its overshoot past zero
  into the next shot. Without it a 30 fps cap rounds the AR's 0.09 s cooldown up to 0.1 and the
  player loses a tenth of their rate of fire to a graphics setting, while bots â€” which fire on
  the fixed clock â€” keep all of theirs.
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

## What was built â€” session 1

- **1v1 Duel** â€” round-based, one life each, first to `CONFIG.DUEL_ROUNDS` (7), mirrored
  spawns, mirrored loadout, always the ELITE tier. `src/match.js`.
- **ELITE bot** â€” per-tier aim profiles in `src/bots.js`. Measured at 20 m against a
  stationary target: hard 0.72 hit / 0.02 headshot, elite 1.00 / 0.75, elite-while-strafing
  0.03. That last number is the counter-play and `tests/e2e/duel.spec.mjs` asserts it holds.
- **AI movement** â€” acceleration-limited locomotion, counter-strafing, cover peeking instead
  of a magic heal, string-pulled paths, pre-aimed angles.
- **Gunplay** â€” additive accuracy cone (rest / move / air / spray bloom), deterministic
  recoil patterns, crosshair that tracks the live cone.
- **FOUNDRY** â€” mirrored three-lane map with a contested raised mid.
- **Grenades** â€” inherit thrower velocity, tumble, roll to a stop; underhand lob on RMB.
- **Characters** â€” Swat Guy, Crypto, Ely and the original soldier, split by team.
- **Animation** â€” eight Mixamo clips, directional blending, spine-driven aiming, authored
  death, weapon carried in the hand bone.

Branch triage: only `codex/phase2-modularization` had anything to merge (it splits the old
5,822-line `game.js` into `src/` modules and adds an ESLint `no-undef` gate). Everything else
was already contained in it or zero commits ahead. **Nothing was deleted.**

---

## Open items

- [x] **Decide what to do with the branch** â€” done: it is on master (sessions 1-5 by PR #7,
      sessions 6 and 7 pushed directly).
- [ ] **An e2e spec for aim assist, trackpad boost and auto-sprint.** None of them are executed
      by any test yet.
- [ ] **Playtest.** Especially the elite bot's difficulty and the new TTK.
- [x] **Scene lighting from the sky** â€” done in session 7: every Blender map gets a PMREM
      environment from its own sky (`skyEnvironment` in `mapGlb.js`, strength `look.env`).
- [ ] **More animation, if wanted.** Hit reactions were discussed but not added â€” the bot has
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
at load; its "which axis is up" test is the axis that never nears zero â€” the largest average is
wrong, because a Run cycle's forward drift averages more than the hip height.

**The e2e harness fakes requestAnimationFrame**, so Playwright's actionability "stable" check
never passes for a click inside a match: use `element.click()` in `page.evaluate`. Its fake
gamepad also rewrites `aiming` every frame â€” hold LT (button 6) to aim in a test.

**A ray exactly along a face or through a corner can go either way.** Two symmetric sight
lines disagreed on PORT because both grazed a box corner. The layout's edges are all at round
numbers, so the specs' probe grids sit at 3-decimal offsets. Keep them off-grid.

**The built-in browser does download, but leaves the file as a GUID `.tmp`** in Downloads
(apparently waiting on a save prompt), and the app deletes it later. The file is complete (an
FBX ends with the magic footer `f85a8c6adef5d97eece90ce3758f290b`): copy it under a proper name
straight away, then convert.

**Blender's glTF exporter with `export_vertex_color='ACTIVE'` writes an extra all-white COLOR_0**
ahead of the real set, and three reads COLOR_0: every container came out white. The script
exports the colour set by name.

**"Every track binds" is not "the pose is right".** The crushed soldier bound every track of
every clip. Measure the pose itself â€” head above feet, toes along the heading â€” as
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
*and* take one screenshot to force the pending native callback to fire â€” the loop then
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
draw groups and re-encodes textures â€” typically 115 MB â†’ under 4 MB. It **rejects**
characters whose parts each carry their own copy of the skeleton (Exo Gray: 896 bones, 784
duplicates), because only one part of those would animate. Then add the file to `CHARACTERS`
in `src/bots.js`.

**Add a map made in Blender:** follow SNOW â€” a generator script on `mapkit.py` that emits
meshes and colliders together, a GLB named by material key plus a collider JSON, and a
`src/map*.js` definition added to `GLB_MAPS` in `maps.js`. `loadGlbMaps` loads every map at
boot alongside the character loads; a map is marked `available` in `MAPS` only once its files
arrive. Add a lobby tile in `index.html` and tile art in `ui-overhaul.css`.

**Add an animation:** download as FBX **Without Skin**, with **In Place** ticked for anything
locomotive (bots are physics-driven, so root motion makes them slide). Drop it in
`assets/bots/anim/` and name it in `manifest.json`.

---

## Running the real game

```bash
node scripts/serve-tests.mjs
```

Then open `http://localhost:4173`. `window.__game` is exposed on localhost only and is the
fastest way to drive a scenario â€” e.g. `__game.startMatch('duel','medium','PLAYER','snow')`.
Pointer lock fails inside an embedded preview pane; that error is the pane, not the game.
