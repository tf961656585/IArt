/**
 * Agent 会话核状态与持久化投影（Editor-local，spec 03-会话存储与IPC契约.md）。
 *
 * 职责：
 * - 会话元数据 / 正式消息 / 本地发送留痕 / 流式暂态的 Editor 侧投影（会话历史的事实源是
 *   会话存储，本 store 不把历史写进画布节点 data，spec 02 禁止项）；
 * - 受理落库的持久化工具（节点/会话/user 消息/assistant 消息 / 元数据刷新）。
 *
 * 分层：`agentSessionState`（本文件，状态与落库）→ `agentRoundEvents`（受理屏障与事件收口）
 * → `agentSessionStore`（对外 API）。单向依赖，无环。
 */

import { create } from 'zustand';

import type {
  AgentApprovalMode,
  AgentError,
  AgentMessageAppendParams,
  AgentMessageRecord,
  AgentReferenceAssetBrief,
  AgentSendRecord,
  AgentSessionRecord,
  AgentToolCallEvent,
  ChatMessageContent,
} from '@iart/contracts';

import { getRuntimeProjectPath } from '@/client/store/runtimeStore';
import type { AgentFailureCode } from './agentErrorText';
import { agentSessionStorage } from './agentSessionStorage';

// ────────────────────────────────────────────
// 钉死的对外 API 类型
// ────────────────────────────────────────────

/** 一次提交的完整输入（首条消息的 `agentSessionId` 也由调用方生成）。 */
export type AgentSubmitInput = {
  requestId: string;
  agentSessionId: string;
  /** null = 首条消息（会话与节点在受理后创建） */
  nodeId: string | null;
  modelId: string;
  /** 'off' 或已启用档位标识 */
  thinkingTier: string;
  approvalMode: AgentApprovalMode;
  content: ChatMessageContent;
  referenceAssetIds: string[];
  /**
   * 引用资产简报（spec 04：Backend 拼模型上下文资产清单 + 工具参数解析媒体输入的依据）。
   * 与 referenceAssetIds 同源（画布资产注册表投影）；缺简报的旧调用方按空清单收敛。
   */
  referenceAssets: AgentReferenceAssetBrief[];
};

export type AgentSubmitResult = { agentSessionId: string; nodeId: string };

/**
 * 会话级错误呈现（供 UI 与调用方消费；不吞错）。
 *
 * `code` 是界面取文案的唯一依据（映射见 agentErrorText）；`message` 只作日志与技术排查材料，
 * 界面不印（可能是后端原文）。
 */
export type AgentSessionError = {
  code: AgentFailureCode;
  message: string;
  requestId: string;
};

/** 在途请求（会话级）：requestId 关联该轮提交，nodeId 在受理后可用。 */
export type AgentInFlightRequest = {
  requestId: string;
  agentSessionId: string;
  nodeId: string | null;
};

/**
 * 工具调用活跃态（spec 04「工具调用循环语义」）：会话视图提案卡片的状态数据源。
 *
 * 只承载「当前进行到哪了」的内存投影；工具调用记录（含历史卡片恢复）的事实源在会话存储
 * （`agent_tool_calls` 表，按会话读取）。终态条目保留在本表用于把 persisted 消息卡片
 * 渲染到最新状态，随 `forgetSessions` / `reset` 摘除。
 *
 * `requestId` 是该条目所属发送请求（提案事件携带）：批量审批面板按「在途请求的未决条目」
 * 取数，轮次收口时也据此只收敛本轮条目——`toolCallId` 本身不带轮次归属。
 */
export type AgentToolCallLive = {
  toolCallId: string;
  requestId: string;
  toolName: string;
  toolKind: AgentToolCallEvent['toolKind'];
  modelId: string | null;
  argsJson: string;
  status: AgentToolCallEvent['status'] | 'succeeded' | 'failed' | 'cancelled' | 'skipped';
  proposalExpiresAt: number | null;
};

/** live 条目的终态集合：终态是运行域已收口的事实，不得被迟到的推进事件压回未收口态。 */
const TERMINAL_TOOL_CALL_STATUSES: ReadonlySet<AgentToolCallLive['status']> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
]);

export const isTerminalToolCallStatus = (
  status: AgentToolCallLive['status'] | null | undefined,
): boolean => status !== null && status !== undefined && TERMINAL_TOOL_CALL_STATUSES.has(status);

/** 轮次收口时未收口条目的收敛去向：未派发提案按未执行结算，已派发在途按取消呈现。 */
const settleStatusForRoundClose = (
  status: AgentToolCallLive['status'],
): AgentToolCallLive['status'] => (status === 'proposed' ? 'skipped' : 'cancelled');

type AgentSessionState = {
  /** 当前项目路径（项目打开时经 loadAgentSessions 注入；提交/落库均按项目作用域） */
  projectPath: string | null;
  sessionsById: Record<string, AgentSessionRecord>;
  sessionIdByNodeId: Record<string, string>;
  messagesBySessionId: Record<string, AgentMessageRecord[]>;
  messagesLoadedSessionIds: Record<string, boolean>;
  /** 消息读取失败（视图据此区分「正在读取 / 读取失败 / 空」，不停在加载态） */
  messagesLoadFailedSessionIds: Record<string, boolean>;
  sendRecordsBySessionId: Record<string, AgentSendRecord[]>;
  /** 在途流式文本（纯内存，不落库） */
  streamingBySessionId: Record<string, string>;
  /** 在途请求（按会话；首条消息在节点创建前也已登记） */
  inFlightBySessionId: Record<string, AgentInFlightRequest>;
  errorsBySessionId: Record<string, AgentSessionError>;
  /** 工具调用活跃态（按会话再按 toolCallId；会话视图提案卡片状态源） */
  toolCallsLiveBySessionId: Record<string, Record<string, AgentToolCallLive>>;

  setProjectPath: (projectPath: string | null) => void;
  upsertSessionRecord: (session: AgentSessionRecord) => void;
  replaceSessions: (sessions: AgentSessionRecord[]) => void;
  setMessages: (agentSessionId: string, messages: AgentMessageRecord[]) => void;
  appendMessageToState: (message: AgentMessageRecord) => void;
  /**
   * 推进会话「最后一条消息时间」（内存投影）：消息落库后按单调更大值写回 `lastMessageAt`。
   * 事实源是存储写入端（`appendAgentMessage` 同事务维护），这里只让内存投影与之一致，
   * 不构造第二口径（`lastMessageAt` 为 null 即「还没有消息」，不用别的字段兜底）。
   */
  advanceSessionLastMessageAt: (agentSessionId: string, createdAt: number) => void;
  /** 标记/清除「消息读取失败」（读取成功或重新开始读取时清除） */
  setMessagesLoadFailed: (agentSessionId: string, failed: boolean) => void;
  setSendRecords: (agentSessionId: string, records: AgentSendRecord[]) => void;
  appendSendRecordToState: (record: AgentSendRecord) => void;
  appendStreamingText: (agentSessionId: string, delta: string) => void;
  clearStreamingText: (agentSessionId: string) => void;
  /**
   * 作废会话：把该会话的元数据、节点→会话引用、消息缓存、发送留痕、流式暂态、
   * 在途请求与错误态一并从 store 摘除（删除 Agent 节点时调用；纯内存操作，不写库）。
   * 摘除后残留的 `agent:*` 事件会被收口守卫丢弃。
   */
  forgetSessions: (agentSessionIds: readonly string[]) => void;
  setInFlight: (agentSessionId: string, request: AgentInFlightRequest | null) => void;
  setSessionError: (agentSessionId: string, error: AgentSessionError | null) => void;
  /**
   * 写入/推进一条 live 条目。**终态单调**：已是终态的条目不会被迟到的
   * `proposed` / `dispatching` / `running` 回写覆盖（事件乱序的守卫，见 agentRoundEvents）。
   */
  upsertToolCallLive: (agentSessionId: string, entry: AgentToolCallLive) => void;
  /**
   * 轮次收口时把该轮仍留在未终态的 live 条目收敛为不可操作终态（防御：正常路径由
   * `agent:tool_result` 逐条收口）。判据是条目自带的 `requestId`，不误伤其他轮次。
   */
  settleRoundToolCalls: (agentSessionId: string, requestId: string) => void;
  reset: () => void;
};

export const EMPTY_MESSAGES: AgentMessageRecord[] = [];
export const EMPTY_SEND_RECORDS: AgentSendRecord[] = [];
export const EMPTY_TEXT = '';

const initialState = {
  projectPath: null,
  sessionsById: {} as Record<string, AgentSessionRecord>,
  sessionIdByNodeId: {} as Record<string, string>,
  messagesBySessionId: {} as Record<string, AgentMessageRecord[]>,
  messagesLoadedSessionIds: {} as Record<string, boolean>,
  messagesLoadFailedSessionIds: {} as Record<string, boolean>,
  sendRecordsBySessionId: {} as Record<string, AgentSendRecord[]>,
  streamingBySessionId: {} as Record<string, string>,
  inFlightBySessionId: {} as Record<string, AgentInFlightRequest>,
  errorsBySessionId: {} as Record<string, AgentSessionError>,
  toolCallsLiveBySessionId: {} as Record<string, Record<string, AgentToolCallLive>>,
};

export const useAgentSessionStore = create<AgentSessionState>()((set) => ({
  ...initialState,

  setProjectPath: (projectPath) => set({ projectPath }),

  upsertSessionRecord: (session) =>
    set((state) => ({
      sessionsById: { ...state.sessionsById, [session.agentSessionId]: session },
      sessionIdByNodeId: { ...state.sessionIdByNodeId, [session.nodeId]: session.agentSessionId },
    })),

  replaceSessions: (sessions) =>
    set(() => {
      const sessionsById: Record<string, AgentSessionRecord> = {};
      const sessionIdByNodeId: Record<string, string> = {};
      for (const session of sessions) {
        sessionsById[session.agentSessionId] = session;
        sessionIdByNodeId[session.nodeId] = session.agentSessionId;
      }
      return { sessionsById, sessionIdByNodeId };
    }),

  setMessages: (agentSessionId, messages) =>
    set((state) => {
      const messagesLoadFailedSessionIds = { ...state.messagesLoadFailedSessionIds };
      // 读到了就是成功：失败标记随加载完成一并摘除（失败→重试成功的路径不留残态）。
      delete messagesLoadFailedSessionIds[agentSessionId];
      return {
        messagesBySessionId: { ...state.messagesBySessionId, [agentSessionId]: messages },
        messagesLoadedSessionIds: { ...state.messagesLoadedSessionIds, [agentSessionId]: true },
        messagesLoadFailedSessionIds,
      };
    }),

  setMessagesLoadFailed: (agentSessionId, failed) =>
    set((state) => {
      const messagesLoadFailedSessionIds = { ...state.messagesLoadFailedSessionIds };
      if (failed) {
        messagesLoadFailedSessionIds[agentSessionId] = true;
      } else {
        delete messagesLoadFailedSessionIds[agentSessionId];
      }
      return { messagesLoadFailedSessionIds };
    }),

  appendMessageToState: (message) =>
    set((state) => {
      const current = state.messagesBySessionId[message.agentSessionId] ?? EMPTY_MESSAGES;
      return {
        messagesBySessionId: {
          ...state.messagesBySessionId,
          [message.agentSessionId]: [...current, message],
        },
      };
    }),

  advanceSessionLastMessageAt: (agentSessionId, createdAt) =>
    set((state) => {
      const session = state.sessionsById[agentSessionId];
      if (!session) {
        // 条件跳过必须留痕：会话不在投影里（未加载 / 已作废）时不建影子记录。
        console.debug('[agentSession] last message time skipped: session not in store', {
          agentSessionId,
          createdAt,
        });
        return { sessionsById: state.sessionsById };
      }
      const current = session.lastMessageAt;
      if (current !== null && current >= createdAt) {
        // 单调不回退：补写历史消息（更早时间）不得把该列拉回去。
        return { sessionsById: state.sessionsById };
      }
      return {
        sessionsById: {
          ...state.sessionsById,
          [agentSessionId]: { ...session, lastMessageAt: createdAt },
        },
      };
    }),

  setSendRecords: (agentSessionId, records) =>
    set((state) => ({
      sendRecordsBySessionId: { ...state.sendRecordsBySessionId, [agentSessionId]: records },
    })),

  appendSendRecordToState: (record) =>
    set((state) => {
      const current = state.sendRecordsBySessionId[record.agentSessionId] ?? [];
      return {
        sendRecordsBySessionId: {
          ...state.sendRecordsBySessionId,
          [record.agentSessionId]: [...current, record],
        },
      };
    }),

  appendStreamingText: (agentSessionId, delta) =>
    set((state) => ({
      streamingBySessionId: {
        ...state.streamingBySessionId,
        [agentSessionId]: (state.streamingBySessionId[agentSessionId] ?? EMPTY_TEXT) + delta,
      },
    })),

  clearStreamingText: (agentSessionId) =>
    set((state) => ({
      streamingBySessionId: { ...state.streamingBySessionId, [agentSessionId]: EMPTY_TEXT },
    })),

  forgetSessions: (agentSessionIds) => {
    const forgottenIds = new Set(agentSessionIds.filter((agentSessionId) => agentSessionId.length > 0));
    if (forgottenIds.size === 0) {
      // 条件跳过必须留痕（非 Agent 节点删除等场景）。
      console.debug('[agentSession] forget skipped: empty session id set');
      return;
    }
    set((state) => {
      const sessionsById = { ...state.sessionsById };
      const sessionIdByNodeId = { ...state.sessionIdByNodeId };
      const messagesBySessionId = { ...state.messagesBySessionId };
      const messagesLoadedSessionIds = { ...state.messagesLoadedSessionIds };
      const messagesLoadFailedSessionIds = { ...state.messagesLoadFailedSessionIds };
      const sendRecordsBySessionId = { ...state.sendRecordsBySessionId };
      const streamingBySessionId = { ...state.streamingBySessionId };
      const inFlightBySessionId = { ...state.inFlightBySessionId };
      const errorsBySessionId = { ...state.errorsBySessionId };
      const toolCallsLiveBySessionId = { ...state.toolCallsLiveBySessionId };

      for (const agentSessionId of forgottenIds) {
        const session = sessionsById[agentSessionId];
        if (session) {
          // 节点 → 会话引用同步摘除；引用已指向别的会话时不误删。
          if (sessionIdByNodeId[session.nodeId] === agentSessionId) {
            delete sessionIdByNodeId[session.nodeId];
          }
          delete sessionsById[agentSessionId];
        }
        delete messagesBySessionId[agentSessionId];
        delete messagesLoadedSessionIds[agentSessionId];
        delete messagesLoadFailedSessionIds[agentSessionId];
        delete sendRecordsBySessionId[agentSessionId];
        delete streamingBySessionId[agentSessionId];
        delete inFlightBySessionId[agentSessionId];
        delete errorsBySessionId[agentSessionId];
        delete toolCallsLiveBySessionId[agentSessionId];
      }

      return {
        sessionsById,
        sessionIdByNodeId,
        messagesBySessionId,
        messagesLoadedSessionIds,
        messagesLoadFailedSessionIds,
        sendRecordsBySessionId,
        streamingBySessionId,
        inFlightBySessionId,
        errorsBySessionId,
      };
    });
  },

  setInFlight: (agentSessionId, request) =>
    set((state) => {
      const next = { ...state.inFlightBySessionId };
      if (request === null) {
        delete next[agentSessionId];
      } else {
        next[agentSessionId] = request;
      }
      return { inFlightBySessionId: next };
    }),

  setSessionError: (agentSessionId, error) =>
    set((state) => {
      const next = { ...state.errorsBySessionId };
      if (error === null) {
        delete next[agentSessionId];
      } else {
        next[agentSessionId] = error;
      }
      return { errorsBySessionId: next };
    }),

  upsertToolCallLive: (agentSessionId, entry) =>
    set((state) => {
      const existing = state.toolCallsLiveBySessionId[agentSessionId]?.[entry.toolCallId] ?? null;
      if (isTerminalToolCallStatus(existing?.status) && !isTerminalToolCallStatus(entry.status)) {
        // 条件跳过必须留痕：终态先到、推进事件迟到（事件乱序），不得把卡片压回未收口状态。
        console.debug('[agentSession] tool call live write ignored: terminal state already settled', {
          agentSessionId,
          toolCallId: entry.toolCallId,
          settled: existing?.status,
          incoming: entry.status,
        });
        return { toolCallsLiveBySessionId: state.toolCallsLiveBySessionId };
      }
      return {
        toolCallsLiveBySessionId: {
          ...state.toolCallsLiveBySessionId,
          [agentSessionId]: {
            ...(state.toolCallsLiveBySessionId[agentSessionId] ?? {}),
            [entry.toolCallId]: entry,
          },
        },
      };
    }),

  settleRoundToolCalls: (agentSessionId, requestId) =>
    set((state) => {
      const live = state.toolCallsLiveBySessionId[agentSessionId];
      if (!live) {
        console.debug('[agentSession] round tool call sweep skipped: session has no live entries', {
          agentSessionId,
          requestId,
        });
        return { toolCallsLiveBySessionId: state.toolCallsLiveBySessionId };
      }
      const next: Record<string, AgentToolCallLive> = { ...live };
      const settledIds: string[] = [];
      for (const entry of Object.values(live)) {
        if (entry.requestId !== requestId) continue;
        if (isTerminalToolCallStatus(entry.status)) continue;
        const status = settleStatusForRoundClose(entry.status);
        next[entry.toolCallId] = { ...entry, status, proposalExpiresAt: null };
        settledIds.push(entry.toolCallId);
      }
      if (settledIds.length === 0) return { toolCallsLiveBySessionId: state.toolCallsLiveBySessionId };
      console.debug('[agentSession] round tool call sweep: unsettled entries closed with round', {
        agentSessionId,
        requestId,
        settledIds,
      });
      return {
        toolCallsLiveBySessionId: { ...state.toolCallsLiveBySessionId, [agentSessionId]: next },
      };
    }),

  reset: () => set({ ...initialState }),
}));

// ────────────────────────────────────────────
// 持久化投影工具（受理落库 / 元数据刷新）
// ────────────────────────────────────────────

let idCounter = 0;
export const createLocalId = (prefix: string): string =>
  `${prefix}_${Date.now()}_${(idCounter += 1).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export const resolveProjectPath = (): string | null =>
  useAgentSessionStore.getState().projectPath ?? getRuntimeProjectPath();

/**
 * 构造会话级错误呈现。
 * `code` 默认取契约码；本端合成的连接级失败由调用方显式给 `connection_unavailable`。
 */
export const buildSessionError = (
  message: AgentError,
  code: AgentFailureCode = message.code,
): AgentSessionError => ({
  code,
  message: message.message,
  requestId: message.requestId,
});

/** 内容是否可落库（`partialContent` 非空判定；空串与空数组视为无内容）。 */
export const hasMessageContent = (content: ChatMessageContent | null | undefined): boolean => {
  if (content === null || content === undefined) return false;
  if (typeof content === 'string') return content.trim().length > 0;
  return content.some((part) =>
    part.type === 'text' ? part.text.trim().length > 0 : part.url.trim().length > 0,
  );
};

export const buildUserMessageAppendParams = (params: {
  agentSessionId: string;
  requestId: string;
  content: ChatMessageContent;
  createdAt: number;
}): AgentMessageAppendParams => ({
  agentSessionId: params.agentSessionId,
  role: 'user',
  requestId: params.requestId,
  body: { kind: 'chat', content: params.content },
  plan: null,
  createdAt: params.createdAt,
  isPartial: false,
});

export const buildAssistantMessageAppendParams = (params: {
  agentSessionId: string;
  requestId: string;
  content: ChatMessageContent;
  createdAt: number;
  isPartial: boolean;
}): AgentMessageAppendParams => ({
  agentSessionId: params.agentSessionId,
  role: 'assistant',
  requestId: params.requestId,
  body: { kind: 'chat', content: params.content },
  plan: null,
  createdAt: params.createdAt,
  isPartial: params.isPartial,
});

/** 追加正式消息并同步 store 投影（seq 由存储写入端分配）。 */
export const appendFormalMessage = async (
  projectPath: string,
  params: AgentMessageAppendParams,
): Promise<AgentMessageRecord | null> => {
  try {
    const stored = await agentSessionStorage.appendAgentMessage(projectPath, params);
    useAgentSessionStore.getState().appendMessageToState(stored);
    // 会话「最后一条消息时间」由存储写入端在同事务维护；内存投影同步推进（单调更大值），
    // 让节点副行 / 会话视图不必等下一次元数据刷新才看到新时间。
    useAgentSessionStore
      .getState()
      .advanceSessionLastMessageAt(stored.agentSessionId, stored.createdAt);
    return stored;
  } catch (error) {
    console.warn('[agentSession] append message failed', {
      agentSessionId: params.agentSessionId,
      role: params.role,
      error,
    });
    return null;
  }
};

/**
 * 刷新会话元数据（`messageCount` / `updatedAt` 由存储写入端维护，这里只读最新值）。
 * 读取失败不阻断主链（元数据刷新是投影补全，不是事实写入）。
 */
export const refreshSessionMeta = async (projectPath: string, agentSessionId: string): Promise<void> => {
  const session = useAgentSessionStore.getState().sessionsById[agentSessionId];
  if (!session) return;
  try {
    const latest = await agentSessionStorage.readAgentSessionByNodeId(projectPath, session.nodeId);
    if (latest) {
      useAgentSessionStore.getState().upsertSessionRecord(latest);
    } else {
      console.debug('[agentSession] session meta refresh found no row', { agentSessionId });
    }
  } catch (error) {
    console.warn('[agentSession] session meta refresh failed', { agentSessionId, error });
  }
};
