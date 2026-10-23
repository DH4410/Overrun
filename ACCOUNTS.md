# Accounts and rewards

Sign up with a username (and optionally an email), sign in on any device, and keep your career
(XP, level, stats, what you wear) saved on the server. Levels and stats unlock operators, gun
finishes and titles.

## What is real, and what is not

- **Accounts are real server code**, with tests. Passwords are salted and hashed (PBKDF2-SHA256),
  sessions are random tokens in an `HttpOnly` cookie, and sign-in attempts are throttled.
- **Nothing is deployed from here.** Putting accounts online means deploying the Worker to your own
  Cloudflare account (`npx wrangler deploy`), which needs your login. Until then accounts work on the
  local server (`node server/node.js`) and are saved to `server/.accounts.json`.
- **Only the Cloudflare deploy could not be tried.** `wrangler deploy --dry-run` bundles it, and the
  same code runs against the local server in the tests, but I have not run the Durable Object live.
- **The career is a save file, not anti-cheat.** Single player is computed in the browser, so the
  server cannot know a match was played. It keeps a career from going backwards, refuses absurd
  numbers and refuses rewards the numbers have not earned. Someone who edits their own browser can
  still award themselves XP. Online play (the multiplayer room) is server-authoritative and does not
  pay career XP yet.

## Lost passwords: the recovery code

There is no email service, so there is no "email me a reset link". Instead sign-up shows a
**recovery code once** (`XXXXX-XXXXX-XXXXX-XXXXX`). It resets the password from the sign-in card
("Forgot password?") and issues a new code. The email, if given, is only another way to sign in.
Lose both the password and the code and the account cannot be recovered. That is the trade-off of
having no mail server; adding one (Cloudflare Email Service, or any SMTP relay) is the way to change it.

## Files

| File | What it is |
|---|---|
| `server/accounts.js` | The service: sign-up, sign-in, sessions, the saved career, password change, recovery, delete. Storage-agnostic. Also the `Throttle`. |
| `server/accounts-http.js` | The `/api/*` routes on web-standard `Request`/`Response`: cookie handling, JSON-only, same-site checks, throttling. |
| `server/accounts-file.js` | A JSON-file store (local server) and a memory store (tests). |
| `server/accounts-do.js` | The Cloudflare Durable Object `AccountsDO` that keeps every account. |
| `src/account.js` | The browser side: the chip in the top bar, the sign-in card, saving the career when it changes. |
| `src/rewards.js` | The unlock table (operators, finishes, titles). Shared by the browser and the server. |
| `src/career.js` | The career screen. |

## The API

| Call | Body | Result |
|---|---|---|
| `POST /api/register` | `{ username, email?, password }` | account, career, recovery code; sets the cookie |
| `POST /api/login` | `{ login, password }` (login is a username or email) | account, career; sets the cookie |
| `POST /api/logout` | | clears the cookie |
| `GET /api/me` | | account and career, or `{ "user": null }` when signed out (always a 200, so it never shows up as a console error) |
| `PUT /api/profile` | `{ profile, rev }` | the saved career. 409 if `rev` is stale (another device saved first) |
| `POST /api/password` | `{ current, password }` | signs every other device out |
| `POST /api/recover` | `{ login, recoveryCode, password }` | signs in, issues a new recovery code |
| `DELETE /api/account` | `{ password }` | deletes the account |

Usernames are 3-12 letters, numbers, `-` or `_` (the callsign length), unique ignoring case.
Passwords are 8-128 characters.

## How the browser behaves

- No account server behind the page (the plain static test server, or a file): the chip reads
  `GUEST`, is greyed out, and the game is exactly the guest game.
- Signed out: the career lives in `localStorage` as before.
- Signing in merges: the career with more XP is kept, and no counter ever goes down, so a guest's
  matches are not lost to an empty account. Two devices that disagree merge the same way.
- Signed in: every saved career is sent to the server about 1.5 s later.

## Run and test

```sh
node server/node.js 8790                  # http://127.0.0.1:8790, accounts in server/.accounts.json
npm test                                  # server/accounts tests and the rewards table
CI=1 npx playwright test accounts         # the sign-up / sign-in / unlock flows on a real server
```

## Deploy

```sh
npx wrangler deploy
```

`wrangler.jsonc` already binds the `ACCOUNTS` Durable Object (migration `v2`) and routes `/api/*`
to it. Two things to check on a real deploy:

- **CPU time on the free plan.** Each sign-up and sign-in runs one or two PBKDF2 hashes at 100,000
  iterations, the most a Worker allows. The free plan's per-request CPU limit is small, so if
  sign-ins fail with a CPU error, lower `PBKDF2_ITERATIONS` in `wrangler.jsonc` or move to the paid
  plan. I could not measure this without deploying.
- **HTTPS.** The cookie is marked `Secure` automatically on HTTPS, which Cloudflare always serves.

## Rewards

`src/rewards.js` is one table:

| Kind | Unlocked by | Now |
|---|---|---|
| Operators | level | SWAT and TROOPER at 1, GAS MASK 3, CRYPTO 6, ELY 10, STEVE 14 |
| Gun finishes | level | STOCK 1, DESERT TAN 2, ARCTIC 5, CRIMSON 8, MIDNIGHT 12, GOLD 20 |
| Titles | stats | VETERAN, VICTOR, HEADHUNTER, UNSTOPPABLE, EXTERMINATOR, CHAMPION |

To add a reward, add a row there. The lobby picker, locker, career screen, podium ("UNLOCKED: ...")
and the server's check all read the same table. A finish only recolours the gun's `polymer`,
`alloy` and `steel` materials (see `applyGunSkin` in `src/gunmodels.js`); it needs no new art.
