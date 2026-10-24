/**
 * The friends drawer in the lobby: add people, accept requests, see who is on, invite them or
 * jump into the room they are in. The server side (and what "online" means) is server/friends.js.
 *
 * Presence is a heartbeat: while you are signed in and the page is visible this checks in every
 * POLL_MS (faster while the drawer is open), and the answer is the whole panel. Nothing is
 * pushed to you, so an invite can take up to POLL_MS to arrive.
 */

const POLL_MS = 30_000;
const POLL_OPEN_MS = 10_000;
const BANNER_MS = 20_000;
const STATUS_TIP = { online: 'In the online room', solo: 'Playing solo', lobby: 'In the lobby', offline: 'Offline' };

const ICON = {
  play: '<path d="M5 3l9 5-9 5z"/>',
  send: '<path d="M2 8l12-6-4 12-2-5z"/>',
  check: '<path d="M3 8.5l3.2 3.2L13 5"/>',
  cross: '<path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/>',
  wait: '<path d="M4 2h8M4 14h8M5 2c0 4 6 4 6 6s-6 2-6 6"/>',
  mail: '<path d="M2 4h12v8H2zM2 4l6 5 6-5"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
};
const svg = (key) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICON[key];                // our own constants, never user text
  return s;
};

export function createFriends({ getElement: $, account, getStatus, onJoin }) {
  const drawer = $('friends'), btn = $('friends-btn'), badge = $('fr-badge'), list = $('fr-list'), msg = $('fr-msg');
  let data = { friends: [], incoming: [], outgoing: [], invites: [] };
  let timer = null, busy = false, seenInvites = null, armedRemove = null, bannerTimer = 0;

  const signedIn = () => !!account.state.user;
  const isOpen = () => drawer.classList.contains('on');

  const say = (text, ok = false) => { msg.textContent = text ?? ''; msg.classList.toggle('ok', ok); };

  function button(cls, icon, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = `fr-b ${cls}`; b.title = title; b.setAttribute('aria-label', title);
    b.append(svg(icon));
    b.addEventListener('click', onClick);
    return b;
  }

  function row(cls, name, status, ...actions) {
    const r = document.createElement('div');
    r.className = `fr-row ${cls}`;
    const dot = document.createElement('i');
    dot.className = `fr-dot ${status ?? ''}`;
    if (status) dot.title = STATUS_TIP[status];
    const n = document.createElement('b');
    n.textContent = name;
    const a = document.createElement('span');
    a.className = 'fr-acts';
    a.append(...actions);
    r.append(dot, n, a);
    return r;
  }

  function section(icon, count) {
    const h = document.createElement('div');
    h.className = 'fr-sec';
    h.append(svg(icon));
    const c = document.createElement('em');
    c.textContent = count;
    h.append(c);
    return h;
  }

  /* --------------------------------- the server --------------------------------- */

  async function call(path, body) {
    const r = await account.api('POST', path, body);
    if (!r) { say('Could not reach the server.'); return null; }
    if (r.status >= 400) { say(r.data?.message ?? 'That did not work.'); return null; }
    take(r.data);
    return r.data;
  }

  function take(next) {
    // Rebuilding the rows under a pointer that is about to click one loses the click, so only
    // repaint when something actually changed.
    if (JSON.stringify(next) !== JSON.stringify(data)) { data = next; paint(); }
    const names = new Set(next.invites.map((i) => i.from));
    // The first answer after sign-in is not news; only invites that turn up after it are.
    if (seenInvites) {
      const fresh = next.invites.find((i) => !seenInvites.has(i.from));
      if (fresh) banner(fresh.from);
    }
    seenInvites = names;
  }

  async function refresh() {
    if (busy || !signedIn() || document.hidden) return;
    busy = true;
    try {
      const r = await account.api('POST', '/api/presence', { status: getStatus() });
      if (r?.status === 200) take(r.data);
    } finally { busy = false; }
  }

  function schedule() {
    clearInterval(timer);
    timer = null;
    if (!signedIn()) return;
    timer = setInterval(refresh, isOpen() ? POLL_OPEN_MS : POLL_MS);
  }

  /* ----------------------------------- painting ----------------------------------- */

  function paint() {
    const pending = data.incoming.length + data.invites.length;
    badge.textContent = pending;
    badge.hidden = pending === 0;
    btn.classList.toggle('hot', pending > 0);
    list.textContent = '';

    if (data.invites.length) {
      list.append(section('mail', data.invites.length));
      for (const i of data.invites) {
        list.append(row('invite', i.from, null,
          button('go', 'play', `Join ${i.from}`, () => accept(i.from)),
          button('no', 'cross', 'Dismiss', () => call('/api/friends/dismiss', { name: i.from }))));
      }
    }
    if (data.incoming.length) {
      list.append(section('plus', data.incoming.length));
      for (const n of data.incoming) {
        list.append(row('req', n, null,
          button('go chk', 'check', `Accept ${n}`, () => call('/api/friends/accept', { name: n })),
          button('no', 'cross', 'Decline', () => call('/api/friends/decline', { name: n }))));
      }
    }
    const online = data.friends.filter((f) => f.online);
    const away = data.friends.filter((f) => !f.online);
    if (online.length) list.append(section('play', online.length));
    for (const f of online) list.append(friendRow(f));
    if (away.length) {
      const h = section('wait', away.length);
      h.classList.add('away');
      list.append(h);
    }
    for (const f of away) list.append(friendRow(f));
    for (const n of data.outgoing) {
      list.append(row('out', n, 'offline', button('no', 'cross', 'Cancel request', () => call('/api/friends/decline', { name: n }))));
    }
    if (!data.friends.length && !data.incoming.length && !data.outgoing.length && !data.invites.length) {
      const e = document.createElement('div');
      e.className = 'fr-empty';
      e.append(svg('plus'));
      list.append(e);
    }
  }

  function friendRow(f) {
    const acts = [];
    if (f.status === 'online') acts.push(button('go', 'play', `Join ${f.username}`, () => { close(); onJoin(); }));
    if (f.online) {
      acts.push(button('inv', 'send', `Invite ${f.username}`, async (e) => {
        const el = e.currentTarget;
        if (await call('/api/friends/invite', { name: f.username })) { say(`Invited ${f.username}`, true); el.classList.add('sent'); }
      }));
    }
    const armed = armedRemove === f.username;
    const rm = button(`no${armed ? ' armed' : ''}`, 'cross', armed ? 'Click again to remove' : 'Remove friend', () => {
      if (armedRemove !== f.username) { armedRemove = f.username; paint(); setTimeout(() => { if (armedRemove === f.username) { armedRemove = null; paint(); } }, 3000); return; }
      armedRemove = null;
      call('/api/friends/remove', { name: f.username });
    });
    acts.push(rm);
    return row(f.online ? 'on' : 'off', f.username, f.status, ...acts);
  }

  /** Taking an invite: tell the server it is handled, then go where the friend is. */
  async function accept(from) {
    await call('/api/friends/dismiss', { name: from });
    hideBanner();
    close();
    onJoin();
  }

  /* ----------------------------------- the banner ----------------------------------- */

  let banEl = null;
  function banner(from) {
    if (!banEl) {
      banEl = document.createElement('div');
      banEl.id = 'fr-invite';
      $('menu').append(banEl);
    }
    banEl.textContent = '';
    const av = document.createElement('i');
    av.textContent = from.slice(0, 1).toUpperCase();
    const n = document.createElement('b');
    n.textContent = from;
    banEl.append(av, n,
      button('go', 'play', `Join ${from}`, () => accept(from)),
      button('no', 'cross', 'Dismiss', () => { hideBanner(); call('/api/friends/dismiss', { name: from }); }));
    banEl.classList.add('on');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(hideBanner, BANNER_MS);
  }
  function hideBanner() { banEl?.classList.remove('on'); clearTimeout(bannerTimer); }

  /* ------------------------------------- drawer ------------------------------------- */

  function open() {
    if (!signedIn()) return;
    drawer.classList.add('on');
    say('');
    schedule();
    refresh();
    $('fr-name').focus({ preventScroll: true });
  }
  function close() { drawer.classList.remove('on'); schedule(); }

  function sync() {
    const on = signedIn();
    btn.hidden = !on;
    if (!on) {
      drawer.classList.remove('on');
      data = { friends: [], incoming: [], outgoing: [], invites: [] };
      seenInvites = null;
      hideBanner();
      paint();
    } else {
      refresh();
    }
    schedule();
  }

  function init() {
    btn.addEventListener('click', () => (isOpen() ? close() : open()));
    $('fr-close').addEventListener('click', close);
    $('fr-add').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('fr-name');
      const name = input.value.trim();
      if (!name) return;
      const before = data.friends.length;
      if (await call('/api/friends/request', { name })) {
        input.value = '';
        say(data.friends.length > before ? `You and ${name} are friends` : `Request sent to ${name}`, true);
      }
    });
    // Keys typed into the drawer are for the drawer.
    drawer.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.code === 'Escape') close(); });
    addEventListener('overrun:auth', sync);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    sync();
  }

  return { init, open, close, refresh, sync, get data() { return data; } };
}
