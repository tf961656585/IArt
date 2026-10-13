import * as fs from "node:fs";
import * as path from "node:path";

import { PROJECT_FOLDER_PATHS } from "../constants.cts";
import { getProjectIndex } from "../project-store.cts";
import { ensureStorageDirs } from "../storage.cts";
import {
  type ProjectIndexItem,
  type RequestLogRecord,
  normalizeString,
  isPlainObject,
  readProjectIndexPayload,
  readRecordMetadata,
} from "./common.cts";

const PROJECT_INDEX_CACHE_TTL_MS = 30 * 1000;
const REQUEST_LOG_RETENTION_DAYS = 7;
const REQUEST_LOG_RETENTION_MS =
  REQUEST_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

type CleanupState = {
  lastCleanupAt: number;
};

type RequestLogCandidate = {
  fullPath: string;
  mtimeMs: number;
};

const cleanupStateByDir = new Map<string, CleanupState>();
let cachedProjectIndexAt = 0;
let cachedProjectIndex: ProjectIndexItem[] | null = null;

export const safeEncodeURIComponent = (value: unknown): string => {
  try {
    return encodeURIComponent(String(value ?? ""));
  } catch {
    return String(value ?? "");
  }
};

export const resolveProjectPathFromMetadata = (
  meta: unknown,
): string | null => {
  const metaRecord = readRecordMetadata(meta);
  if (!metaRecord) return null;

  const scope = normalizeString(metaRecord.scope).toLowerCase();
  if (scope === "global") return null;

  const projectPath = normalizeString(metaRecord.projectPath);
  if (projectPath) return projectPath;

  const nodeGraphId = normalizeString(metaRecord.nodeGraphId);
  if (!nodeGraphId) return null;

  const now = Date.now();
  if (
    !cachedProjectIndex ||
    now - cachedProjectIndexAt > PROJECT_INDEX_CACHE_TTL_MS
  ) {
    try {
      const projectIndexResult = getProjectIndex() as unknown;
      const indexRecord = readProjectIndexPayload(
        (() => { const pip = readProjectIndexPayload(projectIndexResult); return pip !== null && pip !== undefined ? pip.index : undefined; })(),
      );
      const indexPayload = (indexRecord !== null && indexRecord !== undefined ? indexRecord.projects : undefined);
      cachedProjectIndex = Array.isArray(indexPayload) ? indexPayload : [];
      cachedProjectIndexAt = now;
    } catch {
      cachedProjectIndex = [];
      cachedProjectIndexAt = now;
    }
  }

  const hit = cachedProjectIndex.find(
    (item) => normalizeString(item.nodeGraphId) === nodeGraphId,
  );
  const resolved = normalizeString((hit !== null && hit !== undefined ? hit.path : undefined));
  return resolved || null;
};

export const ensureRequestLogDir = (projectPath: unknown): string => {
  const normalizedProjectPath = normalizeString(projectPath);
  if (normalizedProjectPath) {
    const dir = path.join(
      normalizedProjectPath,
      PROJECT_FOLDER_PATHS.REQUEST_LOGS_DIR,
    );
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  const paths = ensureStorageDirs();
  const dir = path.join(paths.logs, "requests");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

export const maybeCleanupOldLogs = (dir: unknown): void => {
  const resolvedDir = normalizeString(dir);
  if (!resolvedDir) return;

  const now = Date.now();
  const state = cleanupStateByDir.get(resolvedDir) ?? { lastCleanupAt: 0 };
  if (state.lastCleanupAt && now - state.lastCleanupAt < 60 * 60 * 1000) {
    return;
  }

  state.lastCleanupAt = now;
  cleanupStateByDir.set(resolvedDir, state);

  try {
    const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        entry.name.startsWith(".") ||
        !entry.name.endsWith(".json")
      ) {
        continue;
      }

      const fullPath = path.join(resolvedDir, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      const mtimeMs = Number.isFinite(stat.mtimeMs)
        ? stat.mtimeMs
        : stat.mtime.getTime();
      if (!Number.isFinite(mtimeMs)) continue;
      if (now - mtimeMs <= REQUEST_LOG_RETENTION_MS) continue;

      try {
        fs.unlinkSync(fullPath);
      } catch {
        void 0;
      }
    }
  } catch {
    void 0;
  }
};

export const buildLogFilename = (
  subjectId: unknown,
  attempt: unknown,
): string => {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = `${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  const attemptPart = Number.isFinite(attempt) ? `_${attempt}` : "";
  return `${ts}_${safeEncodeURIComponent(
    subjectId || "unknown",
  )}${attemptPart}_${suffix}.json`;
};

export const buildAttachmentFilename = (
  subjectId: unknown,
  attempt: unknown,
  kind: unknown,
): string => {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = `${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  const attemptPart = Number.isFinite(attempt) ? `-${attempt}` : "";
  const safeKind = normalizeString(kind).replace(/[^a-z0-9_-]+/gi, "-");
  const kindPart = safeKind || "attachment";
  return `${ts}_${kindPart}-${safeEncodeURIComponent(
    subjectId || "unknown",
  )}${attemptPart}_${suffix}.json`;
};

export const toProjectRelativePath = (
  projectPath: unknown,
  absolutePath: unknown,
): string | null => {
  const normalizedProjectPath = normalizeString(projectPath);
  const normalizedAbsolutePath = normalizeString(absolutePath);
  if (!normalizedProjectPath || !normalizedAbsolutePath) return null;

  try {
    const projectRoot = path.resolve(normalizedProjectPath);
    const resolved = path.resolve(normalizedAbsolutePath);
    const rel = path.relative(projectRoot, resolved);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return rel;
  } catch {
    return null;
  }
};

const findLatestRequestLogFilePathBySubjectId = (
  projectPath: unknown,
  subjectId: unknown,
): string | null => {
  const resolvedSubjectId = normalizeString(subjectId);
  if (!resolvedSubjectId) return null;

  const dir = ensureRequestLogDir(projectPath);
  const encodedSubjectId = safeEncodeURIComponent(resolvedSubjectId);

  try {
    if (!fs.existsSync(dir)) return null;
    if (!fs.statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }

  try {
    const files = fs.readdirSync(dir);
    const candidates = files
      .filter(
        (name) =>
          name.endsWith(".json") && name.includes(`_${encodedSubjectId}_`),
      )
      .map((name): RequestLogCandidate | null => {
        const fullPath = path.join(dir, name);
        try {
          const stat = fs.statSync(fullPath);
          if (!stat.isFile()) return null;
          return {
            fullPath,
            mtimeMs: typeof stat.mtimeMs === "number" ? stat.mtimeMs : 0,
          };
        } catch {
          return null;
        }
      })
      .filter((item): item is RequestLogCandidate => item !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    return (candidates[0] !== null && candidates[0] !== undefined ? candidates[0].fullPath : undefined) ?? null;
  } catch {
    return null;
  }
};

export const findLatestRequestLogFilePathByTaskId = (
  projectPath: unknown,
  taskId: unknown,
): string | null =>
  findLatestRequestLogFilePathBySubjectId(projectPath, taskId);

export const readRequestLogRecordFile = (
  filePath: unknown,
): RequestLogRecord | null => {
  const resolved = normalizeString(filePath);
  if (!resolved) return null;

  try {
    const text = fs.readFileSync(resolved, "utf-8");
    const parsed = JSON.parse(text) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const writeRequestLogRecordFile = (
  filePath: unknown,
  record: unknown,
): boolean => {
  const resolved = normalizeString(filePath);
  if (!resolved) return false;

  try {
    fs.writeFileSync(resolved, JSON.stringify(record, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
};

export const syncTaskRequestLogArtifact = (
  taskId: unknown,
  projectPath: unknown,
  artifactPatch: unknown,
): null => {
  void taskId;
  void projectPath;
  void artifactPatch;
  return null;
};
