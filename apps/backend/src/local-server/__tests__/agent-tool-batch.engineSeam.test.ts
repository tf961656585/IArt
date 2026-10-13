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
import { __test_only__, executeAgentSubmitPrompt, handleAgentMessage } from '../agent-execution.cts';
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
 * Agent 工具批「并发执行 + 批量勾选审批」接缝测试（spec 04「工具调用循环语义」、spec 05「Confirm 决裁流程」）。
 *
 * 使命：验证**真实**链路「流式引擎聚合一条 assistant 消息的多个 tool_calls → 整批提案（共享批级
 * 截止时间）→ 批量勾选提交 → 执行集合**并发**派发 → 各条目终态按 toolCallId 配对回灌 → 第二轮
 * 模型上下文完整」，且提交未勾选条目按 `skipped` 结算。
 *
 * 与 `agent-tool-loop.engineSeam.test.ts` 同一 bargain：真实引擎 + 真实适配器 + 假 HTTP 上游
 * （本机 http 不可用，故替换 `globalThis.fetch`），不注入假 core。工具执行走真实加工链
 * （项目媒体目录里预置的真实 PNG + 真实 sharp 缩放），因此「并发执行成功」不是桩造出来的。
 *
 * 红→绿自证：本表先在「串行逐条提案 + 逐条决裁」的旧实现上跑红（只提案首条、`submit` 形态不被
 * 受理），再随批量并发编排落地转绿。
 */

const CHAT_MODEL_ID = 'seam-llm';
const CHAT_CONNECTION_BASE_URL = 'https://seam-upstream.example.invalid/v1';
const CHAT_CREDENTIAL = 'sk-seam-upstream-key';
const UPSTREAM_MODEL_NAME = 'upstream-seam-model';

const AGENT_SESSION_ID = 'agent-session-batch-seam';

/** 会话引用资产 id（加工工具按 assetId 引用会话资产清单）。 */
const SOURCE_ASSET_ID = 'asset-seam-source';
const SOURCE_FILE_KEY = 'source/seam.png';
/** 16x16 单色 PNG（真实可解码图像：加工链走真实 sharp，不是桩）。 */
const SOURCE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVR4nGM4oaFBEmIY1aAxGkonhmvSAAB8MxgQxeu24QAAAABJRU5ErkJggg==';

type UpstreamRequest = { url: string; body: Record<string, unknown> | null };

const sseFrame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

const contentFrame = (content: string): string =>
  sseFrame({
    id: 'chatcmpl-seam',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: UPSTREAM_MODEL_NAME,
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
  });

/** 单个 tool_call 分片：同一条 assistant 消息的多个调用必须使用各自的 `index`（适配器按 index 聚合）。 */
const toolCallFrame = (params: {
  index: number;
  id: string;
  name: string;
  argsJson: string;
}): string =>
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
              index: params.index,
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

/** 假 HTTP 上游：按调用序号回放脚本化 SSE 帧，并记录每次请求体。 */
const installUpstreamStub = (scriptedResponses: string[][]): {
  requests: UpstreamRequest[];
  restore: () => void;
} => {
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
      body:
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null,
    });
    const frames =
      scriptedResponses[Math.min(requests.length - 1, scriptedResponses.length - 1)] ?? [];
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

/** 上游请求里 assistant 消息携带的 tool_call id（顺序 = 供应商交付顺序）。 */
const assistantToolCallIdsOf = (request: UpstreamRequest | undefined): string[] => {
  const messages = request?.body?.['messages'];
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message: unknown) => {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) return [];
    const toolCalls: unknown = Reflect.get(message, 'tool_calls');
    if (!Array.isArray(toolCalls)) return [];
    return toolCalls.map((toolCall: unknown) =>
      toolCall !== null && typeof toolCall === 'object'
        ? String(Reflect.get(toolCall, 'id'))
        : '',
    );
  });
};

/** 上游请求里 tool 结果消息的（toolCallId → 内容）配对。 */
const toolMessagesOf = (
  request: UpstreamRequest | undefined,
): Array<{ toolCallId: string; content: string }> => {
  const messages = request?.body?.['messages'];
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message: unknown) => {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) return [];
    const record: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(message)) record[key] = value;
    if (record['role'] !== 'tool') return [];
    return [
      {
        toolCallId: String(record['tool_call_id'] ?? ''),
        content: typeof record['content'] === 'string' ? record['content'] : '',
      },
    ];
  });
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

/**
 * 建立「已打开项目」并预置一张真实 PNG（加工工具的源媒体在项目媒体目录里，
 * 经 `local-media://<projectRef>/<fileKey>` 解析回该文件——与生产路径同一张作用域表）。
 */
const createOpenedProject = (projectName: string) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-batch-seam-'));
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
  const sourceFilePath = path.join(projectPath, 'media', SOURCE_FILE_KEY);
  fs.mkdirSync(path.dirname(sourceFilePath), { recursive: true });
  fs.writeFileSync(sourceFilePath, Buffer.from(SOURCE_PNG_BASE64, 'base64'));
  const stableProjectId = `spid_${crypto.randomBytes(12).toString('hex')}`;
  const projectRef = `prj_${crypto.randomBytes(16).toString('hex').slice(0, 32)}`;
  const synced = syncProjectScope({ stableProjectId, projectPath, projectRef });
  assert.ok(synced, 'project scope should be registered');
  return {
    projectPath,
    projectRef,
    sourceMediaUrl: `local-media://${projectRef}/${SOURCE_FILE_KEY}`,
    close: (): void => {
      removeProjectScope(stableProjectId);
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
};

const seedChatModel = async (): Promise<void> => {
  const connection = createConnection({
    display_name: 'seam-upstream',
    base_url: CHAT_CONNECTION_BASE_URL,
  });
  const credential = await setCredentialForConnection(connection.connection_id, CHAT_CREDENTIAL);
  assert.ok(credential, 'credential should be written');
  setConnectionCredential(connection.connection_id, credential.credentialRef, credential.version, true);
  // 写侧兼容判定是显式两态（生成模型自建声明试点 §3.5）：声明必须先于部署，否则对话模型
  // 解析不出族、接入被拒——不再按「任意 model_id 可建死记录」的旧行为播种。
  // 单记录口径：能力属性与接入归属一体（spec 03 §6.1），不再经 ModelDeployment 接入。
  const record = addCustomChatModel({
    model_id: CHAT_MODEL_ID,
    connection_id: connection.connection_id,
    protocol_adapter_id: 'openai-chat-completions-v1',
    remote_model_id: UPSTREAM_MODEL_NAME,
  });
  assert.equal(
    record.ok,
    true,
    'custom chat model record should be created',
  );
  const activated = setActiveDeployment(CHAT_MODEL_ID, record.model.record_id);
  assert.equal(activated, record.model.record_id, 'active route should point at the seeded record');
};

const setupTest = async (t: TestContext) => {
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  const previousPackagesDir = process.env['IART_MODEL_ASSET_PACKAGES_DIR'];
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-batch-seam-storage-'));
  // 空包目录：本表只用内置加工工具（与模型能力包目录无关）。
  const emptyPackagesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-batch-seam-packages-'));
  process.env['IART_STORAGE_ROOT'] = storageRoot;
  process.env['IART_MODEL_ASSET_PACKAGES_DIR'] = emptyPackagesDir;
  const clearCaches = (): void => {
    clearConnectionCache();
    clearDeploymentCache();
    clearActiveRouteCache();
    clearCustomModelCache();
  };
  clearCaches();
  const project = createOpenedProject('demo-agent-batch');
  const harness = createHarness();
  setBackendIpcTestHandler(async (message) => {
    if (message.type === 'runtime:read-agent-messages') {
      return {
        type: 'runtime:transaction-result',
        transactionId: message.transactionId,
        success: true,
        data: [],
      };
    }
    // 加工产物资产持久化与任务事件走真实 Backend 写入链；接缝之外只挡 Main 侧落库。
    if (
      message.type === 'runtime:execute-transaction' ||
      message.type === 'runtime:write-task-event'
    ) {
      return {
        type: 'runtime:transaction-result',
        transactionId: message.transactionId,
        success: true,
        data: null,
      };
    }
    throw new Error(`unexpected IPC message type: ${message.type}`);
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
  return {
    ...harness,
    projectPath: project.projectPath,
    sourceMediaUrl: project.sourceMediaUrl,
  };
};

const submitMessage = (overrides: {
  requestId: string;
  projectPath: string;
  sourceMediaUrl: string;
  approvalMode: 'confirm' | 'yolo';
  agentSessionId?: string;
}): AgentSubmitPrompt => ({
  type: 'agent:submit_prompt',
  requestId: overrides.requestId,
  agentSessionId: overrides.agentSessionId ?? AGENT_SESSION_ID,
  projectPath: overrides.projectPath,
  modelId: CHAT_MODEL_ID,
  thinkingTier: 'off',
  approvalMode: overrides.approvalMode,
  content: '帮我把这张图处理一下',
  referenceAssetIds: [SOURCE_ASSET_ID],
  referenceAssets: [
    {
      assetId: SOURCE_ASSET_ID,
      mediaType: 'image',
      url: overrides.sourceMediaUrl,
      width: 16,
      height: 16,
      durationMs: null,
      summary: 'seam.png',
    },
  ],
});

const resizeArgs = (percent: number): string =>
  JSON.stringify({ asset_id: SOURCE_ASSET_ID, percent });

/** 一条 assistant 消息携带 3 条加工工具调用的上游脚本（index 0/1/2 各自成片）。 */
const threeToolCallRound = (): string[] => [
  toolCallFrame({ index: 0, id: 'call-batch-1', name: 'resize_image', argsJson: resizeArgs(50) }),
  toolCallFrame({ index: 1, id: 'call-batch-2', name: 'resize_image', argsJson: resizeArgs(25) }),
  toolCallFrame({
    index: 2,
    id: 'call-batch-3',
    name: 'crop_image',
    argsJson: JSON.stringify({ asset_id: SOURCE_ASSET_ID, x: 0, y: 0, width: 8, height: 8 }),
  }),
  finishFrame('tool_calls'),
  DONE_FRAME,
];

const submitDecision = (params: {
  requestId: string;
  agentSessionId?: string;
  decisions: Array<{ toolCallId: string; execute: boolean }>;
}) =>
  AgentClientMessageSchema.parse({
    type: 'agent:tool_decision',
    requestId: params.requestId,
    agentSessionId: params.agentSessionId ?? AGENT_SESSION_ID,
    decision: 'submit',
    decisions: params.decisions,
  });

void test('接缝：整批提案（同批级截止）→ 勾选提交 → 执行集合并发派发成功、未勾选按 skipped 结算、结果按 toolCallId 配对回灌', async (t) => {
  const { client, sent, projectPath, sourceMediaUrl } = await setupTest(t);
  const agentSessionId = 'agent-session-batch-1';
  const upstream = installUpstreamStub([
    threeToolCallRound(),
    [contentFrame('两张缩略图已生成，第三张按你的意思不执行。'), finishFrame('stop'), DONE_FRAME],
  ]);
  t.after(() => {
    upstream.restore();
  });

  const pending = executeAgentSubmitPrompt({
    client,
    message: submitMessage({
      requestId: 'request-batch-1',
      projectPath,
      sourceMediaUrl,
      approvalMode: 'confirm',
      agentSessionId,
    }),
  });

  await waitFor(
    () => messagesOfType(sent(), 'agent:tool_call').length >= 1,
    'first proposal frame',
  );

  // ── 批提案：整批一次送达，共享同一批级截止时间（串行实现下只有首条被提案）──
  const proposalEvents = messagesOfType(sent(), 'agent:tool_call');
  assert.deepEqual(
    proposalEvents.map((event) => [event.toolCallId, event.status]),
    [
      ['call-batch-1', 'proposed'],
      ['call-batch-2', 'proposed'],
      ['call-batch-3', 'proposed'],
    ],
    'the whole batch must be proposed up front',
  );
  const expiresAt = proposalEvents.map((event) => event.proposalExpiresAt);
  assert.ok((expiresAt[0] ?? 0) > Date.now() - 1_000, 'confirm proposal carries a deadline');
  assert.deepEqual(expiresAt, [expiresAt[0], expiresAt[0], expiresAt[0]], 'batch shares one deadline');

  // ── 批量勾选提交：勾选前两条、不勾选第三条 ──
  handleAgentMessage(
    client,
    submitDecision({
      requestId: 'request-batch-1',
      agentSessionId,
      decisions: [
        { toolCallId: 'call-batch-1', execute: true },
        { toolCallId: 'call-batch-2', execute: true },
        { toolCallId: 'call-batch-3', execute: false },
      ],
    }),
  );
  await pending;

  // ── 并发派发：两条被勾选条目都在任一终态前进入 dispatching（串行实现下逐条串行）──
  const eventOrder = sent().flatMap((message, index) =>
    message.type === 'agent:tool_call' || message.type === 'agent:tool_result'
      ? [[index, message.type, message.toolCallId, message.status] as const]
      : [],
  );
  const dispatchedIds = eventOrder
    .filter(([, type, , status]) => type === 'agent:tool_call' && status === 'dispatching')
    .map(([, , toolCallId]) => toolCallId);
  assert.deepEqual(
    [...dispatchedIds].sort(),
    ['call-batch-1', 'call-batch-2'],
    'both checked entries must be dispatched',
  );
  // 比较的是**出站事件序号**（eventOrder 里存的是 sent() 位置，不是 eventOrder 下标）。
  const firstTerminalIndex = eventOrder.find(([, type]) => type === 'agent:tool_result')?.[0] ?? -1;
  const dispatchIndexes = eventOrder
    .filter(([, type, , status]) => type === 'agent:tool_call' && status === 'dispatching')
    .map(([index]) => index);
  assert.ok(
    firstTerminalIndex >= 0 && dispatchIndexes.every((index) => index < firstTerminalIndex),
    'both entries must be in flight before the first terminal event (concurrent dispatch)',
  );

  // ── 终态结算：勾选两条并发执行成功、未勾选一条 skipped ──
  const resultEvents = messagesOfType(sent(), 'agent:tool_result');
  assert.deepEqual(
    [...resultEvents].sort((a, b) => a.toolCallId.localeCompare(b.toolCallId)).map((event) => [
      event.toolCallId,
      event.status,
    ]),
    [
      ['call-batch-1', 'succeeded'],
      ['call-batch-2', 'succeeded'],
      ['call-batch-3', 'skipped'],
    ],
  );
  const unchecked = resultEvents.find((event) => event.toolCallId === 'call-batch-3');
  assert.equal(unchecked?.errorSummary, '未勾选，未执行');

  // ── 第二轮模型上下文：assistant 一条消息携带整批 tool_calls，tool 结果逐条配对 ──
  assert.equal(upstream.requests.length, 2, 'tool loop should call the model a second time');
  const secondRound = upstream.requests[1];
  assert.deepEqual(
    assistantToolCallIdsOf(secondRound),
    ['call-batch-1', 'call-batch-2', 'call-batch-3'],
    'assistant message must carry the whole batch',
  );
  const toolMessages = toolMessagesOf(secondRound);
  assert.deepEqual(
    [...toolMessages.map((message) => message.toolCallId)].sort(),
    ['call-batch-1', 'call-batch-2', 'call-batch-3'],
    'each tool_call must have exactly one paired tool result',
  );
  const paired = new Map(toolMessages.map((message) => [message.toolCallId, message.content]));
  assert.match(String(paired.get('call-batch-1')), /resize_image 执行成功/);
  assert.match(String(paired.get('call-batch-2')), /resize_image 执行成功/);
  assert.match(String(paired.get('call-batch-3')), /未执行/);

  // 待决登记清空：批级结算后无残留等待器。
  assert.deepEqual(__test_only__.getPendingToolDecisionIdsForTests(), []);

  const complete = messagesOfType(sent(), 'agent:complete');
  assert.equal(complete.length, 1);
  assert.equal(complete[0]?.content, '两张缩略图已生成，第三张按你的意思不执行。');
  assert.equal(messagesOfType(sent(), 'agent:error').length, 0);
});

void test('接缝：整轮驳回一次结算整批未决条目（不派发任何条目，逐条回灌 skipped）', async (t) => {
  const { client, sent, projectPath, sourceMediaUrl } = await setupTest(t);
  const agentSessionId = 'agent-session-batch-2';
  const upstream = installUpstreamStub([
    threeToolCallRound(),
    [contentFrame('这批都按你的意思不执行。'), finishFrame('stop'), DONE_FRAME],
  ]);
  t.after(() => {
    upstream.restore();
  });

  const pending = executeAgentSubmitPrompt({
    client,
    message: submitMessage({
      requestId: 'request-batch-2',
      projectPath,
      sourceMediaUrl,
      approvalMode: 'confirm',
      agentSessionId,
    }),
  });
  await waitFor(
    () => messagesOfType(sent(), 'agent:tool_call').length >= 1,
    'first proposal frame',
  );

  const decision = AgentClientMessageSchema.parse({
    type: 'agent:tool_decision',
    requestId: 'request-batch-2',
    agentSessionId,
    decision: 'reject_round',
  });
  handleAgentMessage(client, decision);
  await pending;

  // 整批一次结算：三条都 skipped、来源标注整轮驳回，且没有任何条目被派发。
  const resultEvents = messagesOfType(sent(), 'agent:tool_result');
  assert.deepEqual(
    resultEvents.map((event) => [event.toolCallId, event.status, event.errorSummary]),
    [
      ['call-batch-1', 'skipped', '已整轮驳回，未执行'],
      ['call-batch-2', 'skipped', '已整轮驳回，未执行'],
      ['call-batch-3', 'skipped', '已整轮驳回，未执行'],
    ],
  );
  assert.deepEqual(
    messagesOfType(sent(), 'agent:tool_call').map((event) => event.status),
    ['proposed', 'proposed', 'proposed'],
    'round rejection must not dispatch any entry',
  );

  const secondRound = upstream.requests[1];
  assert.deepEqual(
    [...toolMessagesOf(secondRound).map((message) => message.toolCallId)].sort(),
    ['call-batch-1', 'call-batch-2', 'call-batch-3'],
    'rejected batch must be paired back into the next model call',
  );
  assert.deepEqual(__test_only__.getPendingToolDecisionIdsForTests(), []);
  assert.equal(messagesOfType(sent(), 'agent:complete').length, 1);
  assert.equal(messagesOfType(sent(), 'agent:error').length, 0);
});
