import * as crypto from 'node:crypto';
import {
  ExecutionSnapshotSchema,
  type ExecutionSnapshot,
  type BatchIntentSnapshot,
} from '@iart/contracts';
import { getConnection } from './connection-store.cts';
import { getActiveDeploymentId, resolveActiveTarget, type ActiveRouteTarget } from './active-route-store.cts';
import { getAdapter } from '../protocol-adapter/adapter-registry.cts';
import { getCredentialVersion } from './credential-store.cts';
import * as loggingModule from '../logging.cts';

/**
 * ExecutionSnapshot 构建器（spec 03 §8 / spec 45 §5.2）。
 *
 * - 派发时解析 active 接入记录（deployment 或自建模型记录，双查见 active-route-store），
 *   冻结模型协议·连接·Base URL·remote_model_id·凭据版本
 *   （2026-09-26 起协议归属模型级：adapter_id 按模型解析——自建记录自带协议字段、已装包
 *   模型按封闭族正则表；记录无协议即显式失败，2026-09-29 起连接不再承载接口类型预选）
 * - 未派发的任务读取当时 active，已开始请求的任务不漂移
 * - 远程受理后轮询/取消/结果只按同一快照
 * - `deployment_id` 语义为「active 接入记录 id」：已装包模型为 ModelDeployment id，
 *   自建模型为其模型记录 id（两类 id 同用 `up_dep_` 前缀）
 */

const normalizeModelId = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const generateSnapshotId = (): string => {
  const rand = crypto.randomBytes(6).toString('hex').toLowerCase();
  const ts = Date.now().toString(36).toLowerCase();
  return `snap_${ts}_${rand}`;
};

type BuildSnapshotResult =
  | { ok: true; snapshot: ExecutionSnapshot }
  | { ok: false; code: string; message: string };

const ERROR_CODES_MAP = {
  NO_ACTIVE: 'no_active_deployment',
  DEPLOYMENT_NOT_FOUND: 'deployment_not_found',
  CONNECTION_NOT_FOUND: 'connection_not_found',
  CONNECTION_NOT_ENABLED: 'connection_not_enabled',
  CREDENTIAL_MISSING: 'credential_missing',
  ADAPTER_NOT_FOUND: 'adapter_not_found',
  REMOTE_MODEL_MISSING: 'remote_model_missing',
} as const;

const buildExecutionSnapshot = (params: {
  modelId: string;
  batchIntent?: BatchIntentSnapshot | null;
}): BuildSnapshotResult => {
  const modelId = normalizeModelId(params.modelId);
  if (!modelId) {
    return { ok: false, code: ERROR_CODES_MAP.NO_ACTIVE, message: 'model_id is required' };
  }
  const activeDeploymentId = getActiveDeploymentId(modelId);
  if (!activeDeploymentId) {
    loggingModule.logDebug('[execution-snapshot] no active deployment', { modelId });
    return { ok: false, code: ERROR_CODES_MAP.NO_ACTIVE, message: `model ${modelId} has no active deployment` };
  }
  // 解析 active 接入记录（deployment 或自建模型记录，双查）：两类记录投影为同一形状
  const access: ActiveRouteTarget | null = resolveActiveTarget(modelId);
  if (!access) {
    loggingModule.logDebug('[execution-snapshot] active access record not found', { modelId, activeDeploymentId });
    return { ok: false, code: ERROR_CODES_MAP.DEPLOYMENT_NOT_FOUND, message: `active access record not found: ${activeDeploymentId}` };
  }
  if (access.model_id !== modelId) {
    loggingModule.logDebug('[execution-snapshot] access record model mismatch', { modelId, recordModelId: access.model_id });
    return { ok: false, code: ERROR_CODES_MAP.DEPLOYMENT_NOT_FOUND, message: 'active access record model mismatch' };
  }
  const connection = getConnection(access.connection_id);
  if (!connection) {
    loggingModule.logDebug('[execution-snapshot] connection not found', { deploymentId: access.target_id, connectionId: access.connection_id });
    return { ok: false, code: ERROR_CODES_MAP.CONNECTION_NOT_FOUND, message: `connection not found: ${access.connection_id}` };
  }
  if (connection.lifecycle !== 'enabled') {
    loggingModule.logDebug('[execution-snapshot] connection not enabled', { connectionId: connection.connection_id, lifecycle: connection.lifecycle });
    return { ok: false, code: ERROR_CODES_MAP.CONNECTION_NOT_ENABLED, message: `connection lifecycle is ${connection.lifecycle}` };
  }
  if (!connection.has_credential || !connection.credential_ref) {
    loggingModule.logDebug('[execution-snapshot] credential missing', { connectionId: connection.connection_id });
    return { ok: false, code: ERROR_CODES_MAP.CREDENTIAL_MISSING, message: 'connection credential missing' };
  }
  // 协议由模型自带（2026-09-26 起协议归属模型级；2026-09-29 起连接不再承载接口类型预选）：
  // 自建记录携带协议字段、已装包模型按 model_id 封闭族正则表在 active-route 解析时回填。
  // 记录无协议即显式失败——连接遗留键不再是协议来源，连接默认预选从来不是协议事实源。
  const modelProtocolAdapterId = access.protocol_adapter_id;
  if (!modelProtocolAdapterId) {
    loggingModule.logDebug('[execution-snapshot] model protocol unresolved (record has no protocol adapter)', {
      modelId,
      source: access.source,
      connectionId: connection.connection_id,
    });
    return {
      ok: false,
      code: ERROR_CODES_MAP.ADAPTER_NOT_FOUND,
      message: `model ${modelId} has no protocol adapter`,
    };
  }
  const adapter = getAdapter(modelProtocolAdapterId);
  if (!adapter) {
    loggingModule.logDebug('[execution-snapshot] adapter not found', { adapterId: modelProtocolAdapterId });
    return { ok: false, code: ERROR_CODES_MAP.ADAPTER_NOT_FOUND, message: `adapter not found: ${modelProtocolAdapterId}` };
  }
  const remoteModelId = access.remote_model_id.trim();
  if (!remoteModelId) {
    loggingModule.logDebug('[execution-snapshot] remote_model_id missing', { deploymentId: access.target_id });
    return { ok: false, code: ERROR_CODES_MAP.REMOTE_MODEL_MISSING, message: 'access record remote_model_id missing' };
  }
  // 解析 endpoint：base_url + adapter relative endpoint（冻结版本与连接，前瞻占位）
  // 各适配器 payload 形态不同（openai: generations/edits、gemini: interactions、seedance: tasks、veo: predictLongRunning），
  // 快照的 resolved_endpoint 仅为"连接+适配器版本"冻结锚点，真实请求 endpoint 由 request-assembler 按 payloadFormat/mode 再决算；
  // 此处按适配器选择最常用相对路径作为占位，避免跨适配器硬编码 generations 造成快照可读性偏差（后续阶段3由 request-assembler 回填精确 endpoint）。
  const baseUrl = connection.base_url;
  const adapterVersion = adapter.version;
  const pickDefaultRelative = (): string => {
    const rel = adapter.relative_endpoints ?? {};
    if (adapter.adapter_id === 'openai-image-v1') return rel.generations ?? '/v1/images/generations';
    if (adapter.adapter_id === 'gemini-image-interactions-v1') return rel.interactions ?? '/v1beta/interactions';
    if (adapter.adapter_id === 'seedance-2-0-v1') return rel.tasks ?? '/api/v3/contents/generations/tasks';
    if (adapter.adapter_id === 'veo-v1') return rel.predictLongRunning ?? '/v1beta/models/{model}:predictLongRunning';
    // fallback：取首个可用相对路径
    const first = Object.values(rel).find((v): v is string => typeof v === 'string' && Boolean(v.trim()));
    return first ?? '/v1/images/generations';
  };
  const resolvedEndpoint = `${baseUrl.replace(/\/+$/, '')}${pickDefaultRelative()}`;
  const credentialVersion = getCredentialVersion(connection.credential_ref) ?? connection.credential_version ?? 0;
  // model_version 取自 batchIntent 或固定占位
  const modelVersion = params.batchIntent?.model_version ?? '1.0.0';
  const now = new Date().toISOString();
  const snapshotId = generateSnapshotId();
  const candidate: ExecutionSnapshot = {
    snapshot_id: snapshotId,
    model_id: modelId,
    model_version: modelVersion,
    deployment_id: access.target_id,
    connection_id: connection.connection_id,
    connection_revision: connection.revision,
    adapter_id: adapter.adapter_id,
    adapter_version: adapterVersion,
    base_url: baseUrl,
    remote_model_id: remoteModelId,
    credential_ref: connection.credential_ref,
    credential_version: credentialVersion,
    resolved_endpoint: resolvedEndpoint,
    resolved_params: undefined,
    created_at: now,
  };
  const parsed = ExecutionSnapshotSchema.safeParse(candidate);
  if (!parsed.success) {
    loggingModule.logDebug('[execution-snapshot] schema invalid', { error: parsed.error.message, candidate });
    return { ok: false, code: 'snapshot_invalid', message: parsed.error.message };
  }
  return { ok: true, snapshot: parsed.data };
};

const isSnapshotStillValid = (snapshot: ExecutionSnapshot): { valid: boolean; reason?: string } => {
  const connection = getConnection(snapshot.connection_id);
  if (!connection) return { valid: false, reason: 'connection not found (retired)' };
  // 即使 connection 已 retired，已有快照的远程已受理任务可继续查询（spec 5.3 租约保留）
  // 此处只校验必要字段是否仍可读
  if (connection.revision !== snapshot.connection_revision) {
    loggingModule.logDebug('[execution-snapshot] connection revision drift (snapshot frozen)', {
      snapshotId: snapshot.snapshot_id,
      snapshotRevision: snapshot.connection_revision,
      currentRevision: connection.revision,
    });
  }
  return { valid: true };
};

export {
  buildExecutionSnapshot,
  isSnapshotStillValid,
  generateSnapshotId,
  type BuildSnapshotResult,
};
