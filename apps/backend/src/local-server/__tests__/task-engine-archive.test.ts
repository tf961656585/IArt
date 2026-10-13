import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveTaskArchivePath } from '../task-archive-store.cts';
import { writeTaskArchiveSnapshot } from '../task-engine-archive.cts';

const writeJson = (filePath: string, value: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
};

const createProjectFolder = (rootDir: string) => {
  const projectPath = path.join(rootDir, 'demo.iartproj');
  fs.mkdirSync(projectPath, { recursive: true });
  writeJson(path.join(projectPath, 'manifest.json'), {
    version: 1,
    name: 'task-engine-archive-test',
  });
  return projectPath;
};

void test('task-engine-archive: snapshot 不重复保存 response 摘要', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-engine-archive-'));
  const projectPath = createProjectFolder(tempDir);

  try {
    writeTaskArchiveSnapshot({
      id: 'task-archive-snapshot-1',
      status: 'succeeded',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {
        taskId: 'task-archive-snapshot-1',
        projectPath,
      },
      request: {
        url: 'https://example.com/generate',
        method: 'POST',
      },
      response: {
        body: {
          shouldNotBeDuplicated: true,
        },
      },
    });

    const archivePath = resolveTaskArchivePath({
      taskId: 'task-archive-snapshot-1',
      projectPath,
      metadata: undefined,
      event: undefined,
    });
    assert.ok(archivePath);
    const rawLine = fs.readFileSync(archivePath, 'utf-8').trim().split('\n')[0];
    assert.ok(rawLine);
    const parsed = JSON.parse(rawLine) as {
      snapshot?: {
        task?: Record<string, unknown>;
      };
    };
    const snapshotTask = parsed.snapshot?.task ?? {};
    assert.equal(Object.prototype.hasOwnProperty.call(snapshotTask, 'response'), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
