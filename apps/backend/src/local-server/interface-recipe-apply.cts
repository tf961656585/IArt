import {
  cloneJsonValue,
  type InterfaceRecipe,
  type RecipeCondition,
  type RecipeDirectResult,
  type RecipeMediaType,
  type RecipeResultForm,
} from '@iart/contracts';
import { isObjectRecord } from './model-package-catalog.shared.cts';
import type { CatalogRawObject } from './model-package-catalog.raw-object.cts';
import type { JsonObject } from './model-package-catalog.types.cts';
import type { GenerationFamilyTemplateSources } from './generation-family-templates.cts';
import { deriveFixedRequestHeaders } from './interface-format/request-headers.cts';

/**
 * 接口配方 × 族模板 sources 的合成（`docs/custom-providers/接口配方-design.md` §6/§7）。
 *
 * 纯函数、无 IO、无网络：只把配方编译进 `sources.runtimeModel` 的三个结果段落。
 *
 * 落点说明（与设计文档措辞的差异，以代码事实为准）：执行计划归一化
 * （`model-package-catalog.task-plan.cts` 的 `normalizeFormalTaskExecutionPlan`）读取的是
 * `runtimeModel.result_rule` / `runtimeModel.result_output_mapping` /
 * `runtimeModel.result_acquisition_strategy` **顶层字段**，因此本模块写在这三个位置，
 * 而不是 `runtimeModel.runtime` 下面。
 *
 * 职责边界：
 * - 不碰 `request_strategy` / `polling_strategy` / payload_rules（传输层仍是族模板）；
 * - 不碰 `submit_accept_condition` / `submit_response_id_path` / `error_mapping_rules`
 *   （配方只承载判定与结果形态，提交语义仍由族模板承载）；
 * - `result_rule.mode` 保持族模板原值（配方不决定同步/异步）。
 */

/** target 取值以 `task-result-output-mapping.cts` 的 `mediaTypeFromTarget` 合法值为准。 */
const OUTPUT_TARGET_BY_MEDIA_TYPE: Readonly<Record<RecipeMediaType, string>> = {
  image: 'output.image_url',
  video: 'output.video_url',
  audio: 'output.audio_url',
};

/**
 * `needs_fetch + binary` 的保留响应路径。
 *
 * 最终结果接口直接返回媒体字节流时，物化阶段不把字节搬进内存，而是把构造好的内容地址
 * 写到响应体的这个保留键上；下载、落盘与资产绑定仍由既有 `downloadRemoteMediaToFiles`
 * 链路完成（天然复用鉴权头与本地化逻辑）。执行侧的写入点是
 * `task-result-acquisition.cts` 的 `ACQUIRED_MEDIA_URL_PATH`（两处必须一致）。
 */
const ACQUIRED_MEDIA_URL_PATH = '__acquired_media_url';

const asObjectOrThrow = (value: unknown, errorCode: string): CatalogRawObject => {
  if (!isObjectRecord(value)) {
    throw new Error(errorCode);
  }
  return value;
};

/**
 * 条件树 → 执行计划可消费的 JSON 形状。
 *
 * 字段名与 `CatalogTaskResultCondition` 对齐（`op` / `path` / `value` / `children` /
 * `condition`），不做任何语义改写：比较语义由求值器唯一决定。
 */
const recipeConditionToJson = (condition: RecipeCondition): JsonObject => {
  if (condition.op === 'all' || condition.op === 'any') {
    return {
      op: condition.op,
      children: condition.children.map((child) => recipeConditionToJson(child)),
    };
  }
  if (condition.op === 'not') {
    return {
      op: 'not',
      condition: recipeConditionToJson(condition.condition),
    };
  }
  const atom: JsonObject = { op: condition.op, path: condition.path };
  if (condition.value !== undefined) atom.value = condition.value;
  return atom;
};

/**
 * 直接结果（轮询响应 / 二次请求响应里直接可取的产物）→ output_mapping_rules。
 *
 * 同一 target 多条规则是既有兜底形态（seedance / kling 家族就是这样：查询可能先回状态后回
 * 地址），因此全部 `required: false`，命中哪条取哪条。
 */
const buildDirectResultRules = (result: RecipeDirectResult): JsonObject[] =>
  result.media_field_paths.map((path) => ({
    target: OUTPUT_TARGET_BY_MEDIA_TYPE[result.media_type],
    source: { kind: 'response', path },
    required: false,
  }));

const buildOutputMappingRules = (result: RecipeResultForm): JsonObject[] => {
  if (result.kind === 'needs_fetch') {
    if (result.accept === 'binary') {
      // 媒体类型由配方写入侧校验保证存在；缺失时留空规则（执行阶段会因取不到产物收口失败）。
      if (result.media_type === undefined) return [];
      // 获取阶段把内容地址写到保留路径，映射据此走既有下载链路（不再伪造「响应里的 URL 字段」）。
      return [
        {
          target: OUTPUT_TARGET_BY_MEDIA_TYPE[result.media_type],
          source: { kind: 'response', path: ACQUIRED_MEDIA_URL_PATH },
          required: true,
        },
      ];
    }
    // `accept = json`：取回的结构化响应按 after 的形态解读。
    return result.after === undefined ? [] : buildDirectResultRules(result.after);
  }
  return buildDirectResultRules(result);
};

const buildResultOutputMapping = (recipe: InterfaceRecipe): JsonObject => ({
  response_mode: 'structured_payload',
  requires_auth: recipe.requires_auth,
  output_mapping_rules: buildOutputMappingRules(recipe.result),
  note:
    recipe.result.kind === 'needs_fetch' && recipe.result.accept === 'binary'
      ? `interface recipe ${recipe.recipe_id}: binary final result is materialized by the acquisition stage`
      : `interface recipe ${recipe.recipe_id}`,
});

/**
 * `needs_fetch` → result_acquisition_strategy。
 *
 * 形状必须被 `normalizeTaskResultAcquisitionStrategy` 接受，并满足
 * `docs/model-assets/08-异步最终结果获取策略.md` 的关键约束：
 * - `acquisition_mode = 'fetch_final_result'`；
 * - 标识来自查询响应 → `identity_source = 'query_response_path'` + `identity_path`；
 * - 必须有 `request_strategy`（GET + 提交同源鉴权，方法固定）。
 *
 * 地址模板保留 `{id}` 占位符（执行器据此替换）；GET 方法固定，不开放方法/请求头/请求体。
 * 请求策略只写「打到哪个地址、用什么方法」，不写从未被执行链消费的三个规则数组。
 *
 * `request_headers` 是格式 `api.headers.*` 的字面量规则（提交 / 轮询 / 取结果共用），随获取
 * 策略冻结：取结果请求按策略独立发起，运行时不回读格式实体的规则树。鉴权头不在这里
 * （由 `requires_auth` 在请求时注入）。
 */
const buildResultAcquisitionStrategy = (
  recipe: InterfaceRecipe,
  requestHeaders: Record<string, string>,
): JsonObject | null => {
  if (recipe.result.kind !== 'needs_fetch') return null;
  const strategy: JsonObject = {
    acquisition_mode: 'fetch_final_result',
    identity_source: 'query_response_path',
    identity_path: recipe.result.identity_field_path,
    request_strategy: {
      request_stage: 'acquisition',
      protocol: 'http',
      endpoint: recipe.result.content_url_template,
      method: 'GET',
    },
    request_headers: { ...requestHeaders },
    accept: recipe.result.accept,
    media_type: recipe.result.media_type ?? undefined,
    requires_auth: recipe.requires_auth,
    note: `interface recipe ${recipe.recipe_id}: GET ${recipe.result.content_url_template} (authorization: ${recipe.requires_auth ? 'same-origin credential' : 'none'})`,
  };
  return strategy;
};

/**
 * 把配方合入族模板 sources（返回新 sources，输入不被修改）。
 *
 * 合成顺序固定为「族模板内置默认 → 记录参数覆盖（调用方先做）→ 配方」，因此参数覆盖的结果
 * 原样保留，配方只覆盖判定与结果段落。
 */
const applyRecipeToSources = (
  sources: GenerationFamilyTemplateSources,
  recipe: InterfaceRecipe,
): GenerationFamilyTemplateSources => {
  const runtimeModel = asObjectOrThrow(
    cloneJsonValue(sources.runtimeModel),
    'interface_recipe_runtime_model_invalid',
  );

  // 判定段：success_when 必填；failure_when 缺省 = 该配方没有失败判定（不继承族模板的条件，
  // 否则配方与模板可能对同一路径给出互相矛盾的结论）。
  const resultRule = isObjectRecord(runtimeModel.result_rule)
    ? runtimeModel.result_rule
    : ({} as JsonObject);
  resultRule.success_condition = recipeConditionToJson(recipe.success_when);
  resultRule.failure_condition =
    recipe.failure_when === undefined ? undefined : recipeConditionToJson(recipe.failure_when);
  // 失败原因只随失败判定进入执行计划：没有 failure_when 时它永远不会被消费，
  // 留在计划里只会让「这份计划为什么带着一句用户提示」无法解释。
  resultRule.failure_reason =
    recipe.failure_when === undefined ? undefined : recipe.failure_reason;
  runtimeModel.result_rule = resultRule;

  // 结果形态段：三形态互斥，由配方 result.kind 判别。
  runtimeModel.result_output_mapping = buildResultOutputMapping(recipe);

  // 取结果请求的固定请求头：从（已应用参数覆盖与别名的）规则树派生，条件/宏规则跳过并留痕。
  const runtimeRecord = isObjectRecord(runtimeModel.runtime) ? runtimeModel.runtime : null;
  const payloadRules = runtimeRecord === null ? null : runtimeRecord.payload_rules;
  const requestHeaders = deriveFixedRequestHeaders(payloadRules, {
    formatId: recipe.family_adapter_id,
    ...(typeof runtimeModel.model_id === 'string' ? { modelId: runtimeModel.model_id } : {}),
  });

  // 是否需要再取一次：needs_fetch 时声明获取策略；直接返回时清空族模板可能携带的获取声明，
  // 否则会先发一次多余请求。`undefined` 在归一化器里等价于 null，且不落 JSON。
  runtimeModel.result_acquisition_strategy =
    buildResultAcquisitionStrategy(recipe, requestHeaders) ?? undefined;

  return {
    runtimeModel,
    node: sources.node,
    localizationResources: sources.localizationResources,
  };
};

export { applyRecipeToSources, recipeConditionToJson };
