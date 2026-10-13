import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  AgentServerMessageSchema,
  type AgentServerMessage,
  type AgentSubmitPrompt,
} from '@iart/contracts';
import type { BusinessClient } from '../business-actions/common.cts';
import { setBackendIpcTestHandler } from '../backend-ipc-sender.cts';
import { executeAgentSubmitPrompt, handleAgentMessage } from '../agent-execution.cts';
import { createProjectFolder } from '../project-store.cts';
import { removeProjectScope, syncProjectScope } from '../project-media-scope.cts';
import {
  clearCacheForTest as clearConnectionCache,
  createConnection,
  setConnectionCredential,
} from '../provider-connection/connection-store.cts';
import {
  clearCacheForTest as clearDeploymentCache,
  createDeployment,
} from '../provider-connection/deployment-store.cts';
import {
  clearCacheForTest as clearActiveRouteCache,
  setActiveDeployment,
} from '../provider-connection/active-route-store.cts';
import {
  addCustomChatModel,
  clearCacheForTest as clearCustomModelCache,
} from '../provider-connection/custom-chat-model-store.cts';
import { setCredentialForConnection } from '../provider-connection/credential-store.cts';

/**
 * Agent 单条取消接缝测试（spec 04「工具调用循环语义·单条取消」、spec 05「Yolo 语义」）。
 *
 * 使命：验证**真实**链路「`agent:cancel` 携带 toolCallId → 取消路由分支 → 条目级中止登记 →
 * 真实执行器的中止信号 → 派生任务取消链 → 该条目以 `cancelled` 结算回灌 → 第二轮模型调用 →
 * complete 收口」，且**不**发出整请求取消的 `agent:error`。
 *
 * 真实边界外的替身只有两处（与 `agent-tool-loop.engineSeam.test.ts` 同一 bargain）：
 * - 上游网络走假 fetch：对话上游按脚本回放 SSE；生成上游端点挂起直到中止信号触发
 *   （模拟真实生成任务的长时间在途，取消命令到达时条目必然在途）。
 * - Backend→Main IPC（历史读取 / runtime 事务 / 任务事件）在测试处理器内拦截。
 *
 * 红→绿自证：本测试先在「取消路由未按 toolCallId 分支」的旧实现上跑红
 * （单条取消被当整请求取消 → error(cancelled) 收口、无第二轮），再随路由分支落地转绿。
 */

const CHAT_MODEL_ID = 'seam-llm';
const CHAT_CONNECTION_BASE_URL = 'https://seam-upstream.example.invalid/v1';
const CHAT_CREDENTIAL = 'sk-seam-upstream-key';
const UPSTREAM_MODEL_NAME = 'upstream-seam-model';

// 假模型名必须命中 openai-image-v1 闭合族正则（/^gpt-image-/i）才会进可提交目录
//（listExecutableCatalogEntries 只收录已闭合生成族）。
const GENERATION_MODEL_ID = 'gpt-image-seam';
const GENERATION_CONNECTION_BASE_URL = 'https://seam-gen-upstream.example.invalid/v1';
const GENERATION_CREDENTIAL = 'sk-seam-gen-key';

const AGENT_SESSION_ID = 'agent-session-cancel-seam';

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

const readRequestUrl = (input: string | URL | Request): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

const abortError = (): Error => new DOMException('This operation was aborted', 'AbortError');

/**
 * 路由式假 fetch：对话上游按调用序回放脚本化 SSE；生成上游挂起直到中止信号触发
 * （真实生成任务的长在途等价物；取消链会 abort 该请求，不会留下悬空 socket）。
 */
const installRoutingUpstreamStub = (params: {
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
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal ?? null;
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      });
      throw new Error('generation upstream resolved without abort (not expected)');
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

const messagesOfType = <T extends AgentServerMessage['type']>(
  sent: AgentServerMessage[],
  type: T,
): Array<Extract<AgentServerMessage, { type: T }>> =>
  sent.filter((message): message is Extract<AgentServerMessage, { type: T }> => message.type === type);

const messageRolesOfRequest = (request: UpstreamRequest | undefined): string[] => {
  const messages = request?.body?.['messages'];
  if (!Array.isArray(messages)) return [];
  return messages.map((message: unknown) =>
    message !== null && typeof message === 'object' && !Array.isArray(message)
      ? String(Reflect.get(message, 'role'))
      : '',
  );
};

const messageAt = (request: UpstreamRequest | undefined, index: number): Record<string, unknown> => {
  const messages = request?.body?.['messages'];
  if (!Array.isArray(messages)) throw new Error('upstream request carries no messages');
  const message: unknown = messages[index];
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error(`upstream message #${index} is not an object`);
  }
  return message as Record<string, unknown>;
};

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
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

/** 最小可提交生成模型包：输出 image、http_formal_task 驱动、提交端点指向挂起上游。 */
const writeGenerationPackage = (packageRoot: string): void => {
  const packageDir = path.join(packageRoot, 'seam-image-pkg');
  fs.mkdirSync(path.join(packageDir, 'locales'), { recursive: true });
  const writeJson = (filePath: string, value: unknown): void => {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
  };
  writeJson(path.join(packageDir, 'manifest.json'), {
    package_id: 'seam-image-pkg',
    entry_model: { model_id: GENERATION_MODEL_ID, relative_path: 'runtime_model.json' },
    node_definition: { relative_path: 'node_definition.json' },
    resources: [],
    locales: [
      { locale: 'zh-CN', relative_path: 'locales/zh-CN.json' },
      { locale: 'en', relative_path: 'locales/en.json' },
    ],
  });
  // 本地化词典必须覆盖全部字段标签（缺键 = bad_package，整包被拒载）。
  writeJson(path.join(packageDir, 'locales', 'zh-CN.json'), { Prompt: 'Prompt' });
  writeJson(path.join(packageDir, 'locales', 'en.json'), { Prompt: 'Prompt' });
  writeJson(path.join(packageDir, 'node_definition.json'), {
    node_type: 'model',
    group_key: 'seam-cancel',
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
      // 加载器要求至少一个字段；prompt 由生成工具顶层承载（提交体单独投影），
      // 不进参数合并层，因此 required_fields 留空（否则执行侧必填校验误报缺 prompt）。
      fields: [{ field_key: 'prompt', label: 'Prompt', component: 'textarea', required: true }],
      required_fields: [],
      default_values: {},
    },
    runtime: {
      provider_id: 'openai',
      execution_driver: 'http_formal_task',
      // 组装器的端点来源是 payload api 块 / runtime.api_defaults（非 request_strategy.endpoint）。
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
    result_rule: { mode: 'sync', submit_response_id_path: '/id' },
  });
};

const createOpenedProject = (projectName: string) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cancel-seam-'));
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

/**
 * 隔离存储根 + 真实对话/生成两条链路的 store 种子：
 * 对话（openai-chat-completions-v1）走既有范式；生成（openai-image-v1）同构播种。
 * 模型名不命中生成族正则（模型族 unresolved），与任意适配器兼容。
 */
const setupTest = async (t: TestContext) => {
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  const previousPackagesDir = process.env['IART_MODEL_ASSET_PACKAGES_DIR'];
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cancel-seam-storage-'));
  const packagesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cancel-seam-packages-'));
  writeGenerationPackage(packagesDir);
  process.env['IART_STORAGE_ROOT'] = storageRoot;
  process.env['IART_MODEL_ASSET_PACKAGES_DIR'] = packagesDir;
  const clearCaches = (): void => {
    clearConnectionCache();
    clearDeploymentCache();
    clearActiveRouteCache();
    clearCustomModelCache();
  };
  clearCaches();
  const project = createOpenedProject('demo-agent-cancel');
  const harness = createHarness();
  const handledTypes: string[] = [];
  setBackendIpcTestHandler(async (message) => {
    handledTypes.push(message.type);
    if (message.type === 'runtime:read-agent-messages') {
      return {
        type: 'runtime:transaction-result',
        transactionId: message.transactionId,
        success: true,
        data: [],
      };
    }
    if (message.type === 'runtime:execute-transaction' || message.type === 'runtime:write-task-event') {
      return {
        type: 'runtime:transaction-result',
        transactionId: message.transactionId,
        success: true,
        data: null,
      };
    }
    throw new Error(`unexpected IPC message type: ${message.type}`);
  });

  // 对话链路种子（与 engineSeam 同范式）。
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

  // 生成链路种子：连接（openai-image-v1）→ 凭证 → 部署 → active route。
  const generationConnection = createConnection({
    display_name: 'seam-gen-upstream',
    base_url: GENERATION_CONNECTION_BASE_URL,
  });
  const generationCredential = await setCredentialForConnection(generationConnection.connection_id, GENERATION_CREDENTIAL);
  assert.ok(generationCredential, 'generation credential should be written');
  setConnectionCredential(generationConnection.connection_id, generationCredential.credentialRef, generationCredential.version, true);
  const generationDeployment = createDeployment({
    model_id: GENERATION_MODEL_ID,
    connection_id: generationConnection.connection_id,
    remote_model_id: 'remote-seam-image',
  });
  assert.equal(setActiveDeployment(GENERATION_MODEL_ID, generationDeployment.deployment_id), generationDeployment.deployment_id);

  t.after(() => {
    setBackendIpcTestHandler(null);
    project.close();
    clearCaches();
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    if (previousPackagesDir === undefined) delete process.env['IART_MODEL_ASSET_PACKAGES_DIR'];
    else process.env['IART_MODEL_ASSET_PACKAGES_DIR'] = previousPackagesDir;
    fs.rmSync(storageRoot, { recursive: true, force: true });
    fs.rmSync(packagesDir, { recursive: true, force: true });
  });
  return { ...harness, projectPath: project.projectPath };
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

void test('接缝：单条取消只中止在途生成条目，整轮继续收口', async (t) => {
  const { client, sent, projectPath } = await setupTest(t);
  const upstream = installRoutingUpstreamStub({
    generationBaseUrl: GENERATION_CONNECTION_BASE_URL,
    chatScript: [
      [
        toolCallFrame({
          id: 'call_cancel_1',
          name: 'generate_image',
          argsJson: `{"model_id":"${GENERATION_MODEL_ID}","prompt":"一只猫"}`,
        }),
        finishFrame('tool_calls'),
        DONE_FRAME,
      ],
      [contentFrame('生成已取消，改为文字说明。'), finishFrame('stop'), DONE_FRAME],
    ],
  });
  t.after(() => {
    upstream.restore();
  });

  const pending = executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-cancel-tool-1', projectPath }),
  });

  // 等条目进入执行（dispatching = 执行器已在途、挂起的生成请求已发出）。
  try {
    await waitFor(
      () => messagesOfType(sent(), 'agent:tool_call').some((event) => event.status === 'dispatching'),
      'generation entry dispatching',
    );
  } catch (error: unknown) {
    console.error('[seam-diag] sent events:', JSON.stringify(sent(), null, 2));
    console.error('[seam-diag] upstream requests:', JSON.stringify(upstream.requests.map((r) => r.url), null, 2));
    throw error;
  }
  // 诊断：条目应停在执行中（生成请求挂起）；若已提前终态说明生成链在派发前断裂。
  try {
    await waitFor(
      () => upstream.generationRequestCount() > 0,
      'generation task request reached upstream',
    );
  } catch (error: unknown) {
    console.error('[seam-diag] sent events:', JSON.stringify(sent(), null, 2));
    throw error;
  }
  assert.equal(upstream.generationRequestCount(), 1, 'generation task should have started its request');
  // 单条取消：携带 toolCallId 的 agent:cancel（spec 05「Yolo 语义」）。
  handleAgentMessage(client, {
    type: 'agent:cancel',
    agentSessionId: AGENT_SESSION_ID,
    requestId: 'request-cancel-tool-1',
    toolCallId: 'call_cancel_1',
  });
  await pending;

  // ── 条目结算：cancelled（走生成任务取消链，非 skipped / failed）──
  const toolResults = messagesOfType(sent(), 'agent:tool_result');
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0]?.toolCallId, 'call_cancel_1');
  assert.equal(toolResults[0]?.status, 'cancelled');

  // ── 整轮未被中止：无 error(cancelled)，循环进入第二轮并 complete 收口 ──
  assert.equal(messagesOfType(sent(), 'agent:error').length, 0, 'single-item cancel must not abort the round');
  // 请求序（按 URL 区分）：chat 首轮 → 生成（挂起被中止）→ chat 第二轮。
  const chatRequests = upstream.requests.filter((request) => request.url.startsWith(CHAT_CONNECTION_BASE_URL));
  assert.equal(chatRequests.length, 2, 'tool loop should call the model a second time after cancel');
  const second = chatRequests[1];
  assert.deepEqual(messageRolesOfRequest(second), ['user', 'assistant', 'tool']);
  const toolMessage = messageAt(second, 2);
  assert.equal(toolMessage['tool_call_id'], 'call_cancel_1');
  assert.match(String(toolMessage['content']), /已取消/);
  const complete = messagesOfType(sent(), 'agent:complete');
  assert.equal(complete.length, 1);
  assert.equal(complete[0]?.content, '生成已取消，改为文字说明。');
});

void test('接缝：未命中单条取消不打断在途；整请求取消仍以 cancelled 收口（回归）', async (t) => {
  const { client, sent, projectPath } = await setupTest(t);
  const upstream = installRoutingUpstreamStub({
    generationBaseUrl: GENERATION_CONNECTION_BASE_URL,
    chatScript: [
      [
        toolCallFrame({
          id: 'call_whole_1',
          name: 'generate_image',
          argsJson: `{"model_id":"${GENERATION_MODEL_ID}","prompt":"一只猫"}`,
        }),
        finishFrame('tool_calls'),
        DONE_FRAME,
      ],
    ],
  });
  t.after(() => {
    upstream.restore();
  });

  const pending = executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-cancel-whole-1', projectPath }),
  });
  await waitFor(
    () => messagesOfType(sent(), 'agent:tool_call').some((event) => event.status === 'dispatching'),
    'generation entry dispatching',
  );
  const eventsAtInFlight = sent().length;

  // ① 未命中的单条取消（错误的条目标识）：留痕忽略，不发事件、不打断在途执行。
  handleAgentMessage(client, {
    type: 'agent:cancel',
    agentSessionId: AGENT_SESSION_ID,
    requestId: 'request-cancel-whole-1',
    toolCallId: 'call_bogus',
  });
  await waitFor(
    () => upstream.generationRequestCount() === 1,
    'in-flight generation request still hanging after missed cancel',
  );
  assert.equal(sent().length, eventsAtInFlight, 'missed cancel must not emit events');

  // ② 整请求取消（不带 toolCallId）：条目随请求联动取消（cancelled 结算），整轮 error(cancelled) 收口。
  handleAgentMessage(client, {
    type: 'agent:cancel',
    agentSessionId: AGENT_SESSION_ID,
    requestId: 'request-cancel-whole-1',
  });
  await pending;

  const toolResults = messagesOfType(sent(), 'agent:tool_result');
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0]?.status, 'cancelled', 'in-flight entry settles cancelled via chained abort');
  const errors = messagesOfType(sent(), 'agent:error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.code, 'cancelled');
  assert.equal(messagesOfType(sent(), 'agent:complete').length, 0, 'aborted round must not complete');
});
