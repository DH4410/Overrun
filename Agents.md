# Agents Notes (What to Be Careful About)

This file is for contributors/agents working on OVERRUN.

## Key cautions

1. **Do not break gameplay feel**
   - Movement, recoil, damage, and projectile timing are tightly tuned.
   - Small numeric changes can make the game feel wrong quickly.

2. **Respect physics and collision assumptions**
   - The game uses `cannon-es` bodies for world/combatants/grenades.
   - Bullets are handled manually; avoid mixing in rigid-body bullets.

3. **Keep performance in mind**
   - This is a real-time FPS; avoid expensive per-frame logic.
   - Prefer lightweight updates inside render/physics loops.

4. **Be careful with controls and pointer lock**
   - Input and pointer-lock flow directly affect playability.
   - Test pause/resume and cursor lock behavior after input changes.

5. **Do not break HUD readability**
   - HUD elements communicate critical state (HP, armor, ammo, score).
   - Preserve clarity and contrast when changing styles/layout.

6. **Service worker behavior matters**
   - Source files use network-first, assets use cache-first.
   - If changing caching logic, avoid stale-code debugging traps.

7. **Preserve offline/fallback behavior**
   - Prop loading has procedural fallbacks for missing files.
   - Keep graceful degradation instead of hard failures where possible.

8. **Keep changes scoped**
   - Prefer small, focused edits.
   - Avoid unrelated refactors in the same change.

## Before finishing a change

- Confirm the game still starts from menu and enters a match.
- Verify controls, firing, reloads, and scoreboard still work.
- Check no accidental asset path or cache key breakage was introduced.
