import { mergeProfiles } from './profile.js';

/**
 * The account in the browser: the chip in the lobby's top bar, the sign-in card, and keeping the
 * career saved on the server whenever you are signed in. See server/accounts.js for the other side.
 *
 * The server may not be there at all (the plain static test server, or opening index.html from a
 * file). Then the chip says so and the game is exactly the guest game it always was. The session
 * itself is an HttpOnly cookie, so nothing here ever touches a token.
 */

const PUSH_DELAY_MS = 1500;
const VIEW_TITLES = {
  login: 'SIGN IN', register: 'CREATE ACCOUNT', forgot: 'RESET PASSWORD', recovery: 'RECOVERY CODE',
  in: 'ACCOUNT', password: 'CHANGE PASSWORD', delete: 'DELETE ACCOUNT',
};

export function createAccount({ getElement: $, getProfile, setProfile, setCallsign, onChange, fetchFn = (...a) => fetch(...a) }) {
  const state = { available: null, user: null, rev: 0 };
  let pushTimer = null, pushing = false, pushAgain = false;

  const modal = $('acct'), msg = $('acct-msg'), chip = $('account'), chipName = $('ac-name');
  let view = 'login';

  /* ------------------------------- the server ------------------------------- */

  /** { status, data } or null when there is no account server behind this page. */
  async function api(method, path, body) {
    let res;
    try {
      res = await fetchFn(path, {
        method, credentials: 'same-origin',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { return null; }
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) return null;
    let data = null;
    try { data = await res.json(); } catch { return null; }
    return { status: res.status, data };
  }

  /* --------------------------------- the chip --------------------------------- */

  function paintChip() {
    if (!chip) return;
    chip.classList.toggle('in', !!state.user);
    chip.classList.toggle('off', state.available === false);
    const tip = state.available === false ? 'Accounts need the online server' : state.user ? 'Your account' : 'Sign in or create an account';
    chip.title = tip;
    if (chipName) chipName.textContent = state.available === false ? 'GUEST' : state.user ? state.user.username.toUpperCase() : 'SIGN IN';
    // Whatever needs to know who is signed in (the friends drawer) listens for this.
    globalThis.dispatchEvent(new CustomEvent('overrun:auth', { detail: { user: state.user?.username ?? null } }));
  }

  function applyCloud(data) {
    state.user = data.user;
    state.rev = data.rev;
    const local = getProfile();
    const merged = mergeProfiles(local, data.profile);
    setProfile(merged);
    setCallsign?.(state.user.username);
    paintChip();
    onChange?.(merged);
    // The guest career had more in it than the account did: save the merge back.
    if (JSON.stringify(merged) !== JSON.stringify(data.profile)) schedulePush(0);
  }

  function signedOut() {
    state.user = null;
    state.rev = 0;
    clearTimeout(pushTimer);
    paintChip();
  }

  /* ---------------------------------- saving ---------------------------------- */

  function schedulePush(delay = PUSH_DELAY_MS) {
    if (!state.user) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, delay);
  }

  async function push() {
    if (!state.user) return;
    if (pushing) { pushAgain = true; return; }
    pushing = true;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await api('PUT', '/api/profile', { profile: getProfile(), rev: state.rev });
        if (!r) return;
        if (r.status === 200) { state.rev = r.data.rev; break; }
        if (r.status === 401) { signedOut(); return; }
        // Another device saved first, or ours had fallen behind: take theirs, merge, try once more.
        if (r.status === 409 || r.data?.error === 'regress') {
          const me = await api('GET', '/api/me');
          if (me?.status !== 200) return;
          state.rev = me.data.rev;
          const merged = mergeProfiles(getProfile(), me.data.profile);
          setProfile(merged);
          onChange?.(merged);
          continue;
        }
        return;
      }
    } finally {
      pushing = false;
      if (pushAgain) { pushAgain = false; schedulePush(0); }
    }
  }

  /** Called by the game whenever the career is saved. */
  function profileSaved() { schedulePush(); }

  /* ----------------------------------- the card ----------------------------------- */

  function say(text, ok = false) {
    if (!msg) return;
    msg.textContent = text ?? '';
    msg.classList.toggle('ok', ok);
  }

  function show(next) {
    view = next;
    for (const el of modal.querySelectorAll('[data-view]')) el.classList.toggle('on', el.dataset.view === next);
    $('acct-title').textContent = VIEW_TITLES[next] ?? 'ACCOUNT';
    say('');
    if (next === 'in') {
      $('acct-name').textContent = state.user?.username ?? '';
      $('acct-mail').textContent = state.user?.email ?? 'No email on this account';
    }
    modal.querySelector(`[data-view="${next}"] input`)?.focus({ preventScroll: true });
  }

  function open() {
    if (state.available === false) return;
    modal.classList.add('on');
    show(state.user ? 'in' : 'login');
  }

  function close() {
    // The recovery code is shown once; do not let a stray click throw it away.
    if (view === 'recovery') return;
    modal.classList.remove('on');
    for (const f of modal.querySelectorAll('form')) f.reset();
  }

  const fields = (form) => Object.fromEntries(new globalThis.FormData(form).entries());

  async function submit(form) {
    const kind = form.dataset.view;
    const b = fields(form);
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    say('One moment…', true);
    try {
      const calls = {
        login: () => api('POST', '/api/login', { login: b.login, password: b.password }),
        register: () => api('POST', '/api/register', { username: b.username, email: b.email, password: b.password }),
        forgot: () => api('POST', '/api/recover', { login: b.login, recoveryCode: b.recoveryCode, password: b.password }),
        password: () => api('POST', '/api/password', { current: b.current, password: b.password }),
        delete: () => api('DELETE', '/api/account', { password: b.password }),
      };
      const r = await calls[kind]();
      if (!r) { say('Could not reach the account server.'); return; }
      if (r.status >= 400) { say(r.data?.message ?? 'That did not work.'); return; }
      form.reset();
      if (kind === 'login') { applyCloud(r.data); close(); }
      else if (kind === 'register' || kind === 'forgot') {
        applyCloud(r.data);
        $('acct-code').textContent = r.data.recoveryCode;
        show('recovery');
      } else if (kind === 'password') { show('in'); say('Password changed. Other devices were signed out.', true); }
      else if (kind === 'delete') { signedOut(); close(); }
    } finally {
      button.disabled = false;
    }
  }

  function bind() {
    chip?.addEventListener('click', open);
    modal.addEventListener('click', (e) => {
      if (e.target === modal || e.target.closest('.pop-x')) close();
      const go = e.target.closest('[data-go]');
      if (go) show(go.dataset.go);
    });
    for (const form of modal.querySelectorAll('form')) {
      form.addEventListener('submit', (e) => { e.preventDefault(); submit(form); });
    }
    $('acct-out').addEventListener('click', async () => {
      await api('POST', '/api/logout', {});
      signedOut();
      close();
    });
    $('acct-saved').addEventListener('click', () => { $('acct-code').textContent = ''; view = 'in'; close(); });
    $('acct-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($('acct-code').textContent); say('Copied.', true); } catch { say('Select the code and copy it by hand.'); }
    });
    addEventListener('keydown', (e) => { if (e.code === 'Escape' && modal.classList.contains('on')) close(); });
    // Keys typed into the card are for the card.
    modal.addEventListener('keydown', (e) => e.stopPropagation());
  }

  /** Called once at boot: bind the card and find out whether there is a server and a session. */
  async function init() {
    bind();
    const r = await api('GET', '/api/me');
    // `offline` is what the plain static test server answers; a missing server is a 404 or no answer at all.
    if (!r || r.status !== 200 || r.data?.offline) { state.available = false; paintChip(); return; }
    state.available = true;
    if (r.data.user) applyCloud(r.data); else paintChip();
  }

  return { init, open, close, profileSaved, push, state, api };
}
