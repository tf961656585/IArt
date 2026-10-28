import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { type TestContext } from 'node:test';

import {
  ExecutionSnapshotSchema,
  HUB_LOCAL_WRITE_TOKEN_ENV,
  HUB_LOCAL_WRITE_TOKEN_HEADER,
  type ExecutionSnapshot,
} from '@iart/contracts';
import { createRequestHandler } from '../router.cts';
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
import { clearCacheForTest as clearInterfaceFormatCache } from '../provider-connection/interface-format-store.cts';
import { clearCacheForTest as clearInterfaceRecipeCache } from '../provider-connection/interface-recipe-store.cts';

/**
 * 自定义接口格式执行链接缝的共用夹具（**测试专用**，非测试文件：node:test 不用它作入口）。
 *
 * 放入独立模块的原因：提交/轮询/结果获取/文本正文等接缝用例共享同一套隔离存储、真实路由
 * 服务、假 HTTP 上游与模型播种；每个用例文件各写一份会在环境清理与命名上漂移。
 */

export const HUB_WRITE_TOKEN = 'w'.repeat(32);
export const BASE_URL = 'https://custom-wire.example.invalid';
export const CREDENTIAL = 'sk-custom-wire-secret-value';
export const CONNECTION_DISPLAY_NAME = 'custom-wire-seam';

export type JsonRecord = Record<string, unknown>;

export type UpstreamCall = {
  url: URL;
  method: string;
  headers: Headers;
  bodyText: string | null;
};

export const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const readRecord = (value: unknown, message: string): JsonRecord => {
  assert.ok(isRecord(value), message);
  return value;
};

export const installFetch = (
  t: TestContext,
  responder: (call: UpstreamCall) => Response,
): { calls: UpstreamCall[] } => {
  const originalFetch = globalThis.fetch;
  const calls: UpstreamCall[] = [];
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const bodyText = typeof init?.body === 'string' ? init.body : null;
    const call: UpstreamCall = {
      url: new URL(rawUrl),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: new Headers(init?.headers ?? undefined),
      bodyText,
    };
    calls.push(call);
    return responder(call);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return { calls };
};

export const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export const withIsolatedEnv = (t: TestContext): string => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-wire-seam-'));
  const previousToken = process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  const previousLogLevel = process.env['IART_LOG_LEVEL'];
  process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = HUB_WRITE_TOKEN;
  process.env['IART_STORAGE_ROOT'] = tempRoot;
  // debug 级留痕：凭证脱敏断言必须建立在「日志真的写出来了」之上，不能空跑。
  process.env['IART_LOG_LEVEL'] = 'debug';
  clearInterfaceFormatCache();
  clearInterfaceRecipeCache();
  clearCustomGenerationModelCache();
  clearConnectionCache();
  clearActiveRouteCache();
  t.after(() => {
    if (previousToken === undefined) delete process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
    else process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = previousToken;
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    if (previousLogLevel === undefined) delete process.env['IART_LOG_LEVEL'];
    else process.env['IART_LOG_LEVEL'] = previousLogLevel;
    clearInterfaceFormatCache();
    clearInterfaceRecipeCache();
    clearCustomGenerationModelCache();
    clearConnectionCache();
    clearActiveRouteCache();
  });
  return tempRoot;
};

/** 读取本次测试写入的后端日志（验证凭证不落日志）。 */
export const readBackendLog = (storageRoot: string): string => {
  const logPath = path.join(storageRoot, 'logs', 'backend.log');
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
};

export const startRouterServer = async (t: TestContext): Promise<string> => {
  const server = http.createServer(createRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('custom_wire_seam_test_address_unavailable');
  }
  return `http://127.0.0.1:${address.port}`;
};

export const callHub = async (
  baseUrl: string,
  pathname: string,
  body: unknown,
): Promise<JsonRecord> => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [HUB_LOCAL_WRITE_TOKEN_HEADER]: HUB_WRITE_TOKEN,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as JsonRecord) : {};
  if (response.status !== 200) {
    const root = process.env['IART_STORAGE_ROOT'];
    const logPath = root ? path.join(root, 'logs', 'backend.log') : '';
    const log = logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
    assert.fail(`${pathname} failed: ${JSON.stringify(parsed)}\nbackend.log:\n${log}`);
  }
  return parsed;
};

export type FormatDraft = JsonRecord;

export const createFormat = async (baseUrl: string, draft: FormatDraft): Promise<JsonRecord> => {
  const created = await callHub(baseUrl, '/api/interface-formats', draft);
  assert.ok(typeof created['format_id'] === 'string', `format_id missing: ${JSON.stringify(created)}`);
  return created;
};

/** 固定请求头 + 固定查询参数 + 查询参数鉴权 + 模型嵌套落点的 JSON 格式。 */
export const jsonQueryFormatDraft = (displayName: string): FormatDraft => ({
  display_name: displayName,
  submit: {
    path: '/v1/custom/generate',
    method: 'POST',
    payload_format: 'json',
    content_type: 'application/json',
    auth: { kind: 'query_api_key', query_name: 'api_key' },
    headers: [{ name: 'X-Fixed-Header', value: 'fixed-value' }],
    query: [{ name: 'api_version', value: '2026-10-27' }],
    form_field_style: 'dotted',
    form_array_style: 'repeat',
  },
  model_binding: { location: 'body', path: 'config.model' },
  parameters: [
    {
      binding: { location: 'query', name: 'quality' },
      label: '画质',
      type: 'string',
      required: false,
      default_value: 'high',
    },
    {
      binding: { location: 'header', name: 'X-Param-Header' },
      label: '请求头参数',
      type: 'string',
      required: false,
      default_value: 'from-param',
    },
  ],
  prompt_binding: { location: 'body', path: 'prompt' },
  behavior: {
    result: { kind: 'direct_url', media_field_paths: ['data.0.url'], media_type: 'image' },
  },
});

export type SeededModel = {
  modelId: string;
  format: JsonRecord;
  connectionId: string;
};

/** 用一条已创建的格式落一条模型记录并设为 active（多处复用：给连接 + 凭证 + 记录）。 */
export const seedModelForFormat = async (
  format: JsonRecord,
  modelId: string,
): Promise<SeededModel> => {
  const connection = createConnection({ display_name: CONNECTION_DISPLAY_NAME, base_url: BASE_URL });
  const credential = await setCredentialForConnection(connection.connection_id, CREDENTIAL);
  assert.ok(credential, 'credential should be stored');
  if (!credential) throw new Error('credential setup failed');
  setConnectionCredential(connection.connection_id, credential.credentialRef, credential.version, true);
  const record = addCustomGenerationModel({
    model_id: modelId,
    connection_id: connection.connection_id,
    family_adapter_id: String(format['format_id']),
    remote_model_id: `remote-${modelId}`,
    ...(typeof format['recipe_id'] === 'string' ? { recipe_id: format['recipe_id'] } : {}),
  });
  assert.ok(record.ok, `generation model record should be created: ${JSON.stringify(record)}`);
  if (!record.ok) throw new Error('model setup failed');
  setActiveDeployment(modelId, record.model.record_id);
  return { modelId, format, connectionId: connection.connection_id };
};

export const seedFormatModel = async (
  t: TestContext,
  draft: FormatDraft,
  modelId: string,
): Promise<SeededModel> => {
  const baseUrl = await startRouterServer(t);
  const format = await createFormat(baseUrl, draft);
  return seedModelForFormat(format, modelId);
};

export const buildManualSnapshot = (params: {
  formatId: string;
  remoteModelId: string;
  credentialRef: string;
  auth: { kind: 'query_api_key'; query_name: string } | { kind: 'bearer'; header_name: string; prefix?: string };
}): ExecutionSnapshot =>
  ExecutionSnapshotSchema.parse({
    snapshot_id: `snap_custom_wire_${params.formatId}`,
    model_id: 'custom-wire-model',
    model_version: '1.0.0',
    deployment_id: 'up_dep_custom_wire',
    connection_id: 'up_conn_custom_wire',
    connection_revision: 1,
    protocol: {
      kind: 'generation_format',
      format_id: params.formatId,
      format_version: '1.0.0',
      auth: params.auth,
    },
    base_url: BASE_URL,
    remote_model_id: params.remoteModelId,
    credential_ref: params.credentialRef,
    credential_version: 1,
    resolved_endpoint: `${BASE_URL}/v1/custom/generate`,
    created_at: '2026-10-27T00:00:00.000Z',
  });
