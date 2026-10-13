import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { setBackendIpcTestHandler } from '../backend-ipc-sender.cts';
import { createRequestHandler } from '../router.cts';
import { appendTaskArchiveEvent } from '../task-archive-store.cts';

const writeJson = (filePath: string, value: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
};

const createProjectFolder = (rootDir: string) => {
  const projectPath = path.join(rootDir, 'demo.iartproj');
  fs.mkdirSync(projectPath, { recursive: true });
  writeJson(path.join(projectPath, 'manifest.json'), {
    version: 1,
    name: 'router-task-archive-read',
  });
  return projectPath;
};

void test('router: /api/tasks/:id/result 只以正式 task.response 为结果事实源', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-task-archive-read-'));
  const projectPath = createProjectFolder(tempDir);
  setBackendIpcTestHandler(async (message) => ({
    type: 'runtime:transaction-result',
    transactionId: message.transactionId,
    success: true,
    data: {
      taskId: 'task-result-archive-1',
      projectPath,
      status: 'succeeded',
      metadata: {
        projectPath,
        taskId: 'task-result-archive-1',
      },
      response: {
        body: {
          ok: true,
          source: 'formal-task-response',
        },
        bodyType: 'json',
        contentType: 'application/json',
      },
    },
    task: {
      taskId: 'task-result-archive-1',
      projectPath,
      status: 'succeeded',
      metadata: {
        projectPath,
        taskId: 'task-result-archive-1',
      },
      response: {
        body: {
          ok: true,
          source: 'formal-task-response',
        },
        bodyType: 'json',
        contentType: 'application/json',
      },
    },
  }));

  appendTaskArchiveEvent({
    taskId: 'task-result-archive-1',
    projectPath,
    metadata: {
      projectPath,
      taskId: 'task-result-archive-1',
    },
    event: {
      taskId: 'task-result-archive-1',
      type: 'task.snapshot',
      timestamp: new Date().toISOString(),
      detail: {
        phase: 'polling_remote',
      },
      snapshot: {
        task: {
          id: 'task-result-archive-1',
          status: 'succeeded',
          response: {
            body: {
              ok: false,
              source: 'archive-should-not-win',
            },
          },
        },
      },
    },
  });

  const server = http.createServer(createRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('router_task_archive_read_server_address_unavailable');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    setBackendIpcTestHandler(null);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const response = await fetch(
    `${baseUrl}/api/tasks/task-result-archive-1/result?projectPath=${encodeURIComponent(projectPath)}`,
  );
  assert.equal(response.status, 200);
  const payload: unknown = await response.json();
  assert.deepEqual(payload, {
    ok: true,
    source: 'formal-task-response',
  });
});

void test('router: /api/tasks/:id/result 无正式结果时只返回诊断摘要，不回退 archive response', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-task-archive-fallback-'));
  const projectPath = createProjectFolder(tempDir);
  setBackendIpcTestHandler(async (message) => ({
    type: 'runtime:transaction-result',
    transactionId: message.transactionId,
    success: true,
    data: {
      taskId: 'task-result-fallback-1',
      projectPath,
      status: 'polling',
      error: null,
      metadata: {
        projectPath,
        taskId: 'task-result-fallback-1',
        remoteRequestId: 'remote-from-snapshot-1',
      },
      response: null,
    },
    task: {
      taskId: 'task-result-fallback-1',
      projectPath,
      status: 'polling',
      error: null,
      metadata: {
        projectPath,
        taskId: 'task-result-fallback-1',
        remoteRequestId: 'remote-from-snapshot-1',
      },
      response: null,
    },
  }));

  appendTaskArchiveEvent({
    taskId: 'task-result-fallback-1',
    projectPath,
    metadata: {
      projectPath,
      taskId: 'task-result-fallback-1',
    },
    event: {
      taskId: 'task-result-fallback-1',
      type: 'task.snapshot',
      timestamp: new Date().toISOString(),
      detail: {
        phase: 'polling_remote',
        remoteRequestId: null,
      },
      snapshot: {
        task: {
          id: 'task-result-fallback-1',
          status: 'polling',
          progress: {
            phase: 'polling_remote',
          },
          metadata: {
            remoteRequestId: null,
          },
          response: {
            body: {
              source: 'archive-response-should-not-leak',
            },
          },
        },
      },
    },
  });

  const server = http.createServer(createRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('router_task_archive_fallback_server_address_unavailable');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    setBackendIpcTestHandler(null);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const response = await fetch(
    `${baseUrl}/api/tasks/task-result-fallback-1/result?projectPath=${encodeURIComponent(projectPath)}`,
  );
  assert.equal(response.status, 200);
  const payload: unknown = await response.json();
  const typedPayload = payload && typeof payload === 'object'
    ? payload as { status?: unknown; archive?: { phase?: unknown; remoteRequestId?: unknown }; response?: unknown }
    : {};
  assert.equal(typedPayload.status, 'polling');
  assert.equal(typedPayload.archive?.phase, 'polling_remote');
  assert.equal(typedPayload.archive?.remoteRequestId, 'remote-from-snapshot-1');
  assert.equal('response' in typedPayload, false);
});
