import * as crypto from 'node:crypto';
import {
  ExecutionSnapshotSchema,
  type ExecutionSnapshot,
  type BatchIntentSnapshot,
} from '@iart/contracts';
import { getConnection } from './connection-store.cts';
import {
  getActiveRoutes,
  resolveActiveTargetRecord,
  type ActiveRouteTarget,
} from './active-route-store.cts';
import { getAdapter } from '../protocol-adapter/adapter-registry.cts';
import { getCredentialVersion } from './credential-store.cts';
import * as loggingModule from '../logging.cts';

/**
 * ExecutionSnapshot 构建器（spec 03 §8 / spec 45 §5.2）。
 *
 * - 派发时解析 active 接入记录（只有模型记录一种载体，见 active-route-store），冻结模型协议·
 *   连接·Base URL·remote_model_id·凭据版本
 *   （2026-09-26 起协议归属模型级：adapter_id 只按模型记录自带的协议字段解析；记录无协议即
 *   显式失败，2026-09-29 起连接不再承载接口类型预选，也不按 model_id 名称或正则推断）
 * - 未派发的任务读取当时 active，已开始请求的任务不漂移
 * - 远程受理后轮询/取消/结果只按同一快照
 * - `deployment_id` 语义为「active 接入记录 id」，即该模型的记录 id（字段名沿用，2026-10-19
 *   部署载体退场后不再有第二种取值）
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
  /**
   * active 路由指向的接入记录找不到（记录的删除与 active route 清理之间被读到的瞬间）。
   *
   * 2026-10-19 由 `deployment_not_found` 改名：部署载体已退场，失败的语义是「接入目标不见了」，
   * 与「没有 active 接入目标」（`no_active_deployment`）是两件事。`no_active_deployment` 的
   * 取值沿用既有字符串——它已跨进程分发到任务记录与 Editor 文案表，改名会打断已落库的
   * 历史任务记录；但它的**语义**已是「模型没有 active 接入目标」（spec 03 §9）。
   */
  ACCESS_TARGET_NOT_FOUND: 'access_target_not_found',
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
  // 先读 active 路由**原始映射**（不先做存活性过滤）：这样「路由为空」与「路由指向的记录已不在」
  // 是两条可分辨的失败，各有自己的原因码。若先走 getActiveDeploymentId（它会把 stale 映射折成
  // null），下面那条 ACCESS_TARGET_NOT_FOUND 就永远不可达——一条永远不触发的判据比没有更糟。
  const activeRecordId = getActiveRoutes()[modelId];
  if (!activeRecordId) {
    loggingModule.logDebug('[execution-snapshot] no active access target', { modelId });
    return { ok: false, code: ERROR_CODES_MAP.NO_ACTIVE, message: `model ${modelId} has no active access target` };
  }
  // 解析 active 接入记录（两族模型记录两查，投影为同一形状）
  const access: ActiveRouteTarget | null = resolveActiveTargetRecord(activeRecordId);
  if (!access) {
    loggingModule.logDebug('[execution-snapshot] active access record not found', { modelId, activeRecordId });
    return { ok: false, code: ERROR_CODES_MAP.ACCESS_TARGET_NOT_FOUND, message: `active access record not found: ${activeRecordId}` };
  }
  if (access.model_id !== modelId) {
    loggingModule.logDebug('[execution-snapshot] access record model mismatch', { modelId, recordModelId: access.model_id });
    return { ok: false, code: ERROR_CODES_MAP.ACCESS_TARGET_NOT_FOUND, message: 'active access record model mismatch' };
  }
  const connection = getConnection(access.connection_id);
  if (!connection) {
    loggingModule.logDebug('[execution-snapshot] connection not found', { recordId: access.target_id, connectionId: access.connection_id });
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
  // 协议由模型记录自带（2026-09-26 起协议归属模型级；2026-09-29 起连接不再承载接口类型预选）：
  // 两族记录的 schema 都要求协议字段必填，active route 投影因此恒有值。下面这次判空是执行边界的
  // 兜底（记录被外部改坏时不静默放行），不是「未命中原生正则」的分支——那类解析已随部署载体
  // 退场消失（spec 03 §8：不存在按 model_id 名称或正则推断协议）。
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
    loggingModule.logDebug('[execution-snapshot] remote_model_id missing', { recordId: access.target_id });
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
    // 可灵三个提交端点各是一个适配器（2026-10-19 拆分）：各自取自己的提交端点作占位，
    // 不落到「首个可用相对路径」——三条目都带查询端点，靠顺序取到的值不可读。
    if (adapter.adapter_id === 'kling-text2video-v1') return rel.textToVideo ?? '/text-to-video/kling-3.0';
    if (adapter.adapter_id === 'kling-image2video-v1') return rel.imageToVideo ?? '/image-to-video/kling-3.0';
    if (adapter.adapter_id === 'kling-omni-video-v1') return rel.omniVideo ?? '/omni-video/kling-3.0-omni';
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
