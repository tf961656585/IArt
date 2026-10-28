import {
  ExecutionSnapshotSchema,
  cloneJsonValue,
  isRequeryEligibleFailureStage,
  type ExecutionSnapshot,
} from '@iart/contracts';
import * as loggingModule from './logging.cts';
import { findProjectionByModelIdOrAlias } from './model-package-catalog.cts';
import { buildPollingStrategyFromProjection } from './request-assembler.cts';
import { isUnsettledCancelRecord } from './task-cancel-service.cts';
import { appendTaskArchiveEventSafely } from './task-engine-archive.cts';
import { buildPollingRequestFromPlan } from './task-engine-polling-utils.cts';
import { startTaskRequery } from './task-executor.cts';
import { normalizeString } from './task-normalizer.cts';
import { getConnection } from './provider-connection/connection-store.cts';
import { readCredentialValue } from './provider-connection/credential-store.cts';

/**
 * 失败任务重新查询（`succeeded` 之外唯一把 `failed` 送回非终态的受控出边）。
 *
 * 口径（已拍板，见 docs/architecture/contracts/task-state-machine.md transitions.requery）：
 * - 同一 taskId / batchId / remoteRequestId；不新建 GenerationBatch、不新建 RuntimeTask、
 *   不重新提交生成请求；
 * - 查询请求、成功/失败判定与结果字段映射使用**当前最新**的接口格式与接口配方；
 * - 连接身份、Base URL、凭证版本与 remote_model_id 沿用原任务的 ExecutionSnapshot，不重算；
 * - 给一轮完整的新等待预算（当前格式声明的间隔与次数上限），期间适用常规取消语义；
 * - 不自动重试、不自动 fallback、不设置请求超时。
 *
 * 本模块只负责「资格 + 预检 + 计划重建 + 派发」，执行链复用 task-executor 与轮询引擎。
 */

const REQUEST_RULE_REQUIRED_MESSAGE = '当前模型没有可用的查询计划，无法重新查询结果';

export type RequeryRejectCode =
  | 'invalid_task'
  | 'task_not_failed'
  | 'stage_not_requeryable'
  | 'missing_remote_request_id'
  | 'snapshot_unavailable'
  | 'cancel_pending'
  | 'agent_derived'
  | 'in_flight'
  | 'model_unavailable'
  | 'interface_format_unavailable'
  | 'connection_unavailable'
  | 'credential_unavailable';

export type RequeryExecutionPlan = {
  /** 原任务的提交请求摘要原样保留（重新查询不重建提交链）。 */
  submit_request_summary: unknown;
  polling_strategy: unknown;
  result_rule: unknown;
  result_acquisition_strategy: unknown;
  result_output_mapping: unknown;
};

export type ResolveRequeryPlanResult =
  | { ok: true; plan: RequeryExecutionPlan; modelId: string }
  | { ok: false; code: RequeryRejectCode; message: string };

export type RequeryOutcome =
  | { ok: true; taskId: string; requestedAt: string }
  | { ok: false; code: RequeryRejectCode; message: string };

type RequestedRequery = {
  taskId: string;
  failureStage: string | null;
  failureCode: string;
  remoteRequestId: string;
  requeryCount: number;
};

/** 落库记录（RuntimeTaskView 形状）的显式读取面：只声明本模块消费的字段。 */
type RequeryRecordView = {
  taskId: unknown | undefined;
  id: unknown | undefined;
  status: unknown | undefined;
  failure: unknown | undefined;
  metadata: unknown | undefined;
  remoteRequestId: unknown | undefined;
};
type RequeryMetadataView = {
  taskId: unknown | undefined;
  modelId: unknown | undefined;
  model_id: unknown | undefined;
  remoteRequestId: unknown | undefined;
  remote_request_id: unknown | undefined;
  executionSnapshot: unknown | undefined;
  execution_snapshot: unknown | undefined;
  taskExecutionPlan: unknown | undefined;
  agentLineage: unknown | undefined;
  requeryCount: unknown | undefined;
  requeryStartedAt: unknown | undefined;
};
type RequeryFailureView = { code: unknown | undefined; stage: unknown | undefined };
type RequeryPlanView = { submit_request_summary: unknown | undefined };
type SubmitSummaryView = { body: unknown | undefined };
type SubmitSummaryBodyView = { meta: unknown | undefined };
type SubmitSummaryMetaView = { taskType: unknown | undefined };
type AgentLineageView = { agentSessionId: unknown | undefined };

const isObjectRecord = (value: unknown): value is object =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const asRecordView = (value: unknown): RequeryRecordView =>
  isObjectRecord(value) ? (value as RequeryRecordView) : ({} as RequeryRecordView);
const asMetadataView = (value: unknown): RequeryMetadataView =>
  isObjectRecord(value) ? (value as RequeryMetadataView) : ({} as RequeryMetadataView);
const asFailureView = (value: unknown): RequeryFailureView =>
  isObjectRecord(value) ? (value as RequeryFailureView) : ({} as RequeryFailureView);
const asPlanView = (value: unknown): RequeryPlanView =>
  isObjectRecord(value) ? (value as RequeryPlanView) : ({} as RequeryPlanView);
const asSubmitSummaryView = (value: unknown): SubmitSummaryView =>
  isObjectRecord(value) ? (value as SubmitSummaryView) : ({} as SubmitSummaryView);
const asSubmitSummaryBodyView = (value: unknown): SubmitSummaryBodyView =>
  isObjectRecord(value) ? (value as SubmitSummaryBodyView) : ({} as SubmitSummaryBodyView);
const asSubmitSummaryMetaView = (value: unknown): SubmitSummaryMetaView =>
  isObjectRecord(value) ? (value as SubmitSummaryMetaView) : ({} as SubmitSummaryMetaView);
const asAgentLineageView = (value: unknown): AgentLineageView =>
  isObjectRecord(value) ? (value as AgentLineageView) : ({} as AgentLineageView);

const rejectPlan = (
  code: RequeryRejectCode,
  message: string,
): ResolveRequeryPlanResult => ({ ok: false, code, message });

/**
 * 原任务的 taskType（轮询地址模板里的 `{taskType}` 占位在组装期就要有值）。
 *
 * 任务表不保留请求体原文，只能从提交摘要里读；摘要被体积上限折叠时回落当前投影的
 * `default_task_type`（同一事实的当前值，不引入第二事实源）。
 */
const readOriginalTaskType = (metadata: unknown): string => {
  const plan = asPlanView(asMetadataView(metadata).taskExecutionPlan);
  const submitSummary = asSubmitSummaryView(plan.submit_request_summary);
  const body = asSubmitSummaryBodyView(submitSummary.body);
  const meta = asSubmitSummaryMetaView(body.meta);
  return normalizeString(meta.taskType);
};

/**
 * 按当前模型记录重建查询计划（纯解析，无 IO 副作用）。
 *
 * 重新解析投影（`findProjectionByModelIdOrAlias` 每次调用重装声明 × 族模板 × 配方）意味着
 * 用户改配方 / 改格式 / 改模型参数后，重新查询立刻按最新口径读取；不缓存、不沿用旧计划中的
 * 查询与判定段落。提交摘要与远端任务号属于「同一任务身份」的一部分，原样保留。
 */
const resolveRequeryPlan = (record: unknown): ResolveRequeryPlanResult => {
  const recordValue = asRecordView(record);
  const metadata = asMetadataView(recordValue.metadata);
  const modelId = normalizeString(metadata.modelId || metadata.model_id);
  if (!modelId) {
    return rejectPlan('model_unavailable', '任务记录缺少模型标识，无法重新查询结果');
  }
  const found = findProjectionByModelIdOrAlias(modelId, { baseDir: undefined });
  if (!found) {
    return rejectPlan('model_unavailable', `模型 ${modelId} 已不可用，无法重新查询结果`);
  }
  const projection = found.projection;
  const currentPlan = projection.task_execution_plan;
  if (!currentPlan) {
    loggingModule.logDebug('[task-requery] current projection has no formal execution plan', { modelId });
    return rejectPlan('interface_format_unavailable', REQUEST_RULE_REQUIRED_MESSAGE);
  }
  const taskType =
    readOriginalTaskType(metadata) || normalizeString(projection.runtime.default_task_type);
  const pollingStrategy = buildPollingStrategyFromProjection(
    projection,
    currentPlan.request_strategy.endpoint,
    { meta: { taskType } },
  );
  if (!pollingStrategy) {
    // 当前格式/配方不是异步轮询（或没有查询声明）：没有「再查一次」的读取规则可依。
    loggingModule.logDebug('[task-requery] current projection has no async polling strategy', {
      modelId,
      familyAdapterId: projection.package_id,
      taskType,
    });
    return rejectPlan('interface_format_unavailable', REQUEST_RULE_REQUIRED_MESSAGE);
  }
  const existingPlan = asPlanView(metadata.taskExecutionPlan);
  const submitRequestSummary = isObjectRecord(existingPlan.submit_request_summary)
    ? cloneJsonValue(existingPlan.submit_request_summary)
    : null;
  return {
    ok: true,
    modelId,
    plan: {
      submit_request_summary: submitRequestSummary,
      polling_strategy: pollingStrategy,
      result_rule: currentPlan.result_rule ? cloneJsonValue(currentPlan.result_rule) : null,
      // 取结果策略也随当前配方重建（不止任务清单列出的判定与映射两项）：
      // `needs_fetch` 配方（先取结果地址再下载）若不重建获取声明，重查会把轮询响应当成
      // 最终结果去映射，必然再次命中 result_mapping 约定，用户反复点也只能反复失败。
      // 保留旧策略同样不行——它属于「读取规则」，与查询/判定/映射必须同源。
      result_acquisition_strategy: currentPlan.result_acquisition_strategy
        ? cloneJsonValue(currentPlan.result_acquisition_strategy)
        : null,
      result_output_mapping: currentPlan.result_output_mapping
        ? cloneJsonValue(currentPlan.result_output_mapping)
        : null,
    },
  };
};

const readExecutionSnapshot = (metadata: unknown): ExecutionSnapshot | null => {
  const metadataRecord = asMetadataView(metadata);
  const candidate = metadataRecord.executionSnapshot ?? metadataRecord.execution_snapshot;
  if (!candidate || typeof candidate !== 'object') return null;
  const parsed = ExecutionSnapshotSchema.safeParse(candidate);
  if (!parsed.success) {
    loggingModule.logDebug('[task-requery] invalid execution snapshot in task metadata', {
      error: parsed.error.message,
    });
    return null;
  }
  return parsed.data;
};

const isAgentDerivedTask = (metadata: unknown): boolean => {
  const agentLineage = asAgentLineageView(asMetadataView(metadata).agentLineage);
  return Boolean(normalizeString(agentLineage.agentSessionId));
};

const readRequeryCount = (metadata: unknown): number => {
  const raw = asMetadataView(metadata).requeryCount;
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

/** 拒绝留痕的附加事实（字段固定，不用宽泛索引类型）。 */
type RejectionDetail = {
  status?: string;
  failureCode?: string;
  failureStage?: string | null;
  modelId?: string;
  connectionId?: string;
  lifecycle?: string;
  reason?: string;
};

const buildRejection = (
  record: unknown,
  code: RequeryRejectCode,
  message: string,
  detail: RejectionDetail = {},
): RequeryOutcome => {
  const recordValue = asRecordView(record);
  const metadata = asMetadataView(recordValue.metadata);
  const taskId = normalizeString(recordValue.taskId || recordValue.id || metadata.taskId);
  // 所有拒绝必须留痕：静默拒绝会让「按钮点了没反应」在排查中不可见。
  loggingModule.logDebug('[task-requery] rejected', { taskId, code, message, ...detail });
  appendTaskArchiveEventSafely(
    recordValue,
    'task.requery_rejected',
    { phase: 'requery_rejected', code, message, ...detail },
    '[task-requery] Failed to write requery_rejected archive event:',
  );
  return { ok: false, code, message };
};

/**
 * 重新查询（failed → polling）。
 *
 * 传入落库记录（RuntimeTaskView 形状即可）。校验顺序：状态 → 失败阶段 → 远端任务号 →
 * 取消记录 / agent 血缘 → 执行快照 → 当前格式与配方 → 连接与凭证 → 单飞占位。
 * 任一不满足即拒绝，**不 fallback**：不换连接、不换模型、不换 endpoint、不重建快照。
 */
const requeryFailedTask = async (record: unknown): Promise<RequeryOutcome> => {
  const recordValue = asRecordView(record);
  const metadata = asMetadataView(recordValue.metadata);
  const taskId = normalizeString(recordValue.taskId || recordValue.id || metadata.taskId);
  if (!taskId) return buildRejection(record, 'invalid_task', '任务记录缺少任务号，无法重新查询结果');
  const status = normalizeString(recordValue.status).toLowerCase();
  if (status !== 'failed') {
    return buildRejection(record, 'task_not_failed', '只有失败的任务可以重新查询结果', { status });
  }
  const failure = asFailureView(recordValue.failure);
  const failureStage = normalizeString(failure.stage) || null;
  if (!isRequeryEligibleFailureStage(failureStage)) {
    return buildRejection(record, 'stage_not_requeryable', '这次失败无法通过重新查询解决', {
      failureCode: normalizeString(failure.code),
      failureStage,
    });
  }
  const remoteRequestId = normalizeString(
    metadata.remoteRequestId || metadata.remote_request_id || recordValue.remoteRequestId,
  );
  if (!remoteRequestId) {
    return buildRejection(record, 'missing_remote_request_id', '任务没有远端任务号，无法重新查询结果');
  }
  if (isUnsettledCancelRecord(metadata)) {
    return buildRejection(record, 'cancel_pending', '任务还有未结算的取消请求，无法重新查询结果');
  }
  if (isAgentDerivedTask(metadata)) {
    // agent 派生任务的结果回投由工具循环结算；复活会让等待方与产物归属不确定。
    return buildRejection(record, 'agent_derived', '智能体发起的任务不支持重新查询结果');
  }
  const snapshot = readExecutionSnapshot(metadata);
  if (!snapshot) {
    return buildRejection(record, 'snapshot_unavailable', '原任务的执行快照不可用，无法重新查询结果');
  }
  const planResolution = resolveRequeryPlan(recordValue);
  if (!planResolution.ok) {
    return buildRejection(record, planResolution.code, planResolution.message, {
      modelId: normalizeString(metadata.modelId || metadata.model_id),
    });
  }
  const planRecord = {
    ...recordValue,
    metadata: { ...metadata, taskExecutionPlan: planResolution.plan },
  };
  const pollingRequest = buildPollingRequestFromPlan(planRecord, null);
  if (pollingRequest.status !== 'ready') {
    return buildRejection(record, 'interface_format_unavailable', REQUEST_RULE_REQUIRED_MESSAGE, {
      reason: pollingRequest.status === 'blocked' ? pollingRequest.reason : pollingRequest.status,
    });
  }
  // 连接/凭证预检（能预判就预判）：原连接被删除或停用、凭证版本不可读时直接拒绝，
  // 不切换其他连接；预判不到的情形（如租约期内的瞬时不可读）交给轮询引擎以
  // `credential_missing` 干净失败。
  const connection = getConnection(snapshot.connection_id);
  if (!connection) {
    return buildRejection(record, 'connection_unavailable', '原服务商连接已删除，无法重新查询结果', {
      connectionId: snapshot.connection_id,
    });
  }
  if (connection.lifecycle !== 'enabled') {
    return buildRejection(record, 'connection_unavailable', '原服务商连接已停用，无法重新查询结果', {
      connectionId: snapshot.connection_id,
      lifecycle: connection.lifecycle,
    });
  }
  const credentialRef = normalizeString(snapshot.credential_ref);
  if (credentialRef) {
    const credentialValue = await readCredentialValue(credentialRef);
    if (credentialValue === null) {
      return buildRejection(record, 'credential_unavailable', '原服务商凭证已失效，无法重新查询结果', {
        connectionId: snapshot.connection_id,
      });
    }
  }
  const requeryCount = readRequeryCount(metadata) + 1;
  const requestedAt = new Date().toISOString();
  const initialPatch = {
    status: 'polling',
    finishedAt: null,
    error: null,
    // 上一轮响应属于「上一次读取」，重新查询必须让新的轮询响应独立成立。
    response: null,
    progress: {
      phase: null,
      attempt: 0,
      consecutiveFailures: 0,
      message: null,
      percent: 0,
    },
    metadata: {
      taskExecutionPlan: planResolution.plan,
      requeryStartedAt: normalizeString(metadata.requeryStartedAt) || requestedAt,
      requeryCount,
    },
  };
  const dispatch = startTaskRequery({
    record: recordValue,
    request: pollingRequest.request,
    polling: pollingRequest.polling,
    initialPatch,
  });
  if (!dispatch.started) {
    return buildRejection(
      record,
      dispatch.reason === 'in_flight' ? 'in_flight' : 'invalid_task',
      dispatch.reason === 'in_flight'
        ? '这个任务正在重新查询，请稍候'
        : '任务记录缺少任务号，无法重新查询结果',
    );
  }
  const requested: RequestedRequery = {
    taskId,
    failureStage,
    failureCode: normalizeString(failure.code),
    remoteRequestId,
    requeryCount,
  };
  appendTaskArchiveEventSafely(
    recordValue,
    'task.requery_requested',
    { phase: 'requery_requested', ...requested },
    '[task-requery] Failed to write requery_requested archive event:',
  );
  appendTaskArchiveEventSafely(
    recordValue,
    'task.requery_started',
    { phase: 'requery_started', ...requested, modelId: planResolution.modelId },
    '[task-requery] Failed to write requery_started archive event:',
  );
  loggingModule.logDebug('[task-requery] started', {
    taskId,
    remoteRequestId,
    failureStage,
    requeryCount,
  });
  // 执行链在后台推进（取消走 task-executor 的同一个在途注册表）。
  void dispatch.promise.catch((error: unknown) => {
    loggingModule.logWarn('[task-requery] background execution rejected', {
      taskId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return { ok: true, taskId, requestedAt };
};

export {
  resolveRequeryPlan,
  requeryFailedTask,
};
