# What makes a good game lobby — research notes for OVERRUN

Written before the UI rework, so the rework has reasons behind it.

## How reliable this is

I searched the web from the cloud session. Riot's own pages could not be fetched (the
sandbox's network blocks the host), and the Fortnite, Apex and Overwatch searches returned
content-farm pages and nothing credible. So:

- **Sourced** points come from search results I could read. They are marked with the source.
- **Design judgment** points are my own reasoning about shooters I know. They are marked as
  such, and are not verified against anything in this session. Treat them as opinion.

## Sourced findings

### Valorant's 2023 interface overhaul (the best-documented case)

Source: coverage and Riot's "Preview the future of VALORANT's interface" announcement, via
search summaries — [Riot](https://playvalorant.com/en-us/news/game-updates/preview-the-future-of-valorant-s-interface/),
[One Esports on patch 5.08](https://www.oneesports.gg/valorant/valorant-new-ui-patch-5-08/),
[PCGamesN](https://www.pcgamesn.com/valorant/ui-changes).

- Riot **cut decoration that served no function** and raised contrast and simplified shapes, so the
  player card and the call to action stand out.
- The top tabs became **bold text in a short vertical menu**; the **Play button grew and turned
  red**, so the one thing most players do is the easiest thing to find.
- Agent select moved from 3D textures to 2D key art, each backdrop **tinted to that agent's
  personality**: identity through colour, not clutter.
- The pre-match screen shows **each player's banner and a VS treatment**: the head-to-head is
  the point, so it is the picture.
- The work was done by a task force that **audited the core flow screens**, not one screen.

### General menu guidance

Source: [GameAnalytics](https://www.gameanalytics.com/blog/how-to-make-your-game-ui-shine-and-increase-conversions),
[a menu-structure guide](https://indieklem.substack.com/p/9-creating-an-intuitive-in-game-menu).

- **3 to 5 top-level options.** More causes decision paralysis and clutter.
- **The button players press most is the biggest and most contrasting one.**
- **Keep the tree shallow:** nothing deeper than three levels.
- **Plain labels** ("Play", not "Enter the World"). **One consistent rule set** across screens.
- **Immediate feedback** on every input.

### Counter-Strike 2 and Call of Duty (what to copy and what to avoid)

Source: [Sportskeeda on CS2](https://www.sportskeeda.com/esports/all-major-ui-changes-coming-counter-strike-2-far),
[Attack of the Fanboy](https://attackofthefanboy.com/news/call-of-duty-warzone-2s-battle-pass-has-a-big-ui-problem/),
[Charlie INTEL](https://www.charlieintel.com/call-of-duty-warzone/furious-warzone-players-demand-changes-to-the-games-scummy-battle-pass-design-106125/),
[MobileSyrup's MW2 review](https://mobilesyrup.com/2022/11/01/call-of-duty-modern-warfare-ii-review/).
These are launch-era press and forum posts, so they show sentiment, not a systematic study.

- CS2 kept a **short top bar (Inventory, Play, News)** rather than a deep menu tree.
- MW2 and Warzone 2 were criticised for a **cluttered main menu and an overloaded battle pass screen**.
- A concrete failure: on PC, **one key both opened and confirmed "Skip Battle Pass Tier"**,
  and nothing on screen said so, so players spent currency by accident. Lesson: **an action that
  costs something needs its own labelled confirmation.**
- The **non-linear battle pass** (pick which reward to chase) was praised over a fixed grind.

### In-game HUD

Source: a student [Valorant UI case study](https://app.notion.com/p/Independent-UI-UX-Case-Study-Valorant-21bba50a6ad480c1a4b0c0f1c5e65db1)
(portfolio piece, so weigh it accordingly) and general HUD guides; the rest of what the search
returned was near-duplicate junk and is not cited.

- Less clutter improves focus under stress; **colour coding aids tactical reading** but
  **visual noise rises when the player is stressed**, so the HUD must stay quiet.
- **Show information when it is relevant** (a health bar that appears in combat) rather than all
  the time. Use conventional colours: red for danger, green for health.

## Design judgment (mine, not verified in this session)

From playing and studying shooter menus, the lobbies people stay in share a handful of traits.
I have not checked these against sources here; they are the reasoning behind the layout below.

1. **The player's own character is the centrepiece.** Fortnite, Apex and Overwatch all put your
   avatar in the middle of the screen. It is the thing you own, so it is the reward you look at.
2. **One huge primary button in a fixed corner** (bottom-right in most), always in the same place,
   with the current mode/map shown directly above it so you never have to open a menu to know
   what you are about to play.
3. **A short top bar for navigation**, with the destination you are on clearly marked.
4. **Progress is always visible and always points at the next thing**: level bar, the next reward,
   a short list of challenges. It answers "why play one more match?"
5. **Social is a corner, not a screen**: your party and your account sit in a top corner.
6. **Motion is calm**: slow idle animation and a slow camera, no flashing, because people sit in
   a lobby for minutes.
7. **Cosmetics are previewed on your own character before you commit.**

## What was wrong with the old OVERRUN lobby

Looking at the screenshot (a 440 px column of cards over the map flyover):

- Everything lives in one tall left column, so **at 810 px high the Bot Difficulty buttons were hidden
  under the pinned DEPLOY row.** A real layout bug, found while taking the first screenshot.
- The operator, the thing you own, was not on screen at all. The hero module existed but was never
  wired in.
- Mode, map and loadout were three same-weight cards, so nothing said "this is the one thing to press".
- No sense of what to do next: no rewards, no challenges, no account.

## The new layout

```
┌────────────────────────────────────────────────────────────────────────────┐
│ OVERRUN   PLAY · OPERATORS · LOCKER · CAREER · STORE · SETTINGS    ◉ NAME ⏻ │  top bar, 5-6 labels
├──────────────┬──────────────────────────────────────────┬──────────────────┤
│ PLAYER CARD  │                                          │ CHALLENGES       │
│  level, XP   │        OPERATOR on a lit pad             │  3 short goals   │
│ NEXT REWARD  │        (map flies past behind)           │ MODE  Deathmatch │
│  preview     │        ◀  SWAT  ▶                        │ MAP   Port       │
│              │                                          │ ┌──────────────┐ │
│              │                                          │ │    DEPLOY    │ │
└──────────────┴──────────────────────────────────────────┴─┴──────────────┴─┘
```

In-game, the same rules: a quiet HUD, the same type and colours, information shown when it
matters, and conventional colour meaning (red danger, green health).

## Limits of this research

- No credible source on Fortnite, Apex or Overwatch lobbies was reachable, so those comparisons
  above are marked as my judgment.
- Nothing here measures what OVERRUN players want. The screenshots are the real test; the
  owner's reaction decides.
