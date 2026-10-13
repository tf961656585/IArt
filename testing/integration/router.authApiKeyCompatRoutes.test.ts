// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCjsMock, clearCjsCache, resolveCjsPath, cjsImportAs } from './helpers/cjs-mock';
import { MemoryResponse, createMockRequest, type RouterModule } from './helpers/http-test-types';

describe('backend router auth + api key compat routes', () => {
  const cjs = createCjsMock();
  /* hub 本地写守卫：写路由要求 env token + header + loopback 来源 */
  const HUB_WRITE_TOKEN_ENV = 'IART_HUB_LOCAL_WRITE_TOKEN';
  const HUB_WRITE_TOKEN_HEADER = 'x-iart-hub-write-token';
  const HUB_WRITE_TOKEN = 'router-test-write-token-0123456789abcdef';
  let previousHubWriteToken: string | undefined;

  const withHubWriteTrust = <T extends { headers: Record<string, string> }>(req: T): T => {
    req.headers[HUB_WRITE_TOKEN_HEADER] = HUB_WRITE_TOKEN;
    (req as T & { socket: { remoteAddress: string } }).socket = {
      remoteAddress: '127.0.0.1',
    };
    return req;
  };

  beforeEach(() => {
    cjs.restore();
    previousHubWriteToken = process.env[HUB_WRITE_TOKEN_ENV];
    process.env[HUB_WRITE_TOKEN_ENV] = HUB_WRITE_TOKEN;
  });

  afterEach(() => {
    cjs.restore();
    if (previousHubWriteToken === undefined) {
      delete process.env[HUB_WRITE_TOKEN_ENV];
    } else {
      process.env[HUB_WRITE_TOKEN_ENV] = previousHubWriteToken;
    }
  });

  it('已下线的 /api/auth/* 与 /api/hub/api-key 不再提供', async () => {
    const routerPath = resolveCjsPath('../../apps/backend/dist/local-server/router.cjs');
    clearCjsCache(routerPath);
    const router = await cjsImportAs<RouterModule>('../../apps/backend/dist/local-server/router.cjs');
    const handler = router.createRequestHandler({ baseDir: process.cwd() });

    /* 内置账号体系已下线：登录状态与登出路由随之删除，不得重新出现 */
    const authStatusReq = createMockRequest({ method: 'GET', url: '/api/auth/status', headers: {} });
    const authStatusRes = new MemoryResponse();
    await handler(authStatusReq, authStatusRes);
    await new Promise((resolve) => authStatusRes.once('finish', resolve));

    expect(authStatusRes.statusCode).toBe(404);

    const logoutReq = withHubWriteTrust(createMockRequest({ method: 'POST', url: '/api/auth/logout', body: Buffer.from('{}', 'utf-8'), headers: { 'content-type': 'application/json' } }));
    const logoutRes = new MemoryResponse();
    await handler(logoutReq, logoutRes);
    await new Promise((resolve) => logoutRes.once('finish', resolve));

    expect(logoutRes.statusCode).toBe(404);

    /* 旧密钥模式（account / custom 槽位 + apiKeyMode）已随 BYOK 化删除，路由不得重新出现 */
    const apiKeyReq = withHubWriteTrust(createMockRequest({ method: 'POST', url: '/api/hub/api-key', body: Buffer.from(JSON.stringify({ apiKeyMode: 'custom' }), 'utf-8'), headers: { 'content-type': 'application/json' } }));
    const apiKeyRes = new MemoryResponse();
    await handler(apiKeyReq, apiKeyRes);
    await new Promise((resolve) => apiKeyRes.once('finish', resolve));

    expect(apiKeyRes.statusCode).toBe(404);
  });

  it('不再提供 /hub 前端静态入口', async () => {
    const routerPath = resolveCjsPath('../../apps/backend/dist/local-server/router.cjs');
    clearCjsCache(routerPath);
    const router = await cjsImportAs<RouterModule>('../../apps/backend/dist/local-server/router.cjs');
    const handler = router.createRequestHandler({ baseDir: process.cwd() });

    const req = createMockRequest({ method: 'GET', url: '/hub', headers: {} });
    const res = new MemoryResponse();
    await handler(req, res);
    await new Promise((resolve) => res.once('finish', resolve));

    expect(res.statusCode).toBe(404);
  });

  it('不再提供 /api/workers-proxy/task-self 兼容路由', async () => {
    const routerPath = resolveCjsPath('../../apps/backend/dist/local-server/router.cjs');
    clearCjsCache(routerPath);
    const router = await cjsImportAs<RouterModule>('../../apps/backend/dist/local-server/router.cjs');
    const handler = router.createRequestHandler({ baseDir: process.cwd() });

    const req = createMockRequest({ method: 'GET', url: '/api/workers-proxy/task-self?status=accepted', headers: { accept: 'application/json' } });
    const res = new MemoryResponse();
    await handler(req, res);
    await new Promise((resolve) => res.once('finish', resolve));

    expect(res.statusCode).toBe(404);
    expect(res.headers['x-editor-backend-compat-route']).toBeUndefined();
  });
});
