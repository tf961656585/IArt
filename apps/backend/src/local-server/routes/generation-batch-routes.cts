import { readJsonBodyOrSendError } from "../http/json-route.cts";
import type { RouteDefinition } from "../http/route-registry.cts";
import * as constantsModule from "../constants.cts";
import * as httpUtilsModule from "../http-utils.cts";
import {
  BatchIntentSnapshotSchema,
  PromptDockBatchSubmitRequestSchema,
  PromptDockBatchSubmitResponseSchema,
} from "@iart/contracts";
import {
  acceptGenerationBatch,
  dispatchAcceptedBatch,
  persistAcceptedBatch,
} from "../business-actions/generation-batch.cts";
import * as backendIpcSenderModule from "../backend-ipc-sender.cts";
import * as loggingModule from "../logging.cts";

const { ERROR_CODES } = constantsModule;
const { sendJson, sendError } = httpUtilsModule;

/**
 * GenerationBatch 受理端点（TODO 4 / PromptDock 生成主链§4 / runtime spec「固定任务数」）。
 *
 * - POST /api/generation-batches：严格 parse PromptDockBatchSubmitRequestSchema；
 *   单个 RuntimeTransaction 原子写入 1 个 batch 行 + 恰好 N 个 task 行；
 *   ack-before-dispatch：响应先行写出，随后 setImmediate 直接并发派发 N 个任务。
 * - 接受失败不得返回部分任务集合。
 */
const handleGenerationBatchSubmit = async (
  body: unknown,
  corsHeaders: Record<string, string>,
  res: Parameters<RouteDefinition["handle"]>[0]["res"],
) => {
  const parsed = PromptDockBatchSubmitRequestSchema.safeParse(body);
  if (!parsed.success) {
    loggingModule.logDebug("[generation-batch] invalid submit request", {
      error: parsed.error.message,
    });
    sendError(res, 400, ERROR_CODES.INVALID_TASK, parsed.error.message, corsHeaders);
    return;
  }
  const accepted = await acceptGenerationBatch({
    body: parsed.data,
    baseDir: null,
  });
  if (!accepted.ok) {
    sendError(res, 400, ERROR_CODES.INVALID_TASK, accepted.message, corsHeaders);
    return;
  }
  const persisted = await persistAcceptedBatch({
    projectPath: parsed.data.project_path,
    intentSnapshot: accepted.intentSnapshot,
    tasks: accepted.tasks,
  });
  if (!persisted.ok) {
    sendError(res, 500, ERROR_CODES.INTERNAL_ERROR, persisted.message, corsHeaders);
    return;
  }

  const responsePayload = PromptDockBatchSubmitResponseSchema.parse({
    batch_id: accepted.batchId,
    intent_snapshot: accepted.intentSnapshot,
    tasks: persisted.tasks.map((task) => ({
      task_id: task.taskId,
      task_index: task.taskIndex,
    })),
  });
  // ack-before-dispatch：响应落库并写出后，才直接并发派发（避免任务状态通知早于 Editor 建投影）。
  sendJson(res, 200, responsePayload, corsHeaders);
  setImmediate(() => {
    dispatchAcceptedBatch({
      projectPath: parsed.data.project_path,
      tasks: persisted.tasks,
    });
  });
};

/**
 * Batch 快照读取端点（Editor 资产「复用」/失败重试回填创作面用，产品 spec「复用」段）。
 *
 * GET /api/generation-batches/:batchId?projectPath=...：经 storage read（runtime:read-batch-by-id）
 * 读取受理时冻结的 BatchIntentSnapshot（batches.payloadJson 无损持久化）。快照缺失或
 * payload 不合规按 404 处理；不回填连接/凭证/部署/执行快照（spec PromptDock生成主链.md）。
 */
const handleGenerationBatchRead = async (
  batchIdRaw: string,
  projectPath: string,
  corsHeaders: Record<string, string>,
  res: Parameters<RouteDefinition["handle"]>[0]["res"],
) => {
  const batchId = batchIdRaw.trim();
  if (!batchId || !projectPath.trim()) {
    sendError(res, 400, ERROR_CODES.INVALID_TASK, "batchId and projectPath are required", corsHeaders);
    return;
  }
  let result: Awaited<ReturnType<typeof backendIpcSenderModule.sendReadBatchById>>;
  try {
    result = await backendIpcSenderModule.sendReadBatchById({
      projectPath,
      batchId,
    });
  } catch (error) {
    loggingModule.logDebug("[generation-batch] read snapshot ipc failed", { batchId, error });
    sendError(res, 500, ERROR_CODES.INTERNAL_ERROR, "Batch snapshot read failed", corsHeaders);
    return;
  }
  const data = result.success ? result.data : null;
  const batchField = data != null && typeof data === "object" && !Array.isArray(data)
    ? (data as { batch?: unknown }).batch
    : null;
  const parsed = BatchIntentSnapshotSchema.nullable().safeParse(batchField ?? null);
  if (!parsed.success || parsed.data === null) {
    sendError(res, 404, ERROR_CODES.NOT_FOUND, "Batch snapshot not found", corsHeaders);
    return;
  }
  sendJson(res, 200, { batch: parsed.data }, corsHeaders);
};

const createGenerationBatchRoutes = (): RouteDefinition[] => [
  {
    name: "generation-batches",
    match: ({ req, pathname }) => pathname === "/api/generation-batches" && req.method === "POST",
    handle: async ({ req, res, corsHeaders }) => {
      const body = await readJsonBodyOrSendError(req, res, corsHeaders);
      if (body == null) return;
      await handleGenerationBatchSubmit(body, corsHeaders, res);
    },
  },
  {
    name: "generation-batch-by-id",
    match: ({ req, pathname }) =>
      req.method === "GET" && pathname.startsWith("/api/generation-batches/"),
    handle: async ({ res, url, pathname, corsHeaders }) => {
      const segments = pathname.replace("/api/generation-batches/", "").split("/").filter(Boolean);
      const first = segments[0] ?? "";
      let batchId = first;
      try {
        batchId = decodeURIComponent(first);
      } catch {
        // 保留原值（decode 失败不阻断读取）
      }
      await handleGenerationBatchRead(batchId, url.searchParams.get("projectPath") ?? "", corsHeaders, res);
    },
  },
];

export { createGenerationBatchRoutes };
