import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  AgentClientMessageSchema,
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
 * Agent 工具循环 × 流式引擎接缝测试（spec 04「工具调用循环语义」）。
 *
 * 使命：验证**真实**链路「流式引擎调用适配器 → 适配器聚合流式 tool_calls → 引擎把聚合结果
 * 交给循环 → 循环执行并回填 → 第二轮模型调用携带 assistant tool_calls + tool 结果」。
 *
 * 与 `agent.toolLoopSeam.test.ts`（Editor↔Backend 接缝，注入假 core）的分工：那条链路的
 * 假 core 直接返回 `message.toolCalls`，因此**测不到**引擎与适配器之间靠 `onToolCall` 回调
 * 运转的收集机制——本表专门覆盖这一环。这里不注入假 core：只用假 HTTP 上游（本机 http
 * 不可用，故替换 `globalThis.fetch`，真实 `openai_chat` 适配器与真实 SSE 帧照常运转）。
 *
 * 判据是「循环是否进入第二轮」，模型上下文里 assistant tool_calls 与 tool 结果的配对必须
 * 完整（OpenAI 协议要求每个 tool_call_id 都有对应 tool 结果，缺一条下一轮即 API 报错）。
 */

const CHAT_MODEL_ID = 'seam-llm';
const CHAT_CONNECTION_BASE_URL = 'https://seam-upstream.example.invalid/v1';
const CHAT_CREDENTIAL = 'sk-seam-upstream-key';
const UPSTREAM_MODEL_NAME = 'upstream-seam-model';

type UpstreamRequest = { url: string; body: Record<string, unknown> | null };

type UpstreamStub = {
  requests: UpstreamRequest[];
  restore: () => void;
};

const sseFrame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

const contentFrame = (content: string): string =>
  sseFrame({
    id: 'chatcmpl-seam',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: UPSTREAM_MODEL_NAME,
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
  });

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

const DONE_FRAME = 'data: [DONE]\n\n';

/** 一段完整的 SSE 上游响应（帧序与真实 OpenAI 流一致：内容 → tool_calls → finish → [DONE]）。 */
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

/**
 * 假 HTTP 上游：按调用序号回放脚本化 SSE 帧，并记录每次请求体。
 *
 * 连接 base_url 在 store 层被约束为 https（连接声明不可为本机 http），因此这里替换
 * `globalThis.fetch` 而不是起本地服务器——真实适配器仍按真实 HTTP 客户端语义发请求。
 */
const installUpstreamStub = (scriptedResponses: string[][]): UpstreamStub => {
  const originalFetch = globalThis.fetch;
  const requests: UpstreamRequest[] = [];
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    const parsed: unknown = rawBody ? JSON.parse(rawBody) : null;
    requests.push({
      url: readRequestUrl(input),
      body: parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null,
    });
    const frames = scriptedResponses[Math.min(requests.length - 1, scriptedResponses.length - 1)] ?? [];
    return sseResponse(frames);
  };
  return {
    requests,
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
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(message)) {
    record[key] = value;
  }
  return record;
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

const createOpenedProject = (projectName: string) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-engine-seam-'));
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
 * 隔离存储根并声明「真实用的那条对话链路」：连接（openai-chat-completions-v1）→ 凭证 →
 * 部署（冻结 remote_model_id）→ active route → 自建对话模型声明。全部走生产 store，
 * 不注入任何替身：模型配置解析阶段测的就是生产路径。
 */
const seedChatModel = async (): Promise<void> => {
  const connection = createConnection({
    display_name: 'seam-upstream',
    base_url: CHAT_CONNECTION_BASE_URL,
  });
  const credential = await setCredentialForConnection(connection.connection_id, CHAT_CREDENTIAL);
  assert.ok(credential, 'credential should be written');
  setConnectionCredential(connection.connection_id, credential.credentialRef, credential.version, true);
  // 写侧兼容判定是显式两态（生成模型自建声明试点 §3.5）：解析不出族的 model_id 建不了接入，
  // 声明必须先于部署——不再按「任意 model_id 可建死记录」的旧行为播种。
  // 单记录口径：能力属性与接入归属一体（spec 03 §6.1），不再经 ModelDeployment 接入。
  const record = addCustomChatModel({
    model_id: CHAT_MODEL_ID,
    connection_id: connection.connection_id,
    protocol_adapter_id: 'openai-chat-completions-v1',
    remote_model_id: UPSTREAM_MODEL_NAME,
  });
  assert.equal(record.ok, true, 'custom chat model record should be created');
  const activated = setActiveDeployment(CHAT_MODEL_ID, record.model.record_id);
  assert.equal(activated, record.model.record_id, 'active route should point at the seeded record');
};

const setupTest = async (t: TestContext) => {
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  const previousPackagesDir = process.env['IART_MODEL_ASSET_PACKAGES_DIR'];
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-engine-seam-storage-'));
  // 空包目录：本表不依赖生成工具投影（加工工具是内置固定注册表，与包目录无关）。
  const emptyPackagesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-engine-seam-packages-'));
  process.env['IART_STORAGE_ROOT'] = storageRoot;
  process.env['IART_MODEL_ASSET_PACKAGES_DIR'] = emptyPackagesDir;
  const clearCaches = (): void => {
    clearConnectionCache();
    clearDeploymentCache();
    clearActiveRouteCache();
    clearCustomModelCache();
  };
  clearCaches();
  const project = createOpenedProject('demo-agent-engine');
  const harness = createHarness();
  setBackendIpcTestHandler(async (message) => {
    if (message.type !== 'runtime:read-agent-messages') {
      throw new Error(`unexpected IPC message type: ${message.type}`);
    }
    return {
      type: 'runtime:transaction-result',
      transactionId: message.transactionId,
      success: true,
      data: [],
    };
  });
  await seedChatModel();
  t.after(() => {
    setBackendIpcTestHandler(null);
    project.close();
    clearCaches();
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    if (previousPackagesDir === undefined) delete process.env['IART_MODEL_ASSET_PACKAGES_DIR'];
    else process.env['IART_MODEL_ASSET_PACKAGES_DIR'] = previousPackagesDir;
    fs.rmSync(storageRoot, { recursive: true, force: true });
    fs.rmSync(emptyPackagesDir, { recursive: true, force: true });
  });
  return { ...harness, projectPath: project.projectPath };
};

const submitMessage = (overrides: {
  requestId: string;
  projectPath: string;
  approvalMode?: 'confirm' | 'yolo';
}): AgentSubmitPrompt => ({
  type: 'agent:submit_prompt',
  requestId: overrides.requestId,
  agentSessionId: 'agent-session-engine',
  projectPath: overrides.projectPath,
  modelId: CHAT_MODEL_ID,
  thinkingTier: 'off',
  approvalMode: overrides.approvalMode ?? 'yolo',
  content: '帮我把这张图处理一下',
  referenceAssetIds: [],
  referenceAssets: [],
});

void test('接缝：引擎聚合的流式 tool_calls 进入工具循环，第二轮携带 assistant tool_calls + tool 结果', async (t) => {
  const { client, sent, projectPath } = await setupTest(t);
  const upstream = installUpstreamStub([
    [
      contentFrame('我先看看有没有这个工具'),
      toolCallFrame({ id: 'call_eng_1', name: 'unknown_tool', argsJson: '{"a":1}' }),
      finishFrame('tool_calls'),
      DONE_FRAME,
    ],
    [contentFrame('这个工具不存在，改用文字说明。'), finishFrame('stop'), DONE_FRAME],
  ]);
  t.after(() => {
    upstream.restore();
  });

  await executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-engine-tool-1', projectPath }),
  });

  // ── 循环进入第二轮：上游被调用了两次（断链时只有一次，首轮即收口）──
  assert.equal(upstream.requests.length, 2, 'tool loop should call the model a second time');
  assert.match(upstream.requests[0]?.url ?? '', /\/chat\/completions$/);
  // 第一轮携带工具清单（循环声明了工具能力），第二轮同样携带（未达轮数上限）。
  assert.ok(Array.isArray(upstream.requests[0]?.body?.['tools']), 'first round should declare tools');

  // ── 第二轮模型上下文：user → assistant(tool_calls) → tool（配对完整）──
  const second = upstream.requests[1];
  assert.deepEqual(messageRolesOfRequest(second), ['user', 'assistant', 'tool']);
  const assistantMessage = messageAt(second, 1);
  const toolCalls = assistantMessage['tool_calls'];
  assert.ok(Array.isArray(toolCalls), 'assistant message should carry tool_calls');
  const firstToolCall: unknown = toolCalls[0];
  assert.ok(firstToolCall !== null && typeof firstToolCall === 'object');
  assert.equal(Reflect.get(firstToolCall, 'id'), 'call_eng_1');
  assert.equal(Reflect.get(Reflect.get(firstToolCall, 'function') as object, 'name'), 'unknown_tool');
  const toolMessage = messageAt(second, 2);
  assert.equal(toolMessage['tool_call_id'], 'call_eng_1');
  assert.match(String(toolMessage['content']), /unknown_tool/);

  // ── 出站事件：中间轮助手消息定稿携带该批 tool_calls → 未知工具按失败回灌 → 第二轮收口 ──
  const messages = sent();
  const assistantEvents = messagesOfType(messages, 'agent:assistant_message');
  assert.equal(assistantEvents.length, 1);
  assert.equal(assistantEvents[0]?.toolCalls.length, 1);
  assert.equal(assistantEvents[0]?.toolCalls[0]?.id, 'call_eng_1');
  const toolResults = messagesOfType(messages, 'agent:tool_result');
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0]?.toolCallId, 'call_eng_1');
  assert.equal(toolResults[0]?.status, 'failed');
  const complete = messagesOfType(messages, 'agent:complete');
  assert.equal(complete.length, 1);
  assert.equal(complete[0]?.content, '这个工具不存在，改用文字说明。');
  assert.deepEqual(upstream.requests[0]?.body?.['model'], UPSTREAM_MODEL_NAME);
});

void test('接缝：引擎聚合的 tool_calls 走真实提案与批量决裁路径，未勾选结果回填后继续下一轮', async (t) => {
  const { client, sent, projectPath } = await setupTest(t);
  const upstream = installUpstreamStub([
    [
      toolCallFrame({
        id: 'call_eng_2',
        name: 'crop_image',
        argsJson: '{"asset_id":"asset-a","x":0,"y":0,"width":10,"height":10}',
      }),
      finishFrame('tool_calls'),
      DONE_FRAME,
    ],
    [contentFrame('已跳过。'), finishFrame('stop'), DONE_FRAME],
  ]);
  t.after(() => {
    upstream.restore();
  });

  const pending = executeAgentSubmitPrompt({
    client,
    message: submitMessage({
      requestId: 'request-engine-tool-2',
      projectPath,
      approvalMode: 'confirm',
    }),
  });

  await waitFor(
    () => messagesOfType(sent(), 'agent:tool_call').some((event) => event.status === 'proposed'),
    'proposal frame',
  );
  const decision = AgentClientMessageSchema.parse({
    type: 'agent:tool_decision',
    requestId: 'request-engine-tool-2',
    agentSessionId: 'agent-session-engine',
    decision: 'submit',
    decisions: [{ toolCallId: 'call_eng_2', execute: false }],
  });
  handleAgentMessage(client, decision);
  await pending;

  assert.equal(upstream.requests.length, 2, 'tool loop should call the model a second time after submit');
  assert.deepEqual(messageRolesOfRequest(upstream.requests[1]), ['user', 'assistant', 'tool']);
  const toolMessage = messageAt(upstream.requests[1], 2);
  assert.equal(toolMessage['tool_call_id'], 'call_eng_2');
  assert.match(String(toolMessage['content']), /crop_image/);
  const toolResults = messagesOfType(sent(), 'agent:tool_result');
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0]?.status, 'skipped');
  assert.equal(toolResults[0]?.errorSummary, '未勾选，未执行');
});
