import type { InternalMessage } from './types.js';

/**
 * 粗略估算 token 数：中文 × 2，英文 / 4
 */
export function estimateTokens(text: string): number {
  let count = 0;
  for (const char of text) {
    count += char.charCodeAt(0) > 0x7f ? 2 : 0.25;
  }
  return Math.ceil(count);
}

function getMessageTokens(msg: InternalMessage): number {
  if (msg.tokenCount != null) return msg.tokenCount;
  const content = typeof msg.content === 'string'
    ? msg.content
    : msg.content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('');
  return estimateTokens(content);
}

/**
 * 按 context window 截断消息历史。
 *
 * 策略：保留 system prompt（已在外部处理），从最新消息向前保留，
 * 累计 token 超过 contextWindowTokens 时截断最早的 user/assistant 消息。
 */
export function truncateToContextWindow(
  messages: InternalMessage[],
  contextWindowTokens: number,
): InternalMessage[] {
  let totalTokens = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    totalTokens += getMessageTokens(msg);
    if (totalTokens > contextWindowTokens) {
      return messages.slice(i + 1);
    }
  }

  return messages;
}
