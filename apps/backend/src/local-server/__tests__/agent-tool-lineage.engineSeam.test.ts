import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  AGENT_TASK_LINEAGE_METADATA_KEY,
  AgentServerMessageSchema,
  TaskStateNotificationSchema,
  parseAgentTaskLineage,
  type AgentServerMessage,
  type AgentSubmitPrompt,
  type TaskStateNotification,
} from '@iart/contracts';
import type { BusinessClient } from '../business-actions/common.cts';
import { setBackendIpcTestHandler } from '../backend-ipc-sender.cts';
import { executeAgentSubmitPrompt } from '../agent-execution.cts';
import { createProjectFolder } from '../project-store.cts';
import { removeProjectScope, syncProjectScope } from '../project-media-scope.cts';
import { createTaskRecordFromFormalSpec, normalizeTaskRecord } from '../task-store.cts';
import { buildRuntimeTaskRow, buildRuntimeTaskView } from '../task-payload-builder.cts';
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
  addCustomChatModel,
  clearCacheForTest as clearCustomModelCache,
} from '../provider-connection/custom-chat-model-store.cts';
import {
  addCustomGenerationModel,
  clearCacheForTest as clearCustomGenerationModelCache,
} from '../provider-connection/custom-generation-model-store.cts';
import { setCredentialForConnection } from '../provider-connection/credential-store.cts';

/**
 * agent 派生任务血缘「随记录与通知到达 Editor」接缝测试
 *（spec docs/agent/04「血缘与画布投影」AG-EX-001、docs/agent/02「产物资产节点与血缘归属」）。
 *
 * 使命：验证**真实**链路「agent 工具调用 → 真实执行器带 agentLineage 受理生成批次 → 真实记录创建
 * （metadata 白名单）→ 真实任务执行链 → 终态通知 sendTaskStateNotification → 通知 task.metadata
 * 携带 agentLineage 与产物资产」。Editor 侧 `parseAgentTaskLineage` 判据（画布资产节点落位的唯一
 * 入口条件）依赖本段链路，本测试就是这条判据的载体证明。
 *
 * 真实边界外的替身只有两处（与 agent-tool-loop / agent-tool-cancel engineSeam 同一 bargain）：
 * - 上游网络走假 fetch：对话上游按脚本回放 SSE；生成上游（sync 模式）返回带 `data:` 内联产物的
 *   成功响应（内联产物经真实 materializer 落盘，无需二次下载，也不触碰下载 host 白名单）。
 * - Backend→Main IPC（历史读取 / runtime 事务 / 任务事件）在测试处理器内拦截；backend→Main 的
 *   单向通知出口 `process.send` 被接管为捕获数组（node:test 进程无 IPC 通道，该出口恒为 undefined）。
 *
 * 红→绿自证：本测试先在「TASK_METADATA_KEYS 白名单未放行 agentLineage」的旧实现上跑红
 *（通知 metadata 无血缘、事务 payload 的 metadataJson 无血缘），再随白名单放行转绿。
 */

const CHAT_MODEL_ID = 'seam-llm';
const CHAT_CONNECTION_BASE_URL = 'https://seam-upstream.example.invalid/v1';
const CHAT_CREDENTIAL = 'sk-seam-upstream-key';
const UPSTREAM_MODEL_NAME = 'upstream-seam-model';

// 假模型名必须命中 openai-image-v1 闭合族正则（/^gpt-image-/i）才会进可提交目录。
const GENERATION_MODEL_ID = 'gpt-image-seam-lineage';
const GENERATION_CONNECTION_BASE_URL = 'https://seam-gen-upstream.example.invalid/v1';
const GENERATION_CREDENTIAL = 'sk-seam-gen-key';

const AGENT_SESSION_ID = 'agent-session-lineage-seam';
const TOOL_CALL_ID = 'call_lineage_1';

/** 1×1 PNG（内联产物：materializer 只做字节落盘，不做图像解码）。 */
const INLINE_IMAGE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

type UpstreamRequest = { url: string; body: Record<string, unknown> | null };

const sseFrame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

const toolCallFrame = (params: { id: string; name: string; argsJson: string }): string =>
  sseFrame({
    id: 'chatcmpl-seam',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: UPSTREAM_MODEL_NAME,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: params.id,
              type: 'function',
              function: { name: params.name, arguments: params.argsJson },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  });

const finishFrame = (reason: 'tool_calls' | 'stop'): string =>
  sseFrame({
    id: 'chatcmpl-seam',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: UPSTREAM_MODEL_NAME,
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
    usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
  });

const contentFrame = (content: string): string =>
  sseFrame({
    id: 'chatcmpl-seam',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: UPSTREAM_MODEL_NAME,
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
  });

const DONE_FRAME = 'data: [DONE]\n\n';

const sseResponse = (frames: string[]): Response => {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller): void {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
};

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const readRequestUrl = (input: string | URL | Request): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

/**
 * 路由式假 fetch：对话上游按调用序回放脚本化 SSE；生成上游（sync 模式）返回成功响应，
 * 产物 URL 是 `data:` 内联载荷（真实 materializer 内联落盘）。
 */
const installSucceedingUpstreamStub = (params: {
  chatScript: string[][];
  generationBaseUrl: string;
}): { requests: UpstreamRequest[]; generationRequestCount: () => number; restore: () => void } => {
  const originalFetch = globalThis.fetch;
  const requests: UpstreamRequest[] = [];
  let generationRequests = 0;
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = readRequestUrl(input);
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    const parsed: unknown = rawBody ? JSON.parse(rawBody) : null;
    requests.push({
      url,
      body: parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null,
    });
    if (url.startsWith(params.generationBaseUrl)) {
      generationRequests += 1;
      return jsonResponse({
        id: 'req-lineage-1',
        data: [{ url: INLINE_IMAGE_DATA_URL }],
      });
    }
    const frames = params.chatScript[Math.min(requests.length - 1, params.chatScript.length - 1)] ?? [];
    return sseResponse(frames);
  };
  return {
    requests,
    generationRequestCount: (): number => generationRequests,
    restore: (): void => {
      globalThis.fetch = originalFetch;
    },
  };
};

/**
 * 接管 backend→Main 的单向通知出口（process.send）。node:test 进程无 IPC 通道，
 * 该出口在生产（fork 子进程）由 Main 消费，测试里只做捕获。
 */
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
        // node:test 进程本就没有 IPC 通道：还原为「无该出口」而不是写回 undefined
        //（exactOptionalPropertyTypes 下 process.send 不接受 undefined）。
        Reflect.deleteProperty(process, 'send');
        return;
      }
      process.send = original;
    },
  };
};

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error(`waitFor timed out: ${label}`);
};

const createHarness = () => {
  const rawPayloads: unknown[] = [];
  const ws = {
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => {
      rawPayloads.push(JSON.parse(payload));
    },
    on: () => {
      void 0;
    },
  };
  const client: BusinessClient = {
    ws,
    actionIds: new Set<string>(),
    taskIds: new Set<string>(),
    closed: false,
  };
  const sent = (): AgentServerMessage[] =>
    rawPayloads.map((payload, index) => {
      const parsed = AgentServerMessageSchema.safeParse(payload);
      assert.ok(
        parsed.success,
        `sent payload #${index} must satisfy AgentServerMessageSchema: ${JSON.stringify(payload)}`,
      );
      return parsed.data;
    });
  return { client, sent };
};


const createOpenedProject = (projectName: string) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lineage-seam-'));
  const created = createProjectFolder(tempDir, projectName);
  if (!created || 'error' in created) {
    throw new Error('project_creation_failed');
  }
  const projectPath = created.projectPath;
  fs.writeFileSync(
    path.join(projectPath, 'manifest.json'),
    JSON.stringify({ version: 1, name: projectName }),
    'utf-8',
  );
  const stableProjectId = `spid_${crypto.randomBytes(12).toString('hex')}`;
  const projectRef = `prj_${crypto.randomBytes(16).toString('hex').slice(0, 32)}`;
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

/** 隔离存储根 + 真实对话/生成两条链路的 store 种子；同时记录 runtime 事务 payload（落库侧证据）。 */
const setupTest = async (t: TestContext) => {
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lineage-seam-storage-'));
  process.env['IART_STORAGE_ROOT'] = storageRoot;
  const clearCaches = (): void => {
    clearConnectionCache();
    clearCustomGenerationModelCache();
    clearActiveRouteCache();
    clearCustomModelCache();
  };
  clearCaches();
  const project = createOpenedProject('demo-agent-lineage');
  const harness = createHarness();
  const transactionTaskRows: Array<{ taskId: unknown; metadataJson: unknown }> = [];
  setBackendIpcTestHandler(async (message) => {
    if (message.type === 'runtime:read-agent-messages') {
      return {
        type: 'runtime:transaction-result',
        transactionId: message.transactionId,
        success: true,
        data: [],
      };
    }
    if (message.type === 'runtime:execute-transaction') {
      const tasks: unknown = (message as { tasks?: unknown }).tasks;
      if (Array.isArray(tasks)) {
        for (const row of tasks) {
          if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
          const view = row as { taskId?: unknown; metadataJson?: unknown };
          transactionTaskRows.push({ taskId: view.taskId, metadataJson: view.metadataJson });
        }
      }
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

  // 对话链路种子。
  const chatConnection = createConnection({
    display_name: 'seam-upstream',
    base_url: CHAT_CONNECTION_BASE_URL,
  });
  const chatCredential = await setCredentialForConnection(chatConnection.connection_id, CHAT_CREDENTIAL);
  assert.ok(chatCredential, 'chat credential should be written');
  setConnectionCredential(chatConnection.connection_id, chatCredential.credentialRef, chatCredential.version, true);
  // 写侧兼容判定是显式两态（生成模型自建声明试点 §3.5）：声明必须先于部署，否则对话模型
  // 解析不出族、接入被拒——不再按「任意 model_id 可建死记录」的旧行为播种。
  // 单记录口径：能力属性与接入归属一体（spec 03 §6.1），不再经 ModelDeployment 接入。
  const chatRecord = addCustomChatModel({
    model_id: CHAT_MODEL_ID,
    connection_id: chatConnection.connection_id,
    protocol_adapter_id: 'openai-chat-completions-v1',
    remote_model_id: UPSTREAM_MODEL_NAME,
  });
  assert.equal(chatRecord.ok, true, 'custom chat model record should be created');
  assert.equal(setActiveDeployment(CHAT_MODEL_ID, chatRecord.model.record_id), chatRecord.model.record_id);

  // 生成链路种子：连接 → 凭证 → 用户生成模型记录（openai-image-v1 族模板）→ active route。
  const generationConnection = createConnection({
    display_name: 'seam-gen-upstream',
    base_url: GENERATION_CONNECTION_BASE_URL,
  });
  const generationCredential = await setCredentialForConnection(generationConnection.connection_id, GENERATION_CREDENTIAL);
  assert.ok(generationCredential, 'generation credential should be written');
  setConnectionCredential(generationConnection.connection_id, generationCredential.credentialRef, generationCredential.version, true);
  const generationRecord = addCustomGenerationModel({
    model_id: GENERATION_MODEL_ID,
    connection_id: generationConnection.connection_id,
    family_adapter_id: 'openai-image-v1',
    remote_model_id: 'remote-seam-image',
  });
  assert.equal(generationRecord.ok, true, 'custom generation model record should be created');
  if (!generationRecord.ok) throw new Error('generation record seed failed');
  assert.equal(setActiveDeployment(GENERATION_MODEL_ID, generationRecord.model.record_id), generationRecord.model.record_id);

  t.after(() => {
    setBackendIpcTestHandler(null);
    project.close();
    clearCaches();
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });
  return { ...harness, projectPath: project.projectPath, transactionTaskRows };
};

const submitMessage = (overrides: { requestId: string; projectPath: string }): AgentSubmitPrompt => ({
  type: 'agent:submit_prompt',
  requestId: overrides.requestId,
  agentSessionId: AGENT_SESSION_ID,
  projectPath: overrides.projectPath,
  modelId: CHAT_MODEL_ID,
  thinkingTier: 'off',
  approvalMode: 'yolo',
  content: '帮我生成一张图',
  referenceAssetIds: [],
  referenceAssets: [],
});

void test('接缝：agent 派生任务血缘随记录与通知到达 Editor（含产物输出）', async (t) => {
  const { client, projectPath, transactionTaskRows } = await setupTest(t);
  const capture = installNotificationCapture();
  const upstream = installSucceedingUpstreamStub({
    generationBaseUrl: GENERATION_CONNECTION_BASE_URL,
    chatScript: [
      [
        toolCallFrame({
          id: TOOL_CALL_ID,
          name: 'generate_image',
          argsJson: `{"model_id":"${GENERATION_MODEL_ID}","prompt":"一只猫"}`,
        }),
        finishFrame('tool_calls'),
        DONE_FRAME,
      ],
      [contentFrame('图已生成。'), finishFrame('stop'), DONE_FRAME],
    ],
  });
  t.after(() => {
    upstream.restore();
    capture.restore();
  });

  await executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-lineage-1', projectPath }),
  });
  await waitFor(
    () => capture.notifications.some((notification) => notification.task.status === 'succeeded'),
    'agent-derived task succeeded notification',
  );

  const succeeded = capture.notifications.find(
    (notification) => notification.task.status === 'succeeded',
  );
  assert.ok(succeeded, 'agent 派生任务成功必须发出 task:state-changed（succeeded）');
  const lineage = { agentSessionId: AGENT_SESSION_ID, toolCallId: TOOL_CALL_ID };

  // ① 通知 task.metadata 携带血缘（Editor 画布资产节点落位的唯一判据）。
  assert.deepEqual(
    parseAgentTaskLineage(succeeded.task.metadata ?? null),
    lineage,
    'notification.task.metadata must carry agentLineage for the Editor projection',
  );
  assert.deepEqual(
    (succeeded.task.metadata ?? {})[AGENT_TASK_LINEAGE_METADATA_KEY],
    lineage,
    'metadata 域原始键必须存在（不经解析器口径兜底）',
  );

  // ② 产物随通知到达（Editor 落资产节点的输入：输出 + 媒体资产行）。
  assert.ok(
    succeeded.outputs.some((output) => output.mediaType === 'image' && typeof output.assetId === 'string' && output.assetId),
    'succeeded notification must carry the materialized image output',
  );
  assert.ok(succeeded.mediaAssets.length > 0, 'succeeded notification must carry media assets');

  // ③ 落库侧同源：runtime 事务 payload 的 task metadataJson 也带血缘（读写两侧一致放行）。
  const succeededRow = transactionTaskRows.find((row) => row.taskId === succeeded.task.taskId);
  assert.ok(succeededRow, 'runtime transaction must persist the task row');
  assert.equal(typeof succeededRow.metadataJson, 'string', 'task row must carry metadataJson');
  const persistedMetadata: unknown = JSON.parse(String(succeededRow.metadataJson));
  assert.deepEqual(
    parseAgentTaskLineage(persistedMetadata),
    lineage,
    'persisted metadataJson must carry agentLineage',
  );
});

void test('记录与视图：agentLineage 经 metadata 白名单进入 record / metadataJson / view（读写同源）', () => {
  const lineage = { agentSessionId: AGENT_SESSION_ID, toolCallId: TOOL_CALL_ID };
  const spec = {
    request: { url: 'https://provider.example/v1/images/generations', method: 'POST', headers: {} },
    type: 'http',
    polling: null,
    metadata: {
      modelId: GENERATION_MODEL_ID,
      model_id: GENERATION_MODEL_ID,
      batchId: 'batch_lineage_1',
      batch_id: 'batch_lineage_1',
      taskIndex: 0,
      projectPath: '/tmp/lineage.iartproj',
      [AGENT_TASK_LINEAGE_METADATA_KEY]: lineage,
    },
    autoStart: true,
  };
  const record = createTaskRecordFromFormalSpec(spec, {
    actionId: undefined,
    actionName: 'runtime.batch.task.created',
    actionClass: 'business_async',
    compatMode: 'generation_batch_accept',
    submissionTransport: 'http',
    preserveLegacyTaskId: false,
    taskId: 'task_lineage_1',
  });
  assert.ok(record, 'task record should be created');
  assert.deepEqual(
    parseAgentTaskLineage(record.metadata),
    lineage,
    'record.metadata must keep agentLineage (creation-time whitelist)',
  );

  // 读侧再归一（存储读回同源）：白名单同样放行。
  const renormalized = normalizeTaskRecord(record);
  assert.ok(renormalized, 'record should be re-normalized');
  assert.deepEqual(parseAgentTaskLineage(renormalized.metadata), lineage, 'read-side normalization must keep agentLineage');

  // 通知/事务使用的行投影：metadataJson 含血缘，hydrate 出的 view.metadata 同样含血缘。
  const buildOptions = {
    fallbackStatus: undefined,
    statusNormalizer: () => undefined,
    projectPathResolver: () => undefined,
  };
  const row = buildRuntimeTaskRow(record, buildOptions);
  assert.equal(typeof row.metadataJson, 'string', 'row.metadataJson must be written');
  assert.deepEqual(
    parseAgentTaskLineage(JSON.parse(String(row.metadataJson))),
    lineage,
    'row.metadataJson must carry agentLineage',
  );
  const view = buildRuntimeTaskView(record, buildOptions);
  assert.deepEqual(
    parseAgentTaskLineage(view.metadata ?? null),
    lineage,
    'hydrated view.metadata must carry agentLineage',
  );
});
