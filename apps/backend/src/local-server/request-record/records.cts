import * as fs from "node:fs";
import * as path from "node:path";

import {
  type RequestLogRecord,
  normalizeString,
  readHttpRequestPayload,
  readHttpResponsePayload,
  readObject,
  readRecordMetadata,
  readRecordOptions,
} from "./common.cts";
import { resolveRecordAppVersion } from "./app-version.cts";
import {
  buildLogFilename,
  ensureRequestLogDir,
  findLatestRequestLogFilePathByTaskId,
  maybeCleanupOldLogs,
  readRequestLogRecordFile,
  syncTaskRequestLogArtifact,
  toProjectRelativePath,
  writeRequestLogRecordFile,
} from "./log-files.cts";
import {
  extractInlineDataSummary,
  sanitizeHeaders,
  sanitizePayload,
} from "./sanitize.cts";

type PatchOptions = {
  projectPath: unknown | undefined;
  taskId: unknown | undefined;
  patch: unknown | undefined;
};

type RecordPatch = (record: RequestLogRecord) => void;

const isRecordPatch = (value: unknown): value is RecordPatch =>
  typeof value === "function";

export const patchLatestRequestLogRecordByTaskId = (
  options: unknown,
): { ok: boolean; reason: string | undefined; filePath: string | undefined } => {
  const opts = readObject(options) as PatchOptions | null;
  const projectPath = normalizeString((opts !== null && opts !== undefined ? opts.projectPath : undefined) || "");
  const taskId = normalizeString((opts !== null && opts !== undefined ? opts.taskId : undefined) || "");
  const patch = (opts !== null && opts !== undefined ? opts.patch : undefined);

  if (!taskId) return { ok: false as const, reason: "missing-task-id", filePath: undefined };
  if (!isRecordPatch(patch)) return { ok: false, reason: "invalid-patch", filePath: undefined };

  const filePath = findLatestRequestLogFilePathByTaskId(
    projectPath || null,
    taskId,
  );
  if (!filePath) return { ok: false, reason: "not-found", filePath: undefined };

  const record = readRequestLogRecordFile(filePath);
  if (!record) return { ok: false, reason: "invalid-record", filePath: undefined };

  try {
    patch(record);
  } catch {
    return { ok: false, reason: "patch-failed", filePath: undefined };
  }

  return writeRequestLogRecordFile(filePath, record)
    ? { ok: true as const, filePath, reason: undefined }
    : { ok: false, reason: "write-failed", filePath: undefined };
};

export const readLatestRequestLogRecordByTaskId = (
  projectPath: unknown,
  taskId: unknown,
): { filePath: string; record: RequestLogRecord } | null => {
  const filePath = findLatestRequestLogFilePathByTaskId(projectPath, taskId);
  if (!filePath) return null;

  const record = readRequestLogRecordFile(filePath);
  if (!record) return null;

  return { filePath, record };
};

export const writeHttpRequestRecord = (options: unknown): boolean => {
  const opts = readRecordOptions(options);
  if (!opts) return false;

  const metadata = readRecordMetadata(opts.metadata);
  const request = readHttpRequestPayload(opts.request);
  const requestMeta = readRecordMetadata((request !== null && request !== undefined ? request.metadata : undefined));
  const response = readHttpResponsePayload(opts.response);
  const taskId =
    normalizeString(opts.taskId) ||
    normalizeString((metadata !== null && metadata !== undefined ? metadata.taskId : undefined)) ||
    normalizeString((requestMeta !== null && requestMeta !== undefined ? requestMeta.taskId : undefined));
  const subjectId = taskId || "unknown";
  const attempt = Number.isFinite(opts.attempt)
    ? Number(opts.attempt)
    : undefined;
  const projectPath = normalizeString(opts.projectPath) || null;
  const record = {
    version: 1,
    kind: "http",
    appVersion: resolveRecordAppVersion(opts),
    taskId: taskId || null,
    attempt: attempt ?? null,
    createdAt: new Date().toISOString(),
    projectPath,
    metadata: sanitizePayload(opts.metadata ?? null),
    request: {
      url: normalizeString((request !== null && request !== undefined ? request.url : undefined)) || null,
      method: normalizeString((request !== null && request !== undefined ? request.method : undefined)) || null,
      headers: sanitizeHeaders((request !== null && request !== undefined ? request.headers : undefined) ?? null),
      inlineDataSummary: extractInlineDataSummary((request !== null && request !== undefined ? request.body : undefined) ?? null),
      body: sanitizePayload((request !== null && request !== undefined ? request.body : undefined) ?? null),
    },
    response: response
      ? {
          status: Number.isFinite(response.status) ? response.status : null,
          ok: typeof response.ok === "boolean" ? response.ok : null,
          contentType: normalizeString(response.contentType) || null,
          headers: sanitizeHeaders(response.headers ?? null),
          body: sanitizePayload(response.body ?? null),
          bodyType: normalizeString(response.bodyType) || null,
          file: sanitizePayload(response.file ?? null),
          resultSummary: sanitizePayload(response.resultSummary ?? null),
          resultRef: sanitizePayload(response.resultRef ?? null),
          size: Number.isFinite(response.size) ? response.size : null,
          receivedAt: normalizeString(response.receivedAt) || null,
          error: response.error ? sanitizePayload(response.error) : null,
        }
      : null,
    error: opts.error ? sanitizePayload(opts.error) : null,
    timing: sanitizePayload(opts.timing ?? null),
  };
  const dir = ensureRequestLogDir(projectPath);
  const filePath = path.join(dir, buildLogFilename(subjectId, attempt));

  try {
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2), "utf-8");
    maybeCleanupOldLogs(dir);

    if (taskId) {
      syncTaskRequestLogArtifact(taskId, projectPath, {
        latestRequestLog: {
          path: projectPath
            ? toProjectRelativePath(projectPath, filePath) || filePath
            : filePath,
          taskId: taskId || null,
          attempt: attempt ?? null,
          updatedAt: record.createdAt,
        },
      });
    }

    return true;
  } catch {
    return false;
  }
};
