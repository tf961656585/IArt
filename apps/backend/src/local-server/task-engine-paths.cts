import * as path from "node:path";
import * as backendIpcSenderModule from "./backend-ipc-sender.cts";
import { buildRuntimeTaskRow } from "./task-payload-builder.cts";
import {
  rebuildTaskSnapshotsFromTaskRecord,
  resolveProjectPathFromMetadata,
} from "./task-engine-archive.cts";
import { isRecord, toRecord } from "./task-engine-shared.cts";
import {
  normalizeString,
  normalizeTaskRecord,
  normalizeTaskStatus,
} from "./task-normalizer.cts";

const { sendRuntimeTransaction } = backendIpcSenderModule;

type TaskPathFileRaw = {
  path: unknown | undefined;
};

type TaskPathResponseRaw = {
  file: unknown | undefined;
};

type TaskPathRecordRaw = {
  response: unknown | undefined;
  metadata: unknown | undefined;
  projectPath: unknown | undefined;
};

const emptyTaskPathRecord: TaskPathRecordRaw = {
  response: undefined,
  metadata: undefined,
  projectPath: undefined,
};

const asTaskPathRecord = (value: unknown): TaskPathRecordRaw =>
  isRecord(value) ? (value as TaskPathRecordRaw) : emptyTaskPathRecord;

const asTaskPathResponse = (value: unknown): TaskPathResponseRaw | null =>
  isRecord(value) ? (value as TaskPathResponseRaw) : null;

const asTaskPathFile = (value: unknown): TaskPathFileRaw | null =>
  isRecord(value) ? (value as TaskPathFileRaw) : null;

const decodeTaskIdFromFilename = (filename: unknown) => {
  const normalizedFilename = normalizeString(filename);
  if (!normalizedFilename) return "";
  const base = path.basename(normalizedFilename, ".json");
  try {
    return decodeURIComponent(base);
  } catch {
    return base;
  }
};

const decodeTaskIdFromUrl = (value: unknown) => {
  if (!value) return "";
  try {
    return decodeURIComponent(String(value));
  } catch {
    return String(value);
  }
};

const isSafeRelativePath = (relativePath: unknown) => {
  if (!relativePath || typeof relativePath !== "string") return false;
  const trimmed = relativePath.trim();
  if (!trimmed) return false;
  if (path.isAbsolute(trimmed)) return false;
  const normalized = trimmed.replace(/\\/g, "/");
  return !normalized.startsWith("..") && !normalized.includes("/../");
};

const resolveTaskResultAbsolutePath = (record: unknown) => {
  const recordValue = asTaskPathRecord(record);
  const response = asTaskPathResponse(recordValue.response);
  const responseFile = asTaskPathFile(response !== null ? response.file : undefined);
  const filePath = responseFile !== null ? responseFile.path : undefined;
  if (typeof filePath !== "string" || !filePath.trim()) return null;
  const trimmed = filePath.trim();
  if (path.isAbsolute(trimmed)) return trimmed;
  if (!isSafeRelativePath(trimmed)) return null;
  const projectPath = resolveProjectPathFromMetadata(recordValue.metadata);
  if (!projectPath) return null;
  const projectRoot = path.resolve(projectPath);
  const resolved = path.resolve(projectPath, trimmed);
  const rel = path.relative(projectRoot, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
};

const toProjectRelativePath = (projectPath: unknown, absolutePath: unknown) => {
  if (!projectPath || !absolutePath) return null;
  try {
    const projectRoot = path.resolve(String(projectPath));
    const resolved = path.resolve(String(absolutePath));
    const rel = path.relative(projectRoot, resolved);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return rel;
  } catch {
    return null;
  }
};

const locateTaskRecordAndPaths = async (taskId: unknown) => {
  const resolvedTaskId = normalizeString(taskId);
  if (!resolvedTaskId) return null;
  const tryLocateInTasks = (tasks: unknown[]) => {
    for (const taskRecord of tasks) {
      const snapshots = rebuildTaskSnapshotsFromTaskRecord(taskRecord);
      const record = snapshots.find(
        (item) => normalizeString(toRecord(item).id) === resolvedTaskId,
      );
      if (!record) continue;
      const taskRecordValue = asTaskPathRecord(taskRecord);
      const projectPath = normalizeString(taskRecordValue.projectPath) || null;
      return {
        record,
        paths: null,
        scope: projectPath ? "project" : "global",
        projectPath,
        taskRecord,
      };
    }
    return null;
  };
  void tryLocateInTasks;
  return null;
};

const writeRuntimeTaskRow = (record: unknown) => {
  const recordValue = asTaskPathRecord(record);
  const metadata = isRecord(recordValue.metadata) ? recordValue.metadata : {};
  const projectPath =
    normalizeString(recordValue.projectPath) ||
    resolveProjectPathFromMetadata(metadata);
  if (!projectPath) return null;
  const row = buildRuntimeTaskRow(recordValue, {
    fallbackStatus: undefined,
    statusNormalizer: normalizeTaskStatus,
    projectPathResolver: resolveProjectPathFromMetadata,
  });
  return { projectPath, tasks: [row] };
};

const awaitRuntimeTaskRowWrite = async (record: unknown) => {
  const transaction = writeRuntimeTaskRow(record);
  if (!transaction) return;
  await sendRuntimeTransaction(transaction);
};

export {
  normalizeTaskRecord,
  decodeTaskIdFromFilename,
  decodeTaskIdFromUrl,
  resolveTaskResultAbsolutePath,
  toProjectRelativePath,
  locateTaskRecordAndPaths,
  writeRuntimeTaskRow,
  awaitRuntimeTaskRowWrite,
};
