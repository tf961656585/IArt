/**
 * 临时补全 WebSocket 连接管理
 *
 * 持久 WebSocket 连接，用于编辑器文本 AI 能力（如 TextInput 节点「AI 修改」）
 * 的临时 Chat Completion 流式通信。
 * 与 businessActionSocket 的 per-action 短连接模式不同，临时补全需要维持长连接。
 *
 * 对话区域已退役（决策 #21），会话级流式（chat:send_message 等）随之移除；
 * 本模块只保留临时补全通道（chat:temporary_completion）。
 */

import { buildBusinessActionSocketUrl } from '@/client/utils/businessActionSocket';
import {
  CHAT_WS_MESSAGE_TYPE,
  type ChatServerMessage,
  type ChatTemporaryCompletion,
  isChatServerMessage,
} from '@iart/contracts';

type SocketState = 'idle' | 'connecting' | 'connected' | 'disconnected';

type TemporaryCompletionResult = {
  message: unknown;
  usage: unknown;
};

type TemporaryCompletionEntry = {
  message: ChatTemporaryCompletion;
  sent: boolean;
  onToken: (text: string) => void;
  resolve: (result: TemporaryCompletionResult) => void;
  reject: (error: Error) => void;
};

const normalizeString = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed || '';
};

class TemporaryCompletionSocket {
  private ws: WebSocket | null = null;
  private state: SocketState = 'idle';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manualDisconnect = false;
  private temporaryRequests = new Map<string, TemporaryCompletionEntry>();

  requestTemporaryCompletion(
    message: ChatTemporaryCompletion,
    handlers: { onToken: (text: string) => void },
  ): Promise<TemporaryCompletionResult> {
    const requestId = normalizeString(message.requestId);
    if (!requestId) {
      return Promise.reject(new Error('缺少临时调用 ID'));
    }
    if (this.temporaryRequests.has(requestId)) {
      return Promise.reject(new Error('临时调用 ID 已存在'));
    }

    return new Promise<TemporaryCompletionResult>((resolve, reject) => {
      this.temporaryRequests.set(requestId, {
        message,
        sent: false,
        onToken: handlers.onToken,
        resolve,
        reject,
      });
      this.manualDisconnect = false;
      if (!this.ensureSocket()) {
        this.temporaryRequests.delete(requestId);
        reject(new Error('聊天连接暂时不可用，请稍后重试。'));
        return;
      }
      this.flushTemporaryRequests();
    });
  }

  private ensureSocket(): boolean {
    if (this.ws && (this.state === 'connected' || this.state === 'connecting')) {
      return true;
    }

    const socketUrl = buildBusinessActionSocketUrl();
    if (!socketUrl) {
      console.warn('[TemporaryCompletionSocket] WebSocket URL 不可用');
      this.setState('disconnected');
      this.scheduleReconnect();
      return false;
    }

    this.cleanup();
    this.setState('connecting');

    const socket = (() => {
      try {
        return new WebSocket(socketUrl);
      } catch (error) {
        console.warn('[TemporaryCompletionSocket] 创建 WebSocket 失败', error);
        this.setState('disconnected');
        this.scheduleReconnect();
        return null;
      }
    })();

    if (socket === null) {
      return false;
    }

    this.ws = socket;

    try {
      socket.addEventListener('open', () => {
        if (this.ws !== socket) return;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.manualDisconnect = false;
        this.ws = socket;
        this.setState('connected');
        this.flushTemporaryRequests();
      });

      socket.addEventListener('message', (event) => {
        if (this.ws !== socket) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(event.data));
        } catch {
          return;
        }

        if (!isChatServerMessage(parsed)) return;

        const msg = parsed as ChatServerMessage;
        switch (msg.type) {
          case CHAT_WS_MESSAGE_TYPE.TEMPORARY_TOKEN:
            {
              const request = this.temporaryRequests.get(msg.requestId);
              if (request !== undefined) {
                request.onToken(msg.text);
              }
            }
            break;
          case CHAT_WS_MESSAGE_TYPE.TEMPORARY_COMPLETE: {
            const request = this.temporaryRequests.get(msg.requestId);
            if (request) {
              this.temporaryRequests.delete(msg.requestId);
              request.resolve({ message: msg.message, usage: msg.usage });
            }
            break;
          }
          case CHAT_WS_MESSAGE_TYPE.TEMPORARY_ERROR: {
            const request = this.temporaryRequests.get(msg.requestId);
            if (request) {
              this.temporaryRequests.delete(msg.requestId);
              request.reject(new Error(msg.error));
            }
            break;
          }
          default:
            break;
        }
      });

      socket.addEventListener('error', () => {
        if (this.ws !== socket) return;
        console.warn('[TemporaryCompletionSocket] WebSocket 错误');
        this.rejectTemporaryRequests(new Error('聊天连接出错了，请重试。'));
      });

      socket.addEventListener('close', () => {
        if (this.ws !== socket) return;
        this.ws = null;
        this.rejectTemporaryRequests(new Error('聊天连接已断开，请重试。'));
        if (this.manualDisconnect) {
          this.setState('idle');
          return;
        }
        this.setState('disconnected');
        this.scheduleReconnect();
      });
    } catch (error) {
      console.warn('[TemporaryCompletionSocket] 绑定 WebSocket 事件失败', error);
      try {
        socket.close();
      } catch {
        // ignore
      }
      if (this.ws === socket) {
        this.ws = null;
      }
      this.setState('disconnected');
      this.scheduleReconnect();
      return false;
    }
    return true;
  }

  disconnect(): void {
    this.manualDisconnect = true;
    this.cleanup();
    this.setState('idle');
    this.rejectTemporaryRequests(new Error('聊天连接已关闭，请重试。'));
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  private setState(next: SocketState): void {
    this.state = next;
  }

  private scheduleReconnect(): void {
    if (this.manualDisconnect) {
      return;
    }
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureSocket();
    }, 3000);
  }

  private flushTemporaryRequests(): void {
    if (!this.ws || this.state !== 'connected') return;
    for (const [requestId, entry] of this.temporaryRequests) {
      if (entry.sent) continue;
      try {
        this.ws.send(JSON.stringify(entry.message));
        this.temporaryRequests.set(requestId, { ...entry, sent: true });
      } catch (error) {
        this.temporaryRequests.delete(requestId);
        entry.reject(error instanceof Error ? error : new Error('消息发送失败，请重试。'));
        this.setState('disconnected');
        this.scheduleReconnect();
      }
    }
  }

  private rejectTemporaryRequests(error: Error): void {
    if (this.temporaryRequests.size === 0) return;
    const entries = Array.from(this.temporaryRequests.values());
    this.temporaryRequests.clear();
    for (const entry of entries) {
      entry.reject(error);
    }
  }

  private cleanup(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
  }
}

export const chatActionSocket = new TemporaryCompletionSocket();
