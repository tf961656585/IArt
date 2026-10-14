import * as z from "zod";

export type {
  RuntimeTaskRow,
  RuntimeTaskOutputRow,
  RuntimeMediaAssetRow,
  RuntimeTaskView,
  RuntimeTaskFailure,
  RuntimeTaskOutputView,
  RuntimeMediaAssetView,
  RuntimeJsonObject,
  RuntimeBatchRow,
  MediaAssetsChangedNotification,
} from "./schemas/runtime-transaction.schema";
export type {
  TaskStateNotification,
  TaskStateSnapshot,
} from "./task-notification";
export type {
  EffectiveProxyDecision,
  ProxyDecisionNotification,
  ProxyRefreshRequest,
} from "./proxy-decision";

export {
  RuntimeTaskRowSchema,
  RuntimeTaskOutputRowSchema,
  RuntimeMediaAssetRowSchema,
  RuntimeTaskViewSchema,
  RuntimeTaskFailureSchema,
  RuntimeTaskOutputViewSchema,
  RuntimeMediaAssetViewSchema,
  RuntimeMediaAssetOriginalSchema,
  RuntimeMediaAssetThumbnailSchema,
  RuntimeMediaAssetThumbnailErrorSchema,
  RuntimeMediaAssetLifecycleSchema,
  RuntimeJsonObjectSchema,
  RuntimeBatchRowSchema,
  UnifiedGenerationStatusSchema,
  MediaAssetsChangedNotificationSchema,
} from "./schemas/runtime-transaction.schema";
export {
  TaskStateNotificationSchema,
  TaskStateSnapshotSchema,
} from "./task-notification";

import type {
  MediaAssetsChangedNotification,
} from "./schemas/runtime-transaction.schema";
import {
  RuntimeBatchRowSchema,
  RuntimeMediaAssetRowSchema,
  RuntimeTaskOutputRowSchema,
  RuntimeTaskRowSchema,
} from "./schemas/runtime-transaction.schema";
import type {
  TaskStateNotification,
  TaskStateSnapshot,
} from "./task-notification";
import type {
  ProxyDecisionNotification,
  ProxyRefreshRequest,
} from "./proxy-decision";
import type { CredentialCryptoEncryptPayload, CredentialCryptoDecryptPayload, CredentialCryptoAvailablePayload } from "./credential-crypto-ipc";
import {
  UnifiedGenerationStatusSchema,
} from "./schemas/runtime-transaction.schema";

const RuntimeMessageBaseSchema = z.object({
  projectPath: z.string(),
  transactionId: z.string(),
});

export const RuntimeTransactionPayloadSchema = RuntimeMessageBaseSchema.extend({
  type: z.literal("runtime:execute-transaction"),
  tasks: z.array(RuntimeTaskRowSchema).optional(),
  taskOutputs: z.array(RuntimeTaskOutputRowSchema).optional(),
  mediaAssets: z.array(RuntimeMediaAssetRowSchema).optional(),
  batches: z.array(RuntimeBatchRowSchema).optional(),
});

export const RuntimeTransactionResultSchema = z.object({
  type: z.literal("runtime:transaction-result"),
  transactionId: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  needRefill: z.boolean().optional(),
});

export const TaskEventPayloadSchema = RuntimeMessageBaseSchema.extend({
  type: z.literal("runtime:write-task-event"),
  event: z.object({
    taskId: z.string(),
    eventType: z.string(),
    payload: z.record(z.unknown()),
    createdAt: z.number(),
  }),
});

export const ReadTasksPayloadSchema = RuntimeMessageBaseSchema.extend({
  type: z.literal("runtime:read-tasks"),
  status: UnifiedGenerationStatusSchema.optional(),
  limit: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().optional(),
});

export const ReadTaskByIdPayloadSchema = RuntimeMessageBaseSchema.extend({
  type: z.literal("runtime:read-task-by-id"),
  taskId: z.string(),
});

export const ReadBatchByIdPayloadSchema = RuntimeMessageBaseSchema.extend({
  type: z.literal("runtime:read-batch-by-id"),
  batchId: z.string(),
});

export const ReadTaskOutputsPayloadSchema = RuntimeMessageBaseSchema.extend({
  type: z.literal("runtime:read-task-outputs"),
  taskId: z.string(),
});

export const ReadMediaAssetsByTaskPayloadSchema = RuntimeMessageBaseSchema.extend({
  type: z.literal("runtime:read-media-assets-by-task"),
  taskId: z.string(),
});

export const ReadMediaAssetByIdPayloadSchema = RuntimeMessageBaseSchema.extend({
  type: z.literal("runtime:read-media-asset-by-id"),
  assetId: z.string(),
});

export const ReadAllMediaAssetsPayloadSchema = RuntimeMessageBaseSchema.extend({
  type: z.literal("runtime:read-all-media-assets"),
});

/**
 * 会话正式历史读取（Backend → Main，Backend 提交时加载历史并按上下文窗口截断）。
 *
 * 结果经 RuntimeTransactionResult.data 返回 `AgentMessageRecord[]`（按 seq 升序），
 * 消费端以 AgentMessageRecordSchema 解析。
 */
export const ReadAgentMessagesPayloadSchema = RuntimeMessageBaseSchema.extend({
  type: z.literal("runtime:read-agent-messages"),
  agentSessionId: z.string(),
});

export const DeleteTaskPayloadSchema = RuntimeMessageBaseSchema.extend({
  type: z.literal("runtime:delete-task"),
  taskId: z.string(),
});

export const ProjectScopeRegisterMessageSchema = z.object({
  type: z.literal("runtime:project-scope-register"),
  stableProjectId: z.string().min(1),
  projectPath: z.string().min(1),
  projectRef: z.string().min(1),
});

export const ProjectScopeUnregisterMessageSchema = z.object({
  type: z.literal("runtime:project-scope-unregister"),
  stableProjectId: z.string().min(1),
});

export const ProjectScopeSyncMessageSchema = z.object({
  type: z.literal("runtime:project-scope-sync"),
  scopes: z.array(z.object({
    stableProjectId: z.string().min(1),
    projectPath: z.string().min(1),
    projectRef: z.string().min(1),
  })),
});

export type RuntimeTransactionPayload = z.infer<typeof RuntimeTransactionPayloadSchema>;
export type RuntimeTransactionResult = z.infer<typeof RuntimeTransactionResultSchema>;
export type TaskEventPayload = z.infer<typeof TaskEventPayloadSchema>;
export type ReadTasksPayload = z.infer<typeof ReadTasksPayloadSchema>;
export type ReadTaskByIdPayload = z.infer<typeof ReadTaskByIdPayloadSchema>;
export type ReadBatchByIdPayload = z.infer<typeof ReadBatchByIdPayloadSchema>;
export type ReadTaskOutputsPayload = z.infer<typeof ReadTaskOutputsPayloadSchema>;
export type ReadMediaAssetsByTaskPayload = z.infer<typeof ReadMediaAssetsByTaskPayloadSchema>;
export type ReadMediaAssetByIdPayload = z.infer<typeof ReadMediaAssetByIdPayloadSchema>;
export type ReadAllMediaAssetsPayload = z.infer<typeof ReadAllMediaAssetsPayloadSchema>;
export type ReadAgentMessagesPayload = z.infer<typeof ReadAgentMessagesPayloadSchema>;
export type DeleteTaskPayload = z.infer<typeof DeleteTaskPayloadSchema>;
export type ProjectScopeRegisterMessage = z.infer<typeof ProjectScopeRegisterMessageSchema>;
export type ProjectScopeUnregisterMessage = z.infer<typeof ProjectScopeUnregisterMessageSchema>;
export type ProjectScopeSyncMessage = z.infer<typeof ProjectScopeSyncMessageSchema>;

export type BackendToMainMessage =
  | RuntimeTransactionPayload
  | TaskEventPayload
  | MediaAssetsChangedNotification
  | TaskStateNotification
  | TaskStateSnapshot
  | ProxyDecisionNotification
  | ReadTasksPayload
  | ReadTaskByIdPayload
  | ReadBatchByIdPayload
  | ReadTaskOutputsPayload
  | ReadMediaAssetsByTaskPayload
  | ReadMediaAssetByIdPayload
  | ReadAllMediaAssetsPayload
  | ReadAgentMessagesPayload
  | DeleteTaskPayload
  | CredentialCryptoEncryptPayload
  | CredentialCryptoDecryptPayload
  | CredentialCryptoAvailablePayload;

export type MainToBackendMessage =
  | RuntimeTransactionResult
  | ProjectScopeRegisterMessage
  | ProjectScopeUnregisterMessage
  | ProjectScopeSyncMessage
  | ProxyRefreshRequest;
