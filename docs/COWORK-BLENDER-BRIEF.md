# Brief for local Claude (Sonnet 5): Blender crate, animations, skins for OVERRUN

Paste everything below the line into a local Claude Code / Cowork session opened in your
`shooting-game` folder (the clone of `DH4410/Overrun`), with the Blender MCP connected and a browser available.

---

You are working on OVERRUN, a browser FPS (three.js 0.169 loaded from a CDN, cannon-es, no build step: the game boots from static files). Your job is the 3D art and animation pass that the cloud session could not do, because it had no Blender and no free internet. Work on a new branch off `claude/overrun-cosmetics` (the branch that holds the store, crate and gun-skin work; if you cannot find it, use `master` and say so). Do not push to `live-deployed` and do not open a PR unless I ask.

## Ground rules (read first)

1. **Search online for assets before modelling anything yourself.** Check Poly Pizza, Sketchfab (downloadable, CC0 / CC-BY only), Kenney.nl, Quaternius, ambientCG, Poly Haven. Prefer CC0. Record every asset you use in `assets/LICENSES.md` (create it if it does not exist) (name, author, URL, licence, what it is used for). If the licence is not CC0 / CC-BY / similar, do not use it. Model it yourself instead.
2. **Battery and lag matter more than polish.** The player base is on laptops. Budgets: crate GLB at most 600 KB and 30k triangles; each texture at most 1024 px on the long edge, JPG for colour, no PNG unless alpha is needed; one draw-call-friendly material set (at most 6 materials); no real-time shadows or post-processing added for it. Bake lighting and ambient occlusion into textures in Blender where it helps.
3. **Assets ship as files in `assets/`, not generated in code at runtime.** The game's service worker (`sw.js`) precaches them; bump the cache name (`overrun-v68` is current) and add the new files to its precache list.
4. **Never ask me for passwords in chat.** For Mixamo you need an Adobe login. Open the browser, go to mixamo.com, and wait for me to log in myself, then carry on.
5. No text or pictures may touch the border of their box in any UI you change. Give them space. Never make the player scroll.
6. Do not put any AI-model name in commit messages, code comments or files.
7. Run `npm test` and `npm run lint` before each commit. Both must pass (219 unit tests; lint has 12 existing warnings and no errors). The store e2e spec needs `TEST_PORT=4290 npx playwright test tests/e2e/store.spec.mjs`.

## Task A: the supply crate and its animation (Blender)

Today the crate is built in code in `src/crateModel.js` (`buildCrate(onLoad)` returns `{ crate, lid, seamMat, dispose }`) with baked textures in `assets/textures/crate/` (`panel`, `bump`, `end`, `endbump` JPGs). It is used by `src/crateDrop.js` (the full-screen drop window) and as a still picture in the store (`crateStill`). It is not detailed enough. Replace the look with a proper model.

Deliverable: `assets/models/crate/supply-crate.glb`.

- Look: a heavy military/industrial supply crate. Think pressed steel panels, reinforced corner castings, rivets, stencilled lettering ("SUPPLY DROP", "CLASS A", a warning triangle), hazard stripes, scuffs, rust at the edges, rubber/steel handles, a hinged or lift-off lid with latches and a gasket line, a glowing seam light strip (this is the tell for crate rarity, see below), and a small vent. Roughly 1.5 m x 0.9 m x 1.05 m (width x height x depth), origin at the centre of the base so it can sit on y = 0.
- Search for a base crate model first (Poly Pizza / Kenney / Quaternius sci-fi or military crates). Use it as a base if the licence allows and improve it (extra bevels, panels, decals, wear). Otherwise model it yourself.
- Node contract (names matter, the code looks them up):
  - `crate` (root), `body` (everything that stays), `lid` (the part that opens; its origin sits at the lid's centre so the existing fly-away code can move it).
  - A material named `seam` for the emissive light strip. The code drives its emissive colour and intensity per rarity, so give it a plain white emissive base and keep it a single material.
  - A material named `chute` is NOT needed. The parachute stays in code.
- Animation clips in the same GLB (names matter): `idle` (tiny sway, 2 s loop), `land` (a hard-landing squash and bounce, 0.8 s, once), `shake` (warming-up rattle, loops), `open` (lid unlatches, lifts, tips and falls away; about 1.2 s; end pose has the lid hidden or far from the camera). Keep it light: rigid-body style transforms on `lid` and `crate`, no skinning, no shape keys.
- Export: glTF Binary, Y-up, apply transforms, Draco or meshopt compression only if `three/addons` loaders are already importable offline in this repo (check `scripts/glbquant.mjs` and how other GLBs in `assets/models` are loaded). If neither works, ship uncompressed but inside the size budget.
- Integrate: change `src/crateModel.js` so `buildCrate` loads the GLB with `GLTFLoader` (look at how `src/bots.js` / `src/lobby.js` load GLBs) and keeps the existing procedural crate as the fallback when the file has not loaded yet or fails. Keep the return shape `{ crate, lid, seamMat, dispose }`, and add `mixer` plus an `actions` map for the clips. In `src/crateDrop.js`, play `land` at `FALL`, `shake` between `FALL` and `BURST`, and `open` at `BURST` (replace the hand-coded lid flight, keeping the timeline constants `FALL=2100`, `LOCK=3300`, `BURST=4300`, `CARD=5200`). The e2e helper fakes `performance.now`, so drive the mixer from the same clock the drop uses, never from a separate real-time clock.
- `crateStill` (the store picture) should render the GLB once and stay as an image. No live 3D canvas in the store.
- Show me screenshots of: the crate on the store page, the drop falling, landing, charging, bursting for common and legendary, at 1366x768 and 800x450.

## Task B: more crate animation polish (optional, after A is merged in your branch)

- A second, bigger "premium crate" variant (same GLB with a different `body` material colour, gold trim) for a future legendary-only crate. Only add it if the base crate is finished and under budget.
- A short looping "float and glow" idle for the store page still, if it costs nothing at rest. Otherwise skip it.

## Task C: operator skins (Mixamo)

Goal: more unique, **lighter-coloured** characters that do not look like well-known game characters. The 20 current ones are listed in `src/skins.js` (`SKINS`: id, name, tag; portraits in `assets/skins/<id>.jpg`). Several are too dark.

1. Open mixamo.com in the browser. Wait for me to sign in.
2. Pick characters that are bright or mid-tone and distinctive. Avoid anything resembling a famous franchise character. Aim for 6 to 8 new ones. Download each as FBX Binary with skin, T-pose.
3. Do not download animations. The game reuses its own animation set (see how the existing characters are rigged and animated in `src/bots.js` and `src/player.js`; the rig must match the current Mixamo skeleton naming, `mixamorig:*`).
4. Convert each with `node scripts/fbx-to-glb.mjs <input.fbx> assets/bots/<id>.glb --max-texture=1024` (characters live in `assets/bots/`; `src/bots.js` line ~475 builds the path as `./assets/bots/<id>.glb`). Target under 1.5 MB per character.
5. Add each to the END of `SKINS` in `src/skins.js` (new ids go last so saved picks keep their place; no `boot: true`, they lazy-load). Add each id to the server's accepted list (it derives from `CHARACTER_IDS` in `src/skins.js`, so check nothing else hardcodes the list: `grep -rn "CHARACTER_IDS\|'warzombie'" src server`).
6. Render a portrait for each with `node scripts/skin-portraits.mjs` (read it first for flags) into `assets/skins/<id>.jpg`.
7. Credit them in `assets/LICENSES.md` (Mixamo characters are free to use in games under Adobe's terms; say so).
8. For the existing too-dark ones, lighten by editing the model's base-colour texture or material tint where `src/lobby.js` / `src/bots.js` applies materials. Do not change ids.

## Task D: gun models (only if time remains)

`src/gunmodels.js` builds every gun in code from extruded profiles and boxes. Search online first for CC0 gun models (Quaternius, Kenney, Poly Pizza) that fit each gun id. If you find good ones, ship them as GLBs in `assets/models/guns/<id>.glb` with the same node names the code expects (read `gunmodels.js` and `src/gunskins.js` first: skins recolour the materials named `polymer`, `alloy`, `steel`, and project baked patterns from `assets/textures/guns/` onto them with a triplanar-style shader patch in `src/gunTextures.js`). Keep the three material names or the gun skins stop working. Muzzle, grip and viewmodel scale must match what the code uses today. If this is a big rewrite, stop and report instead.

## Task E: real textures for gun skins (needs open internet on your machine)

The 17 JPGs in `assets/textures/guns/` are baked from procedural patterns (`tools/gunTextureDraw.js`, built with `npm run bake:textures`) because the cloud session could not download real materials. You can. For each pattern name (carbon, brushed, speckle, camo_wood, camo_desert, camo_urban, rust, scales, leather, magma, marble, hex, circuit, hazard, facets, damascus, swirl), look for a matching CC0 tileable colour map on ambientCG or Poly Haven (for example carbon fibre, brushed metal, rust, leather, marble, scales). Download at 1K, convert to a seamless 512 px JPG (quality 0.85, under 60 KB each), and save over the file with the same name. Keep the name `<pattern>.jpg`. Record each source in `assets/LICENSES.md`. Skip patterns with no good match (the procedural one stays).

## Finishing

- `npm test`, `npm run lint`, the store e2e spec, then a manual look at the store and a drop of each rarity (common, rare, epic, legendary).
- Commit in small steps. Report what you changed, the file sizes, the licence list, and anything you skipped and why. Do not push without telling me the branch name first.
