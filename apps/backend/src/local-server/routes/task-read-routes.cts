import * as fs from "node:fs";
import * as path from "node:path";

import * as backendIpcSenderModule from "../backend-ipc-sender.cts";
import * as constantsModule from "../constants.cts";
import * as httpUtilsModule from "../http-utils.cts";
import type { HeadersRecord, RouteDefinition } from "../http/route-registry.cts";
import * as taskArchiveReadModelModule from "../task-archive-read-model.cts";
import * as taskEngineModule from "../task-engine.cts";
import * as taskExecutorModule from "../task-executor.cts";
import * as taskCancelServiceModule from "../task-cancel-service.cts";
import * as taskRequeryModule from "../task-requery.cts";
import * as utilsModule from "../utils.cts";
import { TaskCancelAcceptedResponseSchema, TaskRequeryAcceptedSchema, type RuntimeTaskView } from "@iart/contracts";

type TaskResultFileLike = { contentType: unknown | undefined; path: unknown | undefined };
type TaskResultResponseLike = {
  contentType: unknown | undefined;
  body: unknown | undefined;
  bodyType: unknown | undefined;
  file: unknown | undefined;
  localOutput: unknown | undefined;
  localOutputs: unknown | undefined;
  mediaDownload: unknown | undefined;
  pollingCompletion: unknown | undefined;
  receivedAt: unknown | undefined;
};
type TaskArchiveEventLike = {
  type: unknown | undefined;
  timestamp: unknown | undefined;
  detail: unknown | undefined;
  snapshot: unknown | undefined;
};
type TaskArchiveDetailLike = {
  status: unknown | undefined;
  taskId: unknown | undefined;
  phase: unknown | undefined;
  remoteRequestId: unknown | undefined;
};
type TaskArchiveSnapshotLike = { task: unknown | undefined };
type TaskArchiveTaskLike = {
  id: unknown | undefined;
  status: unknown | undefined;
  progress: unknown | undefined;
  error: unknown | undefined;
  metadata: unknown | undefined;
};
type TaskArchiveMetadataLike = { remoteRequestId: unknown | undefined };
type TaskArchiveProgressLike = { phase: unknown | undefined };
type TaskArchiveErrorLike = {
  message: unknown | undefined;
  code: unknown | undefined;
  details: unknown | undefined;
};
type TaskRecordLike = {
  taskId: unknown | undefined;
  projectPath: unknown | undefined;
  status: unknown | undefined;
  error: unknown | undefined;
  response: unknown | undefined;
  metadata: unknown | undefined;
};
type ReadTaskByIdResult = { success: boolean | undefined; data: unknown | undefined; task: unknown | undefined };
type TaskResultResponsePayload = {
  res: Parameters<RouteDefinition["handle"]>[0]["res"];
  response: unknown;
  projectPath: unknown;
  corsHeaders: HeadersRecord;
};

const { ERROR_CODES } = constantsModule;
const { sendJson, sendError } = httpUtilsModule;
const { decodeTaskIdFromUrl } = taskEngineModule;
const { isPlainObject } = utilsModule;

const sendReadTaskByIdSafe = async (params: {
  projectPath: string;
  taskId: string;
}): Promise<ReadTaskByIdResult> => {
  const result = await backendIpcSenderModule.sendReadTaskById(params);
  if (!isJsonObject(result)) {
    return { success: false, data: undefined, task: undefined };
  }
  return {
    success: typeof result.success === "boolean" ? result.success : undefined,
    data: "data" in result ? result.data : undefined,
    task: "task" in result ? result.task : undefined,
  };
};

const isJsonObject = (value: unknown): value is object => Boolean(value && typeof value === "object" && !Array.isArray(value));

const normalizeString = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : "");

const getTaskArchiveDetailLike = (value: unknown): TaskArchiveDetailLike | null => (isJsonObject(value) ? (value as TaskArchiveDetailLike) : null);
const getTaskArchiveEventLike = (value: unknown): TaskArchiveEventLike | null => (isJsonObject(value) ? (value as TaskArchiveEventLike) : null);
const getTaskArchiveMetadataLike = (value: unknown): TaskArchiveMetadataLike | null => (isJsonObject(value) ? (value as TaskArchiveMetadataLike) : null);
const getTaskArchiveProgressLike = (value: unknown): TaskArchiveProgressLike | null => (isJsonObject(value) ? (value as TaskArchiveProgressLike) : null);
const getTaskArchiveErrorLike = (value: unknown): TaskArchiveErrorLike | null => (isJsonObject(value) ? (value as TaskArchiveErrorLike) : null);
const getTaskArchiveSnapshotLike = (value: unknown): TaskArchiveSnapshotLike | null => (isJsonObject(value) ? (value as TaskArchiveSnapshotLike) : null);
const getTaskArchiveTaskLike = (value: unknown): TaskArchiveTaskLike | null => (isJsonObject(value) ? (value as TaskArchiveTaskLike) : null);
const getTaskRecordLike = (value: unknown): TaskRecordLike | null => (isJsonObject(value) ? (value as TaskRecordLike) : null);
const getTaskResultFileLike = (value: unknown): TaskResultFileLike | null => (isJsonObject(value) ? (value as TaskResultFileLike) : null);
const getTaskResultResponseLike = (value: unknown): TaskResultResponseLike | null => (isJsonObject(value) ? (value as TaskResultResponseLike) : null);

const isSafeRelativePath = (relativePath: unknown) => {
  if (!relativePath || typeof relativePath !== "string") return false;
  const trimmed = relativePath.trim();
  if (!trimmed) return false;
  if (path.isAbsolute(trimmed)) return false;
  const normalized = trimmed.replace(/\\/g, "/");
  return !normalized.startsWith("..") && !normalized.includes("/../");
};

const resolveTaskResultContentType = (response: unknown) => {
  const responseRecord = getTaskResultResponseLike(response);
  if (!responseRecord) return "application/octet-stream";
  if (typeof responseRecord.contentType === "string" && responseRecord.contentType.trim()) {
    return responseRecord.contentType.trim();
  }
  const file = getTaskResultFileLike(responseRecord.file);
  if (file && typeof file.contentType === "string" && file.contentType.trim()) {
    return file.contentType.trim();
  }
  if (responseRecord.bodyType === "json") return "application/json; charset=utf-8";
  return "application/octet-stream";
};

const resolveTaskResultFilePath = (response: unknown, projectPath: unknown) => {
  const responseRecord = getTaskResultResponseLike(response);
  const fileRecord = getTaskResultFileLike((responseRecord !== null && responseRecord !== undefined ? responseRecord.file : undefined));
  const refPath = fileRecord && typeof fileRecord.path === "string" ? fileRecord.path.trim() : "";
  if (!refPath) return null;
  if (path.isAbsolute(refPath)) return refPath;
  const root = normalizeString(projectPath);
  if (!root || !isSafeRelativePath(refPath)) return null;
  try {
    const projectRoot = path.resolve(root);
    const resolved = path.resolve(root, refPath);
    const within = path.relative(projectRoot, resolved);
    if (!within || within.startsWith("..") || path.isAbsolute(within)) return null;
    return resolved;
  } catch {
    return null;
  }
};

const buildTaskArchiveDerivedResultPayload = (taskId: unknown, record: unknown, archiveEvent: unknown) => {
  const recordData = getTaskRecordLike(record);
  const archiveEventRecord = getTaskArchiveEventLike(archiveEvent);
  const detail = getTaskArchiveDetailLike((archiveEventRecord !== null && archiveEventRecord !== undefined ? archiveEventRecord.detail : undefined));
  const snapshot = getTaskArchiveSnapshotLike((archiveEventRecord !== null && archiveEventRecord !== undefined ? archiveEventRecord.snapshot : undefined));
  const snapshotTask = getTaskArchiveTaskLike((snapshot !== null && snapshot !== undefined ? snapshot.task : undefined));
  const recordMetadata = getTaskArchiveMetadataLike((recordData !== null && recordData !== undefined ? recordData.metadata : undefined));
  const snapshotMetadata = getTaskArchiveMetadataLike((snapshotTask !== null && snapshotTask !== undefined ? snapshotTask.metadata : undefined));
  const snapshotProgress = getTaskArchiveProgressLike((snapshotTask !== null && snapshotTask !== undefined ? snapshotTask.progress : undefined));
  const error = getTaskArchiveErrorLike((recordData !== null && recordData !== undefined ? recordData.error : undefined)) || getTaskArchiveErrorLike((snapshotTask !== null && snapshotTask !== undefined ? snapshotTask.error : undefined)) || null;
  return {
    taskId,
    status: normalizeString((recordData !== null && recordData !== undefined ? recordData.status : undefined)).toLowerCase() || normalizeString((detail !== null && detail !== undefined ? detail.status : undefined)).toLowerCase() || normalizeString((snapshotTask !== null && snapshotTask !== undefined ? snapshotTask.status : undefined)).toLowerCase() || null,
    error,
    archive: archiveEvent && archiveEventRecord
      ? {
          type: typeof archiveEventRecord.type === "string" ? archiveEventRecord.type : null,
          timestamp: typeof archiveEventRecord.timestamp === "string" ? archiveEventRecord.timestamp : null,
          taskId: normalizeString((detail !== null && detail !== undefined ? detail.taskId : undefined) || (snapshotTask !== null && snapshotTask !== undefined ? snapshotTask.id : undefined)) || null,
          phase: normalizeString((detail !== null && detail !== undefined ? detail.phase : undefined) || (snapshotProgress !== null && snapshotProgress !== undefined ? snapshotProgress.phase : undefined)) || null,
          remoteRequestId: normalizeString((detail !== null && detail !== undefined ? detail.remoteRequestId : undefined) || (recordMetadata !== null && recordMetadata !== undefined ? recordMetadata.remoteRequestId : undefined) || (snapshotMetadata !== null && snapshotMetadata !== undefined ? snapshotMetadata.remoteRequestId : undefined)) || null,
        }
      : null,
  };
};

const trySendTaskResultFromResponse = ({ res, response, projectPath, corsHeaders }: TaskResultResponsePayload) => {
  const responseRecord = getTaskResultResponseLike(response);
  if (!responseRecord) return false;
  const filePath = resolveTaskResultFilePath(responseRecord, projectPath);
  if (filePath && fs.existsSync(filePath)) {
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      "Content-Type": resolveTaskResultContentType(responseRecord),
      "Content-Length": stat.size,
      ...corsHeaders,
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }
  if (responseRecord.body !== null && responseRecord.body !== undefined) {
    if (responseRecord.bodyType === "json" || isPlainObject(responseRecord.body) || Array.isArray(responseRecord.body)) {
      sendJson(res, 200, responseRecord.body, corsHeaders);
      return true;
    }
    res.writeHead(200, {
      "Content-Type": resolveTaskResultContentType(responseRecord) || "text/plain; charset=utf-8",
      ...corsHeaders,
    });
    res.end(typeof responseRecord.body === "string" ? responseRecord.body : JSON.stringify(responseRecord.body));
    return true;
  }
  if (
    (responseRecord.localOutput && typeof responseRecord.localOutput === "object") ||
    (Array.isArray(responseRecord.localOutputs) && responseRecord.localOutputs.length > 0) ||
    (responseRecord.mediaDownload && typeof responseRecord.mediaDownload === "object") ||
    (responseRecord.pollingCompletion && typeof responseRecord.pollingCompletion === "object")
  ) {
    sendJson(
      res,
      200,
      {
        localOutput: responseRecord.localOutput ?? null,
        localOutputs: Array.isArray(responseRecord.localOutputs) ? responseRecord.localOutputs : null,
        mediaDownload: responseRecord.mediaDownload ?? null,
        pollingCompletion: responseRecord.pollingCompletion ?? null,
      },
      corsHeaders,
    );
    return true;
  }
  return false;
};

const readLatestTaskArchiveResultContext = (input: unknown) => {
  const inputRecord = getTaskRecordLike(input);
  return taskArchiveReadModelModule.readLatestTaskArchiveContext({
    taskId: (inputRecord !== null && inputRecord !== undefined ? inputRecord.taskId : undefined),
    projectPath: (inputRecord !== null && inputRecord !== undefined ? inputRecord.projectPath : undefined),
    metadata: (inputRecord !== null && inputRecord !== undefined ? inputRecord.metadata : undefined),
  });
};

const handleTaskCancel = async (
  taskId: string,
  projectPath: string,
  corsHeaders: HeadersRecord,
  res: Parameters<RouteDefinition["handle"]>[0]["res"],
) => {
  let view: RuntimeTaskView | null = null;
  try {
    const result = await sendReadTaskByIdSafe({ projectPath, taskId });
    const raw = result !== null && result !== undefined && result.success ? result.data : null;
    view = isJsonObject(raw) ? (raw as RuntimeTaskView) : null;
  } catch {
    view = null;
  }
  if (!view) {
    sendError(res, 404, ERROR_CODES.TASK_NOT_FOUND, "Task not found", corsHeaders);
    return;
  }
  const effectiveProject = typeof view.projectPath === "string" && view.projectPath ? view.projectPath : projectPath;
  // 已进入正式终态的任务不接受取消（spec task-state-machine cancellation）。
  if (taskEngineModule.isTaskFinalStatus(view.status)) {
    sendError(res, 409, ERROR_CODES.INVALID_TASK, "Task already in terminal state; cancel not accepted", corsHeaders);
    return;
  }
  const nowIso = new Date().toISOString();
  // 取消屏障先于持久化建立，阻断「读取状态之后」到达的成功事务（spec cancel races）。
  taskCancelServiceModule.registerCancelledBarrier(taskId);
  const persisted = await taskCancelServiceModule.persistCancelRecord({
    taskId,
    projectPath: effectiveProject,
    status: view.status,
    metadata: view.metadata ?? {},
    request: view.request ?? null,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  });
  if (!persisted) {
    taskCancelServiceModule.unregisterCancelledBarrier(taskId);
    sendError(res, 500, ERROR_CODES.INTERNAL_ERROR, "Failed to persist cancel record", corsHeaders);
    return;
  }
  const acceptedPayload = TaskCancelAcceptedResponseSchema.parse({
    accepted: true,
    task_id: taskId,
    cancelled_at: nowIso,
  });
  sendJson(res, 200, acceptedPayload, corsHeaders);
  // 命令被接受后才 abort 进行中请求并结算为独立 cancelled 终态；
  // 结算写库成功后才由 settleCancelledTask 发送状态变化通知。
  setImmediate(() => {
    void (async () => {
      taskExecutorModule.cancelTaskExecution(taskId);
      await taskCancelServiceModule.settleCancelledTask({
        taskId,
        projectPath: effectiveProject,
        metadata: view.metadata ?? {},
        request: view.request ?? null,
        createdAt: view.createdAt,
        updatedAt: view.updatedAt,
        cancelRecord: taskCancelServiceModule.buildCancelRecord(taskId, nowIso),
      });
    })();
  });
};

const handleTaskRequery = async (
  taskId: string,
  projectPath: string,
  corsHeaders: HeadersRecord,
  res: Parameters<RouteDefinition["handle"]>[0]["res"],
) => {
  let record: unknown = null;
  try {
    const result = await sendReadTaskByIdSafe({ projectPath, taskId });
    record = result !== null && result !== undefined && result.success ? result.data : null;
  } catch {
    record = null;
  }
  if (!isJsonObject(record)) {
    sendError(res, 404, ERROR_CODES.TASK_NOT_FOUND, "Task not found", corsHeaders);
    return;
  }
  let outcome: Awaited<ReturnType<typeof taskRequeryModule.requeryFailedTask>>;
  try {
    outcome = await taskRequeryModule.requeryFailedTask(record);
  } catch {
    sendError(res, 500, ERROR_CODES.INTERNAL_ERROR, "Failed to requery task result", corsHeaders);
    return;
  }
  if (!outcome.ok) {
    // 资格 / 预检拒绝统一 409：命令本身合法，但当前任务状态不接受重新查询。
    // 错误码保留具体拒绝原因（连接不可用 / 凭证失效 / 在途等），供 Editor 映射用户文案；
    // 不得统一压成 invalid_task，否则前端只能拿内部措辞直接展示。
    sendError(res, 409, outcome.code, outcome.message, corsHeaders);
    return;
  }
  const acceptedPayload = TaskRequeryAcceptedSchema.parse({
    accepted: true,
    taskId: outcome.taskId,
    status: "polling",
    requestedAt: outcome.requestedAt,
  });
  sendJson(res, 200, acceptedPayload, corsHeaders);
};

const handleTaskByIdRoute = async ({ req, res, url, pathname, corsHeaders }: Parameters<RouteDefinition["handle"]>[0]) => {
  const segments = pathname.replace("/api/tasks/", "").split("/").filter(Boolean);
  const [first, second] = segments;
  const taskId = decodeTaskIdFromUrl(first);
  if (!taskId) {
    sendError(res, 400, ERROR_CODES.INVALID_TASK, "Invalid task id", corsHeaders);
    return;
  }
  const projectPath = url.searchParams.get("projectPath") || "";
  if (!second) {
    if (req.method === "GET") {
      try {
        const result = await sendReadTaskByIdSafe({ projectPath, taskId });
        const task = (result !== null && result !== undefined ? result.success : undefined) ? result.data : null;
        if (!task) {
          sendError(res, 404, ERROR_CODES.TASK_NOT_FOUND, "Task not found", corsHeaders);
          return;
        }
        sendJson(res, 200, { task }, corsHeaders);
      } catch {
        sendError(res, 404, ERROR_CODES.TASK_NOT_FOUND, "Task not found", corsHeaders);
      }
      return;
    }
    if (req.method === "DELETE") {
      try {
        await backendIpcSenderModule.sendDeleteTask({ projectPath, taskId });
      } catch {
        void 0;
      }
      sendJson(res, 200, { success: true }, corsHeaders);
      return;
    }
    sendError(res, 405, ERROR_CODES.METHOD_NOT_ALLOWED, "Method not allowed", corsHeaders);
    return;
  }
  if (second === "cancel" && req.method === "POST") {
    await handleTaskCancel(taskId, projectPath, corsHeaders, res);
    return;
  }
  if (second === "requery" && req.method === "POST") {
    await handleTaskRequery(taskId, projectPath, corsHeaders, res);
    return;
  }
  if (second === "resume" && req.method === "POST") {
    sendError(res, 410, ERROR_CODES.INVALID_TASK, "Task resume is not supported; please submit a new task instead", corsHeaders);
    return;
  }
  if (second === "result" && req.method === "GET") {
    let record: TaskRecordLike | null = null;
    try {
      const result = await sendReadTaskByIdSafe({ projectPath, taskId });
      record = getTaskRecordLike((result !== null && result !== undefined ? result.task : undefined));
    } catch {
      void 0;
    }
    const taskProjectPath = (record !== null && record !== undefined ? record.projectPath : undefined) || projectPath || null;
    const response = record !== null && record.response !== undefined && typeof record.response === "object" ? record.response : null;
    if (
      trySendTaskResultFromResponse({
        res,
        response,
        projectPath: taskProjectPath,
        corsHeaders,
      })
    )
      return;
    const archiveContext = readLatestTaskArchiveResultContext({
      taskId,
      projectPath: taskProjectPath,
      metadata: record !== null ? record.metadata : undefined,
    });
    if (archiveContext || (record !== null ? record.error : undefined) || normalizeString(record !== null ? record.status : undefined)) {
      sendJson(res, 200, buildTaskArchiveDerivedResultPayload(taskId, record, archiveContext !== null ? archiveContext.event : undefined), corsHeaders);
      return;
    }
    sendError(res, 409, ERROR_CODES.TASK_NOT_READY, "Task result not ready", corsHeaders);
    return;
  }
  sendError(res, 404, ERROR_CODES.NOT_FOUND, "Not found", corsHeaders);
};

const createTaskReadRoutes = (): RouteDefinition[] => [
  {
    name: "task-by-id",
    match: ({ pathname }) => pathname.startsWith("/api/tasks/"),
    handle: handleTaskByIdRoute,
  },
];

export { createTaskReadRoutes };
