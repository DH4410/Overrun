# OVERRUN — Bot Deathmatch

OVERRUN is a browser-based first-person shooter where you fight AI bots in fast arena combat.

## What the game includes

- **Game modes**
  - Deathmatch (free-for-all, first to 20)
  - Team Deathmatch (you + allies vs enemy team, first to 25)
  - Survival (endless waves, score by kills)
- **Maps**: Warehouse and Dungeon
- **Weapons**: multiple weapon slots, reloads, aiming/scope, frag and smoke grenades
- **HUD systems**: health/armor, ammo, minimap, scoreboard, kill feed, damage indicators
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
- `Tab` scoreboard
- `Esc` release cursor / pause

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
