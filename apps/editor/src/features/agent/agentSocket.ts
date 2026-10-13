/**
 * Agent 执行管道 WS 客户端（`agent:*` 主链，spec 04-执行管道与WS协议.md）。
 *
 * 连接形态：长连接到既有 `/ws/business`（URL 构造复用 businessActionSocket 的
 * `buildBusinessActionSocketUrl`，不另立第二套 URL 规则）。
 * 与 chatActionSocket（长连接 + requestId 关联 + token 回调）同范式，区别在于本通道
 * 承载 agent 会话流式与取消。
 *
 * 错误收口（spec 04 / 仓库「远端请求不自动重试」）：
 * - 连接不可用、socket error、socket close 时，所有在途请求立即收到一条 `agent:error`
 *   （code `execution_failed`），绝不静默挂起、不自动重连、不补发、不切换 endpoint；
 * - 下一次用户发送会重新建连（用户动作驱动的重连，不是自动重试）。
 *
 * 文案口径：本文件里的错误串是「本端合成的失败」的原始描述（同时进日志），用户可见文案由
 * 错误码映射给出（见 agentErrorText：无会话归属的本端失败按 `connection_unavailable` 呈现），
 * 因此这里的措辞也按用户语言写（「这一轮回复」「这条消息」），不出现实现术语。
 */

import {
  AGENT_WS_MESSAGE_TYPE,
  AgentClientMessageSchema,
  AgentErrorSchema,
  AgentServerMessageSchema,
  type AgentAccepted,
  type AgentAssistantMessageEvent,
  type AgentCancel,
  type AgentClientMessage,
  type AgentComplete,
  type AgentError,
  type AgentSubmitPrompt,
  type AgentToolCallEvent,
  type AgentToolDecision,
  type AgentToolResultEvent,
  type AgentToken,
} from '@iart/contracts';
import { buildBusinessActionSocketUrl } from '@/client/utils/businessActionSocket';

type SocketState = 'idle' | 'connecting' | 'connected' | 'disconnected';

/** 服务端消息分发句柄（按 `type` 分派，消息已过 schema 校验）。 */
export type AgentSocketHandlers = {
  onAccepted: (message: AgentAccepted) => void;
  onToken: (message: AgentToken) => void;
  onAssistantMessage: (message: AgentAssistantMessageEvent) => void;
  onToolCall: (message: AgentToolCallEvent) => void;
  onToolResult: (message: AgentToolResultEvent) => void;
  onComplete: (message: AgentComplete) => void;
  onError: (message: AgentError) => void;
};

const CONNECTION_UNAVAILABLE_MESSAGE = '连不上，这一次回复没有完成，请重试。';

/**
 * 决裁投递失败原因（界面据此给不同出口，见审批面板）：
 * - `connection_unavailable`：连接不可用，命令没发出去（恢复后重试有效）；
 * - `round_closed`：该轮已收口（无匹配在途轮次），这一批不会再被裁定（重试恒无效）。
 * 本层只可能产出 `connection_unavailable`；`round_closed` 由调用方按在途轮次判据产出。
 */
export type AgentToolDecisionDeliveryFailure = 'connection_unavailable' | 'round_closed';

/** 决裁投递结果：送达 / 未送达且给出原因（调用方不猜失败理由）。 */
export type AgentToolDecisionDelivery =
  | { delivered: true }
  | { delivered: false; reason: AgentToolDecisionDeliveryFailure };

export const isAgentWsMessageType = (value: unknown): boolean =>
  typeof value === 'string' && value.startsWith('agent:');

export class AgentSocketClient {
  private ws: WebSocket | null = null;
  private state: SocketState = 'idle';
  private readonly handlers = new Set<AgentSocketHandlers>();
  /** 建连期间暂存的待发消息（open 后按序 flush）。 */
  private outbox: AgentClientMessage[] = [];
  /** 在途 requestId（收到 accepted 后仍保留，直到 complete / error / 断线收口）。 */
  private readonly pendingRequestIds = new Set<string>();

  /** 订阅服务端消息；返回取消订阅函数。 */
  subscribe(handlers: AgentSocketHandlers): () => void {
    this.handlers.add(handlers);
    return () => {
      this.handlers.delete(handlers);
    };
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  /**
   * 发送提交消息。连接不可用（URL 不在本地回环 / WebSocket 不可用）时立即失败：
   * 该 requestId 收到 `agent:error`，调用方无需等待。
   */
  sendSubmitPrompt(message: AgentSubmitPrompt): void {
    this.pendingRequestIds.add(message.requestId);
    this.send(this.validateClientMessage(message));
  }

  /** 发送取消消息；取消不经 pending 集（其生命周期由 submit 的 requestId 收口）。 */
  sendCancel(message: AgentCancel): void {
    if (!this.buildAndFlush(this.validateClientMessage(message))) {
      // 取消命令发不出去：不断言在途状态，记录后可追踪（条件跳过必须留痕）。
      console.warn('[agentSocket] cancel not delivered (socket unavailable)', {
        agentSessionId: message.agentSessionId,
        requestId: message.requestId,
      });
    }
  }

  /**
   * 发送 confirm 档提案批的决裁（`submit` 勾选提交 / `reject_round` 整轮驳回，spec 05）。
   *
   * 返回投递结果：未送达时携带原因（连接不可用），调用方（审批面板）据此给对应的失败反馈与
   * 重试出口；本层只留痕，不自行重试、不补救。
   */
  sendToolDecision(message: AgentToolDecision): AgentToolDecisionDelivery {
    const delivered = this.buildAndFlush(this.validateClientMessage(message));
    if (!delivered) {
      // 条件跳过必须留痕（决策未送达）：按原因分流的用户可见反馈由调用方承担。
      console.debug('[agentSocket] tool decision not delivered (socket unavailable)', {
        agentSessionId: message.agentSessionId,
        requestId: message.requestId,
        decision: message.decision,
        decisionCount: message.decision === 'submit' ? message.decisions.length : 0,
      });
      return { delivered: false, reason: 'connection_unavailable' };
    }
    return { delivered: true };
  }

  /**
   * 出站契约校验：只校验、不替换原对象。
   *
   * `.parse()` 的返回值会剥离契约尚未登记的字段（zod 对象默认 strip），若直接发送返回值，
   * 「契约先落后发 / 后落先发」的顺序会决定字段是否真正到达 Backend（如 `projectPath`）。
   * 因此这里只用 parse 做边界校验，发送仍用调用方构造的原对象。
   */
  private validateClientMessage<T extends AgentClientMessage>(message: T): T {
    AgentClientMessageSchema.parse(message);
    return message;
  }

  /** 主动断开（窗口关闭等）；在途请求按断线口径收口。 */
  disconnect(): void {
    const socket = this.ws;
    this.ws = null;
    this.setState('idle');
    if (socket) {
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
    this.failPendingRequests('连接中断了，这一轮回复没有完成。');
  }

  private send(message: AgentClientMessage): void {
    if (this.buildAndFlush(message)) return;
    this.failRequest(message, CONNECTION_UNAVAILABLE_MESSAGE);
  }

  /**
   * 建立连接并发送（连接中则入队）。返回 false 表示连接无法建立 —— 由调用方决定收口语义。
   */
  private buildAndFlush(message: AgentClientMessage): boolean {
    if (this.state === 'connected' && this.ws) {
      this.write(message);
      return true;
    }
    if (!this.ensureSocket()) return false;
    this.outbox.push(message);
    this.flushOutbox();
    return true;
  }

  private write(message: AgentClientMessage): void {
    const ws = this.ws;
    if (!ws) return;
    try {
      ws.send(JSON.stringify(message));
    } catch (error) {
      console.warn('[agentSocket] send failed', error);
      this.failRequest(message, '这条消息没能发出，请重试。');
    }
  }

  private ensureSocket(): boolean {
    if (this.ws && (this.state === 'connected' || this.state === 'connecting')) return true;

    const socketUrl = buildBusinessActionSocketUrl();
    if (!socketUrl || typeof WebSocket === 'undefined') {
      this.setState('disconnected');
      return false;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(socketUrl);
    } catch (error) {
      console.warn('[agentSocket] create socket failed', error);
      this.setState('disconnected');
      return false;
    }

    this.ws = socket;
    this.setState('connecting');
    socket.addEventListener('open', () => {
      if (this.ws !== socket) return;
      this.setState('connected');
      this.flushOutbox();
    });
    socket.addEventListener('message', (event) => {
      if (this.ws !== socket) return;
      this.handleIncoming(event.data);
    });
    socket.addEventListener('error', () => {
      if (this.ws !== socket) return;
      console.warn('[agentSocket] socket error');
      this.ws = null;
      this.setState('disconnected');
      this.outbox = [];
      this.failPendingRequests('连接中断了，这一轮回复没有完成。');
    });
    socket.addEventListener('close', () => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.setState('disconnected');
      this.outbox = [];
      this.failPendingRequests('连接中断了，这一轮回复没有完成。');
    });
    return true;
  }

  private flushOutbox(): void {
    if (this.state !== 'connected' || !this.ws) return;
    const queued = this.outbox;
    this.outbox = [];
    for (const message of queued) {
      this.write(message);
    }
  }

  private handleIncoming(raw: unknown): void {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(String(raw));
    } catch {
      console.warn('[agentSocket] incoming message is not valid JSON');
      return;
    }

    const parsed = AgentServerMessageSchema.safeParse(parsedJson);
    if (!parsed.success) {
      // 非 agent 消息（同一 socket 承载其他消息族）：留痕跳过，不打断连接。
      const messageType =
        parsedJson !== null && typeof parsedJson === 'object'
          ? (parsedJson as { type?: unknown }).type
          : undefined;
      if (!isAgentWsMessageType(messageType)) {
        console.debug('[agentSocket] ignored non-agent message', { type: messageType });
        return;
      }
      // 形如 agent:* 但结构不合法：按失败收口，不让在途请求挂起。
      console.warn('[agentSocket] malformed agent message', { type: messageType });
      this.failRequestById(readRequestId(parsedJson), '这一轮回复中断了，可以再发一次。');
      return;
    }

    const message = parsed.data;
    switch (message.type) {
      case AGENT_WS_MESSAGE_TYPE.ACCEPTED:
        this.dispatch((handler) => handler.onAccepted(message));
        break;
      case AGENT_WS_MESSAGE_TYPE.TOKEN:
        this.dispatch((handler) => handler.onToken(message));
        break;
      case AGENT_WS_MESSAGE_TYPE.ASSISTANT_MESSAGE:
        this.dispatch((handler) => handler.onAssistantMessage(message));
        break;
      case AGENT_WS_MESSAGE_TYPE.TOOL_CALL:
        this.dispatch((handler) => handler.onToolCall(message));
        break;
      case AGENT_WS_MESSAGE_TYPE.TOOL_RESULT:
        this.dispatch((handler) => handler.onToolResult(message));
        break;
      case AGENT_WS_MESSAGE_TYPE.COMPLETE:
        this.pendingRequestIds.delete(message.requestId);
        this.dispatch((handler) => handler.onComplete(message));
        break;
      case AGENT_WS_MESSAGE_TYPE.ERROR:
        this.pendingRequestIds.delete(message.requestId);
        this.dispatch((handler) => handler.onError(message));
        break;
      default:
        break;
    }
  }

  private dispatch(apply: (handler: AgentSocketHandlers) => void): void {
    for (const handler of this.handlers) {
      apply(handler);
    }
  }

  /** 连接级失败：为每个在途 requestId 生成 `agent:error` 收口。 */
  private failPendingRequests(message: string): void {
    const pending = Array.from(this.pendingRequestIds);
    this.pendingRequestIds.clear();
    for (const requestId of pending) {
      this.emitSyntheticError(requestId, message);
    }
  }

  private failRequest(message: AgentClientMessage, errorMessage: string): void {
    this.pendingRequestIds.delete(message.requestId);
    this.emitSyntheticError(message.requestId, errorMessage);
  }

  private failRequestById(requestId: string | null, errorMessage: string): void {
    if (requestId === null) return;
    this.pendingRequestIds.delete(requestId);
    this.emitSyntheticError(requestId, errorMessage);
  }

  private emitSyntheticError(requestId: string, message: string): void {
    const error: AgentError = AgentErrorSchema.parse({
      type: AGENT_WS_MESSAGE_TYPE.ERROR,
      requestId,
      agentSessionId: '',
      code: 'execution_failed',
      message,
      partialContent: null,
    });
    this.dispatch((handler) => handler.onError(error));
  }

  private setState(next: SocketState): void {
    this.state = next;
  }
}

const readRequestId = (value: unknown): string | null => {
  if (value === null || typeof value !== 'object') return null;
  const raw = (value as { requestId?: unknown }).requestId;
  return typeof raw === 'string' && raw.trim() ? raw : null;
};

/** 全局 agent socket 实例（长连接，按需建连）。 */
export const agentSocket = new AgentSocketClient();
