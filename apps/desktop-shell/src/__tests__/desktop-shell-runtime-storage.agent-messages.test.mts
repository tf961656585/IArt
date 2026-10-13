// @vitest-environment node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { beforeAll, describe, it } from 'vitest';

import Database from 'better-sqlite3';

import { AgentMessageRecordSchema } from '@iart/contracts';

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const runtimeStorageEntry = `${workspaceRoot}/apps/desktop-shell/dist/desktop-shell-runtime-storage.cjs`;
const schemaEntry = `${workspaceRoot}/apps/desktop-shell/dist/storage/editor-storage-schema.cjs`;
const writerEntry = `${workspaceRoot}/apps/desktop-shell/dist/storage/editor-storage-agent-writer.cjs`;
const readModelEntry = `${workspaceRoot}/apps/desktop-shell/dist/storage/editor-storage-read-model.cjs`;

type RuntimeResultPatch = {
  success: boolean;
  data?: unknown;
  error?: string;
};

type RuntimeStorageModule = {
  createRuntimeStorageMessageHandler: (deps: {
    sendMessage: (message: unknown) => void;
    sendResult: (transactionId: string, result: RuntimeResultPatch) => void;
  }) => (msg: unknown) => boolean;
};

/**
 * 运行时读取链路里唯一需要替身的是「按 projectPath 取已打开的项目库」：
 * 生产实现（editor-storage-service-impl.getDb）加载的是 Electron ABI 版 better-sqlite3，
 * 在 vitest（Node ABI）下无法加载，因此本测试用内存库替身注入 DB 句柄，
 * 其余链路（contracts 载荷校验、分支派发、结果形状、真实读取 SQL）全部走真实实现。
 */
type StorageServiceStub = {
  getDbForExistingProject: (projectPath: string) => unknown;
  readAgentMessages: (db: unknown, agentSessionId: string) => unknown[];
};

type ModuleLoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

const SERVICE_SPECIFIER = './storage/editor-storage-service.cjs';

const withServiceStub = <T,>(stub: StorageServiceStub, fn: () => T): T => {
  const moduleWithLoad = Module as typeof Module & { _load: ModuleLoadFn };
  const originalLoad = moduleWithLoad._load;
  moduleWithLoad._load = (request, parent, isMain) =>
    request === SERVICE_SPECIFIER ? stub : originalLoad.call(Module, request, parent, isMain);
  try {
    return fn();
  } finally {
    moduleWithLoad._load = originalLoad;
  }
};

const createHandlerHarness = () => {
  const results: Array<{ transactionId: string; patch: RuntimeResultPatch }> = [];
  const handler = (requireDesktop(runtimeStorageEntry) as RuntimeStorageModule)
    .createRuntimeStorageMessageHandler({
      sendMessage: (message) => {
        results.push({ transactionId: 'unexpected', patch: { success: false, data: message } });
      },
      sendResult: (transactionId, patch) => {
        results.push({ transactionId, patch });
      },
    });
  return { handler, results };
};

describe('desktop runtime storage — runtime:read-agent-messages', () => {
  beforeAll(() => {
    for (const entry of [runtimeStorageEntry, schemaEntry, writerEntry, readModelEntry]) {
      if (!existsSync(entry)) {
        execFileSync('pnpm', ['--filter', '@iart/desktop-shell', 'build'], {
          cwd: workspaceRoot,
          stdio: 'pipe',
        });
        break;
      }
    }
  });

  it('按 seq 升序返回会话历史，data 为可通过 contracts schema 校验的记录数组', () => {
    const schema = requireDesktop(schemaEntry) as { initSchema: (db: unknown) => void };
    const writer = requireDesktop(writerEntry) as {
      upsertAgentSession: (db: unknown, session: unknown) => unknown;
      appendAgentMessage: (db: unknown, params: unknown) => unknown;
    };
    const readModel = requireDesktop(readModelEntry) as {
      readAgentMessages: (db: unknown, agentSessionId: string) => unknown[];
    };

    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    schema.initSchema(db);
    try {
      writer.upsertAgentSession(db, {
        agentSessionId: 'as_1',
        nodeId: 'node-1',
        modelId: 'gpt-image-2',
        thinkingTier: 'off',
        approvalMode: 'confirm',
        title: '会话',
        messageCount: 0,
        createdAt: 1,
        updatedAt: 1,
        lastMessageAt: null,
      });
      writer.appendAgentMessage(db, {
        agentSessionId: 'as_1',
        role: 'user',
        requestId: 'req-1',
        body: { kind: 'chat', content: '你好' },
        plan: null,
        createdAt: 2,
        isPartial: false,
      });
      const assistant = writer.appendAgentMessage(db, {
        agentSessionId: 'as_1',
        role: 'assistant',
        requestId: 'req-1',
        body: {
          kind: 'chat',
          content: [
            { type: 'text', text: '收到' },
            { type: 'image', url: 'local-media://out-1' },
          ],
        },
        plan: { steps: [{ stepId: 'step-1', order: 0, title: '出图', status: 'done' }] },
        createdAt: 3,
        isPartial: true,
      });

      delete requireDesktop.cache[runtimeStorageEntry];
      const harness = withServiceStub(
        {
          getDbForExistingProject: (projectPath) =>
            projectPath === '/tmp/iart-agent-project' ? db : null,
          readAgentMessages: (targetDb, agentSessionId) =>
            readModel.readAgentMessages(targetDb, agentSessionId),
        },
        createHandlerHarness,
      );

      assert.equal(
        harness.handler({
          type: 'runtime:read-agent-messages',
          transactionId: 'tx-1',
          projectPath: '/tmp/iart-agent-project',
          agentSessionId: 'as_1',
        }),
        true,
      );

      assert.equal(harness.results.length, 1);
      assert.equal(harness.results[0]?.transactionId, 'tx-1');
      assert.equal(harness.results[0]?.patch.success, true);
      assert.equal(harness.results[0]?.patch.error, undefined);
      const data = harness.results[0]?.patch.data;
      assert.ok(Array.isArray(data), 'data 应为 AgentMessageRecord[]');
      assert.deepEqual(
        data.map((record) => AgentMessageRecordSchema.parse(record).seq),
        [1, 2],
      );
      assert.deepEqual(AgentMessageRecordSchema.parse(data[1]), assistant);
    } finally {
      delete requireDesktop.cache[runtimeStorageEntry];
      db.close();
    }
  });

  it('项目库不可用 / 会话无消息 / 载荷非法时各自收口', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    (requireDesktop(schemaEntry) as { initSchema: (db: unknown) => void }).initSchema(db);
    try {
      delete requireDesktop.cache[runtimeStorageEntry];
      const harness = withServiceStub(
        {
          getDbForExistingProject: (projectPath) =>
            projectPath === '/tmp/iart-agent-empty' ? db : null,
          readAgentMessages: () => {
            throw new Error('readAgentMessages 不应在无库路径上被调用');
          },
        },
        createHandlerHarness,
      );

      // 项目库不可用：返回空数组并带 error，不进入读取。
      assert.equal(
        harness.handler({
          type: 'runtime:read-agent-messages',
          transactionId: 'tx-missing-db',
          projectPath: '/tmp/iart-agent-not-open',
          agentSessionId: 'as_1',
        }),
        true,
      );
      assert.deepEqual(harness.results[0], {
        transactionId: 'tx-missing-db',
        patch: { success: false, data: [], error: 'project db unavailable' },
      });

      // 载荷缺 agentSessionId：不进入存储层。
      assert.equal(
        harness.handler({
          type: 'runtime:read-agent-messages',
          transactionId: 'tx-bad',
          projectPath: '/tmp/iart-agent-empty',
        }),
        true,
      );
      assert.deepEqual(harness.results[1], {
        transactionId: 'tx-bad',
        patch: { success: false, error: 'invalid runtime:read-agent-messages payload' },
      });

      // 非本通道消息不由本 handler 处理。
      assert.equal(harness.handler({ type: 'runtime:something-else' }), false);
      assert.equal(harness.results.length, 2);
    } finally {
      delete requireDesktop.cache[runtimeStorageEntry];
      db.close();
    }
  });
});
