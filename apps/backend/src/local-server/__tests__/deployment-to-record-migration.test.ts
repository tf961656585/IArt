import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ADAPTER_REGISTRY,
  GENERATION_FAMILY_ADAPTER_IDS,
  GENERATION_MEDIA_SLOT_IDS,
} from '@iart/contracts';
import {
  clearCacheForTest as clearActiveRouteCache,
  getActiveDeploymentId,
  resolveActiveTarget,
} from '../provider-connection/active-route-store.cts';
import { clearCacheForTest as clearConnectionCache } from '../provider-connection/connection-store.cts';
import { listLegacyDeployments } from '../provider-connection/legacy-deployment-file.cts';
import {
  clearCacheForTest as clearCustomGenerationModelCache,
  getCustomGenerationModel,
  listCustomGenerationModels,
} from '../provider-connection/custom-generation-model-store.cts';
import { buildExecutionSnapshot } from '../provider-connection/execution-snapshot.cts';
import { retireResidualDeployments } from '../provider-connection/deployment-to-record-migration.cts';
import {
  LEGACY_DEPLOYMENT_MODEL_CAPABILITIES,
  resolveLegacyDeploymentModelCapability,
} from '../provider-connection/deployment-to-generation-model-migration.cts';
import { GENERATION_FAMILY_TEMPLATE_REGISTRY } from '../generation-family-templates.registry.cts';

/**
 * 存量接入载体（`ModelDeployment`，已退场）→ 用户生成模型记录 的一次性迁移（spec 03 §11「升级约束：一次性换轨」，
 * 对应 spec 03 §12 验收 PC-15「模型来源唯一」——注意该 spec 的验收项是项目符号形态、不是
 * `#### 验收：` 标题形态，机器登记里没有它，因此这里不写 `@spec:` 标注，避免关联守卫报
 * 「ID 全仓未定义」）。
 *
 * 三条硬约束在这里被钉住：
 * ① **逐值不变**：`model_id` / `connection_id` / `remote_model_id` 原样搬进记录；
 *    `record_id` 继承 `deployment_id`（`active-routes.json` 因此零改动）；
 * ② **协议补齐与升级前实际执行一致**：`family_adapter_id` 取自换算表（即升级前实际执行所用的
 *    协议适配器），`accepted_media_slots` 取自换算表（该模型在 PromptDock 里实际可用的素材位，
 *    已收窄到族模板能表达的范围内）；
 * ③ **幂等**：重复加载不产生重复记录、不改写已存在的记录、不复活已移除的接入。
 *
 * 无法逐值映射的两类（无族 model_id、有族但不在换算表内）与「已存在同 model_id 的用户记录」
 * 都不迁移：迁移只移除自己转换成功的条目，跳过的原样留在旧文件里。
 *
 * 它们的最终去向由收尾步骤决定（`retireResidualDeployments`，spec 03 §11 一次性换轨的最后一步）：
 * **归档后丢弃旧文件**。理由见文件末尾的处置用例与 `legacy-deployment-file.cts`：这两类都不承载
 * 「只有旧文件里才有」的用户意图（无族模型从未进过可执行目录、冲突条目的信息已被用户记录覆盖），
 * 但「可以丢」不等于「应当静默丢」——归档让人事后能查、能抢救。
 */

process.env['IART_LOG_LEVEL'] = 'debug';

const CONNECTION_ID = 'up_conn_legacy_migration';
const ACTIVE_MODEL_ID = 'gpt-image-2';
const ACTIVE_DEPLOYMENT_ID = 'up_dep_legacy_active_01';
const SEEDANCE_MODEL_ID = 'doubao-seedance-2-0-260128';
const SEEDANCE_DEPLOYMENT_ID = 'up_dep_legacy_seedance_01';
const KLING_TEXT_MODEL_ID = 'kling-v3-text2video';
const KLING_TEXT_DEPLOYMENT_ID = 'up_dep_legacy_kling_text_01';
/** Veo 标准版：包的输入端口有参考图，但该族上限只开放首尾帧（用来钉住收窄）。 */
const VEO_MODEL_ID = 'veo-3.1-generate-preview';
const VEO_DEPLOYMENT_ID = 'up_dep_legacy_veo_01';
/** 无族 model_id：不在任何封闭族正则内（TTS 包），升级前也进不了可提交目录。 */
const NO_FAMILY_MODEL_ID = 'gemini-2.5-flash-preview-tts';
const NO_FAMILY_DEPLOYMENT_ID = 'up_dep_legacy_tts_01';

type JsonValue = Record<string, unknown>;

const writeJson = (storageRoot: string, filename: string, value: unknown): void => {
  fs.mkdirSync(path.join(storageRoot, 'config'), { recursive: true });
  fs.writeFileSync(path.join(storageRoot, 'config', filename), JSON.stringify(value, null, 2), 'utf-8');
};

const readJson = (storageRoot: string, filename: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(storageRoot, 'config', filename), 'utf-8'));

const clearAllCaches = (): void => {
  clearConnectionCache();
  clearActiveRouteCache();
  clearCustomGenerationModelCache();
};

const withIsolatedRoot = (t: test.TestContext): string => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-record-migration-'));
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

/**
 * 旧接入文件里剩下的条目（读取走 `legacy-deployment-file`——它是旧文件在整仓的唯一读取点，
 * 部署 store 已随载体退场删除）。
 */
const remainingDeployments = (): Array<{ deployment_id: string; model_id: string }> =>
  listLegacyDeployments().map((item) => ({ deployment_id: item.deployment_id, model_id: item.model_id }));

/** 一条 v2 deployment 记录（升级前的现役形状）。 */
const deployment = (params: {
  deploymentId: string;
  modelId: string;
  remoteModelId: string;
  createdAt?: string;
}): JsonValue => ({
  deployment_id: params.deploymentId,
  model_id: params.modelId,
  connection_id: CONNECTION_ID,
  remote_model_id: params.remoteModelId,
  created_at: params.createdAt ?? '2026-10-10T00:00:00.000Z',
  updated_at: params.createdAt ?? '2026-10-10T00:00:00.000Z',
});

/** 升级前现役 fixture：连接 + 4 条 deployment（3 条可迁、1 条无族）+ active route。 */
const writeLegacyFixture = (storageRoot: string): void => {
  writeJson(storageRoot, 'provider-connections.json', {
    version: 1,
    updatedAt: '2026-10-10T00:00:00.000Z',
    connections: [{
      connection_id: CONNECTION_ID,
      display_name: 'legacy-migration-provider',
      base_url: 'https://legacy-migration.example.invalid/v1',
      credential_ref: 'cred_legacy_migration',
      credential_version: 1,
      has_credential: true,
      lifecycle: 'enabled',
      revision: 0,
      created_at: '2026-10-10T00:00:00.000Z',
      updated_at: '2026-10-10T00:00:00.000Z',
    }],
  });
  writeJson(storageRoot, 'model-deployments.json', {
    version: 2,
    updatedAt: '2026-10-10T00:00:00.000Z',
    deployments: [
      deployment({ deploymentId: ACTIVE_DEPLOYMENT_ID, modelId: ACTIVE_MODEL_ID, remoteModelId: 'gpt-image-2' }),
      deployment({ deploymentId: SEEDANCE_DEPLOYMENT_ID, modelId: SEEDANCE_MODEL_ID, remoteModelId: 'remote-seedance' }),
      deployment({ deploymentId: KLING_TEXT_DEPLOYMENT_ID, modelId: KLING_TEXT_MODEL_ID, remoteModelId: 'remote-kling-text' }),
      deployment({ deploymentId: VEO_DEPLOYMENT_ID, modelId: VEO_MODEL_ID, remoteModelId: 'remote-veo-standard' }),
      deployment({ deploymentId: NO_FAMILY_DEPLOYMENT_ID, modelId: NO_FAMILY_MODEL_ID, remoteModelId: 'remote-tts' }),
    ],
  });
  writeJson(storageRoot, 'active-routes.json', {
    version: 1,
    updatedAt: '2026-10-10T00:00:00.000Z',
    activeRoutes: { [ACTIVE_MODEL_ID]: ACTIVE_DEPLOYMENT_ID },
  });
};

const readLog = (storageRoot: string): string => {
  const logPath = path.join(storageRoot, 'logs', 'backend.log');
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
};

void test('迁移：deployment 逐值搬进记录，record_id 继承 deployment_id，族与素材位取自换算表', async (t) => {
  const storageRoot = withIsolatedRoot(t);
  writeLegacyFixture(storageRoot);

  // 首次触达记录 store：deployment store 先就绪，再逐条换算并落盘。
  const records = listCustomGenerationModels();

  const migrated = records.find((item) => item.model_id === ACTIVE_MODEL_ID);
  assert.ok(migrated, '可换算的 deployment 必须生成一条记录');
  assert.equal(migrated.record_id, ACTIVE_DEPLOYMENT_ID, 'record_id 继承 deployment_id（active route 零改动）');
  assert.equal(migrated.model_id, ACTIVE_MODEL_ID, 'model_id 逐值不变');
  assert.equal(migrated.connection_id, CONNECTION_ID, 'connection_id 逐值不变（所属服务商不变）');
  assert.equal(migrated.remote_model_id, 'gpt-image-2', 'remote_model_id 逐值不变（远端模型名不变）');
  assert.equal(migrated.family_adapter_id, 'openai-image-v1', '族取自换算表');
  assert.deepEqual(migrated.accepted_media_slots, ['reference_image'], '素材位与换算表一致');
  assert.equal(migrated.created_at, '2026-10-10T00:00:00.000Z', 'created_at 取原接管的创建时间');
  assert.deepEqual(migrated.parameter_overrides, { official: [], custom: [] }, '参数覆盖缺省物化为空覆盖');

  // 三个族各自的素材位都按表落地（不是「全族取上限」的粗粒度换算）。
  const seedance = getCustomGenerationModel(SEEDANCE_MODEL_ID);
  assert.ok(seedance);
  assert.equal(seedance.family_adapter_id, 'seedance-2-0-v1');
  assert.deepEqual(
    seedance.accepted_media_slots,
    ['first_frame', 'last_frame', 'reference_image', 'reference_video', 'reference_audio'],
  );
  const klingText = getCustomGenerationModel(KLING_TEXT_MODEL_ID);
  assert.ok(klingText);
  assert.equal(klingText.family_adapter_id, 'kling-text2video-v1');
  assert.deepEqual(klingText.accepted_media_slots, [], '文生视频族一个素材位都没有');
  const veo = getCustomGenerationModel(VEO_MODEL_ID);
  assert.ok(veo);
  assert.equal(veo.family_adapter_id, 'veo-v1');
  assert.deepEqual(
    veo.accepted_media_slots,
    ['first_frame', 'last_frame'],
    'Veo 只开放首尾帧（包的参考图端口超出该族上限，收窄后不进记录）',
  );

  // 落盘：文件为当前形状（形状没变，版本不升），记录在其中。
  const file = readJson(storageRoot, 'custom-generation-models.json') as { version: number; models: JsonValue[] };
  assert.equal(file.version, 3);
  assert.deepEqual(
    file.models.map((item) => item['model_id']).sort(),
    [ACTIVE_MODEL_ID, KLING_TEXT_MODEL_ID, SEEDANCE_MODEL_ID, VEO_MODEL_ID].sort(),
  );

  // 旧接入文件：转换成功的条目移除，无族的条目原样保留（换轨只清自己转换过的）。
  assert.deepEqual(
    remainingDeployments(),
    [{ deployment_id: NO_FAMILY_DEPLOYMENT_ID, model_id: NO_FAMILY_MODEL_ID }],
    '已迁移的接入从旧文件移除、无族接入保留',
  );
});

void test('迁移：无族 deployment 不迁移、留痕，且不阻断其他条目转换', async (t) => {
  const storageRoot = withIsolatedRoot(t);
  writeLegacyFixture(storageRoot);

  const records = listCustomGenerationModels();
  assert.equal(
    records.some((item) => item.model_id === NO_FAMILY_MODEL_ID),
    false,
    '无族 model_id 不得被换成任何族（升级不改变协议语义，也不凭空造族）',
  );

  const logText = readLog(storageRoot);
  assert.match(logText, /no closed family/, '无族跳过必须留痕');
  assert.match(logText, new RegExp(NO_FAMILY_DEPLOYMENT_ID), '留痕须指认被跳过的接入');
});

void test('迁移：active-routes.json 零改动，迁移后仍解析到同一条模型记录', async (t) => {
  const storageRoot = withIsolatedRoot(t);
  writeLegacyFixture(storageRoot);
  const activeRoutesBefore = fs.readFileSync(path.join(storageRoot, 'config', 'active-routes.json'), 'utf-8');

  listCustomGenerationModels();

  // 文件没有被迁移改写（id 空间相同，迁移不需要碰它）。
  assert.equal(
    fs.readFileSync(path.join(storageRoot, 'config', 'active-routes.json'), 'utf-8'),
    activeRoutesBefore,
  );

  assert.equal(getActiveDeploymentId(ACTIVE_MODEL_ID), ACTIVE_DEPLOYMENT_ID, 'active 接入 id 不变');

  const target = resolveActiveTarget(ACTIVE_MODEL_ID);
  assert.ok(target, 'active 接入目标迁移后仍可解析');
  assert.equal(target.target_id, ACTIVE_DEPLOYMENT_ID);
  assert.equal(target.model_id, ACTIVE_MODEL_ID);
  assert.equal(target.connection_id, CONNECTION_ID);
  assert.equal(target.remote_model_id, 'gpt-image-2');
  assert.equal(target.source, 'custom_generation', '接入目标来源只剩模型记录一种');
  assert.equal(target.protocol_adapter_id, 'openai-image-v1', '协议由记录自带，不再按 model_id 正则推断');

  // 执行快照照常建立：协议、连接、远端模型名都来自迁移后的记录。
  const snapshot = buildExecutionSnapshot({ modelId: ACTIVE_MODEL_ID });
  assert.equal(snapshot.ok, true, `迁移后仍应能建立执行快照: ${snapshot.ok ? '' : snapshot.message}`);
  if (!snapshot.ok) return;
  assert.equal(snapshot.snapshot.adapter_id, 'openai-image-v1');
  assert.equal(snapshot.snapshot.connection_id, CONNECTION_ID);
  assert.equal(snapshot.snapshot.remote_model_id, 'gpt-image-2');
  assert.equal(snapshot.snapshot.deployment_id, ACTIVE_DEPLOYMENT_ID);
});

void test('迁移幂等：重复加载不产生重复记录、不改写已迁移记录、不复活已移除的接入', async (t) => {
  const storageRoot = withIsolatedRoot(t);
  writeLegacyFixture(storageRoot);

  const first = listCustomGenerationModels();
  const firstSnapshot = JSON.stringify(first);

  // 全量清缓存后重读：deployment 已被移除，不再有待迁移项。
  clearAllCaches();
  const second = listCustomGenerationModels();
  assert.equal(JSON.stringify(second), firstSnapshot, '重复加载的记录集合逐字节一致（不重复、不改写）');

  clearAllCaches();
  for (const item of second) {
    const again = getCustomGenerationModel(item.model_id);
    assert.ok(again);
    assert.deepEqual(again, item, '记录内容稳定');
  }
  assert.deepEqual(
    remainingDeployments().map((item) => item.model_id),
    [NO_FAMILY_MODEL_ID],
    '无族接入保留、已迁移接入不复活',
  );
});

void test('迁移幂等：记录已落盘但接入未及移除时（上次运行中断），只补移除不新增记录', async (t) => {
  const storageRoot = withIsolatedRoot(t);
  writeLegacyFixture(storageRoot);
  // 模拟「写完记录、还没移除接入」就中断的中间态：记录已存在（同 record_id），接入仍在。
  writeJson(storageRoot, 'custom-generation-models.json', {
    version: 3,
    updatedAt: '2026-10-10T00:00:00.000Z',
    models: [{
      model_id: ACTIVE_MODEL_ID,
      record_id: ACTIVE_DEPLOYMENT_ID,
      connection_id: CONNECTION_ID,
      remote_model_id: 'gpt-image-2',
      family_adapter_id: 'openai-image-v1',
      accepted_media_slots: ['reference_image'],
      parameter_overrides: { official: [], custom: [] },
      created_at: '2026-10-10T00:00:00.000Z',
    }],
  });
  clearAllCaches();

  const records = listCustomGenerationModels();
  assert.equal(
    records.filter((item) => item.model_id === ACTIVE_MODEL_ID).length,
    1,
    '同 record_id 的既有记录不重复写入',
  );
  assert.equal(
    remainingDeployments().some((item) => item.deployment_id === ACTIVE_DEPLOYMENT_ID),
    false,
    '中断残留的接入被补移除',
  );
  assert.equal(
    remainingDeployments().some((item) => item.deployment_id === SEEDANCE_DEPLOYMENT_ID),
    false,
    '其余可迁移接入照常转换',
  );

  const logText = readLog(storageRoot);
  assert.match(logText, /already recorded/, '补移除必须留痕（说明这次只清理、不新增）');
});

void test('迁移冲突：已存在同 model_id 的用户记录时记录优先，接入跳过并留痕、不改写用户记录', async (t) => {
  const storageRoot = withIsolatedRoot(t);
  writeLegacyFixture(storageRoot);
  // 用户自建的同名记录（换轨前自己添加过同名模型）：record_id 与接入不同。
  writeJson(storageRoot, 'custom-generation-models.json', {
    version: 3,
    updatedAt: '2026-10-10T00:00:00.000Z',
    models: [{
      model_id: ACTIVE_MODEL_ID,
      record_id: 'up_dep_user_own_01',
      connection_id: CONNECTION_ID,
      remote_model_id: 'user-own-remote',
      family_adapter_id: 'openai-image-v1',
      accepted_media_slots: ['reference_image'],
      parameter_overrides: { official: [], custom: [] },
      created_at: '2026-09-30T00:00:00.000Z',
    }],
  });
  clearAllCaches();

  const records = listCustomGenerationModels();
  const sameModel = records.filter((item) => item.model_id === ACTIVE_MODEL_ID);
  assert.equal(sameModel.length, 1, '一个 model_id 只能有一条记录');
  assert.equal(sameModel[0]?.record_id, 'up_dep_user_own_01', '记录优先：用户记录的 id 不被接管 id 顶掉');
  assert.equal(sameModel[0]?.remote_model_id, 'user-own-remote', '记录优先：用户记录的远端模型名不被改写');
  assert.equal(sameModel[0]?.created_at, '2026-09-30T00:00:00.000Z', '记录优先：用户记录不被重写');

  assert.ok(
    remainingDeployments().some((item) => item.deployment_id === ACTIVE_DEPLOYMENT_ID),
    '冲突的接入不迁（不销毁无法安全映射的数据，留给收尾归档）',
  );
  assert.equal(
    remainingDeployments().some((item) => item.deployment_id === SEEDANCE_DEPLOYMENT_ID),
    false,
    '同一次加载里其余接入照常迁移',
  );

  const logText = readLog(storageRoot);
  assert.match(logText, /conflict/, '冲突跳过必须留痕');
  assert.match(logText, /up_dep_user_own_01/, '留痕须指认冲突两侧');
  assert.match(logText, new RegExp(ACTIVE_DEPLOYMENT_ID));
});

void test('迁移：没有 deployment 文件时是无操作（不写空记录文件）', async (t) => {
  const storageRoot = withIsolatedRoot(t);

  assert.deepEqual(listCustomGenerationModels(), []);
  assert.equal(
    fs.existsSync(path.join(storageRoot, 'config', 'custom-generation-models.json')),
    false,
    '没有可迁移数据时不得凭空落盘一个空记录文件',
  );
});

void test('换算表：覆盖升级前全部有族 model_id，且每个条目与该族模板能力、能力协议适配器一致', () => {
  /**
   * 升级前本仓分发过的模型清单（2026-10-19 换轨时点冻结的 22 个 id，其中 15 个命中封闭族
   * 正则）。清单写死在测试里、不读任何目录：换轨同版本内分发资产已被删除，换算表是那段历史
   * 能力的**唯一留存载体**，测试必须跟着表走。
   */
  const familyModelIdsAtSwitch = [
    'gpt-image-2',
    'gpt-image-2.5-flare',
    'gpt-image-2.5-sunburst',
    'gemini-3-pro-image',
    'gemini-3.1-flash-image',
    'gemini-3.1-flash-lite-image',
    'doubao-seedance-2-0-260128',
    'doubao-seedance-2-0-fast-260128',
    'doubao-seedance-2-0-mini-260615',
    'veo-3.1-generate-preview',
    'veo-3.1-fast-generate-preview',
    'veo-3.1-lite-generate-preview',
    'kling-v3-text2video',
    'kling-v3-image2video',
    'kling-v3-omni-video',
  ];

  assert.deepEqual(
    Object.keys(LEGACY_DEPLOYMENT_MODEL_CAPABILITIES).sort(),
    [...familyModelIdsAtSwitch].sort(),
    '换算表必须恰好覆盖升级前全部有族 model_id（多一条是幽灵数据，少一条会让用户模型丢失）',
  );

  for (const modelId of familyModelIdsAtSwitch) {
    const capability = resolveLegacyDeploymentModelCapability(modelId);
    assert.ok(capability, `${modelId} 必须有换算条目`);
    // ① 族与「升级前实际执行所用的适配器」一致（升级不改变协议语义）。
    //
    // 这条校验原本靠与封闭族正则（`resolveClosedFamilyAdapter`）逐条比对来钉住——那个注册表随
    // 部署载体一并删除后，改用契约里同一份「族 → ProtocolAdapter」的静态映射（`ADAPTER_REGISTRY`）
    // 校验换算表的族 id 确实指向一个已登记、family='generation' 的真实适配器。
    //
    // 语义差别说清：①不再有「7 条正则」这一层可供对照，本表因此是那段历史能力的**唯一留存载体**
    // （升级后软件不再按名称推断族，表也不会跟着活注册表演进——它描述升级前那一刻的包）；
    // ②能钉住的仍是最关键的一条：每个换算条目都必须落在现役协议族里，否则迁移会写出一个执行链
    // 认不出的族，用户模型升级后发不出去。表内 model_id → 族的对应关系本身已冻结，不随族口径变化。
    assert.equal(
      ADAPTER_REGISTRY[capability.familyAdapterId].family,
      'generation',
      `${modelId} 的换算族必须是已登记的生成协议适配器`,
    );
    // ② 素材位必须是该族模板能表达的范围内——否则记录写入侧守卫会拒、投影侧会静默过滤。
    const familyEntry = GENERATION_FAMILY_TEMPLATE_REGISTRY[capability.familyAdapterId];
    const supported = new Set<string>(familyEntry.supportsMediaSlots);
    const outOfFamily = capability.acceptedMediaSlots.filter((slot) => !supported.has(slot));
    assert.deepEqual(outOfFamily, [], `${modelId} 的素材位超出该族模板能力: ${outOfFamily.join('、')}`);
    // ③ 素材位不重复（受控词表是集合语义）。
    assert.equal(
      new Set(capability.acceptedMediaSlots).size,
      capability.acceptedMediaSlots.length,
      `${modelId} 的素材位清单不得重复`,
    );
  }

  // 族 id 全部落在契约值域内（换算表不得写入契约外的族）。
  const knownFamilies = new Set<string>(GENERATION_FAMILY_ADAPTER_IDS);
  // 素材位全部落在受控词表内：类型层已由 `satisfies readonly GenerationMediaSlotId[]` 钉住，
  // 这里再从值域反查一次，防止将来有人把表放宽成 string[] 时静默漏掉。
  const knownSlots = new Set<string>(GENERATION_MEDIA_SLOT_IDS);
  for (const capability of Object.values(LEGACY_DEPLOYMENT_MODEL_CAPABILITIES)) {
    assert.ok(knownFamilies.has(capability.familyAdapterId), `未知族: ${capability.familyAdapterId}`);
    for (const slot of capability.acceptedMediaSlots) {
      assert.ok(knownSlots.has(slot), `未知素材位: ${slot}`);
    }
  }

  // 表内没有的 model_id 一律返回 null（不得凭空造出能力）。
  assert.equal(resolveLegacyDeploymentModelCapability('gpt-image-unknown-9'), null);
  assert.equal(resolveLegacyDeploymentModelCapability('gemini-2.5-flash-preview-tts'), null);
});

// ---------------------------------------------------------------------------
// 收尾：残留条目的处置（归档 + 丢弃旧文件）
// ---------------------------------------------------------------------------

void test('收尾：残留条目（无族 / 冲突）归档后丢弃旧文件，模型的既有信息不丢', async (t) => {
  const storageRoot = withIsolatedRoot(t);
  writeLegacyFixture(storageRoot);

  // 先跑迁移（可映射条目搬进记录），再跑收尾。
  listCustomGenerationModels();
  const archivedCount = retireResidualDeployments();

  assert.equal(archivedCount, 1, '应归档 1 条残留（无族的那条）');
  assert.equal(
    fs.existsSync(path.join(storageRoot, 'config', 'model-deployments.json')),
    false,
    '旧接入文件从 config 下移除（留一个永不读取的文件会让后来者以为它还是事实源）',
  );
  const archivePath = path.join(storageRoot, 'config', 'archive', 'model-deployments.json');
  assert.equal(fs.existsSync(archivePath), true, '丢弃前必须留下归档');
  const archive = JSON.parse(fs.readFileSync(archivePath, 'utf-8')) as {
    archived_at: string;
    reason: string;
    deployments: Array<{ deployment_id: string; model_id: string }>;
  };
  assert.equal(typeof archive.archived_at, 'string', '归档带上归档时间');
  assert.match(archive.reason, /retired/, '归档写明原因（载体退役），供人工排查');
  assert.deepEqual(
    archive.deployments.map((item) => item.model_id),
    [NO_FAMILY_MODEL_ID],
    '被丢弃的残留条目内容原样进归档',
  );

  // 迁移产出的记录不受收尾影响。
  assert.deepEqual(
    listCustomGenerationModels().map((item) => item.model_id).sort(),
    [ACTIVE_MODEL_ID, KLING_TEXT_MODEL_ID, SEEDANCE_MODEL_ID, VEO_MODEL_ID].sort(),
    '收尾不得触碰已迁移的记录',
  );

  // 收尾留痕：归档动作可诊断。
  const logText = readLog(storageRoot);
  assert.match(logText, /retired legacy deployment file/, '收尾必须留痕');
});

void test('收尾：旧文件不在时是零操作（幂等，不重复归档）', async (t) => {
  const storageRoot = withIsolatedRoot(t);

  assert.equal(retireResidualDeployments(), 0, '没有旧文件时零操作');
  assert.equal(
    fs.existsSync(path.join(storageRoot, 'config', 'archive', 'model-deployments.json')),
    false,
    '没有残留就不该凭空造出一份归档',
  );

  writeLegacyFixture(storageRoot);
  listCustomGenerationModels();
  assert.equal(retireResidualDeployments(), 1);
  assert.equal(retireResidualDeployments(), 0, '第二次调用无操作（旧文件已不在）');
});

void test('收尾：v1 文件里的退役档位键在归档前已剥离（归档不是原始字节的转存）', async (t) => {
  const storageRoot = withIsolatedRoot(t);
  // v1 形状（带 enabled_thinking_tiers / default_thinking_tier）
  writeJson(storageRoot, 'provider-connections.json', {
    version: 1,
    updatedAt: '2026-10-10T00:00:00.000Z',
    connections: [{
      connection_id: CONNECTION_ID,
      display_name: 'legacy-migration-provider',
      base_url: 'https://legacy-migration.example.invalid/v1',
      credential_ref: 'cred_legacy_migration',
      credential_version: 1,
      has_credential: true,
      lifecycle: 'enabled',
      revision: 0,
      created_at: '2026-10-10T00:00:00.000Z',
      updated_at: '2026-10-10T00:00:00.000Z',
    }],
  });
  writeJson(storageRoot, 'model-deployments.json', {
    version: 1,
    updatedAt: '2026-10-10T00:00:00.000Z',
    deployments: [{
      ...deployment({
        deploymentId: NO_FAMILY_DEPLOYMENT_ID,
        modelId: NO_FAMILY_MODEL_ID,
        remoteModelId: 'remote-tts',
      }),
      enabled_thinking_tiers: ['low'],
      default_thinking_tier: 'low',
    }],
  });

  assert.equal(retireResidualDeployments(), 1);

  const archive = JSON.parse(
    fs.readFileSync(path.join(storageRoot, 'config', 'archive', 'model-deployments.json'), 'utf-8'),
  ) as { deployments: Array<Record<string, unknown>> };
  const archivedEntry = archive.deployments[0];
  assert.ok(archivedEntry);
  assert.equal('enabled_thinking_tiers' in archivedEntry, false, '退役档位键不进归档（归档记的是现役形状）');
  assert.equal('default_thinking_tier' in archivedEntry, false);
});
