# Playtest report (partial)

Scope of this pass: boot/start matrix for every mode on every map that hosts it, plus the known
`match-modes` failure. Everything else in the playtest brief is **not yet done**.

## Verified (ran it)
- Start + 240 sim frames, 1280x720, no console/page errors, finite player and bot positions:
  dm (7 maps), tdm (7), hp (7), sv (5), gg (7), duel (4: port, desert, snow, depot) — 37/37.
- lint 0 errors (12 warnings), unit 247/247.

## Bugs
1. **Gun Game / Hardpoint unplayable from the lobby map picker (fixed).** `src/ui.js` tested
   `map.modes.includes(mode)`, but no map lists `gg` or `hp`, so every map greyed out; this is also why
   `startMatch` timed out in `match-modes.spec.mjs`. The server already used `mapHosts` (hp->tdm, gg->dm);
   the lobby now does too. Covered by the existing Gun Game and Hardpoint e2e tests.

## Missing / polish (unverified, from reading code only)
- Screenshots from the fake-clock harness are not reliable for judging visuals (blank scene, intro banner
  still showing, a stray "AMMO / ELIMINATED" bar in the HUD at 1280x720); needs a real-clock look.
- `codexbugs.md` is stale: `viewBob` is wired (`src/main.js`). Other entries not re-checked.
- Not covered: weapons matrix, bot styles, kill cam, settings tabs, meta/lobby, online, 1920x1080 and 390x844.
