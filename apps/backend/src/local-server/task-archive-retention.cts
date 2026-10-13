import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectTaskArchivePayloadRefPaths } from './task-archive-payloads.cts';

const TASK_ARCHIVE_KEEP_TASKS = 100;
const TASK_ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
const TASK_ARCHIVE_PAYLOAD_DIR_NAME = 'payloads';

type TaskArchiveDirInfo = {
  absolutePath: string;
  taskId: string;
  eventsPath: string;
  sortTime: number;
  payloads: string[];
};

type PayloadReferenceInfo = {
  absolutePath: string;
  newestReferenceTime: number;
};

const normalizeString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

const walkSize = (targetPath: string) => {
  if (!fs.existsSync(targetPath)) return 0;
  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    total += walkSize(path.join(targetPath, entry.name));
  }
  return total;
};

const readArchiveEventPayloadRefs = (taskArchiveDirPath: string) => {
  const eventsPath = path.join(taskArchiveDirPath, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [] as string[];
  const refs = new Set<string>();
  const lines = fs.readFileSync(eventsPath, 'utf-8').split('\n');
  for (const line of lines) {
    const text = normalizeString(line);
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as unknown;
      const lineRefs = collectTaskArchivePayloadRefPaths(parsed);
      for (const refPath of lineRefs) {
        const absolutePath = path.resolve(taskArchiveDirPath, refPath);
        refs.add(absolutePath);
      }
    } catch {
      void 0;
    }
  }
  return [...refs];
};

const readArchiveSortTime = (taskArchiveDirPath: string) => {
  const eventsPath = path.join(taskArchiveDirPath, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) {
    return fs.statSync(taskArchiveDirPath).mtimeMs;
  }
  return fs.statSync(eventsPath).mtimeMs;
};

const listTaskArchiveDirs = (archiveRootPath: string) => {
  if (!fs.existsSync(archiveRootPath)) return [] as TaskArchiveDirInfo[];
  const entries = fs.readdirSync(archiveRootPath, { withFileTypes: true });
  const dirs: TaskArchiveDirInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === TASK_ARCHIVE_PAYLOAD_DIR_NAME) continue;
    const absolutePath = path.join(archiveRootPath, entry.name);
    dirs.push({
      absolutePath,
      taskId: entry.name,
      eventsPath: path.join(absolutePath, 'events.jsonl'),
      sortTime: readArchiveSortTime(absolutePath),
      payloads: readArchiveEventPayloadRefs(absolutePath),
    });
  }
  dirs.sort((left, right) => right.sortTime - left.sortTime);
  return dirs;
};

const deletePayloadIfExists = (payloadPath: string) => {
  if (!fs.existsSync(payloadPath)) return false;
  const stat = fs.statSync(payloadPath);
  if (!stat.isFile()) return false;
  fs.rmSync(payloadPath, { force: true });
  return true;
};

const deleteTaskArchiveDir = (taskDirPath: string) => {
  if (!fs.existsSync(taskDirPath)) return false;
  fs.rmSync(taskDirPath, { recursive: true, force: true });
  return true;
};

const buildRetainedPayloadSet = (retainedDirs: TaskArchiveDirInfo[]) => {
  const retainedPayloads = new Set<string>();
  for (const dir of retainedDirs) {
    for (const payloadPath of dir.payloads) {
      retainedPayloads.add(payloadPath);
    }
  }
  return retainedPayloads;
};

const buildPayloadReferenceInfos = (dirs: TaskArchiveDirInfo[]) => {
  const payloadInfos = new Map<string, PayloadReferenceInfo>();
  for (const dir of dirs) {
    for (const payloadPath of dir.payloads) {
      const existing = payloadInfos.get(payloadPath);
      if (!existing) {
        payloadInfos.set(payloadPath, {
          absolutePath: payloadPath,
          newestReferenceTime: dir.sortTime,
        });
        continue;
      }
      if (dir.sortTime > existing.newestReferenceTime) {
        existing.newestReferenceTime = dir.sortTime;
      }
    }
  }
  return [...payloadInfos.values()].sort((left, right) => left.newestReferenceTime - right.newestReferenceTime);
};

const enforceTaskArchiveRetention = (archiveRootPath: string) => {
  const archiveRoot = normalizeString(archiveRootPath);
  if (!archiveRoot || !fs.existsSync(archiveRoot)) return;
  const taskDirs = listTaskArchiveDirs(archiveRoot);
  const retainedDirs = taskDirs.slice(0, TASK_ARCHIVE_KEEP_TASKS);
  const oldDirs = taskDirs.slice(TASK_ARCHIVE_KEEP_TASKS);
  const retainedPayloads = buildRetainedPayloadSet(retainedDirs);

  for (const dir of oldDirs) {
    for (const payloadPath of dir.payloads) {
      if (retainedPayloads.has(payloadPath)) continue;
      deletePayloadIfExists(payloadPath);
    }
  }

  for (const dir of oldDirs.sort((left, right) => left.sortTime - right.sortTime)) {
    deleteTaskArchiveDir(dir.absolutePath);
  }

  if (walkSize(archiveRoot) <= TASK_ARCHIVE_MAX_BYTES) return;

  const retainedPayloadInfos = buildPayloadReferenceInfos(retainedDirs);
  for (const payloadInfo of retainedPayloadInfos) {
    if (walkSize(archiveRoot) <= TASK_ARCHIVE_MAX_BYTES) break;
    deletePayloadIfExists(payloadInfo.absolutePath);
  }

  if (walkSize(archiveRoot) <= TASK_ARCHIVE_MAX_BYTES) return;

  const remainingDirs = listTaskArchiveDirs(archiveRoot).sort((left, right) => left.sortTime - right.sortTime);
  for (const dir of remainingDirs) {
    if (walkSize(archiveRoot) <= TASK_ARCHIVE_MAX_BYTES) break;
    deleteTaskArchiveDir(dir.absolutePath);
  }
};

export {
  TASK_ARCHIVE_KEEP_TASKS,
  TASK_ARCHIVE_MAX_BYTES,
  TASK_ARCHIVE_PAYLOAD_DIR_NAME,
  enforceTaskArchiveRetention,
};
