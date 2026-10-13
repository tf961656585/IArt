import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const sourceRoot = path.join(repoRoot, 'apps', 'hub', 'dist-static');

const args = process.argv.slice(2);

const readOption = (name, fallback) => {
  const index = args.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (index === -1) return fallback;
  const arg = args[index];
  if (arg.startsWith(`${name}=`)) {
    const value = arg.slice(name.length + 1).trim();
    return value || fallback;
  }
  const value = args[index + 1];
  return value && !value.startsWith('-') ? value.trim() : fallback;
};

const host = readOption('--host', '127.0.0.1');
const port = Number.parseInt(readOption('--port', '3200'), 10);

const safeJoin = (baseDir, targetPath) => {
  const resolved = path.resolve(baseDir, targetPath);
  return resolved.startsWith(path.resolve(baseDir)) ? resolved : null;
};

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${host}:${port}`);
  const pathname = requestUrl.pathname === '/hub' ? '/index.html' : requestUrl.pathname;
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = safeJoin(sourceRoot, relativePath);

  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType =
    ext === '.html'
      ? 'text/html; charset=utf-8'
      : ext === '.css'
        ? 'text/css; charset=utf-8'
        : ext === '.js'
          ? 'text/javascript; charset=utf-8'
          : 'application/octet-stream';

  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(port, host, () => {
  console.log(`[hub-dev-server] listening on http://${host}:${port}`);
});
