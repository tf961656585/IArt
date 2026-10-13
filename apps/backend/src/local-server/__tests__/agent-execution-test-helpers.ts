/**
 * agent 执行编排单测的共享替身（`agent-execution.test.ts` 与 `agent-tool-loop.test.ts` 共用）。
 *
 * 底座与 IPC 均被替换为假实现：单测不得发真实请求、不得消耗真实费用。
 * 项目作用域不注入替身：测试经 project-media-scope 真实注册表建立「已打开项目」状态，
 * 保证测的就是生产路径上的作用域裁定逻辑。
 * 出站事件的原始载荷在断言时统一经 `AgentServerMessageSchema` 校验——
 * 顺带钉住"发出去的就是契约形状"（`sendJson` 会吞掉 send 内的异常，故不在 send 里断言）。
 */

import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';

import {
  AgentServerMessageSchema,
  type AgentMessageRecord,
  type AgentServerMessage,
  type AgentSubmitPrompt,
  type InternalMessage,
} from '@iart/contracts';
import type { executeChatCompletionCore } from '../chat-streaming-engine.cts';
import type { BusinessClient } from '../business-actions/common.cts';
import { setBackendIpcTestHandler } from '../backend-ipc-sender.cts';
import { __test_only__ } from '../agent-execution.cts';
import {
  createProjectFolder,
} from '../project-store.cts';
import {
  removeProjectScope,
  syncProjectScope,
} from '../project-media-scope.cts';

export type CoreParams = Parameters<typeof executeChatCompletionCore>[0];
export type CoreResult = Awaited<ReturnType<typeof executeChatCompletionCore>>;

export const AGENT_SESSION_ID = 'agent-session-1';

export const parseServerMessages = (rawPayloads: unknown[]): AgentServerMessage[] =>
  rawPayloads.map((payload, index) => {
    const parsed = AgentServerMessageSchema.safeParse(payload);
    assert.ok(
      parsed.success,
      `sent payload #${index} must satisfy AgentServerMessageSchema: ${JSON.stringify(payload)}`,
    );
    return parsed.data;
  });

export const createHarness = () => {
  const rawPayloads: unknown[] = [];
  const ws = {
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => {
      const raw: unknown = JSON.parse(payload);
      rawPayloads.push(raw);
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
  const sent = (): AgentServerMessage[] => parseServerMessages(rawPayloads);
  return { client, rawPayloads, sent };
};

/**
 * 建立真实的「已打开项目」状态（scope 注册表 + 最小合法项目目录），
 * 与生产注册路径（Main 经 runtime:project-scope-register 同步）同一张表。
 */
export const createOpenedProject = (projectName: string) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-execution-'));
  const created = createProjectFolder(tempDir, projectName);
  if (!created || 'error' in created) {
    throw new Error('project_creation_failed');
  }
  const projectPath = created.projectPath;
  // session 存在性校验要求目录是合法项目（manifest.json 存在）。
  fs.writeFileSync(
    path.join(projectPath, 'manifest.json'),
    JSON.stringify({ version: 1, name: projectName }),
    'utf-8',
  );
  const stableProjectId = `spid_${crypto.randomBytes(12).toString('hex')}`;
  const projectRef = `prj_${crypto.randomBytes(16).toString('hex').slice(0, 32)}`;
  const synced = syncProjectScope({ stableProjectId, projectPath, projectRef });
  assert.ok(synced, 'project scope should be registered');

  const close = (): void => {
    removeProjectScope(stableProjectId);
    fs.rmSync(tempDir, { recursive: true, force: true });
  };
  return { projectPath, close };
};

export const resetHarness = (): void => {
  __test_only__.clearForTests();
  setBackendIpcTestHandler(null);
};

export const setupTest = (t: TestContext) => {
  const harness = createHarness();
  const project = createOpenedProject('demo-agent');
  t.after(() => {
    project.close();
    resetHarness();
  });
  return { ...harness, projectPath: project.projectPath };
};

export const chatRecord = (params: {
  seq: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  requestId?: string | null;
  isPartial?: boolean;
}): AgentMessageRecord => ({
  agentSessionId: AGENT_SESSION_ID,
  seq: params.seq,
  role: params.role,
  requestId: params.requestId ?? null,
  body: { kind: 'chat', content: params.content },
  plan: null,
  createdAt: 1_700_000_000_000 + params.seq,
  isPartial: params.isPartial ?? false,
});

export const submitMessage = (overrides: {
  requestId: string;
  projectPath: string;
  content?: string;
  modelId?: string;
  agentSessionId?: string;
  thinkingTier?: string;
}) => ({
  type: 'agent:submit_prompt' as const,
  requestId: overrides.requestId,
  agentSessionId: overrides.agentSessionId ?? AGENT_SESSION_ID,
  projectPath: overrides.projectPath,
  modelId: overrides.modelId ?? 'gpt-5-chat',
  thinkingTier: overrides.thinkingTier ?? 'off',
  approvalMode: 'confirm' as const,
  content: overrides.content ?? 'hello agent',
  referenceAssetIds: [] as string[],
  referenceAssets: [] as AgentSubmitPrompt['referenceAssets'],
});

export const installCore = (impl: (params: CoreParams) => Promise<CoreResult>): CoreParams[] => {
  const calls: CoreParams[] = [];
  __test_only__.setCoreExecutorForTests(async (params) => {
    // 快照拷贝：工具循环复用同一 messages 数组实例逐轮追加，调用点捕获当轮切片。
    calls.push({ ...params, messages: [...params.messages] });
    return impl(params);
  });
  return calls;
};

export const assistantResult = (content: string): CoreResult => ({
  message: {
    messageId: 'assistant-message-1',
    role: 'assistant',
    content,
    createdAt: 1_700_000_000_999,
  },
  usage: { inputTokens: 7, outputTokens: 3 },
});

/** 中间轮结果：助手消息携带工具调用（工具循环据此推进到提案/执行编排）。 */
export const toolCallResult = (
  content: string,
  toolCalls: Array<{ id: string; name: string; argsJson: string }>,
): CoreResult => ({
  message: {
    messageId: 'assistant-message-tools',
    role: 'assistant',
    content,
    createdAt: 1_700_000_000_998,
    toolCalls,
  },
  usage: { inputTokens: 7, outputTokens: 3 },
});

/** 加工工具的合法参数形状（执行与否由审批裁定决定；本条只关心提案与结算）。 */
export const cropToolCall = (id: string) => ({
  id,
  name: 'crop_image',
  argsJson: `{"asset_id":"asset-${id}","x":0,"y":0,"width":16,"height":16}`,
});

type HistoryOptions = {
  records?: AgentMessageRecord[];
  failWith?: string;
  invalidData?: unknown;
};

export const installHistoryReader = (options: HistoryOptions) => {
  const requests: Array<{ projectPath: string; agentSessionId: string }> = [];
  setBackendIpcTestHandler(async (message) => {
    if (message.type !== 'runtime:read-agent-messages') {
      throw new Error(`unexpected IPC message type: ${message.type}`);
    }
    requests.push({
      projectPath: message.projectPath,
      agentSessionId: message.agentSessionId,
    });
    if (options.failWith !== undefined) {
      return {
        type: 'runtime:transaction-result',
        transactionId: message.transactionId,
        success: false,
        error: options.failWith,
      };
    }
    const data: unknown = options.invalidData !== undefined ? options.invalidData : (options.records ?? []);
    return {
      type: 'runtime:transaction-result',
      transactionId: message.transactionId,
      success: true,
      data,
    };
  });
  return requests;
};

export const messagesOfType = <T extends AgentServerMessage['type']>(
  sent: AgentServerMessage[],
  type: T,
): Array<Extract<AgentServerMessage, { type: T }>> =>
  sent.filter((message): message is Extract<AgentServerMessage, { type: T }> => message.type === type);

export const flushAsync = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
};

export const createDeferred = () => {
  let resolveFn: () => void = () => {
    throw new Error('deferred resolver not initialized');
  };
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: resolveFn };
};

export const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await flushAsync();
  }
  throw new Error(`waitFor timed out: ${label}`);
};

/** 工具调用批次里 assistant 消息携带的 tool_call id（第二轮模型上下文的配对校验）。 */
export const assistantToolCallIds = (messages: ReadonlyArray<InternalMessage>): string[] =>
  messages.flatMap((message) =>
    message.role === 'assistant' && 'toolCalls' in message && message.toolCalls
      ? message.toolCalls.map((toolCall) => toolCall.id)
      : [],
  );

/** 工具调用批次里回填的 tool 结果消息 id（必须与 assistant 的 tool_call 逐条配对）。 */
export const toolResultMessageIds = (messages: ReadonlyArray<InternalMessage>): string[] =>
  messages.flatMap((message) => (message.role === 'tool' ? [message.toolCallId] : []));

/**
 * 决裁上行消息（`agent:tool_decision`，批量形态）：
 * - `submit`：携带本批全部未决条目的执行/不执行映射（完整映射，非增量）；
 * - `reject_round`：整轮驳回，不带 `decisions`。
 */
export const submitDecisionMessage = (params: {
  requestId: string;
  decisions: Array<{ toolCallId: string; execute: boolean }>;
  agentSessionId?: string;
}): { type: 'agent:tool_decision'; requestId: string; agentSessionId: string; decision: 'submit'; decisions: Array<{ toolCallId: string; execute: boolean }> } => ({
  type: 'agent:tool_decision',
  requestId: params.requestId,
  agentSessionId: params.agentSessionId ?? AGENT_SESSION_ID,
  decision: 'submit',
  decisions: params.decisions,
});

/** 整轮驳回决裁上行（本批全部未决条目一次性不执行）。 */
export const rejectRoundDecisionMessage = (params: {
  requestId: string;
  agentSessionId?: string;
}): { type: 'agent:tool_decision'; requestId: string; agentSessionId: string; decision: 'reject_round' } => ({
  type: 'agent:tool_decision',
  requestId: params.requestId,
  agentSessionId: params.agentSessionId ?? AGENT_SESSION_ID,
  decision: 'reject_round',
});
