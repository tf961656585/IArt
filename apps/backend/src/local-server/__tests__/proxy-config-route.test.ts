import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HUB_LOCAL_WRITE_TOKEN_ENV, HUB_LOCAL_WRITE_TOKEN_HEADER } from '@iart/contracts';
import { createRequestHandler } from '../router.cts';

const HUB_WRITE_TOKEN = 'b'.repeat(32);

type JsonValue = Record<string, unknown>;

const startServer = async () => {
  const server = http.createServer(createRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address == null || typeof address == 'string') {
    throw new Error('proxy_config_route_server_address_unavailable');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
};

const withTempEnv = (t: test.TestContext) => {
  const previousToken = process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iart-proxy-config-route-'));
  process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = HUB_WRITE_TOKEN;
  process.env['IART_STORAGE_ROOT'] = tempDir;
  t.after(() => {
    if (previousToken == null) delete process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
    else process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = previousToken;
    if (previousRoot == null) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return tempDir;
};

const withServer = async (t: test.TestContext) => {
  const started = await startServer();
  t.after(() => new Promise<void>((resolve, reject) => {
    started.server.close((error) => (error ? reject(error) : resolve()));
  }));
  return started.baseUrl;
};

const headers = () => ({
  'content-type': 'application/json',
  [HUB_LOCAL_WRITE_TOKEN_HEADER]: HUB_WRITE_TOKEN,
});

void test('GET /api/config exposes proxyMode + nullable proxyUrl in resolved', async (t) => {
  withTempEnv(t);
  const baseUrl = await withServer(t);
  const response = await fetch(`${baseUrl}/api/config`);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as JsonValue;
  const resolved = payload['resolved'] as JsonValue;
  assert.ok(['system', 'direct', 'manual'].includes(String(resolved['proxyMode'])));
  const proxyUrl = resolved['proxyUrl'];
  assert.ok(proxyUrl === null || typeof proxyUrl === 'string');
});

void test('PUT /api/config persists manual proxy and reflects in resolved (round-trip)', async (t) => {
  const tempDir = withTempEnv(t);
  const baseUrl = await withServer(t);

  const putResponse = await fetch(`${baseUrl}/api/config`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ proxyMode: 'manual', proxyUrl: 'http://127.0.0.1:7890' }),
  });
  assert.equal(putResponse.status, 200);
  const putPayload = (await putResponse.json()) as JsonValue;
  assert.equal((putPayload['resolved'] as JsonValue)['proxyMode'], 'manual');
  assert.equal((putPayload['resolved'] as JsonValue)['proxyUrl'], 'http://127.0.0.1:7890/');

  // backend.json 持久化验证
  const persisted = JSON.parse(fs.readFileSync(path.join(tempDir, 'config', 'backend.json'), 'utf-8')) as JsonValue;
  assert.equal(persisted['proxyMode'], 'manual');
  assert.equal(persisted['proxyUrl'], 'http://127.0.0.1:7890/');

  // 切回 system 清 URL
  const reset = await fetch(`${baseUrl}/api/config`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ proxyMode: 'system', proxyUrl: '' }),
  });
  const resetPayload = (await reset.json()) as JsonValue;
  assert.equal((resetPayload['resolved'] as JsonValue)['proxyMode'], 'system');
  assert.equal((resetPayload['resolved'] as JsonValue)['proxyUrl'], null);
});

void test('PUT /api/config rejects manual without valid proxyUrl with 400', async (t) => {
  withTempEnv(t);
  const baseUrl = await withServer(t);

  const missing = await fetch(`${baseUrl}/api/config`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ proxyMode: 'manual', proxyUrl: '' }),
  });
  assert.equal(missing.status, 400);
  const missingPayload = (await missing.json()) as JsonValue;
  assert.match(String(missingPayload['message']), /valid proxy URL/i);

  const invalidScheme = await fetch(`${baseUrl}/api/config`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ proxyMode: 'manual', proxyUrl: 'socks5://127.0.0.1:7890' }),
  });
  assert.equal(invalidScheme.status, 400);
});

void test('PUT /api/config requires hub write token (guard applies to proxy fields)', async (t) => {
  withTempEnv(t);
  const baseUrl = await withServer(t);
  const response = await fetch(`${baseUrl}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ proxyMode: 'direct' }),
  });
  // 守卫拒绝码为 403 origin_not_allowed（router.cts hub local write trust 路径）
  assert.equal(response.status, 403);
});
