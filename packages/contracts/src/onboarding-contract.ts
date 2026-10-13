import * as z from 'zod';

/**
 * 首次指引（onboarding）契约。
 *
 * 承载主窗口「首次指引欢迎面」的展示态记忆：用户是否已看过/跳过欢迎指引。
 * 语义边界（docs/hub/首次指引-design.md §3.6 拍板）：
 * - 判定「是否触发指引」的配置状态（有无服务商/有无接入）不在这里——那由
 *   GET /api/provider-connections 与 GET /api/model-deployments 的既有事实源承载，
 *   Hub 只消费，不自建第二套判定（IA §9.1）。
 * - 本状态只回答「用户是否已看过指引」这一个展示态问题；「新装机 vs 删光了服务商」
 *   不区分（拍板口径：删光后重开会再看到一次欢迎面，行为合理）。
 *
 * 存储：Runtime Backend 的 config/onboarding-state.json（独立小文件，
 * 先例 announcement.json；不走 /api/config，
 * 「引导记忆」不是本机配置）。
 */

export const ONBOARDING_GUIDE_SCHEMA_VERSION = 1;

export const OnboardingStateSchema = z
  .object({
    version: z.literal(ONBOARDING_GUIDE_SCHEMA_VERSION),
    updatedAt: z.string(),
    /** 用户已看过/跳过欢迎指引：true 后欢迎模态不再自动出现（帮助中心重放不受此限）。 */
    guideDismissed: z.boolean(),
  })
  .strict();

export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

export const DEFAULT_ONBOARDING_STATE: OnboardingState = {
  version: ONBOARDING_GUIDE_SCHEMA_VERSION,
  updatedAt: new Date(0).toISOString(),
  guideDismissed: false,
};

// ---------------------------------------------------------------------------
// HTTP DTO
// ---------------------------------------------------------------------------

/** GET /api/onboarding-state 响应 */
export const OnboardingStateResponseSchema = z
  .object({
    state: OnboardingStateSchema,
  })
  .strict();

export type OnboardingStateResponse = z.infer<typeof OnboardingStateResponseSchema>;

/** PUT /api/onboarding-state 请求体：只允许写已看标记（其余字段由后端维护）。 */
export const OnboardingStateUpdateBodySchema = z
  .object({
    guideDismissed: z.boolean(),
  })
  .strict();

export type OnboardingStateUpdateBody = z.infer<typeof OnboardingStateUpdateBodySchema>;
