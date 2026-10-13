import * as z from 'zod';
import type { MediaAsset } from './project-dto';
import { MentionMapEntrySchema, type MentionMapEntry } from './task-submit-request';
import { TaskProviderOverrideSchema, type TaskProviderOverride } from './provider-connection-contract';
// @deprecated providerOverride / overrideId 随 spec 03 废止，保留仅为过渡兼容；
// TaskProviderOverrideSchema 已从 task-submit-request.ts 迁移至 provider-connection-contract.ts 兼容导出。

/**
 * 本文件混载两类内容：
 * - 现役：跨边界状态集合（UnifiedGenerationStatus / UNIFIED_GENERATION_STATUSES /
 *   UNIFIED_GENERATION_RUNNING_STATUSES / 正式状态契约）。RuntimeTask 状态事实源以本文件为准。
 * - @deprecated 待退役：until-x 导出（until_x_success_enabled / target_success_count /
 *   append_count / 批次协调器投影 / CANVAS_TASK_SNAPSHOT/DELTA 事件）。until-x 已废止
 *   （docs/runtime/固定任务数批次提交与投影语义.md 取代「直到 x 个成功」与补位），
 *   这些导出由 Todo 6（Editor 旧主链替换）整体退役；新代码禁止新增对本文件 until-x 导出的引用。
 *
 * 状态集合与正式状态契约现役；仅 until-x 导出部分 @deprecated。
 */

export type UnifiedGenerationStatus =
  | 'submitting'
  | 'generating'
  | 'polling'
  | 'downloading'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/**
 * 提交阶段（submitting）细分 phase 取值。
 *
 * - `uploading_input` / `requesting`：提交链路细分（上传输入物化 / 发起远端请求）。
 */
export type UnifiedGenerationSubmittingPhase =
  | 'uploading_input'
  | 'requesting';

export interface UnifiedGenerationProgress {
  phase: UnifiedGenerationSubmittingPhase | string | undefined;
}

export interface UnifiedGenerationErrorInfo {
  code: string | undefined;
  message: string | undefined;
}

export interface UnifiedGenerationOutputEntry {
  mediaType: 'image' | 'video' | 'audio' | 'text' | undefined;
  assetId: string | null | undefined;
  textValue: string | null | undefined;
  url: string | null | undefined;
  mediaAsset: MediaAsset | null | undefined;
  mimeType: string | null | undefined;
  sizeBytes: number | null | undefined;
}

export type UnifiedGenerationUntilXCloseReason = 'reached_target_success' | 'user_cancelled';

export interface UnifiedGenerationUntilXSubmitMeta {
  until_x_success_enabled: boolean | undefined;
  batch_id: string | undefined;
  target_success_count: number | undefined;
}

export interface UnifiedGenerationUntilXMainDisplayResultRef {
  task_id: string;
  result_id: string;
}

export interface UnifiedGenerationUntilXAppendRequest {
  path: string;
  nodeGraphId: string;
  sourceNodeId: string;
  targetNodeId: string;
  executionId: string;
  batchId: string;
  target_success_count: number;
  model_id: string;
  append_count: number;
  arguments: Record<string, unknown> | undefined;
  media_inputs: unknown[] | undefined;
  input_assets: unknown[] | undefined;
  metadata: Record<string, unknown> | undefined;
  /** 用户选择的策略档位 Key；undefined 表示使用策略默认 Key */
  policyTierKey: string | undefined;
  /** "@锚点 → 素材" 映射（spec §5.4 / §7.2），mention 注入归后端物化层 */
  mention_map: Record<string, MentionMapEntry> | undefined;
  /**
   * custom_provider 渠道的任务级绑定覆盖（spec §6.4 / §8.1）。
   * undefined 表示无绑定（后端按渠道互斥跳过注入）。
   */
  providerOverride?: TaskProviderOverride | undefined;
  /**
   * 用户当前选中的 override 声明 id（spec §5.5），优先级高于 providerOverride。
   * 已随 spec 03 废止（PC-08），仅过渡兼容保留；新链路走 BatchIntentSnapshot/ExecutionSnapshot。
   */
  overrideId?: string | undefined;
}

export interface UnifiedGenerationUntilXAppendResponse {
  success: boolean;
  batch_id: string;
  append_count: number;
  target_success_count: number;
  task_ids: string[];
}

export interface UnifiedGenerationUntilXBatchProjection {
  until_x_success_enabled: boolean;
  batch_id: string;
  target_success_count: number;
  cancel_requested: boolean;
  current_success_count: number;
  in_flight_count: number;
  main_display_results: UnifiedGenerationUntilXMainDisplayResultRef[];
  batch_closed: boolean;
  close_reason: UnifiedGenerationUntilXCloseReason | null;
}

interface TaskEntryBase {
  taskId: string;
  status: UnifiedGenerationStatus;
  sourceNodeId: string;
  targetNodeId: string;
  createdAt: number;
  updatedAt: number;
  progress: UnifiedGenerationProgress | null;
  error: UnifiedGenerationErrorInfo | null;
  outputs: UnifiedGenerationOutputEntry[] | null;
}

export interface UnifiedGenerationTaskEntryUntilX extends TaskEntryBase {
  executionId: string;
  modelId: string;
  taskIndex: number;
  until_x_batch: UnifiedGenerationUntilXBatchProjection;
}

export interface UnifiedGenerationTaskEntryPlain extends TaskEntryBase {
  executionId: string | undefined;
  modelId: string | undefined;
  taskIndex: number | undefined;
  remoteRequestId: string | undefined;
  until_x_batch: undefined | undefined;
}

export type UnifiedGenerationTaskEntry =
  | UnifiedGenerationTaskEntryUntilX
  | UnifiedGenerationTaskEntryPlain;

export interface UnifiedGenerationOutputBucket {
  outputs: UnifiedGenerationOutputEntry[] | null | undefined;
  lastTaskId: string | undefined;
  lastExecutionId: string | undefined;
  lastJobCreatedAt: number | undefined;
  updatedAt: number | undefined;
}

export type UnifiedGenerationSourceTaskBucket = Record<string, UnifiedGenerationTaskEntry>;

export interface UnifiedGenerationIndexPayload {
  version: number;
  nodeGraphId: string;
  updatedAt: string;
  tasksById: Record<string, UnifiedGenerationTaskEntry>;
  outputsByNodeId: Record<string, UnifiedGenerationOutputBucket> | undefined;
  sourceTasksByNodeId: Record<string, UnifiedGenerationSourceTaskBucket> | undefined;
}

export interface UnifiedGenerationDeltaPayload {
  changedTasks: Record<string, UnifiedGenerationTaskEntry> | undefined;
  changedOutputs: Record<string, UnifiedGenerationOutputBucket> | undefined;
  changedSourceTasks: Record<string, UnifiedGenerationSourceTaskBucket> | undefined;
  tombstones: Array<{ taskId: string | undefined; nodeId: string | undefined; outputIndex: number | undefined }> | undefined;
}

export const UNIFIED_GENERATION_STATUSES = [
  'submitting',
  'generating',
  'polling',
  'downloading',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export const UNIFIED_GENERATION_STATUS = {
  SUBMITTING: 'submitting',
  GENERATING: 'generating',
  POLLING: 'polling',
  DOWNLOADING: 'downloading',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const satisfies Record<string, UnifiedGenerationStatus>;

export const UNIFIED_GENERATION_RUNNING_STATUSES = [
  UNIFIED_GENERATION_STATUS.SUBMITTING,
  UNIFIED_GENERATION_STATUS.GENERATING,
  UNIFIED_GENERATION_STATUS.POLLING,
  UNIFIED_GENERATION_STATUS.DOWNLOADING,
] as const satisfies readonly UnifiedGenerationStatus[];

export const UNIFIED_GENERATION_SUBMITTING_PHASES = [
  'uploading_input',
  'requesting',
] as const;
export const UNIFIED_GENERATION_SUBMITTING_PHASE_SET = new Set<string>(UNIFIED_GENERATION_SUBMITTING_PHASES);

export const UNIFIED_GENERATION_STATUS_SET = new Set<string>(UNIFIED_GENERATION_STATUSES);

export const CANVAS_TASK_SNAPSHOT_EVENT = 'canvas_task_snapshot';
export const CANVAS_TASK_DELTA_EVENT = 'canvas_task_delta';
export const CANVAS_TASK_PROTOCOL_VERSION = 4;

export const UnifiedGenerationProgressSchema = z.object({
  phase: z.string().optional(),
});

export const UnifiedGenerationErrorInfoSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
});

export const UnifiedGenerationOutputEntrySchema = z.object({
  mediaType: z.enum(['image', 'video', 'audio', 'text']).optional(),
  assetId: z.string().nullable().optional(),
  textValue: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  mediaAsset: z.unknown().nullable().optional(),
  mimeType: z.string().nullable().optional(),
  sizeBytes: z.number().nullable().optional(),
});

export const UnifiedGenerationUntilXSubmitMetaSchema = z.object({
  until_x_success_enabled: z.boolean().optional(),
  batch_id: z.string().optional(),
  target_success_count: z.number().int().positive().optional(),
});

export const UnifiedGenerationUntilXMainDisplayResultRefSchema = z.object({
  task_id: z.string().min(1),
  result_id: z.string().min(1),
});

export const UnifiedGenerationUntilXAppendRequestSchema = z.object({
  path: z.string().min(1),
  nodeGraphId: z.string().min(1),
  sourceNodeId: z.string().min(1),
  targetNodeId: z.string().min(1),
  executionId: z.string().min(1),
  batchId: z.string().min(1),
  target_success_count: z.number().int().positive(),
  model_id: z.string().min(1),
  append_count: z.number().int().positive(),
  arguments: z.record(z.unknown()).optional(),
  media_inputs: z.array(z.unknown()).optional(),
  input_assets: z.array(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
  policyTierKey: z.string().optional(),
  // .strict() 下必须显式声明 mention_map，否则客户端携带时会被拒绝（spec §5.4）
  mention_map: z.record(MentionMapEntrySchema).optional(),
  // custom_provider 渠道任务级绑定覆盖（spec §6.4 / §8.1）
  providerOverride: TaskProviderOverrideSchema.optional(),
  // @deprecated 随 spec 03 废止，仅过渡兼容
  overrideId: z.string().optional(),
}).strict().refine((value) => {
  const hasArguments = Boolean(value.arguments && Object.keys(value.arguments).length > 0);
  const hasMediaInputs = Boolean(value.media_inputs && value.media_inputs.length > 0);
  const hasInputAssets = Boolean(value.input_assets && value.input_assets.length > 0);
  return hasArguments || hasMediaInputs || hasInputAssets;
}, {
  message: 'until-x append requires direct payload',
});

export const UnifiedGenerationUntilXAppendResponseSchema = z.object({
  success: z.boolean(),
  batch_id: z.string().min(1),
  append_count: z.number().int().nonnegative(),
  target_success_count: z.number().int().positive(),
  task_ids: z.array(z.string().min(1)),
});

export const UnifiedGenerationUntilXBatchProjectionSchema = z.object({
  until_x_success_enabled: z.literal(true),
  batch_id: z.string().min(1),
  target_success_count: z.number().int().positive(),
  cancel_requested: z.boolean(),
  current_success_count: z.number().int().nonnegative(),
  in_flight_count: z.number().int().nonnegative(),
  main_display_results: z.array(UnifiedGenerationUntilXMainDisplayResultRefSchema),
  batch_closed: z.boolean(),
  close_reason: z.enum(['reached_target_success', 'user_cancelled']).nullable(),
});

export type UnifiedGenerationUntilXAppendRequestDto = z.infer<
  typeof UnifiedGenerationUntilXAppendRequestSchema
>;
export type UnifiedGenerationUntilXAppendResponseDto = z.infer<
  typeof UnifiedGenerationUntilXAppendResponseSchema
>;

const normalizeString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

export const normalizeUnifiedGenerationStatus = (value: unknown, fallback: UnifiedGenerationStatus | null = null) => {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) return fallback;
  return UNIFIED_GENERATION_STATUS_SET.has(normalized) ? normalized : fallback;
};

export const isUnifiedGenerationStatus = (value: unknown): value is UnifiedGenerationStatus =>
  typeof value === 'string' && UNIFIED_GENERATION_STATUS_SET.has(value);

export const normalizeUnifiedGenerationSubmittingPhase = (
  value: unknown,
  fallback: UnifiedGenerationSubmittingPhase | null = null,
): UnifiedGenerationSubmittingPhase | null => {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) return fallback;
  return UNIFIED_GENERATION_SUBMITTING_PHASE_SET.has(normalized)
    ? (normalized as UnifiedGenerationSubmittingPhase)
    : fallback;
};
