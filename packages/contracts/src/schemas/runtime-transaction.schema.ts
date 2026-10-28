import * as z from "zod";

import { TASK_FAILURE_STAGES } from "../task-failure-stage";
import { UNIFIED_GENERATION_STATUSES } from "../unified-generation";

const LOCAL_MEDIA_SCHEME = "local-media://";

const localMediaUrl = () =>
  z.string().refine(
    (url: string) => url.startsWith(LOCAL_MEDIA_SCHEME),
    { message: "URL must start with local-media:// scheme" },
  );

export const UnifiedGenerationStatusSchema = z.enum(UNIFIED_GENERATION_STATUSES);

export const RuntimeTaskFailureSchema = z.object({
  code: z.string().nullable().optional(),
  message: z.string().nullable().optional(),
  userMessage: z.string().nullable().optional(),
  backendMessage: z.string().nullable().optional(),
  retryable: z.boolean().nullable().optional(),
  details: z.unknown().nullable().optional(),
  /**
   * 失败阶段（见 task-failure-stage.ts）。旧 failureJson 无该键仍可 parse；
   * 重新查询资格只认该字段，缺失即不可重查。
   */
  stage: z.enum(TASK_FAILURE_STAGES).nullable().optional(),
}).strict();

export const RuntimeTaskRowSchema = z.object({
  taskId: z.string(),
  status: UnifiedGenerationStatusSchema,
  projectPath: z.string(),
  sourceNodeId: z.string().nullable().optional(),
  targetNodeId: z.string().nullable().optional(),
  batchId: z.string().nullable().optional(),
  requestJson: z.string().nullable().optional(),
  metadataJson: z.string().nullable().optional(),
  remoteRequestId: z.string().nullable().optional(),
  progressPercent: z.number().nullable().optional(),
  progressMessage: z.string().nullable().optional(),
  progressPhase: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  errorCode: z.string().nullable().optional(),
  failureJson: z.string().nullable().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** 执行真实开始时刻（epoch ms）；旧记录/未开始任务为 null（受理时刻是 createdAt，不互替）。 */
  startedAt: z.number().nullable().optional(),
  /** 执行真实结束时刻（epoch ms）；未终态任务为 null（最后回写时刻是 updatedAt，不互替）。 */
  finishedAt: z.number().nullable().optional(),
}).strict();

export const RuntimeTaskOutputRowSchema = z.object({
  outputId: z.string(),
  taskId: z.string(),
  mediaType: z.string(),
  assetId: z.string().nullable().optional(),
  textValue: z.string().nullable().optional(),
  sortOrder: z.number().nullable().optional(),
});

export const RuntimeMediaAssetRowSchema = z.object({
  assetId: z.string(),
  mediaType: z.string(),
  payloadJson: z.string(),
  createdAt: z.number().nullable().optional(),
  updatedAt: z.number().nullable().optional(),
});

export const RuntimeJsonObjectSchema = z.record(z.unknown());

export const RuntimeTaskViewSchema = z.object({
  taskId: z.string(),
  status: UnifiedGenerationStatusSchema,
  projectPath: z.string(),
  sourceNodeId: z.string().nullable().optional(),
  targetNodeId: z.string().nullable().optional(),
  batchId: z.string().nullable().optional(),
  request: RuntimeJsonObjectSchema.nullable().optional(),
  metadata: RuntimeJsonObjectSchema.optional(),
  remoteRequestId: z.string().nullable().optional(),
  progressPercent: z.number().nullable().optional(),
  progressMessage: z.string().nullable().optional(),
  progressPhase: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  errorCode: z.string().nullable().optional(),
  failure: RuntimeTaskFailureSchema.nullable().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** 执行真实开始时刻（epoch ms）；旧记录/未开始任务为 null。 */
  startedAt: z.number().nullable().optional(),
  /** 执行真实结束时刻（epoch ms）；未终态任务为 null。 */
  finishedAt: z.number().nullable().optional(),
}).strict();

export const RuntimeTaskOutputViewSchema = RuntimeTaskOutputRowSchema;

export const RuntimeMediaAssetOriginalSchema = z.object({
  url: localMediaUrl(),
  projectRef: z.string().nullable().optional(),
  fileKey: z.string().nullable().optional(),
  sourceUrl: z.string().nullable().optional(),
  /** 导入素材的原始文件名；生成/加工产物与 2026-10-07 前入库数据为 null/缺省。default 保旧载荷兼容且推导必填键。 */
  sourceFileName: z.string().min(1).nullable().default(null),
  mimeType: z.string().nullable().optional(),
  sizeBytes: z.number().nullable().optional(),
  width: z.number().nullable().optional(),
  height: z.number().nullable().optional(),
  durationMs: z.number().nullable().optional(),
  fps: z.number().nullable().optional(),
}).strict();

export const RuntimeMediaAssetThumbnailErrorSchema = z.object({
  code: z.string().nullable().optional(),
  message: z.string().nullable().optional(),
  failedAt: z.number().nullable().optional(),
}).strict();

export const RuntimeMediaAssetThumbnailSchema = z.object({
  url: localMediaUrl().nullable(),
  mimeType: z.string().nullable().optional(),
  width: z.number().nullable().optional(),
  height: z.number().nullable().optional(),
  status: z.enum(["missing", "generating", "ready", "stale", "failed"]),
  generatedAt: z.number().nullable().optional(),
  error: RuntimeMediaAssetThumbnailErrorSchema.nullable().optional(),
}).strict();

export const RuntimeMediaAssetLifecycleSchema = z.object({
  createdAt: z.number(),
  updatedAt: z.number(),
}).strict();

export const RuntimeMediaAssetViewSchema = z.object({
  assetId: z.string(),
  mediaType: z.enum(["image", "video", "audio"]),
  original: RuntimeMediaAssetOriginalSchema,
  thumbnail: RuntimeMediaAssetThumbnailSchema,
  lifecycle: RuntimeMediaAssetLifecycleSchema,
}).strict();

/**
 * GenerationBatch 运行域持久化投影 Row（spec storage-schema.md runtime_domain.batches）。
 *
 * 职责（唯一）：保存 GenerationBatch 身份、唯一不可变提交配置快照与固定任务成员关系，
 * 服务溯源、恢复与批次对账。不存在目标成功数更新、批次级取消请求、自动追加或补位写入路径。
 *
 * 两层结构（AGENTS.md「禁止脱水/水合」）：
 * - 表列（camelCase）：batchId + payloadJson + createdAt/updatedAt。
 * - payloadJson 内部结构跟随 BatchIntentSnapshotSchema（provider-connection-contract.ts），
 *   BatchIntentSnapshot 与固定任务成员关系整体承载于单一 JSON payload，不拆成 targetSuccessCount /
 *   cancelRequested 等并列列再拼回。
 *
 * 禁止项：
 * - sourceNodeId 是旧模型节点概念（产品定位已禁止模型节点），本 Row 不承载；批次归属项目由外层
 *   RuntimeMessageBase.projectPath 表达。
 * - targetSuccessCount / cancelRequested 等 until-x 专属字段不得出现。
 */
export const RuntimeBatchRowSchema = z.object({
  batchId: z.string(),
  payloadJson: z.string(),
  createdAt: z.number().nullable().optional(),
  updatedAt: z.number().nullable().optional(),
  /**
   * 客户端幂等键（spec docs/integrations/CLI与本地Agent集成.md §5.4 受理幂等键）：batch 级
   * 去重键，由提交请求 client_request_id 承载；界面提交不携带时为 null/缺省。存储层
   * batches.clientRequestId（唯一索引）的写路径契约。
   */
  clientRequestId: z.string().nullable().optional(),
}).strict();

export const MediaAssetsChangedNotificationSchema = z.object({
  type: z.literal("media-assets:changed"),
  projectPath: z.string(),
  mediaAssets: z.array(RuntimeMediaAssetViewSchema),
});

export type RuntimeJsonObject = z.infer<typeof RuntimeJsonObjectSchema>;
export type RuntimeTaskFailure = z.infer<typeof RuntimeTaskFailureSchema>;
export type RuntimeTaskRow = z.infer<typeof RuntimeTaskRowSchema>;
export type RuntimeTaskOutputRow = z.infer<typeof RuntimeTaskOutputRowSchema>;
export type RuntimeMediaAssetRow = z.infer<typeof RuntimeMediaAssetRowSchema>;
export type RuntimeTaskView = z.infer<typeof RuntimeTaskViewSchema>;
export type RuntimeTaskOutputView = z.infer<typeof RuntimeTaskOutputViewSchema>;
export type RuntimeMediaAssetView = z.infer<typeof RuntimeMediaAssetViewSchema>;
export type RuntimeBatchRow = z.infer<typeof RuntimeBatchRowSchema>;
export type MediaAssetsChangedNotification = z.infer<typeof MediaAssetsChangedNotificationSchema>;
