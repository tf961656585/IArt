import * as fs from "node:fs";
import * as path from "node:path";
import { shell } from "electron";

const revealTaskArchive = (projectPath: string, taskId: string) => {
  const archiveDir = path.join(
    projectPath,
    ".iartstudio",
    "task-archives",
    encodeURIComponent(taskId),
  );
  const legacyArchiveDir = path.join(
    projectPath,
    "task-archives",
    encodeURIComponent(taskId),
  );
  const parentDir = path.dirname(archiveDir);
  const legacyParentDir = path.dirname(legacyArchiveDir);
  try {
    if (fs.existsSync(archiveDir)) {
      void shell.openPath(archiveDir);
      return { ok: true, dir: archiveDir };
    }
    if (fs.existsSync(legacyArchiveDir)) {
      void shell.openPath(legacyParentDir);
      return { ok: false, reason: "legacy-found", dir: legacyParentDir };
    }
    if (fs.existsSync(parentDir)) {
      void shell.openPath(parentDir);
      return { ok: false, reason: "not-found", dir: parentDir };
    }
  } catch (error) {
    return { ok: false, reason: "reveal-failed", error: String(error) };
  }
  return { ok: false, reason: "dir-missing", dir: parentDir };
};

export { revealTaskArchive };
