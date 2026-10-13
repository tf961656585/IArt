import * as z from 'zod';

import {
  BatchIntentSnapshotSchema,
  ChatModelCatalogResponseSchema,
  ExecutableModelCatalogResponseSchema,
  PromptDockBatchSubmitRequestSchema,
  PromptDockBatchSubmitResponseSchema,
  TaskCancelAcceptedResponseSchema,
} from '@iart/contracts';
import type {
  BatchIntentSnapshot,
  ChatModelDirectoryEntry,
  ExecutableModelDirectoryEntry,
  PromptDockBatchSubmitRequest,
  PromptDockBatchSubmitResponse,
} from '@iart/contracts';
import { request } from './transport';
import { getRuntimeProjectPath } from '@/client/store/runtimeStore';

/**
 * PromptDock 提交主链客户端层（Todo 6）。
 *
 * 只承载 PromptDock 到 Backend 的提交/目录/取消/快照读取 HTTP 通道。契约 DTO 唯一 owner 为
 * `packages/contracts`（promptdock-batch-contract.ts / executable-model-catalog-contract.ts /
 * provider-connection-contract.ts），本文件只在 HTTP 边界做 schema `.parse()`，不复制字段事实源。
 *
 * - POST /api/generation-batches
 * - GET  /api/generation-batches/:batchId
 * - GET  /api/executable-model-catalog
 * - POST /api/tasks/:id/cancel
 */

// ---------------------------------------------------------------------------
// 可执行模型目录
// ---------------------------------------------------------------------------

/**
 * PromptDock 目录条目：跨边界 DTO 由 contracts 承载与 parse，Editor 不叠加字段事实源。
 * inline 层/完整参数面板的分层由 Editor 呈现层按字段 component 派生
 * （spec docs/editor/节点参数呈现分层.md「由实现层按模型 schema 裁定」），不依赖目录下发标记。
 */
export type PromptDockCatalogEntry = ExecutableModelDirectoryEntry;

const catalogSchema = ExecutableModelCatalogResponseSchema;

/**
 * 拉取可执行模型目录（GET /api/executable-model-catalog）。
 *
 * 模型列表、model_version、参数 schema、能力与 active deployment 可执行性均由 Runtime
 * Backend 聚合投影；Editor 不长期硬编码模型真相（遵循根 AGENTS.md「Model ID 唯一性与显示规则」与共享契约口径）。
 */
export const fetchExecutableModelCatalog = async (): Promise<PromptDockCatalogEntry[]> => {
  try {
    const payload = await request<unknown>({
      method: 'GET',
      endpoint: '/api/executable-model-catalog',
      responseType: 'json',
      includeAuth: false,
      useBackendTask: false,
    });
    const parsed = catalogSchema.safeParse(payload);
    if (!parsed.success) {
      console.warn('[promptdock] executable model catalog response invalid', parsed.error);
      return [];
    }
    return parsed.data.models;
  } catch (error) {
    console.warn('[promptdock] executable model catalog fetch failed', error);
    return [];
  }
};

// ---------------------------------------------------------------------------
// 对话模型目录（agent 形态的语言模型来源）
// ---------------------------------------------------------------------------

/**
 * agent 形态的模型条目：跨边界 DTO 由 contracts 承载，`thinking_tiers` 是后端按该模型
 * 启用关系与连接协议算出的可选档位（spec 37「思考档位」），创作面只消费、不自行过滤。
 */
export type PromptDockChatCatalogEntry = ChatModelDirectoryEntry;

/**
 * 拉取对话模型目录（GET /api/chat-model-catalog）。
 *
 * 对话模型不进生成式目录（spec 03 §1 / spec 06），因此由独立端点承载；
 * 读不到时返回空数组，由前置校验给「还没有可用的模型」引导，不静默编造候选。
 */
export const fetchChatModelCatalog = async (): Promise<PromptDockChatCatalogEntry[]> => {
  try {
    const payload = await request<unknown>({
      method: 'GET',
      endpoint: '/api/chat-model-catalog',
      responseType: 'json',
      includeAuth: false,
      useBackendTask: false,
    });
    const parsed = ChatModelCatalogResponseSchema.safeParse(payload);
    if (!parsed.success) {
      console.warn('[promptdock] chat model catalog response invalid', parsed.error);
      return [];
    }
    return parsed.data.models;
  } catch (error) {
    console.warn('[promptdock] chat model catalog fetch failed', error);
    return [];
  }
};

// ---------------------------------------------------------------------------
// GenerationBatch 提交受理
// ---------------------------------------------------------------------------

/**
 * 提交一次固定任务数 GenerationBatch（POST /api/generation-batches）。
 *
 * 受理响应经 PromptDockBatchSubmitResponseSchema.parse 校验（原子受理：tasks.length ===
 * intent_snapshot.task_count 且 batch_id 一致）。响应成功即确认任务已落库，Editor 据此创建
 * N 个任务节点投影（spec：提交受理是任务投影唯一创建事实）。
 */
export const submitGenerationBatch = async (
  body: PromptDockBatchSubmitRequest,
): Promise<PromptDockBatchSubmitResponse> => {
  const parsedBody = PromptDockBatchSubmitRequestSchema.parse(body);
  const response = await request<unknown>({
    method: 'POST',
    endpoint: '/api/generation-batches',
    body: parsedBody,
    responseType: 'json',
  });
  return PromptDockBatchSubmitResponseSchema.parse(response);
};

// ---------------------------------------------------------------------------
// BatchIntentSnapshot 读取（复用/重试回填）
// ---------------------------------------------------------------------------

/**
 * 读取一次提交受理时冻结的 BatchIntentSnapshot（GET /api/generation-batches/:batchId）。
 *
 * 供资产「复用」与失败重试回填创作面（prompt/参数/参考/任务数）。快照缺失（旧批次、
 * 项目库不可用）或响应不合规返回 null 并留痕，不抛错——回填失败退化为仅回填模型身份。
 */
export const fetchBatchIntentSnapshot = async (
  batchId: string,
): Promise<BatchIntentSnapshot | null> => {
  const normalized = batchId.trim();
  const projectPath = getRuntimeProjectPath();
  if (!normalized || !projectPath) {
    console.debug('[promptdock] batch snapshot fetch skipped (no batchId or projectPath)', { batchId });
    return null;
  }
  try {
    const response = await request<unknown>({
      method: 'GET',
      endpoint: `/api/generation-batches/${encodeURIComponent(normalized)}?projectPath=${encodeURIComponent(projectPath)}`,
      responseType: 'json',
      includeAuth: false,
      useBackendTask: false,
    });
    const batchField =
      response != null && typeof response === 'object' && !Array.isArray(response)
        ? (response as { batch?: unknown }).batch
        : null;
    const parsed = BatchIntentSnapshotSchema.nullable().safeParse(batchField ?? null);
    if (parsed.success) return parsed.data;
    console.debug('[promptdock] batch snapshot response invalid', {
      batchId,
      issue: parsed.error.message,
    });
    return null;
  } catch (error) {
    console.debug('[promptdock] batch snapshot fetch failed', { batchId, error });
    return null;
  }
};

// ---------------------------------------------------------------------------
// 任务取消命令
// ---------------------------------------------------------------------------

/**
 * 取消命令受理结果（HTTP 边界整形状 parse）。
 *
 * 200 响应体即 TaskCancelAcceptedResponse 契约形状（accepted/task_id/cancelled_at，唯一 owner
 * 为 packages/contracts task-cancel-contract.ts）；accepted:false 分支是防御性兜底——现行
 * Backend 拒绝一律走非 2xx 错误体，但边界 parse 不把契约外形状静默放进下游。取消语义以任务
 * 状态机为准；投影移除由 Backend 结算终态通知驱动，本函数不旁路操作画布投影。
 */
const cancelTaskResponseSchema = z.union([
  TaskCancelAcceptedResponseSchema,
  z.object({ accepted: z.literal(false) }).strict(),
]);

export type CancelTaskCommandResult = z.infer<typeof cancelTaskResponseSchema>;

/**
 * 对单个 RuntimeTask 发出取消命令（POST /api/tasks/:id/cancel）。
 *
 * 返回契约受理形状（accepted/task_id/cancelled_at）；Backend 拒绝走非 2xx（HTTP 错误体
 * {code, message}），由调用方按状态处理。Backend 持久化取消记录并结算为独立 'cancelled'
 * 终态，晚到成功/媒体结果一律丢弃（spec 固定任务数批次提交与投影语义）。
 */
export const cancelTask = async (taskId: string): Promise<CancelTaskCommandResult> => {
  const normalized = taskId.trim();
  if (!normalized) throw new Error('cancelTask requires taskId');
  const response = await request<unknown>({
    method: 'POST',
    endpoint: `/api/tasks/${encodeURIComponent(normalized)}/cancel`,
    responseType: 'json',
  });
  return cancelTaskResponseSchema.parse(response);
};
