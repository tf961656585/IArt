import * as z from 'zod';
import {
  CUSTOM_THINKING_TIER_LIMIT,
  THINKING_TIER_NAME_MAX_LENGTH,
  THINKING_TIER_NAME_MIN_LENGTH,
  ThinkingTierPoolResponseSchema,
  ThinkingTierRemovalResponseSchema,
  ThinkingTierSchema,
} from '@iart/contracts';
import * as constantsModule from '../constants.cts';
import * as httpUtilsModule from '../http-utils.cts';
import { readJsonBodyOrSendError } from '../http/json-route.cts';
import type { RouteDefinition } from '../http/route-registry.cts';
import * as loggingModule from '../logging.cts';
import {
  addCustomThinkingTier,
  listBuiltinThinkingTiers,
  listCustomThinkingTierNames,
  removeCustomThinkingTier,
} from '../provider-connection/thinking-tier-store.cts';
import {
  countChatModelsUsingTier,
  stripThinkingTierFromChatModels,
} from '../provider-connection/custom-chat-model-store.cts';

/**
 * 思考档位全局预设池路由（spec 37「思考档位」）。
 *
 * - GET    /api/thinking-tiers              池子（内置档 + 自定义档，自定义档带被启用数）
 * - POST   /api/thinking-tiers              新增自定义档 {name}
 * - DELETE /api/thinking-tiers/:name        删除自定义档（级联清理各模型的启用关系）
 *
 * 写入进 Hub write token 白名单（hub-local-write-policy）；启用关系不在这里写，
 * 走自建对话模型记录的 enabled_thinking_tiers（PUT /api/custom-chat-models/:modelId，
 * spec 37 v4.0.0：档位随自建对话模型记录走，原 ModelDeployment 档位字段已退役）。
 */

const { ERROR_CODES } = constantsModule;
const { sendJson, sendError } = httpUtilsModule;

const NO_STORE_HEADERS = (corsHeaders: Record<string, string>): Record<string, string> => ({
  ...corsHeaders,
  'Cache-Control': 'no-store',
});

const splitPathname = (pathname: string): string[] => pathname.split('/').filter(Boolean);

const ThinkingTierCreateBodySchema = z.object({ name: ThinkingTierSchema }).strict();

/**
 * 池子里一个自定义档位被多少个**模型**启用。
 *
 * 档位启用关系随自建对话模型记录走（spec 37 v4.0.0）；每个记录的 model_id 全局唯一，
 * 按记录数即模型数。界面用的是「几个模型会失去这个档位」。
 */
const countModelsUsingTier = (tier: string): number => countChatModelsUsingTier(tier);

const buildPoolPayload = (): unknown => ({
  pool: {
    builtin: listBuiltinThinkingTiers(),
    custom: listCustomThinkingTierNames().map((name) => ({
      name,
      used_by_models: countModelsUsingTier(name),
    })),
  },
});

const createThinkingTierRoutes = (): RouteDefinition[] => [
  {
    name: 'thinking-tiers',
    match: ({ req, pathname }) =>
      (req.method === 'GET' || req.method === 'POST') && pathname === '/api/thinking-tiers',
    handle: async ({ req, res, corsHeaders }) => {
      if (req.method === 'GET') {
        sendJson(res, 200, ThinkingTierPoolResponseSchema.parse(buildPoolPayload()), NO_STORE_HEADERS(corsHeaders));
        return;
      }
      const body = await readJsonBodyOrSendError(req, res, corsHeaders);
      if (body == null) return;
      const parsed = ThinkingTierCreateBodySchema.safeParse(body);
      if (!parsed.success) {
        sendError(
          res,
          400,
          ERROR_CODES.INVALID_CONFIG,
          `档位名无效：需为 ${THINKING_TIER_NAME_MIN_LENGTH}–${THINKING_TIER_NAME_MAX_LENGTH} 位字母、数字、下划线或短横线，且以字母或数字开头（上限 ${CUSTOM_THINKING_TIER_LIMIT} 个自定义档位）`,
          corsHeaders,
        );
        return;
      }
      const created = addCustomThinkingTier(parsed.data.name);
      if (!created) {
        sendError(
          res,
          409,
          'conflict',
          '该档位名已被内置档位占用或已存在（内置档位与「不思考」不可重名）',
          corsHeaders,
        );
        return;
      }
      sendJson(res, 200, ThinkingTierPoolResponseSchema.parse(buildPoolPayload()), NO_STORE_HEADERS(corsHeaders));
    },
  },
  {
    name: 'thinking-tiers-by-name',
    match: ({ req, pathname }) => {
      const segs = splitPathname(pathname);
      return segs[0] === 'api' && segs[1] === 'thinking-tiers' && segs.length === 3 && req.method === 'DELETE';
    },
    handle: ({ res, pathname, corsHeaders }) => {
      const rawName = splitPathname(pathname)[2] ?? '';
      const name = decodeURIComponent(rawName);
      if (!removeCustomThinkingTier(name)) {
        sendError(res, 404, ERROR_CODES.NOT_FOUND, '没有这个自定义档位', corsHeaders);
        return;
      }
      // spec 37 v4.0.0：删除自定义档时级联清理引用它的模型启用关系（档位随自建对话记录走）
      const removedFromModels = stripThinkingTierFromChatModels(name);
      if (removedFromModels > 0) {
        loggingModule.logDebug('[thinking-tier-routes] custom tier removed and cascaded', {
          name,
          removedFromModels,
        });
      }
      sendJson(
        res,
        200,
        ThinkingTierRemovalResponseSchema.parse({ removed_from_models: removedFromModels }),
        NO_STORE_HEADERS(corsHeaders),
      );
    },
  },
];

export { createThinkingTierRoutes };
