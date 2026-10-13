import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  TASK_ARCHIVE_KEEP_TASKS,
  TASK_ARCHIVE_PAYLOAD_DIR_NAME,
  enforceTaskArchiveRetention,
} from '../task-archive-retention.cts';

const writeEventLine = (eventsPath: string, event: unknown) => {
  fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
  fs.writeFileSync(eventsPath, `${JSON.stringify(event)}\n`, 'utf-8');
};

const writePayload = (archiveRoot: string, fileName: string, content: string) => {
  const payloadDir = path.join(archiveRoot, TASK_ARCHIVE_PAYLOAD_DIR_NAME);
  fs.mkdirSync(payloadDir, { recursive: true });
  fs.writeFileSync(path.join(payloadDir, fileName), content, 'utf-8');
  return path.join(payloadDir, fileName);
};

void test('task-archive-retention: 超过最近任务上限时删除最老任务目录并排除项目级 payloads 目录计数', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-archive-retention-'));
  const archiveRoot = path.join(tempDir, '.iartstudio', 'task-archives');
  fs.mkdirSync(archiveRoot, { recursive: true });
  writePayload(archiveRoot, 'shared.txt', 'shared');

  try {
    for (let index = 0; index < TASK_ARCHIVE_KEEP_TASKS + 2; index += 1) {
      const dirPath = path.join(archiveRoot, `task-${String(index).padStart(3, '0')}`);
      const eventsPath = path.join(dirPath, 'events.jsonl');
      writeEventLine(eventsPath, {
        taskId: `task-${index}`,
        detail: {
          largeText: {
            __archive_payload_ref: {
              path: '../payloads/shared.txt',
              format: 'text',
              encoding: 'utf-8',
              sha256: 'shared',
              size: 6,
            },
          },
        },
      });
      const mtime = new Date(Date.now() - (TASK_ARCHIVE_KEEP_TASKS + 2 - index) * 1000);
      fs.utimesSync(dirPath, mtime, mtime);
      fs.utimesSync(eventsPath, mtime, mtime);
    }

    enforceTaskArchiveRetention(archiveRoot);

    const dirs = fs.readdirSync(archiveRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== TASK_ARCHIVE_PAYLOAD_DIR_NAME);
    assert.equal(dirs.length, TASK_ARCHIVE_KEEP_TASKS);
    assert.equal(fs.existsSync(path.join(archiveRoot, TASK_ARCHIVE_PAYLOAD_DIR_NAME, 'shared.txt')), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

void test('task-archive-retention: retained task 仍引用共享 payload 时不得删除共享文件', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-archive-retention-shared-'));
  const archiveRoot = path.join(tempDir, '.iartstudio', 'task-archives');
  fs.mkdirSync(archiveRoot, { recursive: true });
  const sharedPayloadPath = writePayload(archiveRoot, 'shared.json', '{"ok":true}');

  try {
    for (let index = 0; index < TASK_ARCHIVE_KEEP_TASKS + 1; index += 1) {
      const dirPath = path.join(archiveRoot, `task-${String(index).padStart(3, '0')}`);
      const eventsPath = path.join(dirPath, 'events.jsonl');
      writeEventLine(eventsPath, {
        taskId: `task-${index}`,
        detail: {
          payload: {
            __archive_payload_ref: {
              path: '../payloads/shared.json',
              format: 'json',
              encoding: 'utf-8',
              sha256: 'shared-json',
              size: 11,
            },
          },
        },
      });
      const mtime = new Date(Date.now() - (TASK_ARCHIVE_KEEP_TASKS + 1 - index) * 1000);
      fs.utimesSync(dirPath, mtime, mtime);
      fs.utimesSync(eventsPath, mtime, mtime);
    }

    enforceTaskArchiveRetention(archiveRoot);

    assert.equal(fs.existsSync(sharedPayloadPath), true);
    assert.equal(fs.existsSync(path.join(archiveRoot, 'task-000')), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
