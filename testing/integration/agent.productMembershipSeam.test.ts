/**
 * 「agent 产物自动入 Agent 容器」投影接缝测试（spec docs/agent/02 验收 AG-CT-001）。
 *
 * 使命：真实链路首尾跑通「agent 工具产出 → 任务记录（metadata.agentLineage 过
 * TASK_METADATA_KEYS 白名单）→ task:state-changed 通知真实构造 → Editor 投影真实函数
 * 消费 → 产物节点 groupId = Agent 节点 id」。
 *
 * 两端真实实现：
 * - Backend 端 = 真实引擎 + 真实适配器 + 假 HTTP 上游（agent-tool-lineage.engineSeam
 *   test.ts 范式延伸到投影消费）：真实 executeAgentSubmitPrompt → 真实 chat 适配器
 *   （openai-chat-completions-v1，SSE 假上游回放 generate_image tool_call）→ 真实工具
 *   循环 → 真实 agent-tool-executor（acceptGenerationBatch 注入 agentLineage）→ 真实
 *   记录创建（TASK_METADATA_KEYS 白名单）→ 真实任务执行链（假 HTTP 上游返回内联产物，
 *   真实 materializer 落盘）→ 真实 sendTaskStateNotification（process.send 出口捕获）。
 * - Editor 端 = 真实投影创建（createAgentNodeForAcceptance 建锚点 Agent 节点）+ 真实
 *   消费入口（useCanvasTaskIndexSync 注册的 listener → TaskStateNotificationSchema.parse
 *   → applyTaskStateChanged → 真实 canvasStore addNode membership 机制）。
 *
 * 真实边界外的替身只有三处（最外层挡网络与 IPC，两端之间零手工输入）：
 * - 上游网络走假 fetch：对话上游按脚本回放 SSE；生成上游（sync 模式）返回 data: 内联产物。
 * - Backend→Main 请求-响应 IPC（历史读取 / runtime 事务 / 任务事件）在测试处理器内拦截。
 * - 通知出口 process.send 为「捕获后转发」包装：task/media 单向通知捕获进数组供本测试
 *   消费（生产里由 desktop-shell 转发到 Editor，属 IPC 传输层，是本接缝允许挡住的最外层）；
 *   其余消息原样转发给 vitest worker 原始 process.send（forks pool 的 tinypool 协议通道，
 *   吞掉会破坏测试运行器本身）。
 *
 * 输入真实性（2026-09-22 第三次同类事故纪律）：喂给 Editor 投影的通知是 process.send
 * 捕获的**原始对象**（真实记录创建 → 真实白名单 → 真实视图构造的产物），禁止手工构造
 * 含 groupId 的理想通知；白名单剥键、通知缺血缘这类断链会让「投影消费不到 → 断言红」
 * 直接可见。
 *
 * 红→绿自证：本测试先在「projectAgentDerivedSucceededAssets 未传 membership」的未接线
 * 实现上跑红（产物节点落地但 groupId 缺失），接线后转绿。
 *
 * @spec: AG-CT-001
 */

import { Buffer as NodeBuffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextEncoder as NodeTextEncoder } from 'node:util';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import {
  AGENT_TASK_LINEAGE_METADATA_KEY,
  TaskStateNotificationSchema,
  parseAgentTaskLineage,
  type AgentSubmitPrompt,
} from '@iart/contracts';

import { cjsRequireAs } from './helpers/cjs-mock';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { createNodeGraph } from '@/features/canvas/types/nodeGraph';
import type { AssetNodeData, GraphNode } from '@/features/canvas/types/node';
import { createAgentNodeForAcceptance } from '@/features/agent/agentNodeProjection';
import { useCanvasTaskIndexSync } from '@/features/canvas/hooks/useCanvasTaskIndexSync';

const HELPER_FILE_PATH = fileURLToPath(import.meta.url);

// ── 后端真实实现的加载桥（agentSessionSeamHarness 同款：tsx 作用域 CJS require）──

type BackendBusinessClient = {
  ws: {
    OPEN: number;
    readyState: number;
    send: (payload: string) => void;
    on: () => void;
  };
  actionIds: Set<string>;
  taskIds: Set<string>;
  closed: boolean;
};

type BackendAgentExecutionModule = {
  executeAgentSubmitPrompt: (args: {
    client: BackendBusinessClient;
    message: AgentSubmitPrompt;
  }) => Promise<unknown>;
};

type BackendIpcSenderModule = {
  setBackendIpcTestHandler: (handler: ((message: unknown) => Promise<unknown>) | null) => void;
};

type BackendProjectStoreModule = {
  createProjectFolder: (
    parentDir: string,
    projectName: string,
  ) => { projectPath?: string; error?: string } | null;
};

type BackendProjectMediaScopeModule = {
  syncProjectScope: (entry: {
    stableProjectId: string;
    projectPath: string;
    projectRef: string;
  }) => unknown;
  removeProjectScope: (stableProjectId: string) => void;
};

type BackendConnectionStoreModule = {
  createConnection: (input: {
    display_name: string;
    base_url: string;
  }) => { connection_id: string };
  setConnectionCredential: (
    connectionId: string,
    credentialRef: string,
    version: number,
    active: boolean,
  ) => boolean;
  clearCacheForTest: () => void;
};

type BackendCredentialStoreModule = {
  setCredentialForConnection: (
    connectionId: string,
    secret: string,
  ) => Promise<{ credentialRef: string; version: number } | null>;
};

type BackendDeploymentStoreModule = {
  createDeployment: (input: {
    model_id: string;
    connection_id: string;
    remote_model_id: string;
  }) => { deployment_id: string };
  clearCacheForTest: () => void;
};

/** 自建对话模型记录（spec 03 §6.1 单记录口径）：record_id 即接入记录 id。 */
type BackendCustomChatModelRecord = {
  model_id: string;
  record_id: string;
  connection_id: string;
  remote_model_id: string;
};

type BackendActiveRouteStoreModule = {
  setActiveDeployment: (modelId: string, deploymentId: string) => string | null;
  clearCacheForTest: () => void;
};

type BackendCustomChatModelStoreModule = {
  addCustomChatModel: (input: {
    model_id: string;
    connection_id: string;
    remote_model_id?: string;
  }) => { ok: boolean; model?: BackendCustomChatModelRecord };
  clearCacheForTest: () => void;
};

type BackendModules = {
  execution: BackendAgentExecutionModule;
  ipcSender: BackendIpcSenderModule;
  projectStore: BackendProjectStoreModule;
  projectMediaScope: BackendProjectMediaScopeModule;
  connectionStore: BackendConnectionStoreModule;
  credentialStore: BackendCredentialStoreModule;
  deploymentStore: BackendDeploymentStoreModule;
  activeRouteStore: BackendActiveRouteStoreModule;
  customChatModelStore: BackendCustomChatModelStoreModule;
};

/** Node realm 的 `Uint8Array` 构造器（jsdom 暴露的全局属另一 realm，tsx/esbuild 自检依赖）。 */
const resolveNodeUint8Array = (): Uint8ArrayConstructor => {
  const bufferPrototype: unknown = Object.getPrototypeOf(NodeBuffer.prototype);
  return (bufferPrototype as { constructor: Uint8ArrayConstructor }).constructor;
};

const sourcePath = (...segments: string[]): string =>
  path.join(process.cwd(), 'apps', 'backend', 'src', 'local-server', ...segments);

const loadBackendModules = async (): Promise<BackendModules> => {
  // esbuild（tsx 转译器）自检 `new TextEncoder().encode("") instanceof Uint8Array`：
  // jsdom 的 TextEncoder / Uint8Array 属另一 realm，会把自检判假，先换成 Node realm 实现。
  globalThis.Uint8Array = resolveNodeUint8Array();
  globalThis.TextEncoder = NodeTextEncoder;
  const tsx = await import('tsx/cjs/api');
  const scoped = tsx.register({ namespace: 'agent-product-membership-seam' });
  try {
    return {
      execution: cjsRequireAs<BackendAgentExecutionModule>(
        scoped.require(sourcePath('agent-execution.cts'), HELPER_FILE_PATH),
      ),
      ipcSender: cjsRequireAs<BackendIpcSenderModule>(
        scoped.require(sourcePath('backend-ipc-sender.cts'), HELPER_FILE_PATH),
      ),
      projectStore: cjsRequireAs<BackendProjectStoreModule>(
        scoped.require(sourcePath('project-store.cts'), HELPER_FILE_PATH),
      ),
      projectMediaScope: cjsRequireAs<BackendProjectMediaScopeModule>(
        scoped.require(sourcePath('project-media-scope.cts'), HELPER_FILE_PATH),
      ),
      connectionStore: cjsRequireAs<BackendConnectionStoreModule>(
        scoped.require(sourcePath('provider-connection', 'connection-store.cts'), HELPER_FILE_PATH),
      ),
      credentialStore: cjsRequireAs<BackendCredentialStoreModule>(
        scoped.require(sourcePath('provider-connection', 'credential-store.cts'), HELPER_FILE_PATH),
      ),
      deploymentStore: cjsRequireAs<BackendDeploymentStoreModule>(
        scoped.require(sourcePath('provider-connection', 'deployment-store.cts'), HELPER_FILE_PATH),
      ),
      activeRouteStore: cjsRequireAs<BackendActiveRouteStoreModule>(
        scoped.require(
          sourcePath('provider-connection', 'active-route-store.cts'),
          HELPER_FILE_PATH,
        ),
      ),
      customChatModelStore: cjsRequireAs<BackendCustomChatModelStoreModule>(
        scoped.require(
          sourcePath('provider-connection', 'custom-chat-model-store.cts'),
          HELPER_FILE_PATH,
        ),
      ),
    };
  } finally {
    // 模块已进 require cache：注销钩子只影响后续 require，不影响已加载的 backend 实现。
    scoped.unregister();
  }
};

// ── 常量（与 agent-tool-lineage.engineSeam.test.ts 同一套上游脚本）──

const CHAT_MODEL_ID = 'seam-llm';
const CHAT_CONNECTION_BASE_URL = 'https://seam-upstream.example.invalid/v1';
const CHAT_CREDENTIAL = 'sk-seam-upstream-key';
const UPSTREAM_MODEL_NAME = 'upstream-seam-model';

// 假模型名必须命中 openai-image-v1 闭合族正则（/^gpt-image-/i）才会进可提交目录。
const GENERATION_MODEL_ID = 'gpt-image-seam-membership';
const GENERATION_CONNECTION_BASE_URL = 'https://seam-gen-upstream.example.invalid/v1';
const GENERATION_CREDENTIAL = 'sk-seam-gen-key';

const AGENT_SESSION_ID = 'agent-session-membership-seam';
const TOOL_CALL_ID = 'call_membership_1';

const GRAPH_ID = 'graph-membership-seam';
const CONTAINER = { width: 1440, height: 900 };

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
}): { restore: () => void } => {
  const originalFetch = globalThis.fetch;
  const requests: UpstreamRequest[] = [];
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = readRequestUrl(input);
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    const parsed: unknown = rawBody ? JSON.parse(rawBody) : null;
    requests.push({
      url,
      body:
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null,
    });
    if (url.startsWith(params.generationBaseUrl)) {
      return jsonResponse({
        id: 'req-membership-1',
        data: [{ url: INLINE_IMAGE_DATA_URL }],
      });
    }
    const frames =
      params.chatScript[Math.min(requests.length - 1, params.chatScript.length - 1)] ?? [];
    return sseResponse(frames);
  };
  return {
    restore: (): void => {
      globalThis.fetch = originalFetch;
    },
  };
};

/**
 * 通知出口 process.send「捕获后转发」包装：
 * - task:state-changed / task:state-snapshot / media-assets:changed 是 backend→Main 的
 *   单向通知，捕获进数组供本测试消费（生产里由 desktop-shell 转发到 Editor，属 IPC 传输层，
 *   是本接缝允许挡住的最外层）。
 * - 其余消息原样转发给原始 process.send——vitest forks pool 的 worker 用它与 tinypool
 *   父进程通信，吞掉会破坏测试运行器本身。
 */
const BACKEND_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  'task:state-changed',
  'task:state-snapshot',
  'media-assets:changed',
]);

type NotificationCapture = { notifications: unknown[]; restore: () => void };

const installNotificationCapture = (): NotificationCapture => {
  const originalSend = process.send;
  const notifications: unknown[] = [];
  process.send = (message: unknown, ...args: unknown[]): boolean => {
    if (message !== null && typeof message === 'object') {
      const type: unknown = (message as { type?: unknown }).type;
      if (typeof type === 'string' && BACKEND_NOTIFICATION_TYPES.has(type)) {
        notifications.push(message);
        return true;
      }
    }
    if (originalSend !== undefined && originalSend !== null) {
      return Reflect.apply(originalSend, process, [message, ...args]) as boolean;
    }
    return true;
  };
  return {
    notifications,
    restore: (): void => {
      if (originalSend === undefined || originalSend === null) {
        Reflect.deleteProperty(process, 'send');
        return;
      }
      process.send = originalSend;
    },
  };
};

/**
 * OpenAI SDK 浏览器环境防护垫片：`isRunningInBrowser()` 判定 `typeof window !== 'undefined'
 * && typeof window.document !== 'undefined' && typeof navigator !== 'undefined'`——jsdom 下
 * 三者全真，client 构造直接抛错。生产 backend 跑在纯 Node（无 window 绑定），此处在后端链路
 * 执行窗口内临时摘除 `window` 全局绑定（属性值即 globalThis 本身、configurable），使被测
 * 引擎与生产同环境；窗口外 Editor 侧不受影响，结束后按原描述符还原。
 */
const hideWindowBindingForBackendChain = (): (() => void) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  if (descriptor === undefined) return () => undefined;
  Reflect.deleteProperty(globalThis, 'window');
  return (): void => {
    Object.defineProperty(globalThis, 'window', descriptor);
  };
};

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  throw new Error(`waitFor timed out: ${label}`);
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** 最小可提交生成模型包：输出 image、sync 结果规则、结果映射取 data.0.url（内联产物）。 */
const writeGenerationPackage = (packageRoot: string): void => {
  const packageDir = path.join(packageRoot, 'seam-membership-image-pkg');
  fs.mkdirSync(path.join(packageDir, 'locales'), { recursive: true });
  const writeJson = (filePath: string, value: unknown): void => {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
  };
  writeJson(path.join(packageDir, 'manifest.json'), {
    package_id: 'seam-membership-image-pkg',
    entry_model: { model_id: GENERATION_MODEL_ID, relative_path: 'runtime_model.json' },
    node_definition: { relative_path: 'node_definition.json' },
    resources: [],
    locales: [
      { locale: 'zh-CN', relative_path: 'locales/zh-CN.json' },
      { locale: 'en', relative_path: 'locales/en.json' },
    ],
  });
  writeJson(path.join(packageDir, 'locales', 'zh-CN.json'), { Prompt: 'Prompt' });
  writeJson(path.join(packageDir, 'locales', 'en.json'), { Prompt: 'Prompt' });
  writeJson(path.join(packageDir, 'node_definition.json'), {
    node_type: 'model',
    group_key: 'seam-membership',
    input_ports: [],
    output_ports: [],
  });
  writeJson(path.join(packageDir, 'runtime_model.json'), {
    model_id: GENERATION_MODEL_ID,
    provider_id: 'openai',
    capability: {
      input_modalities: ['text'],
      output_modalities: ['image'],
      supports_async_task: false,
    },
    parameter_schema: {
      fields: [{ field_key: 'prompt', label: 'Prompt', component: 'textarea', required: true }],
      required_fields: [],
      default_values: {},
    },
    runtime: {
      provider_id: 'openai',
      execution_driver: 'http_formal_task',
      api_defaults: { endpoint: '/v1/test', method: 'POST', contentType: 'application/json' },
    },
    request_strategy: {
      request_stage: 'submit',
      protocol: 'http',
      endpoint: '/v1/test',
      method: 'POST',
      header_rules: [],
      body_rules: [],
      query_rules: [],
    },
    // 同步结果规则：提交响应即结果（无轮询）。
    result_rule: { mode: 'sync', submit_response_id_path: '/id' },
    result_output_mapping: {
      response_mode: 'structured_payload',
      output_mapping_rules: [
        {
          target: 'output.image_url',
          source: { kind: 'response', path: 'data.0.url' },
          required: false,
          default_value: null,
        },
      ],
    },
  });
};

/** 假传输层：会话帧只记录不消费（本接缝的 Editor 入口是任务通知）；留作失败诊断。 */
const backendFrames: unknown[] = [];

const createBackendClient = (): BackendBusinessClient => ({
  ws: {
    OPEN: 1,
    readyState: 1,
    send: (payload: string): void => {
      backendFrames.push(JSON.parse(payload) as unknown);
    },
    on: (): void => {
      // 同上。
    },
  },
  actionIds: new Set<string>(),
  taskIds: new Set<string>(),
  closed: false,
});

const submitMessage = (projectPath: string): AgentSubmitPrompt => ({
  type: 'agent:submit_prompt',
  requestId: 'request-membership-1',
  agentSessionId: AGENT_SESSION_ID,
  projectPath,
  modelId: CHAT_MODEL_ID,
  thinkingTier: 'off',
  approvalMode: 'yolo',
  content: '帮我生成一张图',
  referenceAssetIds: [],
  referenceAssets: [],
});

// ── 生命周期状态 ──

let backend: BackendModules | null = null;
let notificationCapture: NotificationCapture | null = null;
let upstreamRestore: (() => void) | null = null;
let projectClose: (() => void) | null = null;
let storageRoot = '';
let packagesDir = '';
let seamProjectPath = '';
let seamTransactionTaskRows: Array<{ taskId: unknown; metadataJson: unknown }> = [];
const tempDirs: string[] = [];
let previousStorageRoot: string | undefined;
let previousPackagesDir: string | undefined;

type TaskStateChangeListener = (message: unknown) => void;
const electronListeners: {
  changed: TaskStateChangeListener | null;
  snapshot: TaskStateChangeListener | null;
  media: TaskStateChangeListener | null;
} = { changed: null, snapshot: null, media: null };

beforeAll(async () => {
  previousStorageRoot = process.env['IART_STORAGE_ROOT'];
  previousPackagesDir = process.env['IART_MODEL_ASSET_PACKAGES_DIR'];
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'membership-seam-storage-'));
  packagesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'membership-seam-packages-'));
  writeGenerationPackage(packagesDir);
  process.env['IART_STORAGE_ROOT'] = storageRoot;
  process.env['IART_MODEL_ASSET_PACKAGES_DIR'] = packagesDir;

  const modules = await loadBackendModules();

  // 隔离存储根 + 真实对话/生成两条链路的 store 种子（清缓存防跨用例残留）。
  modules.connectionStore.clearCacheForTest();
  modules.deploymentStore.clearCacheForTest();
  modules.activeRouteStore.clearCacheForTest();
  modules.customChatModelStore.clearCacheForTest();

  const projectParent = fs.mkdtempSync(path.join(os.tmpdir(), 'membership-seam-project-'));
  tempDirs.push(projectParent);
  const created = modules.projectStore.createProjectFolder(projectParent, 'demo-membership');
  if (!created || created.error !== undefined || !created.projectPath) {
    throw new Error('project_creation_failed');
  }
  const projectPath = created.projectPath;
  fs.writeFileSync(
    path.join(projectPath, 'manifest.json'),
    JSON.stringify({ version: 1, name: 'demo-membership' }),
    'utf-8',
  );
  const stableProjectId = `spid_${crypto.randomBytes(12).toString('hex')}`;
  const projectRef = `prj_${crypto.randomBytes(16).toString('hex').slice(0, 32)}`;
  const synced = modules.projectMediaScope.syncProjectScope({
    stableProjectId,
    projectPath,
    projectRef,
  });
  if (!synced) throw new Error('project scope should be registered');
  projectClose = (): void => {
    modules.projectMediaScope.removeProjectScope(stableProjectId);
    fs.rmSync(projectParent, { recursive: true, force: true });
  };
  seamProjectPath = projectPath;

  // 对话链路种子：连接 → 凭证 → 部署 → active route → 自定义对话模型声明。
  const chatConnection = modules.connectionStore.createConnection({
    display_name: 'seam-upstream',
    base_url: CHAT_CONNECTION_BASE_URL,
  });
  const chatCredential = await modules.credentialStore.setCredentialForConnection(
    chatConnection.connection_id,
    CHAT_CREDENTIAL,
  );
  if (!chatCredential) throw new Error('chat credential should be written');
  modules.connectionStore.setConnectionCredential(
    chatConnection.connection_id,
    chatCredential.credentialRef,
    chatCredential.version,
    true,
  );
  // 单记录口径（spec 03 §6.1）：对话模型的能力属性与接入归属一体，一次写入完成；
  // 不再经 ModelDeployment 接入（自建 model_id 在 deployment 创建路径被显式拒绝）。
  const chatRecord = modules.customChatModelStore.addCustomChatModel({
    model_id: CHAT_MODEL_ID,
    connection_id: chatConnection.connection_id,
    protocol_adapter_id: 'openai-chat-completions-v1',
    remote_model_id: UPSTREAM_MODEL_NAME,
  });
  if (!chatRecord.ok || !chatRecord.model) {
    throw new Error('custom chat model record should be created');
  }
  if (
    modules.activeRouteStore.setActiveDeployment(CHAT_MODEL_ID, chatRecord.model.record_id) !==
    chatRecord.model.record_id
  ) {
    throw new Error('chat active route should be set');
  }

  // 生成链路种子：连接 → 凭证 → 部署 → active route（连接不再承载接口类型，协议随模型记录走）。
  const generationConnection = modules.connectionStore.createConnection({
    display_name: 'seam-gen-upstream',
    base_url: GENERATION_CONNECTION_BASE_URL,
  });
  const generationCredential = await modules.credentialStore.setCredentialForConnection(
    generationConnection.connection_id,
    GENERATION_CREDENTIAL,
  );
  if (!generationCredential) throw new Error('generation credential should be written');
  modules.connectionStore.setConnectionCredential(
    generationConnection.connection_id,
    generationCredential.credentialRef,
    generationCredential.version,
    true,
  );
  const generationDeployment = modules.deploymentStore.createDeployment({
    model_id: GENERATION_MODEL_ID,
    connection_id: generationConnection.connection_id,
    remote_model_id: 'remote-seam-image',
  });
  if (
    modules.activeRouteStore.setActiveDeployment(
      GENERATION_MODEL_ID,
      generationDeployment.deployment_id,
    ) !== generationDeployment.deployment_id
  ) {
    throw new Error('generation active deployment should be set');
  }

  // Backend→Main 请求-响应 IPC 拦截：历史读取回空、runtime 事务回执并捕获落库行、任务事件回执。
  seamTransactionTaskRows = [];
  const transactionTaskRows = seamTransactionTaskRows;
  modules.ipcSender.setBackendIpcTestHandler(async (message: unknown) => {
    const payload = asRecord(message);
    const type = payload === null ? undefined : payload['type'];
    const transactionId = String(payload?.['transactionId'] ?? '');
    if (type === 'runtime:read-agent-messages') {
      return { type: 'runtime:transaction-result', transactionId, success: true, data: [] };
    }
    if (type === 'runtime:execute-transaction') {
      const tasks: unknown = payload?.['tasks'];
      if (Array.isArray(tasks)) {
        for (const row of tasks) {
          const view = asRecord(row);
          if (view !== null) {
            transactionTaskRows.push({
              taskId: view['taskId'],
              metadataJson: view['metadataJson'],
            });
          }
        }
      }
      return { type: 'runtime:transaction-result', transactionId, success: true, data: null };
    }
    if (type === 'runtime:write-task-event') {
      return { type: 'runtime:transaction-result', transactionId, success: true, data: null };
    }
    throw new Error(`unexpected IPC message type: ${String(type)}`);
  });

  notificationCapture = installNotificationCapture();
  upstreamRestore = installSucceedingUpstreamStub({
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
  }).restore;

  backend = modules;
}, 120_000);

afterAll(() => {
  notificationCapture?.restore();
  upstreamRestore?.();
  backend?.ipcSender.setBackendIpcTestHandler(null);
  backend?.connectionStore.clearCacheForTest();
  backend?.deploymentStore.clearCacheForTest();
  backend?.activeRouteStore.clearCacheForTest();
  backend?.customChatModelStore.clearCacheForTest();
  projectClose?.();
  if (previousStorageRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
  else process.env['IART_STORAGE_ROOT'] = previousStorageRoot;
  if (previousPackagesDir === undefined) delete process.env['IART_MODEL_ASSET_PACKAGES_DIR'];
  else process.env['IART_MODEL_ASSET_PACKAGES_DIR'] = previousPackagesDir;
  fs.rmSync(storageRoot, { recursive: true, force: true });
  fs.rmSync(packagesDir, { recursive: true, force: true });
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  Reflect.deleteProperty(window, 'electron');
});

const resetCanvas = (): void => {
  const graph = createNodeGraph({
    name: 'membership-seam',
    description: undefined,
    tags: undefined,
    category: undefined,
  });
  graph.id = GRAPH_ID;
  graph.viewport = { x: 0, y: 0, zoom: 1 };
  useCanvasStore.setState((state) => {
    state.nodeGraph = graph;
    state.mediaAssets = {};
    state.selectedNodeIds = [];
    state.history = [];
    state.historyIndex = -1;
    state.hasUnsavedChanges = false;
    state.ui.canvasContainerSize = CONTAINER;
  });
};

/** window.electron 任务通知通道替身：登记 hook 注册的真实 listener，供测试把原始通知灌入。 */
const installElectronListenerStub = (): void => {
  electronListeners.changed = null;
  electronListeners.snapshot = null;
  electronListeners.media = null;
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      onTaskStateChanged: (handler: TaskStateChangeListener): void => {
        electronListeners.changed = handler;
      },
      onTaskStateSnapshot: (handler: TaskStateChangeListener): void => {
        electronListeners.snapshot = handler;
      },
      onMediaAssetsChanged: (handler: TaskStateChangeListener): void => {
        electronListeners.media = handler;
      },
      removeTaskStateListeners: (): void => {
        electronListeners.changed = null;
        electronListeners.snapshot = null;
        electronListeners.media = null;
      },
    },
  });
};

const findAssetNode = (assetId: string): GraphNode<AssetNodeData> | undefined => {
  const nodes = useCanvasStore.getState().nodeGraph?.nodes ?? [];
  return nodes.find(
    (node): node is GraphNode<AssetNodeData> =>
      node.type === 'asset' && (node.data as AssetNodeData).assetId === assetId,
  );
};

const findAgentNode = (): GraphNode | undefined =>
  (useCanvasStore.getState().nodeGraph?.nodes ?? []).find((node) => node.type === 'agent');

beforeEach(() => {
  resetCanvas();
  installElectronListenerStub();
  backendFrames.length = 0;
});

describe('agent 产物自动入容器投影接缝', () => {
  // @spec: AG-CT-001
  it('真实链路：工具产出 → 记录白名单 → 通知真实构造 → Editor 真实投影消费 → 产物 groupId 指向 Agent 节点', async () => {
    const modules = backend;
    expect(modules).not.toBeNull();
    if (!modules) return;

    // ── Given：Editor 真实投影创建锚点 Agent 节点（受理创建事实的真实函数）──
    const agentNode = createAgentNodeForAcceptance({ agentSessionId: AGENT_SESSION_ID });
    expect(agentNode).not.toBeNull();
    const agentNodeId = agentNode?.id ?? '';
    expect(agentNodeId).not.toBe('');

    // ── When：Backend 真实引擎（真实 chat 适配器 + 真实工具执行链 + 假 HTTP 上游）──
    const capture = notificationCapture;
    expect(capture).not.toBeNull();
    if (!capture) return;
    const isSucceededNotification = (raw: unknown): boolean => {
      const parsed = TaskStateNotificationSchema.safeParse(raw);
      return parsed.success && parsed.data.task.status === 'succeeded';
    };
    const restoreWindow = hideWindowBindingForBackendChain();
    try {
      await modules.execution.executeAgentSubmitPrompt({
        client: createBackendClient(),
        message: submitMessage(seamProjectPath),
      });
      await waitFor(
        () => capture.notifications.some(isSucceededNotification),
        'agent-derived task succeeded notification',
      );
    } catch (error) {
      // 失败诊断：把会话帧（accepted/error/tool 事件）与通知捕获数一起带出，定位断链在哪一跳。
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; ` +
          `captured=${capture.notifications.length}; frames=${JSON.stringify(backendFrames)}`,
      );
    } finally {
      restoreWindow();
    }

    const succeededRaw: unknown = capture.notifications.find(isSucceededNotification);
    expect(succeededRaw).toBeTruthy();
    const succeeded = TaskStateNotificationSchema.parse(succeededRaw);
    const lineage = { agentSessionId: AGENT_SESSION_ID, toolCallId: TOOL_CALL_ID };

    // ── 输入真实性证据①：通知 task.metadata 携带血缘（过白名单后的视图构造产物）──
    expect(parseAgentTaskLineage(succeeded.task.metadata ?? null)).toEqual(lineage);
    expect((succeeded.task.metadata ?? {})[AGENT_TASK_LINEAGE_METADATA_KEY]).toEqual(lineage);

    // ── 输入真实性证据②：产物随通知真实到达（Editor 落资产节点的输入）──
    const imageOutput = succeeded.outputs.find(
      (output) =>
        output.mediaType === 'image' &&
        typeof output.assetId === 'string' &&
        output.assetId.length > 0,
    );
    expect(imageOutput).toBeTruthy();
    const assetId = String(imageOutput?.assetId ?? '');
    expect(assetId).not.toBe('');
    expect(succeeded.mediaAssets.length).toBeGreaterThan(0);

    // ── 输入真实性证据③：落库侧行 metadataJson 同带血缘（记录创建白名单读写同源）──
    const persistedRow = seamTransactionTaskRows.find(
      (row) => row.taskId === succeeded.task.taskId,
    );
    expect(persistedRow).toBeTruthy();
    expect(typeof persistedRow?.metadataJson).toBe('string');
    const persistedMetadata: unknown = JSON.parse(String(persistedRow?.metadataJson));
    expect(parseAgentTaskLineage(persistedMetadata)).toEqual(lineage);

    // ── Then：Editor 真实消费入口（hook 注册的 listener → schema parse → applyTaskStateChanged）
    //       —— 捕获的原始通知跨边界进入，不做任何手工改写 ──
    renderHook(() => useCanvasTaskIndexSync(GRAPH_ID, undefined));
    expect(electronListeners.changed).not.toBeNull();
    act(() => {
      electronListeners.changed?.(succeededRaw);
    });

    // 断言核心：产物资产节点已落画布，且 groupId 指向 Agent 节点（创建即入容器）。
    const product = findAssetNode(assetId);
    expect(product).toBeTruthy();
    expect(product?.groupId).toBe(agentNodeId);

    // 容器属性不新增节点类型：画布没有 group 类型节点；Agent 节点自身不是成员。
    const graphNodes = useCanvasStore.getState().nodeGraph?.nodes ?? [];
    expect(graphNodes.some((node) => node.type === 'group')).toBe(false);
    expect(findAgentNode()?.groupId).toBeUndefined();
    // 血缘归血缘：媒体记录并入画布注册表，可被引用。
    expect(useCanvasStore.getState().mediaAssets[assetId]).toBeTruthy();
  }, 60_000);
});
