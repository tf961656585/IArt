import assert from 'node:assert/strict';
import test from 'node:test';

import {
  __test_only__,
  executeAgentSubmitPrompt,
  handleAgentMessage,
} from '../agent-execution.cts';
import {
  AGENT_SESSION_ID,
  assistantResult,
  assistantToolCallIds,
  cropToolCall,
  flushAsync,
  installCore,
  installHistoryReader,
  messagesOfType,
  rejectRoundDecisionMessage,
  setupTest,
  submitDecisionMessage,
  submitMessage,
  toolCallResult,
  toolResultMessageIds,
  waitFor,
} from './agent-execution-test-helpers';

/**
 * 工具批的批量勾选决裁与批级结算（spec 04「工具调用循环语义」、spec 05「Confirm 决裁流程」）。
 *
 * 共享替身（假底座、项目作用域、历史读取、事件断言）见 `agent-execution-test-helpers.ts`；
 * 会话发送主链本身见 `agent-execution.test.ts`，批的并发执行与真实加工链见
 * `agent-tool-batch.engineSeam.test.ts`。本表覆盖「一次批级决裁如何改变一个工具批的结算」：
 * 勾选提交（含未勾选/未列出/跨批条目）、整轮驳回、批级超时、批内重复、未知工具、
 * 请求级取消与决裁竞态。
 */

/** 出站事件序（提案/结果按发送先后）：用于钉「并发派发先于任一终态」。 */
const toolEventOrder = (
  sent: ReturnType<ReturnType<typeof setupTest>['sent']>,
): Array<{ type: string; toolCallId: string; status: string }> =>
  sent.flatMap((message) =>
    message.type === 'agent:tool_call' || message.type === 'agent:tool_result'
      ? [{ type: message.type, toolCallId: message.toolCallId, status: message.status }]
      : [],
  );

void test('批量勾选提交：勾选条目并发派发执行、未勾选条目按 skipped 结算、整批逐条回填', async (t) => {
  const { client, sent, projectPath } = setupTest(t);
  installHistoryReader({ records: [] });
  let roundIndex = 0;
  const calls = installCore(async () => {
    roundIndex += 1;
    if (roundIndex === 1) {
      return toolCallResult('', [
        cropToolCall('call-b1'),
        cropToolCall('call-b2'),
        cropToolCall('call-b3'),
      ]);
    }
    return assistantResult('收到，不再调用工具。');
  });

  const pending = executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-batch-submit', projectPath }),
  });
  await waitFor(() => messagesOfType(sent(), 'agent:tool_call').length >= 1, 'batch proposals');

  // 整批一次提案：三条同时进入未决集合（串行实现只会有首条）。
  const proposalEvents = messagesOfType(sent(), 'agent:tool_call');
  assert.deepEqual(
    proposalEvents.map((event) => [event.toolCallId, event.status]),
    [
      ['call-b1', 'proposed'],
      ['call-b2', 'proposed'],
      ['call-b3', 'proposed'],
    ],
  );
  assert.deepEqual(__test_only__.getPendingToolDecisionIdsForTests(), [
    'call-b1',
    'call-b2',
    'call-b3',
  ]);

  handleAgentMessage(
    client,
    submitDecisionMessage({
      requestId: 'request-batch-submit',
      decisions: [
        { toolCallId: 'call-b1', execute: true },
        { toolCallId: 'call-b2', execute: true },
        { toolCallId: 'call-b3', execute: false },
      ],
    }),
  );
  await pending;

  // 并发派发：被执行条目都在任一终态前进入 dispatching（串行实现逐条串行，不满足）。
  const events = toolEventOrder(sent());
  const firstTerminal = events.findIndex((event) => event.type === 'agent:tool_result');
  const dispatchCountBeforeTerminal = events
    .slice(0, firstTerminal)
    .filter((event) => event.type === 'agent:tool_call' && event.status === 'dispatching').length;
  assert.equal(dispatchCountBeforeTerminal, 2, 'both checked entries must dispatch concurrently');

  // 终态：勾选两条走真实执行（会话资产清单里没有该资产 → 工具自身失败终态，失败只阻断该条），
  // 未勾选一条按不执行结算。
  const resultEvents = messagesOfType(sent(), 'agent:tool_result');
  assert.deepEqual(
    [...resultEvents].sort((a, b) => a.toolCallId.localeCompare(b.toolCallId)).map((event) => [
      event.toolCallId,
      event.status,
    ]),
    [
      ['call-b1', 'failed'],
      ['call-b2', 'failed'],
      ['call-b3', 'skipped'],
    ],
  );
  assert.equal(resultEvents.find((event) => event.toolCallId === 'call-b3')?.errorSummary, '未勾选，未执行');

  // 批级结算后待决登记与批级计时器清空。
  assert.deepEqual(__test_only__.getPendingToolDecisionIdsForTests(), []);

  // 模型上下文：assistant 一条消息携带整批 toolCalls，tool 结果逐条配对。
  assert.equal(calls.length, 2);
  const secondCall = calls[1];
  assert.ok(secondCall);
  assert.deepEqual(assistantToolCallIds(secondCall.messages), ['call-b1', 'call-b2', 'call-b3']);
  assert.deepEqual(
    [...toolResultMessageIds(secondCall.messages)].sort(),
    ['call-b1', 'call-b2', 'call-b3'],
  );

  const complete = messagesOfType(sent(), 'agent:complete');
  assert.equal(complete.length, 1);
  assert.equal(complete[0]?.content, '收到，不再调用工具。');
  assert.equal(messagesOfType(sent(), 'agent:error').length, 0);
});

void test('提交映射异常路径：未列出的未决条目按不执行结算，跨批 toolCallId 忽略留痕', async (t) => {
  const { client, sent, projectPath } = setupTest(t);
  installHistoryReader({ records: [] });
  let roundIndex = 0;
  const calls = installCore(async () => {
    roundIndex += 1;
    if (roundIndex === 1) {
      return toolCallResult('', [cropToolCall('call-u1'), cropToolCall('call-u2')]);
    }
    return assistantResult('收口。');
  });

  const pending = executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-batch-unlisted', projectPath }),
  });
  await waitFor(() => messagesOfType(sent(), 'agent:tool_call').length >= 2, 'batch proposals');

  handleAgentMessage(
    client,
    submitDecisionMessage({
      requestId: 'request-batch-unlisted',
      decisions: [
        { toolCallId: 'call-u1', execute: true },
        // call-u2 未列出：发送端异常路径，按不执行结算（与 execute: false 同口径）。
        { toolCallId: 'call-not-in-batch', execute: true },
      ],
    }),
  );
  await pending;

  const resultEvents = messagesOfType(sent(), 'agent:tool_result');
  assert.deepEqual(
    [...resultEvents].sort((a, b) => a.toolCallId.localeCompare(b.toolCallId)).map((event) => [
      event.toolCallId,
      event.status,
      event.errorSummary,
    ]),
    [
      ['call-u1', 'failed', '资产 asset-call-u1 不在当前会话的资产清单中，无法引用'],
      ['call-u2', 'skipped', '未勾选，未执行'],
    ],
    'cross-batch toolCallId must not affect the batch settlement',
  );
  const secondCall = calls[1];
  assert.ok(secondCall);
  // 回填按完成序（配对依据是 toolCallId，不是数组位置）：未执行条目先结算、执行条目后到位。
  assert.deepEqual(
    [...toolResultMessageIds(secondCall.messages)].sort(),
    ['call-u1', 'call-u2'],
  );
  assert.equal(messagesOfType(sent(), 'agent:error').length, 0);
});

void test('整轮驳回：本批全部未决条目一次结算为 skipped（多提案不再只结算最后一条）', async (t) => {
  const { client, sent, projectPath } = setupTest(t);
  installHistoryReader({ records: [] });
  let roundIndex = 0;
  const calls = installCore(async () => {
    roundIndex += 1;
    if (roundIndex === 1) {
      return toolCallResult('', [
        cropToolCall('call-r1'),
        cropToolCall('call-r2'),
        cropToolCall('call-r3'),
      ]);
    }
    return assistantResult('收到，不再调用工具。');
  });

  const pending = executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-reject-round', projectPath }),
  });
  await waitFor(() => messagesOfType(sent(), 'agent:tool_call').length >= 3, 'batch proposals');
  assert.deepEqual(__test_only__.getPendingToolDecisionIdsForTests(), [
    'call-r1',
    'call-r2',
    'call-r3',
  ]);

  handleAgentMessage(
    client,
    rejectRoundDecisionMessage({ requestId: 'request-reject-round' }),
  );
  await pending;

  const resultEvents = messagesOfType(sent(), 'agent:tool_result');
  assert.deepEqual(
    resultEvents.map((event) => [event.toolCallId, event.status, event.errorSummary]),
    [
      ['call-r1', 'skipped', '已整轮驳回，未执行'],
      ['call-r2', 'skipped', '已整轮驳回，未执行'],
      ['call-r3', 'skipped', '已整轮驳回，未执行'],
    ],
  );
  // 驳回只结算未决批：没有任何条目的 dispatching。
  assert.deepEqual(
    messagesOfType(sent(), 'agent:tool_call').map((event) => event.status),
    ['proposed', 'proposed', 'proposed'],
  );
  assert.deepEqual(__test_only__.getPendingToolDecisionIdsForTests(), []);

  const secondCall = calls[1];
  assert.ok(secondCall);
  assert.deepEqual(assistantToolCallIds(secondCall.messages), ['call-r1', 'call-r2', 'call-r3']);
  assert.deepEqual(toolResultMessageIds(secondCall.messages), ['call-r1', 'call-r2', 'call-r3']);

  // 批已结算：迟到的决裁（先到先结算）不再命中等待器，不发事件、不改状态。
  const sentBefore = sent().length;
  handleAgentMessage(
    client,
    submitDecisionMessage({
      requestId: 'request-reject-round',
      decisions: [{ toolCallId: 'call-r1', execute: true }],
    }),
  );
  await flushAsync();
  assert.equal(sent().length, sentBefore);
});

void test('批级超时：整批未提交即按 skipped 关闭，且不派发任何条目', async (t) => {
  const { client, sent, projectPath } = setupTest(t);
  installHistoryReader({ records: [] });
  __test_only__.setToolProposalTimeoutMsForTests(30);
  let roundIndex = 0;
  const calls = installCore(async () => {
    roundIndex += 1;
    if (roundIndex === 1) {
      return toolCallResult('', [cropToolCall('call-t1'), cropToolCall('call-t2')]);
    }
    return assistantResult('超时后收口。');
  });

  await executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-batch-timeout', projectPath }),
  });

  const resultEvents = messagesOfType(sent(), 'agent:tool_result');
  assert.deepEqual(
    resultEvents.map((event) => [event.toolCallId, event.status, event.errorSummary]),
    [
      ['call-t1', 'skipped', '提案超时未决，已关闭'],
      ['call-t2', 'skipped', '提案超时未决，已关闭'],
    ],
  );
  assert.deepEqual(
    messagesOfType(sent(), 'agent:tool_call').map((event) => event.status),
    ['proposed', 'proposed'],
  );
  assert.deepEqual(__test_only__.getPendingToolDecisionIdsForTests(), []);
  const secondCall = calls[1];
  assert.ok(secondCall);
  assert.deepEqual(toolResultMessageIds(secondCall.messages), ['call-t1', 'call-t2']);
  assert.equal(messagesOfType(sent(), 'agent:complete').length, 1);
});

void test('批内重复 toolCallId：重复条目不提案不执行，唯一 id 恰好一条配对结果', async (t) => {
  const { client, sent, projectPath } = setupTest(t);
  installHistoryReader({ records: [] });
  let roundIndex = 0;
  const calls = installCore(async () => {
    roundIndex += 1;
    if (roundIndex === 1) {
      return toolCallResult('', [
        cropToolCall('call-dup'),
        cropToolCall('call-other'),
        cropToolCall('call-dup'),
      ]);
    }
    return assistantResult('收口。');
  });

  const pending = executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-batch-duplicate', projectPath }),
  });
  await waitFor(() => messagesOfType(sent(), 'agent:tool_call').length >= 2, 'batch proposals');

  // 重复 id 只保留首个条目：提案恰好 2 条（重复条目不提案）。
  assert.deepEqual(
    messagesOfType(sent(), 'agent:tool_call').map((event) => event.toolCallId),
    ['call-dup', 'call-other'],
  );
  assert.deepEqual(__test_only__.getPendingToolDecisionIdsForTests(), ['call-dup', 'call-other']);

  handleAgentMessage(
    client,
    submitDecisionMessage({
      requestId: 'request-batch-duplicate',
      decisions: [
        { toolCallId: 'call-dup', execute: true },
        { toolCallId: 'call-other', execute: true },
      ],
    }),
  );
  await pending;

  // 每个被接受的 id 恰好一条结果（重复条目不得再产出同 id 的结果）。
  const resultEvents = messagesOfType(sent(), 'agent:tool_result');
  assert.deepEqual(
    [...resultEvents].sort((a, b) => a.toolCallId.localeCompare(b.toolCallId)).map((event) => [
      event.toolCallId,
      event.status,
    ]),
    [
      ['call-dup', 'failed'],
      ['call-other', 'failed'],
    ],
  );
  const secondCall = calls[1];
  assert.ok(secondCall);
  const resultIds = toolResultMessageIds(secondCall.messages);
  assert.deepEqual([...resultIds].sort(), ['call-dup', 'call-other']);
  assert.equal(new Set(resultIds).size, resultIds.length, 'no duplicate tool result for one id');
});

void test('未知工具：提案事件照发（落库有 tool_call 记录）后立即以 failed 结算，结果不孤儿', async (t) => {
  const { client, sent, projectPath } = setupTest(t);
  installHistoryReader({ records: [] });
  let roundIndex = 0;
  const calls = installCore(async () => {
    roundIndex += 1;
    if (roundIndex === 1) {
      return toolCallResult('', [
        { id: 'call-unknown', name: 'unknown_tool', argsJson: '{"a":1}' },
      ]);
    }
    return assistantResult('这个工具不存在，改用文字说明。');
  });

  const pending = executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-batch-unknown', projectPath }),
  });
  await waitFor(() => messagesOfType(sent(), 'agent:tool_result').length >= 1, 'unknown settled');

  // 未知工具不进入决裁等待（无待决登记），提案事件照常发出（落库有记录）。
  assert.deepEqual(
    messagesOfType(sent(), 'agent:tool_call').map((event) => [event.toolCallId, event.status]),
    [['call-unknown', 'proposed']],
  );
  assert.deepEqual(__test_only__.getPendingToolDecisionIdsForTests(), []);
  const resultEvents = messagesOfType(sent(), 'agent:tool_result');
  assert.deepEqual(
    resultEvents.map((event) => [event.toolCallId, event.status, event.errorSummary]),
    [['call-unknown', 'failed', '未注册的工具调用：unknown_tool']],
  );

  // 未知工具不阻塞批级屏障：本批只有未知工具时直接进入下一轮模型调用。
  await pending;
  const secondCall = calls[1];
  assert.ok(secondCall);
  assert.deepEqual(assistantToolCallIds(secondCall.messages), ['call-unknown']);
  assert.deepEqual(toolResultMessageIds(secondCall.messages), ['call-unknown']);
  assert.equal(messagesOfType(sent(), 'agent:complete').length, 1);
});

void test('未知工具不进入批级决裁等待：同批可决裁条目仍待提交时，未知工具已按 failed 结算', async (t) => {
  const { client, sent, projectPath } = setupTest(t);
  installHistoryReader({ records: [] });
  let roundIndex = 0;
  const calls = installCore(async () => {
    roundIndex += 1;
    if (roundIndex === 1) {
      return toolCallResult('', [
        { id: 'call-mixed-unknown', name: 'unknown_tool', argsJson: '{}' },
        cropToolCall('call-mixed-known'),
      ]);
    }
    return assistantResult('收口。');
  });

  const pending = executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-batch-mixed', projectPath }),
  });
  await waitFor(() => messagesOfType(sent(), 'agent:tool_call').length >= 2, 'batch proposals');
  await waitFor(() => messagesOfType(sent(), 'agent:tool_result').length >= 1, 'unknown settled');

  // 未知工具已结算，可决裁条目仍在等待提交（未决集合只含可决裁条目）。
  assert.deepEqual(
    messagesOfType(sent(), 'agent:tool_result').map((event) => [
      event.toolCallId,
      event.status,
      event.errorSummary,
    ]),
    [['call-mixed-unknown', 'failed', '未注册的工具调用：unknown_tool']],
  );
  assert.deepEqual(__test_only__.getPendingToolDecisionIdsForTests(), ['call-mixed-known']);

  handleAgentMessage(
    client,
    submitDecisionMessage({
      requestId: 'request-batch-mixed',
      decisions: [{ toolCallId: 'call-mixed-known', execute: true }],
    }),
  );
  await pending;

  assert.deepEqual(
    [...messagesOfType(sent(), 'agent:tool_result')]
      .sort((a, b) => a.toolCallId.localeCompare(b.toolCallId))
      .map((event) => [event.toolCallId, event.status]),
    [
      ['call-mixed-known', 'failed'],
      ['call-mixed-unknown', 'failed'],
    ],
  );
  const secondCall = calls[1];
  assert.ok(secondCall);
  assert.deepEqual(
    [...toolResultMessageIds(secondCall.messages)].sort(),
    ['call-mixed-known', 'call-mixed-unknown'],
  );
  assert.equal(messagesOfType(sent(), 'agent:complete').length, 1);
});

void test('请求级取消：未决批按 skipped 结算（标注取消来源），整请求以 cancelled 收口', async (t) => {
  const { client, sent, projectPath } = setupTest(t);
  installHistoryReader({ records: [] });
  let roundIndex = 0;
  installCore(async () => {
    roundIndex += 1;
    if (roundIndex === 1) return toolCallResult('', [cropToolCall('call-c1'), cropToolCall('call-c2')]);
    return assistantResult('不应到达。');
  });

  const pending = executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-batch-abort', projectPath }),
  });
  await waitFor(() => messagesOfType(sent(), 'agent:tool_call').length >= 2, 'batch proposals');

  handleAgentMessage(client, {
    type: 'agent:cancel',
    agentSessionId: AGENT_SESSION_ID,
    requestId: 'request-batch-abort',
    toolCallId: null,
  });
  await pending;

  const resultEvents = messagesOfType(sent(), 'agent:tool_result');
  assert.deepEqual(
    resultEvents.map((event) => [event.toolCallId, event.status, event.errorSummary]),
    [
      ['call-c1', 'skipped', '会话已取消'],
      ['call-c2', 'skipped', '会话已取消'],
    ],
  );
  assert.deepEqual(__test_only__.getPendingToolDecisionIdsForTests(), []);
  const errors = messagesOfType(sent(), 'agent:error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.code, 'cancelled');
  assert.equal(messagesOfType(sent(), 'agent:complete').length, 0);
});

void test('决裁不变量：submit 条目 toolCallId 空白按 invalid_request 拒绝且不结算（批仍可被合法提交收口）', async (t) => {
  const { client, sent, projectPath } = setupTest(t);
  installHistoryReader({ records: [] });
  let roundIndex = 0;
  installCore(async () => {
    roundIndex += 1;
    if (roundIndex === 1) return toolCallResult('', [cropToolCall('call-inv-1')]);
    return assistantResult('收口。');
  });

  const pending = executeAgentSubmitPrompt({
    client,
    message: submitMessage({ requestId: 'request-decision-invariant', projectPath }),
  });
  await waitFor(() => messagesOfType(sent(), 'agent:tool_call').length >= 1, 'batch proposals');

  // 非法决裁：条目 id 空白 → invalid_request + 留痕，且不得结算本批。
  handleAgentMessage(
    client,
    submitDecisionMessage({
      requestId: 'request-decision-invariant',
      decisions: [{ toolCallId: '   ', execute: true }],
    }),
  );
  await flushAsync();
  const errors = messagesOfType(sent(), 'agent:error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.code, 'invalid_request');
  assert.match(errors[0]?.message ?? '', /non-empty toolCallId/);
  assert.equal(messagesOfType(sent(), 'agent:tool_result').length, 0, '非法决裁不得结算');
  assert.deepEqual(__test_only__.getPendingToolDecisionIdsForTests(), ['call-inv-1']);

  // 合法提交立即生效（回归）：批仍在等待，不被非法决裁破坏。
  handleAgentMessage(
    client,
    submitDecisionMessage({
      requestId: 'request-decision-invariant',
      decisions: [{ toolCallId: 'call-inv-1', execute: false }],
    }),
  );
  await pending;

  const results = messagesOfType(sent(), 'agent:tool_result');
  assert.equal(results.length, 1);
  assert.equal(results[0]?.status, 'skipped');
  assert.equal(results[0]?.errorSummary, '未勾选，未执行');
  assert.deepEqual(__test_only__.getPendingToolDecisionIdsForTests(), []);
  assert.equal(messagesOfType(sent(), 'agent:complete').length, 1);
});
