import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentMessageRecord } from '@iart/contracts';
import { setBackendIpcTestHandler } from '../backend-ipc-sender.cts';
import {
  __test_only__,
  executeAgentSubmitPrompt,
  handleAgentMessage,
} from '../agent-execution.cts';
import {
  AGENT_SESSION_ID,
  assistantResult,
  chatRecord,
  createDeferred,
  createOpenedProject,
  flushAsync,
  installCore,
  installHistoryReader,
  messagesOfType,
  setupTest,
  submitMessage,
  waitFor,
} from './agent-execution-test-helpers';

/**
 * agent 执行编排（spec docs/agent/04）。
 *
 * 共享替身（假底座、项目作用域、历史读取、事件断言）见 `agent-execution-test-helpers.ts`；
 * 本表覆盖会话发送主链：受理、历史投影、失败收口、取消与并发约束。
 * 工具调用循环的审批裁定与整轮驳回见 `agent-tool-loop.test.ts`。
 */

void test('受理 → accepted → token* → complete：事件顺序与载荷', async (t) => {
  const { client, sent, projectPath } = setupTest(t);
  const readRequests = installHistoryReader({
    records: [
      chatRecord({ seq: 1, role: 'user', content: 'first prompt', requestId: 'request-old-1' }),
      chatRecord({ seq: 2, role: 'assistant', content: 'first answer', requestId: 'request-old-1' }),
    ],
  });
  const calls = installCore(async (params) => {
    params.onToken('Hel');
    params.onToken('lo');
    return assistantResult('Hello');
  });

  await executeAgentSubmitPrompt({
    client,
    message: submitMessage({
      requestId: 'request-new-1',
      projectPath,
      content: 'second prompt',
      thinkingTier: 'high',
    }),
  });

  const messages = sent();
  assert.deepEqual(
    messages.map((message) => message.type),
    ['agent:accepted', 'agent:token', 'agent:token', 'agent:complete'],
  );

  const accepted = messagesOfType(messages, 'agent:accepted')[0];
  assert.ok(accepted);
  assert.equal(accepted.requestId, 'request-new-1');
  assert.equal(accepted.agentSessionId, AGENT_SESSION_ID);

  const tokens = messagesOfType(messages, 'agent:token');
  assert.deepEqual(tokens.map((token) => token.delta), ['Hel', 'lo']);
  assert.deepEqual(
    tokens.map((token) => token.requestId),
    ['request-new-1', 'request-new-1'],
  );

  const complete = messagesOfType(messages, 'agent:complete')[0];
  assert.ok(complete);
  assert.equal(complete.content, 'Hello');
  assert.equal(complete.agentSessionId, AGENT_SESSION_ID);

  // 历史读取作用域 = payload 的 projectPath（不是"当前唯一已打开项目"）
  assert.deepEqual(readRequests, [
    { projectPath, agentSessionId: AGENT_SESSION_ID },
  ]);

  const coreCall = calls[0];
  assert.ok(coreCall);
  assert.equal(coreCall.traceScope, 'session');
  assert.equal(coreCall.modelId, 'gpt-5-chat');
  assert.equal(coreCall.sessionId, AGENT_SESSION_ID);
  assert.equal(coreCall.requestId, 'request-new-1');
  assert.equal(coreCall.thinkingTier, 'high');
  assert.equal(coreCall.systemPromptText, undefined);
  // 历史消息 + 本轮用户消息（按 seq 升序投影）
  assert.deepEqual(
    coreCall.messages.map((message) => [message.role, message.content]),
    [
      ['user', 'first prompt'],
      ['assistant', 'first answer'],
      ['user', 'second prompt'],
    ],
  );
  assert.equal(__test_only__.getInFlightRequestIdForTests(AGENT_SESSION_ID), null);
});

void test('历史投影：工具体投影为 assistant toolCalls / tool 消息，本轮 requestId 记录跳过', async (t) => {
  const { client, projectPath } = setupTest(t);
  installHistoryReader({
    records: [
      chatRecord({ seq: 1, role: 'user', content: 'kept question' }),
      {
        agentSessionId: AGENT_SESSION_ID,
        seq: 2,
        role: 'assistant',
        requestId: 'request-old-tool',
        body: {
          kind: 'tool_call',
          toolCallId: 'tool-call-1',
          toolName: 'generate_image',
          toolKind: 'generation',
          modelId: 'gpt-image-2',
          argsJson: '{"prompt":"一只猫"}',
        },
        plan: null,
        createdAt: 1_700_000_000_002,
        isPartial: false,
      },
      {
        agentSessionId: AGENT_SESSION_ID,
        seq: 3,
        role: 'system',
        requestId: 'request-old-tool',
        body: {
          kind: 'tool_result',
          toolCallId: 'tool-call-1',
          toolName: 'generate_image',
          status: 'succeeded',
          summary: '已生成 1 张图片',
          assetIds: ['asset-2'],
          errorSummary: null,
        },
        plan: null,
        createdAt: 1_700_000_000_003,
        isPartial: false,
      },
      chatRecord({
        seq: 4,
        role: 'user',
        content: 'already persisted current turn',
        requestId: 'request-new-2',
      }),
    ],
  });
  const calls = installCore(async () => assistantResult('ok'));

  await executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-new-2', projectPath, content: 'current turn' }),
  });

  const coreCall = calls[0];
  assert.ok(coreCall);
  // 工具体跨轮可见：tool_call → assistant toolCalls，tool_result → tool 消息（产物 assetId 列出）。
  assert.deepEqual(
    coreCall.messages.map((message) => message.role),
    ['user', 'assistant', 'tool', 'user'],
  );
  const assistantToolMessage = coreCall.messages[1];
  assert.ok(
    assistantToolMessage && 'toolCalls' in assistantToolMessage
      ? assistantToolMessage.toolCalls
      : undefined,
  );
  const toolResultMessage = coreCall.messages[2];
  assert.ok(
    toolResultMessage && toolResultMessage.role === 'tool' && 'toolCallId' in toolResultMessage,
  );
  assert.equal(toolResultMessage.toolCallId, 'tool-call-1');
  assert.match(String(toolResultMessage.content), /asset-2/);
  // 属于本轮 requestId 的记录不进上下文（避免与本轮追加重复）。
  assert.deepEqual(
    coreCall.messages.map((message) => message.content).map((content) => (typeof content === 'string' ? content : content.find((part) => part.type === 'text')?.text ?? '')),
    ['kept question', '', '工具 generate_image succeeded；已生成 1 张图片；产物 assetId: asset-2', 'current turn'],
  );
});

/** 工具调用记录（正式历史里的 `tool_call` 消息体）。 */
const toolCallRecord = (params: {
  seq: number;
  toolCallId: string;
  toolName?: string;
}): AgentMessageRecord => ({
  agentSessionId: AGENT_SESSION_ID,
  seq: params.seq,
  role: 'assistant',
  requestId: 'request-old-batch',
  body: {
    kind: 'tool_call',
    toolCallId: params.toolCallId,
    toolName: params.toolName ?? 'generate_image',
    toolKind: 'generation',
    modelId: 'gpt-image-2',
    argsJson: '{"prompt":"一只猫"}',
  },
  plan: null,
  createdAt: 1_700_000_000_000 + params.seq,
  isPartial: false,
});

/** 工具结果记录（正式历史里的 `tool_result` 消息体）。 */
const toolResultRecord = (params: { seq: number; toolCallId: string }): AgentMessageRecord => ({
  agentSessionId: AGENT_SESSION_ID,
  seq: params.seq,
  role: 'system',
  requestId: 'request-old-batch',
  body: {
    kind: 'tool_result',
    toolCallId: params.toolCallId,
    toolName: 'generate_image',
    status: 'succeeded',
    summary: '已生成 1 张图片',
    assetIds: [`asset-${params.toolCallId}`],
    errorSummary: null,
  },
  plan: null,
  createdAt: 1_700_000_000_000 + params.seq,
  isPartial: false,
});

void test('历史投影：同批连续 tool_call 记录合并为一条 assistant 消息，结果按 toolCallId 与本批配对', async (t) => {
  const { client, projectPath } = setupTest(t);
  installHistoryReader({
    records: [
      chatRecord({ seq: 1, role: 'user', content: 'kept question' }),
      toolCallRecord({ seq: 2, toolCallId: 'call-h1' }),
      toolCallRecord({ seq: 3, toolCallId: 'call-h2' }),
      toolCallRecord({ seq: 4, toolCallId: 'call-h3' }),
      // 并发执行：结果记录按完成序落库（与提案顺序不一致）。
      toolResultRecord({ seq: 5, toolCallId: 'call-h2' }),
      toolResultRecord({ seq: 6, toolCallId: 'call-h1' }),
      toolResultRecord({ seq: 7, toolCallId: 'call-h3' }),
    ],
  });
  const calls = installCore(async () => assistantResult('ok'));

  await executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-new-batch', projectPath, content: 'current turn' }),
  });

  const coreCall = calls[0];
  assert.ok(coreCall);
  // 末条为本轮追加的 user 消息（当前 turn），历史投影只贡献其前的部分。
  assert.deepEqual(
    coreCall.messages.map((message) => message.role),
    ['user', 'assistant', 'tool', 'tool', 'tool', 'user'],
  );
  const assistantMessage = coreCall.messages[1];
  const toolCalls =
    assistantMessage && 'toolCalls' in assistantMessage ? assistantMessage.toolCalls : undefined;
  assert.deepEqual(
    toolCalls?.map((toolCall) => toolCall.id),
    ['call-h1', 'call-h2', 'call-h3'],
    'one assistant message must carry the whole batch',
  );
  const projectedToolResultIds = coreCall.messages.flatMap((message) =>
    message.role === 'tool' ? [message.toolCallId] : [],
  );
  assert.deepEqual(
    projectedToolResultIds,
    ['call-h2', 'call-h1', 'call-h3'],
    'tool results keep record (completion) order and pair by toolCallId',
  );
  assert.deepEqual(
    [...projectedToolResultIds].sort(),
    ['call-h1', 'call-h2', 'call-h3'],
    'every tool_call has a paired result',
  );
});

void test('历史投影：中断残留的孤儿记录被丢弃（无结果的调用 / 无调用的结果 / 同 id 重复结果）', async (t) => {
  const { client, projectPath } = setupTest(t);
  installHistoryReader({
    records: [
      chatRecord({ seq: 1, role: 'user', content: 'kept question' }),
      // 中断残留：此调用没有结果记录——留在上下文里会让下一次模型调用整体报错。
      toolCallRecord({ seq: 2, toolCallId: 'call-orphan-call' }),
      toolCallRecord({ seq: 3, toolCallId: 'call-paired' }),
      toolResultRecord({ seq: 4, toolCallId: 'call-paired' }),
      // 同 id 重复结果与无调用的结果：都不得产出第二条 tool 消息。
      toolResultRecord({ seq: 5, toolCallId: 'call-paired' }),
      toolResultRecord({ seq: 6, toolCallId: 'call-orphan-result' }),
    ],
  });
  const calls = installCore(async () => assistantResult('ok'));

  await executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-new-orphans', projectPath, content: 'current turn' }),
  });

  const coreCall = calls[0];
  assert.ok(coreCall);
  assert.deepEqual(
    coreCall.messages.map((message) => message.role),
    ['user', 'assistant', 'tool', 'user'],
  );
  const assistantMessage = coreCall.messages[1];
  const toolCalls =
    assistantMessage && 'toolCalls' in assistantMessage ? assistantMessage.toolCalls : undefined;
  assert.deepEqual(toolCalls?.map((toolCall) => toolCall.id), ['call-paired']);
  const toolMessage = coreCall.messages[2];
  assert.equal(toolMessage?.role === 'tool' ? toolMessage.toolCallId : '', 'call-paired');
});

void test('历史读取失败：以 agent:error 收口，不静默当空历史', async (t) => {
  const { client, sent, projectPath } = setupTest(t);
  installHistoryReader({ failWith: 'storage unavailable' });
  const calls = installCore(async () => assistantResult('never'));

  await executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-history-failure', projectPath }),
  });

  assert.equal(calls.length, 0);
  const messages = sent();
  assert.deepEqual(messages.map((message) => message.type), ['agent:error']);
  const error = messagesOfType(messages, 'agent:error')[0];
  assert.ok(error);
  assert.equal(error.code, 'execution_failed');
  assert.equal(error.partialContent, null);
  assert.match(error.message, /storage unavailable/);
  assert.equal(__test_only__.getInFlightRequestIdForTests(AGENT_SESSION_ID), null);
});

void test('历史数据不合法：以 agent:error 收口', async (t) => {
  const { client, sent, projectPath } = setupTest(t);
  installHistoryReader({ invalidData: { messages: [] } });
  const calls = installCore(async () => assistantResult('never'));

  await executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-history-invalid', projectPath }),
  });

  assert.equal(calls.length, 0);
  const messages = sent();
  assert.deepEqual(messages.map((message) => message.type), ['agent:error']);
  const error = messagesOfType(messages, 'agent:error')[0];
  assert.ok(error);
  assert.equal(error.code, 'execution_failed');
  assert.match(error.message, /invalid/);
});

void test('模型配置解析前失败：code=model_unavailable', async (t) => {
  const { client, sent, projectPath } = setupTest(t);
  installHistoryReader({ records: [] });
  installCore(async () => {
    // 未调用 onModelConfigResolved = 模型 / 部署 / 凭证解析阶段失败
    throw new Error('chat model has no usable active deployment: gpt-5-chat');
  });

  await executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-model-missing', projectPath }),
  });

  const messages = sent();
  assert.deepEqual(messages.map((message) => message.type), ['agent:accepted', 'agent:error']);
  const error = messagesOfType(messages, 'agent:error')[0];
  assert.ok(error);
  assert.equal(error.code, 'model_unavailable');
  assert.equal(error.partialContent, null);
  assert.match(error.message, /no usable active deployment/);
});

void test('执行中失败：code=execution_failed 并携带 partialContent', async (t) => {
  const { client, sent, projectPath } = setupTest(t);
  installHistoryReader({ records: [] });
  installCore(async (params) => {
    params.onModelConfigResolved?.();
    params.onToken('partial answer');
    throw new Error('stream broke');
  });

  await executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-stream-broken', projectPath }),
  });

  const messages = sent();
  assert.deepEqual(
    messages.map((message) => message.type),
    ['agent:accepted', 'agent:token', 'agent:error'],
  );
  const error = messagesOfType(messages, 'agent:error')[0];
  assert.ok(error);
  assert.equal(error.code, 'execution_failed');
  assert.equal(error.partialContent, 'partial answer');
});

void test('agent:cancel：abort 在途请求，以 cancelled 收口并清理在途映射', async (t) => {
  const { client, sent, projectPath } = setupTest(t);
  installHistoryReader({ records: [] });
  const calls = installCore(async (params) => {
    params.onModelConfigResolved?.();
    params.onToken('snip');
    await new Promise<void>((_resolve, reject) => {
      params.abortSignal.addEventListener('abort', () => {
        reject(new Error('aborted by client'));
      });
    });
    throw new Error('core resolved after abort is not expected');
  });

  const pending = executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-cancel-1', projectPath }),
  });
  await waitFor(() => calls.length === 1, 'core execution started');

  handleAgentMessage(client, {
    type: 'agent:cancel',
    agentSessionId: AGENT_SESSION_ID,
    requestId: 'request-cancel-1',
  });
  await pending;

  const messages = sent();
  assert.deepEqual(
    messages.map((message) => message.type),
    ['agent:accepted', 'agent:token', 'agent:error'],
  );
  const error = messagesOfType(messages, 'agent:error')[0];
  assert.ok(error);
  assert.equal(error.code, 'cancelled');
  assert.equal(error.partialContent, 'snip');
  assert.equal(__test_only__.getInFlightRequestIdForTests(AGENT_SESSION_ID), null);
});

void test('agent:cancel 落在受理前（历史读取中）：不发 accepted，直接以 cancelled 收口', async (t) => {
  const { client, sent, projectPath } = setupTest(t);
  const readStarted = createDeferred();
  const readGate = createDeferred();
  setBackendIpcTestHandler(async (message) => {
    assert.equal(message.type, 'runtime:read-agent-messages');
    readStarted.resolve();
    await readGate.promise;
    return {
      type: 'runtime:transaction-result',
      transactionId: message.transactionId,
      success: true,
      data: [],
    };
  });
  const calls = installCore(async () => assistantResult('should not run'));

  const pending = executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-cancel-early', projectPath }),
  });
  await readStarted.promise;
  handleAgentMessage(client, {
    type: 'agent:cancel',
    agentSessionId: AGENT_SESSION_ID,
    requestId: 'request-cancel-early',
  });
  readGate.resolve();
  await pending;

  assert.equal(calls.length, 0);
  const messages = sent();
  assert.deepEqual(messages.map((message) => message.type), ['agent:error']);
  const error = messagesOfType(messages, 'agent:error')[0];
  assert.ok(error);
  assert.equal(error.code, 'cancelled');
  assert.equal(error.partialContent, null);
  assert.equal(__test_only__.getInFlightRequestIdForTests(AGENT_SESSION_ID), null);
});

void test('agent:cancel：无在途请求时不打断、不发事件', async (t) => {
  const { client, sent, projectPath } = setupTest(t);
  installHistoryReader({ records: [] });
  const calls = installCore(async (params) => {
    params.onModelConfigResolved?.();
    return assistantResult('done');
  });

  await executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-done-1', projectPath }),
  });
  assert.equal(calls.length, 1);
  const beforeCancel = sent().length;

  handleAgentMessage(client, {
    type: 'agent:cancel',
    agentSessionId: AGENT_SESSION_ID,
    requestId: 'request-done-1',
  });
  handleAgentMessage(client, {
    type: 'agent:cancel',
    agentSessionId: 'agent-session-unknown',
    requestId: 'request-done-1',
  });
  await flushAsync();

  assert.equal(sent().length, beforeCancel);
});

void test('并发约束：同一会话在途时重复提交按 invalid_request 拒绝，不同会话互不影响', async (t) => {
  const { client, sent, projectPath } = setupTest(t);
  installHistoryReader({ records: [] });
  const firstGate = createDeferred();
  const calls = installCore(async (params) => {
    if (params.requestId === 'request-concurrent-1') {
      await firstGate.promise;
    }
    return assistantResult('done');
  });

  const first = executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-concurrent-1', projectPath }),
  });
  await waitFor(() => calls.length === 1, 'first request in flight');
  assert.equal(__test_only__.getInFlightRequestIdForTests(AGENT_SESSION_ID), 'request-concurrent-1');

  await executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-concurrent-2', projectPath }),
  });

  const rejected = messagesOfType(sent(), 'agent:error')[0];
  assert.ok(rejected);
  assert.equal(rejected.code, 'invalid_request');
  assert.equal(rejected.requestId, 'request-concurrent-2');
  assert.equal(calls.length, 1);

  // 不同会话可并发
  await executeAgentSubmitPrompt({
    client,
    message: submitMessage({
      requestId: 'request-other-session',
      projectPath,
      agentSessionId: 'agent-session-2',
    }),
  });
  assert.ok(
    messagesOfType(sent(), 'agent:complete').some(
      (message) => message.agentSessionId === 'agent-session-2',
    ),
  );

  firstGate.resolve();
  await first;

  const completed = messagesOfType(sent(), 'agent:complete');
  assert.ok(completed.some((message) => message.requestId === 'request-concurrent-1'));
  assert.equal(__test_only__.getInFlightRequestIdForTests(AGENT_SESSION_ID), null);
  assert.equal(__test_only__.getInFlightRequestIdForTests('agent-session-2'), null);
});

void test('作用域：多项目打开时读取作用域仍是 payload 传入的那个 projectPath', async (t) => {
  const { client } = setupTest(t);
  const other = createOpenedProject('demo-agent-other');
  t.after(() => {
    other.close();
  });
  const readRequests = installHistoryReader({ records: [] });
  installCore(async () => assistantResult('ok'));

  await executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-two-projects', projectPath: other.projectPath }),
  });

  assert.equal(readRequests.length, 1);
  assert.equal(readRequests[0]?.projectPath, other.projectPath);
  assert.equal(readRequests[0]?.agentSessionId, AGENT_SESSION_ID);
});

void test('作用域：projectPath 未打开时按 invalid_request 拒绝，不读库', async (t) => {
  const { client, sent, projectPath } = setupTest(t);
  const readRequests = installHistoryReader({ records: [] });
  const calls = installCore(async () => assistantResult('never'));
  const notOpenedPath = `${projectPath}-not-opened`;

  await executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-closed-project', projectPath: notOpenedPath }),
  });

  assert.deepEqual(readRequests, []);
  assert.equal(calls.length, 0);
  const messages = sent();
  assert.deepEqual(messages.map((message) => message.type), ['agent:error']);
  const error = messagesOfType(messages, 'agent:error')[0];
  assert.ok(error);
  assert.equal(error.code, 'invalid_request');
  assert.match(error.message, /not an open project/);
  assert.equal(error.partialContent, null);
  assert.equal(__test_only__.getInFlightRequestIdForTests(AGENT_SESSION_ID), null);
});

void test('解析失败与未知类型：尽力回执 invalid_request，无归属信息时只留日志', async (t) => {
  const { client, sent } = setupTest(t);

  // 缺必填字段（projectPath），但能提到 requestId / agentSessionId
  handleAgentMessage(client, {
    type: 'agent:submit_prompt',
    requestId: 'request-invalid-1',
    agentSessionId: AGENT_SESSION_ID,
  });
  await flushAsync();
  let messages = sent();
  assert.equal(messages.length, 1);
  const invalid = messagesOfType(messages, 'agent:error')[0];
  assert.ok(invalid);
  assert.equal(invalid.code, 'invalid_request');
  assert.equal(invalid.requestId, 'request-invalid-1');
  assert.equal(invalid.agentSessionId, AGENT_SESSION_ID);
  assert.equal(invalid.partialContent, null);

  // 未知类型（未来契约新增但本模块未接线）
  handleAgentMessage(client, {
    type: 'agent:future_type',
    requestId: 'request-future-1',
    agentSessionId: AGENT_SESSION_ID,
  });
  await flushAsync();
  messages = sent();
  assert.equal(messages.length, 2);
  const futureTypeError = messagesOfType(messages, 'agent:error')[1];
  assert.ok(futureTypeError);
  assert.equal(futureTypeError.code, 'invalid_request');
  assert.equal(futureTypeError.requestId, 'request-future-1');

  // 连 requestId 都提不到：不发事件（无请求可归属）
  handleAgentMessage(client, { type: 'agent:submit_prompt' });
  handleAgentMessage(client, 'not-an-object');
  handleAgentMessage(client, { type: 'agent:cancel', agentSessionId: AGENT_SESSION_ID });
  await flushAsync();
  assert.equal(sent().length, 2);
});

void test('提交校验：空内容、空 projectPath 按 invalid_request 拒绝', async (t) => {
  const { client, sent, projectPath } = setupTest(t);
  const readRequests = installHistoryReader({ records: [] });

  handleAgentMessage(client, submitMessage({ requestId: 'request-empty-content', projectPath, content: '   ' }));
  await flushAsync();
  let messages = sent();
  assert.equal(messages.length, 1);
  const emptyContent = messagesOfType(messages, 'agent:error')[0];
  assert.ok(emptyContent);
  assert.equal(emptyContent.code, 'invalid_request');
  assert.match(emptyContent.message, /content is empty/);

  await executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-empty-project', projectPath: '' }),
  });
  messages = sent();
  assert.equal(messages.length, 2);
  const emptyProjectPath = messagesOfType(messages, 'agent:error')[1];
  assert.ok(emptyProjectPath);
  assert.equal(emptyProjectPath.code, 'invalid_request');
  assert.match(emptyProjectPath.message, /projectPath is required/);

  assert.deepEqual(readRequests, []);
  assert.equal(__test_only__.getInFlightRequestIdForTests(AGENT_SESSION_ID), null);
});

