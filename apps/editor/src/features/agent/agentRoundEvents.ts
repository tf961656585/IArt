/**
 * Agent 轮次事件收口（受理屏障 / 终态保护 / 顺序保证）。
 *
 * 职责（spec 04-执行管道与WS协议.md）：
 * - `agent:accepted` 的同步阶段置位受理，受理续作完成节点/会话/user 消息落库并在途登记后
 *   结算屏障；同轮 `token` / `complete` / `error` 一律先过屏障，保证 user 正式消息先于
 *   同轮 assistant（含 partial）消息落库，且终态不被迟到的受理续作反向覆盖；
 * - 删除会话后的残留事件由收口守卫丢弃（不写库、不向用户抛错）。
 */

import type {
  AgentAssistantMessageEvent,
  AgentError,
  AgentSessionRecord,
  AgentToolCallEvent,
  AgentToolCallRecord,
  AgentToolResultEvent,
  ChatMessageContent,
} from '@iart/contracts';

import { agentSessionStorage } from './agentSessionStorage';
import { agentSocket } from './agentSocket';
import { AgentSubmitFailure, type AgentFailureCode } from './agentErrorText';
import { createAgentNodeForAcceptance, resolveAgentSessionTitle } from './agentNodeProjection';
import {
  appendFormalMessage,
  buildAssistantMessageAppendParams,
  buildSessionError,
  buildUserMessageAppendParams,
  hasMessageContent,
  refreshSessionMeta,
  resolveProjectPath,
  useAgentSessionStore,
  type AgentSubmitInput,
  type AgentSubmitResult,
  type AgentToolCallLive,
} from './agentSessionState';

type PendingSubmitEntry = {
  input: AgentSubmitInput;
  resolve: (result: AgentSubmitResult) => void;
  reject: (error: Error) => void;
};

/** 受理前等待中的提交（受理/失败/取消三种收口）。 */
const pendingSubmits = new Map<string, PendingSubmitEntry>();

/** 同一 requestId 是否已有等待中的提交（重复提交守卫）。 */
export const hasPendingSubmit = (requestId: string): boolean => pendingSubmits.has(requestId);

/**
 * 登记一轮提交（发送前调用）：先登记轮次（含受理落库屏障），再返回等待受理的 promise。
 * 发送同步失败（连接不可用）也走同一收口路径，调用方不需要另加分支。
 */
export const beginAgentRound = (input: AgentSubmitInput): Promise<AgentSubmitResult> => {
  const result = new Promise<AgentSubmitResult>((resolve, reject) => {
    pendingSubmits.set(input.requestId, { input, resolve, reject });
  });
  openAgentRound(input.requestId, input.agentSessionId);
  return result;
};

// ────────────────────────────────────────────
// 轮次与事件收口（受理 → 节点/会话/正式消息；token/complete/error 收口）
// ────────────────────────────────────────────

/**
 * 受理前失败的收口：以携带错误码的失败 reject 等待中的提交。
 *
 * `detail` 只进日志（可能含后端原文）；界面按 `code` 取用户文案（映射见 agentErrorText），
 * 不读 `message`。
 */
export const settlePendingSubmitError = (
  requestId: string,
  code: AgentFailureCode,
  detail: string,
): void => {
  const pending = pendingSubmits.get(requestId);
  if (!pending) return;
  pendingSubmits.delete(requestId);
  pending.reject(new AgentSubmitFailure(code, requestId, detail));
};

/** 受理前等待中的提交按节点归属查找（删除节点时也要终止这一类在途轮次）。 */
export const findPendingSubmitByNodeId = (nodeId: string): PendingSubmitEntry | null => {
  for (const entry of pendingSubmits.values()) {
    if (entry.input.nodeId === nodeId) return entry;
  }
  return null;
};

/**
 * 轮次屏障：把「受理落库」与「同轮 token / complete / error」之间的时序钉死。
 *
 * 背景（真实缺陷）：Backend 在 `agent:accepted` 之后、网络之前失败时，`agent:error`
 * 必然先于 Editor 受理侧的多次 await 落库完成到达。没有屏障时终态事件会先收口，
 * 随后被受理续作反向覆盖（错误被清掉、在途残留显示「生成中」、partial 助手消息
 * 早于本轮 user 消息落库而颠倒 seq）。
 *
 * 屏障语义：
 * - 登记时机：`submitAgentPrompt` 发送前登记（不晚于任何受理事实）；
 * - 置位时机：`agent:accepted` 处理的**同步阶段**（早于该函数任何 await）置 `accepted`；
 * - 结算时机：受理续作写完节点 / 会话记录 / user 正式消息并登记在途请求之后（同步尾段）；
 * - 未受理即收口（Backend 校验、作用域、历史读取失败面从不发 accepted）时由收口侧结算，
 *   等待者不会永久挂起。
 */
type AgentRoundBarrier = {
  promise: Promise<void>;
  settled: boolean;
  settle: () => void;
};

type AgentRound = {
  requestId: string;
  agentSessionId: string;
  /** 本端已收到 `agent:accepted`（同步置位，早于受理续作的任何 await）。 */
  accepted: boolean;
  /** 本轮已终态收口（complete / error）：此后受理续作不得再改错误态与在途标记。 */
  closed: boolean;
  acceptance: AgentRoundBarrier;
};

const createAgentRoundBarrier = (): AgentRoundBarrier => {
  const barrier: AgentRoundBarrier = {
    promise: Promise.resolve(),
    settled: false,
    settle: () => undefined,
  };
  barrier.promise = new Promise<void>((resolve) => {
    barrier.settle = () => {
      if (barrier.settled) return;
      barrier.settled = true;
      resolve();
    };
  });
  return barrier;
};

/** 轮次表（按 requestId）。已收口的轮次保留一小段，用于幂等忽略迟到事件。 */
const agentRounds = new Map<string, AgentRound>();
const closedRoundOrder: string[] = [];
const MAX_REMEMBERED_CLOSED_ROUNDS = 32;

const openAgentRound = (requestId: string, agentSessionId: string): AgentRound => {
  const round: AgentRound = {
    requestId,
    agentSessionId,
    accepted: false,
    closed: false,
    acceptance: createAgentRoundBarrier(),
  };
  agentRounds.set(requestId, round);
  return round;
};

const readAgentRound = (requestId: string): AgentRound | null => agentRounds.get(requestId) ?? null;

/** 终态收口：置位收口标记并结算屏障（未受理的轮次也要放行等待者）。幂等。 */
const closeAgentRound = (round: AgentRound | null): void => {
  if (!round || round.closed) return;
  round.closed = true;
  round.acceptance.settle();
  // 轮次收口即本批工具调用不再有后续事件：把仍留在未终态的条目收敛为不可操作终态，
  // 不让批内条目在卡片上永远停在「等待确认 / 正在执行」。正常路径已由 tool_result 逐条收口，
  // 这里只兜底（事件丢失 / 受理失败）；收敛判据是条目自带的 requestId，不误伤下一轮。
  useAgentSessionStore.getState().settleRoundToolCalls(round.agentSessionId, round.requestId);
  closedRoundOrder.push(round.requestId);
  while (closedRoundOrder.length > MAX_REMEMBERED_CLOSED_ROUNDS) {
    const oldest = closedRoundOrder.shift();
    if (oldest === undefined) break;
    const candidate = agentRounds.get(oldest);
    if (candidate?.closed) agentRounds.delete(oldest);
  }
};

/**
 * 等待本轮受理落库完成（顺序保证：同轮 user 正式消息必先于 assistant 消息落库）。
 *
 * - 已受理：等屏障（受理续作在写完节点/会话/user 消息并登记在途后结算）；
 * - 未受理且未收口：Backend 的失败面（校验 / 作用域 / 历史读取失败）从不发 accepted，
 *   这里不能等待（会永久挂起），按「本轮无正式历史写入」直接收口；
 * - 已收口：屏障必然已结算，直接返回。
 */
const awaitRoundAcceptance = async (round: AgentRound | null): Promise<void> => {
  if (!round) return;
  if (!round.accepted && !round.closed) return;
  await round.acceptance.promise;
};

/**
 * 事件收口守卫：判定 `agent:*` 事件的归属是否还存在。
 *
 * 背景（docs/agent/02-Agent节点与画布投影.md「撤销重做与删除」）：删除 Agent 节点要求
 * 「先在途终止再删除」，删除动作会经删除咽喉前置钩子立即作废会话（元数据、消息缓存、
 * 在途请求一并摘除）。Backend 侧仍在途的流式收尾事件随后到达，此时该会话既无在途请求、
 * 也不在元数据中 —— 这类事件必须丢弃，否则会去写一个已删除会话（写库校验失败）并把
 * 报错噪音抛给用户。
 *
 * 归属判定（任一命中即放行；命中口径都必须在本端「待收口」的事实源上）：
 * - `sessionsById`：会话元数据（已加载或已受理落库）；
 * - `inFlightBySessionId`：已受理、尚未收口的轮次；
 * - `sendRecordsBySessionId`：本地发送留痕。发送留痕先于 socket 发送落库，因此它覆盖
 *   「已受理但会话元数据尚未写回」「受理后立刻失败」等窗口，保证正常路径不被守卫误伤
 *   （首轮在途请求在收到 `agent:accepted` 之前就已登记）；
 * - `pendingSubmits`：已发出、尚未受理或尚未收口的提交（含非本会话归属的兜底匹配）。
 */
const hasKnownAgentEventTarget = (agentSessionId: string, requestId: string): boolean => {
  if (!agentSessionId) return false;
  const state = useAgentSessionStore.getState();
  if (state.sessionsById[agentSessionId]) return true;
  if (state.inFlightBySessionId[agentSessionId]) return true;
  if (state.sendRecordsBySessionId[agentSessionId]?.length) return true;
  if (pendingSubmits.has(requestId)) return true;
  for (const entry of pendingSubmits.values()) {
    if (entry.input.agentSessionId === agentSessionId) return true;
  }
  return false;
};

/**
 * 丢弃无归属事件（条件跳过必须留痕）：只记日志，不写库、不改 store、不向用户抛错。
 * 返回 true 表示已丢弃。
 */
const dropUnknownAgentEvent = (
  kind: string,
  agentSessionId: string,
  requestId: string,
): boolean => {
  if (hasKnownAgentEventTarget(agentSessionId, requestId)) return false;
  console.debug('[agentSession] event dropped: session is neither in flight nor known', {
    kind,
    agentSessionId,
    requestId,
  });
  return true;
};

const handleAccepted = async (message: {
  requestId: string;
  agentSessionId: string;
}): Promise<void> => {
  const round = readAgentRound(message.requestId);
  const pending = pendingSubmits.get(message.requestId);

  // 同步阶段置位受理（早于本函数任何 await）：同轮 token/complete/error 据此等待验收屏障。
  if (round && !round.closed) {
    round.accepted = true;
  }

  if (round?.closed === true) {
    // 本轮已由终态收口（error 先到）：迟到的受理续作不得再清错误态、不得再改在途标记。
    console.debug('[agentSession] accepted for settled round ignored', {
      requestId: message.requestId,
    });
    round.acceptance.settle();
    return;
  }

  if (!pending) {
    // 非本端发起 / 已取消 / 已收口：幂等忽略（留痕，便于排查）。
    // 归属判定即这里的 pendingSubmits 命中（受理是本端等待中的提交才有的事实）。
    console.debug('[agentSession] accepted for unknown request ignored', {
      requestId: message.requestId,
    });
    round?.acceptance.settle();
    return;
  }
  pendingSubmits.delete(message.requestId);

  const projectPath = resolveProjectPath();
  if (!projectPath) {
    round?.acceptance.settle();
    // 项目没打开是永久性失败（重试无效）：独立错误码，出口是重新打开项目。
    pending.reject(
      new AgentSubmitFailure(
        'project_unavailable',
        message.requestId,
        '项目还没打开，Agent 会话无法写入。',
      ),
    );
    return;
  }

  const store = useAgentSessionStore.getState();
  const agentSessionId = message.agentSessionId || pending.input.agentSessionId;
  const isFirstMessage = pending.input.nodeId === null;

  try {
    let nodeId = pending.input.nodeId;

    if (isFirstMessage) {
      // 1) 受理是节点创建的唯一触发事实：一次提交恰好一个 Agent 节点。
      const node = createAgentNodeForAcceptance({
        agentSessionId,
        referenceAssetIds: pending.input.referenceAssetIds,
      });
      if (!node) {
        throw new Error('画布还没准备好，Agent 节点没能创建，请重试。');
      }
      nodeId = node.id;

      // 2) 会话记录落库（title 由首条用户消息文本生成）。
      const now = Date.now();
      const session: AgentSessionRecord = {
        agentSessionId,
        nodeId: node.id,
        modelId: pending.input.modelId,
        thinkingTier: pending.input.thinkingTier,
        approvalMode: pending.input.approvalMode,
        title: resolveAgentSessionTitle(pending.input.content),
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
        // 新会话还没有消息：null 即「还没有消息」（首条 user 消息落库时才推进该列，
        // 存储写入端是事实源，这里只提供合法的初始值）。
        lastMessageAt: null,
      };
      const stored = await agentSessionStorage.upsertAgentSession(projectPath, session);
      store.upsertSessionRecord(stored);
    }

    // 3) user 消息在受理后进正式历史（本轮 requestId 关联）。这一步必须在屏障结算之前完成：
    //    同轮 assistant（含 partial）消息要等它落库，seq 才不会颠倒。
    await appendFormalMessage(
      projectPath,
      buildUserMessageAppendParams({
        agentSessionId,
        requestId: message.requestId,
        content: pending.input.content,
        createdAt: Date.now(),
      }),
    );

    if (round && !round.closed) {
      store.setInFlight(agentSessionId, {
        requestId: message.requestId,
        agentSessionId,
        nodeId: nodeId ?? null,
      });
      store.setSessionError(agentSessionId, null);
    } else {
      // 本轮已被终态收口（如用户取消后收口先完成）：保留已有错误态，且不留残在途条目。
      store.setInFlight(agentSessionId, null);
      console.debug('[agentSession] accepted continuation skipped state writes (round settled)', {
        agentSessionId,
        requestId: message.requestId,
      });
    }

    // 受理落库完成、在途标记就位后结算屏障：终态处理排在受理续作之后，能正确收口。
    round?.acceptance.settle();
    pending.resolve({ agentSessionId, nodeId: nodeId ?? '' });
    await refreshSessionMeta(projectPath, agentSessionId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Agent 会话创建失败，请重试。';
    console.warn('[agentSession] accepted handling failed', { agentSessionId, error });
    round?.acceptance.settle();
    store.setSessionError(agentSessionId, {
      code: 'execution_failed',
      message: reason,
      requestId: message.requestId,
    });
    pending.reject(new AgentSubmitFailure('execution_failed', message.requestId, reason));
  }
};

/** 应用一段流式增量（在途归属校验 + 累加；纯内存，不落库）。 */
const applyTokenDelta = (message: {
  agentSessionId: string;
  requestId: string;
  delta: string;
}): void => {
  const state = useAgentSessionStore.getState();
  const inFlight = state.inFlightBySessionId[message.agentSessionId];
  if (inFlight && inFlight.requestId !== message.requestId) {
    // 上一轮已收口、迟到的 token：不污染新一轮在途文本（留痕跳过）。
    console.debug('[agentSession] stale token ignored', {
      agentSessionId: message.agentSessionId,
      requestId: message.requestId,
    });
    return;
  }
  state.appendStreamingText(message.agentSessionId, message.delta);
};

const handleToken = (message: { agentSessionId: string; requestId: string; delta: string }): void => {
  if (dropUnknownAgentEvent('token', message.agentSessionId, message.requestId)) return;
  const round = readAgentRound(message.requestId);
  if (round?.closed === true) {
    // 本轮已终态收口：迟到 token 不再累加（否则终态后凭空出现流式文本）。
    console.debug('[agentSession] token after round settled ignored', {
      agentSessionId: message.agentSessionId,
      requestId: message.requestId,
    });
    return;
  }
  if (round && !round.acceptance.settled) {
    // 受理落库未完成：本段挂到屏障之后（同步路径不受影响，只有真在途才排队）。
    const pendingRound = round;
    void pendingRound.acceptance.promise.then(() => {
      if (pendingRound.closed) return;
      applyTokenDelta(message);
    });
    return;
  }
  applyTokenDelta(message);
};

const handleComplete = async (message: {
  agentSessionId: string;
  requestId: string;
  content: ChatMessageContent;
}): Promise<void> => {
  // 收口守卫：已删除会话的残留 complete 只丢弃，不写库、不刷新元数据。
  if (dropUnknownAgentEvent('complete', message.agentSessionId, message.requestId)) return;
  const round = readAgentRound(message.requestId);
  // 顺序保证：先等本轮受理落库（user 正式消息），assistant 消息才落库。
  await awaitRoundAcceptance(round);
  if (round?.closed === true) {
    // 本轮已收口（重复事件）：幂等忽略，不重复落库、不改状态。
    console.debug('[agentSession] duplicate complete ignored (round already settled)', {
      agentSessionId: message.agentSessionId,
      requestId: message.requestId,
    });
    return;
  }
  const projectPath = resolveProjectPath();
  const store = useAgentSessionStore.getState();
  const agentSessionId = message.agentSessionId;
  // 终态先占位（同步、无 await 缝隙），再清在途/流式并落库。
  closeAgentRound(round);
  store.clearStreamingText(agentSessionId);
  store.setInFlight(agentSessionId, null);

  if (hasMessageContent(message.content)) {
    if (projectPath) {
      await appendFormalMessage(
        projectPath,
        buildAssistantMessageAppendParams({
          agentSessionId,
          requestId: message.requestId,
          content: message.content,
          createdAt: Date.now(),
          isPartial: false,
        }),
      );
    }
  } else {
    console.debug('[agentSession] complete without content, nothing to persist', {
      agentSessionId,
      requestId: message.requestId,
    });
  }

  if (projectPath) {
    await refreshSessionMeta(projectPath, agentSessionId);
  }
};

const handleError = async (message: AgentError): Promise<void> => {
  const round = readAgentRound(message.requestId);
  const projectPath = resolveProjectPath();
  const agentSessionId =
    message.agentSessionId ||
    round?.agentSessionId ||
    findSessionIdByRequestId(message.requestId);
  const store = useAgentSessionStore.getState();
  // 失败码 → 用户文案的映射输入（见 agentErrorText）：
  // 本端合成的失败（连不上 / 断线 / 发不出去 / 响应无法识别）不携带会话归属，按连接口径呈现；
  // 服务端失败一律带会话归属，用契约码（原文只作日志材料，不上面）。
  const failureCode: AgentFailureCode =
    message.agentSessionId === '' ? 'connection_unavailable' : message.code;

  if (!agentSessionId) {
    // 连接级失败（无会话归属）：直接收口等待中的提交，不留悬空 promise。
    console.debug('[agentSession] error without session ownership', {
      requestId: message.requestId,
      message: message.message,
    });
    closeAgentRound(round);
    settlePendingSubmitError(message.requestId, failureCode, message.message);
    return;
  }

  // 收口守卫：已删除会话的残留 error 只丢弃，不写库、不设错误态、不向用户抛错。
  if (dropUnknownAgentEvent('error', agentSessionId, message.requestId)) return;

  // 顺序保证：先等本轮受理落库（user 正式消息），partial assistant 才落库。
  await awaitRoundAcceptance(round);
  if (round?.closed === true) {
    // 本轮已收口（重复事件）：不覆盖已有错误态、不改在途标记。
    console.debug('[agentSession] duplicate error ignored (round already settled)', {
      agentSessionId,
      requestId: message.requestId,
    });
    return;
  }

  // 该轮已收口：清在途/流式，并把可读错误交给 UI（不静默吞掉）。
  closeAgentRound(round);
  store.clearStreamingText(agentSessionId);
  store.setInFlight(agentSessionId, null);
  store.setSessionError(agentSessionId, buildSessionError(message, failureCode));

  // 中断分支：已有部分内容则按 isPartial 落正式历史。
  if (projectPath && hasMessageContent(message.partialContent)) {
    await appendFormalMessage(
      projectPath,
      buildAssistantMessageAppendParams({
        agentSessionId,
        requestId: message.requestId,
        content: message.partialContent as ChatMessageContent,
        createdAt: Date.now(),
        isPartial: true,
      }),
    );
  }

  if (projectPath) {
    await refreshSessionMeta(projectPath, agentSessionId);
  }
  // 受理前失败：提交 promise 收口到调用方（不静默吞错）；受理后失败经 store 错误态呈现。
  settlePendingSubmitError(message.requestId, failureCode, message.message);
};

const findSessionIdByRequestId = (requestId: string): string | null => {
  const state = useAgentSessionStore.getState();
  for (const [agentSessionId, inFlight] of Object.entries(state.inFlightBySessionId)) {
    if (inFlight.requestId === requestId) return agentSessionId;
  }
  for (const sendRecord of Object.values(state.sendRecordsBySessionId)) {
    const hit = sendRecord.find((record) => record.requestId === requestId);
    if (hit) return hit.agentSessionId;
  }
  return null;
};

// ────────────────────────────────────────────
// 工具调用事件（spec 04「工具调用循环语义」：中间轮助手消息 / 提案 / 终态）
// ────────────────────────────────────────────

/** 中间轮助手消息定稿（仅对话内容；工具调用消息由 tool_call 事件落库，避免重复）。 */
const handleAssistantMessageEvent = async (message: AgentAssistantMessageEvent): Promise<void> => {
  if (dropUnknownAgentEvent('assistant_message', message.agentSessionId, message.requestId)) return;
  const round = readAgentRound(message.requestId);
  await awaitRoundAcceptance(round);
  if (round?.closed === true) return;
  // 定稿即消费流式缓冲：本事件前的 token 已全部并入这条正式消息，不清零则下一轮 token
  // 追加在上一轮残留上（会话气泡复读上一轮全文）。与 Backend 轮次边界的 streamedText
  // 重置对齐；先清再落库——落库 await 期间到达的下一轮 token 不得被误清。
  useAgentSessionStore.getState().clearStreamingText(message.agentSessionId);
  const projectPath = resolveProjectPath();
  if (!projectPath || !hasMessageContent(message.content)) return;
  await appendFormalMessage(
    projectPath,
    buildAssistantMessageAppendParams({
      agentSessionId: message.agentSessionId,
      requestId: message.requestId,
      content: message.content,
      createdAt: Date.now(),
      isPartial: false,
    }),
  );
};

/** 工具调用记录写入失败不阻断会话流（记录可从消息与任务事实重建，卡片状态源在 live 态）。 */
const persistToolCallRecordFailure = (kind: string, error: unknown): void => {
  console.warn(`[agentSession] tool call record ${kind} failed`, { error });
};

/**
 * 按 `toolCallId` 串行化的工具调用记录写入链。
 *
 * 背景（真实竞态）：提案的 `appendAgentToolCall` 与状态推进的 `updateAgentToolCall` 分属两个
 * 独立异步 handler，互不等待。两个事件几乎同时到达时，update 可能先跑完而记录尚不存在
 * （存储层按 `toolCallId` 定位不到行，返回 null），该次状态推进就静默空转，卡片停在提案态。
 * 这里把同一 `toolCallId` 的写入按到达顺序排队：该条目已有在途写入时排队，不越过先行写入。
 *
 * 前序写入已完成（链空闲）时立即执行，不额外等一个微任务——记录写入的落点不被无谓推迟。
 * 只保证「同一 `toolCallId` 内的写入顺序」；跨 `toolCallId` 不排序（spec 04：落库顺序不承诺与
 * 提案顺序一致，投影按 `toolCallId` 配对）。
 */
const toolCallWriteChains = new Map<string, Promise<void>>();

const runToolCallWrite = async (work: () => Promise<void>): Promise<void> => {
  try {
    await work();
  } catch (error) {
    persistToolCallRecordFailure('write', error);
  }
};

const enqueueToolCallWrite = (toolCallId: string, work: () => Promise<void>): Promise<void> => {
  const previous = toolCallWriteChains.get(toolCallId);
  const next =
    previous === undefined ? runToolCallWrite(work) : previous.then(() => runToolCallWrite(work));
  toolCallWriteChains.set(toolCallId, next);
  void next.then(() => {
    // 只摘除自己仍是链尾的条目：期间新登记的任务要继续挂在链上。
    if (toolCallWriteChains.get(toolCallId) === next) toolCallWriteChains.delete(toolCallId);
  });
  return next;
};

const handleToolCallEvent = async (message: AgentToolCallEvent): Promise<void> => {
  if (dropUnknownAgentEvent('tool_call', message.agentSessionId, message.requestId)) return;
  const round = readAgentRound(message.requestId);
  await awaitRoundAcceptance(round);
  if (round?.closed === true) return;

  const store = useAgentSessionStore.getState();
  store.upsertToolCallLive(message.agentSessionId, {
    toolCallId: message.toolCallId,
    requestId: message.requestId,
    toolName: message.toolName,
    toolKind: message.toolKind,
    modelId: message.modelId,
    argsJson: message.argsJson,
    status: message.status,
    proposalExpiresAt: message.proposalExpiresAt,
  });

  const projectPath = resolveProjectPath();
  if (!projectPath) return;
  const proposalExpiresAt = message.proposalExpiresAt;
  if (message.status === 'proposed') {
    // 提案发出：tool_call 消息进正式历史 + 工具调用记录建立（各恰好一次）。
    void appendFormalMessage(projectPath, {
      agentSessionId: message.agentSessionId,
      role: 'assistant',
      requestId: message.requestId,
      body: {
        kind: 'tool_call',
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        toolKind: message.toolKind,
        modelId: message.modelId,
        argsJson: message.argsJson,
      },
      plan: null,
      createdAt: Date.now(),
      isPartial: false,
    });
    await enqueueToolCallWrite(message.toolCallId, async () => {
      const now = Date.now();
      const record = await agentSessionStorage.appendAgentToolCall(projectPath, {
        toolCallId: message.toolCallId,
        agentSessionId: message.agentSessionId,
        toolName: message.toolName,
        toolKind: message.toolKind,
        modelId: message.modelId,
        status: 'proposed',
        batchId: null,
        taskIds: [],
        assetIds: [],
        errorSummary: null,
        createdAt: now,
        updatedAt: now,
      });
      // 记录回写 live 只补记录侧字段（argsJson / 截止时间沿用既有 live 条目）：
      // 终态若已先到，store 的单调守卫会丢弃这次未收口回写。
      store.upsertToolCallLive(
        message.agentSessionId,
        liveEntryFromRecord(record, message.requestId, proposalExpiresAt),
      );
    });
    return;
  }
  // dispatching / running：记录状态推进（终态由 tool_result 结算）。
  await enqueueToolCallWrite(message.toolCallId, async () => {
    const record: AgentToolCallRecord | null = await agentSessionStorage.updateAgentToolCall(projectPath, {
      agentSessionId: message.agentSessionId,
      toolCallId: message.toolCallId,
      status: message.status,
    });
    if (record === null) {
      // 记录不存在（本会话本批无该条目的落库行）：留痕跳过，不臆造记录。
      console.debug('[agentSession] tool call status advance found no record', {
        agentSessionId: message.agentSessionId,
        toolCallId: message.toolCallId,
        status: message.status,
      });
      return;
    }
    store.upsertToolCallLive(
      message.agentSessionId,
      liveEntryFromRecord(record, message.requestId, proposalExpiresAt),
    );
  });
};

/** 记录 → live 态投影（argsJson 不在记录上，取既有 live 条目或提案事件携带值）。 */
const liveEntryFromRecord = (
  record: AgentToolCallRecord,
  requestId: string,
  proposalExpiresAt: number | null,
): AgentToolCallLive => {
  const existing = useAgentSessionStore.getState().toolCallsLiveBySessionId[record.agentSessionId]?.[record.toolCallId] ?? null;
  return {
    toolCallId: record.toolCallId,
    requestId: existing?.requestId ?? requestId,
    toolName: record.toolName,
    toolKind: record.toolKind,
    modelId: record.modelId,
    argsJson: existing?.argsJson ?? '',
    status: record.status,
    proposalExpiresAt,
  };
};

const handleToolResultEvent = async (message: AgentToolResultEvent): Promise<void> => {
  if (dropUnknownAgentEvent('tool_result', message.agentSessionId, message.requestId)) return;
  const round = readAgentRound(message.requestId);
  await awaitRoundAcceptance(round);
  if (round?.closed === true) return;

  const store = useAgentSessionStore.getState();
  const projectPath = resolveProjectPath();
  // 消息落库先于记录更新（两路异步写都先于本轮 complete 收口；消息 seq 稳定在
  // 最终 assistant 消息之前，记录更新稍晚不影响卡片——卡片状态源在 live 态）。
  if (projectPath) {
    void appendFormalMessage(projectPath, {
      agentSessionId: message.agentSessionId,
      role: 'system',
      requestId: message.requestId,
      body: {
        kind: 'tool_result',
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        status: message.status,
        summary: message.summary,
        assetIds: message.assetIds,
        errorSummary: message.errorSummary,
      },
      plan: null,
      createdAt: Date.now(),
      isPartial: false,
    });
  }
  // 终态的落库与 live 回填排在提案 append 之后（同一 toolCallId 的写入链）：提案与终态几乎
  // 同时到达时，终态不会因记录尚未建立而落在空处（记录保留终态、卡片拿到终态），也不空转。
  await enqueueToolCallWrite(message.toolCallId, async () => {
    const record = projectPath
      ? await agentSessionStorage.updateAgentToolCall(projectPath, {
          agentSessionId: message.agentSessionId,
          toolCallId: message.toolCallId,
          status: message.status,
          batchId: message.batchId,
          taskIds: message.taskIds,
          assetIds: message.assetIds,
          errorSummary: message.errorSummary,
        })
      : null;
    if (record === null) {
      console.debug('[agentSession] tool result found no persisted record', {
        agentSessionId: message.agentSessionId,
        toolCallId: message.toolCallId,
        status: message.status,
      });
    }
    // 终态回填 live 态（字段取记录值；记录缺失时合并既有 live 条目，不臆造字段）。
    const existing =
      useAgentSessionStore.getState().toolCallsLiveBySessionId[message.agentSessionId]?.[
        message.toolCallId
      ] ?? null;
    store.upsertToolCallLive(message.agentSessionId, {
      toolCallId: message.toolCallId,
      requestId: existing?.requestId ?? message.requestId,
      toolName: message.toolName,
      toolKind: record?.toolKind ?? existing?.toolKind ?? 'generation',
      modelId: record?.modelId ?? existing?.modelId ?? null,
      argsJson: existing?.argsJson ?? '',
      status: message.status,
      proposalExpiresAt: null,
    });
  });
};

agentSocket.subscribe({
  onAccepted: (message) => {
    void handleAccepted(message);
  },
  onToken: (message) => {
    handleToken(message);
  },
  onAssistantMessage: (message) => {
    void handleAssistantMessageEvent(message);
  },
  onToolCall: (message) => {
    void handleToolCallEvent(message);
  },
  onToolResult: (message) => {
    void handleToolResultEvent(message);
  },
  onComplete: (message) => {
    void handleComplete(message);
  },
  onError: (message) => {
    void handleError(message);
  },
});
