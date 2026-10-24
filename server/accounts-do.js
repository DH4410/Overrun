import { DurableObject } from 'cloudflare:workers';

import { Accounts, Throttle } from './accounts.js';
import { createAccountApi } from './accounts-http.js';

/**
 * The accounts on Cloudflare: one Durable Object named "main" whose storage holds every account.
 * One object is plenty for a game this size, and it makes sign-up uniqueness trivial. The
 * PBKDF2 cost is `PBKDF2_ITERATIONS` (a Worker allows at most 100,000).
 */
export class AccountsDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const iterations = Math.min(100_000, Number(env.PBKDF2_ITERATIONS) || 100_000);
    const store = {
      get: (k) => ctx.storage.get(k),
      put: (k, v) => ctx.storage.put(k, v),
      delete: (k) => ctx.storage.delete(k),
    };
    this.api = createAccountApi({ accounts: new Accounts({ store, iterations }), throttle: new Throttle() });
  }

  async fetch(request) {
    return (await this.api(request)) ?? new Response('Not found', { status: 404 });
  }
}
