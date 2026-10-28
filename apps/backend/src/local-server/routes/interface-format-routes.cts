import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CustomInterfaceFormatCopyResponseSchema,
  CustomInterfaceFormatCreateBodySchema,
  CustomInterfaceFormatRemovalResponseSchema,
  CustomInterfaceFormatUpdateBodySchema,
  CustomInterfaceFormatWriteResponseSchema,
  InterfaceFormatDetailSchema,
  InterfaceFormatListResponseSchema,
  InterfaceFormatPathDiscoveryBodySchema,
  InterfaceRecipePathDiscoveryResponseSchema,
  type InterfaceRecipePathDiscoveryResponse,
} from '@iart/contracts';
import * as constantsModule from '../constants.cts';
import * as httpUtilsModule from '../http-utils.cts';
import { readJsonBodyOrSendError } from '../http/json-route.cts';
import type { RouteDefinition } from '../http/route-registry.cts';
import * as loggingModule from '../logging.cts';
import {
  buildInterfaceFormatFromDraft,
  buildInterfaceRecipeFromDraft,
  buildUserInterfaceRecipeName,
} from '../interface-format/draft-synthesis.cts';
import { describeDraftBodyError } from '../interface-format/draft-error-copy.cts';
import { mergeInterfaceFormatDraft } from '../interface-format/draft-merge.cts';
import {
  buildCopiedInterfaceFormat,
  buildCopiedInterfaceRecipeName,
  deriveRecipeFromBuiltinBehavior,
} from '../interface-format/copy.cts';
import { loadAllFormats } from '../interface-format/registry.cts';
import {
  buildInterfaceFormatDetail,
  buildInterfaceFormatSummary,
  countModelsUsingFormat,
} from '../interface-format/detail-view.cts';
import type { InterfaceFormat } from '../interface-format/schema.cts';
import {
  addInterfaceFormat,
  generateInterfaceFormatId,
  getUserInterfaceFormat,
  isPresetFormatId,
  nextUserInterfaceFormatOrder,
  removeInterfaceFormat,
  updateInterfaceFormat,
} from '../provider-connection/interface-format-store.cts';
import {
  addInterfaceRecipe,
  listInterfaceRecipes,
  removeInterfaceRecipe,
  updateInterfaceRecipe,
} from '../provider-connection/interface-recipe-store.cts';
import { validateInterfaceRecipe } from '../interface-recipe-validation.cts';
import {
  collectSampleHeaderPaths,
  collectSamplePaths,
  parseSampleValue,
} from '../result-sample-inspection.cts';

/**
 * 接口格式路由（Hub「接口格式」页的数据源，旅程设计 §1.2 / §4）。
 *
 * - GET    /api/interface-formats                              列表（预设 + 用户，按 order 升序）
 * - POST   /api/interface-formats                              创建用户格式（草稿 → 实体 + 判定配方）
 * - GET    /api/interface-formats/:formatId                    详情（身份、传输、素材位、参数、内置行为摘要）
 * - PUT    /api/interface-formats/:formatId                    更新用户格式（id 不可改；同步更新绑定配方）
 * - POST   /api/interface-formats/:formatId/copy               复制格式（整实体克隆 + 配方处理）
 * - DELETE /api/interface-formats/:formatId                    删除用户格式（不级联删配方）
 * - POST   /api/interface-formats/:formatId/path-discovery     样本字段路径发现（纯本地，不发请求）
 *
 * 2026-10-26 批次 B5a：读入口从「只有预设」改为 `loadAllFormats()`（预设 + 用户库）。写入口把
 * Hub 的**声明式草稿**交给 `interface-format/draft-synthesis.cts` 合成实体与配方——路由只负责
 * 校验、身份（id / order）、原子性与可读错误，不重复解释任何字段。
 *
 * 写路径受 Hub write token 保护（`hub-local-write-policy`）；GET 不加。
 *
 * 未知格式（404）、未就绪格式（200 + `status = 'pending'` / 路径发现 409）与「预设不可改」
 * （409）必须可区分：三者分别是「不存在」「存在但运行时规则还没就绪」「内置格式只读」。
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

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

const handleList = (res: RouterResponse, corsHeaders: Record<string, string>): void => {
  const formats = [...loadAllFormats()].sort((left, right) => left.order - right.order);
  sendJson(
    res,
    200,
    InterfaceFormatListResponseSchema.parse({ formats: formats.map(buildInterfaceFormatSummary) }),
    NO_STORE_HEADERS(corsHeaders),
  );
};

const handleDetail = (
  res: RouterResponse,
  formatId: string,
  corsHeaders: Record<string, string>,
): void => {
  const format = loadAllFormats().find((item) => item.format_id === formatId);
  if (format === undefined) {
    loggingModule.logDebug('[interface-format-routes] unknown interface format id', { formatId });
    sendError(res, 404, ERROR_CODES.NOT_FOUND, '没有这个接口格式', corsHeaders);
    return;
  }
  sendJson(
    res,
    200,
    InterfaceFormatDetailSchema.parse(buildInterfaceFormatDetail(format, countModelsUsingFormat(formatId))),
    NO_STORE_HEADERS(corsHeaders),
  );
};

const buildHeaders = (rawHeaders: Record<string, string> | undefined): Headers | null => {
  if (rawHeaders === undefined) return null;
  try {
    return new Headers(rawHeaders);
  } catch {
    return null;
  }
};

const handlePathDiscovery = async (
  req: RouterRequest,
  res: RouterResponse,
  formatId: string,
  corsHeaders: Record<string, string>,
): Promise<void> => {
  const format = loadAllFormats().find((item) => item.format_id === formatId);
  if (format === undefined) {
    loggingModule.logDebug('[interface-format-routes] path discovery: unknown interface format id', { formatId });
    sendError(res, 404, ERROR_CODES.NOT_FOUND, '没有这个接口格式', corsHeaders);
    return;
  }
  if (format.status !== 'ready') {
    loggingModule.logDebug('[interface-format-routes] path discovery: interface format pending', { formatId });
    sendError(res, 409, 'conflict', '这个接口格式还没就绪，暂时不能分析样本', corsHeaders);
    return;
  }

  const body = await readJsonBodyOrSendError(req, res, corsHeaders);
  if (body == null) return;
  const parsed = InterfaceFormatPathDiscoveryBodySchema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, ERROR_CODES.INVALID_CONFIG, '样本内容的格式无效，请检查后重试', corsHeaders);
    return;
  }

  const headers = buildHeaders(parsed.data.headers);
  if (parsed.data.headers !== undefined && headers === null) {
    loggingModule.logDebug('[interface-format-routes] path discovery: invalid sample headers', { formatId });
    sendError(res, 400, ERROR_CODES.INVALID_CONFIG, '响应头的格式无效，请检查后重试', corsHeaders);
    return;
  }

  const paths: InterfaceRecipePathDiscoveryResponse['paths'] = [];
  collectSamplePaths(parseSampleValue(parsed.data.sample), '', paths);
  if (headers !== null) {
    const bodyPaths = paths.map((entry) => entry.path);
    collectSampleHeaderPaths(headers, paths, bodyPaths);
  }
  sendJson(
    res,
    200,
    InterfaceRecipePathDiscoveryResponseSchema.parse({ paths }),
    NO_STORE_HEADERS(corsHeaders),
  );
};

// ---------------------------------------------------------------------------
// 写路由（用户自建格式：草稿 → 实体 + 判定配方）
// ---------------------------------------------------------------------------

const describeFormatViolations = (violations: readonly { message: string }[]): string =>
  violations.map((violation) => violation.message).join('；');

/** 合成实体/配方时抛出的可读错误：交给路由转成 400，而不是 500。 */
const isDraftSynthesisError = (error: unknown): boolean =>
  error instanceof Error && /^interface_format_|^custom_interface_format_/.test(error.message);

const describeSynthesisError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('interface_format_submit_path')) {
    return '请求路径必须是相对路径：以 / 开头，不能带域名，也不能包含 .. 段';
  }
  return '这份接口格式的请求规则没能生效，请检查请求路径、方法与参数后重试';
};

/**
 * 找到与某用户格式绑定的配方。
 *
 * 一个自定义格式在创建时固定生成一份配方（同名同族），创建后用户也可能为该格式手工加配方；
 * 更新时优先改同名那份，其次改该族的第一份，都没有就新建——保证「格式更新后判定与结果形态
 * 跟着一起更新」，而不是悄悄留下旧判定。
 */
const findBoundRecipe = (formatId: string, displayName: string) => {
  const candidates = listInterfaceRecipes().filter((recipe) => recipe.family_adapter_id === formatId);
  if (candidates.length === 0) return null;
  const expectedName = buildUserInterfaceRecipeName(displayName);
  return candidates.find((recipe) => recipe.name === expectedName) ?? candidates[0] ?? null;
};

/** 配方更新补丁（由草稿合成的创建体转成 update 的三态语义：缺省段显式清空）。 */
const toRecipeUpdatePatch = (recipe: ReturnType<typeof buildInterfaceRecipeFromDraft>) => ({
  name: recipe.name,
  success_when: recipe.success_when,
  failure_when: recipe.failure_when ?? null,
  failure_reason: recipe.failure_reason ?? null,
  result: recipe.result,
  requires_auth: recipe.requires_auth ?? false,
});

/**
 * 创建体 → store 入参：把契约里的显式 `undefined` 键去掉。
 *
 * `exactOptionalPropertyTypes` 下 `{ failure_when: undefined }` 与「没有该键」不是同一件事，
 * store 的入参类型按「没有该键」声明；逐项展开是唯一不需要断言的写法。
 */
const toAddRecipeInput = (recipe: ReturnType<typeof buildInterfaceRecipeFromDraft>) => ({
  name: recipe.name,
  family_adapter_id: recipe.family_adapter_id,
  success_when: recipe.success_when,
  result: recipe.result,
  ...(recipe.failure_when === undefined ? {} : { failure_when: recipe.failure_when }),
  ...(recipe.failure_reason === undefined ? {} : { failure_reason: recipe.failure_reason }),
  ...(recipe.requires_auth === undefined ? {} : { requires_auth: recipe.requires_auth }),
});

const handleCreate = async (
  req: RouterRequest,
  res: RouterResponse,
  corsHeaders: Record<string, string>,
): Promise<void> => {
  const body = await readJsonBodyOrSendError(req, res, corsHeaders);
  if (body == null) return;
  const parsed = CustomInterfaceFormatCreateBodySchema.safeParse(body);
  if (!parsed.success) {
    loggingModule.logDebug('[interface-format-routes] create: invalid draft body', {
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
    sendError(res, 400, ERROR_CODES.INVALID_CONFIG, describeDraftBodyError(parsed.error.issues), corsHeaders);
    return;
  }
  const draft = parsed.data;
  const formatId = draft.format_id ?? generateInterfaceFormatId();
  if (isPresetFormatId(formatId)) {
    loggingModule.logDebug('[interface-format-routes] create: id conflicts with preset format', { formatId });
    sendError(res, 409, 'conflict', `「${formatId}」已经是一个内置接口格式的标识，换一个标识再试`, corsHeaders);
    return;
  }
  if (getUserInterfaceFormat(formatId) !== null) {
    loggingModule.logDebug('[interface-format-routes] create: id already exists', { formatId });
    sendError(res, 409, 'conflict', `已经有「${formatId}」这个接口格式了，换一个标识或先删除它`, corsHeaders);
    return;
  }

  const order = nextUserInterfaceFormatOrder();
  let format: InterfaceFormat;
  try {
    format = buildInterfaceFormatFromDraft(draft, { format_id: formatId, order });
  } catch (error) {
    loggingModule.logDebug('[interface-format-routes] create: draft synthesis failed', {
      formatId,
      error: error instanceof Error ? error.message : String(error),
    });
    sendError(
      res,
      400,
      ERROR_CODES.INVALID_CONFIG,
      isDraftSynthesisError(error) ? describeSynthesisError(error) : '这份接口格式没能生成，请检查后重试',
      corsHeaders,
    );
    return;
  }

  // 先落格式再校验配方：自定义格式创建时尚未登记，配方的「族必须已登记」校验会把它判成未知。
  const added = addInterfaceFormat(format);
  if (!added.ok) {
    const status = added.reason === 'invalid_format' ? 400 : 409;
    sendError(
      res,
      status,
      added.reason === 'invalid_format' ? ERROR_CODES.INVALID_CONFIG : 'conflict',
      added.reason === 'invalid_format'
        ? '这份接口格式没能保存，请检查后重试'
        : `已经有「${formatId}」这个接口格式了，换一个标识或先删除它`,
      corsHeaders,
    );
    return;
  }

  const recipeInput = buildInterfaceRecipeFromDraft(draft, formatId);
  // 校验输入形状与配方路由同一份（family_adapter_id 此时已登记为刚写入的用户格式）。
  const violations = validateInterfaceRecipe({
    family_adapter_id: recipeInput.family_adapter_id,
    success_when: recipeInput.success_when,
    ...(recipeInput.failure_when === undefined ? {} : { failure_when: recipeInput.failure_when }),
    result: recipeInput.result,
  });
  if (violations.length > 0) {
    removeInterfaceFormat(formatId);
    loggingModule.logDebug('[interface-format-routes] create: synthesized recipe invalid, format rolled back', {
      formatId,
      violations: violations.map((violation) => violation.message),
    });
    sendError(res, 400, ERROR_CODES.INVALID_CONFIG, describeFormatViolations(violations), corsHeaders);
    return;
  }
  const recipeAdded = addInterfaceRecipe(toAddRecipeInput(recipeInput));
  if (!recipeAdded.ok) {
    removeInterfaceFormat(formatId);
    loggingModule.logDebug('[interface-format-routes] create: recipe write failed, format rolled back', {
      formatId,
      reason: recipeAdded.reason,
    });
    sendError(res, 400, ERROR_CODES.INVALID_CONFIG, '判定配方没能保存，请检查后重试', corsHeaders);
    return;
  }

  sendJson(
    res,
    200,
    CustomInterfaceFormatWriteResponseSchema.parse({
      format_id: formatId,
      recipe_id: recipeAdded.recipe.recipe_id,
      detail: buildInterfaceFormatDetail(added.format, countModelsUsingFormat(formatId)),
    }),
    NO_STORE_HEADERS(corsHeaders),
  );
};

const handleUpdate = async (
  req: RouterRequest,
  res: RouterResponse,
  formatId: string,
  corsHeaders: Record<string, string>,
): Promise<void> => {
  const body = await readJsonBodyOrSendError(req, res, corsHeaders);
  if (body == null) return;
  const parsed = CustomInterfaceFormatUpdateBodySchema.safeParse(body);
  if (!parsed.success) {
    loggingModule.logDebug('[interface-format-routes] update: invalid draft body', {
      formatId,
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
    sendError(res, 400, ERROR_CODES.INVALID_CONFIG, describeDraftBodyError(parsed.error.issues), corsHeaders);
    return;
  }
  const draft = parsed.data;
  const existing = getUserInterfaceFormat(formatId);
  if (existing === null) {
    if (isPresetFormatId(formatId)) {
      loggingModule.logDebug('[interface-format-routes] update: preset format is read-only', { formatId });
      sendError(res, 409, 'conflict', '这是随软件内置的接口格式，不能修改；可以新建一份自己的格式', corsHeaders);
      return;
    }
    loggingModule.logDebug('[interface-format-routes] update: unknown interface format id', { formatId });
    sendError(res, 404, ERROR_CODES.NOT_FOUND, '没有这个接口格式', corsHeaders);
    return;
  }
  if (draft.format_id !== undefined && draft.format_id !== formatId) {
    loggingModule.logDebug('[interface-format-routes] update: format id is immutable', {
      formatId,
      requestedFormatId: draft.format_id,
    });
    sendError(res, 409, 'conflict', '接口格式的标识不能修改；要换标识请删除后重新创建', corsHeaders);
    return;
  }

  let format: InterfaceFormat;
  try {
    // order 保留原值：改内容不该让格式在列表里跳动。
    const synthesized = buildInterfaceFormatFromDraft(draft, { format_id: formatId, order: existing.order });
    // 编辑合并：草稿只表达表单可表示的部分；现有实体里其余请求规则（条件分支、meta、
    // 顶层回显、额外固定头等）由服务端从**已保存实体**带入，客户端无法提供这些规则。
    const merged = mergeInterfaceFormatDraft({ existing, draft, synthesized });
    if (!merged.ok) {
      loggingModule.logDebug('[interface-format-routes] update: draft merge refused', {
        formatId,
        errors: merged.errors,
      });
      sendError(res, 400, ERROR_CODES.INVALID_CONFIG, merged.errors.join(' '), corsHeaders);
      return;
    }
    format = merged.format;
  } catch (error) {
    loggingModule.logDebug('[interface-format-routes] update: draft synthesis failed', {
      formatId,
      error: error instanceof Error ? error.message : String(error),
    });
    sendError(
      res,
      400,
      ERROR_CODES.INVALID_CONFIG,
      isDraftSynthesisError(error) ? describeSynthesisError(error) : '这份接口格式没能生成，请检查后重试',
      corsHeaders,
    );
    return;
  }

  const recipeInput = buildInterfaceRecipeFromDraft(draft, formatId);
  const violations = validateInterfaceRecipe({
    family_adapter_id: recipeInput.family_adapter_id,
    success_when: recipeInput.success_when,
    ...(recipeInput.failure_when === undefined ? {} : { failure_when: recipeInput.failure_when }),
    result: recipeInput.result,
  });
  if (violations.length > 0) {
    sendError(res, 400, ERROR_CODES.INVALID_CONFIG, describeFormatViolations(violations), corsHeaders);
    return;
  }

  // 先写配方再写格式：配方写失败时不改动格式；格式写失败则把配方恢复成写入前的值。
  const bound = findBoundRecipe(formatId, existing.display_name);
  let recipeId: string;
  let rollbackRecipe: (() => void) | null = null;
  if (bound === null) {
    const addedRecipe = addInterfaceRecipe(toAddRecipeInput(recipeInput));
    if (!addedRecipe.ok) {
      sendError(res, 400, ERROR_CODES.INVALID_CONFIG, '判定配方没能保存，请检查后重试', corsHeaders);
      return;
    }
    recipeId = addedRecipe.recipe.recipe_id;
    rollbackRecipe = () => {
      removeInterfaceRecipe(recipeId);
    };
  } else {
    const previousPatch = toRecipeUpdatePatch({
      name: bound.name,
      family_adapter_id: bound.family_adapter_id,
      success_when: bound.success_when,
      ...(bound.failure_when === undefined ? {} : { failure_when: bound.failure_when }),
      ...(bound.failure_reason === undefined ? {} : { failure_reason: bound.failure_reason }),
      result: bound.result,
      requires_auth: bound.requires_auth,
    });
    const updatedRecipe = updateInterfaceRecipe(bound.recipe_id, toRecipeUpdatePatch(recipeInput));
    if (!updatedRecipe.ok) {
      sendError(res, 400, ERROR_CODES.INVALID_CONFIG, '判定配方没能更新，请检查后重试', corsHeaders);
      return;
    }
    recipeId = bound.recipe_id;
    rollbackRecipe = () => {
      updateInterfaceRecipe(bound.recipe_id, previousPatch);
    };
  }

  const updated = updateInterfaceFormat(formatId, format);
  if (!updated.ok) {
    rollbackRecipe?.();
    loggingModule.logDebug('[interface-format-routes] update: format write failed, recipe rolled back', {
      formatId,
      reason: updated.reason,
    });
    sendError(
      res,
      updated.reason === 'not_found' ? 404 : 400,
      updated.reason === 'not_found' ? ERROR_CODES.NOT_FOUND : ERROR_CODES.INVALID_CONFIG,
      updated.reason === 'not_found' ? '没有这个接口格式' : '这份接口格式没能保存，请检查后重试',
      corsHeaders,
    );
    return;
  }

  sendJson(
    res,
    200,
    CustomInterfaceFormatWriteResponseSchema.parse({
      format_id: formatId,
      recipe_id: recipeId,
      detail: buildInterfaceFormatDetail(updated.format, countModelsUsingFormat(formatId)),
    }),
    NO_STORE_HEADERS(corsHeaders),
  );
};

/**
 * 复制接口格式（`POST /api/interface-formats/:formatId/copy`）。
 *
 * 预设与用户格式都可复制；复制体是**服务端整实体克隆**——不经过草稿重新合成，因此预设里
 * 表单表达不到的请求规则（条件端点分支、素材位条件分支、额外固定头、`meta.*`）原样保留。
 * 判定配方：用户格式的绑定配方一并复制；预设只在能可靠派生结果形态时派生配方，否则
 * `recipe_id: null`，由编辑器补全。
 */
const handleCopy = (res: RouterResponse, formatId: string, corsHeaders: Record<string, string>): void => {
  const source = loadAllFormats().find((item) => item.format_id === formatId);
  if (source === undefined) {
    loggingModule.logDebug('[interface-format-routes] copy: unknown interface format id', { formatId });
    sendError(res, 404, ERROR_CODES.NOT_FOUND, '没有这个接口格式', corsHeaders);
    return;
  }
  if (source.status !== 'ready') {
    loggingModule.logDebug('[interface-format-routes] copy: source format is not ready', { formatId });
    sendError(res, 409, 'conflict', '这个接口格式还没就绪，暂时不能复制', corsHeaders);
    return;
  }

  let newFormatId: string | null = null;
  for (let attempt = 0; attempt < 5 && newFormatId === null; attempt += 1) {
    const candidate = generateInterfaceFormatId();
    if (!isPresetFormatId(candidate) && getUserInterfaceFormat(candidate) === null) {
      newFormatId = candidate;
      break;
    }
    loggingModule.logDebug('[interface-format-routes] copy: generated id collided, retrying', { candidate });
  }
  if (newFormatId === null) {
    sendError(res, 500, 'internal_error', '复制没能完成，请重试', corsHeaders);
    return;
  }

  let cloned: InterfaceFormat;
  try {
    cloned = buildCopiedInterfaceFormat(source, {
      format_id: newFormatId,
      order: nextUserInterfaceFormatOrder(),
    });
  } catch (error) {
    loggingModule.logDebug('[interface-format-routes] copy: entity clone failed', {
      formatId,
      error: error instanceof Error ? error.message : String(error),
    });
    sendError(res, 400, ERROR_CODES.INVALID_CONFIG, '这个接口格式没能复制，请检查后重试', corsHeaders);
    return;
  }

  const added = addInterfaceFormat(cloned);
  if (!added.ok) {
    sendError(
      res,
      added.reason === 'invalid_format' ? 400 : 409,
      added.reason === 'invalid_format' ? ERROR_CODES.INVALID_CONFIG : 'conflict',
      added.reason === 'invalid_format'
        ? '这个接口格式没能复制，请检查后重试'
        : '复制出的接口格式标识已被占用，请重试',
      corsHeaders,
    );
    return;
  }

  // 判定配方：用户格式复制其绑定配方；预设尝试从内置行为派生。都不可得时返回 null。
  const boundSourceRecipe =
    source.origin === 'user'
      ? (listInterfaceRecipes().find((recipe) => recipe.family_adapter_id === source.format_id) ?? null)
      : null;
  const recipeInput =
    boundSourceRecipe === null
      ? deriveRecipeFromBuiltinBehavior(added.format, buildCopiedInterfaceRecipeName(source.display_name))
      : {
          name: boundSourceRecipe.name,
          family_adapter_id: newFormatId,
          success_when: boundSourceRecipe.success_when,
          ...(boundSourceRecipe.failure_when === undefined ? {} : { failure_when: boundSourceRecipe.failure_when }),
          ...(boundSourceRecipe.failure_reason === undefined ? {} : { failure_reason: boundSourceRecipe.failure_reason }),
          result: boundSourceRecipe.result,
          requires_auth: boundSourceRecipe.requires_auth,
        };

  let recipeId: string | null = null;
  if (recipeInput !== null) {
    const violations = validateInterfaceRecipe({
      family_adapter_id: recipeInput.family_adapter_id,
      success_when: recipeInput.success_when,
      ...(recipeInput.failure_when === undefined ? {} : { failure_when: recipeInput.failure_when }),
      result: recipeInput.result,
    });
    if (violations.length > 0) {
      removeInterfaceFormat(newFormatId);
      loggingModule.logDebug('[interface-format-routes] copy: derived recipe invalid, format rolled back', {
        formatId,
        violations: violations.map((violation) => violation.message),
      });
      sendError(res, 400, ERROR_CODES.INVALID_CONFIG, describeFormatViolations(violations), corsHeaders);
      return;
    }
    const copyRecipeInput = {
      name: recipeInput.name,
      family_adapter_id: recipeInput.family_adapter_id,
      success_when: recipeInput.success_when,
      result: recipeInput.result,
      ...(recipeInput.failure_when === undefined ? {} : { failure_when: recipeInput.failure_when }),
      ...(recipeInput.failure_reason === undefined ? {} : { failure_reason: recipeInput.failure_reason }),
      ...(recipeInput.requires_auth === undefined ? {} : { requires_auth: recipeInput.requires_auth }),
    };
    const recipeAdded = addInterfaceRecipe(copyRecipeInput);
    if (!recipeAdded.ok) {
      removeInterfaceFormat(newFormatId);
      loggingModule.logDebug('[interface-format-routes] copy: recipe write failed, format rolled back', {
        formatId,
        reason: recipeAdded.reason,
      });
      sendError(res, 400, ERROR_CODES.INVALID_CONFIG, '判定配方没能保存，请检查后重试', corsHeaders);
      return;
    }
    recipeId = recipeAdded.recipe.recipe_id;
  } else {
    loggingModule.logDebug('[interface-format-routes] copy: no recipe derived, editor must complete behavior', {
      formatId,
      newFormatId,
    });
  }

  sendJson(
    res,
    200,
    CustomInterfaceFormatCopyResponseSchema.parse({
      format_id: newFormatId,
      recipe_id: recipeId,
      detail: buildInterfaceFormatDetail(added.format, countModelsUsingFormat(newFormatId)),
    }),
    NO_STORE_HEADERS(corsHeaders),
  );
};

const handleDelete = (res: RouterResponse, formatId: string, corsHeaders: Record<string, string>): void => {
  if (getUserInterfaceFormat(formatId) === null && isPresetFormatId(formatId)) {
    loggingModule.logDebug('[interface-format-routes] delete: preset format is read-only', { formatId });
    sendError(res, 409, 'conflict', '这是随软件内置的接口格式，不能删除', corsHeaders);
    return;
  }
  if (!removeInterfaceFormat(formatId)) {
    loggingModule.logDebug('[interface-format-routes] delete: unknown interface format id', { formatId });
    sendError(res, 404, ERROR_CODES.NOT_FOUND, '没有这个接口格式', corsHeaders);
    return;
  }
  // 不级联删配方：配方是公共库对象，可能有其它记录引用；引用本格式的记录在投影期
  // 因「格式未登记」自然进入失效态（与「配方被删 → 回落默认」是两件事）。
  sendJson(
    res,
    200,
    CustomInterfaceFormatRemovalResponseSchema.parse({ removed_format_id: formatId }),
    NO_STORE_HEADERS(corsHeaders),
  );
};

const createInterfaceFormatRoutes = (): RouteDefinition[] => [
  {
    name: 'interface-formats',
    match: ({ req, pathname }) =>
      (req.method === 'GET' || req.method === 'POST') && pathname === '/api/interface-formats',
    handle: async ({ req, res, corsHeaders }) => {
      if (req.method === 'GET') {
        handleList(res, corsHeaders);
        return;
      }
      await handleCreate(req, res, corsHeaders);
    },
  },
  {
    // 静态尾段（/copy、/path-discovery）先于 /:formatId 排布，避免后续加方法时误吞。
    name: 'interface-format-copy',
    match: ({ req, pathname }) => {
      if (req.method !== 'POST') return false;
      const segs = splitPathname(pathname);
      return (
        segs[0] === 'api' &&
        segs[1] === 'interface-formats' &&
        segs.length === 4 &&
        segs[3] === 'copy'
      );
    },
    handle: ({ res, pathname, corsHeaders }) => {
      const formatId = decodeURIComponent(splitPathname(pathname)[2] ?? '');
      handleCopy(res, formatId, corsHeaders);
    },
  },
  {
    // 静态尾段（/path-discovery）先于 /:formatId 排布，避免后续加方法时误吞。
    name: 'interface-format-path-discovery',
    match: ({ req, pathname }) => {
      if (req.method !== 'POST') return false;
      const segs = splitPathname(pathname);
      return (
        segs[0] === 'api' &&
        segs[1] === 'interface-formats' &&
        segs.length === 4 &&
        segs[3] === 'path-discovery'
      );
    },
    handle: async ({ req, res, pathname, corsHeaders }) => {
      const formatId = decodeURIComponent(splitPathname(pathname)[2] ?? '');
      await handlePathDiscovery(req, res, formatId, corsHeaders);
    },
  },
  {
    name: 'interface-format-by-id',
    match: ({ req, pathname }) => {
      const segs = splitPathname(pathname);
      return (
        segs[0] === 'api' &&
        segs[1] === 'interface-formats' &&
        segs.length === 3 &&
        (req.method === 'PUT' || req.method === 'DELETE')
      );
    },
    handle: async ({ req, res, pathname, corsHeaders }) => {
      const formatId = decodeURIComponent(splitPathname(pathname)[2] ?? '');
      if (req.method === 'PUT') {
        await handleUpdate(req, res, formatId, corsHeaders);
        return;
      }
      handleDelete(res, formatId, corsHeaders);
    },
  },
  {
    name: 'interface-format-detail',
    match: ({ req, pathname }) => {
      if (req.method !== 'GET') return false;
      const segs = splitPathname(pathname);
      return segs[0] === 'api' && segs[1] === 'interface-formats' && segs.length === 3;
    },
    handle: ({ res, pathname, corsHeaders }) => {
      const formatId = decodeURIComponent(splitPathname(pathname)[2] ?? '');
      handleDetail(res, formatId, corsHeaders);
    },
  },
];

export {
  createInterfaceFormatRoutes,
  buildInterfaceFormatSummary,
  buildInterfaceFormatDetail,
};
