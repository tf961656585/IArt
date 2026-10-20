import {
  CHAT_CONTEXT_WINDOW_MAX_TOKENS,
  CHAT_CONTEXT_WINDOW_MIN_TOKENS,
  CHAT_MAX_OUTPUT_TOKENS_MAX,
  CHAT_MAX_OUTPUT_TOKENS_MIN,
  CustomChatModelCreateBodySchema,
  CustomChatModelListResponseSchema,
  CustomChatModelRemovalResponseSchema,
  CustomChatModelResponseSchema,
  CustomChatModelUpdateBodySchema,
  canAdapterExpressThinkingTier,
} from '@iart/contracts';
import * as constantsModule from '../constants.cts';
import * as httpUtilsModule from '../http-utils.cts';
import { readJsonBodyOrSendError } from '../http/json-route.cts';
import type { RouteDefinition } from '../http/route-registry.cts';
import * as loggingModule from '../logging.cts';
import {
  addCustomChatModel,
  getCustomChatModel,
  listCustomChatModels,
  removeCustomChatModel,
  updateCustomChatModel,
} from '../provider-connection/custom-chat-model-store.cts';
import { describeConnectionOwnershipError } from '../provider-connection/custom-model-ownership.cts';
import { getAdapter } from '../protocol-adapter/adapter-registry.cts';
import { isPoolThinkingTier } from '../provider-connection/thinking-tier-store.cts';
import { clearActiveDeployment, setActiveDeployment } from '../provider-connection/active-route-store.cts';

/**
 * 自建对话模型记录路由（spec 03 §6.1「Deployment 与自建模型记录」、spec 37 v4.0.0）。
 *
 * - GET    /api/custom-chat-models             已添加的自建对话模型记录
 * - POST   /api/custom-chat-models             一次写入完成添加 {model_id, connection_id, protocol_adapter_id, remote_model_id?, 能力两字段?}
 * - PUT    /api/custom-chat-models/:modelId    改记录的可改属性（能力两字段 + 档位两字段整体替换）
 * - DELETE /api/custom-chat-models/:modelId    删除记录（active route 由本路由级联清理）
 *
 * 2026-09-25 起「声明 + 接入」合并为单记录：接入归属（connection_id +
 * remote_model_id）与能力属性一体，思考档位也随记录走（原 PUT /api/model-deployments/:id
 * 的档位启用关系入口随声明层退役）。写入进 Hub write token 白名单（hub-local-write-policy）。
 * POST 成功后由后端把该记录写入 active route（保持「添加即可用」的用户可见行为）。
 */

const { ERROR_CODES } = constantsModule;
const { sendJson, sendError } = httpUtilsModule;

const NO_STORE_HEADERS = (corsHeaders: Record<string, string>): Record<string, string> => ({
  ...corsHeaders,
  'Cache-Control': 'no-store',
});

const splitPathname = (pathname: string): string[] => pathname.split('/').filter(Boolean);

/**
 * 把请求体校验失败落到出错的那个字段上。
 *
 * 各字段的取值范围各不相同，笼统报「模型名无效」会把用户引到没填错的那个输入框。
 * 范围数字取契约常量而非字面量，避免界面承诺的范围与这里提示的范围静默分叉。
 */
const describeBodyError = (issues: readonly { path: readonly PropertyKey[] }[]): string => {
  const field = issues[0]?.path[0];
  if (field === 'connection_id') {
    return '没能确定要添加到哪个服务商，关掉这个窗口后重新打开再试';
  }
  if (field === 'protocol_adapter_id') {
    return '接口类型无效，请重新选择';
  }
  if (field === 'remote_model_id') {
    return '服务商那边的模型 ID 不能为空';
  }
  if (field === 'context_window_tokens') {
    return `上下文窗口无效：需为 ${CHAT_CONTEXT_WINDOW_MIN_TOKENS}–${CHAT_CONTEXT_WINDOW_MAX_TOKENS} 之间的整数`;
  }
  if (field === 'max_output_tokens') {
    return `最大输出 token 无效：需为 ${CHAT_MAX_OUTPUT_TOKENS_MIN}–${CHAT_MAX_OUTPUT_TOKENS_MAX} 之间的整数，或不填`;
  }
  if (field === 'enabled_thinking_tiers' || field === 'default_thinking_tier') {
    return '思考档位无效：需为已启用的档位名';
  }
  return '模型 ID 只能用字母、数字、.、_、-，且以字母或数字开头';
};

/**
 * 档位启用关系的写入校验（spec 37；原 deployment-store 的校验随档位字段迁移至此）。
 *
 * 档位必须在池子里（内置档或自定义档），且自定义档位只能挂在档位字段值域为自由字符串的
 * 协议上。2026-09-26 起协议归属模型级：可表达性按**记录自带的协议**校验（创建体携带），
 * 不再读连接。
 * 返回 null = 通过。
 */
const describeThinkingTierError = (protocolAdapterId: string, tiers: string[]): string | null => {
  if (tiers.length === 0) return null;
  const adapter = getAdapter(protocolAdapterId);
  if (!adapter) return `接口类型无效（${protocolAdapterId}）`;
  if (adapter.family !== 'chat') {
    return `思考档位需要对话接口类型，当前是 ${protocolAdapterId}`;
  }
  for (const tier of tiers) {
    if (!isPoolThinkingTier(tier)) return `没有「${tier}」这个思考档位，请先在档位设置里添加`;
    if (!canAdapterExpressThinkingTier(adapter, tier)) {
      return `当前接口类型表达不了「${tier}」这个自定义思考档位`;
    }
  }
  return null;
};

const createCustomChatModelRoutes = (): RouteDefinition[] => [
  {
    name: 'custom-chat-models',
    match: ({ req, pathname }) =>
      (req.method === 'GET' || req.method === 'POST') && pathname === '/api/custom-chat-models',
    handle: async ({ req, res, corsHeaders }) => {
      if (req.method === 'GET') {
        sendJson(
          res,
          200,
          CustomChatModelListResponseSchema.parse({ models: listCustomChatModels() }),
          NO_STORE_HEADERS(corsHeaders),
        );
        return;
      }
      const body = await readJsonBodyOrSendError(req, res, corsHeaders);
      if (body == null) return;
      const parsed = CustomChatModelCreateBodySchema.safeParse(body);
      if (!parsed.success) {
        sendError(res, 400, ERROR_CODES.INVALID_CONFIG, describeBodyError(parsed.error.issues), corsHeaders);
        return;
      }
      // 一次写入第一段：归属校验（连接存在、enabled、有凭证；协议由请求体自带，不在连接上校验）
      const ownershipError = describeConnectionOwnershipError(parsed.data.connection_id);
      if (ownershipError !== null) {
        sendError(res, 400, ERROR_CODES.INVALID_CONFIG, ownershipError, corsHeaders);
        return;
      }
      // 一次写入第一段（续）：档位随创建一次落库（spec 37），可表达性按记录自带的协议校验
      const tierError = describeThinkingTierError(parsed.data.protocol_adapter_id, parsed.data.enabled_thinking_tiers ?? []);
      if (tierError !== null) {
        sendError(res, 400, ERROR_CODES.INVALID_CONFIG, tierError, corsHeaders);
        return;
      }
      const result = addCustomChatModel({
        model_id: parsed.data.model_id,
        connection_id: parsed.data.connection_id,
        protocol_adapter_id: parsed.data.protocol_adapter_id,
        ...(parsed.data.remote_model_id === undefined ? {} : { remote_model_id: parsed.data.remote_model_id }),
        ...(parsed.data.context_window_tokens === undefined
          ? {}
          : { context_window_tokens: parsed.data.context_window_tokens }),
        // 省略与显式 null 同义（不声明输出上限），在此收敛成 null 交给 store。
        max_output_tokens: parsed.data.max_output_tokens ?? null,
        ...(parsed.data.enabled_thinking_tiers === undefined
          ? {}
          : { enabled_thinking_tiers: parsed.data.enabled_thinking_tiers }),
        ...(parsed.data.default_thinking_tier === undefined
          ? {}
          : { default_thinking_tier: parsed.data.default_thinking_tier }),
      });
      if (!result.ok) {
        if (result.reason === 'duplicate_generation_record') {
          sendError(res, 409, 'conflict', '这个名字已经用于一个生成模型，不能再用作对话模型的模型 ID，换一个模型 ID，或先删除那个生成模型', corsHeaders);
          return;
        }
        sendError(res, 409, 'conflict', '已经添加过这个模型了，换一个模型 ID，或先删除它再重新添加', corsHeaders);
        return;
      }
      // 一次写入最后一段：把新记录设为当前使用（保持「添加即可用」的用户可见行为）
      const activated = setActiveDeployment(result.model.model_id, result.model.record_id);
      if (activated === null) {
        loggingModule.logDebug('[custom-chat-model-routes] create: active route write failed', {
          modelId: result.model.model_id,
          recordId: result.model.record_id,
        });
      }
      const stored = getCustomChatModel(result.model.model_id) ?? result.model;
      sendJson(
        res,
        200,
        CustomChatModelResponseSchema.parse({ model: stored }),
        NO_STORE_HEADERS(corsHeaders),
      );
    },
  },
  {
    name: 'custom-chat-models-by-id',
    match: ({ req, pathname }) => {
      const segs = splitPathname(pathname);
      return (
        segs[0] === 'api' &&
        segs[1] === 'custom-chat-models' &&
        segs.length === 3 &&
        (req.method === 'PUT' || req.method === 'DELETE')
      );
    },
    handle: async ({ req, res, pathname, corsHeaders }) => {
      const modelId = decodeURIComponent(splitPathname(pathname)[2] ?? '');
      if (req.method === 'PUT') {
        const body = await readJsonBodyOrSendError(req, res, corsHeaders);
        if (body == null) return;
        const parsed = CustomChatModelUpdateBodySchema.safeParse(body);
        if (!parsed.success) {
          sendError(res, 400, ERROR_CODES.INVALID_CONFIG, describeBodyError(parsed.error.issues), corsHeaders);
          return;
        }
        const existing = getCustomChatModel(modelId);
        if (existing === null) {
          sendError(res, 404, ERROR_CODES.NOT_FOUND, '没有这个模型', corsHeaders);
          return;
        }
        // 档位启用校验按记录自带的协议（协议归属模型级、创建后不可变，改档位不换协议）
        const tierError = describeThinkingTierError(existing.protocol_adapter_id, parsed.data.enabled_thinking_tiers);
        if (tierError !== null) {
          sendError(res, 400, ERROR_CODES.INVALID_CONFIG, tierError, corsHeaders);
          return;
        }
        const updated = updateCustomChatModel(modelId, {
          context_window_tokens: parsed.data.context_window_tokens,
          max_output_tokens: parsed.data.max_output_tokens,
          enabled_thinking_tiers: parsed.data.enabled_thinking_tiers,
          default_thinking_tier: parsed.data.default_thinking_tier,
        });
        if (updated === null) {
          sendError(res, 404, ERROR_CODES.NOT_FOUND, '没有这个模型', corsHeaders);
          return;
        }
        sendJson(
          res,
          200,
          CustomChatModelResponseSchema.parse({ model: updated }),
          NO_STORE_HEADERS(corsHeaders),
        );
        return;
      }
      if (!removeCustomChatModel(modelId)) {
        sendError(res, 404, ERROR_CODES.NOT_FOUND, '没有这个模型', corsHeaders);
        return;
      }
      // 删除自建记录时级联清理它的「当前使用」标记（记录即接入，无需再清 deployment）。
      const clearedRoute = clearActiveDeployment(modelId);
      loggingModule.logDebug('[custom-chat-model-routes] custom model record removed', {
        modelId,
        activeRouteCleared: clearedRoute,
      });
      sendJson(
        res,
        200,
        CustomChatModelRemovalResponseSchema.parse({ model_id: modelId }),
        NO_STORE_HEADERS(corsHeaders),
      );
    },
  },
];

export { createCustomChatModelRoutes };
