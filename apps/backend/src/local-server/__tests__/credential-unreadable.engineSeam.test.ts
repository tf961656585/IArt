import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  HUB_LOCAL_WRITE_TOKEN_ENV,
  HUB_LOCAL_WRITE_TOKEN_HEADER,
  PromptDockBatchSubmitResponseSchema,
  TaskStateNotificationSchema,
  type TaskStateNotification,
} from '@iart/contracts';
import { createRequestHandler } from '../router.cts';
import { setBackendIpcTestHandler } from '../backend-ipc-sender.cts';
import { createProjectFolder } from '../project-store.cts';
import { removeProjectScope, syncProjectScope } from '../project-media-scope.cts';
import {
  clearCacheForTest as clearConnectionCache,
  createConnection,
  setConnectionCredential,
} from '../provider-connection/connection-store.cts';
import {
  clearCacheForTest as clearActiveRouteCache,
  setActiveDeployment,
} from '../provider-connection/active-route-store.cts';
import {
  addCustomGenerationModel,
  clearCacheForTest as clearCustomGenerationModelCache,
} from '../provider-connection/custom-generation-model-store.cts';
import {
  clearCacheForTest as clearCredentialCache,
  setCredentialCryptoProvider,
} from '../provider-connection/credential-store.cts';

/**
 * 凭证不可读的提交主链接缝（2026-10-29 事故修复的验收面）。
 *
 * 真实链路：真实 `createRequestHandler` + 真实批次受理 + 真实任务执行器 → 假上游
 * （一旦被调用即说明不可读凭证被当明文用了）。宿主安全存储替身按事故形态抛错：
 * 安装版读取开发版写入的密文，钥匙串授权只登记了开发目录的 Electron。
 *
 * 期望：任务以 `credential_missing` + `details.reason='unreadable'` 失败，`userMessage`
 * 是用户能照做的指引，技术字段与 notify/记录里**不含**任何底层异常原文或密文。
 */

const MODEL_ID = 'seam-credential-unreadable';
const REMOTE_MODEL_ID = 'remote-credential-unreadable';
const CONNECTION_BASE_URL = 'https://credential-unreadable.example.invalid';
const HUB_WRITE_TOKEN = 'u'.repeat(32);
const CIPHERTEXT_PAYLOAD = Buffer.from('v10-cross-install-ciphertext', 'utf8').toString('base64');

const UNREADABLE_USER_MESSAGE = '没能读取这个服务商的密钥，请到「设置 → 服务商与模型」重新填写。';

type UpstreamCall = { url: string };

/** 假上游：凭证不可读时任务根本不该发请求——任何调用都记为违约。 */
const installForbiddenUpstream = (): { calls: UpstreamCall[]; restore: () => void } => {
  const originalFetch = globalThis.fetch;
  const calls: UpstreamCall[] = [];
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    // 本地 HTTP 服务的请求（提交/路由）透传给真实 handler，只拦截生成上游。
    if (url.startsWith('http://127.0.0.1')) return originalFetch(input, init);
    calls.push({ url });
    throw new Error(`unexpected upstream request: ${url}`);
  };
  return {
    calls,
    restore: (): void => {
      globalThis.fetch = originalFetch;
    },
  };
};

const installNotificationCapture = (): {
  notifications: TaskStateNotification[];
  restore: () => void;
} => {
  const original = process.send;
  const notifications: TaskStateNotification[] = [];
  process.send = (message: unknown): boolean => {
    const parsed = TaskStateNotificationSchema.safeParse(message);
    if (parsed.success) notifications.push(parsed.data);
    return true;
  };
  return {
    notifications,
    restore: (): void => {
      if (original === undefined) {
        Reflect.deleteProperty(process, 'send');
        return;
      }
      process.send = original;
    },
  };
};

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  // 按真实时间轮询：旧实现是「N 次 setImmediate 空转」，在快机器上够用、在 CI 上几乎不消耗
  // 墙钟时间，会把「任务还在下载」误判成超时（2026-11-10 发布门禁实证：停在 submitting,downloading）。
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
};

const startServer = async (t: TestContext): Promise<string> => {
  const server = http.createServer(createRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('credential_unreadable_seam_server_address_unavailable');
  }
  return `http://127.0.0.1:${address.port}`;
};

const createOpenedProject = (projectName: string) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-unreadable-seam-'));
  const created = createProjectFolder(tempDir, projectName);
  if (!created || 'error' in created) throw new Error('project_creation_failed');
  const projectPath = created.projectPath;
  fs.writeFileSync(
    path.join(projectPath, 'manifest.json'),
    JSON.stringify({ version: 1, name: projectName }),
    'utf-8',
  );
  const stableProjectId = `spid_${crypto.randomBytes(12).toString('hex')}`;
  const projectRef = `prj_${crypto.randomBytes(16).toString('hex')}`;
  const synced = syncProjectScope({ stableProjectId, projectPath, projectRef });
  assert.ok(synced, 'project scope should be registered');
  return {
    projectPath,
    close: (): void => {
      removeProjectScope(stableProjectId);
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
};

const setupTest = async (t: TestContext) => {
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  const previousToken = process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-unreadable-storage-'));
  process.env['IART_STORAGE_ROOT'] = storageRoot;
  process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = HUB_WRITE_TOKEN;
  const clearCaches = (): void => {
    clearConnectionCache();
    clearActiveRouteCache();
    clearCustomGenerationModelCache();
    clearCredentialCache();
  };
  clearCaches();
  const project = createOpenedProject('demo-credential-unreadable');
  setBackendIpcTestHandler(async (message) => {
    if (message.type === 'runtime:execute-transaction') {
      return {
        type: 'runtime:transaction-result',
        transactionId: message.transactionId,
        success: true,
        data: null,
      };
    }
    if (message.type === 'runtime:write-task-event') {
      return {
        type: 'runtime:transaction-result',
        transactionId: message.transactionId,
        success: true,
        data: null,
      };
    }
    throw new Error(`unexpected IPC message type: ${message.type}`);
  });
  t.after(() => {
    setCredentialCryptoProvider(null);
    setBackendIpcTestHandler(null);
    project.close();
    clearCaches();
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    if (previousToken === undefined) delete process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
    else process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = previousToken;
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });
  return { projectPath: project.projectPath, storageRoot };
};

/**
 * 播种连接 + 模型 + active route + **一条历史 safeStorage 密文条目**：
 * 连接记录声称有凭证（ref/version 一致），实际条目是别处写入的密文。
 */
const seedConnectionWithForeignCiphertext = (storageRoot: string): void => {
  const connection = createConnection({
    display_name: 'credential-unreadable-upstream',
    base_url: CONNECTION_BASE_URL,
  });
  const credentialRef = `cred_${connection.connection_id}`;
  fs.mkdirSync(path.join(storageRoot, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(storageRoot, 'config', 'provider-credentials.json'),
    JSON.stringify({
      version: 1,
      updatedAt: '2026-10-29T00:00:00.000Z',
      entries: {
        [credentialRef]: {
          version: 1,
          payload: CIPHERTEXT_PAYLOAD,
          scheme: 'os_safe_storage',
          lastReadFailureAt: null,
          updatedAt: '2026-10-29T00:00:00.000Z',
        },
      },
    }, null, 2),
    'utf-8',
  );
  clearCredentialCache();
  setConnectionCredential(connection.connection_id, credentialRef, 1, true);
  const added = addCustomGenerationModel({
    model_id: MODEL_ID,
    connection_id: connection.connection_id,
    remote_model_id: REMOTE_MODEL_ID,
    family_adapter_id: 'openai-image-v1',
    accepted_media_slots: [],
  });
  assert.equal(added.ok, true, 'generation model should be created');
  setActiveDeployment(MODEL_ID, added.model.record_id);
};

const readBackendLog = (storageRoot: string): string => {
  const logPath = path.join(storageRoot, 'logs', 'backend.log');
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
};

void test('接缝：宿主安全存储解密失败 → 任务以 credential_missing/unreadable 失败且带人话，不泄漏原文', async (t) => {
  const { projectPath, storageRoot } = await setupTest(t);
  seedConnectionWithForeignCiphertext(storageRoot);
  const baseUrl = await startServer(t);
  const notifications = installNotificationCapture();
  const upstream = installForbiddenUpstream();
  // 事故形态：宿主安全存储存在但解密抛错（跨安装目录的钥匙串授权失效）。
  setCredentialCryptoProvider({
    encryptString: async (value: string) => Buffer.from(value, 'utf8'),
    decryptString: async () => {
      throw new Error('Error: Error while decoding data from safeStorage ByteString');
    },
    isEncryptionAvailable: async () => true,
  });

  const submitResponse = await fetch(`${baseUrl}/api/generation-batches`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [HUB_LOCAL_WRITE_TOKEN_HEADER]: HUB_WRITE_TOKEN,
    },
    body: JSON.stringify({
      model_id: MODEL_ID,
      model_version: '1.0.0',
      prompt: '一只在窗台晒太阳的猫',
      arguments: {},
      task_count: 1,
      project_path: projectPath,
    }),
  });
  const submitPayload: unknown = await submitResponse.json();
  const submitText = JSON.stringify(submitPayload);
  assert.equal(submitResponse.status, 200, `batch submit failed: ${submitText}`);
  const accepted = PromptDockBatchSubmitResponseSchema.parse(submitPayload);
  assert.equal(accepted.tasks.length, 1);

  await waitFor(
    () => notifications.notifications.some((notification) => notification.task.status === 'failed'),
    `credential failure notification (statuses: ${notifications.notifications.map((n) => n.task.status).join(',') || '(none)'})`,
  );
  upstream.restore();
  notifications.restore();

  const failed = notifications.notifications.find((notification) => notification.task.status === 'failed');
  assert.ok(failed, 'failed notification should be captured');
  const failure = failed.task.failure;
  assert.ok(failure, '失败任务必须携带 failure');
  assert.equal(failure.code, 'credential_missing');
  assert.deepEqual(failure.details, { reason: 'unreadable' });
  assert.equal(failure.userMessage, UNREADABLE_USER_MESSAGE);
  assert.equal(failure.backendMessage, 'credential unavailable: unreadable');
  assert.equal(failure.stage, 'submit');

  const serializedFailure = JSON.stringify(failure);
  assert.equal(serializedFailure.includes('ByteString'), false, '底层异常原文不得进入任务记录/通知');
  assert.equal(serializedFailure.includes('safeStorage'), false);
  assert.equal(serializedFailure.includes(CIPHERTEXT_PAYLOAD), false, '密文不得进入任务记录/通知');

  assert.equal(upstream.calls.length, 0, '凭证不可读时绝不能向上游发请求');

  // 失败留痕：warn 行只含引用与原因，不含密文。
  const log = readBackendLog(storageRoot);
  assert.ok(log.includes('[credential-store] credential unreadable'), '不可读必须留 warn 日志');
  assert.ok(log.includes('"reason":"unreadable"'));
  assert.equal(log.includes(CIPHERTEXT_PAYLOAD), false, '日志不得包含密文');
});
