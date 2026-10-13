import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getActiveDeploymentId, clearCacheForTest as clearActiveRouteCache } from '../provider-connection/active-route-store.cts';
import {
  clearCacheForTest as clearConnectionCache,
  getConnection,
} from '../provider-connection/connection-store.cts';
import {
  clearCacheForTest as clearDeploymentCache,
  getDeployment,
  listDeployments,
} from '../provider-connection/deployment-store.cts';
import {
  clearCacheForTest as clearCustomChatModelCache,
  getCustomChatModel,
  listCustomChatModels,
} from '../provider-connection/custom-chat-model-store.cts';
import {
  clearCacheForTest as clearCustomGenerationModelCache,
  getCustomGenerationModel,
  listCustomGenerationModels,
} from '../provider-connection/custom-generation-model-store.cts';

/**
 * 自建模型声明存量迁移（spec 03 §6.1「Deployment 与自建模型记录」）。
 *
 * v1 → v3（2026-09-25 单记录合并 + 2026-09-26 协议归属模型级）：迁移顺序是关键——
 * deployment 数据先就绪（deployment store 剥离已退役的档位键），每条 v1 声明从
 * model-deployments 反查该 model_id 的 deployment 合成记录——record_id 继承该
 * deployment 的 deployment_id（active-routes.json 因此零改动）、connection_id/remote_model_id
 * 取自该 deployment、能力字段原样保留、思考档位随自建对话记录走；协议归属模型级起对话
 * 记录还须自带 `protocol_adapter_id`，从 deployment 归属连接的协议回填（v1 时代协议
 * 事实源在连接上），连接缺失或协议非对话族的声明按孤儿丢弃。
 *
 * v2 → v3：存量 v2 记录（无 protocol_adapter_id 字段）逐条从归属连接回填协议后升 v3 落盘；
 * 连接缺失或协议非对话族的记录按孤儿丢弃并留痕（详见文件尾部的 v2 专项用例）。
 *
 * 迁移完成后 deployment store 中自建链记录移除（信息已并入声明记录；内置包 deployment 不动）；
 * 无 deployment 的孤儿声明丢弃 + debug 留痕；v3 文件直接走正常路径（幂等）。
 */

process.env['IART_MODEL_ASSET_PACKAGES_DIR'] = path.join(
  __dirname, '..', '..', '..', '..', '..', '.model-assets', 'sources',
);
process.env['IART_LOG_LEVEL'] = 'debug';

const CHAT_MODEL_ID = 'legacy-llm';
const GENERATION_MODEL_ID = 'legacy-image-model';
const ORPHAN_CHAT_MODEL_ID = 'orphan-llm';
const INSTALLED_MODEL_ID = 'gpt-image-2';

const CHAT_DEPLOYMENT_ID = 'up_dep_legacy_chat_01';
const GENERATION_DEPLOYMENT_ID = 'up_dep_legacy_gen_01';
const INSTALLED_DEPLOYMENT_ID = 'up_dep_legacy_builtin_01';
const CHAT_CONNECTION_ID = 'up_conn_legacy_chat';
const GENERATION_CONNECTION_ID = 'up_conn_legacy_gen';
const INSTALLED_CONNECTION_ID = 'up_conn_legacy_builtin';
/** v1 时代协议事实源在连接上：对话声明归属对话协议连接，迁移据此回填记录自带协议。 */
const CHAT_CONNECTION_PROTOCOL = 'openai-chat-completions-v1';

type JsonValue = Record<string, unknown>;

const readJson = (storageRoot: string, filename: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(storageRoot, 'config', filename), 'utf-8'));

const writeJson = (storageRoot: string, filename: string, value: unknown): void => {
  fs.mkdirSync(path.join(storageRoot, 'config'), { recursive: true });
  fs.writeFileSync(path.join(storageRoot, 'config', filename), JSON.stringify(value, null, 2), 'utf-8');
};

const clearAllCaches = (): void => {
  clearConnectionCache();
  clearDeploymentCache();
  clearActiveRouteCache();
  clearCustomChatModelCache();
  clearCustomGenerationModelCache();
};

/** 服务商连接 fixture（v1 时代形状：协议在连接上）。 */
const writeConnectionsFixture = (storageRoot: string): void => {
  writeJson(storageRoot, 'provider-connections.json', {
    version: 1,
    updatedAt: '2026-09-20T00:00:00.000Z',
    connections: [
      {
        connection_id: CHAT_CONNECTION_ID,
        display_name: 'legacy-chat-provider',
        protocol_adapter_id: CHAT_CONNECTION_PROTOCOL,
        base_url: 'https://legacy-chat.example.invalid/v1',
        has_credential: true,
        lifecycle: 'enabled',
        revision: 0,
        created_at: '2026-09-19T00:00:00.000Z',
        updated_at: '2026-09-19T00:00:00.000Z',
      },
      {
        connection_id: GENERATION_CONNECTION_ID,
        display_name: 'legacy-generation-provider',
        protocol_adapter_id: 'openai-image-v1',
        base_url: 'https://legacy-gen.example.invalid/v1',
        has_credential: true,
        lifecycle: 'enabled',
        revision: 0,
        created_at: '2026-09-19T00:00:00.000Z',
        updated_at: '2026-09-19T00:00:00.000Z',
      },
      {
        connection_id: INSTALLED_CONNECTION_ID,
        display_name: 'legacy-builtin-provider',
        protocol_adapter_id: 'openai-image-v1',
        base_url: 'https://legacy-builtin.example.invalid/v1',
        has_credential: true,
        lifecycle: 'enabled',
        revision: 0,
        created_at: '2026-09-19T00:00:00.000Z',
        updated_at: '2026-09-19T00:00:00.000Z',
      },
    ],
  });
};

/** v1 存量 fixture：两份声明文件（version 1）+ 带档位键的接入 + 连接 + active 路由。 */
const writeLegacyFixture = (storageRoot: string): void => {
  writeConnectionsFixture(storageRoot);
  writeJson(storageRoot, 'custom-chat-models.json', {
    version: 1,
    updatedAt: '2026-09-20T00:00:00.000Z',
    models: [
      { model_id: CHAT_MODEL_ID, context_window_tokens: 64000, max_output_tokens: 4096, created_at: '2026-09-20T00:00:00.000Z' },
      { model_id: ORPHAN_CHAT_MODEL_ID, context_window_tokens: 8192, created_at: '2026-09-20T00:00:00.000Z' },
    ],
  });
  writeJson(storageRoot, 'custom-generation-models.json', {
    version: 1,
    updatedAt: '2026-09-20T00:00:00.000Z',
    models: [
      { model_id: GENERATION_MODEL_ID, family_adapter_id: 'openai-image-v1', created_at: '2026-09-20T00:00:00.000Z' },
    ],
  });
  writeJson(storageRoot, 'model-deployments.json', {
    version: 1,
    updatedAt: '2026-09-20T00:00:00.000Z',
    deployments: [
      {
        deployment_id: CHAT_DEPLOYMENT_ID,
        model_id: CHAT_MODEL_ID,
        connection_id: CHAT_CONNECTION_ID,
        remote_model_id: 'remote-legacy-llm',
        enabled_thinking_tiers: ['low', 'high'],
        default_thinking_tier: 'low',
        created_at: '2026-09-20T01:00:00.000Z',
        updated_at: '2026-09-20T01:00:00.000Z',
      },
      {
        deployment_id: GENERATION_DEPLOYMENT_ID,
        model_id: GENERATION_MODEL_ID,
        connection_id: GENERATION_CONNECTION_ID,
        remote_model_id: 'remote-legacy-image',
        enabled_thinking_tiers: [],
        default_thinking_tier: null,
        created_at: '2026-09-20T01:00:00.000Z',
        updated_at: '2026-09-20T01:00:00.000Z',
      },
      {
        // 内置包接入：带历史档位键（legacy），迁移后必须原样保留（档位键剥掉、记录不丢）
        deployment_id: INSTALLED_DEPLOYMENT_ID,
        model_id: INSTALLED_MODEL_ID,
        connection_id: INSTALLED_CONNECTION_ID,
        remote_model_id: INSTALLED_MODEL_ID,
        enabled_thinking_tiers: [],
        default_thinking_tier: null,
        created_at: '2026-09-20T02:00:00.000Z',
        updated_at: '2026-09-20T02:00:00.000Z',
      },
    ],
  });
  writeJson(storageRoot, 'active-routes.json', {
    version: 1,
    updatedAt: '2026-09-20T00:00:00.000Z',
    activeRoutes: {
      [CHAT_MODEL_ID]: CHAT_DEPLOYMENT_ID,
      [GENERATION_MODEL_ID]: GENERATION_DEPLOYMENT_ID,
    },
  });
};

const withIsolatedRoot = (t: test.TestContext): string => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-model-migration-'));
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  process.env['IART_STORAGE_ROOT'] = storageRoot;
  clearAllCaches();
  writeLegacyFixture(storageRoot);
  t.after(() => {
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    clearAllCaches();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });
  return storageRoot;
};

void test('迁移：v1 声明 + 接入合成 v3 单记录，record_id 继承 deployment id，协议从归属连接回填，active route 零改动', async (t) => {
  const storageRoot = withIsolatedRoot(t);

  // 首次触达声明 store：此时 deployment store 先行就绪（剥档位键），再按 model_id 反查合成。
  const chatModels = listCustomChatModels();
  const generationModels = listCustomGenerationModels();

  // —— 对话记录：能力原样保留 + 接入归属来自 deployment + 协议从归属连接回填 + 档位随记录走 ——
  const chatRecord = chatModels.find((item) => item.model_id === CHAT_MODEL_ID);
  assert.ok(chatRecord, '有接入的 v1 对话声明必须合成记录');
  assert.equal(chatRecord.record_id, CHAT_DEPLOYMENT_ID, 'record_id 继承 deployment_id');
  assert.equal(chatRecord.connection_id, CHAT_CONNECTION_ID);
  assert.equal(chatRecord.remote_model_id, 'remote-legacy-llm');
  assert.equal(chatRecord.protocol_adapter_id, CHAT_CONNECTION_PROTOCOL, '协议从 deployment 归属连接回填（协议归属模型级）');
  assert.equal(chatRecord.context_window_tokens, 64000);
  assert.equal(chatRecord.max_output_tokens, 4096);
  assert.deepEqual(chatRecord.enabled_thinking_tiers, ['low', 'high'], '档位随自建对话记录走');
  assert.equal(chatRecord.default_thinking_tier, 'low');
  assert.equal(chatRecord.created_at, '2026-09-20T00:00:00.000Z', 'created_at 取声明');

  // —— 孤儿声明：无 deployment 反查命中 → 丢弃 ——
  assert.equal(
    chatModels.some((item) => item.model_id === ORPHAN_CHAT_MODEL_ID),
    false,
    '无 deployment 的孤儿声明被丢弃（新口径下无归属模型非法）',
  );

  // —— 生成记录：record_id / connection_id / remote_model_id 来自 deployment ——
  const generationRecord = generationModels.find((item) => item.model_id === GENERATION_MODEL_ID);
  assert.ok(generationRecord, '有接入的 v1 生成声明必须合成记录');
  assert.equal(generationRecord.record_id, GENERATION_DEPLOYMENT_ID);
  assert.equal(generationRecord.connection_id, GENERATION_CONNECTION_ID);
  assert.equal(generationRecord.remote_model_id, 'remote-legacy-image');
  assert.equal(generationRecord.family_adapter_id, 'openai-image-v1');

  // —— 落盘：对话声明文件直接升级为 v3（协议归属模型级），生成侧仍 v2 ——
  const chatFile = readJson(storageRoot, 'custom-chat-models.json') as { version: number; models: JsonValue[] };
  assert.equal(chatFile.version, 3);
  const generationFile = readJson(storageRoot, 'custom-generation-models.json') as { version: number; models: JsonValue[] };
  assert.equal(generationFile.version, 2);

  // —— deployment store：自建链记录移除，内置包接入保留且档位键被剥掉 ——
  assert.equal(getDeployment(CHAT_DEPLOYMENT_ID), null, '自建链 deployment 已并入记录并移除');
  assert.equal(getDeployment(GENERATION_DEPLOYMENT_ID), null);
  const installed = getDeployment(INSTALLED_DEPLOYMENT_ID);
  assert.ok(installed, '内置包 deployment 不动');
  assert.ok(!('enabled_thinking_tiers' in installed), '退役档位键已剥离');
  assert.ok(!('default_thinking_tier' in installed), '退役档位键已剥离');
  const deploymentsFile = readJson(storageRoot, 'model-deployments.json') as { version: number; deployments: JsonValue[] };
  assert.equal(deploymentsFile.version, 2);
  assert.deepEqual(
    deploymentsFile.deployments.map((deployment) => deployment.deployment_id),
    [INSTALLED_DEPLOYMENT_ID],
    '落盘的 deployment 文件只保留内置包接入',
  );
  assert.deepEqual(
    listDeployments().map((deployment) => deployment.model_id),
    [INSTALLED_MODEL_ID],
  );

  // —— active route 零改动：同一 id 现在解析到自建记录 ——
  assert.equal(getActiveDeploymentId(CHAT_MODEL_ID), CHAT_DEPLOYMENT_ID);
  assert.equal(getActiveDeploymentId(GENERATION_MODEL_ID), GENERATION_DEPLOYMENT_ID);

  // —— 孤儿丢弃留痕（debug 日志）——
  const logText = fs.readFileSync(path.join(storageRoot, 'logs', 'backend.log'), 'utf-8');
  assert.match(logText, /orphan.*declaration.*dropped|orphan-llm/i, '孤儿声明丢弃必须留痕');
});

void test('迁移幂等：v3 文件直接走正常路径，重复加载结果一致', async (t) => {
  const storageRoot = withIsolatedRoot(t);

  listCustomChatModels();
  listCustomGenerationModels();

  // 全量清缓存后重读：文件已是 v3，走正常路径，不重复迁移、不再丢数据。
  clearAllCaches();
  const chatAgain = listCustomChatModels();
  listCustomGenerationModels();

  assert.deepEqual(
    chatAgain.map((item) => item.model_id).sort(),
    [CHAT_MODEL_ID],
    '孤儿声明不复活，v3 记录稳定',
  );
  const chatRecord = getCustomChatModel(CHAT_MODEL_ID);
  assert.ok(chatRecord);
  assert.equal(chatRecord.record_id, CHAT_DEPLOYMENT_ID);
  assert.equal(chatRecord.protocol_adapter_id, CHAT_CONNECTION_PROTOCOL, '回填的协议在幂等重读后保持');
  assert.deepEqual(chatRecord.enabled_thinking_tiers, ['low', 'high']);

  const generationRecord = getCustomGenerationModel(GENERATION_MODEL_ID);
  assert.ok(generationRecord);
  assert.equal(generationRecord.record_id, GENERATION_DEPLOYMENT_ID);

  assert.equal(getDeployment(CHAT_DEPLOYMENT_ID), null);
  assert.equal(getDeployment(INSTALLED_DEPLOYMENT_ID)?.model_id, INSTALLED_MODEL_ID);
  assert.equal(getActiveDeploymentId(CHAT_MODEL_ID), CHAT_DEPLOYMENT_ID);

  // 再清一次缓存读盘：落盘内容与内存一致（幂等收敛）。
  clearAllCaches();
  const chatFile = readJson(storageRoot, 'custom-chat-models.json') as { version: number; models: JsonValue[] };
  assert.equal(chatFile.models.length, 1);
  assert.equal(getCustomChatModel(CHAT_MODEL_ID)?.record_id, CHAT_DEPLOYMENT_ID);
});

// ---------------------------------------------------------------------------
// v2 → v3 专项（2026-09-26 协议归属模型级）：存量 v2 记录从归属连接回填 protocol_adapter_id
// ---------------------------------------------------------------------------

/** v2 记录 fixture（协议归属模型级改造前的形状：记录无 protocol_adapter_id 字段）。 */
const writeV2ChatModelsFixture = (storageRoot: string, records: unknown[]): void => {
  writeConnectionsFixture(storageRoot);
  writeJson(storageRoot, 'custom-chat-models.json', {
    version: 2,
    updatedAt: '2026-09-24T00:00:00.000Z',
    models: records,
  });
};

/** 一条完整的 v2 对话记录（无 protocol_adapter_id；其余字段齐全）。 */
const v2Record = (modelId: string, recordId: string, connectionId: string): Record<string, unknown> => ({
  model_id: modelId,
  record_id: recordId,
  connection_id: connectionId,
  remote_model_id: `remote-${modelId}`,
  context_window_tokens: 32000,
  max_output_tokens: 4096,
  enabled_thinking_tiers: ['low'],
  default_thinking_tier: 'low',
  created_at: '2026-09-24T00:00:00.000Z',
});

void test('迁移 v2→v3：记录从归属连接回填 protocol_adapter_id，文件升 v3 落盘', async (t) => {
  const storageRoot = withIsolatedRoot(t);
  writeV2ChatModelsFixture(storageRoot, [v2Record('v2-llm', 'up_dep_v2_llm_01', CHAT_CONNECTION_ID)]);
  clearAllCaches();

  const chatModels = listCustomChatModels();

  const record = chatModels.find((item) => item.model_id === 'v2-llm');
  assert.ok(record, '归属连接存在且为对话协议的 v2 记录必须迁移成功');
  // 连接侧前提：带遗留 protocol_adapter_id 的连接必须照常读出（2026-09-29 起字段仅为
  // 迁移回填保留读取，读盘不得丢弃携带或缺少该字段的连接）
  const legacyConnection = getConnection(CHAT_CONNECTION_ID);
  assert.ok(legacyConnection, '带遗留 protocol_adapter_id 的连接照常读出，迁移才有回填来源');
  assert.equal(legacyConnection.protocol_adapter_id, CHAT_CONNECTION_PROTOCOL, '连接遗留键保持原值');
  assert.equal(record.protocol_adapter_id, CHAT_CONNECTION_PROTOCOL, 'protocol_adapter_id 等于归属连接的协议');
  assert.equal(record.record_id, 'up_dep_v2_llm_01', 'record_id 与其余字段原样保留');
  assert.equal(record.connection_id, CHAT_CONNECTION_ID);
  assert.deepEqual(record.enabled_thinking_tiers, ['low']);

  // 落盘：文件已升 v3，且记录带着回填的协议落库
  const chatFile = readJson(storageRoot, 'custom-chat-models.json') as {
    version: number;
    models: Array<{ model_id: string; protocol_adapter_id?: string }>;
  };
  assert.equal(chatFile.version, 3);
  const onDisk = chatFile.models.find((item) => item.model_id === 'v2-llm');
  assert.ok(onDisk);
  assert.equal(onDisk.protocol_adapter_id, CHAT_CONNECTION_PROTOCOL, '回填的协议随 v3 落盘');
});

void test('迁移 v2→v3：归属连接不存在的记录按孤儿丢弃并留痕', async (t) => {
  const storageRoot = withIsolatedRoot(t);
  writeV2ChatModelsFixture(storageRoot, [v2Record('v2-orphan-llm', 'up_dep_v2_orphan_01', 'up_conn_vanished')]);
  clearAllCaches();

  const chatModels = listCustomChatModels();
  assert.deepEqual(
    chatModels.filter((item) => item.model_id === 'v2-orphan-llm'),
    [],
    '连接缺失的 v2 记录按孤儿丢弃',
  );

  // 丢弃留痕（debug 日志），排查时链路可见
  const logText = fs.readFileSync(path.join(storageRoot, 'logs', 'backend.log'), 'utf-8');
  assert.match(logText, /migrate v2: record connection missing or not chat protocol, dropped/, '孤儿丢弃必须留痕');
  assert.match(logText, /v2-orphan-llm/, '留痕须指认被丢的记录');
});

void test('迁移 v2→v3：连接协议是生成族适配器时记录同样被丢弃（回填确实读取连接协议，非恒过）', async (t) => {
  const storageRoot = withIsolatedRoot(t);
  // 两条记录：一条挂对话协议连接（应存活），一条挂生成协议连接（应被丢）——
  // 同一次加载一活一死，证明丢弃判定真的在读连接的协议值，不是无条件放行或无条件丢弃。
  writeV2ChatModelsFixture(storageRoot, [
    v2Record('v2-llm-on-chat-conn', 'up_dep_v2_alive_01', CHAT_CONNECTION_ID),
    v2Record('v2-llm-on-generation-conn', 'up_dep_v2_dead_01', GENERATION_CONNECTION_ID),
  ]);
  clearAllCaches();

  const chatModels = listCustomChatModels();
  assert.ok(
    chatModels.some((item) => item.model_id === 'v2-llm-on-chat-conn'),
    '对话协议连接下的 v2 记录应存活',
  );
  assert.deepEqual(
    chatModels.filter((item) => item.model_id === 'v2-llm-on-generation-conn'),
    [],
    '生成协议连接下的 v2 记录应被丢弃（协议非对话族）',
  );

  const logText = fs.readFileSync(path.join(storageRoot, 'logs', 'backend.log'), 'utf-8');
  assert.match(logText, /v2-llm-on-generation-conn/, '生成族连接下的丢弃同样留痕');
});
