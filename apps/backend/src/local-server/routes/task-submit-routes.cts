import { readJsonBodyOrSendError } from "../http/json-route.cts";
import {
  HubTaskListResponseSchema,
  RuntimeTaskViewSchema,
  UnifiedGenerationStatusSchema,
} from "@iart/contracts";
import type { RuntimeJsonObject } from "@iart/contracts";
import type { HeadersRecord, RouteDefinition } from "../http/route-registry.cts";
import * as loggingModule from "../logging.cts";
import {
  type AssemblerContext,
  ERROR_CODES,
  assembleExecutionPlanFromPrebuiltPayloadSafe,
  assembleGenerationTaskRequestSafe,
  buildTaskPassthroughMetadata,
  flushSubmittedTask,
  getAssembledExecutionPlan,
  getTaskRecordLike,
  getTaskSubmitBodyLike,
  getTasksReadResultLike,
  isJsonObject,
  normalizeString,
  parseTaskSubmission,
  projectFormalTaskExecutionPlan,
  projectFormalTaskMetadata,
  sendError,
  sendJson,
  sendReadTasks,
  submitExecutionPlanOrSendError,
  toCompatTaskAssembleErrorMessage,
} from "./task-submit-helpers.cts";

const handleTaskSubmit = async (body: unknown, corsHeaders: HeadersRecord, res: Parameters<RouteDefinition["handle"]>[0]["res"]) => {
  const typedBody = getTaskSubmitBodyLike(body);
  const modelId = normalizeString((typedBody !== null && typedBody !== undefined ? typedBody.model_id : undefined));
  if (!modelId) {
    sendError(res, 400, ERROR_CODES.INVALID_TASK, "Missing model_id", corsHeaders);
    return;
  }
  let assembled: unknown = null;
  const submitProjectPath = normalizeString(typedBody !== null && typedBody !== undefined ? typedBody.projectPath : undefined)
    || normalizeString(typedBody !== null && typedBody !== undefined ? typedBody.path : undefined)
    || null;
  const submitAssemblerContext: AssemblerContext = { projectPath: submitProjectPath, baseDir: null };
  try {
    assembled = isJsonObject((typedBody !== null && typedBody !== undefined ? typedBody.prebuilt_payload : undefined))
      ? assembleExecutionPlanFromPrebuiltPayloadSafe({ model_id: modelId, payload: (typedBody !== null && typedBody !== undefined ? typedBody.prebuilt_payload : undefined) }, submitAssemblerContext)
      : await assembleGenerationTaskRequestSafe(
          {
            model_id: modelId,
            arguments: (typedBody !== null && typedBody !== undefined ? typedBody.arguments : undefined),
            media_inputs: (typedBody !== null && typedBody !== undefined ? typedBody.media_inputs : undefined),
            input_assets: (typedBody !== null && typedBody !== undefined ? typedBody.input_assets : undefined),
            mention_map: (typedBody !== null && typedBody !== undefined ? typedBody.mention_map : undefined),
          },
          submitAssemblerContext,
        );
  } catch (error) {
    sendError(res, 400, ERROR_CODES.INVALID_TASK, toCompatTaskAssembleErrorMessage(error, "Failed to assemble task request"), corsHeaders);
    return;
  }
  const metadataInput = projectFormalTaskMetadata((typedBody !== null && typedBody !== undefined ? typedBody.metadata : undefined));
  const assembledExecutionPlan = getAssembledExecutionPlan(assembled);
  const executionPlan = projectFormalTaskExecutionPlan(
    assembledExecutionPlan,
    projectFormalTaskMetadata(assembledExecutionPlan.metadata, metadataInput, buildTaskPassthroughMetadata(typedBody, metadataInput)),
  );
  const submission = await submitExecutionPlanOrSendError(
    executionPlan,
    {
      actionId: undefined,
      actionName: undefined,
      actionClass: undefined,
      submissionTransport: "http",
      compatMode: "http_formal_task_submit",
      preserveLegacyTaskId: false,
    },
    res,
    corsHeaders,
  );
  if (!submission) return;
  const parsedSubmission = parseTaskSubmission(submission);
  if (!parsedSubmission.ok) {
    const statusCode = parsedSubmission.code === "runtime_write_failed" ? 500 : 400;
    sendError(res, statusCode, parsedSubmission.code || ERROR_CODES.INVALID_TASK, parsedSubmission.message, corsHeaders);
    return;
  }
  sendJson(res, 200, { taskId: parsedSubmission.taskId }, corsHeaders);
  flushSubmittedTask(submission);
};

/** 从任务 metadata 提取字符串字段（modelId 写入侧同时落 modelId 与 model_id 两个键，见 formal-task.cts）。 */
const readMetadataString = (metadata: RuntimeJsonObject | undefined, key: string): string | null => {
  const value = metadata ? metadata[key] : undefined;
  return normalizeString(value) || null;
};

const handleTaskList = async (url: URL, corsHeaders: HeadersRecord, res: Parameters<RouteDefinition["handle"]>[0]["res"]) => {
  const rawStatus = url.searchParams.get("status") || null;
  const parsedStatus = rawStatus ? UnifiedGenerationStatusSchema.safeParse(rawStatus) : null;
  if (rawStatus && !(parsedStatus !== null && parsedStatus !== undefined ? parsedStatus.success : undefined)) {
    sendError(res, 400, ERROR_CODES.INVALID_TASK, "Invalid task status", corsHeaders);
    return;
  }
  const status = (parsedStatus !== null && parsedStatus !== undefined && parsedStatus.success) ? parsedStatus.data : null;
  const limit = Number.parseInt(url.searchParams.get("limit") || "", 10);
  const offset = Number.parseInt(url.searchParams.get("offset") || "", 10);
  const projectPath = url.searchParams.get("projectPath") || "";
  try {
    const result = await sendReadTasks({
      projectPath,
      status,
      limit: Number.isFinite(limit) ? limit : null,
      offset: Number.isFinite(offset) ? offset : null,
    });
    const resultRecord = getTasksReadResultLike(result);
    // Main 侧失败（success:false）不得伪装成 200 空列表：按下游读取失败返回 HTTP 错误。
    if (resultRecord === null || resultRecord === undefined || resultRecord.success !== true) {
      loggingModule.logDebug("[task-submit-routes] task list read failed at Main", {
        projectPath,
        error: resultRecord !== null && resultRecord !== undefined ? resultRecord.error : undefined,
      });
      sendError(res, 500, ERROR_CODES.INTERNAL_ERROR, "Task list read failed", corsHeaders);
      return;
    }
    const tasks = Array.isArray(resultRecord.data) ? resultRecord.data : [];
    const mapped = tasks.flatMap((task: unknown) => {
      // Main 经 storage read 返回的是水合后的 RuntimeTaskView（request/metadata/failure 对象键），
      // 按 View schema 校验；Row schema（requestJson 等字符串列）是写路径契约，不用于本读取链路。
      const parsedTask = RuntimeTaskViewSchema.safeParse(task);
      if (!parsedTask.success) {
        const droppedRecord = getTaskRecordLike(task);
        loggingModule.logDebug("[task-submit-routes] task list row failed RuntimeTaskViewSchema parse, dropped", {
          projectPath,
          taskId: droppedRecord ? normalizeString(droppedRecord.taskId) || null : null,
          error: parsedTask.error.message.slice(0, 300),
        });
        return [];
      }
      const view = parsedTask.data;
      const taskId = normalizeString(view.taskId) || null;
      if (!taskId) {
        loggingModule.logDebug("[task-submit-routes] task list row missing taskId, dropped", { projectPath });
        return [];
      }
      const progressPercent = typeof view.progressPercent === "number" && Number.isFinite(view.progressPercent)
        ? view.progressPercent
        : null;
      return {
        taskId,
        id: taskId,
        projectPath: normalizeString(view.projectPath) || null,
        nodeGraphId: null,
        sourceNodeId: normalizeString(view.sourceNodeId) || null,
        targetNodeId: normalizeString(view.targetNodeId) || null,
        executionId: null,
        modelId: readMetadataString(view.metadata, "modelId") || readMetadataString(view.metadata, "model_id"),
        remoteRequestId: normalizeString(view.remoteRequestId) || null,
        status: view.status,
        createdAt: typeof view.createdAt === "number" ? view.createdAt : 0,
        updatedAt: typeof view.updatedAt === "number" ? view.updatedAt : 0,
        errorMessage: normalizeString(view.errorMessage) || null,
        progress: progressPercent,
      };
    });
    const payload = HubTaskListResponseSchema.parse({
      total: mapped.length,
      limit: Number.isFinite(limit) ? limit : mapped.length,
      offset: Number.isFinite(offset) ? offset : 0,
      tasks: mapped,
    });
    sendJson(
      res,
      200,
      payload,
      corsHeaders,
    );
  } catch (error) {
    loggingModule.logDebug("[task-submit-routes] task list read failed", {
      projectPath,
      error: error instanceof Error ? error.message : String(error),
    });
    sendError(res, 500, ERROR_CODES.INTERNAL_ERROR, "Task list read failed", corsHeaders);
  }
};

const createTaskSubmitRoutes = (): RouteDefinition[] => [
  {
    name: "tasks",
    match: ({ pathname }) => pathname === "/api/tasks",
    handle: async ({ req, res, url, corsHeaders }) => {
      if (req.method === "GET") {
        await handleTaskList(url, corsHeaders, res);
        return;
      }
      if (req.method === "POST") {
        const body = await readJsonBodyOrSendError(req, res, corsHeaders);
        if (body == null) return;
        await handleTaskSubmit(body, corsHeaders, res);
        return;
      }
      sendError(res, 405, ERROR_CODES.METHOD_NOT_ALLOWED, "Method not allowed", corsHeaders);
    },
  },
];

export { createTaskSubmitRoutes };
