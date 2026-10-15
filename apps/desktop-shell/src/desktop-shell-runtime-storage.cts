import {
  deleteTaskWithOutputs,
  executeRuntimeTransaction,
  writeTaskEvent,
} from "./storage/editor-storage-runtime-writer.cjs";
import {
  getDb,
  getDbForExistingProject,
  readAgentMessages,
  readAllTasks,
  readAllMediaAssets,
  readBatchById,
  readBatchByClientRequestId,
  readMediaAssetById,
  readMediaAssetsByTaskId,
  readTaskById,
  readTaskOutputs,
} from "./storage/editor-storage-service.cjs";
import { toErrorMessage } from "./desktop-shell-utils.cjs";
import {
  DeleteTaskPayloadSchema,
  ReadAgentMessagesPayloadSchema,
  ReadAllMediaAssetsPayloadSchema,
  ReadBatchByIdPayloadSchema,
  ReadBatchByClientRequestIdPayloadSchema,
  ReadMediaAssetByIdPayloadSchema,
  ReadMediaAssetsByTaskPayloadSchema,
  ReadTaskByIdPayloadSchema,
  ReadTaskOutputsPayloadSchema,
  ReadTasksPayloadSchema,
  RuntimeTransactionPayloadSchema,
  TaskEventPayloadSchema,
} from "@iart/contracts";
import type { RuntimeTransactionResult, UnifiedGenerationStatus } from "@iart/contracts";

export type RuntimeMessageCandidate = {
  type: unknown | undefined;
  projectPath: unknown | undefined;
  transactionId: unknown | undefined;
  event: unknown | undefined;
  taskId: unknown | undefined;
  assetId: unknown | undefined;
  status: unknown | undefined;
  limit: unknown | undefined;
  offset: unknown | undefined;
  task: unknown | undefined;
  tasks: unknown | undefined;
  mediaAssets: unknown | undefined;
  baseUrl: unknown | undefined;
  port: unknown | undefined;
  code: unknown | undefined;
  message: unknown | undefined;
};

type RuntimeResultPatch = Omit<
  RuntimeTransactionResult,
  "type" | "transactionId"
>;

export const asRuntimeMessageCandidate = (
  value: unknown,
): RuntimeMessageCandidate | null =>
  typeof value === "object" && value !== null
    ? (value as RuntimeMessageCandidate)
    : null;

export const createRuntimeStorageMessageHandler = ({
  sendMessage,
  sendResult,
}: {
  sendMessage: (message: RuntimeTransactionResult) => void;
  sendResult: (transactionId: string, result: RuntimeResultPatch) => void;
}) => {
  const readTransactionId = (msg: RuntimeMessageCandidate) =>
    typeof msg.transactionId === "string" ? msg.transactionId : "";

  const sendInvalidPayloadResult = (
    msg: RuntimeMessageCandidate,
    payloadType: string,
  ) => {
    const transactionId = readTransactionId(msg);
    if (!transactionId) return;
    sendResult(transactionId, {
      success: false,
      error: `invalid ${payloadType} payload`,
    });
  };

  return (msg: RuntimeMessageCandidate): boolean => {
    if (msg.type === "runtime:execute-transaction") {
      const parsed = RuntimeTransactionPayloadSchema.safeParse(msg);
      if (!parsed.success) {
        sendInvalidPayloadResult(msg, "runtime:execute-transaction");
        return true;
      }
      const payload = parsed.data;
      let db: ReturnType<typeof getDb> | null = null;
      try {
        db = getDb(payload.projectPath);
        sendMessage(
          db
            ? executeRuntimeTransaction(db, payload)
            : {
                type: "runtime:transaction-result",
                transactionId: payload.transactionId,
                success: false,
                error: "project db unavailable",
              },
        );
      } catch (error) {
        sendResult(payload.transactionId, {
          success: false,
          error: toErrorMessage(error),
        });
      }
      return true;
    }
    if (msg.type === "runtime:write-task-event") {
      const parsed = TaskEventPayloadSchema.safeParse(msg);
      if (!parsed.success) {
        sendInvalidPayloadResult(msg, "runtime:write-task-event");
        return true;
      }
      const payload = parsed.data;
      let db: ReturnType<typeof getDb> | null = null;
      try {
        db = getDb(payload.projectPath);
        sendMessage(
          db
            ? writeTaskEvent(db, payload)
            : {
                type: "runtime:transaction-result",
                transactionId: payload.transactionId,
                success: false,
                error: "project db unavailable",
              },
        );
      } catch (error) {
        sendResult(payload.transactionId, {
          success: false,
          error: toErrorMessage(error),
        });
      }
      return true;
    }
    if (msg.type === "runtime:read-tasks") {
      const parsed = ReadTasksPayloadSchema.safeParse(msg);
      if (!parsed.success) {
        sendInvalidPayloadResult(msg, "runtime:read-tasks");
        return true;
      }
      const payload = parsed.data;
      const db = getDbForExistingProject(payload.projectPath);
      if (!db) {
        sendResult(payload.transactionId, {
          success: false,
          error: "project db unavailable",
        });
        return true;
      }
      try {
        sendResult(payload.transactionId, {
          success: true,
          data: readAllTasks(db, {
            status: payload.status,
            limit: typeof payload.limit === "number" ? payload.limit : undefined,
            offset: typeof payload.offset === "number" ? payload.offset : undefined,
          } as { status: UnifiedGenerationStatus | undefined; limit: number | undefined; offset: number | undefined }),
        });
      } catch (error) {
        sendResult(payload.transactionId, {
          success: false,
          error: toErrorMessage(error),
        });
      }
      return true;
    }
    if (msg.type === "runtime:read-task-by-id") {
      const parsed = ReadTaskByIdPayloadSchema.safeParse(msg);
      if (!parsed.success) {
        sendInvalidPayloadResult(msg, "runtime:read-task-by-id");
        return true;
      }
      const payload = parsed.data;
      const db = getDbForExistingProject(payload.projectPath);
      try {
        sendResult(payload.transactionId, {
          success: Boolean(db),
          data: db ? readTaskById(db, payload.taskId) : null,
          ...(!db ? { error: "project db unavailable" } : {}),
        });
      } catch (error) {
        sendResult(payload.transactionId, {
          success: false,
          error: toErrorMessage(error),
        });
      }
      return true;
    }
    if (msg.type === "runtime:read-batch-by-id") {
      const parsed = ReadBatchByIdPayloadSchema.safeParse(msg);
      if (!parsed.success) {
        sendInvalidPayloadResult(msg, "runtime:read-batch-by-id");
        return true;
      }
      const payload = parsed.data;
      const db = getDbForExistingProject(payload.projectPath);
      try {
        sendResult(payload.transactionId, {
          success: Boolean(db),
          data: { batch: db ? readBatchById(db, payload.batchId) : null },
          ...(!db ? { error: "project db unavailable" } : {}),
        });
      } catch (error) {
        sendResult(payload.transactionId, {
          success: false,
          error: toErrorMessage(error),
        });
      }
      return true;
    }
    if (msg.type === "runtime:read-batch-by-client-request-id") {
      const parsed = ReadBatchByClientRequestIdPayloadSchema.safeParse(msg);
      if (!parsed.success) {
        sendInvalidPayloadResult(msg, "runtime:read-batch-by-client-request-id");
        return true;
      }
      const payload = parsed.data;
      const db = getDbForExistingProject(payload.projectPath);
      try {
        sendResult(payload.transactionId, {
          success: Boolean(db),
          data: { batch: db ? readBatchByClientRequestId(db, payload.clientRequestId) : null },
          ...(!db ? { error: "project db unavailable" } : {}),
        });
      } catch (error) {
        sendResult(payload.transactionId, {
          success: false,
          error: toErrorMessage(error),
        });
      }
      return true;
    }
    if (msg.type === "runtime:read-task-outputs") {
      const parsed = ReadTaskOutputsPayloadSchema.safeParse(msg);
      if (!parsed.success) {
        sendInvalidPayloadResult(msg, "runtime:read-task-outputs");
        return true;
      }
      const payload = parsed.data;
      const db = getDbForExistingProject(payload.projectPath);
      try {
        sendResult(payload.transactionId, {
          success: Boolean(db),
          data: db ? readTaskOutputs(db, payload.taskId) : [],
          ...(!db ? { error: "project db unavailable" } : {}),
        });
      } catch (error) {
        sendResult(payload.transactionId, {
          success: false,
          error: toErrorMessage(error),
        });
      }
      return true;
    }
    if (msg.type === "runtime:read-media-assets-by-task") {
      const parsed = ReadMediaAssetsByTaskPayloadSchema.safeParse(msg);
      if (!parsed.success) {
        sendInvalidPayloadResult(msg, "runtime:read-media-assets-by-task");
        return true;
      }
      const payload = parsed.data;
      const db = getDbForExistingProject(payload.projectPath);
      try {
        sendResult(payload.transactionId, {
          success: Boolean(db),
          data: db ? readMediaAssetsByTaskId(db, payload.taskId) : [],
          ...(!db ? { error: "project db unavailable" } : {}),
        });
      } catch (error) {
        sendResult(payload.transactionId, {
          success: false,
          error: toErrorMessage(error),
        });
      }
      return true;
    }
    if (msg.type === "runtime:read-media-asset-by-id") {
      const parsed = ReadMediaAssetByIdPayloadSchema.safeParse(msg);
      if (!parsed.success) {
        sendInvalidPayloadResult(msg, "runtime:read-media-asset-by-id");
        return true;
      }
      const payload = parsed.data;
      const db = getDbForExistingProject(payload.projectPath);
      try {
        sendResult(payload.transactionId, {
          success: Boolean(db),
          data: db ? readMediaAssetById(db, payload.assetId) : null,
          ...(!db ? { error: "project db unavailable" } : {}),
        });
      } catch (error) {
        sendResult(payload.transactionId, {
          success: false,
          error: toErrorMessage(error),
        });
      }
      return true;
    }
    if (msg.type === "runtime:read-all-media-assets") {
      const parsed = ReadAllMediaAssetsPayloadSchema.safeParse(msg);
      if (!parsed.success) {
        sendInvalidPayloadResult(msg, "runtime:read-all-media-assets");
        return true;
      }
      const payload = parsed.data;
      const db = getDbForExistingProject(payload.projectPath);
      try {
        sendResult(payload.transactionId, {
          success: Boolean(db),
          data: db ? readAllMediaAssets(db) : [],
          ...(!db ? { error: "project db unavailable" } : {}),
        });
      } catch (error) {
        sendResult(payload.transactionId, {
          success: false,
          error: toErrorMessage(error),
        });
      }
      return true;
    }
    if (msg.type === "runtime:read-agent-messages") {
      const parsed = ReadAgentMessagesPayloadSchema.safeParse(msg);
      if (!parsed.success) {
        sendInvalidPayloadResult(msg, "runtime:read-agent-messages");
        return true;
      }
      const payload = parsed.data;
      const db = getDbForExistingProject(payload.projectPath);
      try {
        // 会话正式历史按 seq 升序返回（RuntimeTransactionResult.data 为 AgentMessageRecord[]）；
        // 项目库不可用时返回空数组并带 error，由 Backend 决定如何收口该轮。
        sendResult(payload.transactionId, {
          success: Boolean(db),
          data: db ? readAgentMessages(db, payload.agentSessionId) : [],
          ...(!db ? { error: "project db unavailable" } : {}),
        });
      } catch (error) {
        sendResult(payload.transactionId, {
          success: false,
          error: toErrorMessage(error),
        });
      }
      return true;
    }
    if (msg.type === "runtime:delete-task") {
      const parsed = DeleteTaskPayloadSchema.safeParse(msg);
      if (!parsed.success) {
        sendInvalidPayloadResult(msg, "runtime:delete-task");
        return true;
      }
      const payload = parsed.data;
      const db = getDbForExistingProject(payload.projectPath);
      try {
        if (db) deleteTaskWithOutputs(db, payload.taskId);
        sendResult(payload.transactionId, {
          success: Boolean(db),
          ...(!db ? { error: "project db unavailable" } : {}),
        });
      } catch (error) {
        sendResult(payload.transactionId, {
          success: false,
          error: toErrorMessage(error),
        });
      }
      return true;
    }
    return false;
  };
};
