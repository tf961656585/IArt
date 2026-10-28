import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  RuntimeTransactionResultSchema,
  type ExecutionSnapshot,
  type InterfaceRecipe,
} from '@iart/contracts';
import { setBackendIpcTestHandler } from '../backend-ipc-sender.cts';
import type { CatalogFormalTaskExecutionPlan } from '../model-package-catalog.types.cts';
import { buildDeclaredGenerationProjection } from '../generation-declaration-projection.cts';
import { validateInterfaceRecipe } from '../interface-recipe-validation.cts';
import {
  addInterfaceRecipe,
  clearCacheForTest as clearInterfaceRecipeCache,
} from '../provider-connection/interface-recipe-store.cts';
import {
  addCustomGenerationModel,
  clearCacheForTest as clearCustomGenerationModelCache,
} from '../provider-connection/custom-generation-model-store.cts';
import {
  clearCacheForTest as clearActiveRouteCache,
  setActiveDeployment,
} from '../provider-connection/active-route-store.cts';
import {
  clearCacheForTest as clearConnectionCache,
  createConnection,
  setConnectionCredential,
} from '../provider-connection/connection-store.cts';
import { setCredentialForConnection } from '../provider-connection/credential-store.cts';
import { buildExecutionSnapshot, type BuildSnapshotResult } from '../provider-connection/execution-snapshot.cts';
import { clearRuntimeProjectScopesForTest } from '../project-media-scope.cts';
import { executePollingTask } from '../task-engine-polling.cts';
import { buildPollingRequestFromPlan } from '../task-engine-polling-utils.cts';
import {
  ACQUIRED_MEDIA_URL_PATH,
} from '../task-result-acquisition.cts';
import { executeTaskResultMaterialization } from '../task-result-materializer.cts';

/**
 * 接口配方 × 用户模型记录 → 合成投影 → 执行计划 → 轮询判定 → 结果获取 → 落盘与资产绑定
 * → succeeded 的接缝测试（`docs/custom-providers/接口配方-design.md`）。
 *
 * 使命：用**真实实现**跑通整条主链，只在最外层替换 `globalThis.fetch`：
 * - 配方经真实 store（`config/interface-recipes.json`）写入；
 * - 模型记录经真实 store（`config/custom-generation-models.json`）写入，并以 `recipe_id` 引用配方；
 * - 执行计划取自真实合成投影 `buildDeclaredGenerationProjection`（内部已跑真实
 *   `normalizeFormalTaskExecutionPlan`），不手写条件树/获取策略；
 * - 轮询循环、结果获取、物化、下载鉴权、事务落盘全部走生产实现。
 *
 * 场景对照（红→绿自证）：
 * 1. 引用配方：查询响应 `{id, state:'FINISHED'}` 命中原配方 `success_when`，
 *    `needs_fetch + binary` 获取阶段构造 `<base>/v1/videos/{id}/content`，下载带鉴权，
 *    产物落盘并绑定 media_assets，最终 succeeded。
 * 2. 同一份查询响应、同一条记录族与同一连接，**不引用配方**（走族内置默认）：默认族
 *    只在 `status` / `data.status` 与 `content.video_url` 上判定，`state` 字段永不可见，
 *    轮询预算耗尽后 failed。这条反例证明场景 1 的成功来自配方，而不是被默认行为掩盖。
 *
 * 连接 base_url 被 store 约束为 https，因此假上游用替换 `globalThis.fetch` 实现
 * （沿 `task-result-acquisition.engineSeam.test.ts` 的既有做法）。
 */

const FAMILY_ADAPTER_ID = 'seedance-2-0-v1';
const BASE_URL = 'https://seam-interface-recipe.example.invalid';
const CREDENTIAL = 'sk-seam-interface-recipe-secret';
const RECIPE_ID = 'ir_seam_mainchain_binary';
const MODEL_WITH_RECIPE = 'seam-recipe-model';
const MODEL_WITHOUT_RECIPE = 'seam-default-model';
const REMOTE_MODEL_ID = 'remote-seam-recipe-model';
const JOB_ID = 'job_1';
/** 配方声明的地址模板（保留 `{id}` 占位符，执行期由获取阶段替换）。 */
const CONTENT_URL_TEMPLATE = '/v1/videos/{id}/content';
/** 执行期实际地址：`{id}` 被查询响应里的任务标识替换。 */
const CONTENT_PATH = `/v1/videos/${JOB_ID}/content`;
const CONTENT_URL = `${BASE_URL}${CONTENT_PATH}`;

const binaryPayload = Buffer.from('seam-interface-recipe-video-bytes');

type UpstreamCall = {
  url: string;
  method: string;
  authorization: string | null;
};

type UpstreamStub = {
  calls: UpstreamCall[];
  restore: () => void;
};

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const binaryResponse = (): Response =>
  new Response(binaryPayload, {
    status: 200,
    headers: {
      'content-type': 'video/mp4',
      'content-length': String(binaryPayload.length),
    },
  });

/**
 * 假上游：轮询查询返回配方声明的 `{id, state:'FINISHED'}`；内容端点返回视频字节。
 *
 * 同时记录每次请求的 URL / 方法 / 鉴权头，供断言「内容端点请求带同源鉴权」。
 */
const installUpstream = (t: TestContext): UpstreamStub => {
  const originalFetch = globalThis.fetch;
  const calls: UpstreamCall[] = [];
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers ?? undefined);
    const call: UpstreamCall = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      authorization: headers.get('authorization'),
    };
    calls.push(call);
    if (url === CONTENT_URL) return binaryResponse();
    if (url.includes('/api/v3/contents/generations/tasks/')) {
      // 配方场景与默认场景共用同一份查询响应：字段名 `state` 只有配方认识。
      return jsonResponse({ id: JOB_ID, state: 'FINISHED' });
    }
    throw new Error(`unexpected upstream request: ${url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
};

type CapturedTransaction = {
  tasks: Array<{ status: string }>;
  taskOutputs: Array<{ assetId: string | null; mediaType: string }>;
  mediaAssets: Array<{ assetId: string; mediaType: string; payloadJson: string }>;
};

const isFinalTransaction = (value: unknown): value is CapturedTransaction => {
  if (value === null || typeof value !== 'object') return false;
  const outputs: unknown = Reflect.get(value, 'taskOutputs');
  return (
    Reflect.get(value, 'type') === 'runtime:execute-transaction' &&
    Array.isArray(outputs) &&
    outputs.length > 0
  );
};

/** 接管 Backend→Main 的 runtime 事务出口：捕获最终落库事务并回成功。 */
const installIpcCapture = (captured: unknown[]): void => {
  setBackendIpcTestHandler(async (message) => {
    captured.push(message);
    return RuntimeTransactionResultSchema.parse({
      type: 'runtime:transaction-result',
      transactionId: message.transactionId,
      success: true,
      data: {},
    });
  });
};

type SeamContext = {
  projectPath: string;
  modelId: string;
  plan: CatalogFormalTaskExecutionPlan;
  snapshot: ExecutionSnapshot;
};

/**
 * 真实写入链：存储根隔离 → 连接 + 凭证 → 配方（可选）→ 模型记录（引用配方）→ active route
 * → 真实执行快照 → 真实合成投影 + 真实计划归一化。
 */
const seedMainChain = async (params: {
  t: TestContext;
  scenario: string;
  modelId: string;
  recipeId: string;
  withRecipe: boolean;
}): Promise<SeamContext> => {
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), `interface-recipe-seam-storage-${params.scenario}-`));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `interface-recipe-seam-project-${params.scenario}-`));
  const projectPath = path.join(projectRoot, 'seam-project.iartproj');
  fs.mkdirSync(path.join(projectPath, 'media'), { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, 'manifest.json'),
    JSON.stringify({ version: 1, name: `seam-${params.scenario}` }),
    'utf-8',
  );
  process.env['IART_STORAGE_ROOT'] = storageRoot;
  clearConnectionCache();
  clearActiveRouteCache();
  clearCustomGenerationModelCache();
  clearInterfaceRecipeCache();
  clearRuntimeProjectScopesForTest();

  params.t.after(() => {
    setBackendIpcTestHandler(null);
    clearConnectionCache();
    clearActiveRouteCache();
    clearCustomGenerationModelCache();
    clearInterfaceRecipeCache();
    clearRuntimeProjectScopesForTest();
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    fs.rmSync(storageRoot, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  const connection = createConnection({
    display_name: `interface-recipe-upstream-${params.scenario}`,
    base_url: BASE_URL,
  });
  const credential = await setCredentialForConnection(connection.connection_id, CREDENTIAL);
  assert.ok(credential, 'credential should be written');
  setConnectionCredential(connection.connection_id, credential.credentialRef, credential.version, true);

  if (params.withRecipe) {
    const recipeCandidate: InterfaceRecipe = {
      recipe_id: params.recipeId,
      name: '接缝：二进制内容端点',
      family_adapter_id: FAMILY_ADAPTER_ID,
      success_when: { op: 'eq', path: 'state', value: 'FINISHED' },
      result: {
        kind: 'needs_fetch',
        identity_field_path: 'id',
        content_url_template: CONTENT_URL_TEMPLATE,
        accept: 'binary',
        media_type: 'video',
      },
      requires_auth: true,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    };
    // 先走写入侧语义校验（与保存路由同一实现），确保这份配方本身是合法输入。
    const violations = validateInterfaceRecipe({
      family_adapter_id: recipeCandidate.family_adapter_id,
      success_when: recipeCandidate.success_when,
      result: recipeCandidate.result,
    });
    assert.deepEqual(violations, [], 'recipe should pass the shared semantic validator');
    const addedRecipe = addInterfaceRecipe({
      recipe_id: recipeCandidate.recipe_id,
      name: recipeCandidate.name,
      family_adapter_id: recipeCandidate.family_adapter_id,
      success_when: recipeCandidate.success_when,
      result: recipeCandidate.result,
      requires_auth: recipeCandidate.requires_auth,
    });
    assert.equal(addedRecipe.ok, true, 'recipe should be written by the real store');
  }

  // 模型记录经真实 store 写入：recipe_id 只在引用场景出现，反例走族内置默认。
  const addedModel = addCustomGenerationModel({
    model_id: params.modelId,
    connection_id: connection.connection_id,
    remote_model_id: REMOTE_MODEL_ID,
    family_adapter_id: FAMILY_ADAPTER_ID,
    accepted_media_slots: [],
    ...(params.withRecipe ? { recipe_id: params.recipeId } : {}),
  });
  assert.equal(addedModel.ok, true, 'model record should be accepted by the real store');
  if (!addedModel.ok) throw new Error('model record rejected');

  assert.equal(
    setActiveDeployment(params.modelId, addedModel.model.record_id),
    addedModel.model.record_id,
    'active route should point at the record',
  );

  // 真实执行快照（base_url / credential_ref / adapter 由连接与记录决定，不手写）。
  // 显式标注联合类型后再收窄：node:assert 的 equal/ok 是断言签名，会提前把 `.ok` 收窄成
  // 字面量 true，使随后的失败分支变成 never（TS2339）。这里只用 if-throw 收窄。
  const snapshotResult: BuildSnapshotResult = buildExecutionSnapshot({ modelId: params.modelId });
  if (!snapshotResult.ok) {
    throw new Error(`execution snapshot failed: ${snapshotResult.code} ${snapshotResult.message}`);
  }

  // 真实合成投影：配方由 projection 内部按记录的 recipe_id 从 store 读取并合入。
  const built = buildDeclaredGenerationProjection(addedModel.model);
  assert.ok(built, 'declared generation projection should build');
  if (built === null) throw new Error('declared generation projection missing');
  const plan = built.projection.task_execution_plan;
  assert.ok(plan, 'projection should carry an execution plan');
  if (plan === null) throw new Error('execution plan missing');

  return {
    projectPath,
    modelId: params.modelId,
    plan,
    snapshot: snapshotResult.snapshot,
  };
};

const buildTaskRecord = (context: SeamContext, taskId: string) => ({
  id: taskId,
  taskId,
  status: 'submitting',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  projectPath: context.projectPath,
  // 提交阶段摘要：提交响应 `{id}` 由真实 buildPollingRequestFromPlan 按 result_rule 取 id。
  request: {
    url: `${BASE_URL}${context.plan.request_strategy.endpoint}`,
    method: 'POST',
    headers: {},
  },
  response: {
    status: 200,
    ok: true,
    body: { id: JOB_ID },
  },
  metadata: {
    taskId,
    projectPath: context.projectPath,
    modelId: context.modelId,
    taskExecutionPlan: context.plan,
    executionSnapshot: context.snapshot,
  },
});

/**
 * 跑真实轮询循环。轮询请求由生产实现的 `buildPollingRequestFromPlan` 从执行计划生成
 * （含 `{id}` 替换），只把间隔与轮询预算压小以免测试真的等 3s × 500。
 */
const runPolling = async (context: SeamContext, taskId: string, maxAttempts: number) => {
  const record = buildTaskRecord(context, taskId);
  const pollingBuild = buildPollingRequestFromPlan(record, { id: JOB_ID });
  assert.equal(pollingBuild.status, 'ready', 'polling request should be derivable from the plan');
  if (pollingBuild.status !== 'ready') throw new Error('polling request not ready');
  const polled = await executePollingTask(record, new AbortController(), {
    request: pollingBuild.request,
    polling: {
      ...pollingBuild.polling,
      intervalMs: 1,
      maxAttempts,
    },
  });
  return { polled, record };
};

const readResponseBody = (record: unknown): unknown => {
  if (record === null || typeof record !== 'object') return undefined;
  const response: unknown = Reflect.get(record, 'response');
  if (response === null || typeof response !== 'object') return undefined;
  return Reflect.get(response, 'body');
};

const readMetadataPlan = (record: unknown): Record<string, unknown> => {
  const metadata: unknown = record !== null && typeof record === 'object'
    ? Reflect.get(record, 'metadata')
    : undefined;
  const plan: unknown = metadata !== null && typeof metadata === 'object'
    ? Reflect.get(metadata, 'taskExecutionPlan')
    : undefined;
  return plan !== null && typeof plan === 'object' ? (plan as Record<string, unknown>) : {};
};

const readObjectField = (value: unknown, key: string): unknown =>
  value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;

void test('接缝：配方驱动 needs_fetch + binary → 鉴权下载 → media_assets 绑定 → succeeded', async (t) => {
  const context = await seedMainChain({
    t,
    scenario: 'recipe',
    modelId: MODEL_WITH_RECIPE,
    recipeId: RECIPE_ID,
    withRecipe: true,
  });
  const captured: unknown[] = [];
  installIpcCapture(captured);
  const upstream = installUpstream(t);
  t.after(() => upstream.restore());

  // ① 合成投影里的执行计划确实带上了配方（而不是手写的理想对象）。
  assert.deepEqual(
    context.plan.result_rule.success_condition,
    { op: 'eq', path: 'state', value: 'FINISHED' },
    'recipe success_when must land in the execution plan result_rule',
  );
  const acquisition = context.plan.result_acquisition_strategy;
  assert.ok(acquisition, 'needs_fetch recipe must produce a result acquisition strategy');
  assert.equal(acquisition.acquisition_mode, 'fetch_final_result');
  assert.equal(acquisition.identity_source, 'query_response_path');
  assert.equal(acquisition.identity_path, 'id');
  assert.equal(acquisition.accept, 'binary');
  assert.equal(acquisition.media_type, 'video');
  assert.equal(acquisition.requires_auth, true);
  assert.equal(acquisition.request_strategy?.method, 'GET');
  assert.equal(acquisition.request_strategy?.endpoint, CONTENT_URL_TEMPLATE);
  assert.equal(context.plan.result_output_mapping?.requires_auth, true);
  assert.deepEqual(context.plan.result_output_mapping?.output_mapping_rules, [
    {
      target: 'output.video_url',
      source: { kind: 'response', path: ACQUIRED_MEDIA_URL_PATH },
      required: true,
    },
  ]);

  // ② 真实轮询：查询响应 `{id, state:'FINISHED'}` 命中配方条件树。
  const { polled } = await runPolling(context, 'task-seam-recipe-binary', 3);

  t.diagnostic(
    `green: success_condition=${JSON.stringify(context.plan.result_rule.success_condition)} `
      + `acquisition=${String(context.plan.result_acquisition_strategy?.acquisition_mode)} `
      + `polled.status=${String(readObjectField(polled, 'status'))} `
      + `calls=${upstream.calls.map((call) => `${call.method} ${call.url}`).join(' | ')}`,
  );

  assert.equal(upstream.calls.length, 1, 'binary 获取阶段只构造地址，不额外发请求');
  assert.match(upstream.calls[0]?.url ?? '', /\/api\/v3\/contents\/generations\/tasks\/job_1$/);
  assert.equal(upstream.calls[0]?.method, 'GET');
  assert.equal(
    upstream.calls[0]?.authorization,
    `Bearer ${CREDENTIAL}`,
    '轮询请求带同源鉴权',
  );

  // 任务记录上的执行计划（经真实 patch 归一化后的形态）仍带着配方内容。
  const persistedPlan = readMetadataPlan(polled);
  assert.deepEqual(
    readObjectField(persistedPlan, 'result_rule') !== null &&
      typeof readObjectField(persistedPlan, 'result_rule') === 'object'
      ? Reflect.get(readObjectField(persistedPlan, 'result_rule') as object, 'success_condition')
      : undefined,
    { op: 'eq', path: 'state', value: 'FINISHED' },
    'task metadata.taskExecutionPlan.result_rule.success_condition must stay recipe-driven',
  );
  const persistedAcquisition = readObjectField(persistedPlan, 'result_acquisition_strategy');
  assert.equal(readObjectField(persistedAcquisition, 'acquisition_mode'), 'fetch_final_result');
  assert.equal(readObjectField(persistedAcquisition, 'identity_source'), 'query_response_path');
  assert.equal(readObjectField(persistedAcquisition, 'accept'), 'binary');
  assert.equal(readObjectField(persistedAcquisition, 'requires_auth'), true);
  assert.equal(
    readObjectField(readObjectField(persistedAcquisition, 'request_strategy'), 'endpoint'),
    CONTENT_URL_TEMPLATE,
  );

  // 获取阶段把内容地址写入保留路径（binary 不在该阶段下载字节）。
  assert.equal(
    readObjectField(readResponseBody(polled), ACQUIRED_MEDIA_URL_PATH),
    CONTENT_URL,
    '获取阶段把内容地址写入保留路径',
  );
  assert.equal(readObjectField(polled, 'status'), 'polling', '物化前仍是 polling');
  assert.equal(readObjectField(readObjectField(polled, 'progress'), 'phase'), 'result_received');

  // ③ 真实物化：下载内容端点（带鉴权）→ 落盘 → task_outputs / media_assets 绑定 → succeeded。
  await executeTaskResultMaterialization(polled, undefined);

  assert.equal(upstream.calls.length, 2, '落盘阶段才下载字节');
  assert.equal(upstream.calls[1]?.url, CONTENT_URL);
  assert.equal(upstream.calls[1]?.method, 'GET');
  assert.equal(
    upstream.calls[1]?.authorization,
    `Bearer ${CREDENTIAL}`,
    '内容端点请求必须带同源鉴权头',
  );

  const finalTransaction = captured.filter(isFinalTransaction)[0];
  assert.ok(finalTransaction, 'succeeded 事务应携带产物');
  t.diagnostic(
    `green: final.status=${String(finalTransaction.tasks[0]?.status)} `
      + `outputs=${finalTransaction.taskOutputs.length} `
      + `assets=${finalTransaction.mediaAssets.length} `
      + `assetId=${String(finalTransaction.taskOutputs[0]?.assetId)} `
      + `calls=${upstream.calls.map((call) => `${call.method} ${call.url} auth=${call.authorization === null ? 'none' : 'present'}`).join(' | ')}`,
  );
  assert.equal(finalTransaction.tasks[0]?.status, 'succeeded');
  assert.equal(finalTransaction.taskOutputs.length, 1);
  assert.equal(finalTransaction.taskOutputs[0]?.mediaType, 'video');
  assert.equal(finalTransaction.mediaAssets.length, 1);
  assert.equal(finalTransaction.mediaAssets[0]?.mediaType, 'video');
  assert.ok(
    finalTransaction.taskOutputs[0]?.assetId,
    'task output must carry a bound media asset id',
  );
  assert.equal(
    finalTransaction.taskOutputs[0]?.assetId,
    finalTransaction.mediaAssets[0]?.assetId,
    'task_outputs.assetId must bind to the materialized media_assets row',
  );

  const payload = JSON.parse(finalTransaction.mediaAssets[0]?.payloadJson ?? '{}') as {
    original?: { fileKey?: unknown; sourceUrl?: unknown };
  };
  const fileKey = String(payload.original?.fileKey ?? '');
  assert.ok(fileKey, 'media asset payload should carry fileKey');
  assert.equal(
    fs.existsSync(path.join(context.projectPath, 'media', fileKey)),
    true,
    '媒体应已落盘到项目 media 目录',
  );
  assert.equal(payload.original?.sourceUrl, CONTENT_URL, '产物来源记录为内容端点地址');
  assert.equal(
    JSON.stringify(captured).includes(CREDENTIAL),
    false,
    '凭证明文不得进入任务记录/事务',
  );
});

void test('接缝（红→绿自证）：同一查询响应不引用配方时不判成功，轮询预算耗尽后 failed', async (t) => {
  const context = await seedMainChain({
    t,
    scenario: 'no-recipe',
    modelId: MODEL_WITHOUT_RECIPE,
    recipeId: RECIPE_ID,
    withRecipe: false,
  });
  const captured: unknown[] = [];
  installIpcCapture(captured);
  const upstream = installUpstream(t);
  t.after(() => upstream.restore());

  // 反例基线：同一条记录、同一连接、同一族模板，只是不引用配方。
  // 族内置默认的判定路径是 status / data.status / content.video_url，
  // 而查询响应只给 `state` —— 默认行为永远看不到成功证据。
  assert.equal(
    context.plan.result_rule.success_condition,
    undefined,
    'without a recipe the family default carries no success_condition',
  );
  assert.equal(
    context.plan.result_acquisition_strategy,
    null,
    'without a recipe there is no result acquisition strategy',
  );

  const { polled } = await runPolling(context, 'task-seam-no-recipe', 3);

  t.diagnostic(
    `red: success_condition=${JSON.stringify(context.plan.result_rule.success_condition)} `
      + `acquisition=${JSON.stringify(context.plan.result_acquisition_strategy)} `
      + `polled.status=${String(readObjectField(polled, 'status'))} `
      + `error.code=${String(readObjectField(readObjectField(polled, 'error'), 'code'))} `
      + `calls=${upstream.calls.map((call) => `${call.method} ${call.url}`).join(' | ')}`,
  );

  assert.equal(
    readObjectField(polled, 'status'),
    'failed',
    '同一份查询响应在无配方时必须判定不成立（而不是 succeeded）',
  );
  assert.equal(
    readObjectField(readObjectField(polled, 'error'), 'code'),
    'task_execution_failed',
    '失败原因应为轮询预算耗尽',
  );
  assert.equal(upstream.calls.length, 3, '整个轮询预算都耗完了');
  assert.equal(
    upstream.calls.every((call) => !call.url.includes('/v1/videos/')),
    true,
    '判定不成立时不会进入结果获取阶段，内容端点一次都不会被请求',
  );
  assert.equal(
    readObjectField(readResponseBody(polled), ACQUIRED_MEDIA_URL_PATH),
    undefined,
    '没有获取策略时响应体不会出现保留路径',
  );
  assert.equal(
    captured.filter(isFinalTransaction).length,
    0,
    '失败任务不应产生 succeeded 落库事务',
  );
});
