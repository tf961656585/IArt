import * as z from 'zod';

/**
 * 思考档位契约（spec 37「思考档位（thinking）」）。
 *
 * 档位是**用户侧统一语义**，不等同于任何一家厂商 API 的参数字面量。统一档位到厂商参数的
 * 翻译由该模型的协议适配器承担（`@iart/chat-adapter`；2026-09-26 起协议归属模型级），运行时、
 * Hub 与创作面不得各自维护并列映射。
 *
 * - `off`（不思考）恒定可用、不参与声明，也不出现在预设池里：任何对话模型都接受它。
 * - 内置档位随 app 版本固定，是档位标识的唯一来源。
 * - 自定义档位由用户在全局预设池中添加；标识即展示名（spec 01：档位名直显主窗口的配置值）。
 */

export const THINKING_TIER_OFF = 'off';
export type ThinkingTierOff = typeof THINKING_TIER_OFF;

export const BUILTIN_THINKING_TIERS = ['minimal', 'low', 'medium', 'high'] as const;
export type BuiltinThinkingTier = (typeof BUILTIN_THINKING_TIERS)[number];

/**
 * 档位标识：内置档位标识与自定义档位名共用一套字符集。
 *
 * 档位标识会被原样放进请求参数并透传给厂商档位字段，所以限制为无空白、无引号的短标识。
 * 长度与字符集以常量暴露：主窗口要用同一个值把规则写进提示与输入校验，
 * 各处自行写死数字会在规则调整后出现「界面说一套、写入拦一套」。
 */
export const THINKING_TIER_NAME_MIN_LENGTH = 1;
export const THINKING_TIER_NAME_MAX_LENGTH = 32;
export const THINKING_TIER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export const ThinkingTierSchema = z
  .string()
  .min(THINKING_TIER_NAME_MIN_LENGTH)
  .max(THINKING_TIER_NAME_MAX_LENGTH)
  .regex(THINKING_TIER_NAME_PATTERN);

export type ThinkingTier = z.infer<typeof ThinkingTierSchema>;

export const isBuiltinThinkingTier = (tier: string): tier is BuiltinThinkingTier =>
  (BUILTIN_THINKING_TIERS as readonly string[]).includes(tier);

// ---------------------------------------------------------------------------
// 全局预设池（GET /api/thinking-tiers）
// ---------------------------------------------------------------------------

export const ThinkingTierPresetSchema = z
  .object({
    /** 档位标识（即展示名，spec 01「档位名直显主窗口的配置值」） */
    name: ThinkingTierSchema,
    /** 已被多少个模型启用（按 model_id 去重，同一模型的多条接入算一个；Hub 删除确认文案用它说明影响面） */
    used_by_models: z.number().int().nonnegative(),
  })
  .strict();

export type ThinkingTierPreset = z.infer<typeof ThinkingTierPresetSchema>;

export const ThinkingTierPoolSchema = z
  .object({
    builtin: z.array(ThinkingTierSchema),
    custom: z.array(ThinkingTierPresetSchema),
  })
  .strict();

export type ThinkingTierPool = z.infer<typeof ThinkingTierPoolSchema>;

export const ThinkingTierPoolResponseSchema = z.object({ pool: ThinkingTierPoolSchema }).strict();
export type ThinkingTierPoolResponse = z.infer<typeof ThinkingTierPoolResponseSchema>;

export const ThinkingTierRemovalResponseSchema = z
  .object({
    /** 删除自定义档位后，被级联清理掉该档位的模型数（按 model_id 去重，与该档位的 used_by_models 同一口径） */
    removed_from_models: z.number().int().nonnegative(),
  })
  .strict();

/**
 * 自定义档位数量上限。
 *
 * 由 Runtime Backend 强制执行、由主窗口在提示里说明，是**跨边界共享的策略值**，owner 在 contracts：
 * 两处各写一份会在调整上限时出现「界面写 20、实际拦在 30」的分叉。
 */
export const CUSTOM_THINKING_TIER_LIMIT = 20;

export type ThinkingTierRemovalResponse = z.infer<typeof ThinkingTierRemovalResponseSchema>;
