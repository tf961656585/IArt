import * as crypto from 'node:crypto';
import {
  BatchIntentSnapshotSchema,
  type PromptDockBatchSubmitRequest,
  type BatchIntentSnapshot,
} from '@iart/contracts';
import {
  assembleGenerationTaskRequest,
} from '../request-assembler.cts';
import type { AssemblerContext } from '../request-assembler-shared.cts';
import { buildRuntimeTaskRow } from '../task-payload-builder.cts';
import { createTaskRecordFromFormalSpec, updateTaskRecord } from '../task-store.cts';
import { normalizeFormalTaskExecutionPlan } from './formal-task.cts';
import * as backendIpcSenderModule from '../backend-ipc-sender.cts';
import * as loggingModule from '../logging.cts';
import * as taskExecutorModule from '../task-executor.cts';
import { isJsonObject } from '../routes/task-submit-helpers.cts';

const { sendRuntimeTransaction, sendTaskEvent, sendReadBatchByClientRequestId } = backendIpcSenderModule;
const { startTaskExecution } = taskExecutorModule;
const { logDebug, logWarn } = loggingModule;

const normalizeString = (value: unknown): string =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

const generateBatchId = (): string => `batch_${crypto.randomUUID()}`;
const generateTaskId = (): string => `task_${crypto.randomUUID()}`;

type AssembledExecutionPlan = {
  model_id: string;
  submit_request: { url: string; method: string; headers: unknown; body: unknown };
  polling_strategy: unknown;
  result_rule: unknown;
  result_acquisition_strategy: unknown;
  result_output_mapping: unknown;
  metadata: { modelId?: string; model_id?: string; packageId?: string; endpoint?: string };
};

const getAssembledExecutionPlan = (assembled: unknown): AssembledExecutionPlan | null => {
  if (!isJsonObject(assembled)) return null;
  const executionPlan = (assembled as { executionPlan?: unknown }).executionPlan;
  if (!isJsonObject(executionPlan)) return null;
  return executionPlan as AssembledExecutionPlan;
};

type AcceptResult =
  | { ok: true; batchId: string; intentSnapshot: BatchIntentSnapshot; tasks: Array<{ taskId: string; taskIndex: number; record: unknown }> }
  | { ok: false; code: string; message: string };

/**
 * 原子受理一次 GenerationBatch（spec 主链 / runtime spec「原子受理」）。
 *
 * - 生成 batch_id + 恰好 N 个 taskId（taskId 沿用现有 task_ 生成器）。
 * - 受理期只固化不可变 BatchIntentSnapshot；
 * - 每个任务复用同一份模型语义输入组装出的 execution plan（同一 intent 同一 payload），
 *   taskId / taskIndex / batchId 逐任务锚进 metadata，不复制可变 Provider 配置。
 * - Notification/IO 在调用方（路由）完成；本函数只负责生成对象，不写 IPC。
 *
 * 本函数不构造旧 until-x 语义（sourceNodeId / targetSuccessCount / cancelRequested 均不出现）。
 */
const acceptGenerationBatch = async (params: {
  body: PromptDockBatchSubmitRequest;
  baseDir: string | null;
  /** agent 工具调用派生时的血缘标注（spec 04「血缘与画布投影」）；手动提交不携带。 */
  agentLineage?: { agentSessionId: string; toolCallId: string };
}): Promise<AcceptResult> => {
  const { body, baseDir } = params;
  const batchId = generateBatchId();
  const taskCount = body.task_count;
  const taskIds = Array.from({ length: taskCount }, () => generateTaskId());

  const created_at = new Date().toISOString();
  const mediaRefs = body.media_inputs ?? [];
  const referenceAssetIds = body.reference_asset_ids ?? [];
  const intentCandidate = {
    batch_id: batchId,
    model_id: body.model_id,
    model_version: body.model_version,
    prompt: body.prompt,
    params: body.arguments,
    media_refs: mediaRefs.length > 0 ? mediaRefs : undefined,
    // 参考区资产溯源 id（复用回填参考区用；空数组不入快照，与 media_refs 同口径）。
    reference_asset_ids: referenceAssetIds.length > 0 ? referenceAssetIds : undefined,
    task_count: taskCount,
    task_ids: taskIds,
    created_at,
  };
  const intentParsed = BatchIntentSnapshotSchema.safeParse(intentCandidate);
  if (!intentParsed.success) {
    return { ok: false, code: 'invalid_intent_snapshot', message: intentParsed.error.message };
  }
  const intentSnapshot: BatchIntentSnapshot = intentParsed.data;

  // 同一 intent 组装一次；N 个任务共享同份 payload（固定任务数，成员不可补位）。
  let executionPlan: AssembledExecutionPlan | null = null;
  try {
    // reference_asset_ids 是提交面的资产溯源引用；payload 媒体内容只经 media_inputs
    // （attachment）物化。input_assets 是字段映射槽（mergeFieldMaps 只收 plain object），
    // 不接收字符串数组——不把 reference_asset_ids 误传进去。
    const assembled = await assembleGenerationTaskRequest(
      {
        model_id: body.model_id,
        prompt: body.prompt,
        arguments: body.arguments,
        media_inputs: body.media_inputs,
        mention_map: body.mention_map,
      },
      { projectPath: body.project_path, baseDir } satisfies AssemblerContext,
    );
    executionPlan = getAssembledExecutionPlan(assembled);
  } catch (error) {
    return {
      ok: false,
      code: 'assembly_failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (!executionPlan) {
    return { ok: false, code: 'assembly_failed', message: 'assembleGenerationTaskRequest returned no execution plan' };
  }

  const tasks: Array<{ taskId: string; taskIndex: number; record: unknown }> = [];
  for (let index = 0; index < taskIds.length; index += 1) {
    const taskId = taskIds[index];
    if (!taskId) continue;
    // normalizeFormalTaskExecutionPlan 依赖 metadata 里的 model_id / modelId 与 taskExecutionPlan；
    // 此处把固定成员关系与快照身份写进 metadata（taskIndex / batchId / batch_id）。
    const planPayload = {
      model_id: body.model_id,
      submit_request: executionPlan.submit_request,
      polling_strategy: executionPlan.polling_strategy,
      result_rule: executionPlan.result_rule,
      result_acquisition_strategy: executionPlan.result_acquisition_strategy,
      result_output_mapping: executionPlan.result_output_mapping,
      auto_start: true,
      metadata: {
        modelId: body.model_id,
        model_id: body.model_id,
        batchId,
        batch_id: batchId,
        intentSnapshot,
        taskIndex: index,
        projectPath: body.project_path,
        nodeGraphId: null,
        sourceNodeId: null,
        targetNodeId: null,
        ...(params.agentLineage ? { agentLineage: params.agentLineage } : {}),
      },
    };
    const normalized = normalizeFormalTaskExecutionPlan(planPayload);
    if (!normalized.ok) {
      return { ok: false, code: normalized.code, message: normalized.message };
    }
    const record = createTaskRecordFromFormalSpec(normalized.value, {
      actionId: undefined,
      actionName: 'runtime.batch.task.created',
      actionClass: 'business_async',
      compatMode: 'generation_batch_accept',
      submissionTransport: 'http',
      preserveLegacyTaskId: false,
      taskId,
    });
    if (!record) {
      return { ok: false, code: 'task_record_build_failed', message: `failed to build task record for ${taskId}` };
    }
    tasks.push({ taskId, taskIndex: index, record });
  }

  return {
    ok: true,
    batchId,
    intentSnapshot,
    tasks,
  };
};

type PersistResult =
  | { ok: true; tasks: Array<{ taskId: string; taskIndex: number; record: unknown }> }
  | { ok: false; code: string; message: string };

/**
 * 单个 RuntimeTransaction 原子写入 1 个 batch 行 + N 个 task 行。
 * 任一写入失败不得返回部分任务集合（不产生任何该次提交的运行域对象）。
 */
const persistAcceptedBatch = async (params: {
  projectPath: string;
  intentSnapshot: BatchIntentSnapshot;
  tasks: Array<{ taskId: string; taskIndex: number; record: unknown }>;
  /** 客户端受理幂等键（spec docs/integrations/CLI与本地Agent集成.md §5.4）；界面提交不携带时为 null。 */
  clientRequestId: string | null;
}): Promise<PersistResult> => {
  const { projectPath, intentSnapshot, tasks, clientRequestId } = params;
  const batchPayloadJson = JSON.stringify(intentSnapshot);
  const taskRows = tasks.map(({ record }) =>
    buildRuntimeTaskRow(record, {
      fallbackStatus: undefined,
      statusNormalizer: (status: unknown) =>
        typeof status === 'string' ? status.trim().toLowerCase() : undefined,
      projectPathResolver: () => projectPath,
    }),
  );
  try {
    const transactionResult = await sendRuntimeTransaction({
      projectPath,
      tasks: taskRows,
      batches: [
        {
          batchId: intentSnapshot.batch_id,
          payloadJson: batchPayloadJson,
          clientRequestId: clientRequestId ?? undefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });
    if (!transactionResult || transactionResult.success !== true) {
      const message =
        normalizeString(transactionResult?.error ?? '') || 'Runtime transaction failed';
      logWarn('generation batch accept: atomic runtime write failed', {
        batchId: intentSnapshot.batch_id,
        taskCount: tasks.length,
        error: message,
      });
      return { ok: false, code: 'runtime_write_failed', message: `Failed to persist generation batch: ${message}` };
    }
    return { ok: true, tasks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn('generation batch accept: atomic runtime write threw', {
      batchId: intentSnapshot.batch_id,
      error: message,
    });
    return { ok: false, code: 'runtime_write_failed', message: `Failed to persist generation batch: ${message}` };
  }
};

/**
 * 按客户端幂等键解析幂等重放（spec §5.4 受理幂等键）。
 *
 * 命中即返回既有批次的不可变 BatchIntentSnapshot（batch_id / task_ids 都在快照内，响应据此
 * 重放既有受理结果）；未命中返回 null（走正常受理）。Main 侧读取失败（项目库不可用等 IPC
 * 失败）**不视为未命中**：返回 null 会继续走受理，而幂等键唯一索引会在持久化层硬拒重复
 * 批次（第二个 batchId 同幂等键的行写不进去）——读取失败时按未命中放行是安全的降级，
 * 留 debug 痕说明防线转移到唯一索引。
 */
const resolveBatchReplayByClientRequestId = async (params: {
  projectPath: string;
  clientRequestId: string;
}): Promise<BatchIntentSnapshot | null> => {
  let result;
  try {
    result = await sendReadBatchByClientRequestId({
      projectPath: params.projectPath,
      clientRequestId: params.clientRequestId,
    });
  } catch (error) {
    logDebug('generation batch accept: replay lookup ipc failed, fall through to fresh accept', {
      clientRequestId: params.clientRequestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (!result.success) {
    logDebug('generation batch accept: replay lookup unsuccessful at Main, fall through to fresh accept', {
      clientRequestId: params.clientRequestId,
      error: normalizeString(result.error) || 'unknown',
    });
    return null;
  }
  const data = result.data;
  const batchField =
    data !== null && typeof data === 'object' && !Array.isArray(data)
      ? (data as { batch?: unknown }).batch
      : null;
  if (batchField === null || batchField === undefined) return null;
  const parsed = BatchIntentSnapshotSchema.safeParse(batchField);
  if (parsed.success) return parsed.data;
  logDebug('generation batch accept: replay lookup payload failed BatchIntentSnapshotSchema parse', {
    clientRequestId: params.clientRequestId,
    issue: parsed.error.message.slice(0, 300),
  });
  return null;
};

/**
 * 受理后派发（ack-before-dispatch）：对每个任务先并发 startTaskExecution，再做 accepted 事件
 * 通知。受理响应已先行写出，避免任务状态通知早于 Editor 建投影。
 */
const dispatchAcceptedBatch = (params: {
  projectPath: string;
  tasks: Array<{ taskId: string; taskIndex: number; record: unknown }>;
}): void => {
  const { projectPath, tasks } = params;
  for (const task of tasks) {
    const taskId = task.taskId;
    void sendTaskEvent({
      projectPath,
      event: {
        taskId,
        eventType: 'task.accepted',
        payload: { status: 'submitting', submissionTransport: 'http' },
        createdAt: Date.now(),
      },
    }).catch((error: unknown) => {
      logWarn('generation batch accept: accepted event write failed', {
        taskId,
        error: String(error),
      });
    });
    // N 个任务直接并发派发（无中间编排/队列/节流）。
    void startTaskExecution(task.record).catch((error: unknown) => {
      const fallbackTaskId = normalizeString(taskId);
      if (fallbackTaskId) {
        try {
          updateTaskRecord(task.record, {
            status: 'failed',
            finishedAt: Date.now(),
            error: {
              code: 'task_execution_unhandled_error',
              message: String(error instanceof Error ? error.message : error),
            },
          });
        } catch (patchError) {
          logDebug('generation batch accept: failed to mark dispatch error', {
            taskId: fallbackTaskId,
            error: String(patchError),
          });
        }
      }
    });
  }
};

export {
  generateBatchId,
  generateTaskId,
  acceptGenerationBatch,
  persistAcceptedBatch,
  resolveBatchReplayByClientRequestId,
  dispatchAcceptedBatch,
  type AcceptResult,
  type PersistResult,
};
