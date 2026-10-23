import { levelFromXp, rankTitle } from './profile.js';
import { isUnlocked, nextReward, titleInfo } from './rewards.js';

const $ = (id) => document.getElementById(id);

/** Fill the lobby card from the saved career. Called at boot, after every match and on a rename. */
export function renderPlayerCard(profile) {
  const { level, into, need } = levelFromXp(profile.xp);
  const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  set('pc-level', level);
  // A title you wear replaces the rank line; the rank is still on the career screen.
  const worn = profile.equipped?.title;
  set('pc-rank', worn && isUnlocked(profile, 'title', worn) ? titleInfo(worn).name : rankTitle(level));
  const next = nextReward(level);
  set('nr-name', next ? next.items.map((i) => i.name).join(' + ') : 'EVERYTHING UNLOCKED');
  set('nr-sub', next ? `AT LEVEL ${next.level}  ·  ${next.level - level} LEVEL${next.level - level === 1 ? '' : 'S'} AWAY` : 'You have the full track.');
  set('pc-xpt', `${into} / ${need} XP`);
  const fill = $('pc-xpfill');
  if (fill) fill.style.width = `${Math.round((into / need) * 100)}%`;
  const kd = profile.deaths ? (profile.kills / profile.deaths).toFixed(2) : profile.kills ? profile.kills.toFixed(2) : '0.00';
  const stats = $('pc-stats');
  if (stats) {
    stats.textContent = '';
    for (const [k, v] of [['K/D', kd], ['WINS', profile.wins], ['HEADSHOTS', profile.headshots], ['BEST STREAK', profile.bestStreak]]) {
      const d = document.createElement('div');
      const b = document.createElement('b'); b.textContent = String(v);
      const s = document.createElement('span'); s.textContent = k;
      d.append(b, s);
      stats.appendChild(d);
    }
  }
}
