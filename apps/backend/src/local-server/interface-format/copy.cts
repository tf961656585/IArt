import {
  cloneJsonValue,
  type InterfaceRecipeCreateBody,
  type RecipeCondition,
  type RecipeMediaType,
} from '@iart/contracts';
import { isObjectRecord } from '../model-package-catalog.shared.cts';
import * as loggingModule from '../logging.cts';
import { buildUserInterfaceRecipeName } from './draft-synthesis.cts';
import { InterfaceFormatSchema, type InterfaceFormat } from './schema.cts';

/**
 * 复制接口格式（**服务端整实体克隆**，2026-10-27 批次）。
 *
 * 复制不经过草稿重新合成：草稿只能表达请求落点的一部分（表单可表示的规则），重新合成会把
 * 预设里表单表达不到的规则（条件端点分支、`body.image` 条件、额外固定头、`meta.*` 等）
 * 静默丢掉。因此复制只改身份字段（id / 显示名 / origin / status / order），其余段落
 * （transport / parameters / media / projection / builtin_behavior / composition / localization）
 * 逐字段沿用源实体。
 *
 * 判定与结果形态（配方）另行处理：源是用户格式时由路由复制其绑定配方；源是预设时尝试从
 * `builtin_behavior` 派生一份——只在**能可靠判断结果形态**时派生（目前只有
 * `needs_fetch + binary`：取结果地址、标识路径、媒体类型都显式写在实体里）。判不出来就返回
 * `recipe_id: null`，让 Hub 打开编辑器补全，而不是伪造一份可能取不到产物的配方。
 */

const COPY_SUFFIX = ' 副本';
const DISPLAY_NAME_MAX = 80;

/** 复制体的显示名：`<原名> 副本`（超长按契约上限截断原名，后缀始终保留）。 */
export const buildCopiedInterfaceFormatName = (displayName: string): string => {
  const budget = DISPLAY_NAME_MAX - COPY_SUFFIX.length;
  const trimmed = displayName.trim();
  return `${trimmed.length > budget ? trimmed.slice(0, budget) : trimmed}${COPY_SUFFIX}`;
};

/** 整实体克隆 + 身份字段改写（其余段落原样沿用，不经过草稿）。 */
export const buildCopiedInterfaceFormat = (
  source: InterfaceFormat,
  identity: { format_id: string; order: number },
): InterfaceFormat =>
  InterfaceFormatSchema.parse({
    ...cloneJsonValue(source),
    format_id: identity.format_id,
    display_name: buildCopiedInterfaceFormatName(source.display_name),
    origin: 'user',
    status: 'ready',
    order: identity.order,
  });

const RECIPE_MEDIA_TYPES: ReadonlySet<string> = new Set<RecipeMediaType>(['image', 'video', 'audio']);

const toRecipeMediaType = (value: unknown): RecipeMediaType | null =>
  typeof value === 'string' && RECIPE_MEDIA_TYPES.has(value) ? (value as RecipeMediaType) : null;

/**
 * 从预设的 `builtin_behavior` 派生一份判定配方；判不出来返回 null。
 *
 * 可靠派生的条件（缺一即返回 null，不猜）：
 * - 声明了「再取一次」的内置获取策略（`acquisition_mode = fetch_final_result`）且 accept = binary：
 *   结果形态是确定的（取到的就是媒体字节流）；
 * - 取结果地址模板、任务标识路径、媒体类型都显式存在；
 * - 有轮询状态词表（成功/失败判定从它来）。
 *
 * `accept = json` 需要 `after` 的产物路径语义，`structured_payload` 的映射无法判断路径里是
 * 链接还是内联内容——这两类一律不派生，交给用户在编辑器里补全判定与结果。
 */
export const deriveRecipeFromBuiltinBehavior = (
  format: InterfaceFormat,
  recipeName: string,
): InterfaceRecipeCreateBody | null => {
  const behavior = format.builtin_behavior;
  if (behavior === undefined) return null;
  const acquisition = isObjectRecord(behavior.result_acquisition) ? behavior.result_acquisition : null;
  if (acquisition === null) return null;
  if (acquisition.acquisition_mode !== 'fetch_final_result') return null;
  if (acquisition.accept !== 'binary') return null;

  const requestStrategy = isObjectRecord(acquisition.request_strategy) ? acquisition.request_strategy : null;
  const contentUrlTemplate = requestStrategy === null ? null : requestStrategy.endpoint;
  if (typeof contentUrlTemplate !== 'string' || !contentUrlTemplate.includes('{id}')) {
    loggingModule.logDebug('[interface-format/copy] cannot derive recipe: content url template unavailable', {
      formatId: format.format_id,
      contentUrlTemplate,
    });
    return null;
  }

  const identityFieldPath = format.transport.async?.identity_path ?? format.transport.submit.response_id_path;
  if (identityFieldPath === undefined || identityFieldPath.length === 0) {
    loggingModule.logDebug('[interface-format/copy] cannot derive recipe: identity path unavailable', {
      formatId: format.format_id,
    });
    return null;
  }

  const mediaType =
    toRecipeMediaType(acquisition.media_type) ??
    toRecipeMediaType(format.projection.execution_profile.task_type);
  if (mediaType === null) {
    loggingModule.logDebug('[interface-format/copy] cannot derive recipe: media type unavailable', {
      formatId: format.format_id,
    });
    return null;
  }

  const polling = behavior.polling_status;
  const statusPath = polling?.status_paths[0];
  if (polling === undefined || statusPath === undefined) {
    loggingModule.logDebug('[interface-format/copy] cannot derive recipe: polling status unavailable', {
      formatId: format.format_id,
    });
    return null;
  }

  const successWhen: RecipeCondition = {
    op: 'in',
    path: statusPath,
    value: [...polling.success_values],
  };
  const failureWhen: RecipeCondition | undefined =
    polling.failure_values.length === 0
      ? undefined
      : { op: 'in', path: statusPath, value: [...polling.failure_values] };

  return {
    name: recipeName,
    family_adapter_id: format.format_id,
    success_when: successWhen,
    ...(failureWhen === undefined ? {} : { failure_when: failureWhen }),
    result: {
      kind: 'needs_fetch',
      identity_field_path: identityFieldPath,
      content_url_template: contentUrlTemplate,
      accept: 'binary',
      media_type: mediaType,
    },
    requires_auth: acquisition.requires_auth === true,
  };
};

/** 由源格式显示名生成派生配方的名字（与草稿合成同一命名口径）。 */
export const buildCopiedInterfaceRecipeName = (displayName: string): string =>
  buildUserInterfaceRecipeName(buildCopiedInterfaceFormatName(displayName));
