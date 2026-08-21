import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.TEST_HOST || '127.0.0.1';
const port = Number(process.env.TEST_PORT || 4173);

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.glb', 'model/gltf-binary'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);

function resolveRequestPath(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, `http://${host}:${port}`).pathname);
  const relative = pathname.replace(/^[/\\]+/, '') || 'index.html';
  const candidate = path.resolve(root, relative);
  const insideRoot = candidate === root || candidate.startsWith(`${root}${path.sep}`);
  return insideRoot ? candidate : null;
}
const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  let filePath = resolveRequestPath(request.url || '/');
  if (!filePath) {
    response.writeHead(403).end();
    return;
  }

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = path.join(filePath, 'index.html');
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile()) throw new Error('not a file');

    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Length': fileInfo.size,
      'Content-Type': contentTypes.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

server.listen(port, host, () => {
  process.stdout.write(`OVERRUN test server listening on http://${host}:${port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
