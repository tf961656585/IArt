/* @vitest-environment node */

import { describe, expect, it } from 'vitest';
import { CHAT_ADAPTER_IDS } from '@iart/contracts';
import {
  ANTHROPIC_THINKING_BUDGETS,
  ANTHROPIC_THINKING_REPLY_HEADROOM,
  canChatAdapterExpressThinkingTier,
  resolveAnthropicThinking,
  resolveGeminiThinkingLevel,
  resolveOpenAIReasoningEffort,
} from '../src/thinking-tiers';

/**
 * 思考档位 → 厂商参数翻译（spec 37「思考档位」）。
 *
 * 本文件钉住两侧一致：契约侧 `supports_custom_thinking_tiers`（Hub 勾选与后端写入校验的依据）
 * 与适配器侧实际能不能把档位落到请求上。自定义档位只在 OpenAI 系可表达。
 */

const BUILTIN_TIERS = ['minimal', 'low', 'medium', 'high'] as const;
const CUSTOM_TIER = 'ultra';

describe('思考档位翻译：不思考', () => {
  it('缺省或空值一律不产生厂商字段', () => {
    expect(resolveOpenAIReasoningEffort(undefined)).toBeNull();
    expect(resolveOpenAIReasoningEffort('')).toBeNull();
    expect(resolveOpenAIReasoningEffort('   ')).toBeNull();
    expect(resolveAnthropicThinking(undefined)).toBeNull();
    expect(resolveGeminiThinkingLevel(undefined)).toBeNull();
  });
});

describe('思考档位翻译：内置档位四家均可表达', () => {
  it('OpenAI 系原样透传内置档位值', () => {
    for (const tier of BUILTIN_TIERS) {
      expect(resolveOpenAIReasoningEffort(tier)).toBe(tier);
    }
  });

  it('Anthropic 映射为 thinking 预算，且预算表覆盖全部内置档位', () => {
    for (const tier of BUILTIN_TIERS) {
      const thinking = resolveAnthropicThinking(tier);
      expect(thinking).toEqual({ type: 'enabled', budget_tokens: ANTHROPIC_THINKING_BUDGETS[tier] });
    }
    // 档位越强预算越大：表本身必须是单调的，否则「高」档反而比「中」档想得少
    const budgets = BUILTIN_TIERS.map((tier) => ANTHROPIC_THINKING_BUDGETS[tier] ?? 0);
    const sorted = [...budgets].sort((a, b) => a - b);
    expect(budgets).toEqual(sorted);
    expect(ANTHROPIC_THINKING_REPLY_HEADROOM).toBeGreaterThan(0);
  });

  it('Gemini 映射为 thinkingLevel 枚举（大写）', () => {
    for (const tier of BUILTIN_TIERS) {
      expect(resolveGeminiThinkingLevel(tier)).toBe(tier.toUpperCase());
    }
  });
});

describe('思考档位翻译：自定义档位只在 OpenAI 系可表达', () => {
  it('OpenAI 系透传自定义档位值（用户与服务商约定的值）', () => {
    expect(resolveOpenAIReasoningEffort(CUSTOM_TIER)).toBe(CUSTOM_TIER);
    expect(canChatAdapterExpressThinkingTier('openai_chat', CUSTOM_TIER)).toBe(true);
    expect(canChatAdapterExpressThinkingTier('openai_responses', CUSTOM_TIER)).toBe(true);
  });

  it('Anthropic 与 Gemini 表达不了自定义档位', () => {
    expect(resolveAnthropicThinking(CUSTOM_TIER)).toBeNull();
    expect(resolveGeminiThinkingLevel(CUSTOM_TIER)).toBeNull();
    expect(canChatAdapterExpressThinkingTier('anthropic_messages', CUSTOM_TIER)).toBe(false);
    expect(canChatAdapterExpressThinkingTier('gemini', CUSTOM_TIER)).toBe(false);
  });

  it('契约侧声明的可表达性与适配器侧一致', () => {
    // 契约侧 flag 是 Hub 勾选与后端写入校验的依据；两侧不一致会出现「配得上、发不出」的档位
    for (const adapterId of CHAT_ADAPTER_IDS) {
      const expectedOpenAI = adapterId === 'openai_chat' || adapterId === 'openai_responses';
      expect(canChatAdapterExpressThinkingTier(adapterId, CUSTOM_TIER)).toBe(expectedOpenAI);
      for (const tier of BUILTIN_TIERS) {
        expect(canChatAdapterExpressThinkingTier(adapterId, tier)).toBe(true);
      }
    }
  });
});
