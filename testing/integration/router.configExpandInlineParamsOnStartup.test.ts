// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryResponse, createMockRequest, type MockRequest, type RouterModule } from './helpers/http-test-types';
import { sharedRequire } from './helpers/cjs-mock';
import { clearIartsDataRoot, setIartsDataRoot } from './helpers/runtime-globals';



/* hub 本地写守卫：PUT /api/config 要求 env token + header + loopback 来源 */
const HUB_WRITE_TOKEN_ENV = 'IART_HUB_LOCAL_WRITE_TOKEN';
const HUB_WRITE_TOKEN_HEADER = 'x-iart-hub-write-token';
const HUB_WRITE_TOKEN = 'router-test-write-token-0123456789abcdef';
let previousHubWriteToken: string | undefined;

const requestJson = async (
  handler: (req: MockRequest, res: MemoryResponse) => Promise<void>,
  options: { method: string; url: string; body?: Record<string, unknown> }
) => {
  const rawBody = options.body ? Buffer.from(JSON.stringify(options.body), 'utf-8') : undefined;
  const req = createMockRequest({
    method: options.method,
    url: options.url,
    body: rawBody,
    headers: rawBody
      ? {
          'content-type': 'application/json',
          'content-length': String(rawBody.length),
          [HUB_WRITE_TOKEN_HEADER]: HUB_WRITE_TOKEN,
        }
      : {
          [HUB_WRITE_TOKEN_HEADER]: HUB_WRITE_TOKEN,
        },
  });
  (req as MockRequest & { socket: { remoteAddress: string } }).socket = {
    remoteAddress: '127.0.0.1',
  };

  const res = new MemoryResponse();
  await handler(req, res);
  await new Promise((resolve) => res.once('finish', resolve));

  return {
    status: res.statusCode,
    headers: res.headers,
    json: JSON.parse(res.body.toString('utf-8')) as { config?: Record<string, unknown> },
  };
};

describe('backend router /api/config expandInlineParamsOnStartup', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iarts-router-config-expand-inline-'));
    setIartsDataRoot(path.join(tempRoot, 'storage'));
    previousHubWriteToken = process.env[HUB_WRITE_TOKEN_ENV];
    process.env[HUB_WRITE_TOKEN_ENV] = HUB_WRITE_TOKEN;
    vi.resetModules();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
    if (previousHubWriteToken === undefined) {
      delete process.env[HUB_WRITE_TOKEN_ENV];
    } else {
      process.env[HUB_WRITE_TOKEN_ENV] = previousHubWriteToken;
    }
    clearIartsDataRoot();
    vi.resetModules();
  });

  it('应通过真实 /api/config 路由完成保存并回读首屏开关值', async () => {
    const router = await import('../../apps/backend/dist/local-server/router.cjs') as RouterModule;
    const storageHints = sharedRequire('@iart/utils/storage-root-hints') as {
      resolveBackendConfigFilePath: (options?: Record<string, unknown>) => string;
    };
    const handler = router.createRequestHandler({ baseDir: process.cwd() });
    const configFilePath = storageHints.resolveBackendConfigFilePath();

    const initial = await requestJson(handler, {
      method: 'GET',
      url: '/api/config',
    });
    expect(initial.status).toBe(200);
    expect(initial.json.config?.['expandInlineParamsOnStartup']).toBe(false);

    const savedOn = await requestJson(handler, {
      method: 'PUT',
      url: '/api/config',
      body: { expandInlineParamsOnStartup: true },
    });
    expect(savedOn.status).toBe(200);
    expect(savedOn.json.config?.['expandInlineParamsOnStartup']).toBe(true);

    const readBackOn = await requestJson(handler, {
      method: 'GET',
      url: '/api/config',
    });
    expect(readBackOn.status).toBe(200);
    expect(readBackOn.json.config?.['expandInlineParamsOnStartup']).toBe(true);

    expect(fs.existsSync(configFilePath)).toBe(true);
    const savedFileOn = JSON.parse(fs.readFileSync(configFilePath, 'utf-8')) as {
      expandInlineParamsOnStartup?: boolean;
    };
    expect(savedFileOn.expandInlineParamsOnStartup).toBe(true);

    const savedOff = await requestJson(handler, {
      method: 'PUT',
      url: '/api/config',
      body: { expandInlineParamsOnStartup: false },
    });
    expect(savedOff.status).toBe(200);
    expect(savedOff.json.config?.['expandInlineParamsOnStartup']).toBe(false);

    const readBackOff = await requestJson(handler, {
      method: 'GET',
      url: '/api/config',
    });
    expect(readBackOff.status).toBe(200);
    expect(readBackOff.json.config?.['expandInlineParamsOnStartup']).toBe(false);

    const savedFileOff = JSON.parse(fs.readFileSync(configFilePath, 'utf-8')) as {
      expandInlineParamsOnStartup?: boolean;
    };
    expect(savedFileOff.expandInlineParamsOnStartup).toBe(false);
  });
});
