import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  ExecutableModelCatalogResponseSchema,
  PromptDockBatchSubmitResponseSchema,
  TaskStateNotificationSchema,
  type GenerationMediaSlotId,
  type TaskStateNotification,
} from '@iart/contracts';
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
 * 自建生成模型「声明 × 族模板 → 合成投影 → 目录与执行主链」接缝测试
 *（docs/custom-providers/生成模型自建声明试点-design.md §3.1/§3.6，S1 验收场景的 backend 侧载体）。
 *
 * 使命：验证**真实**链路「真实声明 store 建声明 → 可执行目录条目包含声明模型 → 建接入与 active
 * → POST /api/generation-batches 真实受理与请求组装 → 假上游收到形状正确的请求（endpoint=模板
 * api_defaults、model=remote_model_id 注入、prompt 落在模板 prompt_field）→ 同步响应 → 媒体资产行
 * 产出随 succeeded 通知到达」。
 *
 * 真实边界外的替身只有两处（与 agent-tool-lineage.engineSeam 同一 bargain）：
 * - 上游网络走假 fetch：openai-image 同步接口返回带 `data[].b64_json` 的 ImagesResponse 形状
 *   （内联产物经真实 materializer 落盘，无需二次下载）。
 * - Backend→Main IPC（runtime 事务 / 任务事件）在测试处理器内拦截；process.send 通知出口接管为捕获。
 *
 * 红→绿自证：本测试先在「目录第二来源未接线」的实现上跑红（目录条目缺失、提交组装报
 * modelUnavailable），再随族模板 + 合成投影 + 目录接线转绿。
 */

const DECLARED_MODEL_ID = 'seam-declared-image';
const DECLARED_REF_MODEL_ID = 'seam-declared-image-ref';
const REMOTE_MODEL_ID = 'remote-seam-declared';
const CONNECTION_BASE_URL = 'https://seam-declared-upstream.example.invalid';
const CREDENTIAL_VALUE = 'sk-seam-declared-key';

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
    // 本地 HTTP 服务的请求（目录/提交路由）透传给真实 handler，只拦截生成上游。
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
    throw new Error('seam_server_address_unavailable');
  }
  return `http://127.0.0.1:${address.port}`;
};

const fetchJson = async (baseUrl: string, pathname: string, init?: RequestInit): Promise<unknown> => {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const payload: unknown = await response.json();
  return payload;
};

const createOpenedProject = (projectName: string) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'declared-gen-seam-'));
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
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'declared-gen-seam-storage-'));
  const packagesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'declared-gen-seam-packages-'));
  process.env['IART_STORAGE_ROOT'] = storageRoot;
  process.env['IART_MODEL_ASSET_PACKAGES_DIR'] = packagesDir;
  process.env['IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT'] = 'https://relay.example.invalid/upload';
  const clearCaches = (): void => {
    clearConnectionCache();
    clearActiveRouteCache();
    clearCustomGenerationModelCache();
  };
  clearCaches();
  const project = createOpenedProject('demo-declared-generation');
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
    fs.rmSync(storageRoot, { recursive: true, force: true });
    fs.rmSync(packagesDir, { recursive: true, force: true });
  });
  return { projectPath: project.projectPath };
};

/** 单记录口径：能力属性 + 接入归属一次写入（openai-image-v1 连接 + 凭证）→ active route。 */
const seedDeclarationAndRouting = async (params: { modelId: string; acceptedMediaSlots: GenerationMediaSlotId[] }): Promise<void> => {
  const connection = createConnection({
    display_name: 'seam-declared-upstream',
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
    accepted_media_slots: params.acceptedMediaSlots,
  });
  assert.equal(added.ok, true, 'declaration should be accepted by the real store');
  assert.equal(setActiveDeployment(params.modelId, added.model.record_id), added.model.record_id);
};

void test('接缝：自建生成模型经族模板进入可执行目录并走通提交→执行→产物主链（t2i）', async (t) => {
  const { projectPath } = await setupTest(t);
  await seedDeclarationAndRouting({ modelId: DECLARED_MODEL_ID, acceptedMediaSlots: [] });
  const baseUrl = await startServer(t);
  const capture = installNotificationCapture();
  const upstream = installSucceedingUpstreamStub({ generationBaseUrl: CONNECTION_BASE_URL });
  t.after(() => {
    upstream.restore();
    capture.restore();
  });

  // ① 目录第二来源：声明模型进入可执行目录（接线前必红）。
  const catalogPayload = await fetchJson(baseUrl, '/api/executable-model-catalog');
  const catalog = ExecutableModelCatalogResponseSchema.parse(catalogPayload);
  const entry = catalog.models.find((model) => model.model_id === DECLARED_MODEL_ID);
  assert.ok(entry, 'declared model must appear in the executable catalog');
  assert.equal(entry.deployment.deployable, true, 'declared model with active route must be deployable');
  assert.equal(entry.deployment.failure_code, 'none');
  assert.equal(entry.default_task_type, 'image');
  assert.deepEqual(entry.capability.output_modalities, ['image']);
  assert.deepEqual(
    entry.capability.input_modalities,
    ['text'],
    't2i-only declaration must not project image input capability',
  );
  const fieldKeys = entry.parameter_schema.fields.map((field) => field.fieldKey);
  assert.deepEqual(
    fieldKeys.filter((key) => key !== 'image'),
    ['size', 'quality', 'format', 'moderation'],
    'parameter form comes from the family template',
  );
  assert.ok(
    !fieldKeys.includes('image'),
    't2i-only declaration must not project the reference-image form field',
  );
  assert.ok(
    entry.parameter_schema.fields.every((field) => field.label.startsWith('model-asset/')),
    'labels must be namespaced localization keys projected by the shared localization path, not hardcoded copy',
  );

  // ② 真实提交：POST /api/generation-batches 走真实受理与请求组装。
  const submitResponse = await fetch(`${baseUrl}/api/generation-batches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model_id: DECLARED_MODEL_ID,
      model_version: '1.0.0',
      prompt: '一只在窗台晒太阳的猫',
      arguments: { size: 'auto', quality: 'auto', format: 'jpeg', moderation: 'auto' },
      task_count: 1,
      project_path: projectPath,
    }),
  });
  const submitPayload: unknown = await submitResponse.json();
  const accepted = PromptDockBatchSubmitResponseSchema.parse(submitPayload);
  assert.equal(accepted.tasks.length, 1);

  // ③ 执行主链：假上游收到形状正确的请求（endpoint=模板 api_defaults、model=注入、prompt=模板字段）。
  await waitFor(
    () => capture.notifications.some((notification) => notification.task.status === 'succeeded'),
    `declared-model task succeeded notification (captured statuses: ${capture.notifications.map((n) => n.task.status).join(',') || '(none)'}; last failure: ${(() => {
      const failed = capture.notifications.find((n) => n.task.status === 'failed');
      if (!failed) return '(none)';
      const error = (failed.task as { error?: { code?: unknown; message?: unknown } | null }).error ?? null;
      return `${String(error?.code ?? 'unknown')}: ${String(error?.message ?? '').slice(0, 300)}`;
    })()})`,
  );
  assert.equal(upstream.requests.length, 1, 'exactly one upstream generation request');
  const upstreamRequest = upstream.requests[0];
  if (!upstreamRequest) return;
  assert.equal(
    upstreamRequest.url,
    `${CONNECTION_BASE_URL}/v1/images/generations`,
    'endpoint must come from the family template api_defaults',
  );
  assert.equal(
    upstreamRequest.headers.get('authorization'),
    `Bearer ${CREDENTIAL_VALUE}`,
    'connection credential must be injected as bearer auth',
  );
  const requestBody = upstreamRequest.body ?? {};
  assert.equal(requestBody['model'], REMOTE_MODEL_ID, 'remote_model_id must be injected, not the product model_id');
  assert.notEqual(requestBody['model'], DECLARED_MODEL_ID);
  assert.equal(requestBody['prompt'], '一只在窗台晒太阳的猫', 'prompt must land in the template prompt field');
  assert.equal(requestBody['n'], 1);
  assert.equal(requestBody['size'], 'auto');
  assert.equal(requestBody['quality'], 'auto');
  assert.equal(requestBody['output_format'], 'jpeg', 'wire field must be output_format (official name), not format');
  assert.equal(requestBody['format'], undefined, 'wire must not carry the non-protocol format field');
  assert.equal(requestBody['moderation'], 'auto');
  assert.ok(!('image' in requestBody), 't2i request must not carry an image field');

  // ④ 结果物化：succeeded 通知携带媒体资产行（与在役模型同一投影语言）。
  const succeeded = capture.notifications.find((notification) => notification.task.status === 'succeeded');
  assert.ok(succeeded, 'succeeded notification must be captured');
  assert.ok(
    succeeded.outputs.some((output) => output.mediaType === 'image' && typeof output.assetId === 'string' && output.assetId),
    'succeeded notification must carry the materialized image output',
  );
  assert.ok(succeeded.mediaAssets.length > 0, 'succeeded notification must carry media assets');
});

void test('接缝：声明勾选参考图素材位时能力投影含图像输入（catalog 层）', async (t) => {
  await setupTest(t);
  await seedDeclarationAndRouting({ modelId: DECLARED_REF_MODEL_ID, acceptedMediaSlots: ['reference_image'] });
  const baseUrl = await startServer(t);

  const catalogPayload = await fetchJson(baseUrl, '/api/executable-model-catalog');
  const catalog = ExecutableModelCatalogResponseSchema.parse(catalogPayload);
  const entry = catalog.models.find((model) => model.model_id === DECLARED_REF_MODEL_ID);
  assert.ok(entry, 'reference-capable declared model must appear in the executable catalog');
  assert.ok(
    entry.capability.input_modalities.includes('image'),
    'reference_image media slot must project image input capability',
  );
  assert.equal(entry.capability.supports_reference_media, true);
  assert.ok(
    entry.parameter_schema.fields.some((field) => field.fieldKey === 'image'),
    'reference-capable declaration must project the reference-image form field',
  );
});
