import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendTaskArchiveEvent,
  deleteTaskArchive,
  hasLegacyTaskArchiveDir,
  readTaskArchiveEvents,
  resolveLegacyTaskArchiveDir,
  resolveTaskArchiveDir,
  resolveTaskArchivePath,
} from '../task-archive-store.cts';

interface ArchiveOptions {
  taskId: string | undefined;
  projectPath: string | undefined;
  metadata: unknown | undefined;
  event: unknown | undefined;
}

const asArchiveOptions = (options: { taskId: string; projectPath: string; event?: unknown }): ArchiveOptions =>
  ({ taskId: options.taskId, projectPath: options.projectPath, metadata: undefined, event: options.event ?? undefined });

const writeJson = (filePath: string, value: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
};

const createProjectFolder = (rootDir: string) => {
  const projectPath = path.join(rootDir, 'demo.iartproj');
  fs.mkdirSync(projectPath, { recursive: true });
  writeJson(path.join(projectPath, 'manifest.json'), {
    version: 1,
    name: 'task-archive-store-test',
  });
  return projectPath;
};

void test('task-archive-store: 正式路径写入 .iartstudio/task-archives/{taskId}/events.jsonl', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-archive-store-'));
  const storageRoot = path.join(tempDir, 'storage');
  const projectPath = createProjectFolder(tempDir);
  const previousStorageRoot = process.env['IART_STORAGE_ROOT'];
  process.env['IART_STORAGE_ROOT'] = storageRoot;

  try {
    const archiveDir = resolveTaskArchiveDir(asArchiveOptions({ taskId: 'task-archive-1', projectPath }));
    const archivePath = resolveTaskArchivePath(asArchiveOptions({ taskId: 'task-archive-1', projectPath }));
    assert.ok(archiveDir);
    assert.ok(archivePath);
    assert.equal(archiveDir, path.join(projectPath, '.iartstudio', 'task-archives', 'task-archive-1'));
    assert.equal(archivePath, path.join(projectPath, '.iartstudio', 'task-archives', 'task-archive-1', 'events.jsonl'));

    appendTaskArchiveEvent(asArchiveOptions({
      taskId: 'task-archive-1',
      projectPath,
      event: {
        type: 'task.accepted',
        detail: { step: 1 },
      },
    }));
    appendTaskArchiveEvent(asArchiveOptions({
      taskId: 'task-archive-1',
      projectPath,
      event: {
        type: 'task.succeeded',
        detail: { step: 2 },
      },
    }));

    const events = readTaskArchiveEvents(asArchiveOptions({ taskId: 'task-archive-1', projectPath }));
    assert.equal(events.length, 2);
    assert.equal(events[0]?.type, 'task.accepted');
    assert.equal(events[1]?.type, 'task.succeeded');
    assert.equal((events[0]?.detail as { step?: number })?.step, 1);
    assert.equal((events[1]?.detail as { step?: number })?.step, 2);

    assert.equal(deleteTaskArchive(asArchiveOptions({ taskId: 'task-archive-1', projectPath })), true);
    assert.equal(fs.existsSync(archivePath), false);
    assert.equal(fs.existsSync(archiveDir), false);
  } finally {
    if (previousStorageRoot == null) {
      delete process.env['IART_STORAGE_ROOT'];
    } else {
      process.env['IART_STORAGE_ROOT'] = previousStorageRoot;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

void test('task-archive-store: legacy 根目录 task-archives 只诊断，不参与正式读写', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-archive-store-migration-'));
  const storageRoot = path.join(tempDir, 'storage');
  const projectPath = createProjectFolder(tempDir);
  const previousStorageRoot = process.env['IART_STORAGE_ROOT'];
  process.env['IART_STORAGE_ROOT'] = storageRoot;

  try {
    const legacyArchiveDir = path.join(projectPath, 'task-archives', 'task-archive-legacy-1');
    const legacyArchivePath = path.join(legacyArchiveDir, 'events.jsonl');
    fs.mkdirSync(path.dirname(legacyArchivePath), { recursive: true });
    fs.writeFileSync(
      legacyArchivePath,
      `${JSON.stringify({
        taskId: 'task-archive-legacy-1',
        type: 'task.accepted',
        timestamp: '2026-04-03T00:00:00.000Z',
        detail: { source: 'legacy' },
      })}\n`,
      'utf-8',
    );

    const archiveDir = resolveTaskArchiveDir(asArchiveOptions({ taskId: 'task-archive-legacy-1', projectPath }));
    const archivePath = resolveTaskArchivePath(asArchiveOptions({ taskId: 'task-archive-legacy-1', projectPath }));
    assert.equal(archiveDir, path.join(projectPath, '.iartstudio', 'task-archives', 'task-archive-legacy-1'));
    assert.equal(archivePath, path.join(projectPath, '.iartstudio', 'task-archives', 'task-archive-legacy-1', 'events.jsonl'));
    assert.equal(resolveLegacyTaskArchiveDir(asArchiveOptions({ taskId: 'task-archive-legacy-1', projectPath })), legacyArchiveDir);
    assert.equal(hasLegacyTaskArchiveDir(asArchiveOptions({ taskId: 'task-archive-legacy-1', projectPath })), true);
    assert.equal(fs.existsSync(archivePath), false);
    assert.equal(fs.existsSync(legacyArchivePath), true);
    assert.deepEqual(readTaskArchiveEvents(asArchiveOptions({ taskId: 'task-archive-legacy-1', projectPath })), []);

    appendTaskArchiveEvent(asArchiveOptions({
      taskId: 'task-archive-legacy-1',
      projectPath,
      event: {
        type: 'task.succeeded',
        detail: { source: 'formal-root' },
      },
    }));

    const nextEvents = readTaskArchiveEvents(asArchiveOptions({ taskId: 'task-archive-legacy-1', projectPath }));
    assert.equal(nextEvents.length, 1);
    assert.equal(nextEvents[0]?.type, 'task.succeeded');
    assert.deepEqual(nextEvents[0]?.detail, { source: 'formal-root' });
    assert.equal(fs.existsSync(legacyArchivePath), true);
    assert.equal(fs.existsSync(archivePath), true);
  } finally {
    if (previousStorageRoot == null) {
      delete process.env['IART_STORAGE_ROOT'];
    } else {
      process.env['IART_STORAGE_ROOT'] = previousStorageRoot;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

void test('task-archive-store: payload ref 使用项目级内容寻址池并跨 task 去重', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-archive-store-payload-'));
  const storageRoot = path.join(tempDir, 'storage');
  const projectPath = createProjectFolder(tempDir);
  const previousStorageRoot = process.env['IART_STORAGE_ROOT'];
  process.env['IART_STORAGE_ROOT'] = storageRoot;

  try {
    const largeText = 'a'.repeat(9000);
    appendTaskArchiveEvent(asArchiveOptions({
      taskId: 'task-archive-payload-1',
      projectPath,
      event: {
        type: 'task.result_received',
        detail: {
          largeText,
        },
      },
    }));
    appendTaskArchiveEvent(asArchiveOptions({
      taskId: 'task-archive-payload-2',
      projectPath,
      event: {
        type: 'task.result_received',
        detail: {
          largeText,
        },
      },
    }));
    const archivePath = resolveTaskArchivePath(asArchiveOptions({ taskId: 'task-archive-payload-1', projectPath }));
    assert.ok(archivePath);
    const firstLine = fs.readFileSync(archivePath, 'utf-8').trim().split('\n')[0];
    assert.ok(firstLine);
    const parsed: unknown = JSON.parse(firstLine);
    const detail = parsed && typeof parsed === 'object' ? (parsed as { detail?: { largeText?: { __archive_payload_ref?: { sha256?: string; size?: number; path?: string } } } }).detail : undefined;
    const ref = detail?.largeText?.__archive_payload_ref;
    assert.equal(typeof ref?.sha256, 'string');
    assert.equal(typeof ref?.size, 'number');
    assert.equal(typeof ref?.path, 'string');
    assert.equal(ref?.path?.startsWith('../payloads/'), true);
    const payloadPoolDir = path.join(projectPath, '.iartstudio', 'task-archives', 'payloads');
    const payloadFiles = fs.readdirSync(payloadPoolDir);
    assert.equal(payloadFiles.length, 1);
  } finally {
    if (previousStorageRoot == null) {
      delete process.env['IART_STORAGE_ROOT'];
    } else {
      process.env['IART_STORAGE_ROOT'] = previousStorageRoot;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
