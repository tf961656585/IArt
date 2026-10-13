/**
 * Agent 工具批编排（spec 04「工具调用循环语义」「历史投影规则」、spec 05「Confirm 决裁流程」）。
 *
 * 本模块承载「一个工具批」（模型一条 assistant 消息携带的全部 `tool_calls`）的完整编排：
 * 批内去重 → 整批提案（共享批级截止时间）→ 批级决裁屏障（勾选提交 / 整轮驳回 / 批级超时 /
 * 请求取消）→ 执行集合**并发**派发 → 各条目终态事件与模型上下文回填。
 *
 * 拆分原则是职责而非行数：`agent-execution.cts` 关心「一轮提交怎么收口」，本模块关心
 * 「一个工具批怎么被裁定、并发执行与结算」。
 *
 * 语义事实源: docs/agent/04-执行管道与WS协议.md、docs/agent/05-审批规则.md。
 */

import {
  type AgentCancel,
  type AgentSubmitPrompt,
  type AgentToolDecision,
  type AgentToolKind,
  type InternalMessage,
  type InternalToolCall,
} from '@iart/contracts';

import type { BusinessClient } from './business-actions/common.cts';
import {
  AGENT_TOOL_PROPOSAL_TIMEOUT_MS,
  resolveToolKind,
} from './agent-tool-registry.cts';
import { executeAgentTool, type AgentToolExecutionResult } from './agent-tool-executor.cts';
import { sendAgentToolCall, sendAgentToolResult } from './agent-ws-senders.cts';
import { logDebug, logError } from './logging.cts';

// ────────────────────────────────────────────
// 1. 批级决裁登记
// ────────────────────────────────────────────

/** 批级决裁结局：勾选提交 / 整轮驳回 / 批级超时 / 请求取消。 */
type ToolBatchOutcome = 'submitted' | 'reject_round' | 'timeout' | 'aborted';

type ToolBatchDecision = {
  outcome: ToolBatchOutcome;
  /** 执行集合：`submitted` 时为我方裁定的工具调用 id 集合；其余结局为空集（整批不执行）。 */
  executeIds: ReadonlySet<string>;
};

const NO_EXECUTION: ReadonlySet<string> = new Set<string>();

type PendingToolBatch = {
  /** 本批可决裁条目的 id 集合：决裁归属裁定与「未列出按不执行结算」的判据。 */
  candidateIds: Set<string>;
  settle: (decision: ToolBatchDecision) => void;
};

/**
 * `confirm` 档在途工具批登记（requestId → 批级等待器）。
 *
 * 一个 requestId 同时只有一个工具批在途（请求按会话单飞，且批级屏障串行推进轮次），
 * 故以 requestId 为键：`agent:tool_decision` 两种形态都按 requestId 命中本批、一次结算整批
 * （原「逐条提案 + 单槽 settlePending」的多提案覆盖缺陷在此结构性消除）。
 */
const pendingToolBatches = new Map<string, PendingToolBatch>();

/**
 * 批级提案超时时长（spec 04「提案超时（批级）」）：产品语义固定 10 分钟；
 * 测试可注入更短值以覆盖超时路径，生产路径不读取任何外部配置。
 */
let toolProposalTimeoutMs = AGENT_TOOL_PROPOSAL_TIMEOUT_MS;

const setToolProposalTimeoutMsForTests = (timeoutMs: number | null): void => {
  toolProposalTimeoutMs = timeoutMs ?? AGENT_TOOL_PROPOSAL_TIMEOUT_MS;
};

/**
 * 批级决裁屏障：等待整批的一次结算。
 *
 * 三种结算触发之外还有请求级取消（abort 信号）；结算触发后立即注销批级计时器与登记，
 * 因此迟到的决裁消息不再命中等待器（留痕忽略，先到先结算）。
 */
const waitToolBatchDecision = (params: {
  requestId: string;
  candidateIds: ReadonlyArray<string>;
  abortSignal: AbortSignal;
}): Promise<ToolBatchDecision> =>
  new Promise((resolve) => {
    let settled = false;
    const settle = (decision: ToolBatchDecision): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      params.abortSignal.removeEventListener('abort', onAbort);
      pendingToolBatches.delete(params.requestId);
      resolve(decision);
    };
    const timer: ReturnType<typeof setTimeout> = setTimeout(
      () => settle({ outcome: 'timeout', executeIds: NO_EXECUTION }),
      toolProposalTimeoutMs,
    );
    const onAbort = (): void => settle({ outcome: 'aborted', executeIds: NO_EXECUTION });
    // 进入批编排前请求已取消（本轮流式中途取消）：立即按取消结算，不登记等待器
    // ——`addEventListener` 对已 abort 的信号不会再触发，缺此判断会白等到批级超时。
    if (params.abortSignal.aborted) {
      settle({ outcome: 'aborted', executeIds: NO_EXECUTION });
      return;
    }
    params.abortSignal.addEventListener('abort', onAbort, { once: true });
    pendingToolBatches.set(params.requestId, {
      candidateIds: new Set(params.candidateIds),
      settle,
    });
  });

/**
 * `agent:tool_decision` 批量形态的形状外不变量：`submit` 的每个条目必须携带非空
 * `toolCallId`（schema 只保证是字符串）。返回失败原因（字符串）或 null（通过）。
 *
 * 归属裁定（条目 `toolCallId` 属于本批未决集合）不走拒绝路径——不属于本批的条目一律
 * 忽略留痕，见 `resolveToolDecision`。
 */
const validateToolDecision = (decision: AgentToolDecision): string | null => {
  if (decision.decision !== 'submit') return null;
  const blank = decision.decisions.find((item) => !item.toolCallId.trim());
  return blank ? 'submit decision requires a non-empty toolCallId for every entry' : null;
};

/**
 * 决裁上行落点：命中在途批等待器即一次结算整批；未命中（无在途批 / 已被更早的决裁或
 * 超时结算）留痕忽略——先到先结算。
 *
 * `submit` 只认本批未决条目：不属于本批的 `toolCallId` 忽略留痕；未列入映射的未决条目
 * 与 `execute: false` 同口径（按不执行结算；未列出属发送端异常路径，单独留痕）。
 */
const resolveToolDecision = (decision: AgentToolDecision): void => {
  const requestId = decision.requestId.trim();
  const pending = pendingToolBatches.get(requestId);
  if (!pending) {
    logDebug('[agent-tool-loop] tool decision ignored: no tool batch awaiting decision', {
      agentSessionId: decision.agentSessionId,
      requestId,
      decision: decision.decision,
    });
    return;
  }
  if (decision.decision === 'reject_round') {
    logDebug('[agent-tool-loop] tool batch rejected as a whole by user', {
      agentSessionId: decision.agentSessionId,
      requestId,
      pendingCount: pending.candidateIds.size,
    });
    pending.settle({ outcome: 'reject_round', executeIds: NO_EXECUTION });
    return;
  }
  const executeIds = new Set<string>();
  const listedIds = new Set<string>();
  for (const item of decision.decisions) {
    const toolCallId = item.toolCallId.trim();
    if (listedIds.has(toolCallId)) {
      logDebug('[agent-tool-loop] tool decision entry ignored: duplicate toolCallId in submit', {
        requestId,
        toolCallId,
      });
      continue;
    }
    listedIds.add(toolCallId);
    if (!pending.candidateIds.has(toolCallId)) {
      logDebug('[agent-tool-loop] tool decision entry ignored: toolCallId not pending in this batch', {
        requestId,
        toolCallId,
      });
      continue;
    }
    if (item.execute) executeIds.add(toolCallId);
  }
  const unlistedIds = [...pending.candidateIds].filter((toolCallId) => !listedIds.has(toolCallId));
  if (unlistedIds.length > 0) {
    logDebug('[agent-tool-loop] submit omits pending entries: settled as not executed', {
      requestId,
      agentSessionId: decision.agentSessionId,
      unlistedIds,
    });
  }
  logDebug('[agent-tool-loop] tool batch submitted by user', {
    requestId,
    agentSessionId: decision.agentSessionId,
    executeIds: [...executeIds],
    notExecutedCount: pending.candidateIds.size - executeIds.size,
  });
  pending.settle({ outcome: 'submitted', executeIds });
};

// ────────────────────────────────────────────
// 2. 条目级中止登记（单条取消，spec 04「工具调用循环语义·单条取消」）
// ────────────────────────────────────────────

type RunningToolCallAbort = {
  requestId: string;
  agentSessionId: string;
  controller: AbortController;
};

/**
 * 在途执行条目的条目级中止登记（执行期登记、终态注销，键为 `toolCallId`）。
 *
 * 并发执行下同批多条目可同时在途，本表天然按条目独立登记——单条取消逐条生效，互不影响。
 * 单条取消只作用于在途执行（`dispatching` / `running`）条目：未派发提案的处置走各自决裁
 * 语义（勾选提交/整轮驳回/批级超时），不在本登记内。
 */
const runningToolCallAborts = new Map<string, RunningToolCallAbort>();

/**
 * 单条取消（`agent:cancel` 携带 `toolCallId`）：命中在途执行登记即中止该条目的执行与
 * 派生任务（取消语义走生成任务取消——取消命令被接受后不再生成资产），该条目随后以
 * `cancelled` 结算并回灌模型，同批其余条目与整轮继续。
 * 未命中（未派发 / 已结算）或归属不符（requestId / agentSessionId 对不上）留痕忽略，
 * 不打断任何在途请求。
 */
const cancelAgentToolCall = (cancel: AgentCancel): void => {
  const toolCallId = (cancel.toolCallId ?? '').trim();
  if (!toolCallId) return;
  const entry = runningToolCallAborts.get(toolCallId);
  if (!entry) {
    logDebug('[agent-tool-loop] tool call cancel ignored: no in-flight execution', {
      agentSessionId: cancel.agentSessionId,
      toolCallId,
    });
    return;
  }
  const requestId = cancel.requestId.trim();
  if (requestId && entry.requestId !== requestId) {
    logDebug('[agent-tool-loop] tool call cancel ignored: requestId mismatch', {
      agentSessionId: entry.agentSessionId,
      toolCallId,
      requestId,
      inFlightRequestId: entry.requestId,
    });
    return;
  }
  const agentSessionId = cancel.agentSessionId.trim();
  if (agentSessionId && entry.agentSessionId !== agentSessionId) {
    logDebug('[agent-tool-loop] tool call cancel ignored: session mismatch', {
      toolCallId,
      agentSessionId,
      inFlightSessionId: entry.agentSessionId,
    });
    return;
  }
  logDebug('[agent-tool-loop] cancelling in-flight tool call', {
    agentSessionId: entry.agentSessionId,
    requestId: entry.requestId,
    toolCallId,
  });
  entry.controller.abort();
};

// ────────────────────────────────────────────
// 3. 工具批编排
// ────────────────────────────────────────────

/**
 * 未知工具的提案事件类别：契约 `AGENT_TOOL_KINDS` 只有生成/加工两档，模型幻觉出的工具名
 * 没有第三档可表达。此处按加工类登记（`modelId` 为 null）只承载「提案 → 结果」的配对与
 * 落库分类，不参与执行分派（分派按 `toolName` 重新裁定，未知工具立即以 failed 结算）。
 */
const UNKNOWN_TOOL_KIND: AgentToolKind = 'processing';

/**
 * 批内条目处置：
 * - `decidable`：已登记工具，进入决裁与执行；
 * - `unknown`：未登记工具，提案后立即以 failed 结算（不等待决裁）；
 * - `duplicate`：批内重复 `toolCallId`，去重丢弃（留痕）。
 */
type ToolBatchEntry =
  | { role: 'decidable'; toolCall: InternalToolCall; toolCallId: string; toolKind: AgentToolKind; modelId: string | null }
  | { role: 'unknown'; toolCall: InternalToolCall; toolCallId: string }
  | { role: 'duplicate'; toolCall: InternalToolCall; toolCallId: string };

/** 进入决裁与执行的条目（未知工具与重复条目不进执行阶段）。 */
type DecidableToolBatchEntry = Extract<ToolBatchEntry, { role: 'decidable' }>;

/**
 * 批内条目归一：工具类别裁定 + 批内 `toolCallId` 去重（spec 04「工具调用循环语义」）。
 *
 * 去重口径：重复 id 只有首个条目被接受，后续重复条目不提案、不执行、不产出结果消息——
 * 该 id 的唯一配对结果由首个条目产出。多出一条同 id 的 tool 结果会让工具调用记录被覆盖、
 * 并破坏「每个 tool_call 恰好一条配对结果」的上下文不变量。丢弃必须留痕（debug）。
 */
const normalizeToolBatch = (toolCalls: ReadonlyArray<InternalToolCall>): ToolBatchEntry[] => {
  const entries: ToolBatchEntry[] = [];
  const acceptedToolCallIds = new Set<string>();
  for (const toolCall of toolCalls) {
    const toolCallId =
      toolCall.id.trim() || `tool_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    if (acceptedToolCallIds.has(toolCallId)) {
      logDebug('[agent-tool-loop] duplicate toolCallId in batch: entry dropped without proposal', {
        toolCallId,
        toolName: toolCall.name,
      });
      entries.push({ role: 'duplicate', toolCall, toolCallId });
      continue;
    }
    acceptedToolCallIds.add(toolCallId);
    const toolKind = resolveToolKind(toolCall.name);
    if (toolKind === null) {
      logDebug('[agent-tool-loop] unknown tool in batch: proposed then settled as failed', {
        toolCallId,
        toolName: toolCall.name,
      });
      entries.push({ role: 'unknown', toolCall, toolCallId });
      continue;
    }
    entries.push({
      role: 'decidable',
      toolCall,
      toolCallId,
      toolKind,
      // 生成工具的目标模型从参数中提起（供提案卡片直显）；加工工具无目标模型。
      modelId: toolKind === 'generation' ? extractGenerationModelId(toolCall.argsJson) : null,
    });
  }
  return entries;
};

/** 未执行结算的 `errorSummary` 口径（`skipped` 的来源经此区分，spec 04「工具调用循环语义」）。 */
const TOOL_UNCHECKED_ERROR_SUMMARY = '未勾选，未执行';
const TOOL_TIMEOUT_ERROR_SUMMARY = '提案超时未决，已关闭';
const TOOL_ROUND_REJECTED_ERROR_SUMMARY = '已整轮驳回，未执行';
const TOOL_CANCELLED_ERROR_SUMMARY = '会话已取消';

/** 未执行结算的摘要文本（终态事件与模型上下文回填共用）。 */
const TOOL_NOT_EXECUTED_SUMMARY = '工具调用未执行';

/** 批级结局 → 未执行条目的 `errorSummary`（来源可辨，spec 04）。 */
const settlementErrorSummary = (outcome: ToolBatchOutcome): string => {
  if (outcome === 'timeout') return TOOL_TIMEOUT_ERROR_SUMMARY;
  if (outcome === 'aborted') return TOOL_CANCELLED_ERROR_SUMMARY;
  if (outcome === 'reject_round') return TOOL_ROUND_REJECTED_ERROR_SUMMARY;
  return TOOL_UNCHECKED_ERROR_SUMMARY;
};

/**
 * 未派发条目的终态结算：终态事件 + 模型上下文回填。
 *
 * 状态按来源二分：未执行一律 `skipped`（未勾选 / 未列入提交映射 / 批超时 / 整轮驳回 /
 * 请求取消——来源经 `errorSummary` 区分），未知工具与编排异常为 `failed`。逐条回填是硬要求：
 * OpenAI 协议要求 assistant 消息里每个 `tool_call_id` 都有对应的 tool 结果，缺任何一条
 * 下次调用即报错。
 */
const settleToolCallWithoutExecution = (params: {
  client: BusinessClient;
  submit: AgentSubmitPrompt;
  toolCall: InternalToolCall;
  toolCallId: string;
  /** 未派发条目的结算状态：失败（未知工具/编排异常）或不执行（未勾选/超时/驳回/取消）。 */
  status: 'failed' | 'skipped';
  summary: string;
  errorSummary: string;
}): InternalMessage => {
  sendAgentToolResult(params.client, {
    requestId: params.submit.requestId.trim(),
    agentSessionId: params.submit.agentSessionId.trim(),
    toolCallId: params.toolCallId,
    toolName: params.toolCall.name,
    status: params.status,
    summary: params.summary,
    assetIds: [],
    assets: [],
    batchId: null,
    taskIds: [],
    errorSummary: params.errorSummary,
  });
  return buildToolFollowUpMessage({
    toolCallId: params.toolCallId,
    toolCall: params.toolCall,
    status: params.status,
    summary: params.summary,
    assets: [],
    errorSummary: params.errorSummary,
  });
};

/**
 * 工具批编排（spec 04「工具调用循环语义」）：提案 → 批级决裁 → 并发派发执行 → 终态回填。
 *
 * 返回本轮追加进模型上下文的 tool 结果消息（**完成序**——每条终态即追加，JS 单线程 push
 * 原子；配对依据是 `toolCallId`，不是数组位置）。批级屏障只约束「结果交回模型」的时机，
 * 不约束条目启动：同批条目并发派发，单条等待不阻塞他条。
 */
const runAgentToolBatch = async (params: {
  client: BusinessClient;
  submit: AgentSubmitPrompt;
  toolCalls: ReadonlyArray<InternalToolCall>;
  abortController: AbortController;
}): Promise<InternalMessage[]> => {
  const { client, submit, toolCalls, abortController } = params;
  const requestId = submit.requestId.trim();
  const agentSessionId = submit.agentSessionId.trim();
  const entries = normalizeToolBatch(toolCalls);
  const decidableIds = entries
    .filter((entry) => entry.role === 'decidable')
    .map((entry) => entry.toolCallId);

  // `confirm` 档：决裁等待器先登记再送提案（同一 tick 内完成，决裁消息不可能插进两者之间）。
  const decisionPromise =
    submit.approvalMode === 'confirm' && decidableIds.length > 0
      ? waitToolBatchDecision({
          requestId,
          candidateIds: decidableIds,
          abortSignal: abortController.signal,
        })
      : null;

  // 整批提案一次送达：可决裁条目共享同一批级截止时间（spec 04「提案超时（批级）」）；
  // 未知工具不等待决裁、yolo 档直派发，其 `proposalExpiresAt` 均为 null。
  const batchExpiresAt =
    submit.approvalMode === 'confirm' && decisionPromise !== null
      ? Date.now() + toolProposalTimeoutMs
      : null;
  for (const entry of entries) {
    if (entry.role === 'duplicate') continue;
    sendAgentToolCall(client, {
      requestId,
      agentSessionId,
      toolCallId: entry.toolCallId,
      toolName: entry.toolCall.name,
      toolKind: entry.role === 'decidable' ? entry.toolKind : UNKNOWN_TOOL_KIND,
      modelId: entry.role === 'decidable' ? entry.modelId : null,
      argsJson: entry.toolCall.argsJson,
      status: 'proposed',
      proposalExpiresAt: entry.role === 'decidable' ? batchExpiresAt : null,
    });
  }

  // 未知工具不进决裁等待、不等批级结算：提案送达后立即以失败结算（模型据此修正调用，
  // 不自动重试、不自动补位）。落库因此有 tool_call 记录、结果不孤儿。
  const followUps: InternalMessage[] = [];
  for (const entry of entries) {
    if (entry.role !== 'unknown') continue;
    followUps.push(
      settleToolCallWithoutExecution({
        client,
        submit,
        toolCall: entry.toolCall,
        toolCallId: entry.toolCallId,
        status: 'failed',
        summary: '未知工具',
        errorSummary: `未注册的工具调用：${entry.toolCall.name}`,
      }),
    );
  }

  // 批级决裁：`confirm` 档等整批一次结算；`yolo` 档提案送达后整批直派发（执行集合 = 全部
  // 可决裁条目，视为整批提交，不等待任何用户动作）。
  const decision: ToolBatchDecision = decisionPromise
    ? await decisionPromise
    : { outcome: 'submitted', executeIds: new Set(decidableIds) };
  if (decisionPromise && decision.outcome !== 'submitted') {
    logDebug('[agent-tool-loop] tool batch settled without submission', {
      requestId,
      agentSessionId,
      outcome: decision.outcome,
      pendingCount: decidableIds.length,
    });
  }

  // 并发派发 + 批级屏障：全部可决裁条目独立走各自的终态链，结果按完成序追加，全部终态后
  // 才交回模型（认领执行集合的条目并发在途，互不等待）。
  const decidableEntries = entries.filter(
    (entry): entry is DecidableToolBatchEntry => entry.role === 'decidable',
  );
  const settled = await Promise.allSettled(
    decidableEntries.map((entry) =>
      runToolBatchEntry({ client, submit, entry, decision, abortController, followUps }),
    ),
  );
  settled.forEach((outcome, index) => {
    if (outcome.status !== 'rejected') return;
    const errorSummary = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
    const entry = decidableEntries[index];
    logError('[agent-tool-loop] tool batch entry failed before settlement', {
      requestId,
      agentSessionId,
      toolCallId: entry?.toolCallId ?? null,
      error: errorSummary,
    });
    // 编排层自身异常不得让该条目从上下文里消失：补一条失败结果，保住「每个 tool_call 恰好
    // 一条配对结果」的不变量（缺一条下一次模型调用会整体报错）。
    if (entry) {
      followUps.push(
        settleToolCallWithoutExecution({
          client,
          submit,
          toolCall: entry.toolCall,
          toolCallId: entry.toolCallId,
          status: 'failed',
          summary: '工具执行失败',
          errorSummary,
        }),
      );
    }
  });
  return followUps;
};

/** 已登记工具条目的结算：未进入执行集合即按结局结算，否则派发执行（并发在途，互不等待）。 */
const runToolBatchEntry = async (params: {
  client: BusinessClient;
  submit: AgentSubmitPrompt;
  entry: DecidableToolBatchEntry;
  decision: ToolBatchDecision;
  abortController: AbortController;
  /** 终态结果消息的落点（完成序追加；JS 单线程 push 原子）。 */
  followUps: InternalMessage[];
}): Promise<void> => {
  const { client, submit, entry, decision, abortController, followUps } = params;
  const requestId = submit.requestId.trim();
  const agentSessionId = submit.agentSessionId.trim();

  if (!decision.executeIds.has(entry.toolCallId)) {
    const errorSummary = settlementErrorSummary(decision.outcome);
    logDebug('[agent-tool-loop] tool call settled without execution', {
      requestId,
      agentSessionId,
      toolCallId: entry.toolCallId,
      toolName: entry.toolCall.name,
      outcome: decision.outcome,
      errorSummary,
    });
    followUps.push(
      settleToolCallWithoutExecution({
        client,
        submit,
        toolCall: entry.toolCall,
        toolCallId: entry.toolCallId,
        status: 'skipped',
        summary: TOOL_NOT_EXECUTED_SUMMARY,
        errorSummary,
      }),
    );
    return;
  }

  followUps.push(
    await dispatchToolCall({ client, submit, entry, abortController, requestId, agentSessionId }),
  );
};

/** 派发执行：状态推进 → 条目级中止登记 → 执行器（阻塞等待自身终态）→ 终态事件与上下文回填。 */
const dispatchToolCall = async (params: {
  client: BusinessClient;
  submit: AgentSubmitPrompt;
  entry: DecidableToolBatchEntry;
  abortController: AbortController;
  requestId: string;
  agentSessionId: string;
}): Promise<InternalMessage> => {
  const { client, submit, entry, abortController, requestId, agentSessionId } = params;
  sendAgentToolCall(client, {
    requestId,
    agentSessionId,
    toolCallId: entry.toolCallId,
    toolName: entry.toolCall.name,
    toolKind: entry.toolKind,
    modelId: entry.modelId,
    argsJson: entry.toolCall.argsJson,
    status: 'dispatching',
    proposalExpiresAt: null,
  });
  // 条目级中止（spec 04「单条取消」）：执行器只看条目信号——单条取消只中止本条；
  // 请求级中止经传导同步触发条目信号（整请求取消的既有语义不变）。
  const toolAbortController = new AbortController();
  const onRequestAbort = (): void => toolAbortController.abort();
  if (abortController.signal.aborted) onRequestAbort();
  else abortController.signal.addEventListener('abort', onRequestAbort, { once: true });
  runningToolCallAborts.set(entry.toolCallId, {
    requestId,
    agentSessionId,
    controller: toolAbortController,
  });
  let execution: AgentToolExecutionResult;
  try {
    execution = await executeAgentTool({
      toolName: entry.toolCall.name,
      argsJson: entry.toolCall.argsJson,
      context: {
        projectPath: submit.projectPath.trim(),
        agentSessionId,
        requestId,
        toolCallId: entry.toolCallId,
        referenceAssets: submit.referenceAssets ?? [],
        abortSignal: toolAbortController.signal,
      },
    });
  } finally {
    runningToolCallAborts.delete(entry.toolCallId);
    abortController.signal.removeEventListener('abort', onRequestAbort);
  }

  // 终态事件 + 模型上下文回填（单条失败仅阻断该条目，错误摘要交回模型，其余条目照常并发）。
  sendAgentToolResult(client, {
    requestId,
    agentSessionId,
    toolCallId: entry.toolCallId,
    toolName: entry.toolCall.name,
    status: execution.status,
    summary: execution.summary,
    assetIds: execution.assets.map((asset) => asset.assetId),
    assets: execution.assets,
    batchId: execution.batchId,
    taskIds: execution.taskIds,
    errorSummary: execution.errorSummary,
  });
  return buildToolFollowUpMessage({
    toolCallId: entry.toolCallId,
    toolCall: entry.toolCall,
    status: execution.status,
    summary: execution.summary,
    assets: execution.assets,
    errorSummary: execution.errorSummary,
  });
};

const extractGenerationModelId = (argsJson: string): string | null => {
  try {
    const raw: unknown = JSON.parse(argsJson || '{}');
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      const value: unknown = Reflect.get(raw, 'model_id');
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    }
  } catch {
    // 参数非法由执行层收口，这里只影响提案卡片的模型直显。
  }
  return null;
};

/** 工具结果 → 模型上下文的 tool 消息（产物 assetId 显式列出，供后续轮次引用）。 */
const buildToolFollowUpMessage = (params: {
  toolCallId: string;
  toolCall: InternalToolCall;
  status: 'succeeded' | 'failed' | 'skipped' | 'cancelled';
  summary: string;
  assets: ReadonlyArray<{ assetId: string }>;
  errorSummary: string | null;
}): InternalMessage => {
  const statusText =
    params.status === 'succeeded'
      ? '执行成功'
      : params.status === 'failed'
        ? `执行失败：${params.errorSummary ?? '未知错误'}`
        : params.status === 'cancelled'
          ? '已取消'
          : '未执行';
  const assetLine =
    params.assets.length > 0
      ? `产物 assetId: ${params.assets.map((asset) => asset.assetId).join(', ')}`
      : '';
  const content = [
    `工具 ${params.toolCall.name} ${statusText}`,
    params.summary,
    assetLine,
  ]
    .filter(Boolean)
    .join('；');
  return {
    messageId: `agent_tool_result_${params.toolCallId}`,
    role: 'tool',
    content,
    createdAt: Date.now(),
    toolCallId: params.toolCallId,
    toolName: params.toolCall.name,
  };
};

/** 待决条目标识（含各自的批级计时器）：结算后必须为空，否则批级定时器仍在跑。 */
const getPendingToolDecisionIdsForTests = (): string[] =>
  [...pendingToolBatches.values()].flatMap((batch) => [...batch.candidateIds]);

export {
  validateToolDecision,
  resolveToolDecision,
  runAgentToolBatch,
  cancelAgentToolCall,
  getPendingToolDecisionIdsForTests,
  setToolProposalTimeoutMsForTests,
};
