import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  HUB_LOCAL_WRITE_TOKEN_ENV,
  HUB_LOCAL_WRITE_TOKEN_HEADER,
  ProviderConnectionCredentialResponseSchema,
  ProviderConnectionListResponseSchema,
  ProviderConnectionSchema,
  type ProviderConnection,
} from '@iart/contracts';
import { createRequestHandler } from '../router.cts';
import {
  clearCacheForTest as clearConnectionCache,
} from '../provider-connection/connection-store.cts';
import {
  clearCacheForTest as clearCredentialCache,
  readCredentialValue,
  setCredentialCryptoProvider,
} from '../provider-connection/credential-store.cts';

/**
 * 连接 DTO 的凭证投影（2026-10-29 拍板）：
 * - `credential_protection` / `credential_status` 由后端路由层从凭证存储合成，不持久化到连接文件；
 * - 无凭证 → 双 null；有凭证可读 → `ready`；最近一次读取失败 → `needs_reentry`；
 * - 所有返回 ProviderConnection 的响应都必须带齐，且能被 `ProviderConnectionSchema` parse 通过。
 */

const HUB_WRITE_TOKEN = 'p'.repeat(32);
const CONNECTION_BASE_URL = 'https://projection.example.invalid/v1';
const PLAINTEXT_VALUE = 'sk-projection-secret';

const withIsolatedEnv = (t: test.TestContext): string => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-projection-'));
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  const previousToken = process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
  process.env['IART_STORAGE_ROOT'] = storageRoot;
  process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = HUB_WRITE_TOKEN;
  clearConnectionCache();
  clearCredentialCache();
  t.after(() => {
    setCredentialCryptoProvider(null);
    clearConnectionCache();
    clearCredentialCache();
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    if (previousToken === undefined) delete process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
    else process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = previousToken;
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });
  return storageRoot;
};

const startServer = async (t: test.TestContext): Promise<string> => {
  const server = http.createServer(createRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('projection_test_server_address_unavailable');
  }
  return `http://127.0.0.1:${address.port}`;
};

const writeHeaders = (): Record<string, string> => ({
  'content-type': 'application/json',
  [HUB_LOCAL_WRITE_TOKEN_HEADER]: HUB_WRITE_TOKEN,
});

const call = async (baseUrl: string, pathname: string, method: string, body?: unknown): Promise<unknown> => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: writeHeaders(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `${method} ${pathname} failed: ${text}`);
  return text ? (JSON.parse(text) as unknown) : {};
};

const listConnections = async (baseUrl: string): Promise<ProviderConnection[]> => {
  const payload = await call(baseUrl, '/api/provider-connections', 'GET');
  const parsed = ProviderConnectionListResponseSchema.parse(payload);
  // 列表里每条都必须能独立 parse（契约 DTO 完整性）。
  return parsed.connections.map((connection) => ProviderConnectionSchema.parse(connection));
};

const findConnection = (connections: ProviderConnection[], connectionId: string): ProviderConnection => {
  const found = connections.find((connection) => connection.connection_id === connectionId);
  assert.ok(found, `connection ${connectionId} should be listed`);
  return found;
};

/** 把凭证条目改写为「解不出来的 obfuscated payload」，模拟真实不可读。 */
const corruptCredentialPayload = (storageRoot: string): void => {
  const filePath = path.join(storageRoot, 'config', 'provider-credentials.json');
  const file = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
    entries: Record<string, { payload: string; scheme?: string }>;
  };
  for (const entry of Object.values(file.entries)) {
    entry.payload = Buffer.from([0xc3, 0x28, 0xff]).toString('base64');
    entry.scheme = 'obfuscated';
  }
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf-8');
  clearCredentialCache();
};

void test('连接响应带齐凭证投影：可读=ready / 不可读=needs_reentry / 无凭证=双 null', async (t) => {
  const storageRoot = withIsolatedEnv(t);
  const baseUrl = await startServer(t);

  const created = ProviderConnectionSchema.parse(
    (await call(baseUrl, '/api/provider-connections', 'POST', {
      display_name: 'projection',
      base_url: CONNECTION_BASE_URL,
    }) as { connection: unknown }).connection,
  );
  assert.equal(created.has_credential, false);
  assert.equal(created.credential_protection, null, '无凭证时 protection 为 null');
  assert.equal(created.credential_status, null, '无凭证时 status 为 null');

  const credentialResponse = ProviderConnectionCredentialResponseSchema.parse(
    await call(baseUrl, `/api/provider-connections/${created.connection_id}/credential`, 'PUT', {
      value: PLAINTEXT_VALUE,
    }),
  );
  assert.equal(credentialResponse.connection.credential_protection, 'obfuscated', '无宿主安全存储时按实际方案投影');
  assert.equal(credentialResponse.connection.credential_status, 'ready');

  const afterWrite = findConnection(await listConnections(baseUrl), created.connection_id);
  assert.equal(afterWrite.credential_protection, 'obfuscated');
  assert.equal(afterWrite.credential_status, 'ready');
  assert.equal(afterWrite.has_credential, true);

  // 模拟读取失败（真实读取路径置位 lastReadFailureAt），投影转为 needs_reentry。
  corruptCredentialPayload(storageRoot);
  const read = await readCredentialValue(afterWrite.credential_ref ?? '');
  assert.equal(read.ok, false);
  const afterFailure = findConnection(await listConnections(baseUrl), created.connection_id);
  assert.equal(afterFailure.credential_status, 'needs_reentry');
  assert.equal(afterFailure.credential_protection, 'obfuscated');

  // 重新保存凭证 → 恢复 ready。
  const rewritten = ProviderConnectionCredentialResponseSchema.parse(
    await call(baseUrl, `/api/provider-connections/${created.connection_id}/credential`, 'PUT', {
      value: 'sk-projection-rotated',
    }),
  );
  assert.equal(rewritten.connection.credential_status, 'ready');
  assert.equal(rewritten.connection.credential_protection, 'obfuscated');

  // 单条查询同样带齐。
  const single = ProviderConnectionSchema.parse(
    (await call(baseUrl, `/api/provider-connections/${created.connection_id}`, 'GET') as { connection: unknown }).connection,
  );
  assert.equal(single.credential_status, 'ready');

  // 另一个没有凭证的连接：双 null。
  const bare = ProviderConnectionSchema.parse(
    (await call(baseUrl, '/api/provider-connections', 'POST', {
      display_name: 'projection-no-credential',
      base_url: CONNECTION_BASE_URL,
    }) as { connection: unknown }).connection,
  );
  assert.equal(bare.credential_protection, null);
  assert.equal(bare.credential_status, null);
});

void test('连接文件不持久化凭证投影字段（凭证存储是唯一 owner）', async (t) => {
  const storageRoot = withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  const created = ProviderConnectionSchema.parse(
    (await call(baseUrl, '/api/provider-connections', 'POST', {
      display_name: 'projection-persist',
      base_url: CONNECTION_BASE_URL,
    }) as { connection: unknown }).connection,
  );
  await call(baseUrl, `/api/provider-connections/${created.connection_id}/credential`, 'PUT', {
    value: PLAINTEXT_VALUE,
  });

  const filePath = path.join(storageRoot, 'config', 'provider-connections.json');
  const raw = fs.readFileSync(filePath, 'utf-8');
  assert.equal(raw.includes('credential_protection'), false, '连接文件不得持久化 credential_protection');
  assert.equal(raw.includes('credential_status'), false, '连接文件不得持久化 credential_status');
});
