import {
  OnboardingStateResponseSchema,
  OnboardingStateUpdateBodySchema,
} from '@iart/contracts';
import * as constantsModule from '../constants.cts';
import * as httpUtilsModule from '../http-utils.cts';
import { readJsonBodyOrSendError } from '../http/json-route.cts';
import type { RouteDefinition } from '../http/route-registry.cts';
import { readOnboardingState, setGuideDismissed } from '../onboarding/onboarding-store.cts';

/**
 * 首次指引展示态路由（docs/hub/首次指引-design.md §4.1）。
 *
 * - GET /api/onboarding-state          当前展示态记忆（guideDismissed 等）
 * - PUT  /api/onboarding-state         写已看标记 { guideDismissed: boolean }
 *
 * 写入进 Hub write token 白名单（hub-local-write-policy）。
 * 判定「是否触发指引」的配置状态不经过本路由：Hub 直接消费 GET /api/provider-connections
 * （IA §9.1 不自建判定；2026-10-19 起判据只有「零服务商」一条）。
 */

const { ERROR_CODES } = constantsModule;
const { sendJson, sendError } = httpUtilsModule;

const NO_STORE_HEADERS = (corsHeaders: Record<string, string>): Record<string, string> => ({
  ...corsHeaders,
  'Cache-Control': 'no-store',
});

const createOnboardingRoutes = (): RouteDefinition[] => [
  {
    name: 'onboarding-state',
    match: ({ req, pathname }) =>
      (req.method === 'GET' || req.method === 'PUT') && pathname === '/api/onboarding-state',
    handle: async ({ req, res, corsHeaders }) => {
      if (req.method === 'GET') {
        sendJson(res, 200, OnboardingStateResponseSchema.parse({ state: readOnboardingState() }), NO_STORE_HEADERS(corsHeaders));
        return;
      }
      const body = await readJsonBodyOrSendError(req, res, corsHeaders);
      if (body == null) return;
      const parsed = OnboardingStateUpdateBodySchema.safeParse(body);
      if (!parsed.success) {
        sendError(res, 400, ERROR_CODES.INVALID_CONFIG, '请求体无效：guideDismissed 必须是布尔值', corsHeaders);
        return;
      }
      const state = setGuideDismissed(parsed.data.guideDismissed);
      sendJson(res, 200, OnboardingStateResponseSchema.parse({ state }), NO_STORE_HEADERS(corsHeaders));
    },
  },
];

export { createOnboardingRoutes };
