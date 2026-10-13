// @vitest-environment node
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureBackendDistBuilt } from './backendDist';

const tempDirs: string[] = [];

const request = (url: string) =>
  new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body,
            headers: res.headers,
          });
        });
      })
      .on('error', reject);
  });

const createEditorStaticRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iarts-editor-static-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'index.html'),
    '<!doctype html><html><body><div id="app">editor</div></body></html>',
    'utf8',
  );
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log("editor");', 'utf8');
  return root;
};

beforeAll(() => {
  // dist 由顶层 pnpm test 的 build 阶段保证；仅在缺失时构建（带跨进程锁），
  // 避免并行全量跑时无条件重建 dist 与其他测试文件产生竞争。
  ensureBackendDistBuilt();
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('backend editor static route', () => {
  it('同源承载 /editor/ 入口和静态资源，不抢占其他业务前缀', async () => {
    vi.resetModules();
    const { createRequestHandler } = (await import(
      '../../apps/backend/dist/local-server/router.cjs'
    )) as {
      createRequestHandler: (options?: Record<string, unknown>) => http.RequestListener;
    };

    const staticRoot = createEditorStaticRoot();
    const server = http.createServer(
      createRequestHandler({
        editorStaticRoot: staticRoot,
      }),
    );

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const entry = await request(`http://127.0.0.1:${port}/editor/`);
      expect(entry.status).toBe(200);
      expect(entry.body).toContain('<div id="app">editor</div>');
      expect(entry.headers['content-type']).toContain('text/html');

      const asset = await request(`http://127.0.0.1:${port}/editor/assets/app.js`);
      expect(asset.status).toBe(200);
      expect(asset.body).toContain('console.log("editor")');
      expect(asset.headers['content-type']).toContain('application/javascript');

      const apiMiss = await request(`http://127.0.0.1:${port}/api/not-found`);
      expect(apiMiss.status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
