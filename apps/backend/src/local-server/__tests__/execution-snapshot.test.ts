import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ExecutionSnapshotSchema, buildAdapterAuthInjection, type ExecutionSnapshot } from '@iart/contracts';
import { buildExecutionSnapshot } from '../provider-connection/execution-snapshot.cts';
import { resolveSnapshotProtocol } from '../provider-connection/snapshot-protocol.cts';
import {
  clearCacheForTest as clearConnectionCache,
  createConnection,
  setConnectionCredential,
} from '../provider-connection/connection-store.cts';
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
  removeCustomGenerationModel,
} from '../provider-connection/custom-generation-model-store.cts';
import { setCredentialForConnection } from '../provider-connection/credential-store.cts';

/**
 * ExecutionSnapshot 直测（spec 03 §8 / spec 45 §5.2）。
 *
 * 协议归属模型级（2026-09-26）且连接级接口类型预选已退役（2026-09-29）：快照的协议身份
 * 唯一来源是 `access.protocol_adapter_id`（模型记录自带的协议字段），不再回落连接，也不按
 * `model_id` 名称或正则推断（2026-10-19 部署载体退场后，唯一能给出协议的就是记录本身）。
 * 2026-10-27 起协议身份写进 `protocol` 判别联合（生成 = 接口格式 id + 冻结鉴权形状），两族各自断言：
 * ① 对话记录：`protocol_adapter_id`（openai-chat-completions-v1）→ 快照必须用它；
 * ② 生成记录：`family_adapter_id`（openai-image-v1）生效。
 * 显式失败：快照无法解析出记录 → ok:false 且带原因码（不静默放行）。
 * 另有用例覆盖「连接文件里残留遗留 protocol_adapter_id 不得被当作协议来源」。
 */


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

/**
 * 快照冻结的生成侧协议 id（2026-10-27 起协议身份在 `protocol` 判别联合里，
 * 不再写 `adapter_id`；旧快照的回退读取由 snapshot-protocol 单测覆盖）。
 */
const frozenFormatId = (snapshot: ExecutionSnapshot): string | undefined => {
  const protocol = snapshot.protocol;
  return protocol !== undefined && protocol.kind === 'generation_format'
    ? protocol.format_id
    : undefined;
};

/** 快照冻结的对话协议适配器 id。 */
const frozenChatAdapterId = (snapshot: ExecutionSnapshot): string | undefined => {
  const protocol = snapshot.protocol;
  return protocol !== undefined && protocol.kind === 'chat_adapter' ? protocol.adapter_id : undefined;
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
  assert.equal(frozenChatAdapterId(result.snapshot), 'openai-chat-completions-v1', '协议随记录走（记录自带是唯一来源）');
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
  assert.equal(frozenFormatId(result.snapshot), 'openai-image-v1', '生成记录的 family_adapter_id 生效');
  assert.equal(result.snapshot.connection_id, connectionId);
});

void test('快照：active 指向的接入记录已不存在 → access_target_not_found', async (t) => {
  withIsolatedRoot(t);
  const connectionId = await seedConnection('snapshot-stale');

  const record = addCustomGenerationModel({
    model_id: 'stale-model',
    connection_id: connectionId,
    family_adapter_id: 'openai-image-v1',
    remote_model_id: 'remote-stale',
  });
  assert.equal(record.ok, true, 'generation model record should be created');
  if (!record.ok) return;
  assert.equal(setActiveDeployment('stale-model', record.model.record_id), record.model.record_id);

  // 构造「记录被删、active 路由还没来得及清理」的那一瞬：active 路由缓存里仍攥着这条映射
  // （删除记录时的级联清理由调用方编排，两者之间有真实的竞态窗口）。
  assert.equal(removeCustomGenerationModel('stale-model'), true);

  const result = buildExecutionSnapshot({ modelId: 'stale-model' });
  assert.equal(result.ok, false, `snapshot should fail: ${result.ok ? result.snapshot.snapshot_id : result.message}`);
  if (result.ok) return;
  // 2026-10-19 由 deployment_not_found 改名：部署载体退场后，失败的语义是「接入目标不见了」，
  // 与「没有 active 接入目标」是两条可分辨的失败。
  assert.equal(result.code, 'access_target_not_found', `expected access_target_not_found, got ${result.code}`);
});

void test('快照：连接上的遗留 protocol_adapter_id 不作为协议来源——记录的协议字段才是唯一来源', async (t) => {
  const storageRoot = withIsolatedRoot(t);
  // 直接写带遗留键的连接 fixture（迁移兼容形状）：快照构建不得再读它当协议来源
  writeFixture(storageRoot, 'provider-connections.json', {
    version: 1,
    updatedAt: '2026-09-29T00:00:00.000Z',
    connections: [{
      connection_id: 'up_conn_snap_legacy_preselect',
      display_name: 'legacy-preselect-connection',
      // 遗留键写的是*对话*协议；下面记录的协议是*生成*族——若快照读了连接，就会拿对话适配器
      // 去发图像请求，adapter_id 断言随即红。
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

  const record = addCustomGenerationModel({
    model_id: 'snap-legacy-preselect-gen',
    connection_id: 'up_conn_snap_legacy_preselect',
    family_adapter_id: 'openai-image-v1',
    remote_model_id: 'remote-legacy-preselect',
  });
  assert.equal(record.ok, true, 'generation model record should be created');
  if (!record.ok) return;
  assert.equal(
    setActiveDeployment('snap-legacy-preselect-gen', record.model.record_id),
    record.model.record_id,
  );

  const result = buildExecutionSnapshot({ modelId: 'snap-legacy-preselect-gen' });
  assert.equal(result.ok, true, `snapshot should build: ${result.ok ? '' : result.message}`);
  if (!result.ok) return;
  assert.equal(
    frozenFormatId(result.snapshot),
    'openai-image-v1',
    '协议只从记录自带字段解析：连接上的遗留键既不作来源、也不作兜底',
  );
});

void test('快照：8 个接口格式各自冻结自己的提交端点作占位（旧值不变）', async (t) => {
  withIsolatedRoot(t);
  const connectionId = await seedConnection('snapshot-eight-formats');
  // 期望值来自旧实现逐族 if 链的取值（提交端点，而不是查询 / 内容端点）。
  for (const [familyAdapterId, expectedEndpoint] of [
    ['openai-image-v1', '/v1/images/generations'],
    ['openai-video-v1', '/v1/videos'],
    ['gemini-image-interactions-v1', '/v1beta/interactions'],
    ['seedance-2-0-v1', '/api/v3/contents/generations/tasks'],
    ['veo-v1', '/v1beta/models/{model}:predictLongRunning'],
    ['kling-text2video-v1', '/text-to-video/kling-3.0'],
    ['kling-image2video-v1', '/image-to-video/kling-3.0'],
    ['kling-omni-video-v1', '/omni-video/kling-3.0-omni'],
  ] as const) {
    const modelId = `snap-eight-${familyAdapterId}`;
    const record = addCustomGenerationModel({
      model_id: modelId,
      connection_id: connectionId,
      family_adapter_id: familyAdapterId,
      remote_model_id: 'remote-eight-formats',
    });
    assert.equal(record.ok, true, `${familyAdapterId} 记录应可创建`);
    if (!record.ok) continue;
    assert.equal(setActiveDeployment(modelId, record.model.record_id), record.model.record_id);

    const result = buildExecutionSnapshot({ modelId });
    assert.equal(result.ok, true, `snapshot should build: ${result.ok ? '' : result.message}`);
    if (!result.ok) continue;
    assert.equal(frozenFormatId(result.snapshot), familyAdapterId);
    assert.ok(
      result.snapshot.resolved_endpoint.endsWith(expectedEndpoint),
      `${familyAdapterId} 的快照端点应为提交端点 ${expectedEndpoint}，实际 ${result.snapshot.resolved_endpoint}`,
    );
  }
});

void test('快照：可灵三个适配器各自冻结自己的提交端点作占位', async (t) => {
  withIsolatedRoot(t);
  const connectionId = await seedConnection('snapshot-kling');
  for (const [modelId, familyAdapterId, expectedEndpoint] of [
    ['snap-kling-text', 'kling-text2video-v1', '/text-to-video/kling-3.0'],
    ['snap-kling-image', 'kling-image2video-v1', '/image-to-video/kling-3.0'],
    ['snap-kling-omni', 'kling-omni-video-v1', '/omni-video/kling-3.0-omni'],
  ] as const) {
    const record = addCustomGenerationModel({
      model_id: modelId,
      connection_id: connectionId,
      family_adapter_id: familyAdapterId,
      remote_model_id: 'kling-v3',
    });
    assert.equal(record.ok, true, `${familyAdapterId} 记录应可创建`);
    assert.equal(setActiveDeployment(modelId, record.model.record_id), record.model.record_id);

    const result = buildExecutionSnapshot({ modelId });
    assert.equal(result.ok, true, `snapshot should build: ${result.ok ? '' : result.message}`);
    if (!result.ok) return;
    assert.equal(frozenFormatId(result.snapshot), familyAdapterId);
    assert.ok(
      result.snapshot.resolved_endpoint.endsWith(expectedEndpoint),
      `${familyAdapterId} 的快照端点应为自己的提交端点，实际 ${result.snapshot.resolved_endpoint}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 历史快照回退（2026-10-27 快照契约新增 protocol 判别联合）
// ---------------------------------------------------------------------------

void test('旧快照回退：只有 adapter_id 的生成快照仍能解析出格式身份与鉴权形状', () => {
  const legacy = ExecutionSnapshotSchema.parse({
    snapshot_id: 'snap_legacy_generation',
    model_id: 'legacy-generation-model',
    model_version: '1.0.0',
    deployment_id: 'up_dep_legacy_generation',
    connection_id: 'up_conn_legacy_generation',
    connection_revision: 0,
    adapter_id: 'openai-image-v1',
    adapter_version: '1.0.0',
    base_url: 'https://legacy.example.invalid',
    remote_model_id: 'remote-legacy-image',
    resolved_endpoint: 'https://legacy.example.invalid/v1/images/generations',
    created_at: '2026-10-01T00:00:00.000Z',
  });
  const protocol = resolveSnapshotProtocol(legacy);
  assert.equal(protocol?.kind, 'generation_format', '历史生成快照按格式实体回退解析');
  if (protocol?.kind !== 'generation_format') return;
  assert.equal(protocol.format_id, 'openai-image-v1');
  assert.deepEqual(buildAdapterAuthInjection(protocol.auth, 'sk-legacy'), { kind: 'header', name: 'Authorization', value: 'Bearer sk-legacy' });
});

void test('旧快照回退：只有 adapter_id 的对话快照仍解析成对话适配器', () => {
  const legacy = ExecutionSnapshotSchema.parse({
    snapshot_id: 'snap_legacy_chat',
    model_id: 'legacy-chat-model',
    model_version: '1.0.0',
    deployment_id: 'up_dep_legacy_chat',
    connection_id: 'up_conn_legacy_chat',
    connection_revision: 0,
    adapter_id: 'anthropic-messages-v1',
    adapter_version: '1.0.0',
    base_url: 'https://legacy.example.invalid',
    remote_model_id: 'remote-legacy-chat',
    resolved_endpoint: 'https://legacy.example.invalid/v1/messages',
    created_at: '2026-10-01T00:00:00.000Z',
  });
  const protocol = resolveSnapshotProtocol(legacy);
  assert.equal(protocol?.kind, 'chat_adapter');
  if (protocol?.kind !== 'chat_adapter') return;
  assert.equal(protocol.adapter_id, 'anthropic-messages-v1');
  assert.deepEqual(buildAdapterAuthInjection(protocol.auth, 'sk-legacy'), { kind: 'header', name: 'x-api-key', value: 'sk-legacy' });
});

void test('既无 protocol 也无 adapter_id 的坏快照：解析为 null（调用方显式失败）', () => {
  const broken = ExecutionSnapshotSchema.parse({
    snapshot_id: 'snap_broken',
    model_id: 'broken-model',
    model_version: '1.0.0',
    deployment_id: 'up_dep_broken',
    connection_id: 'up_conn_broken',
    connection_revision: 0,
    base_url: 'https://legacy.example.invalid',
    remote_model_id: 'remote-broken',
    resolved_endpoint: 'https://legacy.example.invalid/v1/x',
    created_at: '2026-10-01T00:00:00.000Z',
  });
  assert.equal(resolveSnapshotProtocol(broken), null);
});
