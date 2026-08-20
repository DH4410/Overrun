# OVERRUN — Game Mode GDD: "The Blackout Phase"

**Mode type:** 5v5, round-based, one-life-per-round
**Maps:** `warehouse`, `dungeon` (dungeon strongly recommended for launch — see Balancing)
**Author role:** Lead Game Designer / Systems Architect

---

## 1. UTILITY & EQUIPMENT DESIGN

All gadgets are physical hardware — batteries, chemicals, springs, glass. Costs are spent from the round economy (Section: Round Structure). Each entry states its pre-blackout and post-blackout behavior explicitly, because the blackout is a state change the item must react to, not just flavor text.

| Gadget | Slot | Cost | Charges | Core Spec |
|---|---|---|---|---|
| Glowstick Marker | Utility 1 | $200 | 2 | Thrown, sticks to any surface, 15s burn |
| Breach Flare | Utility 1 | $350 | 1 | 4m radius flash + 6s standing light source |
| Directional Mic Puck | Utility 2 | $400 | 1 | Stationary, 8m pickup radius, 20s |
| Kinetic Ram | Utility 2 | $300 | 1 | One-shot door impulse, 2s stagger |
| Chem-Light Grenade (team) | Utility 1 (Defender only) | $450 | 1 | 6m AoE, 25s, team-colored |
| Backup Battery Pack | Utility 3 | $250 | 1 | Recharges one personal light-budget slot |

**Glowstick Marker** — Thrown like the existing frag (reuses grenade arc/impulse code). Before blackout: cosmetic, mostly ignored since ambient lighting already reveals the room. After blackout: becomes the cheapest form of vision denial-counter — it is a persistent low-priority light emitter (priority tier 3, below torches/chest glows) that the light-budget system will *drop first* if the leased-light pool is full, meaning attackers must actively manage how many they've thrown or their own markers start blinking out. 15s burn, 1.5m radius, visible on minimap-equivalent only as a light source (no HUD blip — minimap is fully gone, see Section 2).

**Breach Flare** — Fired into a room, physically identical to a frag grenade but non-damaging. Before blackout: functionally useless (rooms are already lit; the 4m flash is invisible against normal exposure). After blackout: this is the single most important attacker tool. It requests a *priority-1 light lease* — it will bump glowsticks and even reboot-console ambient glow off the budget for its 6s life, guaranteeing a real lit patch of floor. Bots' LOS/spot check runs normally in flare light (no smoke-style suppression), so a flare is a deliberate "yes, they can see me too" trade — used to push, not to snipe from.

**Directional Mic Puck** — Placed on a surface, listens in an 8m radius and feeds directional callout pings (arrow ticks at the HUD edge, not map coordinates) whenever a footstep or gunshot audio event fires inside range. Before blackout: minor value, since the minimap already blips spotted enemies visually. After blackout: this is the *only* remaining source of positional information for either team once the minimap is stripped — it becomes a contested placement, and destroying an enemy's puck (2 body-shot equivalents, 20 HP prop) is a legitimate tactical objective.

**Kinetic Ram** — A one-shot spring-loaded impulse device (reuses cannon-es rigid-body impulse application already used for grenade physics/knockback) that forces open a jammed door or knocks a barricade prop. Before blackout: a soft-breach convenience tool, saves 2s over lockpicking. After blackout: doors on backup power (see Map Design, Section 3) can fail *locked*; the Ram becomes the only way through them without going the long way, so it's the mode's designated tempo tool for the 45-second reboot timer.

**Chem-Light Grenade (Defender-only)** — Same throw/impulse profile as the Glowstick but tinted the defending team's color and given priority tier 2 (above enemy glowsticks, below flares). Before blackout: unused (round hasn't reached blackout yet, item is disabled/greyed in the buy menu pre-pull). After blackout: this is defenders' answer to attacker flares — since defenders know their own map callouts blind, a chem-light thrown into a defended chokepoint lets teammates orient without needing to look at a friendly light (bots and players alike read it as "safe glow" via team-color tint on the emitter shader, no gameplay LOS change, purely a comms tool).

**Backup Battery Pack** — Consumable that instantly restores one personal light-lease slot (see engine note: light-budget leases are per-priority-tier, not infinite) — effectively a "my flare/glowstick got starved off the budget, force it back on for 4s" panic button. Only relevant post-blackout; pre-blackout it does nothing and is disabled in the buy menu until the Breaker is pulled, exactly like the Chem-Light.

---

## 2. AUDIO & VISUAL DESIGN ("JUICE") — The Pull Sequence

This is the signature moment of the mode. Sequence begins at **T+0ms**, the instant the Breaker interaction completes.

| Time | Event |
|---|---|
| **T+0ms** | Interaction completes. All diegetic world lights (torches, lamps, chest glows) receive a hard `intensity = 0` from the light-budget manager in a single frame — no fade, this is a power cut, not a dim. |
| **T+0ms** | Low-frequency **thunk** (80–120Hz sub-bass, ~150ms, sourced from the existing physics-impact SFX bus, pitched down) plays at the Breaker's world position — audible mode-wide as a muffled thud through walls (reduced-gain, low-pass filtered to <300Hz for players >15m away, matching a "felt through the building" read). |
| **T+40ms** | Full-screen camera shake, single decaying impulse, amplitude 0.35, duration 220ms, on all players regardless of distance (screen-shake is cheap and universal — no falloff needed for readability of "the round state changed"). |
| **T+40ms** | Controller haptics: one strong rumble pulse, 200ms, both motors, all players. |
| **T+80ms** | HUD teardown begins: minimap circle scales to 0 over 250ms with an ease-in (`cubic-in`), topbar mode label swaps text to "BLACKOUT" mid-scale. |
| **T+150ms** | Red emergency strobe lights fade in — NOT a flash. Ramp `intensity 0 → 1.2` over 400ms on 2–4 fixed-position red point lights per room (leased at priority-1, guaranteed pool, so they always win the light budget over any player gadget). Color: pure red (`#ff1414`), no orange bleed, to stay distinct from muzzle flash and blood-hit flash colors already in the palette. |
| **T+150ms** | Alarm audio layer starts: a klaxon built from two detuned sawtooth oscillators (110Hz and 113Hz, the 3Hz beat creates the "wailing" texture) gated on/off at 0.9Hz (on 550ms / off 550ms), mixed 6dB below master, looping until reboot or round end. |
| **T+300ms** | A single mid-frequency stinger (2–4kHz noise burst, 80ms, resembles a relay-clunk) plays once, globally, marking "systems now offline" — this is the last non-looping cue in the sequence. |
| **T+400–650ms** | Strobe lights begin their loop: hold at `intensity 1.2` for 180ms, snap to `intensity 0.15` (never fully dark — floor must stay minimally readable) for 120ms, repeat. This 300ms duty cycle is slow enough to not trigger photosensitivity thresholds (well under the 3-flashes-per-second guideline) while still reading as "alarm," not "ambient." |
| **T+650ms onward** | Steady state: klaxon loop + strobe loop + total minimap absence + ambient light floor reduced to near-zero except leased sources (torches stay dead — they were on the same circuit as the Breaker). Shadows deepen because ambient/fill light contribution drops to ~5% of pre-blackout value; only point-light-lit patches remain readable. |
| **Reboot success** | Inverse sequence over 600ms: strobes fade out, klaxon cuts on the next off-beat (never mid-wail — avoids an ugly hard cut), original world lights `intensity` ramps back 0→1 over 500ms, a single rising 2-oscillator "power-on" chime (400Hz→800Hz portamento, 300ms) plays globally, minimap scales back in. |

Screen-shake and haptics are universal (not distance-attenuated) because the pull is a round-defining state transition every player needs to register immediately, even mid-fight; audio cues beyond the T+0 thunk are otherwise standard distance/occlusion-attenuated like existing gunfire.

---

## 3. MAP DESIGN & INTERACTIVE GEOMETRY

**1. Fail-Locked Blast Doors.** Two heavy doors per map gate the shortest routes to the Breaker/reboot room. Pre-blackout: powered, open normally on proximity/interact like any door. Post-blackout: lose power and fail into the *locked* state (fail-secure, not fail-safe — matches real emergency door logic and creates a hard chokepoint) unless a player already has line-of-sight-established control of them. Only opened post-blackout via the Kinetic Ram (2s stagger-break) or by finding the one Emergency Crank per map (slow, 4s channel, interruptible — a risk/reward alternative to spending a Ram charge). This is the mode's primary tempo lever: it stops attackers from freely reinforcing the reboot room the instant the pull happens.

**2. Emergency Glass Panels.** Thin reinforced-glass panels (one per major room, adjacent to the dead torches/lamps) that are purely decorative pre-blackout. Post-blackout, they become breakable (any weapon, ~15 HP prop, shotgun one-shots at close range) and behind each is a battery-powered courtesy light on its own isolated circuit — breaking one grants a small (2m radius, 8s) *guaranteed* light patch that does **not** draw from the shared light-budget pool (it's a separate always-on circuit), making it the one reliable non-gadget light source in a blacked-out room. Creates counterplay: defenders holding a dark room know exactly where the "free light" is and can pre-aim it; attackers must decide whether the light they'd create helps them push or just paints them for the defender.

**3. Local Power Boxes (shootable).** Small wall-mounted junction boxes near each strobe cluster, present on both maps' existing torch/chain fixture points. Pre-blackout: inert prop, no interaction. Post-blackout: shootable (30 HP, any weapon) — destroying one kills that room's specific red strobe pair (but not the klaxon or other rooms' strobes) for the rest of the phase, trading "louder is normal" ambient red for near-total darkness in that one room. This lets a holding team convert a room into a true blackout pocket where only muzzle flash and flare/glowstick gadgets provide vision — high risk (you can't see either) high reward (silhouettes against your own leftover light patches become the only tell).

---

## 4. TACTICAL SYNERGIES & TEAMPLAY

With the minimap gone, both teams lose the passive spatial awareness ("where is everyone, where am I") that the circular HUD map otherwise provides continuously. Communication has to fill the gap the UI used to fill for free.

**Callout language shifts from coordinates to relative/audio callouts.** Pre-blackout, players can glance at the minimap and say "east ramp." Post-blackout, with no map, the mode should push players toward the Directional Mic Puck's arrow-tick pings and manual voice callouts anchored to fixed room names ("reboot room," "the blast door," "the glass panel room") rather than compass directions — the GDD recommendation is that room names get baked into level geometry (signage, distinct architecture) specifically so blackout callouts stay legible without a map. This is a level-art requirement flowing directly from a systems decision.

**Attackers holding a dark room post-pull** should default to a "flare-then-triangle" hold: one player burns a Breach Flare to get the guaranteed priority-1 light patch, and the other four position at its edges facing outward, using the lit patch as a shared reference point rather than trying to individually track threats in full dark. This mirrors real CQB doctrine (a chem-light thrown into a room as a rally point) and gives the team a callout anchor ("watching the flare corner").

**Defenders retaking under red strobe** should lean on the fact that they know their own map blind — the design intent is that defenders get a *soft information advantage* (they don't need a minimap to know their own base) that's meant to offset attackers' first-mover advantage of choosing when to pull. Concretely: defenders should coordinate a pincer through the two fail-locked blast doors (forcing attackers to split attention between both approach vectors) while a lone defender uses a Chem-Light at the reboot console itself so the retake team has one unambiguous "friendly, don't shoot" beacon distinct in color from any attacker flare.

**Sound discipline becomes a real skill expression.** Footsteps and reloads are already simulated in-engine; in full dark they become substantially higher-value information than in a lit round, so the mode should slightly increase footstep audio range/clarity specifically during Blackout Phase (a tunable multiplier, not a new system) to reward players who move deliberately and punish panicked sprinting.

---

## 5. BALANCING & FAIRNESS

**Camping advantage in the dark.** A stationary defender in a pitch-black corner is nearly unreadable, which rewards passive play over the mode's intended tactical push-pull. *Fix:* the fail-secure ambient light floor (strobe minimum `intensity 0.15`, Section 2) guarantees no true 100% darkness exists anywhere the strobes reach — corners are dim, not invisible — and bot/player hit-detection silhouettes are rendered with a minimum rim-light term so a model is never fully unreadable at point-blank engagement range (a shader floor, not a gameplay nerf).

**Visibility inequality (monitor/gamma abuse).** Some players will crank monitor brightness or in-game gamma to effectively defeat the blackout's intended readability curve, which is a well-known competitive-integrity problem in every game with a dark mode. *Fix:* clamp a server-authoritative minimum/maximum gamma range in the options menu (already trivial since this is a client-rendered three.js scene — the gamma slider can simply be range-limited during Blackout Phase specifically) and, more importantly, make the *design* not depend on raw darkness for balance — light-budget-leased sources and the strobe floor mean the skill expression is about light management and positioning, not about who can see more black-crush detail.

**The "last player alive can just hide" problem.** No-respawn rounds already create this in Deathmatch-style modes; blackout makes hiding easier since fewer light sources exist to expose a lone survivor. *Fix:* introduce a **Hunt Timer** — once a team is reduced to its last living player, a 30-second countdown starts and that player's Directional Mic Puck signature (footsteps, gunshots) gets a forced audio-range boost (2x) visible only to the enemy team, functionally a "last stand ping" system. This keeps end-rounds from degenerating into indefinite dark-corner stalling without removing agency (the player can still fight or reposition, just can't disappear forever).

**Snowballing (economy compounds a losing streak).** Round-based economies famously punish a losing team by starving their buy phase just when they need gadgets most. *Fix:* loss-streak bonuses (see economy table below) scale up per consecutive loss, capped at 3 stacks, specifically so a team that's down 0-3 can still afford flares/rams to contest the pull rather than getting priced out of relevance.

**Attacker/Defender role asymmetry across a match.** Pulling the Breaker is strictly attacker-initiated, which could make Defender feel purely reactive. *Fix:* standard side-swap at match halftime (5 rounds each side, first to 6) — a scheduling fix, not a new system, but stated explicitly here because the mode has no existing round-count convention to inherit it from.

---

## ROUND STRUCTURE & ECONOMY

- **Round length:** 3:00 total. 0:20 buy phase (frozen movement, weapon/gadget purchase only) → 2:40 live round.
- **Breaker pull window:** anytime after buy phase ends, no cooldown.
- **Reboot timer:** 45s from the moment the Breaker is pulled; if it expires, Attackers win the round instantly regardless of remaining players.
- **Match length:** Best of 11 rounds (first to 6), side-swap after round 5.

| Event | Cash Reward |
|---|---|
| Kill (any weapon) | $150 |
| Headshot kill bonus | +$50 |
| Assist | $50 |
| Pull the Breaker (attacker) | $300, team-wide $100 each |
| Successful Reboot (defender who holds it) | $300, team-wide $100 each |
| Round win (by wipe) | $500 team-wide |
| Round win (by timer/reboot) | $350 team-wide |
| Round loss, base | $200 team-wide |
| Loss-streak bonus | +$100 per consecutive loss, caps at +$300 (4th+ loss) |
| Survive round (no kill) | $75 |

Buy menu gates Chem-Light, Battery Pack, and (for balance) the Breach Flare's second charge behind a $ minimum specifically so early rounds can't insta-spam light-denial tools before either team has established an economy.

---

## SYSTEM NAMES (Glossary)

- **The Breaker** — the interactable objective that triggers Blackout Phase.
- **The Pull** — the act of activating the Breaker; also used as the round-timeline marker ("pre-Pull," "post-Pull").
- **Blackout Phase** — the mode-defining state between Pull and Reboot/timer expiry.
- **The Reboot** — the Defender hold-interaction at the Breaker room that ends Blackout Phase in Defenders' favor.
- **Emergency Timer** — the 45s countdown started by the Pull.
- **Strobe State** — the red-light/klaxon/no-minimap rendering and audio state active during Blackout Phase.
- **Light Lease / Light Budget** — the existing engine system (`MAX_POINT_LIGHTS`, priority-leased lights) that this mode explicitly exploits for gadget balance.
- **Fail-Secure Doors** — blast doors that lock (not unlock) on power loss.
- **Hunt Timer** — the 30s last-player-alive countdown with forced audio exposure.
- **Loss-Streak Bonus** — the scaling economic catch-up mechanic.

---

## IMPLEMENTATION NOTES

**Already supported by the engine, reused as-is:**
- Grenade throw arc/impulse physics (cannon-es) — reused verbatim for Glowstick, Breach Flare, Chem-Light, Kinetic Ram trajectory.
- `smokeBlocks()` LOS check pattern — the pattern (not the smoke itself) is the template for how flares/glass-panel light patches should hook into bot spotting logic.
- Light-budget/priority-lease system — this is the mode's backbone and needs zero new infrastructure to support tiered gadget lights, just new lease requests at defined priorities.
- Hit-zone multipliers and armor absorption — untouched, apply identically in Blackout Phase.
- Bot AI states (SPAWN/PATROL/.../DEAD) — reused unmodified; bots' existing accuracy/reaction/aggression tuning is sufficient, though see hardest-pieces note below.

**Must be built new:**
- Round/no-respawn/buy-phase/economy layer — does not exist anywhere in current OVERRUN and is the largest net-new system in this GDD, independent of Blackout Phase specifics.
- HUD minimap teardown/rebuild animation and topbar state swap.
- Fail-secure door state machine (currently doors, if any exist, are presumably simple open/close interactables, not power-dependent).
- Shootable/breakable props with HP (junction boxes, glass panels) — no existing "prop with damage state distinct from a bot/player" seems implied by the provided facts.
- Server-authoritative gamma clamp — note this game has "no server" per the provided facts, so this specific fix needs re-scoping to a client-side hard-clamped slider (can't truly be server-authoritative without a backend); flagged honestly as a partial mitigation, not a complete one, until/unless a server layer exists.

**Three hardest pieces, flagged honestly:**
1. **Economy + round system.** Not a Blackout Phase feature per se, but Blackout Phase cannot ship without it, and it's a substantial cross-cutting rewrite of match flow, HUD, and bot round-awareness (bots must understand "no respawns" and behave differently, i.e., more conservatively, when their team is down players — current AI states don't appear to encode team-count-awareness at all).
2. **Bot AI under total blackout.** Bots "spot enemies via LOS + smoke check and show a minimap blip only when spotted" — but Blackout Phase removes the minimap for *both* teams, and presumably bots' own internal spotting logic needs an equivalent vision-degradation pass (reduced effective sight range, reliance on the same light-patch/audio cues players get) or bots will trivially out-see human players in the dark, breaking the entire premise. This is a real AI-tuning project, not a light re-skin.
3. **Fail-secure door + prop-HP systems.** These are new gameplay object categories (stateful, damageable, power-dependent geometry) that the current single-file `game.js` architecture doesn't appear to have a slot for yet; at 5,700 lines and growing, this is also the point where a refactor into separate modules becomes worth strongly considering rather than optional.
