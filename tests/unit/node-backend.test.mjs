import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

import { fileStore } from '../../server/accounts-file.js';
import { startServer } from '../../server/node.js';

const password = 'test-password';
const tunnelHeaders = { 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.10' };

function register(port, username, headers = tunnelHeaders) {
  return fetch(`http://127.0.0.1:${port}/api/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ username, password }),
  });
}

test('tunnel mode uses HTTPS cookies and separate IP limits', async (t) => {
  const server = await startServer({ port: 0, accountsFile: null, accountIterations: 1000, trustCloudflare: true, log: () => {} });
  t.after(() => server.stop());
  for (let i = 0; i < 4; i++) {
    const res = await register(server.port, `player${i}`, { ...tunnelHeaders, origin: `https://127.0.0.1:${server.port}` });
    assert.equal(res.status, 201);
    assert.match(res.headers.get('set-cookie'), /; Secure$/);
    await res.text();
  }
  assert.equal((await register(server.port, 'blocked')).status, 429);
  const otherClient = await register(server.port, 'other', { ...tunnelHeaders, 'cf-connecting-ip': '2001:db8::1' });
  assert.equal(otherClient.status, 201);
  await otherClient.text();
  const crossSite = await register(server.port, 'crosssite', { ...tunnelHeaders, origin: 'https://other.example' });
  assert.equal(crossSite.status, 403);
});

test('direct mode ignores forwarded protocol and IP', async (t) => {
  const server = await startServer({ port: 0, accountsFile: null, accountIterations: 1000, log: () => {} });
  t.after(() => server.stop());
  for (let i = 0; i < 5; i++) {
    const res = await register(server.port, `player${i}`, { ...tunnelHeaders, 'cf-connecting-ip': `203.0.113.${10 + i}` });
    assert.equal(res.status, i < 4 ? 201 : 429);
    if (i < 4) assert.doesNotMatch(res.headers.get('set-cookie'), /; Secure/);
    await res.text();
  }
});

test('the Node CLI flushes accounts on SIGINT and loads them after restart', { timeout: 10_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'overrun-accounts-'));
  const accountsFile = join(dir, 'accounts.json');
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
    }
    await rm(dir, { recursive: true, force: true });
  });

  async function launch() {
    const child = spawn(process.execPath, ['server/node.js', '0'], {
      env: { ...process.env, HOST: '127.0.0.1', ACCOUNTS_FILE: accountsFile, MP_BUDGET_FILE: join(dir, 'budget.json'), MP_BUDGET_LIMIT: '20000000' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    children.push(child);
    const lines = createInterface({ input: child.stdout });
    for await (const line of lines) {
      const match = /127\.0\.0\.1:(\d+)/.exec(line);
      if (match) return { child, port: Number(match[1]) };
    }
    assert.fail('Node exited before opening its listener');
  }

  const first = await launch();
  const signup = await register(first.port, 'persisted', {});
  assert.equal(signup.status, 201);
  const cookie = signup.headers.get('set-cookie').split(';')[0];
  const exited = once(first.child, 'exit');
  first.child.kill('SIGINT');
  assert.deepEqual(await exited, [0, null]);
  assert.equal((await fileStore(accountsFile).get('u:persisted')).username, 'persisted');

  const restarted = await launch();
  const response = await fetch(`http://127.0.0.1:${restarted.port}/api/me`, { headers: { cookie } });
  assert.equal((await response.json()).user.username, 'persisted');
  const stats = await fetch(`http://127.0.0.1:${restarted.port}/stats`);
  assert.equal((await stats.json()).budget.limit, 20_000_000);
  const restartedExit = once(restarted.child, 'exit');
  restarted.child.kill('SIGTERM');
  assert.deepEqual(await restartedExit, [0, null]);

  await writeFile(accountsFile, '{invalid');
  assert.throws(() => fileStore(accountsFile), /Invalid JSON in account file/);
});
