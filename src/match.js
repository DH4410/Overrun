import { BOT_NAMES, DIFFICULTY } from './bots.js';
import { loadLoadout } from './loadout.js';
import { applyMatch, loadProfile, rankTitle, saveProfile } from './profile.js';
import { levelRewards } from './rewards.js';
import { WEAPON_BY_ID } from './weapons.js';
import { renderPlayerCard } from './playercard.js';
import { AFTER_TIME } from './killcam.js';
import {
  CONFIG,
  SPAWN_INVULN,
  TEAM,
  TEAM_COLOR,
} from './config.js';

export const MODE_LABEL = { dm: 'DEATHMATCH', tdm: 'TEAM DEATHMATCH', sv: 'SURVIVAL', duel: '1V1 DUEL', gg: 'GUN GAME', hp: 'HARDPOINT' };
/**
 * Gun Game: everyone starts on the same gun and every kill hands the killer the next one. The
 * ladder runs short barrels to long ones, so the opening kills are at arm's length and the last
 * is a sniper shot. Finish it first to win. Owning the guns is not required: the ladder lends them.
 */
export const GUN_LADDER = ['pistol', 'mp', 'revolver', 'smg', 'ashotgun', 'shotgun', 'ar', 'lmg', 'dmr', 'sniper'];
export const ladderGun = (kills) => GUN_LADDER[Math.min(Math.max(0, kills), GUN_LADDER.length - 1)];
/**
 * Survival is meant to be a power fantasy you can lose, not a wall. Waves are small, hostiles walk
 * in a few at a time instead of all at once, the early waves are the easy tier whatever the lobby
 * says, and clearing a wave patches you up.
 */
const SV_ORDER = ['easy', 'medium', 'hard'];
export const svWaveSize = (wave) => Math.min(14, 1 + Math.ceil(wave * 1.5));
export const svWaveCap = (wave) => Math.min(6, 2 + Math.ceil(wave / 2));
export function svWaveTier(wave, baseKey) {
  const cap = wave <= 3 ? 0 : wave <= 6 ? 1 : 2;
  return SV_ORDER[Math.min(Math.max(0, SV_ORDER.indexOf(baseKey)), cap)];
}
const SV_TRICKLE = 2.5;
const SV_HEAL = 60;
export const APP_STATE = Object.freeze({ MENU: 0, PLAYING: 1, PAUSED: 2, SETTINGS: 3 });

export function createMatchState() {
  return {
    mode: 'dm',
    diff: DIFFICULTY.medium,
    running: false,
    time: 0,
    timeLeft: CONFIG.MATCH_SECONDS,
    scoreA: 0,
    scoreB: 0,
    kills: 0,
    wave: 1,
    waveBreak: 0,
    svQueue: 0,
    svTimer: 0,
    svBase: 'medium',
    // Duel only. roundsA is the player's, roundsB the bot's; roundReset counts down the
    // interval between rounds and is <= 0 whenever a round is actually being played.
    roundsA: 0,
    roundsB: 0,
    roundTime: 0,
    roundReset: 0,
    // The player's own run, for XP and the kill medals.
    headshots: 0,
    streak: 0,
    bestStreak: 0,
    multi: 0,
    multiAt: -99,
    medal: '',
    // Chains reached (by length) and revenge kills, for XP; who last killed you, and the streak that death cost.
    multis: {},
    revenges: 0,
    nemesis: null,
    lostStreak: 0,
    tags: [],
  };
}

/** Match setup, bots, respawns, scoring, win conditions, and mode progression. */
export function createMatchRuntime({
  match,
  player,
  bots,
  Bot,
  combatants,
  allyMarks,
  pickSpawn,
  spawnPoints,
  switchMap,
  getCurrentMapId,
  setAppState,
  resetPlayerAmmo,
  syncPlayerPoints,
  resetStance,
  clearEffects,
  resetAmmoChests,
  resetConsumables,
  playerBlip,
  warmUpShaders,
  Audio,
  requestLock,
  showBoard,
  showPause,
  showToast,
  updateAmmoHud,
  updateVitals,
  addKillFeed,
  refreshBoard,
  clearAlertsOn,
  stopFiring,
  isPointerLocked,
  getKillcam = () => null,
  hardpoint = null,
  showStreak = null,
  elements: el,
}) {
let nameSeed = 0;
function nextBotName() { return BOT_NAMES[(nameSeed++) % BOT_NAMES.length]; }

function addBot(team, weaponId = null) {
  const b = new Bot(nextBotName(), team, match.diff, weaponId);
  const sp = pickSpawn(team);
  b.body.position.set(sp.x, sp.y + 0.5, sp.z);
  b.updateTransforms();
  bots.push(b);
  combatants.push(b);
  return b;
}

/** Bring in `wave`: swap the bot tier, place the first few, queue the rest. */
function startSurvivalWave() {
  clearBots();
  match.diff = DIFFICULTY[svWaveTier(match.wave, match.svBase)];
  const total = svWaveSize(match.wave);
  const first = Math.min(total, svWaveCap(match.wave));
  for (let i = 0; i < first; i++) addBot(TEAM.RED);
  match.svQueue = total - first;
  match.svTimer = SV_TRICKLE;
}

function clearBots() {
  hardpoint?.end();
  for (const [, m] of allyMarks) m.root.remove();
  allyMarks.clear();
  for (const b of bots) {
    b.dispose();
    const i = combatants.indexOf(b);
    if (i >= 0) combatants.splice(i, 1);
  }
  bots.length = 0;
}

function startMatch(mode, diffKey, name, mapId = getCurrentMapId()) {
  // Rebuilding the level has to happen before any bot is spawned or the player is placed:
  // both read spawnPoints, and switchMap() empties it.
  switchMap(mapId);

  match.mode = mode;
  // The duel is the elite bot's mode — the menu difficulty does not apply to it. Note that
  // a tier also carries `bots`, the DM headcount, so elite must specify bots: 1.
  match.diff = mode === 'duel' ? DIFFICULTY.elite : DIFFICULTY[diffKey];
  match.svBase = DIFFICULTY[diffKey] ? diffKey : 'medium';
  match.running = true;
  setAppState(APP_STATE.PLAYING);
  match.time = 0;
  match.timeLeft = CONFIG.MATCH_SECONDS;
  match.scoreA = 0; match.scoreB = 0;
  match.kills = 0; match.wave = 1; match.waveBreak = 0;
  match.roundsA = 0; match.roundsB = 0;
  match.roundTime = CONFIG.DUEL_ROUND_SECONDS; match.roundReset = 0;
  match.outro = null;
  getKillcam()?.reset();
  match.headshots = 0; match.streak = 0; match.bestStreak = 0; match.multi = 0; match.multiAt = -99; match.medal = '';
  match.multis = {}; match.revenges = 0; match.nemesis = null; match.lostStreak = 0; match.tags = [];
  showStreak?.(0);
  document.body.classList.remove('outro');
  $id('outro').className = '';
  $id('podium').className = '';
  nameSeed = 0;

  player.name = (name || 'PLAYER').toUpperCase().slice(0, 12);
  player.kills = 0; player.deaths = 0;
  player.team = mode === 'tdm' || mode === 'hp' ? TEAM.BLUE : TEAM.SOLO;
  // A duel is a mirror match, so both sides start on the same gun (when the player carries
  // it) rather than the player opening on whatever the bot did not roll. Otherwise you spawn
  // holding slot 1.
  player.loadout = loadLoadout();
  match.loadout = mode === 'duel' && player.loadout.includes(CONFIG.DUEL_WEAPON)
    ? CONFIG.DUEL_WEAPON : player.loadout[0];
  if (mode === 'gg') { player.loadout = [ladderGun(0)]; match.loadout = ladderGun(0); }
  player.current = match.loadout;
  player.cooking = null;
  player.cooldown = 0; player.reloading = 0;
  player.recoilPitch = 0; player.recoilYaw = 0;
  resetPlayerAmmo();

  clearBots();
  clearEffects();
  resetAmmoChests();
  resetConsumables();
  el.feed.innerHTML = '';

  if (mode === 'tdm' || mode === 'hp') {
    for (let i = 0; i < 2; i++) addBot(TEAM.BLUE);
    for (let i = 0; i < 3; i++) addBot(TEAM.RED);
  } else if (mode === 'dm') {
    for (let i = 0; i < match.diff.bots; i++) addBot(TEAM.SOLO);
  } else if (mode === 'gg') {
    for (let i = 0; i < match.diff.bots; i++) addBot(TEAM.SOLO, ladderGun(0));
  } else if (mode === 'duel') {
    addBot(TEAM.RED, CONFIG.DUEL_WEAPON);
  } else {
    startSurvivalWave();
  }

  if (mode === 'hp') hardpoint?.begin();

  const playerBlipColor = TEAM_COLOR[player.team];
  playerBlip.traverse((o) => { if (o.material) o.material.color.setHex(playerBlipColor); });

  if (mode === 'duel') startDuelRound(); else respawnPlayer(true);
  el.vname.textContent = player.name;
  el.tbMode.textContent = MODE_LABEL[mode];
  el.menu.classList.add('hidden');
  el.hud.classList.remove('hidden');
  updateAmmoHud();
  updateVitals();

  // Bots and their cloned materials only exist now, so compile once more before play starts.
  warmUpShaders();

  Audio.init();
  Audio.startAmbient();
  Audio.playMusic('match');
  Audio.roundStart();
  playIntro(mode);
  requestLock();
}

/** Out of black: the mode and the map, then the HUD slides in. Scenery only, nothing waits on it. */
let introTimer = 0;
function playIntro(mode) {
  const box = $id('intro');
  if (!box) return;
  $id('in-kicker').textContent = match.diff && mode !== 'duel' && mode !== 'sv' ? `${(match.diff.label ?? '').toUpperCase()}` : '';
  $id('in-title').textContent = MODE_LABEL[mode];
  $id('in-map').textContent = getCurrentMapId().replace(/[-_]/g, ' ').toUpperCase();
  box.className = '';
  void box.offsetWidth;                    // restart the animation when a match starts right after another
  box.className = 'on';
  document.body.classList.add('intro');
  clearTimeout(introTimer);
  introTimer = setTimeout(() => { box.className = ''; document.body.classList.remove('intro'); }, 2200);
}

/**
 * A match that is won or lost does not cut straight to the menu. The world keeps running at
 * OUTRO_TIME_SCALE for OUTRO_SECONDS of real time under a big VICTORY / DEFEAT, then the podium
 * comes up over the lobby. match.running is false from the first frame of it, so nobody can
 * fire, score or take damage; only leaving from the pause screen (instant) skips it.
 */
const OUTRO_SECONDS = 5;
const OUTCOME_WORD = { win: 'VICTORY', loss: 'DEFEAT', draw: 'DRAW' };
const $id = (id) => document.getElementById(id);
const span = (className, text) => Object.assign(document.createElement('span'), { className, textContent: String(text) });

function outcomeOf(title) {
  if (title.includes('DRAW')) return 'draw';
  // In TDM the player is always blue.
  if (title.includes('VICTORY') || title.includes('WON') || title.includes('BLUE')) return 'win';
  return 'loss';
}

/** Everyone, best first: kills, then fewest deaths. */
function standings() {
  return [player, ...bots].sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths));
}

function endMatch(title, sub, { instant = false } = {}) {
  if (match.outro) return;
  match.running = false;
  getKillcam()?.reset();
  stopFiring();
  showBoard(false);
  showPause(false);
  el.pause.classList.remove('dead');
  if (instant) { finishMatch(title, sub, false); return; }
  const outcome = outcomeOf(title);
  match.outro = { t: 0, title, sub, outcome };
  $id('o-kicker').textContent = title === OUTCOME_WORD[outcome] ? MODE_LABEL[match.mode] : title;
  $id('o-title').textContent = OUTCOME_WORD[outcome];
  $id('o-sub').textContent = sub;
  $id('outro').className = `on ${outcome}`;
  document.body.classList.add('outro');
  Audio.stinger(outcome);
}

/** Advanced on real time by the frame loop, not on the slowed world clock. */
function updateOutro(dt) {
  if (!match.outro) return;
  match.outro.t += dt;
  if (match.outro.t >= OUTRO_SECONDS) finishMatch(match.outro.title, match.outro.sub, true);
}

function finishMatch(title, sub, podium) {
  const outcome = match.outro?.outcome ?? outcomeOf(title);
  match.outro = null;
  setAppState(APP_STATE.MENU);
  document.exitPointerLock?.();
  Audio.playMusic('lobby');
  document.body.classList.remove('outro');
  $id('outro').className = '';
  el.hud.classList.add('hidden');
  el.menu.classList.remove('hidden');
  el.menuResult.textContent = `${title} — ${sub}`;
  // Only a match played to its end pays out; leaving from the pause screen (podium false) does not.
  let progress = null;
  if (podium) {
    progress = applyMatch(loadProfile(), {
      outcome, kills: player.kills, deaths: player.deaths,
      headshots: match.headshots, bestStreak: match.bestStreak,
      multis: match.multis, revenges: match.revenges,
    });
    saveProfile(progress.profile);
  }
  renderPlayerCard(loadProfile());
  if (podium) showPodium(outcome, title, sub, progress);
  clearEffects();
}

/**
 * The final standings: the top three on a podium, the winner in the middle and biggest, and
 * everyone else in rows underneath. Built with DOM calls so names are never parsed as HTML.
 */
function showPodium(outcome, title, sub, progress) {
  const rows = standings();
  $id('pd-kicker').textContent = title === OUTCOME_WORD[outcome] ? MODE_LABEL[match.mode] : `${MODE_LABEL[match.mode]} · ${title}`;
  $id('pd-title').textContent = OUTCOME_WORD[outcome];
  $id('pd-sub').textContent = sub;
  const stands = $id('pd-stands');
  stands.textContent = '';
  for (const i of [1, 0, 2]) {                 // 2nd, 1st, 3rd, left to right
    const c = rows[i];
    if (!c) continue;
    const d = document.createElement('div');
    d.className = `pd-place p${i + 1}${c === player ? ' self' : ''}`;
    const block = document.createElement('div');
    block.className = 'pd-block';
    block.appendChild(span('pd-rank', i + 1));
    d.append(span('pd-name', c.name), span('pd-kd', `${c.kills} K · ${c.deaths} D`), block);
    stands.appendChild(d);
  }
  const rest = $id('pd-rest');
  rest.textContent = '';
  rows.slice(3).forEach((c, j) => {
    const r = document.createElement('div');
    r.className = `pd-row${c === player ? ' self' : ''}`;
    r.append(span('pd-n', `#${j + 4}`), span('pd-nm', c.name), span('pd-k', `${c.kills} K · ${c.deaths} D`));
    rest.appendChild(r);
  });
  showAward(progress);
  $id('podium').className = `on ${outcome}`;
  $id('podium-close').focus({ preventScroll: true });
}
/** The XP breakdown under the podium: each line counts in, then the bar fills and levels roll over. */
function showAward(progress) {
  const box = $id('pd-xp');
  if (!box || !progress) { box?.classList.remove('on'); return; }
  const lines = $id('pd-xplines');
  lines.textContent = '';
  progress.award.lines.forEach((l, i) => {
    const r = document.createElement('div');
    r.className = 'xp-line';
    r.style.animationDelay = `${1.3 + i * 0.18}s`;
    r.append(span('xp-l', l.label), span('xp-v', `+${l.xp}`));
    lines.appendChild(r);
  });
  const tot = document.createElement('div');
  tot.className = 'xp-line total';
  tot.style.animationDelay = `${1.3 + progress.award.lines.length * 0.18}s`;
  tot.append(span('xp-l', 'TOTAL XP'), span('xp-v', `+${progress.award.total}`));
  lines.appendChild(tot);
  const pay = document.createElement('div');
  pay.className = 'xp-line credits';
  pay.style.animationDelay = `${1.3 + (progress.award.lines.length + 1) * 0.18}s`;
  const coin = document.createElement('i');
  coin.className = 'coin';
  const paid = span('xp-v', `+${progress.credits}`);
  paid.prepend(coin);
  pay.append(span('xp-l', 'CREDITS'), paid);
  lines.appendChild(pay);
  const { before, after } = progress;
  const fill = $id('pd-xpfill');
  const frac = (x) => `${Math.round((x.into / x.need) * 100)}%`;
  // Start where the bar was; a level-up fills it, then lands on the new level's progress.
  fill.style.transition = 'none';
  fill.style.width = frac(before);
  void fill.offsetWidth;
  const t = 1.3 + (progress.award.lines.length + 1) * 0.18 + 0.2;
  setTimeout(() => {
    fill.style.transition = 'width .9s cubic-bezier(.2,.8,.2,1)';
    fill.style.width = progress.leveledUp ? '100%' : frac(after);
    if (progress.leveledUp) {
      setTimeout(() => {
        fill.style.transition = 'none'; fill.style.width = '0%'; void fill.offsetWidth;
        fill.style.transition = 'width .6s ease-out'; fill.style.width = frac(after);
      }, 950);
    }
  }, t * 1000);
  // What the levels just gained hand out, so a new operator or finish is never a surprise discovered later.
  const unlocked = [];
  for (let l = before.level + 1; l <= after.level; l++) for (const r of levelRewards(l)) unlocked.push(r.name);
  $id('pd-xplvl').textContent = progress.leveledUp
    ? `LEVEL UP  ·  ${before.level} → ${after.level}  ·  ${rankTitle(after.level)}${unlocked.length ? `  ·  UNLOCKED: ${unlocked.join(', ')}` : ''}`
    : `LEVEL ${after.level}  ·  ${after.into} / ${after.need} XP`;
  $id('pd-xplvl').classList.toggle('up', progress.leveledUp);
  box.classList.add('on');
}

$id('podium-close')?.addEventListener('click', () => { $id('podium').className = ''; });

/** While you wait to respawn: where you stand, and the table, refreshed a few times a second. */
let deathBoardTimer = 0;
function renderDeathBoard() {
  const rows = standings();
  const host = $id('p-board');
  host.textContent = '';
  const place = document.createElement('div');
  place.className = 'pb-place';
  place.append('YOU ARE ', span('pb-rank', `#${rows.indexOf(player) + 1}`), ` OF ${rows.length}`);
  host.appendChild(place);
  rows.slice(0, 8).forEach((c, i) => {
    const r = document.createElement('div');
    r.className = `pb-row${c === player ? ' self' : ''}`;
    r.append(span('pb-n', `#${i + 1}`), span('pb-nm', c.name), span('pb-k', `${c.kills} K`), span('pb-d', `${c.deaths} D`));
    host.appendChild(r);
  });
}

function respawnPlayer(immediate = false, at = null) {
  const sp = at ?? pickSpawn(player.team);
  player.body.position.set(sp.x, sp.y + 0.6, sp.z);
  player.body.velocity.set(0, 0, 0);
  player.body.wakeUp();
  resetStance();                       // dying crouched must not respawn you crouched
  // Eye and chest follow the body only when the player steps, so until then they still said
  // where you died: a grenade thrown on the first frame of a life left from your corpse.
  syncPlayerPoints();
  player.alive = true;
  player.health = CONFIG.MAX_HEALTH;
  player.armor = CONFIG.START_ARMOR;
  player.respawnTimer = 0;
  getKillcam()?.reset();
  const lost = $id('p-lost'); if (lost) lost.textContent = '';
  const by = $id('p-killer'); if (by) by.textContent = '';
  showStreak?.(0);
  player.invulnTimer = SPAWN_INVULN;   // bots ignore you while this runs
  clearAlertsOn(player);               // and drop any lock they already had
  player.cooking = null;
  player.cookSource = null;
  player.reloading = 0;
  player.cooldown = 0.4;
  resetPlayerAmmo();                  // includes the one-smoke-per-life reset
  player.current = player.loadout.includes(match.loadout) ? match.loadout : player.loadout[0];
  player.pitch = 0;
  // Face the middle of the arena, never the wall you happened to spawn against. Forward is
  // (-sin yaw, -cos yaw), so aiming it at the origin from (x, z) gives yaw = atan2(x, z).
  player.yaw = Math.atan2(sp.x, sp.z);
  if (!immediate) showPause(false);
  updateAmmoHud();
  updateVitals();
}

/* ----------------------------- 1v1 duel ----------------------------- */

/**
 * Place both duellists for a fresh round.
 *
 * pickSpawn() maximises distance from live enemies, which is right for a respawn mid-fight
 * but not for a duel: it is evaluated per combatant, so whoever is placed second reacts to
 * the first and the two sides get measurably unequal openings. A duel has to be a mirror,
 * so this picks the single farthest-apart PAIR of spawn points up front and coin-flips who
 * gets which end. Both then face the middle, as respawnPlayer() already does.
 */
function startDuelRound() {
  const pts = spawnPoints;
  let a = pts[0], b = pts[pts.length - 1], bestD = -1;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = pts[i].distanceToSquared(pts[j]);
      if (d > bestD) { bestD = d; a = pts[i]; b = pts[j]; }
    }
  }
  if (Math.random() < 0.5) { const t = a; a = b; b = t; }

  // Nothing in flight carries across a round boundary.
  clearEffects();

  respawnPlayer(true, a);

  /**
   * Strip the player's spawn protection, and match the two sides' armour.
   *
   * respawnPlayer grants SPAWN_INVULN, which is right everywhere else and badly wrong here:
   * Bot.canSee returns false against an invulnerable target, so the elite bot would spend
   * the first three seconds of every round blind and unable to deal damage while the player
   * crossed most of the map onto its flank. The player also spawns with START_ARMOR and a
   * bot with none, which is another 50 effective health of advantage.
   *
   * A duel is decided by aim and timing or it is not a duel, so both of those go.
   */
  player.invulnTimer = 0;
  const bot = bots[0];
  if (bot) {
    bot.respawn(b);
    bot.invulnTimer = 0;
    bot.respawnTimer = 0;
    bot.armor = player.armor;
  }
  match.roundTime = CONFIG.DUEL_ROUND_SECONDS;
  match.roundReset = 0;
}

/** End a duel round. `winner` is 'player', 'bot', or null for a timed-out draw. */
function endDuelRound(winner) {
  if (match.roundReset > 0) return;          // already resetting; ignore a second death
  if (winner === 'player') match.roundsA++;
  else if (winner === 'bot') match.roundsB++;
  match.roundReset = CONFIG.DUEL_RESET_DELAY;
  const label = winner === 'player' ? 'ROUND WON' : winner === 'bot' ? 'ROUND LOST' : 'ROUND DRAW';
  showToast(`${label}  ${match.roundsA} – ${match.roundsB}`);
  checkWinConditions();
}

const MULTI_WINDOW = 4;
const MULTI_MEDAL = ['', '', 'DOUBLE KILL', 'TRIPLE KILL', 'QUAD KILL', 'MEGA KILL'];
const STREAK_MEDAL = { 3: '3 KILL STREAK', 5: 'RAMPAGE', 7: 'UNSTOPPABLE', 10: 'GODLIKE' };
// What a streak hands you, on the kill that reaches it. This is the single-player path: online, ammo and
// health belong to the server and nothing here runs.
const STREAK_REWARD = { 3: 'RESUPPLY', 5: 'ARMOR', 7: 'MEDKIT', 10: 'FULL KIT' };
const MIN_STREAK = 3;                   // the shortest run that counts as a streak to lose

function giveStreakReward(kind) {
  const resupply = kind === 'RESUPPLY' || kind === 'FULL KIT';
  if (resupply) {
    for (const [id, a] of Object.entries(player.ammo)) a.reserve = WEAPON_BY_ID[id]?.reserve ?? a.reserve;
    player.fragCount = Math.max(player.fragCount, 3);
    updateAmmoHud();
  }
  if (kind === 'ARMOR' || kind === 'FULL KIT') player.armor = CONFIG.MAX_ARMOR;
  if (kind === 'MEDKIT' || kind === 'FULL KIT') player.health = CONFIG.MAX_HEALTH;
  updateVitals();
  Audio.streakReward?.();
}

/** The single place a death is booked, for the player and for bots alike. */
function killCombatant(target, source, headshot, weaponId = null) {
  if (source && source !== target) {
    source.kills++;
    if (match.mode === 'tdm') {
      // Teamkills do not award score — FF is now blocked in explode() but bullet damage
      // has no team filter, so this guard stays as the authoritative scoring check.
      const teamkill = source.team !== TEAM.SOLO && source.team === target.team;
      if (!teamkill) {
        if (source.team === TEAM.BLUE) match.scoreA++;
        else if (source.team === TEAM.RED) match.scoreB++;
      }
    } else if (match.mode === 'hp') {
      // Hardpoint scores off the zone, not off kills; a kill only clears someone off it.
    } else if (match.mode === 'dm' || match.mode === 'gg') {
      if (source === player) match.scoreA++;
      if (match.mode === 'gg') climbLadder(source);
      // scoreB is Red's score in TDM; don't write it here — dmLeader() reads kills directly.
    } else if (match.mode === 'duel') {
      // Rounds are scored in endDuelRound() below, off the death rather than off the kill,
      // so that a duellist who falls out of the map still loses the round.
    } else if (source === player) {
      match.kills++;
    }
  }
  target.deaths++;
  match.medal = '';
  match.tags = [];
  if (source === player && target !== player) {
    if (headshot) match.headshots++;
    match.streak++;
    match.bestStreak = Math.max(match.bestStreak, match.streak);
    // Kills inside 4 s of each other chain into a multi-kill; a streak is kills without dying.
    match.multi = match.time - match.multiAt <= MULTI_WINDOW ? match.multi + 1 : 1;
    match.multiAt = match.time;
    const chain = Math.min(match.multi, MULTI_MEDAL.length - 1);
    if (chain >= 2) match.multis[chain] = (match.multis[chain] || 0) + 1;
    match.medal = MULTI_MEDAL[chain] || STREAK_MEDAL[match.streak] || '';
    // Killing whoever last killed you.
    if (match.nemesis && target === match.nemesis) {
      match.nemesis = null;
      match.revenges++;
      match.tags.push('REVENGE');
      Audio.revenge?.();
    }
    const reward = STREAK_REWARD[match.streak];
    if (reward) {
      giveStreakReward(reward);
      showToast(`${match.streak} KILL STREAK · ${reward}`);
    }
    showStreak?.(match.streak);
  }
  if (target === player) {
    match.lostStreak = match.streak >= MIN_STREAK ? match.streak : 0;
    match.nemesis = source && source !== player && bots.includes(source) ? source : null;
    match.streak = 0;
    showStreak?.(0, match.lostStreak);
    const lost = $id('p-lost');
    if (lost) lost.textContent = match.lostStreak ? `STREAK LOST · ${match.lostStreak} KILLS` : '';
    const by = $id('p-killer');
    if (by) by.textContent = source && source !== player && source.name ? `KILLED BY ${source.name}${WEAPON_BY_ID[source.weaponId] ? ` · ${WEAPON_BY_ID[source.weaponId].name}` : ''}` : '';
  }
  addKillFeed(source, target, headshot, weaponId);

  if (target === player) {
    player.alive = false;
    // A bot's kill gets the kill cam; its length is the respawn wait (the frame loop holds the timer
    // while it runs and gives the death screen a beat after). Otherwise a slower solo respawn.
    const cam = match.mode !== 'duel' && source !== player ? getKillcam() : null;
    const camTime = cam ? cam.begin(source, headshot, { lost: match.lostStreak }) : 0;
    player.respawnTimer = camTime > 0 ? camTime + AFTER_TIME : CONFIG.PLAYER_RESPAWN;
    if (player.cooking) player.cooking = null;
    stopFiring();
  } else {
    target.die();
    target.respawnTimer = CONFIG.RESPAWN_DELAY;
  }
  refreshBoard();
  // One life each: a duel death ends the round rather than starting a respawn timer.
  if (match.mode === 'duel') { endDuelRound(target === player ? 'bot' : 'player'); return; }
  checkWinConditions();
}

/**
 * A kill in Gun Game: the killer's next gun. The player is handed it at once, with a full magazine;
 * a bot gets it when it next respawns, which is when a bot picks its gun.
 */
function climbLadder(killer) {
  const id = ladderGun(killer.kills);
  if (killer !== player) { killer.fixedWeaponId = id; return; }
  if (killer.kills >= GUN_LADDER.length) return;            // the winning kill: the match ends on it
  const w = WEAPON_BY_ID[id];
  player.loadout = [id];
  match.loadout = id;
  player.ammo[id] = { mag: w.mag, reserve: w.reserve };
  player.current = id;
  player.reloading = 0;
  player.cooldown = 0.35;
  player.cooking = null;
  updateAmmoHud();
  showToast(`${killer.kills + 1} / ${GUN_LADDER.length}  ·  ${w.name}`);
}

/** Single source of truth for the DM leader so HUD, win-check and time-limit agree. */
function dmLeader() {
  return bots.reduce((a, b) => (b.kills > a.kills ? b : a), bots[0] || player);
}

function checkWinConditions() {
  if (!match.running) return;
  if (match.mode === 'gg') {
    if (player.kills >= GUN_LADDER.length) return endMatch('VICTORY', 'Finished the ladder');
    for (const b of bots) if (b.kills >= GUN_LADDER.length) return endMatch('DEFEAT', `${b.name} finished the ladder`);
  } else if (match.mode === 'dm') {
    if (player.kills >= CONFIG.DM_TARGET) return endMatch('VICTORY', `${player.kills} kills`);
    for (const b of bots) {
      if (b.kills >= CONFIG.DM_TARGET) return endMatch('DEFEAT', `${b.name} reached ${CONFIG.DM_TARGET}`);
    }
  } else if (match.mode === 'hp') {
    const goal = hardpoint?.target ?? 100;
    if (match.scoreA >= goal) return endMatch('BLUE TEAM WINS', `${match.scoreA} – ${match.scoreB}`);
    if (match.scoreB >= goal) return endMatch('RED TEAM WINS', `${match.scoreB} – ${match.scoreA}`);
  } else if (match.mode === 'tdm') {
    if (match.scoreA >= CONFIG.TDM_TARGET) return endMatch('BLUE TEAM WINS', `${match.scoreA} – ${match.scoreB}`);
    if (match.scoreB >= CONFIG.TDM_TARGET) return endMatch('RED TEAM WINS', `${match.scoreB} – ${match.scoreA}`);
  } else if (match.mode === 'duel') {
    const enemy = bots[0];
    if (match.roundsA >= CONFIG.DUEL_ROUNDS) {
      return endMatch('DUEL WON', `${match.roundsA} – ${match.roundsB} vs ${enemy ? enemy.name : 'ELITE'}`);
    }
    if (match.roundsB >= CONFIG.DUEL_ROUNDS) {
      return endMatch('DUEL LOST', `${match.roundsB} – ${match.roundsA} to ${enemy ? enemy.name : 'ELITE'}`);
    }
  }
}

function updateMatch(dt, realDt = dt) {
  if (!match.running) return;
  match.time += dt;

  if (match.mode === 'duel') {
    if (match.roundReset > 0) {
      match.roundReset -= dt;
      if (match.roundReset <= 0 && match.running) startDuelRound();
    } else {
      match.roundTime -= dt;
      // A round nobody wins scores for nobody, so hiding out the clock gains you nothing.
      if (match.roundTime <= 0) { match.roundTime = 0; endDuelRound(null); }
    }
  } else if (match.mode === 'sv') {
    const alive = bots.reduce((n, b) => n + (b.alive ? 1 : 0), 0);
    if (match.svQueue > 0) {
      match.svTimer -= dt;
      if (match.svTimer <= 0 && alive < svWaveCap(match.wave)) {
        addBot(TEAM.RED);
        match.svQueue--;
        match.svTimer = SV_TRICKLE;
      }
    } else if (alive === 0) {
      if (match.waveBreak <= 0) {
        match.waveBreak = 4.0;
        if (player.alive) {
          player.health = Math.min(CONFIG.MAX_HEALTH, player.health + SV_HEAL);
          player.armor = Math.min(CONFIG.MAX_ARMOR, player.armor + 25);
          resetPlayerAmmo();
          updateVitals();
          updateAmmoHud();
        }
        showToast(`WAVE ${match.wave} CLEARED`);
      } else {
        match.waveBreak -= dt;
        if (match.waveBreak <= 0) {
          match.wave++;
          startSurvivalWave();
          showToast(`WAVE ${match.wave}`);
          match.waveBreak = 0;
        }
      }
    }
  } else {
    match.timeLeft -= dt;
    if (match.mode === 'hp' && hardpoint) {
      const scored = hardpoint.update(dt, combatants);
      if (scored === TEAM.BLUE) match.scoreA++; else if (scored === TEAM.RED) match.scoreB++;
      if (hardpoint.state.moved) { hardpoint.state.moved = false; showToast('ZONE MOVED'); }
      hardpoint.updateHud();
      checkWinConditions();
      if (!match.running) return;
    }
    if (match.timeLeft <= 0) {
      match.timeLeft = 0;
      if (match.mode === 'dm' || match.mode === 'gg') {
        const top = dmLeader();
        if (player.kills > top.kills) endMatch('TIME — VICTORY', `${player.kills} kills`);
        else if (player.kills < top.kills) endMatch('TIME — DEFEAT', `${top.kills} kills`);
        else endMatch('TIME — DRAW', `Tied at ${player.kills} kills`);
      } else {
        if (match.scoreA > match.scoreB) endMatch('TIME — BLUE WINS', `${match.scoreA} – ${match.scoreB}`);
        else if (match.scoreB > match.scoreA) endMatch('TIME — RED WINS', `${match.scoreB} – ${match.scoreA}`);
        else endMatch('TIME — DRAW', `${match.scoreA} – ${match.scoreB}`);
      }
      return;
    }
  }

  // Respawns. In a duel both sides are placed by startDuelRound() instead, so the only
  // thing left here is the death overlay, counting down to the next round rather than to
  // a respawn.
  if (!player.alive) {
    player.respawnTimer -= realDt;           // real time: the kill cam's slow motion must not stretch the wait
    el.pause.classList.add('on', 'dead');
    deathBoardTimer -= dt;
    if (deathBoardTimer <= 0) { deathBoardTimer = 0.25; renderDeathBoard(); }
    el.pBig.textContent = 'ELIMINATED';
    el.pSm.textContent = match.mode === 'duel'
      ? `ROUND ${match.roundsA + match.roundsB + 1} IN ${Math.max(0, match.roundReset).toFixed(1)}s`
      : `RESPAWNING IN ${player.respawnTimer.toFixed(1)}s`;
    // The death screen is not a pause — the resume prompt would just be confusing here.
    el.pCta.style.display = isPointerLocked() ? 'none' : '';
    if (player.respawnTimer <= 0 && match.mode !== 'duel') {
      respawnPlayer();
      el.pause.classList.remove('dead');
      deathBoardTimer = 0;
      el.pCta.style.display = '';
      if (isPointerLocked()) el.pause.classList.remove('on');
    }
  } else if (match.mode === 'duel' && el.pBig.textContent === 'ELIMINATED') {
    // startDuelRound() revived the player; clear the overlay it left behind.
    el.pause.classList.remove('dead');
    deathBoardTimer = 0;
    el.pCta.style.display = '';
    el.pBig.textContent = 'PAUSED';
    el.pSm.textContent = '';        // otherwise the round countdown lingers under PAUSED
    if (isPointerLocked()) el.pause.classList.remove('on');
  }
  for (const b of bots) {
    // Survival waves and duel rounds both place their own bots; neither auto-respawns.
    if (b.alive || match.mode === 'sv' || match.mode === 'duel') continue;
    if (b.respawnTimer <= 0) b.respawn(pickSpawn(b.team));
  }

  // Top bar.
  if (match.mode === 'duel') {
    el.tbA.textContent = match.roundsA;
    el.tbB.textContent = match.roundsB;
    el.tbTime.textContent = match.roundReset > 0
      ? `NEXT ${Math.ceil(match.roundReset)}`
      : formatTime(match.roundTime);
  } else if (match.mode === 'sv') {
    el.tbA.textContent = match.kills;
    el.tbB.textContent = `W${match.wave}`;
    el.tbTime.textContent = formatTime(match.time);
  } else if (match.mode === 'tdm' || match.mode === 'hp') {
    el.tbA.textContent = match.scoreA;
    el.tbB.textContent = match.scoreB;
    el.tbTime.textContent = formatTime(match.timeLeft);
  } else {
    const top = bots.length ? dmLeader() : null;
    el.tbA.textContent = player.kills;
    el.tbB.textContent = top ? top.kills : 0;
    el.tbTime.textContent = formatTime(match.timeLeft);
  }
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

return {
  addBot,
  clearBots,
  startDuelRound,
  startMatch,
  endMatch,
  respawnPlayer,
  killCombatant,
  dmLeader,
  checkWinConditions,
  updateMatch,
  updateOutro,
  formatTime,
  pickSpawn,
};
}
