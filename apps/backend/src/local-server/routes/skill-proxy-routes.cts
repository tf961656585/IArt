/**
 * skill 代理路由。
 *
 * spec: docs/hub/skill-store.md（信任边界与缓解措施）
 *
 * 暴露两个端点供已安装的 skill bash 调用：
 *   POST /api/skill/images/generations
 *   POST /api/skill/images/edits
 *
 * 信任模型（无 token，不进 hub-local-write-policy）：
 *   - loopback（backend 只监听 127.0.0.1）
 *   - endpoint 白名单（只这两个路径）
 *   - 模型白名单（x-iart-model-id 头，只 gpt-image-2）
 *   - 拒绝带 Origin 头的请求（掐断浏览器途经；skill 走 curl 不带 Origin）
 *
 * 端点与 Key 注入：与任务主链同源——按模型解析 active deployment 得到 ExecutionSnapshot
 * （服务商连接的 base_url + 协议适配器 + 凭证引用），经 CredentialLease 取出凭证明文，
 * 再按适配器声明注入鉴权头（不写死网关地址，也不猜测鉴权头形态）。
 * 转发：全量缓冲 raw body 后原样转发（保留 content-type 含 multipart boundary，
 * 不解析重组），重设 Content-Length。不设超时、不重试。
 */

import type * as http from 'node:http';

import { buildAdapterAuthHeader } from '@iart/contracts';

import { ERROR_CODES } from '../constants.cts';
import { sendJson, readBody } from '../http-utils.cts';
import { getFetchDispatcher } from '../fetch-dispatcher.cts';
import type { HeadersRecord, RouteDefinition } from '../http/route-registry.cts';
import * as loggingModule from '../logging.cts';
import { getAdapter } from '../protocol-adapter/adapter-registry.cts';
import { buildExecutionSnapshot } from '../provider-connection/execution-snapshot.cts';
import { acquireLease, releaseLease } from '../provider-connection/credential-store.cts';

// 模型白名单：只允许 gpt-image 模型。
const SKILL_ALLOWED_MODEL_IDS: ReadonlySet<string> = new Set(['gpt-image-2']);

type RouteHandleParams = Parameters<RouteDefinition['handle']>[0];

/**
 * 判定并拒绝带 Origin 头的请求。
 *
 * spec 信任边界：backend CORS 对任意 Origin 回显，暴露面含任意网页经用户浏览器。
 * skill 走 curl 不带 Origin，拒绝 Origin 即掐断浏览器途经，不影响 skill。
 *
 * 返回 true 表示已拒绝（已写入 403 响应），调用方应 return。
 */
const rejectOriginHeader = (req: http.IncomingMessage, res: http.ServerResponse, corsHeaders: HeadersRecord): boolean => {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.trim()) {
    sendJson(
      res,
      403,
      { error: 'Origin header not allowed on skill proxy endpoint', code: ERROR_CODES.FORBIDDEN },
      corsHeaders,
    );
    return true;
  }
  return false;
};

/**
 * 从 x-iart-model-id 头取模型名并校验白名单。
 *
 * 返回 [modelId, ok]。ok=false 表示已拒绝（已写入响应）。
 */
const extractAllowedModelId = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  corsHeaders: HeadersRecord,
): [string, boolean] => {
  const rawModel = req.headers['x-iart-model-id'];
  const modelId = typeof rawModel === 'string' ? rawModel.trim() : '';
  if (!modelId) {
    sendJson(
      res,
      400,
      { error: 'Missing x-iart-model-id header', code: ERROR_CODES.INVALID_CONFIG },
      corsHeaders,
    );
    return ['', false];
  }
  if (!SKILL_ALLOWED_MODEL_IDS.has(modelId)) {
    sendJson(
      res,
      400,
      { error: `Model not in skill allowlist: ${modelId}`, code: ERROR_CODES.INVALID_CONFIG },
      corsHeaders,
    );
    return [modelId, false];
  }
  return [modelId, true];
};

/**
 * 解析出的 skill 代理上游：端点、鉴权头与租约。
 *
 * leaseId 由调用方在转发结束后释放（长时租约语义属于任务主链）。
 */
type SkillUpstream = {
  baseUrl: string;
  authHeaderName: string;
  authHeaderValue: string;
  leaseId: string;
};

/**
 * 解析 skill 代理的目标端点与鉴权头。
 *
 * 与任务主链同源：模型的 active deployment → ExecutionSnapshot → CredentialLease。
 * 未接入服务商、凭证不可读或适配器缺失时返回 null——调用方返回明确错误，不猜端点、
 * 不回退到任何写死的网关。
 */
const resolveSkillUpstream = async (modelId: string): Promise<SkillUpstream | null> => {
  const snapshotResult = buildExecutionSnapshot({ modelId });
  if (!snapshotResult.ok) {
    loggingModule.logDebug('skill-proxy: no execution snapshot for model', {
      modelId,
      code: snapshotResult.code,
      message: snapshotResult.message,
    });
    return null;
  }
  const { snapshot } = snapshotResult;
  const credentialRef = snapshot.credential_ref;
  if (!credentialRef) {
    loggingModule.logDebug('skill-proxy: snapshot carries no credential ref', {
      modelId,
      connectionId: snapshot.connection_id,
    });
    return null;
  }
  const adapter = getAdapter(snapshot.adapter_id);
  if (!adapter) {
    loggingModule.logDebug('skill-proxy: adapter not found', {
      modelId,
      adapterId: snapshot.adapter_id,
    });
    return null;
  }
  const leaseResult = await acquireLease({
    connectionId: snapshot.connection_id,
    credentialRef,
    credentialVersion: typeof snapshot.credential_version === 'number' ? snapshot.credential_version : 0,
    connectionRevision: snapshot.connection_revision,
  });
  if (!leaseResult) {
    loggingModule.logDebug('skill-proxy: acquireLease failed', { modelId, credentialRef });
    return null;
  }
  const authHeader = buildAdapterAuthHeader(adapter.auth, leaseResult.value);
  return {
    baseUrl: snapshot.base_url,
    authHeaderName: authHeader.name,
    authHeaderValue: authHeader.value,
    leaseId: leaseResult.lease.leaseId,
  };
};

/**
 * 转发请求到网关。
 *
 * 全量缓冲 raw body（readBody），原样转发（保留 content-type 含 multipart boundary，
 * 不解析重组）。fetch 自动按 body 字节设置 Content-Length。不设超时（getFetchDispatcher()）。
 */
const forwardToGateway = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  modelId: string,
  skillUpstream: SkillUpstream,
  endpointPath: string,
  corsHeaders: HeadersRecord,
): Promise<void> => {
  // 缓冲 raw body（图生图多图场景的 multipart 也整体缓冲，spec 明确为有意识选择）
  const bodyBuffer = (await readBody(req)) as Buffer | null;

  // 构建转发 headers：保留原 content-type（含 boundary），去掉 hop-by-hop 头
  const headers = new Headers();
  const contentType = req.headers['content-type'];
  if (typeof contentType === 'string') {
    headers.set('content-type', contentType);
  }
  headers.set(skillUpstream.authHeaderName, skillUpstream.authHeaderValue);
  // body.model 由 skill 在 json/multipart 中已设置；上游按 body 内容路由。
  // modelId 经白名单校验已确认合法。

  const targetUrl = `${skillUpstream.baseUrl.replace(/\/+$/, '')}${endpointPath}`;
  const proxyRequestId = `skill-proxy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  loggingModule.logDebug('skill-proxy: forwarding to gateway', {
    requestId: proxyRequestId,
    endpoint: endpointPath,
    modelId,
    bodyBytes: bodyBuffer ? bodyBuffer.length : 0,
  });

  let upstream: Response;
  try {
    const proxyFetchOptions: RequestInit & { dispatcher: unknown | undefined } = {
      method: req.method || 'POST',
      headers,
      ...(bodyBuffer && bodyBuffer.length > 0 ? { body: bodyBuffer as BodyInit } : {}),
      dispatcher: getFetchDispatcher(),
    };
    upstream = await fetch(targetUrl, proxyFetchOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    loggingModule.logWarn('skill-proxy: gateway fetch failed', {
      requestId: proxyRequestId,
      endpoint: endpointPath,
      error: message,
    });
    sendJson(
      res,
      502,
      { error: `Gateway request failed: ${message}`, code: ERROR_CODES.UPSTREAM_FAILED },
      corsHeaders,
    );
    return;
  }

  // 响应原样回传：状态码、content-type、body
  const upstreamBuffer = Buffer.from(await upstream.arrayBuffer());
  const responseHeaders: Record<string, string> = { ...corsHeaders };
  const upstreamContentType = upstream.headers.get('content-type');
  if (upstreamContentType) {
    responseHeaders['content-type'] = upstreamContentType;
  }
  res.writeHead(upstream.status, responseHeaders);
  res.end(upstreamBuffer);
};

/**
 * 通用 skill 代理 handler。
 *
 * endpointPath 形如 /v1/images/generations 或 /v1/images/edits。
 */
const handleSkillImageProxy = async (
  { req, res, corsHeaders }: RouteHandleParams,
  endpointPath: string,
): Promise<void> => {
  // 1. 拒绝带 Origin 头的请求（掐断浏览器途经）
  if (rejectOriginHeader(req, res, corsHeaders)) return;

  // 2. 只接受 POST
  if (req.method !== 'POST') {
    sendJson(
      res,
      405,
      { error: 'Method not allowed', code: ERROR_CODES.METHOD_NOT_ALLOWED },
      { ...corsHeaders, Allow: 'POST' },
    );
    return;
  }

  // 3. 模型白名单校验
  const [modelId, modelOk] = extractAllowedModelId(req, res, corsHeaders);
  if (!modelOk) return;

  // 4. 解析该模型的服务商端点与鉴权（active deployment → 执行快照 → 凭证租约）
  const upstream = await resolveSkillUpstream(modelId);
  if (!upstream) {
    sendJson(
      res,
      503,
      {
        error: 'Skill model has no usable provider connection; add a provider and model deployment in settings',
        code: ERROR_CODES.UPSTREAM_FAILED,
      },
      corsHeaders,
    );
    return;
  }

  // 5. 转发；租约在转发结束后释放
  try {
    await forwardToGateway(req, res, modelId, upstream, endpointPath, corsHeaders);
  } finally {
    releaseLease(upstream.leaseId);
  }
};

const createSkillProxyRoutes = (): RouteDefinition[] => [
  {
    name: 'skill-images-generations',
    match: ({ pathname }) => pathname === '/api/skill/images/generations',
    handle: (context) => handleSkillImageProxy(context, '/v1/images/generations'),
  },
  {
    name: 'skill-images-edits',
    match: ({ pathname }) => pathname === '/api/skill/images/edits',
    handle: (context) => handleSkillImageProxy(context, '/v1/images/edits'),
  },
];

export { createSkillProxyRoutes, SKILL_ALLOWED_MODEL_IDS };

// 测试导出
export const __test_only__ = {
  rejectOriginHeader,
  extractAllowedModelId,
  resolveSkillUpstream,
};
