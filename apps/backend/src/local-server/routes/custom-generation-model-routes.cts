import {
  CustomGenerationModelCreateBodySchema,
  CustomGenerationModelListResponseSchema,
  CustomGenerationModelRemovalResponseSchema,
  CustomGenerationModelResponseSchema,
  CustomGenerationModelUpdateBodySchema,
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
import { buildOpenAiImageV1BaseTemplateSources, OPENAI_IMAGE_V1_FAMILY_ADAPTER_ID } from '../generation-family-templates.cts';
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
 * - PUT    /api/custom-generation-models/:modelId    改可改属性（supports_reference_image / parameter_overrides 整体替换）
 * - DELETE /api/custom-generation-models/:modelId    删除记录（active route 由本路由级联清理）
 *
 * 2026-09-25 起「声明 + ModelDeployment 接入」合并为单记录：接入归属（connection_id +
 * remote_model_id）与能力属性一体。归属校验要求连接的协议族与 `family_adapter_id` 同族。
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
 * `model_id` 与 `supports_reference_image` 是用户填写的字段，提示要说清填什么；
 * `family_adapter_id` 由表单按所在连接的接口类型带上，校验失败只会来自直接调用方；
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
  if (field === 'supports_reference_image') {
    return '参考图设置无效，请重试';
  }
  if (field === 'family_adapter_id') {
    return '这个模型 ID 不能用在这类服务商上';
  }
  if (field === 'parameter_overrides') {
    return '高级参数自定义的数据格式无效';
  }
  return '模型 ID 只能用字母、数字、.、_、-，且以字母或数字开头';
};

/**
 * 保存前的参数覆盖校验（生成模型参数高级自定义设计 §3.3「校验唯一实现」）。
 *
 * 与投影合成路径调用同一套 `validateParameterOverrides`；校验基线是**未应用覆盖**的
 * 基础族模板，且按本次将写入的 supports_reference_image 构建（它决定 image 字段与
 * edits 分支是否存在）。返回 null = 通过；否则返回逐条可读原因。
 */
const validateOverridesForFamily = (
  familyAdapterId: string,
  modelId: string,
  supportsReferenceImage: boolean,
  overrides: ParameterOverrides,
): string[] | null => {
  if (familyAdapterId !== OPENAI_IMAGE_V1_FAMILY_ADAPTER_ID) {
    // 试点单族封闭：契约枚举只会放行 openai-image-v1；此处是扩族期的防御分支。
    return overrides.official.length === 0 && overrides.custom.length === 0
      ? null
      : ['这个模型类型还不支持参数高级自定义'];
  }
  const sources = buildOpenAiImageV1BaseTemplateSources(modelId, { supportsReferenceImage });
  const violations = validateParameterOverrides(sources, overrides);
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
      // 一次写入第一段：归属校验（连接存在、enabled、有凭证；协议由请求体自带的
      // family_adapter_id 声明，值域由契约 enum 保证与已登记族模板一一对应）
      const ownershipError = describeConnectionOwnershipError(parsed.data.connection_id);
      if (ownershipError !== null) {
        sendError(res, 400, ERROR_CODES.INVALID_CONFIG, ownershipError, corsHeaders);
        return;
      }
      const overrideErrors = validateOverridesForFamily(
        parsed.data.family_adapter_id,
        parsed.data.model_id,
        parsed.data.supports_reference_image ?? false,
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
        ...(parsed.data.supports_reference_image === undefined
          ? {}
          : { supports_reference_image: parsed.data.supports_reference_image }),
        ...(parsed.data.parameter_overrides === undefined
          ? {}
          : { parameter_overrides: parsed.data.parameter_overrides }),
      });
      if (!result.ok) {
        if (result.reason === 'duplicate_installed_model') {
          sendError(res, 409, 'conflict', '软件里已经有这个模型了，换一个模型 ID，或直接使用已装的这个模型', corsHeaders);
          return;
        }
        if (result.reason === 'conflicts_with_other_generation_family') {
          sendError(res, 409, 'conflict', '这个名字属于其他类型的生成模型，不能用作 OpenAI 图像模型的模型 ID，换一个模型 ID', corsHeaders);
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
          `软件里已经添加过「${parsed.data.model_id}」了。换一个模型 ID，或在模型列表里先删除它再重新添加。`,
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
        // parameter_overrides 缺省 = 保持现有覆盖不变；出现 = 整体替换（契约口径）。
        if (parsed.data.parameter_overrides !== undefined) {
          const overrideErrors = validateOverridesForFamily(
            existing.family_adapter_id,
            existing.model_id,
            parsed.data.supports_reference_image,
            parsed.data.parameter_overrides,
          );
          if (overrideErrors !== null) {
            sendError(res, 400, ERROR_CODES.INVALID_CONFIG, overrideErrors.join('；'), corsHeaders);
            return;
          }
        }
        const updated = updateCustomGenerationModel(modelId, {
          supports_reference_image: parsed.data.supports_reference_image,
          ...(parsed.data.parameter_overrides === undefined
            ? {}
            : { parameter_overrides: parsed.data.parameter_overrides }),
        });
        if (updated === null) {
          sendError(res, 404, ERROR_CODES.NOT_FOUND, '没有这个模型', corsHeaders);
          return;
        }
        sendJson(
          res,
          200,
          CustomGenerationModelResponseSchema.parse({ model: updated }),
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
