import { AccountError, Throttle } from './accounts.js';

/**
 * The /api/* routes for accounts, on web-standard Request and Response so the same code serves
 * the Cloudflare Durable Object and the local Node server.
 *
 *   POST   /api/register   { username, email?, password }          -> account, career, recovery code
 *   POST   /api/login      { login, password }                      -> account, career
 *   POST   /api/logout                                              -> clears the session
 *   GET    /api/me                                                  -> account, career (401 if signed out)
 *   PUT    /api/profile    { profile, rev }                         -> the saved career
 *   POST   /api/password   { current, password }
 *   POST   /api/recover    { login, recoveryCode, password }        -> signs in, issues a new recovery code
 *   DELETE /api/account    { password }
 *
 * The session is an HttpOnly, SameSite=Lax cookie, so page scripts never see it. State-changing
 * calls must be JSON and, when the browser says where they came from, must come from this site.
 */

const COOKIE = 'overrun_session';
const MAX_BODY = 16 * 1024;
const SESSION_SECONDS = 30 * 86_400;

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
});

function readCookie(request, name) {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

const sessionCookie = (token, secure) => `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}${secure ? '; Secure' : ''}`;
const clearedCookie = (secure) => `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;

async function body(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new AccountError(413, 'size', 'That request is too large.');
  try { const v = JSON.parse(text || '{}'); return v && typeof v === 'object' ? v : {}; } catch { throw new AccountError(400, 'json', 'That request was not valid JSON.'); }
}

export function createAccountApi({ accounts, throttle = new Throttle(), getIp = (r) => r.headers.get('cf-connecting-ip') ?? 'local' }) {
  async function route(request, url, secure, ip) {
    const method = request.method;
    const path = url.pathname;
    const tokenIn = readCookie(request, COOKIE);

    if (method !== 'GET' && method !== 'HEAD') {
      if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) throw new AccountError(415, 'type', 'Requests must be JSON.');
      const origin = request.headers.get('origin');
      if (origin && new URL(origin).host !== url.host) throw new AccountError(403, 'origin', 'Cross-site requests are not allowed.');
    }

    if (path === '/api/me' && method === 'GET') {
      const u = await accounts.session(tokenIn);
      if (!u) return json(401, { error: 'signed_out' }, tokenIn ? { 'set-cookie': clearedCookie(secure) } : {});
      return json(200, { user: accounts.publicUser(u), ...accounts.snapshot(u) });
    }

    /** Sign-in style calls share one throttle: by address and by the name being tried. */
    async function guarded(name, work) {
      const keys = [`ip:${ip}`, `name:${String(name ?? '').trim().toLowerCase()}`];
      const wait = Math.max(...keys.map((k) => throttle.wait(k)));
      if (wait > 0) throw Object.assign(new AccountError(429, 'throttled', `Too many attempts. Try again in ${wait} s.`), { retryAfter: wait });
      try {
        const out = await work();
        throttle.clear(keys[1]);     // a good sign-in forgives the name, never the address: it could be a guesser's own account
        return out;
      } catch (e) {
        if (e instanceof AccountError && (e.code === 'credentials' || e.code === 'recovery')) for (const k of keys) throttle.fail(k);
        throw e;
      }
    }

    if (path === '/api/register' && method === 'POST') {
      const b = await body(request);
      // Sign-ups are throttled by address only: they cost a hash each and make names.
      const wait = throttle.wait(`reg:${ip}`);
      if (wait > 0) throw Object.assign(new AccountError(429, 'throttled', `Too many sign-ups. Try again in ${wait} s.`), { retryAfter: wait });
      const r = await accounts.register(b);
      for (let i = 0; i < 2; i++) throttle.fail(`reg:${ip}`);      // four accounts per window per address
      const { token, ...rest } = r;
      return json(201, rest, { 'set-cookie': sessionCookie(token, secure) });
    }
    if (path === '/api/login' && method === 'POST') {
      const b = await body(request);
      const r = await guarded(b.login, () => accounts.login(b));
      const { token, ...rest } = r;
      return json(200, rest, { 'set-cookie': sessionCookie(token, secure) });
    }
    if (path === '/api/logout' && method === 'POST') {
      await accounts.logout(tokenIn);
      return json(200, { ok: true }, { 'set-cookie': clearedCookie(secure) });
    }
    if (path === '/api/recover' && method === 'POST') {
      const b = await body(request);
      const r = await guarded(b.login, () => accounts.recover(b));
      const { token, ...rest } = r;
      return json(200, rest, { 'set-cookie': sessionCookie(token, secure) });
    }

    // Everything below needs a signed-in account.
    const u = await accounts.session(tokenIn);
    if (!u) throw new AccountError(401, 'signed_out', 'Sign in first.');

    if (path === '/api/profile' && method === 'PUT') {
      const b = await body(request);
      return json(200, await accounts.saveProfile(u, b));
    }
    if (path === '/api/password' && method === 'POST') {
      const b = await body(request);
      const { token } = await guarded(u.username, () => accounts.changePassword(u, b));
      return json(200, { ok: true }, { 'set-cookie': sessionCookie(token, secure) });
    }
    if (path === '/api/account' && method === 'DELETE') {
      const b = await body(request);
      await guarded(u.username, () => accounts.deleteAccount(u, b));
      return json(200, { ok: true }, { 'set-cookie': clearedCookie(secure) });
    }
    throw new AccountError(404, 'not_found', 'No such account call.');
  }

  /** Returns a Response for /api/* requests, or null for anything else. */
  return async function handle(request, { ip } = {}) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return null;
    const secure = url.protocol === 'https:';
    try {
      return await route(request, url, secure, ip ?? getIp(request));
    } catch (e) {
      if (e instanceof AccountError) {
        return json(e.status, { error: e.code, message: e.message }, e.retryAfter ? { 'retry-after': String(e.retryAfter) } : {});
      }
      console.error('accounts:', e);
      return json(500, { error: 'server', message: 'Something went wrong on the server.' });
    }
  };
}
