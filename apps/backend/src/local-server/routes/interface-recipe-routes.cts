import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  InterfaceRecipeCreateBodySchema,
  InterfaceRecipeDryRunBodySchema,
  InterfaceRecipeDryRunResponseSchema,
  InterfaceRecipeListResponseSchema,
  InterfaceRecipePathDiscoveryBodySchema,
  InterfaceRecipePathDiscoveryResponseSchema,
  InterfaceRecipeRemovalResponseSchema,
  InterfaceRecipeResponseSchema,
  InterfaceRecipeUpdateBodySchema,
  type InterfaceRecipeCreateBody,
  type InterfaceRecipeDryRunResponse,
  type InterfaceRecipePathDiscoveryResponse,
  type RecipeCondition,
  type RecipeDirectResult,
  type RecipeMediaType,
  type RecipeResultForm,
} from '@iart/contracts';
import * as constantsModule from '../constants.cts';
import * as httpUtilsModule from '../http-utils.cts';
import { readJsonBodyOrSendError } from '../http/json-route.cts';
import type { RouteDefinition } from '../http/route-registry.cts';
import * as loggingModule from '../logging.cts';
import { isPlainObject } from '../utils.cts';
import { readValueByPath } from '../task-engine-polling-utils.cts';
import {
  collectRecipeConditionPaths,
  evaluateRecipeCondition,
  isRecipeConditionPathObservable,
} from '../result-condition-evaluator.cts';
import { collectSamplePaths, parseSampleValue } from '../result-sample-inspection.cts';
import {
  addInterfaceRecipe,
  getInterfaceRecipe,
  listInterfaceRecipes,
  removeInterfaceRecipe,
  updateInterfaceRecipe,
} from '../provider-connection/interface-recipe-store.cts';
import { validateInterfaceRecipe } from '../interface-recipe-validation.cts';

/**
 * 接口配方路由（`docs/custom-providers/接口配方-design.md` §7/§8）。
 *
 * - GET    /api/interface-recipes                    公共配方库列表
 * - POST   /api/interface-recipes                    新建配方（`recipe_id` 可省略，由 store 生成）
 * - PUT    /api/interface-recipes/:recipeId          改配方（族与 id 不可改）
 * - DELETE /api/interface-recipes/:recipeId          删配方（引用它的记录在投影期回落默认）
 * - POST   /api/interface-recipes/dry-run            样本试跑（纯本地，不发请求）
 * - POST   /api/interface-recipes/path-discovery     样本响应里的字段路径发现
 *
 * 静态路径（`/dry-run`、`/path-discovery`）必须先于 `/:recipeId` 匹配：两者虽只接受 POST、
 * 而 `/:recipeId` 只接受 PUT/DELETE，仍按「静态先行」排布，避免后续加方法时误吞。
 *
 * 试跑与路径发现是计算路由，但仍然入 Hub write token 白名单：它们由 Hub 管理页发起，与写路由
 * 同一信任域；只读 GET 不加。
 */

type RouterRequest = IncomingMessage;
type RouterResponse = ServerResponse<IncomingMessage>;

const { ERROR_CODES } = constantsModule;
const { sendJson, sendError } = httpUtilsModule;

const NO_STORE_HEADERS = (corsHeaders: Record<string, string>): Record<string, string> => ({
  ...corsHeaders,
  'Cache-Control': 'no-store',
});

const splitPathname = (pathname: string): string[] => pathname.split('/').filter(Boolean);

const describeCreateBodyError = (issues: readonly { path: readonly PropertyKey[] }[]): string => {
  const field = issues[0]?.path[0];
  if (field === 'name') return '请给这份配方起一个名字';
  if (field === 'family_adapter_id') return '请选择这份配方对应的接口类型';
  if (field === 'success_when') return '成功判定的格式无效，请重新填写';
  if (field === 'failure_when') return '失败判定的格式无效，请重新填写';
  if (field === 'failure_reason') return '失败原因最多 140 个字，请精简后重试';
  if (field === 'result') return '结果形态的格式无效，请重新填写';
  if (field === 'recipe_id') return '配方的标识格式不对，请重试';
  return '配方内容格式无效，请检查后重试';
};

const describeUpdateBodyError = (issues: readonly { path: readonly PropertyKey[] }[]): string => {
  const field = issues[0]?.path[0];
  if (field === 'name') return '请给这份配方起一个名字';
  if (field === 'success_when') return '成功判定的格式无效，请重新填写';
  if (field === 'failure_when') return '失败判定的格式无效，请重新填写';
  if (field === 'failure_reason') return '失败原因最多 140 个字，请精简后重试';
  if (field === 'result') return '结果形态的格式无效，请重新填写';
  return '配方内容格式无效，请检查后重试';
};

const buildValidationInput = (
  body: Pick<InterfaceRecipeCreateBody, 'family_adapter_id' | 'success_when' | 'failure_when' | 'result'>,
) => ({
  family_adapter_id: body.family_adapter_id,
  success_when: body.success_when,
  ...(body.failure_when === undefined ? {} : { failure_when: body.failure_when }),
  result: body.result,
});

const describeViolations = (
  violations: readonly { message: string }[],
): string => violations.map((violation) => violation.message).join('；');

// ---------------------------------------------------------------------------
// 样本试跑（纯本地计算）
// ---------------------------------------------------------------------------

const DEFAULT_MIME_BY_MEDIA_TYPE: Readonly<Record<RecipeMediaType, string>> = {
  image: 'image/png',
  video: 'video/mp4',
  audio: 'audio/mpeg',
};

const buildDataUrl = (base64: string, mimeType: string | undefined, mediaType: RecipeMediaType): string =>
  `data:${mimeType ?? DEFAULT_MIME_BY_MEDIA_TYPE[mediaType]};base64,${base64.replace(/\s+/g, '')}`;

/**
 * 内联媒体块里 mime 类型的候选键（兼容 camelCase / snake_case 两种上游形态）。
 *
 * 用常量表 + 变量 key 遍历而不是连续字符串下标：固定字段下标访问被
 * `guard:stable-business-types`（`stable/no-fixed-field-bracket-access`）禁止。
 */
const INLINE_MIME_TYPE_KEYS = ['mime_type', 'mimeType', 'content_type', 'contentType'] as const;

type DryRunOutput = InterfaceRecipeDryRunResponse['outputs'][number];

/**
 * 把某个字段值解读成「试跑抽取到的产物」。
 *
 * 只用配方声明的编码方式解读，不做内容探测（执行链的正式抽取规则由 `result_output_mapping`
 * 与后端抽取值器承载，试跑只回答「按这份配方能不能认出产物」）。
 */
const toDryRunOutput = (
  value: unknown,
  mediaType: RecipeMediaType,
  sourcePath: string,
  result: RecipeDirectResult,
): DryRunOutput | null => {
  if (result.kind === 'direct_url') {
    if (typeof value !== 'string') return null;
    const url = value.trim();
    return url ? { media_type: mediaType, url, source_path: sourcePath } : null;
  }

  // inline_media：data_url / raw_base64 / json_inline
  if (result.encoding === 'json_inline') {
    if (!isPlainObject(value)) return null;
    const data = value.data;
    if (typeof data !== 'string' || !data.trim()) return null;
    let mimeType: string | undefined;
    for (const key of INLINE_MIME_TYPE_KEYS) {
      const candidate = value[key];
      if (typeof candidate === 'string' && candidate.trim()) {
        mimeType = candidate.trim();
        break;
      }
    }
    return {
      media_type: mediaType,
      url: buildDataUrl(data, mimeType, mediaType),
      source_path: sourcePath,
    };
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  if (result.encoding === 'data_url') {
    return { media_type: mediaType, url: value.trim(), source_path: sourcePath };
  }
  // raw_base64
  return {
    media_type: mediaType,
    url: buildDataUrl(value, result.mime_type, mediaType),
    source_path: sourcePath,
  };
};

const collectDirectResultOutputs = (
  result: RecipeDirectResult,
  body: unknown,
): DryRunOutput[] => {
  const outputs: DryRunOutput[] = [];
  for (const path of result.media_field_paths) {
    const raw = readValueByPath(body, path, { silent: true, parseJsonString: undefined });
    if (raw === undefined || raw === null) continue;
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      const output = toDryRunOutput(value, result.media_type, path, result);
      if (output !== null) outputs.push(output);
    }
  }
  return outputs;
};

const collectDryRunOutputs = (result: RecipeResultForm, body: unknown): DryRunOutput[] => {
  // needs_fetch：产物在另一次请求的响应里，试跑样本是轮询响应，无法据此抽取产物。
  if (result.kind === 'needs_fetch') return collectDirectResultOutputsForAfter(result, body);
  return collectDirectResultOutputs(result, body);
};

/** needs_fetch + accept=json：若用户把「取回后的响应」当样本贴进来，也能看到产物。 */
const collectDirectResultOutputsForAfter = (
  result: Extract<RecipeResultForm, { kind: 'needs_fetch' }>,
  body: unknown,
): DryRunOutput[] => (result.after === undefined ? [] : collectDirectResultOutputs(result.after, body));

const dedupeMatchedPaths = (
  paths: readonly { path: string; value: unknown }[],
): InterfaceRecipeDryRunResponse['matched'] => {
  const seen = new Set<string>();
  const matched: InterfaceRecipeDryRunResponse['matched'] = [];
  for (const item of paths) {
    let key = item.path;
    try {
      key = `${item.path}\u0000${JSON.stringify(item.value)}`;
    } catch {
      key = `${item.path}\u0000${String(item.value)}`;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    matched.push({ path: item.path, value: item.value });
  }
  return matched;
};

const collectUnseenPaths = (
  recipe: { success_when: RecipeCondition; failure_when?: RecipeCondition; result: RecipeResultForm },
  body: unknown,
  headers: Headers | undefined,
): string[] => {
  const resultPaths: string[] =
    recipe.result.kind === 'needs_fetch'
      ? [
          recipe.result.identity_field_path,
          ...(recipe.result.after === undefined ? [] : recipe.result.after.media_field_paths),
        ]
      : recipe.result.media_field_paths;
  const candidates = [
    ...collectRecipeConditionPaths(recipe.success_when),
    ...(recipe.failure_when === undefined ? [] : collectRecipeConditionPaths(recipe.failure_when)),
    ...resultPaths,
  ];
  const unseen: string[] = [];
  const seen = new Set<string>();
  for (const path of candidates) {
    const normalized = path.trim();
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    if (!isRecipeConditionPathObservable(body, normalized, headers)) unseen.push(normalized);
  }
  return unseen;
};

type DryRunRecipe = {
  success_when: RecipeCondition;
  failure_when: RecipeCondition | undefined;
  result: RecipeResultForm;
};

/**
 * 试跑草稿：创建体的任意字段子集（契约 `InterfaceRecipeDryRunBodySchema.draft` 的形状）。
 *
 * 用映射类型而不是 `Partial<...>`：schema `.partial()` 的推导结果是「每个键都可以显式为
 * undefined」，而 `exactOptionalPropertyTypes` 下 `Partial` 不接受显式 undefined。
 */
type InterfaceRecipeDraft = {
  [K in keyof InterfaceRecipeCreateBody]?: InterfaceRecipeCreateBody[K] | undefined;
};

type DryRunCandidateResult =
  | ({ ok: true } & DryRunRecipe)
  | { ok: false; message: string };

/**
 * 确定要试跑的配方：草稿字段优先，缺省处叠加已保存配方（`draft.recipe_id` 指定）。
 *
 * 之所以允许叠加而不是二选一：Hub 编辑页可能在「改了名字/判定但还没保存」时试跑，
 * 用户预期是「按我眼前这份草稿走」。
 */
const resolveDryRunRecipe = (draft: InterfaceRecipeDraft | undefined): DryRunCandidateResult => {
  if (draft === undefined) {
    return { ok: false, message: '请先填写一份配方再试跑' };
  }
  const saved = draft.recipe_id === undefined ? null : getInterfaceRecipe(draft.recipe_id);
  if (draft.recipe_id !== undefined && saved === null) {
    return { ok: false, message: '要试跑的配方不存在了，请重新选择' };
  }
  const successWhen = draft.success_when ?? saved?.success_when;
  const result = draft.result ?? saved?.result;
  const familyAdapterId = draft.family_adapter_id ?? saved?.family_adapter_id;
  const failureWhen = draft.failure_when ?? saved?.failure_when;
  if (successWhen === undefined || result === undefined) {
    return { ok: false, message: '试跑需要一份完整的配方：至少要有成功判定和结果形态' };
  }
  if (familyAdapterId === undefined) {
    return { ok: false, message: '试跑需要说明这份配方属于哪个接口类型' };
  }
  const violations = validateInterfaceRecipe({
    family_adapter_id: familyAdapterId,
    success_when: successWhen,
    ...(failureWhen === undefined ? {} : { failure_when: failureWhen }),
    result,
  });
  if (violations.length > 0) {
    return { ok: false, message: describeViolations(violations) };
  }
  return { ok: true, success_when: successWhen, failure_when: failureWhen, result };
};

const handleDryRun = async (
  req: RouterRequest,
  res: RouterResponse,
  corsHeaders: Record<string, string>,
): Promise<void> => {
  const body = await readJsonBodyOrSendError(req, res, corsHeaders);
  if (body == null) return;
  const parsed = InterfaceRecipeDryRunBodySchema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, ERROR_CODES.INVALID_CONFIG, '试跑内容的格式无效，请检查后重试', corsHeaders);
    return;
  }
  const candidate = resolveDryRunRecipe(parsed.data.draft);
  if (!candidate.ok) {
    sendError(res, 400, ERROR_CODES.INVALID_CONFIG, candidate.message, corsHeaders);
    return;
  }
  // 样本与响应头：纯本地求值，不发任何请求。
  const sample = parseSampleValue(parsed.data.sample);
  let headers: Headers | undefined;
  if (parsed.data.headers !== undefined) {
    try {
      headers = new Headers(parsed.data.headers);
    } catch (error) {
      loggingModule.logDebug('[interface-recipe-routes] dry-run: invalid sample headers', {
        error: error instanceof Error ? error.message : String(error),
      });
      sendError(res, 400, ERROR_CODES.INVALID_CONFIG, '响应头的格式无效，请检查后重试', corsHeaders);
      return;
    }
  }

  const successEvaluation = evaluateRecipeCondition(candidate.success_when, sample, headers);
  const failureEvaluation =
    candidate.failure_when === undefined
      ? null
      : evaluateRecipeCondition(candidate.failure_when, sample, headers);

  // 判定顺序固定：先判失败，再判成功，都不命中即继续等待（设计 §5.1）。
  const verdict: InterfaceRecipeDryRunResponse['verdict'] =
    failureEvaluation !== null && failureEvaluation.matched
      ? 'failure'
      : successEvaluation.matched
        ? 'success'
        : 'pending';
  const decisive = verdict === 'failure' && failureEvaluation !== null ? failureEvaluation : successEvaluation;

  const response = InterfaceRecipeDryRunResponseSchema.parse({
    verdict,
    matched: dedupeMatchedPaths(decisive.matchedPaths),
    outputs: collectDryRunOutputs(candidate.result, sample),
    unseen_paths: collectUnseenPaths(
      {
        success_when: candidate.success_when,
        ...(candidate.failure_when === undefined ? {} : { failure_when: candidate.failure_when }),
        result: candidate.result,
      },
      sample,
      headers,
    ),
  });
  sendJson(res, 200, response, NO_STORE_HEADERS(corsHeaders));
};

// ---------------------------------------------------------------------------
// 响应样本路径发现
//
// 展开实现抽到 `result-sample-inspection.cts`（接口格式页的路径发现引用同一份实现），
// 本路由只负责请求体校验与响应封装。
// ---------------------------------------------------------------------------

const handlePathDiscovery = async (
  req: RouterRequest,
  res: RouterResponse,
  corsHeaders: Record<string, string>,
): Promise<void> => {
  const body = await readJsonBodyOrSendError(req, res, corsHeaders);
  if (body == null) return;
  const parsed = InterfaceRecipePathDiscoveryBodySchema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, ERROR_CODES.INVALID_CONFIG, '样本内容的格式无效，请检查后重试', corsHeaders);
    return;
  }
  const sample = parseSampleValue(parsed.data.sample);
  const paths: InterfaceRecipePathDiscoveryResponse['paths'] = [];
  collectSamplePaths(sample, '', paths);
  sendJson(
    res,
    200,
    InterfaceRecipePathDiscoveryResponseSchema.parse({ paths }),
    NO_STORE_HEADERS(corsHeaders),
  );
};

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

const handleCreate = async (
  req: RouterRequest,
  res: RouterResponse,
  corsHeaders: Record<string, string>,
): Promise<void> => {
  const body = await readJsonBodyOrSendError(req, res, corsHeaders);
  if (body == null) return;
  const parsed = InterfaceRecipeCreateBodySchema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, ERROR_CODES.INVALID_CONFIG, describeCreateBodyError(parsed.error.issues), corsHeaders);
    return;
  }
  const violations = validateInterfaceRecipe(buildValidationInput(parsed.data));
  if (violations.length > 0) {
    sendError(res, 400, ERROR_CODES.INVALID_CONFIG, describeViolations(violations), corsHeaders);
    return;
  }
  const result = addInterfaceRecipe({
    ...(parsed.data.recipe_id === undefined ? {} : { recipe_id: parsed.data.recipe_id }),
    name: parsed.data.name,
    family_adapter_id: parsed.data.family_adapter_id,
    success_when: parsed.data.success_when,
    ...(parsed.data.failure_when === undefined ? {} : { failure_when: parsed.data.failure_when }),
    ...(parsed.data.failure_reason === undefined ? {} : { failure_reason: parsed.data.failure_reason }),
    result: parsed.data.result,
    ...(parsed.data.requires_auth === undefined ? {} : { requires_auth: parsed.data.requires_auth }),
  });
  if (!result.ok) {
    if (result.reason === 'already_exists') {
      sendError(
        res,
        409,
        'conflict',
        `已经有「${parsed.data.recipe_id ?? ''}」这份配方了，换一个标识或先删除它再新建`,
        corsHeaders,
      );
      return;
    }
    sendError(res, 400, ERROR_CODES.INVALID_CONFIG, '配方内容格式无效，请检查后重试', corsHeaders);
    return;
  }
  sendJson(
    res,
    200,
    InterfaceRecipeResponseSchema.parse({ recipe: result.recipe }),
    NO_STORE_HEADERS(corsHeaders),
  );
};

const handleUpdate = async (
  req: RouterRequest,
  res: RouterResponse,
  recipeId: string,
  corsHeaders: Record<string, string>,
): Promise<void> => {
  const body = await readJsonBodyOrSendError(req, res, corsHeaders);
  if (body == null) return;
  const parsed = InterfaceRecipeUpdateBodySchema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, ERROR_CODES.INVALID_CONFIG, describeUpdateBodyError(parsed.error.issues), corsHeaders);
    return;
  }
  const existing = getInterfaceRecipe(recipeId);
  if (existing === null) {
    sendError(res, 404, ERROR_CODES.NOT_FOUND, '没有这份配方', corsHeaders);
    return;
  }
  // 更新是「整体替换出现的字段、缺省保持」，因此语义校验必须基于合并后的完整配方。
  // failure_when 三态：缺省 = 保持现有；null = 清除（合入校验时视为没有失败判定，
  // 因此不触发冲突检测等依赖它的分支）；条件树 = 替换。
  const mergedFailureWhen =
    parsed.data.failure_when === undefined
      ? existing.failure_when
      : parsed.data.failure_when === null
        ? undefined
        : parsed.data.failure_when;
  const violations = validateInterfaceRecipe({
    family_adapter_id: existing.family_adapter_id,
    success_when: parsed.data.success_when ?? existing.success_when,
    ...(mergedFailureWhen === undefined ? {} : { failure_when: mergedFailureWhen }),
    result: parsed.data.result ?? existing.result,
  });
  if (violations.length > 0) {
    sendError(res, 400, ERROR_CODES.INVALID_CONFIG, describeViolations(violations), corsHeaders);
    return;
  }
  const updated = updateInterfaceRecipe(recipeId, {
    ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
    ...(parsed.data.success_when === undefined ? {} : { success_when: parsed.data.success_when }),
    ...(parsed.data.failure_when === undefined ? {} : { failure_when: parsed.data.failure_when }),
    ...(parsed.data.failure_reason === undefined ? {} : { failure_reason: parsed.data.failure_reason }),
    ...(parsed.data.result === undefined ? {} : { result: parsed.data.result }),
    ...(parsed.data.requires_auth === undefined ? {} : { requires_auth: parsed.data.requires_auth }),
  });
  if (!updated.ok) {
    if (updated.reason === 'not_found') {
      sendError(res, 404, ERROR_CODES.NOT_FOUND, '没有这份配方', corsHeaders);
      return;
    }
    sendError(res, 400, ERROR_CODES.INVALID_CONFIG, '配方内容格式无效，请检查后重试', corsHeaders);
    return;
  }
  sendJson(
    res,
    200,
    InterfaceRecipeResponseSchema.parse({ recipe: updated.recipe }),
    NO_STORE_HEADERS(corsHeaders),
  );
};

const createInterfaceRecipeRoutes = (): RouteDefinition[] => [
  {
    name: 'interface-recipes',
    match: ({ req, pathname }) =>
      (req.method === 'GET' || req.method === 'POST') && pathname === '/api/interface-recipes',
    handle: async ({ req, res, corsHeaders }) => {
      if (req.method === 'GET') {
        sendJson(
          res,
          200,
          InterfaceRecipeListResponseSchema.parse({ recipes: listInterfaceRecipes() }),
          NO_STORE_HEADERS(corsHeaders),
        );
        return;
      }
      await handleCreate(req, res, corsHeaders);
    },
  },
  {
    // 静态路径必须排在 :recipeId 之前。
    name: 'interface-recipes-dry-run',
    match: ({ req, pathname }) => req.method === 'POST' && pathname === '/api/interface-recipes/dry-run',
    handle: async ({ req, res, corsHeaders }) => {
      await handleDryRun(req, res, corsHeaders);
    },
  },
  {
    name: 'interface-recipes-path-discovery',
    match: ({ req, pathname }) =>
      req.method === 'POST' && pathname === '/api/interface-recipes/path-discovery',
    handle: async ({ req, res, corsHeaders }) => {
      await handlePathDiscovery(req, res, corsHeaders);
    },
  },
  {
    name: 'interface-recipes-by-id',
    match: ({ req, pathname }) => {
      const segs = splitPathname(pathname);
      return (
        segs[0] === 'api' &&
        segs[1] === 'interface-recipes' &&
        segs.length === 3 &&
        (req.method === 'PUT' || req.method === 'DELETE')
      );
    },
    handle: async ({ req, res, pathname, corsHeaders }) => {
      const recipeId = decodeURIComponent(splitPathname(pathname)[2] ?? '');
      if (req.method === 'PUT') {
        await handleUpdate(req, res, recipeId, corsHeaders);
        return;
      }
      if (!removeInterfaceRecipe(recipeId)) {
        sendError(res, 404, ERROR_CODES.NOT_FOUND, '没有这份配方', corsHeaders);
        return;
      }
      // 引用该配方的模型记录不做级联改写：投影期按「配方不存在 → 回落族内置默认」处理，
      // 用户重新保存记录即可换掉引用（不因删除配方而阻断模型可用性）。
      sendJson(
        res,
        200,
        InterfaceRecipeRemovalResponseSchema.parse({ removed_recipe_id: recipeId }),
        NO_STORE_HEADERS(corsHeaders),
      );
    },
  },
];

export { createInterfaceRecipeRoutes };
