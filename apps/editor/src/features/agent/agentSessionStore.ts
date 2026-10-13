/**
 * Agent 会话核对外 API（spec 03-会话存储与IPC契约.md / 04-执行管道与WS协议.md）。
 *
 * 职责边界：
 * - 会话元数据 / 正式消息 / 本地发送留痕 / 流式暂态的 Editor 侧投影；会话历史的事实源
 *   始终是会话存储（storage IPC），本 store 不把历史写进画布节点 data（spec 02 禁止项）；
 * - `agent:accepted` 是 Agent 节点创建的唯一起点（受理 → 建节点 → 写会话 → 写 user 消息）；
 * - 发送留痕先于受理可见：点击发送即落库，失败/中断不删除留痕（供手动重试）；
 * - 不自动重试、不补发、不换模型；连接与执行失败一律经 `agent:error` 分支收口。
 *
 * 实现分层见 `agentSessionState`（状态与落库）与 `agentRoundEvents`（受理屏障与事件收口）。
 */

import { useMemo } from 'react';

import type {
  AgentApprovalMode,
  AgentMessageRecord,
  AgentSendRecord,
  AgentSessionRecord,
  AgentToolDecisionItem,
} from '@iart/contracts';
import { AGENT_WS_MESSAGE_TYPE } from '@iart/contracts';

import { registerNodeRemovalPreflight } from '@/features/canvas/store/internal/nodeRemovalPreflight';
import { usePromptDockStore } from '@/features/promptdock/promptDockStore';
import { AgentSubmitFailure } from './agentErrorText';
import { agentSessionStorage } from './agentSessionStorage';
import { agentSocket, type AgentToolDecisionDelivery } from './agentSocket';
import {
  EMPTY_MESSAGES,
  EMPTY_SEND_RECORDS,
  EMPTY_TEXT,
  createLocalId,
  resolveProjectPath,
  useAgentSessionStore,
  type AgentInFlightRequest,
  type AgentSessionError,
  type AgentSubmitInput,
  type AgentSubmitResult,
  type AgentToolCallLive,
} from './agentSessionState';
import {
  beginAgentRound,
  findPendingSubmitByNodeId,
  hasPendingSubmit,
  settlePendingSubmitError,
} from './agentRoundEvents';

// 会话核唯一入口路径保持为 features/agent/agentSessionStore：状态、落库与事件模块经此处再导出。
export { useAgentSessionStore } from './agentSessionState';
export { hasMessageContent } from './agentSessionState';
export type {
  AgentInFlightRequest,
  AgentSessionError,
  AgentSubmitInput,
  AgentSubmitResult,
} from './agentSessionState';

// ────────────────────────────────────────────
// 对外函数 API（钉死签名）
// ────────────────────────────────────────────

/**
 * 项目打开后加载会话元数据列表（只元数据，不加载消息；消息按需读，spec 03）。
 */
export async function loadAgentSessions(projectPath: string): Promise<void> {
  const store = useAgentSessionStore.getState();
  store.setProjectPath(projectPath);
  if (!projectPath) return;
  try {
    const sessions = await agentSessionStorage.readAgentSessions(projectPath);
    useAgentSessionStore.getState().replaceSessions(sessions);
  } catch (error) {
    console.warn('[agentSession] load sessions failed', { projectPath, error });
  }
}

/**
 * 按需读取会话正式消息（首次打开会话视图时调用）。
 * 恢复顺序（spec 03「恢复」）：正式历史之后补读本地发送留痕。
 *
 * 读取失败必须留痕到 store（`messagesLoadFailedSessionIds`）：否则视图停在「正在读取…」，
 * 把失败呈现成无限加载。失败原因进日志，界面用固定出口文案。
 */
export async function ensureAgentMessagesLoaded(agentSessionId: string): Promise<void> {
  if (!agentSessionId) return;
  const store = useAgentSessionStore.getState();
  if (store.messagesLoadedSessionIds[agentSessionId]) return;
  const projectPath = resolveProjectPath();
  if (!projectPath) {
    console.debug('[agentSession] messages load skipped: no project path', { agentSessionId });
    useAgentSessionStore.getState().setMessagesLoadFailed(agentSessionId, true);
    return;
  }
  // 进入读取态：清掉上一次的失败标记（重新打开面板即重试读取，成功则覆盖为已加载）。
  useAgentSessionStore.getState().setMessagesLoadFailed(agentSessionId, false);
  try {
    const messages = await agentSessionStorage.readAgentMessages(projectPath, agentSessionId);
    useAgentSessionStore.getState().setMessages(agentSessionId, messages);
  } catch (error) {
    console.warn('[agentSession] load messages failed', { agentSessionId, error });
    useAgentSessionStore.getState().setMessagesLoadFailed(agentSessionId, true);
    return;
  }
  try {
    const sendRecords = await agentSessionStorage.readAgentSendRecords(projectPath, agentSessionId);
    useAgentSessionStore.getState().setSendRecords(agentSessionId, sendRecords);
  } catch (error) {
    console.warn('[agentSession] load send records failed', { agentSessionId, error });
  }
}

/**
 * 提交一轮 agent 消息（按序：留痕 → 发送 → 受理落库）。
 * 返回受理后的最终节点 id；受理前失败/取消时以携带错误码的 `AgentSubmitFailure` reject
 * （不自动重试；调用方按码取出口文案，不读 `message` 原文）。
 */
export async function submitAgentPrompt(input: AgentSubmitInput): Promise<AgentSubmitResult> {
  const projectPath = resolveProjectPath();
  if (!projectPath) {
    // 项目没打开是永久性失败（重试无效）：独立错误码，出口是重新打开项目（见 agentErrorText）。
    throw new AgentSubmitFailure(
      'project_unavailable',
      input.requestId,
      '项目还没打开，Agent 消息暂时发不出去。',
    );
  }
  if (hasPendingSubmit(input.requestId)) {
    throw new AgentSubmitFailure('duplicate_submit', input.requestId, '同一轮提交仍在途。');
  }
  // 该会话已有一轮在途：这一条不发给远端（Backend 同样按 invalid_request 拒绝），
  // 直接在本地按「上一条还在回复」收口，不让用户对着后端原文猜。
  const inFlight = useAgentSessionStore.getState().inFlightBySessionId[input.agentSessionId];
  if (inFlight) {
    throw new AgentSubmitFailure(
      'duplicate_submit',
      input.requestId,
      `会话已有在途轮次：${inFlight.requestId}`,
    );
  }

  const submittedAt = Date.now();
  const sendRecord: AgentSendRecord = {
    recordId: createLocalId('agent_send'),
    agentSessionId: input.agentSessionId,
    // 首条消息在受理后才有节点宿主：此时为 null（不是空串哨兵）；续作写真实节点 id。
    nodeId: input.nodeId ?? null,
    requestId: input.requestId,
    createdAt: submittedAt,
    content: input.content,
    referenceAssetIds: [...input.referenceAssetIds],
    snapshot: {
      modelId: input.modelId,
      thinkingTier: input.thinkingTier,
      approvalMode: input.approvalMode,
      referenceAssetIds: [...input.referenceAssetIds],
      submittedAt,
    },
  };

  // 1) 本地发送留痕先写：发送点击后消息不在纯内存（spec 03 禁止项）。
  const storedRecord = await agentSessionStorage.appendAgentSendRecord(projectPath, sendRecord);
  useAgentSessionStore.getState().appendSendRecordToState(storedRecord);

  // 2) 发送（受理前等待；错误/断线经 agent:error 收口）。
  //    轮次（含受理落库屏障）与等待 promise 在发送前登记：accepted 的同步阶段即可置位受理状态，
  //    同轮 token/complete/error 一律先过这道屏障；发送同步失败也走同一收口路径。
  const result = beginAgentRound(input);

  agentSocket.sendSubmitPrompt({
    type: AGENT_WS_MESSAGE_TYPE.SUBMIT_PROMPT,
    requestId: input.requestId,
    agentSessionId: input.agentSessionId,
    // 显式携带项目路径：Backend 按它读取该会话的正式历史，不做「唯一打开项目」猜测。
    projectPath,
    modelId: input.modelId,
    thinkingTier: input.thinkingTier,
    approvalMode: input.approvalMode,
    content: input.content,
    referenceAssetIds: [...input.referenceAssetIds],
    // 旧调用方可能未携带简报（类型未覆盖到的测试替身等）：按空清单收敛，不因缺字段崩发送。
    referenceAssets: [...(input.referenceAssets ?? [])],
  });

  return result;
}

/**
 * 按节点取消在途请求（供「删节点先在途终止」使用）。
 * 无在途请求时不发命令（留痕跳过）。
 */
export async function cancelAgentSessionForNode(nodeId: string): Promise<void> {
  if (!nodeId) return;
  const store = useAgentSessionStore.getState();
  const inFlight = Object.values(store.inFlightBySessionId).find(
    (request) => request.nodeId === nodeId,
  );
  if (!inFlight) {
    // 首条消息受理前节点尚不存在：退回按「未绑定节点的在途提交」匹配不可行，留痕跳过。
    console.debug('[agentSession] cancel skipped: no in-flight request for node', { nodeId });
    return;
  }

  agentSocket.sendCancel({
    type: AGENT_WS_MESSAGE_TYPE.CANCEL,
    agentSessionId: inFlight.agentSessionId,
    requestId: inFlight.requestId,
    toolCallId: null,
  });

  // 受理前的提交被取消：调用方等待中的 promise 收口（不悬挂）。
  settlePendingSubmitError(inFlight.requestId, 'cancelled', '本轮已终止（取消或节点删除）。');
}

/**
 * 停止当前会话的在途轮次（spec 06「运行中停止」：发送键双态的停止入口）。
 * 语义为整请求取消（spec 04「取消只中止当前请求」）：已流出的内容按 partial 语义保留，
 * 收口呈现按错误码映射的「已停止这一轮回复。」（见 agentErrorText）。
 * 无在途轮次时不发命令（留痕跳过）。
 */
export function stopCurrentAgentRound(agentSessionId: string): void {
  if (!agentSessionId) return;
  const inFlight = useAgentSessionStore.getState().inFlightBySessionId[agentSessionId];
  if (!inFlight) {
    console.debug('[agentSession] stop skipped: no in-flight round', { agentSessionId });
    return;
  }
  agentSocket.sendCancel({
    type: AGENT_WS_MESSAGE_TYPE.CANCEL,
    agentSessionId,
    requestId: inFlight.requestId,
    // 整请求取消：显式携带空条目标识（线上形状统一，spec 04 单条取消的判别字段）。
    toolCallId: null,
  });
}

/**
 * 取消一条在途工具调用（spec 05「Yolo 语义」单条取消）。
 * 取消命令携带该条目标识：只中止该条目的执行与派生任务，同轮其余条目与整轮继续。
 * 无在途轮次时不发命令（留痕跳过）。
 */
export function cancelAgentToolCall(agentSessionId: string, toolCallId: string): void {
  if (!agentSessionId || !toolCallId) return;
  const inFlight = useAgentSessionStore.getState().inFlightBySessionId[agentSessionId];
  if (!inFlight) {
    console.debug('[agentSession] tool call cancel skipped: no in-flight round', {
      agentSessionId,
      toolCallId,
    });
    return;
  }
  agentSocket.sendCancel({
    type: AGENT_WS_MESSAGE_TYPE.CANCEL,
    agentSessionId,
    requestId: inFlight.requestId,
    toolCallId,
  });
}

/**
 * 提交一批工具提案的勾选决裁（spec 05「Confirm 决裁流程」）。
 *
 * 携带本批**全部未决条目**的执行/不执行完整映射（取消勾选的条目 `execute: false` 即为过滤结果，
 * 「全部不勾选」是合法提交）；投递结果（含未送达原因）供审批面板给对应反馈与重试出口。
 * 无匹配在途轮次（该轮已收口 / 条目不属本会话本轮）时不发送，按「该轮已收口」回报失败，
 * 留痕跳过——这一批不会再被裁定，重试没有意义。
 *
 * 决裁消息的唯一构造出处：面板不自行拼协议形状（契约 `AgentToolDecisionSchema` 批量形态）。
 */
export function submitAgentToolDecisions(
  agentSessionId: string,
  requestId: string,
  decisions: AgentToolDecisionItem[],
): AgentToolDecisionDelivery {
  const inFlight = useAgentSessionStore.getState().inFlightBySessionId[agentSessionId];
  if (!inFlight || inFlight.requestId !== requestId) {
    console.debug('[agentSession] tool decision skipped: no in-flight round for request', {
      agentSessionId,
      requestId,
      inFlightRequestId: inFlight?.requestId ?? null,
    });
    return { delivered: false, reason: 'round_closed' };
  }
  if (decisions.length === 0) {
    // 本端调用契约违约（面板按非空批构造：批内至少一条未决条目）：不构造非法载荷，
    // 按未送达回报（该路径不可达，理由归入批次已无可裁定条目）。
    console.debug('[agentSession] tool decision skipped: empty decisions', {
      agentSessionId,
      requestId,
    });
    return { delivered: false, reason: 'round_closed' };
  }
  return agentSocket.sendToolDecision({
    type: AGENT_WS_MESSAGE_TYPE.TOOL_DECISION,
    requestId,
    agentSessionId,
    decision: 'submit',
    decisions,
  });
}

/**
 * 整轮驳回：把本批全部未决（未派发）条目一次性按不执行结算（spec 05）。
 * 已派发/在途条目不受影响（由 Backend 按先到先结算处理）；无匹配在途轮次时不发送，
 * 按「该轮已收口」回报失败（重试无效）。
 */
export function rejectAgentToolRound(
  agentSessionId: string,
  requestId: string,
): AgentToolDecisionDelivery {
  const inFlight = useAgentSessionStore.getState().inFlightBySessionId[agentSessionId];
  if (!inFlight || inFlight.requestId !== requestId) {
    console.debug('[agentSession] round reject skipped: no in-flight round for request', {
      agentSessionId,
      requestId,
      inFlightRequestId: inFlight?.requestId ?? null,
    });
    return { delivered: false, reason: 'round_closed' };
  }
  return agentSocket.sendToolDecision({
    type: AGENT_WS_MESSAGE_TYPE.TOOL_DECISION,
    requestId,
    agentSessionId,
    decision: 'reject_round',
  });
}

/**
 * 删除节点时终止 + 作废会话（canvas 删除咽喉前置钩子的 agent 侧实现）。
 *
 * 语义（spec 02「删除 Agent 节点 → 先在途终止再删除」）：
 * - 有在途请求 → 立即经 socket 派发 `agent:cancel`（同步，不等待 I/O，不在 store 内 await）；
 *   受理前的等待提交同样按节点归属取消，避免被删除节点上仍挂着未受理的轮次；
 * - 无论有无在途，都把会话从 store 作废：元数据、节点→会话引用、消息缓存、发送留痕、
 *   流式暂态、在途请求、错误态一并摘除。摘除后残留的 `agent:*` 事件被收口守卫丢弃，
 *   不会再对已删除会话写库或抛出用户可见错误。
 *
 * 必须保持同步：调用点是 canvas store 的同步删除事务。
 */
export function cancelAndForgetAgentSessions(nodeIds: readonly string[]): void {
  // 删除节点是显式动作：它带走选中驱动进入的待还原快照（spec 06「显式动作清快照」）。
  // 放在会话遍历之前：非 Agent 节点也会走这条删除咽喉，快照清理不依赖会话是否在途。
  usePromptDockStore.getState().clearAgentEntrySnapshotForNodes(nodeIds);

  const sessionIds = new Set<string>();
  for (const nodeId of nodeIds) {
    if (!nodeId) continue;
    const state = useAgentSessionStore.getState();
    const inFlight = Object.values(state.inFlightBySessionId).find(
      (request) => request.nodeId === nodeId,
    );
    const pendingSubmit = findPendingSubmitByNodeId(nodeId);
    const agentSessionId =
      inFlight?.agentSessionId ??
      state.sessionIdByNodeId[nodeId] ??
      pendingSubmit?.input.agentSessionId ??
      null;

    if (!agentSessionId) {
      // 非 Agent 节点（画布上绝大多数节点）走这里：留痕跳过，不影响删除。
      console.debug('[agentSession] removal forget skipped: node has no agent session', { nodeId });
      continue;
    }

    if (inFlight) {
      agentSocket.sendCancel({
        type: AGENT_WS_MESSAGE_TYPE.CANCEL,
        agentSessionId,
        requestId: inFlight.requestId,
        toolCallId: null,
      });
      // 受理前的提交被取消：调用方等待中的 promise 收口（不悬挂）。
      settlePendingSubmitError(inFlight.requestId, 'cancelled', '本轮已终止（取消或节点删除）。');
    } else if (pendingSubmit) {
      agentSocket.sendCancel({
        type: AGENT_WS_MESSAGE_TYPE.CANCEL,
        agentSessionId,
        requestId: pendingSubmit.input.requestId,
        toolCallId: null,
      });
      settlePendingSubmitError(
        pendingSubmit.input.requestId,
        'cancelled',
        '本轮已终止（取消或节点删除）。',
      );
    } else {
      // 无在途请求：不谎报取消（条件跳过留痕）。
      console.debug('[agentSession] removal forget without in-flight request', {
        nodeId,
        agentSessionId,
      });
    }

    sessionIds.add(agentSessionId);
  }

  if (sessionIds.size === 0) return;
  useAgentSessionStore.getState().forgetSessions([...sessionIds]);
  console.debug('[agentSession] sessions forgotten for removed nodes', {
    nodeIds: [...nodeIds],
    agentSessionIds: [...sessionIds],
  });
}

/**
 * 把「删除节点 → 先在途终止再删除」注册进 canvas 删除咽喉的无环前置钩子。
 *
 * 注册时机：项目加载链调用 `loadAgentSessions` 的同一处显式调用（不在模块 import 时隐式注册）。
 * 幂等：canvas 侧注册位是单槽位覆盖式，重复调用得到同一个注册结果，不叠加多次派发；
 * 这里不另设「已注册」标志位，避免出现与真实注册位不同步的第二事实源。
 */
export function ensureAgentNodeRemovalPreflightRegistered(): void {
  registerNodeRemovalPreflight((nodeIds) => {
    cancelAndForgetAgentSessions(nodeIds);
  });
}

/**
 * 更新会话配置（思考档位 / 审批规则 / 标题）并落库（续作会话改配置）。
 */
export async function updateAgentSessionConfig(
  agentSessionId: string,
  patch: { thinkingTier?: string; approvalMode?: AgentApprovalMode; title?: string },
): Promise<void> {
  if (!agentSessionId) return;
  const projectPath = resolveProjectPath();
  const store = useAgentSessionStore.getState();
  const current = store.sessionsById[agentSessionId];
  if (!projectPath || !current) {
    console.debug('[agentSession] config update skipped', {
      agentSessionId,
      hasProjectPath: Boolean(projectPath),
      hasSession: Boolean(current),
    });
    return;
  }

  const next: AgentSessionRecord = {
    ...current,
    thinkingTier: patch.thinkingTier ?? current.thinkingTier,
    approvalMode: patch.approvalMode ?? current.approvalMode,
    title: patch.title ?? current.title,
    updatedAt: Date.now(),
    // 注意：modelId 不在可改字段内——换模型需另开 Agent 节点（spec 03「会话归属」）。
  };

  const stored = await agentSessionStorage.upsertAgentSession(projectPath, next);
  useAgentSessionStore.getState().upsertSessionRecord(stored);
}

// ────────────────────────────────────────────
// hooks
// ────────────────────────────────────────────

export function useAgentSessionMeta(agentSessionId: string | null): AgentSessionRecord | null {
  return useAgentSessionStore((state) =>
    agentSessionId ? state.sessionsById[agentSessionId] ?? null : null,
  );
}

/**
 * 节点 → 会话稳定引用（工具栏「使用 agent」/ 会话视图打开等以 nodeId 为入口的调用方使用）。
 * 非 hook 版本供事件处理内直接读取。
 */
export function resolveAgentSessionIdByNodeId(nodeId: string | null): string | null {
  if (!nodeId) return null;
  return useAgentSessionStore.getState().sessionIdByNodeId[nodeId] ?? null;
}

/** 节点 → 会话稳定引用的响应式读取（会话随存储加载到达后自动更新）。 */
export function useAgentSessionIdByNodeId(nodeId: string | null): string | null {
  return useAgentSessionStore((state) =>
    nodeId ? state.sessionIdByNodeId[nodeId] ?? null : null,
  );
}

export function useAgentMessages(agentSessionId: string | null): AgentMessageRecord[] {
  return useAgentSessionStore((state) =>
    agentSessionId ? state.messagesBySessionId[agentSessionId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES,
  );
}

export function useAgentStreamingText(agentSessionId: string | null): string {
  return useAgentSessionStore((state) =>
    agentSessionId ? state.streamingBySessionId[agentSessionId] ?? EMPTY_TEXT : EMPTY_TEXT,
  );
}

/** 会话本地发送留痕（先于受理可见的用户意图投影）。 */
export function useAgentSendRecords(agentSessionId: string | null): AgentSendRecord[] {
  return useAgentSessionStore((state) =>
    agentSessionId ? state.sendRecordsBySessionId[agentSessionId] ?? EMPTY_SEND_RECORDS : EMPTY_SEND_RECORDS,
  );
}

/** 会话最近一次错误（可读信息呈现；null 表示无错误）。 */
export function useAgentSessionError(agentSessionId: string | null): AgentSessionError | null {
  return useAgentSessionStore((state) =>
    agentSessionId ? state.errorsBySessionId[agentSessionId] ?? null : null,
  );
}

/** 会话是否在途（用于输入面发送态与终止入口）。 */
export function useAgentSessionInFlight(
  agentSessionId: string | null,
): AgentInFlightRequest | null {
  return useAgentSessionStore((state) =>
    agentSessionId ? state.inFlightBySessionId[agentSessionId] ?? null : null,
  );
}

/** 单条工具调用的活跃态（会话视图提案卡片状态源；null = 无活跃记录，按历史消息渲染）。 */
export function useAgentToolCallLive(
  agentSessionId: string | null,
  toolCallId: string | null,
): AgentToolCallLive | null {
  return useAgentSessionStore((state) =>
    agentSessionId && toolCallId
      ? state.toolCallsLiveBySessionId[agentSessionId]?.[toolCallId] ?? null
      : null,
  );
}

/**
 * 待决提案批：本批全部未决条目 + 批级截止时间（spec 05「Confirm 决裁流程」、
 * spec 06「工具提案交互」）。`items` 顺序即 live 表的插入序（提案到达序）。
 */
export type AgentPendingToolProposalBatch = {
  requestId: string;
  /** 批级截止时间（同批同值，epoch ms）；无截止（yolo 直派发）为 null。 */
  expiresAt: number | null;
  items: AgentToolCallLive[];
};

/**
 * 决裁投递结果（送达 / 未送达且带原因）与失败原因的定义 owner 在 socket 层，
 * 这里转出给界面消费（面板按原因给对应出口，不猜失败理由）。
 */
export type { AgentToolDecisionDelivery, AgentToolDecisionDeliveryFailure } from './agentSocket';

/**
 * 从 live 表派生当前待决提案批（纯函数，供 hook 与测试共用）。
 *
 * 判据两条：条目属于**在途轮次**的 `requestId`，且状态仍是 `proposed`（已提交的条目离开
 * proposed 后自然退出本批——面板据此收起，前端不自行改状态）。无在途轮次或无未决条目时为 null。
 */
export const buildPendingToolProposalBatch = (
  live: Record<string, AgentToolCallLive> | null | undefined,
  inFlight: AgentInFlightRequest | null,
): AgentPendingToolProposalBatch | null => {
  if (!inFlight || !live) return null;
  const items = Object.values(live).filter(
    (entry) => entry.requestId === inFlight.requestId && entry.status === 'proposed',
  );
  if (items.length === 0) return null;
  const deadlines = items
    .map((entry) => entry.proposalExpiresAt)
    .filter((value): value is number => value !== null);
  return {
    requestId: inFlight.requestId,
    expiresAt: deadlines.length > 0 ? Math.min(...deadlines) : null,
    items,
  };
};

/**
 * 当前会话的待决提案批（批量审批面板的数据源）：无在途轮次 / 无未决条目时为 null。
 * 返回对象在 live 表与在途轮次未变时保持引用稳定（zustand 快照比较要求）。
 */
export function useAgentPendingToolProposals(
  agentSessionId: string | null,
): AgentPendingToolProposalBatch | null {
  const live = useAgentSessionStore((state) =>
    agentSessionId ? state.toolCallsLiveBySessionId[agentSessionId] ?? null : null,
  );
  const inFlight = useAgentSessionStore((state) =>
    agentSessionId ? state.inFlightBySessionId[agentSessionId] ?? null : null,
  );
  return useMemo(() => buildPendingToolProposalBatch(live, inFlight), [live, inFlight]);
}
