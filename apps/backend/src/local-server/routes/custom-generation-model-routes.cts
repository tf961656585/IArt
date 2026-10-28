import {
  CustomGenerationModelCreateBodySchema,
  CustomGenerationModelListResponseSchema,
  CustomGenerationModelRemovalResponseSchema,
  CustomGenerationModelResponseSchema,
  CustomGenerationModelUpdateBodySchema,
  type GenerationMediaSlotId,
  type ParameterOverrides,
} from '@iart/contracts';
import * as constantsModule from '../constants.cts';
import * as httpUtilsModule from '../http-utils.cts';
import { readJsonBodyOrSendError } from '../http/json-route.cts';
import type { RouteDefinition } from '../http/route-registry.cts';
import * as loggingModule from '../logging.cts';
import {
  addCustomGenerationModel,
  getCustomGenerationModel,
  listCustomGenerationModels,
  removeCustomGenerationModel,
  updateCustomGenerationModel,
} from '../provider-connection/custom-generation-model-store.cts';
import { describeConnectionOwnershipError } from '../provider-connection/custom-model-ownership.cts';
import { clearActiveDeployment, setActiveDeployment } from '../provider-connection/active-route-store.cts';
import {
  buildFamilyTemplateBaseSources,
  checkFamilyMediaSlotSupport,
  getFamilyTemplate,
} from '../generation-family-templates.registry.cts';
import { getInterfaceFormat } from '../interface-format/registry.cts';
import {
  EMPTY_PARAMETER_OVERRIDES,
  validateParameterOverrides,
} from '../generation-parameter-overrides.cts';

/**
 * 自建生成模型记录路由（spec 03 §6.1「Deployment 与自建模型记录」，2026-09-25 单记录形态，
 * 形态镜像对话侧 custom-chat-model-routes）。
 *
 * - GET    /api/custom-generation-models             已添加的自建生成模型记录
 * - POST   /api/custom-generation-models             一次写入完成添加 {model_id, connection_id, family_adapter_id, ...}
 * - PUT    /api/custom-generation-models/:modelId    改可改属性（accepted_media_slots / parameter_overrides 整体替换）
 * - DELETE /api/custom-generation-models/:modelId    删除记录（active route 由本路由级联清理）
 *
 * 2026-09-25 起「声明 + 接入」合并为单记录：接入归属（connection_id +
 * remote_model_id）与能力属性一体。归属校验只要求连接存在、启用、有凭证——连接不约束
 * 协议族（2026-09-26 起协议归属模型级）。
 * 写入进 Hub write token 白名单（hub-local-write-policy）。POST 成功后由后端把该记录写入
 * active route（保持「添加即可用」的用户可见行为）。声明不承载协议语义，endpoint、请求规则
 * 与参数表单全部来自族模板（试点设计 C1；参数覆盖是受控例外，生成模型参数高级自定义设计
 * §3.3——保存前用与投影合成同一套校验入口验证）。
 */

const { ERROR_CODES } = constantsModule;
const { sendJson, sendError } = httpUtilsModule;

const NO_STORE_HEADERS = (corsHeaders: Record<string, string>): Record<string, string> => ({
  ...corsHeaders,
  'Cache-Control': 'no-store',
});

const splitPathname = (pathname: string): string[] => pathname.split('/').filter(Boolean);

/**
 * 把请求体校验失败落到出错的那个字段上（与对话侧同一思路）。
 *
 * `model_id` 与 `accepted_media_slots` 是用户填写的字段，提示要说清填什么；
 * `family_adapter_id` 由表单按用户所选接口类型带上，校验失败只会来自直接调用方；
 * `parameter_overrides` 形状非法时给专指提示（语义级原因由覆盖校验器逐条给出）。
 */
const describeBodyError = (issues: readonly { path: readonly PropertyKey[] }[]): string => {
  const field = issues[0]?.path[0];
  if (field === 'connection_id') {
    return '没能确定要添加到哪个服务商，关掉这个窗口后重新打开再试';
  }
  if (field === 'remote_model_id') {
    return '服务商那边的模型 ID 不能为空';
  }
  if (field === 'accepted_media_slots') {
    return '素材设置无效，请重试';
  }
  if (field === 'family_adapter_id') {
    return '这个模型 ID 不能用在这类服务商上';
  }
  if (field === 'parameter_overrides') {
    return '高级参数自定义的数据格式无效';
  }
  if (field === 'recipe_id') {
    return '接口配方的标识格式不对，请重新选择一份配方';
  }
  return '模型 ID 只能用字母、数字、.、_、-，且以字母或数字开头';
};

/**
 * 写入侧的接口格式可用性守卫（2026-10-26）。
 *
 * 契约自本批起只约束 `family_adapter_id` 的形状（`InterfaceFormatIdSchema`），不再有封闭枚举；
 * 「这个 id 是不是一个可用接口格式」只能由实体注册表裁定：未登记 = 非法输入（拼写错误 /
 * 已移除的旧 id），pending = 合法格式但运行时规则未就绪。两者都必须给可读拒绝，
 * 而不是把一条注定合成不出模板的记录写进配置。
 *
 * 返回 null = 通过；否则返回可读原因。
 */
const describeFamilyAvailability = (familyAdapterId: string): string | null => {
  const entry = getFamilyTemplate(familyAdapterId);
  if (entry === null) {
    loggingModule.logDebug('[custom-generation-model-routes] unknown interface format id', {
      familyAdapterId,
    });
    return '这个接口类型不能用于生成模型';
  }
  if (entry.status !== 'ready') {
    loggingModule.logDebug('[custom-generation-model-routes] interface format pending, record refused', {
      familyAdapterId,
      pendingReason: entry.pendingReason,
    });
    return '这个接口类型还在支持中，暂时不能添加这类模型';
  }
  return null;
};

/**
 * 用户自建格式的配方必填守卫（2026-10-26 批次 B5a）。
 *
 * 用户自建格式没有内置行为，判定与结果形态只能来自配方：没有配方 = 一条永远判不出成功的记录。
 * 预设格式仍可选（它们带内置默认判定）。store 里有同一份判断（写入的唯一落盘入口），这里
 * 先挡一次是为了「表单没选配方」时直接给出可读原因，而不是等到 store 返回。
 *
 * 返回 null = 通过；否则返回可读原因。
 */
const describeUserFormatRecipeRequirement = (
  familyAdapterId: string,
  recipeId: string | undefined,
): string | null => {
  if (recipeId !== undefined) return null;
  const lookup = getInterfaceFormat(familyAdapterId);
  if (lookup.kind === 'ready' && lookup.format.origin === 'user') {
    loggingModule.logDebug('[custom-generation-model-routes] user interface format without recipe refused', {
      familyAdapterId,
    });
    return '这个接口格式是本机自定义的，添加模型时必须选择一份判定配方';
  }
  return null;
};

/**
 * 写入侧的素材位 × 族能力一致性守卫（批次 2 遗留风险，批次 1 收口）。
 *
 * 契约只保证素材位在受控词表内，不保证「这个族的模板能表达这个素材位」——于是可以给文生视频族
 * 勾上首帧图：记录写得进去、创作面照勾选呈现，直到提交才失败（「能选但一提交就失败」）。
 * 判断依据是注册表条目的 `supportsMediaSlots`（与族模板同一份事实），不在路由里另列清单。
 *
 * 返回 null = 通过；否则返回可读原因。
 */
const describeMediaSlotViolation = (
  familyAdapterId: string,
  acceptedMediaSlots: readonly GenerationMediaSlotId[],
): string | null => {
  if (acceptedMediaSlots.length === 0) return null;
  const support = checkFamilyMediaSlotSupport(familyAdapterId, acceptedMediaSlots);
  if (support.kind === 'ok') return null;
  if (support.kind === 'unknown_family') {
    loggingModule.logDebug('[custom-generation-model-routes] media slot check: unknown family adapter id', {
      familyAdapterId,
    });
    return '这个接口类型不能用于生成模型';
  }
  const entry = getFamilyTemplate(familyAdapterId);
  if (entry !== null && entry.status === 'pending') {
    // 模板未就绪的族：拒绝写入非空素材位。理由见本文件顶部「pending 族的写入口径」。
    loggingModule.logDebug('[custom-generation-model-routes] media slot check: family template pending', {
      familyAdapterId,
      acceptedMediaSlots,
    });
    return '这个接口类型还在支持中，暂时不能设置素材输入；请先添加不接受素材的模型，或改用其他接口类型';
  }
  const unsupported = support.unsupportedMediaSlots.join('、');
  loggingModule.logDebug('[custom-generation-model-routes] media slot check: unsupported media slots for family', {
    familyAdapterId,
    acceptedMediaSlots,
    supportsMediaSlots: support.supportsMediaSlots,
  });
  return `这个接口类型不接受「${unsupported}」这类素材，请取消勾选后再保存`;
};

/**
 * 保存前的参数覆盖校验（生成模型参数高级自定义设计 §3.3「校验唯一实现」）。
 *
 * 与投影合成路径调用同一套 `validateParameterOverrides`；校验基线是**未应用覆盖**的
 * 基础族模板，且按本次将写入的素材位清单构建（它决定素材位字段与对应请求分支是否存在）。
 * 返回 null = 通过；否则返回逐条可读原因。
 *
 * 族分发走注册表：已就绪族用该族基础模板校验；未就绪族一律拒绝带覆盖的写入（该族没有模板，
 * 无从判断覆盖是否成立，放行等于让必然失败的配置进运行时）。
 */
const validateOverridesForFamily = (
  familyAdapterId: string,
  modelId: string,
  acceptedMediaSlots: readonly GenerationMediaSlotId[],
  overrides: ParameterOverrides,
): string[] | null => {
  const hasOverrides = overrides.official.length > 0 || overrides.custom.length > 0;
  if (!hasOverrides) return null;
  const baseline = buildFamilyTemplateBaseSources(familyAdapterId, modelId, { acceptedMediaSlots });
  if (baseline.kind === 'unknown') {
    loggingModule.logDebug('[custom-generation-model-routes] overrides check: unknown family adapter id', {
      familyAdapterId,
    });
    return ['这个接口类型不能用于生成模型'];
  }
  if (baseline.kind === 'pending') {
    loggingModule.logDebug('[custom-generation-model-routes] overrides check: family template pending', {
      familyAdapterId: baseline.familyAdapterId,
    });
    return ['这个接口类型还不支持参数高级自定义'];
  }
  const violations = validateParameterOverrides(baseline.sources, overrides);
  return violations.length === 0 ? null : violations.map((violation) => violation.message);
};

const createCustomGenerationModelRoutes = (): RouteDefinition[] => [
  {
    name: 'custom-generation-models',
    match: ({ req, pathname }) =>
      (req.method === 'GET' || req.method === 'POST') && pathname === '/api/custom-generation-models',
    handle: async ({ req, res, corsHeaders }) => {
      if (req.method === 'GET') {
        sendJson(
          res,
          200,
          CustomGenerationModelListResponseSchema.parse({ models: listCustomGenerationModels() }),
          NO_STORE_HEADERS(corsHeaders),
        );
        return;
      }
      const body = await readJsonBodyOrSendError(req, res, corsHeaders);
      if (body == null) return;
      const parsed = CustomGenerationModelCreateBodySchema.safeParse(body);
      if (!parsed.success) {
        sendError(res, 400, ERROR_CODES.INVALID_CONFIG, describeBodyError(parsed.error.issues), corsHeaders);
        return;
      }
      // 一次写入第一段：接口格式可用性 + 归属校验（连接存在、enabled、有凭证）。协议由请求体
      // 自带的 family_adapter_id 声明；2026-10-26 起契约只约束 id 形状，值域由实体注册表裁定。
      const familyError = describeFamilyAvailability(parsed.data.family_adapter_id);
      if (familyError !== null) {
        sendError(res, 400, ERROR_CODES.INVALID_CONFIG, familyError, corsHeaders);
        return;
      }
      const ownershipError = describeConnectionOwnershipError(parsed.data.connection_id);
      if (ownershipError !== null) {
        sendError(res, 400, ERROR_CODES.INVALID_CONFIG, ownershipError, corsHeaders);
        return;
      }
      const recipeRequirementError = describeUserFormatRecipeRequirement(
        parsed.data.family_adapter_id,
        parsed.data.recipe_id,
      );
      if (recipeRequirementError !== null) {
        sendError(res, 400, ERROR_CODES.INVALID_CONFIG, recipeRequirementError, corsHeaders);
        return;
      }
      // 素材位 × 族能力一致性守卫（写入侧唯一实现，判断依据是族模板注册表的能力事实）
      const mediaSlotError = describeMediaSlotViolation(
        parsed.data.family_adapter_id,
        parsed.data.accepted_media_slots ?? [],
      );
      if (mediaSlotError !== null) {
        sendError(res, 400, ERROR_CODES.INVALID_CONFIG, mediaSlotError, corsHeaders);
        return;
      }
      const overrideErrors = validateOverridesForFamily(
        parsed.data.family_adapter_id,
        parsed.data.model_id,
        parsed.data.accepted_media_slots ?? [],
        parsed.data.parameter_overrides ?? EMPTY_PARAMETER_OVERRIDES,
      );
      if (overrideErrors !== null) {
        sendError(res, 400, ERROR_CODES.INVALID_CONFIG, overrideErrors.join('；'), corsHeaders);
        return;
      }
      const result = addCustomGenerationModel({
        model_id: parsed.data.model_id,
        connection_id: parsed.data.connection_id,
        ...(parsed.data.remote_model_id === undefined ? {} : { remote_model_id: parsed.data.remote_model_id }),
        family_adapter_id: parsed.data.family_adapter_id,
        ...(parsed.data.accepted_media_slots === undefined
          ? {}
          : { accepted_media_slots: parsed.data.accepted_media_slots }),
        ...(parsed.data.parameter_overrides === undefined
          ? {}
          : { parameter_overrides: parsed.data.parameter_overrides }),
        ...(parsed.data.recipe_id === undefined ? {} : { recipe_id: parsed.data.recipe_id }),
      });
      if (!result.ok) {
        if (result.reason === 'family_adapter_not_ready') {
          // store 侧守卫的可读原因原样透给用户（路由侧已先挡一次，这里是纵深防御）
          sendError(res, 400, ERROR_CODES.INVALID_CONFIG, result.message, corsHeaders);
          return;
        }
        if (result.reason === 'media_slot_not_supported_by_family') {
          // store 侧守卫的可读原因原样透给用户（路由侧已先挡一次，这里是纵深防御）
          sendError(res, 400, ERROR_CODES.INVALID_CONFIG, result.message, corsHeaders);
          return;
        }
        if (result.reason === 'recipe_reference_invalid') {
          // 引用校验的唯一实现在 store（与 PUT 共用），可读原因原样透给用户。
          sendError(res, 400, ERROR_CODES.INVALID_CONFIG, result.message, corsHeaders);
          return;
        }
        if (result.reason === 'duplicate_chat_record') {
          sendError(res, 409, 'conflict', '这个名字已经用于一个对话模型，不能再用作图像模型的模型 ID，换一个模型 ID，或先删除那个对话模型', corsHeaders);
          return;
        }
        sendError(
          res,
          409,
          'conflict',
          `已经有「${parsed.data.model_id}」这个模型了。换一个模型 ID，或在模型列表里先删除它再重新添加。`,
          corsHeaders,
        );
        return;
      }
      // 一次写入最后一段：把新记录设为当前使用（保持「添加即可用」的用户可见行为）
      const activated = setActiveDeployment(result.model.model_id, result.model.record_id);
      if (activated === null) {
        loggingModule.logDebug('[custom-generation-model-routes] create: active route write failed', {
          modelId: result.model.model_id,
          recordId: result.model.record_id,
        });
      }
      const stored = getCustomGenerationModel(result.model.model_id) ?? result.model;
      sendJson(
        res,
        200,
        CustomGenerationModelResponseSchema.parse({ model: stored }),
        NO_STORE_HEADERS(corsHeaders),
      );
    },
  },
  {
    name: 'custom-generation-models-by-id',
    match: ({ req, pathname }) => {
      const segs = splitPathname(pathname);
      return (
        segs[0] === 'api' &&
        segs[1] === 'custom-generation-models' &&
        segs.length === 3 &&
        (req.method === 'PUT' || req.method === 'DELETE')
      );
    },
    handle: async ({ req, res, pathname, corsHeaders }) => {
      const modelId = decodeURIComponent(splitPathname(pathname)[2] ?? '');
      if (req.method === 'PUT') {
        const body = await readJsonBodyOrSendError(req, res, corsHeaders);
        if (body == null) return;
        const parsed = CustomGenerationModelUpdateBodySchema.safeParse(body);
        if (!parsed.success) {
          sendError(res, 400, ERROR_CODES.INVALID_CONFIG, describeBodyError(parsed.error.issues), corsHeaders);
          return;
        }
        const existing = getCustomGenerationModel(modelId);
        if (existing === null) {
          sendError(res, 404, ERROR_CODES.NOT_FOUND, '没有这个模型', corsHeaders);
          return;
        }
        // 素材位 × 族能力一致性守卫（PUT 改的正是素材位，同一份判断）
        const mediaSlotError = describeMediaSlotViolation(
          existing.family_adapter_id,
          parsed.data.accepted_media_slots,
        );
        if (mediaSlotError !== null) {
          sendError(res, 400, ERROR_CODES.INVALID_CONFIG, mediaSlotError, corsHeaders);
          return;
        }
        // 用户自建格式不能清除配方（三态里的 `null`）：清除后该记录永远判不出成功。
        if (parsed.data.recipe_id === null) {
          const clearError = describeUserFormatRecipeRequirement(existing.family_adapter_id, undefined);
          if (clearError !== null) {
            sendError(
              res,
              400,
              ERROR_CODES.INVALID_CONFIG,
              '这个接口格式是本机自定义的，不能清除判定配方；请改选另一份配方',
              corsHeaders,
            );
            return;
          }
        }
        // parameter_overrides 缺省 = 保持现有覆盖不变；出现 = 整体替换（契约口径）。
        if (parsed.data.parameter_overrides !== undefined) {
          const overrideErrors = validateOverridesForFamily(
            existing.family_adapter_id,
            existing.model_id,
            parsed.data.accepted_media_slots,
            parsed.data.parameter_overrides,
          );
          if (overrideErrors !== null) {
            sendError(res, 400, ERROR_CODES.INVALID_CONFIG, overrideErrors.join('；'), corsHeaders);
            return;
          }
        }
        const updated = updateCustomGenerationModel(modelId, {
          accepted_media_slots: parsed.data.accepted_media_slots,
          ...(parsed.data.parameter_overrides === undefined
            ? {}
            : { parameter_overrides: parsed.data.parameter_overrides }),
          // 三态：缺省保持现有引用；null 清除；字符串改为该配方。
          ...(parsed.data.recipe_id === undefined ? {} : { recipe_id: parsed.data.recipe_id }),
        });
        if (!updated.ok) {
          if (updated.reason === 'media_slot_not_supported_by_family') {
            // store 侧守卫的可读原因原样透给用户（路由侧已先挡一次，这里是纵深防御）
            sendError(res, 400, ERROR_CODES.INVALID_CONFIG, updated.message, corsHeaders);
            return;
          }
          if (updated.reason === 'recipe_reference_invalid') {
            sendError(res, 400, ERROR_CODES.INVALID_CONFIG, updated.message, corsHeaders);
            return;
          }
          // not_found / invalid_record 对用户是同一件事：这条记录改不成了
          sendError(res, 404, ERROR_CODES.NOT_FOUND, '没有这个模型', corsHeaders);
          return;
        }
        sendJson(
          res,
          200,
          CustomGenerationModelResponseSchema.parse({ model: updated.model }),
          NO_STORE_HEADERS(corsHeaders),
        );
        return;
      }
      if (!removeCustomGenerationModel(modelId)) {
        sendError(res, 404, ERROR_CODES.NOT_FOUND, '没有这个模型', corsHeaders);
        return;
      }
      // 删除自建记录时级联清理它的「当前使用」标记（记录即接入，无需再清 deployment）。
      const clearedRoute = clearActiveDeployment(modelId);
      loggingModule.logDebug('[custom-generation-model-routes] custom model record removed', {
        modelId,
        activeRouteCleared: clearedRoute,
      });
      sendJson(
        res,
        200,
        CustomGenerationModelRemovalResponseSchema.parse({ model_id: modelId }),
        NO_STORE_HEADERS(corsHeaders),
      );
    },
  },
];

export { createCustomGenerationModelRoutes };
