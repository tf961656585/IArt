import * as fs from "node:fs";
import * as path from "node:path";

import {
  normalizeString,
  readAttachmentOptions,
  readRecordMetadata,
} from "./common.cts";
import {
  buildAttachmentFilename,
  ensureRequestLogDir,
  maybeCleanupOldLogs,
  syncTaskRequestLogArtifact,
  toProjectRelativePath,
} from "./log-files.cts";

export const writeRequestLogAttachmentFromFile = (
  options: unknown,
):
  | {
      ok: false;
      reason: string;
      error: string | undefined;
    }
  | {
      ok: true;
      dir: string;
      absolutePath: string;
      ref: {
        path: string;
        size: number | null;
        contentType: string | null;
      };
    } => {
  const opts = readAttachmentOptions(options);
  if (!opts) {
    return { ok: false as const, reason: "invalid-options", error: undefined };
  }

  const metadata = readRecordMetadata(opts.metadata);
  const taskId =
    normalizeString(opts.taskId) || normalizeString((metadata !== null && metadata !== undefined ? metadata.taskId : undefined));
  const subjectId = taskId || "unknown";
  const projectPath = normalizeString(opts.projectPath) || null;
  const attempt = Number.isFinite(opts.attempt)
    ? Number(opts.attempt)
    : undefined;
  const sourceFilePath = normalizeString(opts.sourceFilePath || "");
  const kind = normalizeString(opts.kind || "attachment");
  const contentType = normalizeString(opts.contentType || "") || null;

  if (!sourceFilePath) return { ok: false as const, reason: "missing-source-file", error: undefined };

  const dir = ensureRequestLogDir(projectPath);
  const filename = buildAttachmentFilename(subjectId, attempt, kind);
  const destPath = path.join(dir, filename);

  try {
    fs.copyFileSync(sourceFilePath, destPath);
  } catch (error: unknown) {
    return { ok: false, reason: "copy-failed", error: String(error) };
  }

  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(destPath);
  } catch {
    stat = null;
  }

  try {
    maybeCleanupOldLogs(dir);
  } catch {
    void 0;
  }

  const rel = projectPath ? toProjectRelativePath(projectPath, destPath) : null;
  const result = {
    ok: true as const,
    dir,
    absolutePath: destPath,
    ref: {
      path: rel || destPath,
      size: stat && Number.isFinite(stat.size) ? stat.size : null,
      contentType: contentType || null,
    },
  };

  if (taskId) {
    syncTaskRequestLogArtifact(taskId, projectPath, {
      latestAttachment: {
        kind,
        path: result.ref.path,
        size: result.ref.size,
        contentType: result.ref.contentType,
        updatedAt: new Date().toISOString(),
      },
    });
  }

  return result;
};
