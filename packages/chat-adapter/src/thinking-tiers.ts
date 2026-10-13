import { isBuiltinThinkingTier, type ChatAdapterId } from '@iart/contracts';

/**
 * 思考档位 → 厂商参数的唯一翻译点（spec 37「思考档位」：协议翻译由连接的协议适配器承担，
 * 运行时、Hub 与创作面不得各自维护并列的厂商参数映射）。
 *
 * 档位是用户侧统一语义；这里把它落到各家的请求字段：
 * - OpenAI 对话 / Responses：`reasoning_effort` / `reasoning.effort`，值是自由字符串，
 *   所以内置档位与自定义档位都原样透传（自定义档位是用户与服务商约定的值）。
 * - Anthropic：`thinking.budget_tokens`（token 预算，数值）→ 内置档位有固定预算表；
 *   自定义档位是字符串、无法表达，返回 null。
 * - Gemini：`thinkingConfig.thinkingLevel`（有限枚举 MINIMAL/LOW/MEDIUM/HIGH）→ 只接受内置档位。
 *
 * 与 `packages/contracts` 的 `supports_custom_thinking_tiers` 是同一口径的两侧落点：
 * 契约侧给 Hub 与后端写入校验用（能不能勾选/能不能存），本侧决定实际发什么。
 * 两侧一致由各自单测钉住（见 `packages/chat-adapter/src/__tests__`）。
 */

/** Anthropic thinking 预算表：档位越强，允许的思考 token 越多。 */
export const ANTHROPIC_THINKING_BUDGETS: Record<string, number> = {
  minimal: 1024,
  low: 4096,
  medium: 8192,
  high: 16384,
};

/** Anthropic 要求 `max_tokens` 大于思考预算，预留的回复空间。 */
export const ANTHROPIC_THINKING_REPLY_HEADROOM = 1024;

/**
 * OpenAI 系（Chat Completions / Responses）：档位值直接作为 `reasoning_effort` / `reasoning.effort`。
 * 内置与自定义档位一律透传；空值返回 null（不发字段）。
 */
export const resolveOpenAIReasoningEffort = (tier: string | undefined): string | null => {
  const trimmed = tier?.trim() ?? '';
  return trimmed ? trimmed : null;
};

/**
 * Anthropic：`thinking: { type: 'enabled', budget_tokens }`。自定义档位无法用数值表达，返回 null。
 */
export const resolveAnthropicThinking = (
  tier: string | undefined,
): { type: 'enabled'; budget_tokens: number } | null => {
  const trimmed = tier?.trim() ?? '';
  if (!trimmed) return null;
  const budget = ANTHROPIC_THINKING_BUDGETS[trimmed];
  return typeof budget === 'number' ? { type: 'enabled', budget_tokens: budget } : null;
};

/**
 * Gemini：`thinkingConfig.thinkingLevel`（MINIMAL/LOW/MEDIUM/HIGH）。自定义档位无法表达，返回 null。
 */
export const resolveGeminiThinkingLevel = (tier: string | undefined): string | null => {
  const trimmed = tier?.trim() ?? '';
  if (!trimmed) return null;
  return isBuiltinThinkingTier(trimmed) ? trimmed.toUpperCase() : null;
};

/** 该适配器能否把某个档位落到请求上（自定义档位只在 OpenAI 系可表达）。 */
export const canChatAdapterExpressThinkingTier = (adapterId: ChatAdapterId, tier: string): boolean =>
  adapterId === 'openai_chat' || adapterId === 'openai_responses'
    ? resolveOpenAIReasoningEffort(tier) !== null
    : adapterId === 'anthropic_messages'
      ? resolveAnthropicThinking(tier) !== null
      : resolveGeminiThinkingLevel(tier) !== null;
