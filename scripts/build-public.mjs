import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Copies what the browser loads into .cf-public/, the directory wrangler.jsonc serves as static
 * assets. Serving the repo root directly made `wrangler dev` reload forever (it watches the
 * assets directory, and writes its own state under .wrangler/ inside it) and risked uploading
 * the server, the tests and node_modules. wrangler runs this before `dev` and `deploy`.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.cf-public');
const ENTRIES = ['index.html', 'game.js', 'ui-overhaul.css', 'sw.js', 'src', 'assets'];
const SKIP = /\.zip$|-tmp([\/]|$)/;

rmSync(OUT, { recursive: true, force: true });
for (const e of ENTRIES) cpSync(join(ROOT, e), join(OUT, e), { recursive: true, filter: (src) => !SKIP.test(src) });
console.log(`static files copied to ${OUT}`);
