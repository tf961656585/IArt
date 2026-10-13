import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  ExecutableModelCatalogResponseSchema,
  HUB_LOCAL_WRITE_TOKEN_ENV,
  HUB_LOCAL_WRITE_TOKEN_HEADER,
  PromptDockBatchSubmitResponseSchema,
  TaskStateNotificationSchema,
  type ParameterOverrides,
  type TaskStateNotification,
} from '@iart/contracts';
import { ModelAssetNodeProjectionResponseSchema } from '@iart/contracts/model-asset-contract';
import { createRequestHandler } from '../router.cts';
import { setBackendIpcTestHandler } from '../backend-ipc-sender.cts';
import { createProjectFolder } from '../project-store.cts';
import { removeProjectScope, syncProjectScope } from '../project-media-scope.cts';
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
  addCustomGenerationModel,
  clearCacheForTest as clearCustomGenerationModelCache,
} from '../provider-connection/custom-generation-model-store.cts';
import { setCredentialForConnection } from '../provider-connection/credential-store.cts';

/**
 * 参数覆盖「声明 × 族模板 → 合成投影 → 目录与执行主链」接缝测试
 *（docs/custom-providers/生成模型参数高级自定义-design.md §3.3/§5 S1/S2/S3/S5/S6/S7）。
 *
 * 使命：验证**真实**链路「真实声明 store 建带覆盖的声明 → 族模板合成投影应用覆盖 →
 * 可执行目录条目反映新参数表单 → node-projections 暴露改写后的 payload_rules →
 * POST /api/generation-batches 真实受理与请求组装 → 假上游收到别名/禁用/枚举/自定义
 * 键形状正确的请求 → PUT 修改覆盖后目录与请求体随之更新（S6 编辑传播）」。
 *
 * 真实边界外的替身只有两处（与 custom-generation-family-catalog.engineSeam 同一 bargain）：
 * 假 fetch 上游 + Backend→Main IPC 拦截。
 *
 * 红→绿自证：先在「合成未接线」状态（buildOpenAiImageV1TemplateSources 暂不应用覆盖）
 * 跑红（目录无自定义字段、上游请求体无别名键），再随接线转绿；两段日志落 /tmp。
 */

const DECLARED_MODEL_ID = 'seam-overrides-image';
const REMOTE_MODEL_ID = 'remote-seam-overrides';
const CONNECTION_BASE_URL = 'https://seam-overrides-upstream.example.invalid';
const CREDENTIAL_VALUE = 'sk-seam-overrides-key';
const HUB_WRITE_TOKEN = 'o'.repeat(32);

/** 覆盖集一：别名 + 枚举替换 + 禁用 + 自定义枚举参数（S1/S2/S3/S5 的合成输入）。 */
const OVERRIDES_V1 = {
  official: [
    { field_key: 'size', wire_name: 'image_size' },
    { field_key: 'quality', enum_options: ['hd', 'standard'], default_value: 'hd' },
    { field_key: 'moderation', enabled: false },
  ],
  custom: [
    { label: '水印', wire_name: 'my_watermark', value_type: 'enum' as const, enum_options: ['on', 'off'], default_value: 'on', required: false },
  ],
};

/** 覆盖集二：S6 编辑传播后的新覆盖（别名变化、清空禁用与自定义参数）。 */
const OVERRIDES_V2 = {
  official: [{ field_key: 'size', wire_name: 'img_size_v2' }],
  custom: [],
};

/** 1×1 PNG 的 base64（内联产物：materializer 只做字节落盘，不做图像解码）。 */
const INLINE_IMAGE_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

type UpstreamRequest = { url: string; body: Record<string, unknown> | null; headers: Headers };

/** 假上游：openai-image 同步接口返回 ImagesResponse 形状（data[].b64_json）。 */
const installSucceedingUpstreamStub = (params: {
  generationBaseUrl: string;
}): { requests: UpstreamRequest[]; restore: () => void } => {
  const originalFetch = globalThis.fetch;
  const requests: UpstreamRequest[] = [];
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    // 本地 HTTP 服务的请求（目录/提交/声明路由）透传给真实 handler，只拦截生成上游。
    if (url.startsWith('http://127.0.0.1')) {
      return originalFetch(input, init);
    }
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    const parsed: unknown = rawBody ? JSON.parse(rawBody) : null;
    requests.push({
      url,
      body: parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null,
      headers: new Headers(init?.headers ?? undefined),
    });
    if (url.startsWith(params.generationBaseUrl)) {
      return new Response(
        JSON.stringify({ created: 1727240804, data: [{ b64_json: INLINE_IMAGE_B64 }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected upstream request: ${url}`);
  };
  return {
    requests,
    restore: (): void => {
      globalThis.fetch = originalFetch;
    },
  };
};

/** 接管 backend→Main 的单向通知出口（process.send），捕获任务状态通知。 */
const installNotificationCapture = (): {
  notifications: TaskStateNotification[];
  restore: () => void;
} => {
  const original = process.send;
  const notifications: TaskStateNotification[] = [];
  process.send = (message: unknown): boolean => {
    const parsed = TaskStateNotificationSchema.safeParse(message);
    if (parsed.success) notifications.push(parsed.data);
    return true;
  };
  return {
    notifications,
    restore: (): void => {
      if (original === undefined) {
        Reflect.deleteProperty(process, 'send');
        return;
      }
      process.send = original;
    },
  };
};

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error(`waitFor timed out: ${label}`);
};

const startServer = async (t: TestContext): Promise<string> => {
  const server = http.createServer(createRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('overrides_seam_server_address_unavailable');
  }
  return `http://127.0.0.1:${address.port}`;
};

const createOpenedProject = (projectName: string) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overrides-seam-'));
  const created = createProjectFolder(tempDir, projectName);
  if (!created || 'error' in created) {
    throw new Error('project_creation_failed');
  }
  const projectPath = created.projectPath;
  fs.writeFileSync(
    path.join(projectPath, 'manifest.json'),
    JSON.stringify({ version: 1, name: projectName }),
    'utf-8',
  );
  const stableProjectId = `spid_${crypto.randomBytes(12).toString('hex')}`;
  const projectRef = `prj_${crypto.randomBytes(16).toString('hex')}`;
  const synced = syncProjectScope({ stableProjectId, projectPath, projectRef });
  assert.ok(synced, 'project scope should be registered');
  return {
    projectPath,
    close: (): void => {
      removeProjectScope(stableProjectId);
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
};

/** 隔离存储根 + 空模型包目录（目录中唯一的生成模型就是被测声明）。 */
const setupTest = async (t: TestContext) => {
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  const previousPackagesDir = process.env['IART_MODEL_ASSET_PACKAGES_DIR'];
  const previousRelayEndpoint = process.env['IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT'];
  const previousToken = process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'overrides-seam-storage-'));
  const packagesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overrides-seam-packages-'));
  process.env['IART_STORAGE_ROOT'] = storageRoot;
  process.env['IART_MODEL_ASSET_PACKAGES_DIR'] = packagesDir;
  process.env['IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT'] = 'https://relay.example.invalid/upload';
  process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = HUB_WRITE_TOKEN;
  const clearCaches = (): void => {
    clearConnectionCache();
    clearActiveRouteCache();
    clearCustomGenerationModelCache();
  };
  clearCaches();
  const project = createOpenedProject('demo-overrides-generation');
  setBackendIpcTestHandler(async (message) => {
    if (message.type === 'runtime:execute-transaction') {
      return {
        type: 'runtime:transaction-result',
        transactionId: message.transactionId,
        success: true,
        data: null,
      };
    }
    if (message.type === 'runtime:write-task-event') {
      return {
        type: 'runtime:transaction-result',
        transactionId: message.transactionId,
        success: true,
        data: null,
      };
    }
    throw new Error(`unexpected IPC message type: ${message.type}`);
  });

  t.after(() => {
    setBackendIpcTestHandler(null);
    project.close();
    clearCaches();
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    if (previousPackagesDir === undefined) delete process.env['IART_MODEL_ASSET_PACKAGES_DIR'];
    else process.env['IART_MODEL_ASSET_PACKAGES_DIR'] = previousPackagesDir;
    if (previousRelayEndpoint === undefined) delete process.env['IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT'];
    else process.env['IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT'] = previousRelayEndpoint;
    if (previousToken === undefined) delete process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
    else process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = previousToken;
    fs.rmSync(storageRoot, { recursive: true, force: true });
    fs.rmSync(packagesDir, { recursive: true, force: true });
  });
  return { projectPath: project.projectPath };
};

const writeHeaders = (): Record<string, string> => ({
  'content-type': 'application/json',
  [HUB_LOCAL_WRITE_TOKEN_HEADER]: HUB_WRITE_TOKEN,
});

/** 单记录口径：带覆盖的能力属性 + 接入归属一次写入（openai-image-v1 连接 + 凭证）→ active route。 */
const seedDeclarationAndRouting = async (params: {
  modelId: string;
  parameterOverrides: ParameterOverrides;
}): Promise<void> => {
  const connection = createConnection({
    display_name: 'seam-overrides-upstream',
    base_url: CONNECTION_BASE_URL,
  });
  const credential = await setCredentialForConnection(connection.connection_id, CREDENTIAL_VALUE);
  assert.ok(credential, 'credential should be written');
  setConnectionCredential(connection.connection_id, credential.credentialRef, credential.version, true);
  const added = addCustomGenerationModel({
    model_id: params.modelId,
    connection_id: connection.connection_id,
    remote_model_id: REMOTE_MODEL_ID,
    family_adapter_id: 'openai-image-v1',
    supports_reference_image: false,
    parameter_overrides: params.parameterOverrides,
  });
  assert.equal(added.ok, true, 'declaration with overrides should be accepted by the real store');
  assert.equal(setActiveDeployment(params.modelId, added.model.record_id), added.model.record_id);
};

const getCatalogEntry = async (baseUrl: string, modelId: string) => {
  const catalogPayload: unknown = await (await fetch(`${baseUrl}/api/executable-model-catalog`)).json();
  const catalog = ExecutableModelCatalogResponseSchema.parse(catalogPayload);
  const entry = catalog.models.find((model) => model.model_id === modelId);
  assert.ok(entry, 'declared model with overrides must appear in the executable catalog');
  return entry;
};

const getProjectedPayloadRules = async (baseUrl: string, modelId: string): Promise<Record<string, unknown>> => {
  const payload: unknown = await (await fetch(`${baseUrl}/api/model-assets/node-projections`)).json();
  const response = ModelAssetNodeProjectionResponseSchema.parse(payload);
  const projection = response.projections.find((item) => item.model_id === modelId);
  assert.ok(projection, 'declared model with overrides must have a node projection');
  const runtime = projection.runtime;
  assert.ok(runtime, 'declared generation projection must carry runtime meta');
  assert.ok(runtime.payload_rules, 'declared generation projection must carry payload_rules');
  return runtime.payload_rules as Record<string, unknown>;
};

const submitAndWaitSucceeded = async (params: {
  baseUrl: string;
  projectPath: string;
  arguments: Record<string, unknown>;
  notifications: TaskStateNotification[];
}): Promise<void> => {
  const submitResponse = await fetch(`${params.baseUrl}/api/generation-batches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model_id: DECLARED_MODEL_ID,
      model_version: '1.0.0',
      prompt: '一只在窗台晒太阳的猫',
      arguments: params.arguments,
      task_count: 1,
      project_path: params.projectPath,
    }),
  });
  const submitPayload: unknown = await submitResponse.json();
  const accepted = PromptDockBatchSubmitResponseSchema.parse(submitPayload);
  assert.equal(accepted.tasks.length, 1);
  await waitFor(
    () => params.notifications.some((notification) => notification.task.status === 'succeeded'),
    `overrides task succeeded (statuses: ${params.notifications.map((n) => n.task.status).join(',') || '(none)'})`,
  );
};

const failureDetailOf = (notifications: TaskStateNotification[]): string => {
  const failed = notifications.find((n) => n.task.status === 'failed');
  if (!failed) return '(none)';
  const error = (failed.task as { error?: { code?: unknown; message?: unknown } | null }).error ?? null;
  return `${String(error?.code ?? 'unknown')}: ${String(error?.message ?? '').slice(0, 300)}`;
};

void test('接缝：覆盖声明经族模板合成进目录，别名/禁用/枚举/自定义键随请求体生效', async (t) => {
  const { projectPath } = await setupTest(t);
  await seedDeclarationAndRouting({ modelId: DECLARED_MODEL_ID, parameterOverrides: OVERRIDES_V1 });
  const baseUrl = await startServer(t);
  const capture = installNotificationCapture();
  const upstream = installSucceedingUpstreamStub({ generationBaseUrl: CONNECTION_BASE_URL });
  t.after(() => {
    upstream.restore();
    capture.restore();
  });

  // ① 目录条目：禁用字段消失、枚举被替换、默认值随覆盖、自定义参数入表单（合成顺序：先减后增）。
  const entry = await getCatalogEntry(baseUrl, DECLARED_MODEL_ID);
  const fieldKeys = entry.parameter_schema.fields.map((field) => field.fieldKey);
  assert.deepEqual(
    fieldKeys,
    ['size', 'quality', 'format', 'my_watermark'],
    'disabled moderation must disappear and the custom field must be appended last',
  );
  const quality = entry.parameter_schema.fields.find((field) => field.fieldKey === 'quality');
  assert.ok(quality);
  assert.deepEqual(
    (quality.enumOptions ?? []).map((option) => option.value),
    ['hd', 'standard'],
    'replaced enum options must reach the catalog',
  );
  const defaults = entry.parameter_schema.default_values ?? {};
  assert.equal(defaults['quality'], 'hd', 'overridden default must reach the catalog');
  assert.equal(defaults['my_watermark'], 'on', 'custom default must reach the catalog');
  assert.equal(defaults['moderation'], undefined);

  // ② node-projections 暴露改写后的 payload_rules（别名改键、禁用剪枝、自定义追加）。
  const payloadRules = await getProjectedPayloadRules(baseUrl, DECLARED_MODEL_ID);
  const aliasRule = payloadRules['body.image_size'];
  assert.ok(aliasRule, 'aliased wire key must appear in projected payload_rules');
  assert.equal((aliasRule as { field_key?: unknown }).field_key, 'size');
  assert.equal(payloadRules['body.size'], undefined, 'old wire key must be gone');
  assert.equal(payloadRules['body.moderation'], undefined, 'disabled field rule must be pruned');
  assert.ok(payloadRules['body.my_watermark'], 'custom field rule must be appended (serves both endpoint branches)');

  // ③ 真实提交：假上游收到形状正确的请求体（S1 别名 / S2 禁用 / S3 枚举 / S5 自定义）。
  await submitAndWaitSucceeded({
    baseUrl,
    projectPath,
    arguments: { size: 'auto', quality: 'hd', format: 'jpeg', my_watermark: 'on' },
    notifications: capture.notifications,
  }).catch((error: unknown) => {
    throw new Error(`submit failed; last failure detail: ${failureDetailOf(capture.notifications)}; cause: ${error instanceof Error ? error.message : String(error)}`);
  });
  assert.equal(upstream.requests.length, 1, 'exactly one upstream generation request');
  const requestBody = upstream.requests[0]?.body ?? {};
  assert.equal(requestBody['model'], REMOTE_MODEL_ID);
  assert.equal(requestBody['image_size'], 'auto', 'S1: aliased wire key must be sent');
  assert.equal(requestBody['size'], undefined, 'S1: old wire key must not be sent');
  assert.equal(requestBody['quality'], 'hd', 'S3: replaced enum value must be sent');
  assert.equal(requestBody['output_format'], 'jpeg');
  assert.equal(requestBody['my_watermark'], 'on', 'S5: custom parameter must be sent');
  assert.ok(!('moderation' in requestBody), 'S2: disabled parameter must not be sent');
});

void test('接缝：PUT 修改覆盖后目录与请求体随之更新（S6 编辑传播），非法覆盖保存被拒（S7）', async (t) => {
  const { projectPath } = await setupTest(t);
  await seedDeclarationAndRouting({ modelId: DECLARED_MODEL_ID, parameterOverrides: OVERRIDES_V1 });
  const baseUrl = await startServer(t);
  const capture = installNotificationCapture();
  const upstream = installSucceedingUpstreamStub({ generationBaseUrl: CONNECTION_BASE_URL });
  t.after(() => {
    upstream.restore();
    capture.restore();
  });

  // 前置：V1 覆盖已生效。
  const before = await getCatalogEntry(baseUrl, DECLARED_MODEL_ID);
  assert.ok(before.parameter_schema.fields.some((field) => field.fieldKey === 'my_watermark'));

  // S7：非法覆盖（别名撞保留键）保存被拒，原因可读。
  const illegalPut = await fetch(`${baseUrl}/api/custom-generation-models/${DECLARED_MODEL_ID}`, {
    method: 'PUT',
    headers: writeHeaders(),
    body: JSON.stringify({
      supports_reference_image: false,
      parameter_overrides: { official: [{ field_key: 'size', wire_name: 'model' }], custom: [] },
    }),
  });
  assert.equal(illegalPut.status, 400);
  const illegalBody: unknown = await illegalPut.json();
  assert.match(String((illegalBody as { message?: unknown }).message ?? ''), /重名/);
  // 被拒后目录保持 V1 形态（保存失败不产生半更新）。
  const afterIllegal = await getCatalogEntry(baseUrl, DECLARED_MODEL_ID);
  assert.ok(afterIllegal.parameter_schema.fields.some((field) => field.fieldKey === 'my_watermark'));

  // S6：PUT 合法新覆盖 → 目录重新投影反映新 schema（走既有投影失效链，不重启）。
  const put = await fetch(`${baseUrl}/api/custom-generation-models/${DECLARED_MODEL_ID}`, {
    method: 'PUT',
    headers: writeHeaders(),
    body: JSON.stringify({
      supports_reference_image: false,
      parameter_overrides: OVERRIDES_V2,
    }),
  });
  assert.equal(put.status, 200);

  const after = await getCatalogEntry(baseUrl, DECLARED_MODEL_ID);
  const fieldKeys = after.parameter_schema.fields.map((field) => field.fieldKey);
  assert.deepEqual(
    fieldKeys,
    ['size', 'quality', 'format', 'moderation'],
    'V2 overrides must restore moderation, drop the custom field and keep the aliased size',
  );
  const payloadRules = await getProjectedPayloadRules(baseUrl, DECLARED_MODEL_ID);
  assert.ok(payloadRules['body.img_size_v2'], 'new alias must appear in projected payload_rules');
  assert.equal(payloadRules['body.my_watermark'], undefined, 'removed custom field rule must be gone');

  // S6 尾段：新覆盖随下一次真实提交生效。
  await submitAndWaitSucceeded({
    baseUrl,
    projectPath,
    arguments: { size: 'auto', quality: 'auto', format: 'jpeg', moderation: 'auto' },
    notifications: capture.notifications,
  }).catch((error: unknown) => {
    throw new Error(`resubmit failed; last failure detail: ${failureDetailOf(capture.notifications)}; cause: ${error instanceof Error ? error.message : String(error)}`);
  });
  assert.equal(upstream.requests.length, 1, 'exactly one upstream generation request after the edit');
  const secondBody = upstream.requests[0]?.body ?? {};
  assert.equal(secondBody['img_size_v2'], 'auto', 'new alias must be sent after the edit');
  assert.equal(secondBody['image_size'], undefined);
  assert.equal(secondBody['my_watermark'], undefined, 'removed custom parameter must not be sent');
  assert.equal(secondBody['moderation'], 'auto', 're-enabled parameter must be sent again');
});
