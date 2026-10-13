// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecutableModelDirectoryEntry } from '@iart/contracts';
import { HubConfigResponseSchema } from '@iart/contracts';

import {
  EMPTY_PROMPT_DOCK_DRAFT,
  PROMPT_DOCK_DEFAULT_MODEL_ID,
  usePromptDockStore,
} from '@/features/promptdock/promptDockStore';
import { cjsImportAs, cjsRequireAs, sharedRequire } from './helpers/cjs-mock';
import {
  MemoryResponse,
  createMockRequest,
  isJsonObject,
  readJsonObjectProperty,
  type JsonObject,
  type MockRequest,
  type RouterModule,
} from './helpers/http-test-types';
import { clearIartsDataRoot, setIartsDataRoot } from './helpers/runtime-globals';

/**
 * 「Hub 设置生成默认模型 → 本机配置 → Editor 创作面预选」这条跨进程主链的接缝测试。
 *
 * 两端都是真实实现，只在外层挡掉网络与真实数据库：
 * - Backend 侧：真实 dist router（`createRequestHandler`）、真实 `/api/config` GET/PUT、
 *   真实 hub 本地写守卫（env token + header + loopback）、真实 `pickBackendConfigUpdate`
 *   白名单与归一、真实落盘到临时 storage root 的 `config/backend.json`；
 * - Editor 侧：真实 `promptDockStore`（`setCatalog` / `setGenerationDefaultModelId` 两个写入点），
 *   输入值就是上一步真实 GET 响应里的配置值，不在这里另造一个理想输入。
 *
 * 只有可执行目录是按 `PromptDockCatalogEntry` 真实形状手写的最小 fixture：目录来自
 * `GET /api/executable-model-catalog`（Runtime Backend 投影，需要真实模型能力包），
 * 不属于本用例要覆盖的「配置 → 预选」接缝，本用例只用它保证目录到达的两种真实顺序
 * （目录先到 / 配置先到）都被走到。
 *
 * 最脆的接缝是「目录与配置谁后到谁再试一次」：生成侧未设默认也要回落内置首选，
 * 于是目录先到时 `draft.modelId` 已经被自动预选填成非空，拿它当「用户选过」的守卫
 * 会把随后到达的配置静默吞掉。所以 fixture 目录刻意把「配置的模型」排在最后、
 * 内置首选排在中间——预选结果只能来自配置或内置首选，不可能是「取目录首个」的巧合。
 */

/* hub 本地写守卫：PUT /api/config 要求 env token + header + loopback 来源 */
const HUB_WRITE_TOKEN_ENV = 'IART_HUB_LOCAL_WRITE_TOKEN';
const HUB_WRITE_TOKEN_HEADER = 'x-iart-hub-write-token';
const HUB_WRITE_TOKEN = 'router-test-write-token-0123456789abcdef';
let previousHubWriteToken: string | undefined;

/** 主链上唯一的真实输入（Hub 侧写什么，本用例就写什么）；断言值一律从真实响应读回。 */
const CONFIGURED_MODEL_ID = 'seam-configured-image-model';
const CONFIGURED_MODEL_DEFAULT_ARGUMENTS = { size: 'seam-default-size' };

type StorageRootHintsModule = {
  resolveBackendConfigFilePath: () => string;
};

const requestJson = async (
  handler: (req: MockRequest, res: MemoryResponse) => Promise<void>,
  options: { method: string; url: string; body?: Record<string, unknown> },
) => {
  const rawBody = options.body ? Buffer.from(JSON.stringify(options.body), 'utf-8') : undefined;
  const req = createMockRequest({
    method: options.method,
    url: options.url,
    body: rawBody,
    headers: rawBody
      ? {
          'content-type': 'application/json',
          'content-length': String(rawBody.length),
          [HUB_WRITE_TOKEN_HEADER]: HUB_WRITE_TOKEN,
        }
      : {
          [HUB_WRITE_TOKEN_HEADER]: HUB_WRITE_TOKEN,
        },
  });
  (req as MockRequest & { socket: { remoteAddress: string } }).socket = {
    remoteAddress: '127.0.0.1',
  };

  const res = new MemoryResponse();
  const finished = Promise.withResolvers<void>();
  res.once('finish', finished.resolve);
  await handler(req, res);
  await finished.promise;

  return {
    status: res.statusCode,
    json: JSON.parse(res.body.toString('utf-8')) as JsonObject,
  };
};

/**
 * 读响应体里的 `string | null` 字段。
 *
 * 缺键返回 undefined 是有意的：改动前的旧 dist 里这个键根本不存在，
 * 报「undefined ≠ 期望值」比抛类型错更能说明是主链没接上。
 */
const readOptionalModelId = (source: JsonObject, key: string): string | null | undefined => {
  const value = source[key];
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return value;
  throw new Error(`expected string | null | undefined at ${key}, got ${typeof value}`);
};

const readJsonFileObject = (filePath: string): JsonObject => {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (!isJsonObject(parsed)) throw new Error(`expected JSON object at ${filePath}`);
  return parsed;
};

/**
 * 用 Hub 读配置的**同一份契约 schema** 解析真实响应。
 *
 * 真实链路里 Hub 的读取与保存都拿它 parse 响应；schema 与后端实际写出的形状不一致时，
 * 设置页会整份配置读不出来（保存也报错），而不是只有默认模型这一项坏掉。
 * 这里只读原始 JSON 是不够的——那正是上一轮接缝测试漏掉本缺陷的原因。
 */
const parseConfigResponse = (source: JsonObject) => {
  const parsed = HubConfigResponseSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `真实 /api/config 响应未通过 HubConfigResponseSchema：${JSON.stringify(parsed.error.issues)}`,
    );
  }
  return parsed.data;
};

const entry = (
  modelId: string,
  defaultValues: Record<string, unknown>,
): ExecutableModelDirectoryEntry => ({
  model_id: modelId,
  model_version: '1.0.0',
  default_task_type: 'image',
  capability: { input_modalities: ['text'], output_modalities: ['image'] },
  parameter_schema: { fields: [], required_fields: [], default_values: defaultValues },
  deployment: {
    has_active_deployment: true,
    active_deployment_id: 'dep_seam',
    deployable: true,
    failure_code: 'none',
  },
});

/** 配置的模型排在最后、内置首选排在中间（见文件头：让「取目录首个」无法冒充预选结果）。 */
const catalogFixture = (configuredModelId: string): ExecutableModelDirectoryEntry[] => [
  entry('seam-other-image-model', { size: 'other-default-size' }),
  entry(PROMPT_DOCK_DEFAULT_MODEL_ID, { size: 'builtin-default-size' }),
  entry(configuredModelId, CONFIGURED_MODEL_DEFAULT_ARGUMENTS),
];

const cancelDefaultCatalogFixture = (): ExecutableModelDirectoryEntry[] => [
  entry('seam-other-image-model', { size: 'other-default-size' }),
  entry(PROMPT_DOCK_DEFAULT_MODEL_ID, { size: 'builtin-default-size' }),
];

/** 创作面初始态（store 是模块级单例，用例之间必须显式复位）。 */
const resetPromptDockStore = () => {
  usePromptDockStore.setState({
    form: 'generate',
    draft: { ...EMPTY_PROMPT_DOCK_DRAFT, references: [] },
    catalog: [],
    catalogLoaded: false,
    generationDefaultModelId: null,
    generationModelChosen: false,
    submitting: false,
    preflightIssues: null,
  });
};

const loadRouterHandler = async () => {
  const router = await cjsImportAs<RouterModule>(
    '../../apps/backend/dist/local-server/router.cjs',
  );
  const storageHints = cjsRequireAs<StorageRootHintsModule>(
    sharedRequire('@iart/utils/storage-root-hints'),
  );
  return {
    handler: router.createRequestHandler({ baseDir: process.cwd() }),
    configFilePath: storageHints.resolveBackendConfigFilePath(),
  };
};

describe('生成默认模型接缝：Hub 配置 → 本机配置 → 创作面预选', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iarts-promptdock-generation-default-seam-'));
    setIartsDataRoot(path.join(tempRoot, 'storage'));
    previousHubWriteToken = process.env[HUB_WRITE_TOKEN_ENV];
    process.env[HUB_WRITE_TOKEN_ENV] = HUB_WRITE_TOKEN;
    resetPromptDockStore();
    vi.resetModules();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
    if (previousHubWriteToken === undefined) {
      delete process.env[HUB_WRITE_TOKEN_ENV];
    } else {
      process.env[HUB_WRITE_TOKEN_ENV] = previousHubWriteToken;
    }
    clearIartsDataRoot();
    resetPromptDockStore();
    vi.resetModules();
  });

  it('写入生成默认模型 → 真实回读（含落盘）→ 创作面两种到达顺序都预选出该模型', async () => {
    const { handler, configFilePath } = await loadRouterHandler();

    const saved = await requestJson(handler, {
      method: 'PUT',
      url: '/api/config',
      body: { generationDefaultModelId: CONFIGURED_MODEL_ID },
    });
    expect(saved.status).toBe(200);

    const readBack = await requestJson(handler, {
      method: 'GET',
      url: '/api/config',
    });
    expect(readBack.status).toBe(200);

    const savedModelId = readOptionalModelId(
      readJsonObjectProperty(saved.json, 'config'),
      'generationDefaultModelId',
    );
    const configuredModelId = readOptionalModelId(
      readJsonObjectProperty(readBack.json, 'config'),
      'generationDefaultModelId',
    );
    const resolvedModelId = readOptionalModelId(
      readJsonObjectProperty(readBack.json, 'resolved'),
      'generationDefaultModelId',
    );
    // 白名单漏收 / 归一改写 / 响应不投影，三处任一断链都在这里现形
    expect(savedModelId).toBe(CONFIGURED_MODEL_ID);
    expect(configuredModelId).toBe(CONFIGURED_MODEL_ID);
    expect(resolvedModelId).toBe(CONFIGURED_MODEL_ID);

    // 契约层：Hub 保存与读取都拿这份 schema parse 响应，两个方向都必须过
    const parsedSaved = parseConfigResponse(saved.json);
    const parsedReadBack = parseConfigResponse(readBack.json);
    expect(parsedSaved.config.generationDefaultModelId).toBe(CONFIGURED_MODEL_ID);
    expect(parsedReadBack.config.generationDefaultModelId).toBe(CONFIGURED_MODEL_ID);
    expect(parsedReadBack.resolved.generationDefaultModelId).toBe(CONFIGURED_MODEL_ID);

    // 落盘：配置真的写进了本机存储，而不是只活在进程内存里
    expect(fs.existsSync(configFilePath)).toBe(true);
    const onDisk = readJsonFileObject(configFilePath);
    expect(onDisk['generationDefaultModelId']).toBe(CONFIGURED_MODEL_ID);

    // 收窄用守卫（断言已在上面给出可读失败信息）：下面喂给 store 的值只来自真实响应
    if (configuredModelId !== CONFIGURED_MODEL_ID) {
      throw new Error(`期望回读到配置的模型，实际为 ${String(configuredModelId)}`);
    }

    const catalog = catalogFixture(configuredModelId);

    // 顺序 A：目录先到、配置后到。目录先到时按内置首选预选，配置到达必须把它改成配置的模型
    usePromptDockStore.getState().setCatalog(catalog);
    expect(usePromptDockStore.getState().draft.modelId).toBe(PROMPT_DOCK_DEFAULT_MODEL_ID);

    usePromptDockStore.getState().setGenerationDefaultModelId(configuredModelId);
    const afterCatalogFirst = usePromptDockStore.getState();
    expect(afterCatalogFirst.generationDefaultModelId).toBe(configuredModelId);
    expect(afterCatalogFirst.draft.modelId).toBe(configuredModelId);
    expect(afterCatalogFirst.draft.modelVersion).toBe('1.0.0');
    expect(afterCatalogFirst.draft.arguments).toEqual(CONFIGURED_MODEL_DEFAULT_ARGUMENTS);

    // 顺序 B：配置先到、目录后到（配置先记下，目录到达时再试一次预选）
    resetPromptDockStore();
    usePromptDockStore.getState().setGenerationDefaultModelId(configuredModelId);
    expect(usePromptDockStore.getState().draft.modelId).toBeNull();

    usePromptDockStore.getState().setCatalog(catalog);
    const afterConfigFirst = usePromptDockStore.getState();
    expect(afterConfigFirst.draft.modelId).toBe(configuredModelId);
    expect(afterConfigFirst.draft.modelVersion).toBe('1.0.0');
    expect(afterConfigFirst.draft.arguments).toEqual(CONFIGURED_MODEL_DEFAULT_ARGUMENTS);
  });

  it('取消默认（PUT null）→ 回读 null → 创作面按内置首选预选', async () => {
    const { handler, configFilePath } = await loadRouterHandler();

    const saved = await requestJson(handler, {
      method: 'PUT',
      url: '/api/config',
      body: { generationDefaultModelId: null },
    });
    expect(saved.status).toBe(200);

    const readBack = await requestJson(handler, {
      method: 'GET',
      url: '/api/config',
    });
    expect(readBack.status).toBe(200);

    const savedModelId = readOptionalModelId(
      readJsonObjectProperty(saved.json, 'config'),
      'generationDefaultModelId',
    );
    const configuredModelId = readOptionalModelId(
      readJsonObjectProperty(readBack.json, 'config'),
      'generationDefaultModelId',
    );
    const resolvedModelId = readOptionalModelId(
      readJsonObjectProperty(readBack.json, 'resolved'),
      'generationDefaultModelId',
    );
    // 「取消默认」是写 null，不是不发这个字段：回读必须仍是 null（而不是键消失或留空串）
    expect(savedModelId).toBeNull();
    expect(configuredModelId).toBeNull();
    expect(resolvedModelId).toBeNull();

    // 契约层：没设默认时后端如实回 null，schema 必须接受它（否则 Hub 整份配置读不出来）
    const parsedSaved = parseConfigResponse(saved.json);
    const parsedReadBack = parseConfigResponse(readBack.json);
    expect(parsedSaved.config.generationDefaultModelId).toBeNull();
    expect(parsedReadBack.config.generationDefaultModelId).toBeNull();
    expect(parsedReadBack.resolved.generationDefaultModelId).toBeNull();

    const onDisk = readJsonFileObject(configFilePath);
    expect(onDisk['generationDefaultModelId']).toBeNull();

    const catalog = cancelDefaultCatalogFixture();
    // 与 PromptDock.tsx 读配置同口径（`payload.config.generationDefaultModelId ?? null`）：
    // 缺键也按「没设默认」处理，这里照样只把真实回读值喂进 store
    const noDefaultModelId = configuredModelId ?? null;

    // 顺序 A：目录先到、配置（null）后到
    usePromptDockStore.getState().setCatalog(catalog);
    expect(usePromptDockStore.getState().draft.modelId).toBe(PROMPT_DOCK_DEFAULT_MODEL_ID);

    usePromptDockStore.getState().setGenerationDefaultModelId(noDefaultModelId);
    const afterCatalogFirst = usePromptDockStore.getState();
    expect(afterCatalogFirst.generationDefaultModelId).toBeNull();
    expect(afterCatalogFirst.draft.modelId).toBe(PROMPT_DOCK_DEFAULT_MODEL_ID);
    expect(afterCatalogFirst.draft.arguments).toEqual({ size: 'builtin-default-size' });

    // 顺序 B：配置（null）先到、目录后到
    resetPromptDockStore();
    usePromptDockStore.getState().setGenerationDefaultModelId(noDefaultModelId);
    expect(usePromptDockStore.getState().draft.modelId).toBeNull();

    usePromptDockStore.getState().setCatalog(catalog);
    const afterConfigFirst = usePromptDockStore.getState();
    expect(afterConfigFirst.draft.modelId).toBe(PROMPT_DOCK_DEFAULT_MODEL_ID);
    expect(afterConfigFirst.draft.arguments).toEqual({ size: 'builtin-default-size' });
  });
});
