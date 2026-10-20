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
import { listLegacyDeployments } from '../provider-connection/legacy-deployment-file.cts';
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
 * 迁移完成后旧接入文件里被并掉的条目移除（信息已并入声明记录）；
 * 无 deployment 的孤儿声明丢弃 + debug 留痕；v3 文件直接走正常路径（幂等）。
 */

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

  // —— 落盘：对话声明文件升级为 v3（协议归属模型级），生成侧同样升到 v3（素材位清单）——
  const chatFile = readJson(storageRoot, 'custom-chat-models.json') as { version: number; models: JsonValue[] };
  assert.equal(chatFile.version, 3);
  const generationFile = readJson(storageRoot, 'custom-generation-models.json') as { version: number; models: JsonValue[] };
  assert.equal(generationFile.version, 3);

  // —— 旧接入文件：自建链条目随声明合并移除；升级前添加过的预装模型迁成用户记录 ——
  const remainingIds = listLegacyDeployments().map((item) => item.deployment_id);
  assert.equal(remainingIds.includes(CHAT_DEPLOYMENT_ID), false, '自建链接入已并入记录并从旧文件移除');
  assert.equal(remainingIds.includes(GENERATION_DEPLOYMENT_ID), false);
  // 2026-10-19 原子换轨（spec 03 §11 / PC-15）：升级前用户添加过的预装模型在升级后以**用户记录**
  // 形态存在，model_id / connection_id / remote_model_id 逐值不变，record_id 继承原接入 id。
  // 本用例的 gpt-image-2 接入正是这一类：原断言「内置包接入不动」是双载体时代的旧口径。
  assert.equal(remainingIds.includes(INSTALLED_DEPLOYMENT_ID), false, '预装模型的接入同样迁成记录并移除');
  const installedRecord = getCustomGenerationModel(INSTALLED_MODEL_ID);
  assert.ok(installedRecord, '内置包模型必须迁成用户记录（模型来源唯一，PC-15）');
  assert.equal(installedRecord.record_id, INSTALLED_DEPLOYMENT_ID, 'record_id 继承 deployment_id');
  assert.equal(installedRecord.connection_id, INSTALLED_CONNECTION_ID, '所属服务商不变');
  assert.equal(installedRecord.remote_model_id, INSTALLED_MODEL_ID, '远端模型名不变');
  assert.equal(installedRecord.family_adapter_id, 'openai-image-v1', '族与升级前实际执行所用适配器一致');
  assert.deepEqual(installedRecord.accepted_media_slots, ['reference_image'], '素材位取自换算表');
  // 退役档位键确实被剥掉：若不剥，deployment 会整条解析失败被丢弃，记录就不会存在
  assert.ok(!('enabled_thinking_tiers' in installedRecord), '退役档位键不得进入记录');
  assert.ok(!('default_thinking_tier' in installedRecord), '退役档位键不得进入记录');
  const legacyFile = readJson(storageRoot, 'model-deployments.json') as { version: number; deployments: JsonValue[] };
  assert.equal(legacyFile.version, 2);
  assert.deepEqual(
    legacyFile.deployments.map((item) => item.deployment_id),
    [],
    '落盘的旧接入文件不再有任何条目（全部迁成记录）',
  );
  assert.deepEqual(listLegacyDeployments(), []);

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

  // 预装模型的接入已迁成记录（换轨一次性完成），重复加载不得把它变回旧载体、也不得重复迁一条。
  assert.equal(
    listLegacyDeployments().some((item) => item.deployment_id === INSTALLED_DEPLOYMENT_ID),
    false,
    '已迁移的预装模型接入不复活',
  );
  assert.equal(getCustomGenerationModel(INSTALLED_MODEL_ID)?.record_id, INSTALLED_DEPLOYMENT_ID);
  assert.equal(listLegacyDeployments().length, 0, '幂等重读后旧接入文件仍为空');
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

// ---------------------------------------------------------------------------
// v2 → v3 专项（2026-10-19 素材位清单）：记录剥掉旧布尔键、换算成 accepted_media_slots
// ---------------------------------------------------------------------------

/** 只建空存储根（不写 legacy fixture），供各专项用例自备 fixture。 */
const withBareIsolatedRoot = (t: test.TestContext): string => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-model-migration-'));
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

/** v2 生成记录（素材位扩容前的形状：能力字段是单个 supports_reference_image 布尔）。 */
const v2GenerationRecord = (
  modelId: string,
  recordId: string,
  supportsReferenceImage: boolean,
): Record<string, unknown> => ({
  model_id: modelId,
  record_id: recordId,
  connection_id: GENERATION_CONNECTION_ID,
  remote_model_id: `remote-${modelId}`,
  family_adapter_id: 'openai-image-v1',
  supports_reference_image: supportsReferenceImage,
  parameter_overrides: { official: [], custom: [] },
  created_at: '2026-10-01T00:00:00.000Z',
});

void test('迁移 v2→v3：true/false 两种旧记录各自换算成素材位清单，旧布尔键落盘后消失', async (t) => {
  const storageRoot = withBareIsolatedRoot(t);
  writeJson(storageRoot, 'custom-generation-models.json', {
    version: 2,
    updatedAt: '2026-10-01T00:00:00.000Z',
    models: [
      v2GenerationRecord('v2-gen-with-ref', 'up_dep_v2_gen_ref', true),
      v2GenerationRecord('v2-gen-t2i', 'up_dep_v2_gen_t2i', false),
    ],
  });
  clearAllCaches();

  const records = listCustomGenerationModels();
  assert.equal(records.length, 2, '两条 v2 记录都必须迁移成功（剥键后不被 strict schema 丢弃）');

  const withReference = records.find((item) => item.model_id === 'v2-gen-with-ref');
  assert.ok(withReference, 'supports_reference_image=true 的记录必须存活');
  assert.deepEqual(withReference.accepted_media_slots, ['reference_image'], 'true 换算成参考图素材位');
  assert.equal(withReference.record_id, 'up_dep_v2_gen_ref', '其余字段原样保留');
  assert.equal(withReference.remote_model_id, 'remote-v2-gen-with-ref');

  const t2iOnly = records.find((item) => item.model_id === 'v2-gen-t2i');
  assert.ok(t2iOnly, 'supports_reference_image=false 的记录必须存活');
  assert.deepEqual(t2iOnly.accepted_media_slots, [], 'false 换算成空素材位清单');

  // 落盘：文件升 v3，旧布尔键不再残留（残留会让下次读取整条失败）
  const generationFile = readJson(storageRoot, 'custom-generation-models.json') as {
    version: number;
    models: Array<Record<string, unknown>>;
  };
  assert.equal(generationFile.version, 3);
  for (const record of generationFile.models) {
    assert.ok(!('supports_reference_image' in record), '旧布尔键必须被剥掉');
    assert.ok(Array.isArray(record['accepted_media_slots']), '新字段必须落盘');
  }

  // 幂等：清缓存重读（文件已是 v3）结果一致
  clearAllCaches();
  const again = listCustomGenerationModels();
  assert.deepEqual(
    again.map((item) => [item.model_id, item.accepted_media_slots]),
    [
      ['v2-gen-with-ref', ['reference_image']],
      ['v2-gen-t2i', []],
    ],
  );
});

void test('迁移 v1→v3：带旧布尔的 v1 声明与 deployment 合并时一并换算素材位', async (t) => {
  const storageRoot = withBareIsolatedRoot(t);
  writeConnectionsFixture(storageRoot);
  writeJson(storageRoot, 'custom-generation-models.json', {
    version: 1,
    updatedAt: '2026-09-20T00:00:00.000Z',
    models: [
      {
        model_id: 'v1-gen-with-ref',
        family_adapter_id: 'openai-image-v1',
        supports_reference_image: true,
        created_at: '2026-09-20T00:00:00.000Z',
      },
      {
        model_id: 'v1-gen-t2i',
        family_adapter_id: 'openai-image-v1',
        created_at: '2026-09-20T00:00:00.000Z',
      },
    ],
  });
  writeJson(storageRoot, 'model-deployments.json', {
    version: 2,
    updatedAt: '2026-09-20T00:00:00.000Z',
    deployments: [
      {
        deployment_id: 'up_dep_v1_gen_ref_01',
        model_id: 'v1-gen-with-ref',
        connection_id: GENERATION_CONNECTION_ID,
        remote_model_id: 'remote-v1-gen-with-ref',
        created_at: '2026-09-20T01:00:00.000Z',
        updated_at: '2026-09-20T01:00:00.000Z',
      },
      {
        deployment_id: 'up_dep_v1_gen_t2i_01',
        model_id: 'v1-gen-t2i',
        connection_id: GENERATION_CONNECTION_ID,
        remote_model_id: 'remote-v1-gen-t2i',
        created_at: '2026-09-20T01:00:00.000Z',
        updated_at: '2026-09-20T01:00:00.000Z',
      },
    ],
  });
  clearAllCaches();

  const records = listCustomGenerationModels();
  const withReference = records.find((item) => item.model_id === 'v1-gen-with-ref');
  assert.ok(withReference, 'v1 带参考图的声明必须合成记录');
  assert.deepEqual(withReference.accepted_media_slots, ['reference_image']);
  assert.equal(withReference.record_id, 'up_dep_v1_gen_ref_01', 'record_id 继承 deployment_id');

  const t2iOnly = records.find((item) => item.model_id === 'v1-gen-t2i');
  assert.ok(t2iOnly, 'v1 仅有文生图的声明必须合成记录（缺旧布尔键 = false 语义）');
  assert.deepEqual(t2iOnly.accepted_media_slots, []);

  const generationFile = readJson(storageRoot, 'custom-generation-models.json') as {
    version: number;
    models: Array<Record<string, unknown>>;
  };
  assert.equal(generationFile.version, 3);
  for (const record of generationFile.models) {
    assert.ok(!('supports_reference_image' in record), '迁移产物不得带旧布尔键');
  }
});
