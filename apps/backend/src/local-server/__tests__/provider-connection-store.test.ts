import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  clearCacheForTest,
  getConnection,
  listConnections,
} from '../provider-connection/connection-store.cts';

/**
 * ProviderConnection 持久化读盘语义（spec 03 §4）。
 *
 * 连接级 `protocol_adapter_id`（默认接口类型预选）退役：2026-09-29 起连接不再承载接口类型，
 * 接口类型只在「添加模型」时随模型记录配置。读盘不得因连接缺少（或携带遗留）
 * `protocol_adapter_id` 而丢弃整条连接——旧的丢弃守卫会把没有该字段的连接整条丢掉，
 * 是现存活缺陷（新口径创建的连接天然无该字段，会被读盘整条吞掉）。
 */

const CONNECTION_BASE_URL = 'https://store.example.invalid/v1';

const withIsolatedRoot = (t: test.TestContext): string => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'connection-store-'));
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  process.env['IART_STORAGE_ROOT'] = storageRoot;
  clearCacheForTest();
  t.after(() => {
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    clearCacheForTest();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });
  return storageRoot;
};

const writeConnectionsFixture = (storageRoot: string, connections: unknown[]): void => {
  fs.mkdirSync(path.join(storageRoot, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(storageRoot, 'config', 'provider-connections.json'),
    JSON.stringify({ version: 1, updatedAt: '2026-09-29T00:00:00.000Z', connections }, null, 2),
    'utf-8',
  );
};

const baseConnection = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  connection_id: 'up_conn_store_no_proto',
  display_name: 'no-preselect-connection',
  base_url: CONNECTION_BASE_URL,
  has_credential: false,
  lifecycle: 'enabled',
  revision: 0,
  created_at: '2026-09-29T00:00:00.000Z',
  updated_at: '2026-09-29T00:00:00.000Z',
  ...overrides,
});

void test('读盘：没有 protocol_adapter_id 的连接不得被丢弃（连接不再承载接口类型）', (t) => {
  const storageRoot = withIsolatedRoot(t);
  writeConnectionsFixture(storageRoot, [baseConnection()]);

  const connection = getConnection('up_conn_store_no_proto');
  assert.ok(connection, '缺少 protocol_adapter_id 的连接必须照常读出，不得整条丢弃');
  assert.equal(connection.display_name, 'no-preselect-connection');
  assert.equal(connection.protocol_adapter_id, undefined);
  assert.equal(listConnections().length, 1);
});

void test('读盘：携带遗留 protocol_adapter_id 的连接（存量迁移数据）照常读出', (t) => {
  const storageRoot = withIsolatedRoot(t);
  writeConnectionsFixture(storageRoot, [
    baseConnection({
      connection_id: 'up_conn_store_legacy',
      display_name: 'legacy-preselect-connection',
      protocol_adapter_id: 'openai-image-v1',
    }),
  ]);

  const connection = getConnection('up_conn_store_legacy');
  assert.ok(connection, '带遗留 protocol_adapter_id 的连接必须照常读出（迁移兼容，字段保留读取）');
  assert.equal(connection.protocol_adapter_id, 'openai-image-v1', '遗留键保持原值，供存量迁移回填读取');
});
