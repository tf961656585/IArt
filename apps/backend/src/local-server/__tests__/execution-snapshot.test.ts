import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildExecutionSnapshot } from '../provider-connection/execution-snapshot.cts';
import {
  clearCacheForTest as clearConnectionCache,
  createConnection,
  setConnectionCredential,
} from '../provider-connection/connection-store.cts';
import {
  clearCacheForTest as clearDeploymentCache,
  createDeployment,
} from '../provider-connection/deployment-store.cts';
import {
  clearCacheForTest as clearActiveRouteCache,
  setActiveDeployment,
} from '../provider-connection/active-route-store.cts';
import {
  addCustomChatModel,
  clearCacheForTest as clearCustomChatModelCache,
} from '../provider-connection/custom-chat-model-store.cts';
import {
  addCustomGenerationModel,
  clearCacheForTest as clearCustomGenerationModelCache,
} from '../provider-connection/custom-generation-model-store.cts';
import { setCredentialForConnection } from '../provider-connection/credential-store.cts';

/**
 * ExecutionSnapshot 直测（spec 03 §8 / spec 45 §5.2）。
 *
 * 协议归属模型级（2026-09-26）且连接级接口类型预选已退役（2026-09-29）：快照的 adapter
 * 唯一来源是 `access.protocol_adapter_id`（模型记录自带 / 已装包按 model_id 封闭族正则表
 * 回填），不再回落连接。三类来源各自断言 snapshot.adapter_id：
 * ① 自建对话记录：记录协议 openai-chat-completions-v1 → 快照必须用它；
 * ② 自建生成记录：family_adapter_id（openai-image-v1）生效；
 * ③ 已装包 deployment：gpt-image-2 命中封闭族正则表 → openai-image-v1。
 * 显式失败：deployment 正则未命中且记录无协议 → ok:false, code adapter_not_found——
 * 即使连接文件里还残留遗留 protocol_adapter_id（迁移兼容保留），也不得再被当作协议来源。
 */

process.env['IART_MODEL_ASSET_PACKAGES_DIR'] = path.join(
  __dirname, '..', '..', '..', '..', '..', '.model-assets', 'sources',
);

const CONNECTION_BASE_URL = 'https://snapshot.example.invalid/v1';
const CREDENTIAL_VALUE = 'sk-execution-snapshot-key';

const withIsolatedRoot = (t: test.TestContext): string => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-snapshot-'));
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  process.env['IART_STORAGE_ROOT'] = storageRoot;
  clearAllCaches();
  t.after(() => {
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    clearAllCaches();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });
  return storageRoot;
};

const clearAllCaches = (): void => {
  clearConnectionCache();
  clearDeploymentCache();
  clearActiveRouteCache();
  clearCustomChatModelCache();
  clearCustomGenerationModelCache();
};

/** 建 enabled 连接 + 凭证（连接不再承载接口类型，协议随模型记录走）。 */
const seedConnection = async (
  displayName: string,
): Promise<string> => {
  const connection = createConnection({
    display_name: displayName,
    base_url: CONNECTION_BASE_URL,
  });
  const credential = await setCredentialForConnection(connection.connection_id, CREDENTIAL_VALUE);
  assert.ok(credential, 'credential should be stored');
  setConnectionCredential(connection.connection_id, credential.credentialRef, credential.version, true);
  return connection.connection_id;
};

const writeFixture = (storageRoot: string, filename: string, value: unknown): void => {
  const configDir = path.join(storageRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, filename), JSON.stringify(value, null, 2), 'utf-8');
};

void test('快照：自建对话记录——记录协议 openai-chat-completions-v1 是唯一来源', async (t) => {
  withIsolatedRoot(t);
  const connectionId = await seedConnection('snapshot-chat');

  const record = addCustomChatModel({
    model_id: 'snap-chat-llm',
    connection_id: connectionId,
    protocol_adapter_id: 'openai-chat-completions-v1',
    remote_model_id: 'remote-chat-upstream',
    context_window_tokens: 64000,
    max_output_tokens: 4096,
  });
  assert.equal(record.ok, true, 'custom chat model record should be created');
  assert.equal(setActiveDeployment('snap-chat-llm', record.model.record_id), record.model.record_id, 'active route should point at the seeded record');

  const result = buildExecutionSnapshot({ modelId: 'snap-chat-llm' });
  assert.equal(result.ok, true, `snapshot should build: ${result.ok ? '' : result.message}`);
  if (!result.ok) return;
  assert.equal(result.snapshot.adapter_id, 'openai-chat-completions-v1', '协议随记录走（记录自带是唯一来源）');
  assert.equal(result.snapshot.connection_id, connectionId);
  assert.equal(result.snapshot.remote_model_id, 'remote-chat-upstream');
  assert.equal(result.snapshot.deployment_id, record.model.record_id);
});

void test('快照：自建生成记录——family_adapter_id 生效', async (t) => {
  withIsolatedRoot(t);
  const connectionId = await seedConnection('snapshot-gen');

  const record = addCustomGenerationModel({
    model_id: 'snap-gen-image',
    connection_id: connectionId,
    family_adapter_id: 'openai-image-v1',
    remote_model_id: 'remote-gen-image',
  });
  assert.equal(record.ok, true, 'custom generation model record should be created');
  assert.equal(setActiveDeployment('snap-gen-image', record.model.record_id), record.model.record_id, 'active route should point at the seeded record');

  const result = buildExecutionSnapshot({ modelId: 'snap-gen-image' });
  assert.equal(result.ok, true, `snapshot should build: ${result.ok ? '' : result.message}`);
  if (!result.ok) return;
  assert.equal(result.snapshot.adapter_id, 'openai-image-v1', '生成记录的 family_adapter_id 生效');
  assert.equal(result.snapshot.connection_id, connectionId);
});

void test('快照：已装包 deployment——gpt-image-2 命中正则 → openai-image-v1', async (t) => {
  withIsolatedRoot(t);
  const connectionId = await seedConnection('snapshot-builtin');

  const deployment = createDeployment({
    model_id: 'gpt-image-2',
    connection_id: connectionId,
    remote_model_id: 'gpt-image-2',
  });
  assert.equal(setActiveDeployment('gpt-image-2', deployment.deployment_id), deployment.deployment_id, 'active route should point at the seeded deployment');

  const result = buildExecutionSnapshot({ modelId: 'gpt-image-2' });
  assert.equal(result.ok, true, `snapshot should build: ${result.ok ? '' : result.message}`);
  if (!result.ok) return;
  assert.equal(result.snapshot.adapter_id, 'openai-image-v1', 'gpt-image-2 命中封闭族正则表 → openai-image-v1');
  assert.equal(result.snapshot.connection_id, connectionId);
  assert.equal(result.snapshot.remote_model_id, 'gpt-image-2');
  assert.equal(result.snapshot.deployment_id, deployment.deployment_id);
});

/** 播种「无族模型」deployment + active route（写入侧会拒绝无族 model_id，故直接写 fixture）。 */
const seedNoFamilyDeployment = (storageRoot: string, connectionId: string): void => {
  writeFixture(storageRoot, 'model-deployments.json', {
    version: 2,
    updatedAt: '2026-09-29T00:00:00.000Z',
    deployments: [{
      deployment_id: 'up_dep_snap_nofamily_01',
      model_id: 'no-family-model',
      connection_id: connectionId,
      remote_model_id: 'remote-no-family',
      created_at: '2026-09-29T00:00:00.000Z',
      updated_at: '2026-09-29T00:00:00.000Z',
    }],
  });
  writeFixture(storageRoot, 'active-routes.json', {
    version: 1,
    updatedAt: '2026-09-29T00:00:00.000Z',
    activeRoutes: {
      'no-family-model': 'up_dep_snap_nofamily_01',
    },
  });
  // 缓存要清掉，让 store 重新从磁盘读 fixture
  clearDeploymentCache();
  clearActiveRouteCache();
};

void test('快照：deployment 正则未命中且记录无协议 → adapter_not_found', async (t) => {
  const storageRoot = withIsolatedRoot(t);
  const connectionId = await seedConnection('snapshot-nofamily');

  seedNoFamilyDeployment(storageRoot, connectionId);

  const result = buildExecutionSnapshot({ modelId: 'no-family-model' });
  assert.equal(result.ok, false, `snapshot should fail: ${result.ok ? result.snapshot.adapter_id : result.message}`);
  if (result.ok) return;
  assert.equal(result.code, 'adapter_not_found', `expected adapter_not_found, got ${result.code}`);
});

void test('快照：连接遗留 protocol_adapter_id 不再作为协议来源——正则未命中且记录无协议仍显式失败', async (t) => {
  const storageRoot = withIsolatedRoot(t);
  // 直接写带遗留键的连接 fixture（迁移兼容形状）：快照构建不得再读它当协议来源
  writeFixture(storageRoot, 'provider-connections.json', {
    version: 1,
    updatedAt: '2026-09-29T00:00:00.000Z',
    connections: [{
      connection_id: 'up_conn_snap_legacy_preselect',
      display_name: 'legacy-preselect-connection',
      protocol_adapter_id: 'openai-chat-completions-v1',
      base_url: CONNECTION_BASE_URL,
      has_credential: true,
      credential_ref: 'cred_ref_snapshot_legacy',
      credential_version: 1,
      lifecycle: 'enabled',
      revision: 0,
      created_at: '2026-09-29T00:00:00.000Z',
      updated_at: '2026-09-29T00:00:00.000Z',
    }],
  });
  clearConnectionCache();
  // 凭证：快照要求 has_credential + credential_ref 可解析，种一条真实凭证让判定走到协议步
  const credential = await setCredentialForConnection('up_conn_snap_legacy_preselect', CREDENTIAL_VALUE);
  assert.ok(credential, 'credential should be stored');
  setConnectionCredential('up_conn_snap_legacy_preselect', credential.credentialRef, credential.version, true);

  seedNoFamilyDeployment(storageRoot, 'up_conn_snap_legacy_preselect');

  const result = buildExecutionSnapshot({ modelId: 'no-family-model' });
  assert.equal(result.ok, false, `snapshot should fail: ${result.ok ? result.snapshot.adapter_id : result.message}`);
  if (result.ok) return;
  assert.equal(result.code, 'adapter_not_found', `expected adapter_not_found, got ${result.code}`);
});
