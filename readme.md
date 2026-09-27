# OVERRUN — Bot Deathmatch

OVERRUN is a browser-based first-person shooter where you fight AI bots in fast arena combat.

## What the game includes

- **Game modes**
  - Deathmatch (free-for-all, first to 20)
  - Team Deathmatch (you + allies vs enemy team, first to 25)
  - Survival (endless waves, score by kills)
  - 1v1 Duel (round-based, one life each, first to 7 — always the ELITE bot)
- **Maps**: Warehouse, Foundry (symmetric three-lane, built for duels) and Dungeon
- **Weapons**: multiple weapon slots, reloads, aiming/scope, frag and smoke grenades
- **HUD systems**: health/armor, ammo, minimap, scoreboard, kill feed, damage indicators,
  and a crosshair that opens to match your live firing cone
- **Gunplay**: standing taps are pinpoint; moving, jumping and spraying each widen the cone
  on their own terms, and each weapon has a learnable recoil pattern
- **Offline support**: service worker caches core files and assets

## Controls

- `WASD` move
- `Space` jump
- `Shift` sprint
- `C` crouch
- `LMB` fire
- `RMB` aim / scope
- `1`–`5` switch weapons
- `R` reload
- `G` hold to cook frag
- `F` throw smoke
- `RMB` while cooking — underhand lob instead of an overhand throw
- `Tab` scoreboard
- `Esc` release cursor / pause

## Bot characters and animation

Bots draw from a roster of rigged characters (`assets/bots/*.glb`) and share one clip set
(`assets/bots/anim/`, listed in `manifest.json`). Both come from mixamo.com.

To add a character, download it as FBX and run:

```bash
node scripts/fbx-to-glb.mjs <input.fbx> assets/bots/<name>.glb --max-texture=512
```

That normalises the height, restores the `mixamorig:` bone names, indexes the geometry,
merges draw groups and re-encodes the textures — typically 115 MB down to under 4 MB. It
refuses characters whose parts each carry their own copy of the skeleton, because only one
part of those would animate. Then add the file to the `CHARACTERS` roster in `src/bots.js`.

To add an animation, download it as FBX **Without Skin**, with **In Place** ticked for
anything locomotive, drop it in `assets/bots/anim/` and name it in `manifest.json`.

## Tech stack

- `three.js` for rendering
- `cannon-es` for physics
- Plain HTML/CSS/JS (no build step)

## Running locally

Serve the project from an HTTP server (not `file://`) so ES modules and the service worker work correctly.

Example:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.
