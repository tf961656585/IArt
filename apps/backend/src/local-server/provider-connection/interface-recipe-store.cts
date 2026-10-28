import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import {
  INTERFACE_RECIPE_ID_PATTERN,
  InterfaceRecipeSchema,
  type InterfaceRecipe,
  type RecipeCondition,
  type RecipeResultForm,
} from '@iart/contracts';
import { ensureStorageDirs } from '../storage.cts';
import { INTERFACE_RECIPES_VERSION } from '../constants.cts';
import * as loggingModule from '../logging.cts';
import { isPlainObject } from '../utils.cts';

/**
 * 接口配方公共库（`docs/custom-providers/接口配方-design.md` §4/§7/§9）。
 *
 * - 文件：config/interface-recipes.json（version 1），`{ version, updatedAt, recipes: [] }`
 * - 公共库跨连接共享（2026-10-24 拍板 D1）：一条配方可被任意连接下的模型记录引用，引用时
 *   由写入侧校验族一致；本 store 不感知模型记录，删除配方不做级联清理（投影侧按「配方
 *   不存在 → 回落族内置默认」处理，2026-10-24 拍板 D3 的落地解释）。
 * - 读取逐条 `InterfaceRecipeSchema.safeParse`，失败条目丢弃并留 debug 日志（禁止静默丢失）。
 *   跨字段不变量（条件树语义、needs_fetch 完整性）按仓库纪律不在 schema 里 refine，由
 *   `interface-recipe-validation.cts` 在写入侧唯一校验。
 * - `recipe_id` 缺省时生成，字符集与记录 id 同一规则（进 URL 路径与日志）。
 * - `onInterfaceRecipesChanged` 供装配方注册投影失效回调（与模型记录 store 同名机制对齐）。
 */

const FILE_VERSION = INTERFACE_RECIPES_VERSION;
const RECIPE_ID_PREFIX = 'ir_';

type InterfaceRecipesPathMap = { interfaceRecipes: string | undefined };

export interface InterfaceRecipesFile {
  version: number;
  updatedAt: string;
  recipes: InterfaceRecipe[];
}

const asPathMap = (value: unknown): InterfaceRecipesPathMap | null =>
  isPlainObject(value) ? (value as InterfaceRecipesPathMap) : null;

const getFilePath = (paths: unknown): string | null => {
  const record = asPathMap(paths);
  const filePath = record !== null ? record.interfaceRecipes : undefined;
  return typeof filePath === 'string' && filePath.trim() ? filePath : null;
};

const buildEmptyFile = (): InterfaceRecipesFile => ({
  version: FILE_VERSION,
  updatedAt: new Date(0).toISOString(),
  recipes: [],
});

const normalizeRecipeId = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * 生成配方 id（`ir_` + 时间基 36 进制 + 随机段）。
 *
 * 前缀不承载业务语义，只保证「一眼能看出是配方 id」并且落在契约字符集
 * `^[a-z0-9][a-z0-9._-]*$` 内；同一毫秒内创建多份配方由随机段区分。
 */
const generateInterfaceRecipeId = (): string => {
  const rand = crypto.randomBytes(4).toString('hex').toLowerCase();
  const ts = Date.now().toString(36).toLowerCase();
  return `${RECIPE_ID_PREFIX}${ts}_${rand}`;
};

const readFromDisk = (paths: unknown): InterfaceRecipesFile | null => {
  const filePath = getFilePath(paths);
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!isPlainObject(parsed)) return null;
    const version = Number((parsed as { version: unknown }).version);
    const rawUpdatedAt = (parsed as { updatedAt: unknown }).updatedAt;
    const updatedAt = typeof rawUpdatedAt === 'string' ? rawUpdatedAt : new Date(0).toISOString();
    if (version !== FILE_VERSION) {
      loggingModule.logDebug('[interface-recipe-store] normalizeFile: unsupported version', { version });
      return null;
    }
    const recipes: InterfaceRecipe[] = [];
    const seen = new Set<string>();
    const rawRecipes = (parsed as { recipes: unknown }).recipes;
    if (Array.isArray(rawRecipes)) {
      rawRecipes.forEach((entry, index) => {
        const result = InterfaceRecipeSchema.safeParse(entry);
        if (!result.success) {
          loggingModule.logDebug('[interface-recipe-store] drop invalid recipe record', {
            index,
            error: result.error.message,
          });
          return;
        }
        if (seen.has(result.data.recipe_id)) {
          loggingModule.logDebug('[interface-recipe-store] drop duplicated recipe record', {
            recipeId: result.data.recipe_id,
          });
          return;
        }
        seen.add(result.data.recipe_id);
        recipes.push(result.data);
      });
    }
    return { version: FILE_VERSION, updatedAt, recipes };
  } catch (error) {
    loggingModule.logDebug('[interface-recipe-store] read file failed, treated as empty library', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

const writeToDisk = (paths: unknown, file: InterfaceRecipesFile): void => {
  const filePath = getFilePath(paths);
  if (!filePath) return;
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf-8');
};

let cache: InterfaceRecipesFile | null = null;

const getFile = (): InterfaceRecipesFile => {
  if (cache) return cache;
  const paths: unknown = ensureStorageDirs();
  cache = readFromDisk(paths) ?? buildEmptyFile();
  return cache;
};

type InterfaceRecipesChangeListener = () => void;

const changeListeners = new Set<InterfaceRecipesChangeListener>();

/**
 * 配方变更监听：任一写入落盘成功后触发。本 store 不感知消费方（无业务知识、不反向依赖
 * 路由/投影）：由装配方注册回调使派生快照失效。返回退订函数；监听器抛错只留痕。
 */
const onInterfaceRecipesChanged = (
  listener: InterfaceRecipesChangeListener,
): (() => void) => {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
};

const notifyInterfaceRecipesChanged = (): void => {
  for (const listener of changeListeners) {
    try {
      listener();
    } catch (error) {
      loggingModule.logDebug('[interface-recipe-store] change listener failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
};

const commitFile = (next: InterfaceRecipesFile): InterfaceRecipesFile => {
  const updated: InterfaceRecipesFile = { ...next, updatedAt: new Date().toISOString() };
  const paths: unknown = ensureStorageDirs();
  // 先落盘后置缓存：缓存与磁盘一致，变更通知只代表「落盘成功」。
  writeToDisk(paths, updated);
  cache = updated;
  notifyInterfaceRecipesChanged();
  return updated;
};

/** 公共库里的全部配方（按保存顺序）。 */
const listInterfaceRecipes = (): InterfaceRecipe[] => [...getFile().recipes];

const getInterfaceRecipe = (recipeId: unknown): InterfaceRecipe | null => {
  const id = normalizeRecipeId(recipeId);
  if (!id) return null;
  return getFile().recipes.find((item) => item.recipe_id === id) ?? null;
};

export type AddInterfaceRecipeInput = {
  /** 省略即生成（`ir_` 前缀）；显式给出时必须满足契约字符集（由路由侧 schema 保证）。 */
  recipe_id?: string;
  name: string;
  family_adapter_id: string;
  success_when: RecipeCondition;
  failure_when?: RecipeCondition;
  /** 失败判定命中时展示给用户的失败原因（可选，用户可读文本）。 */
  failure_reason?: string;
  result: RecipeResultForm;
  requires_auth?: boolean;
};

export type AddInterfaceRecipeResult =
  | { ok: true; recipe: InterfaceRecipe }
  | { ok: false; reason: 'already_exists' }
  /** 组装出的配方没通过契约 schema（理论不可达：路由侧已校验同一份形状）。 */
  | { ok: false; reason: 'invalid_recipe' };

const addInterfaceRecipe = (input: AddInterfaceRecipeInput): AddInterfaceRecipeResult => {
  const requestedId = input.recipe_id === undefined ? '' : normalizeRecipeId(input.recipe_id);
  const recipeId = requestedId || generateInterfaceRecipeId();
  if (!INTERFACE_RECIPE_ID_PATTERN.test(recipeId)) {
    loggingModule.logDebug('[interface-recipe-store] add: invalid recipe id', { recipeId });
    return { ok: false, reason: 'invalid_recipe' };
  }
  if (getInterfaceRecipe(recipeId) !== null) {
    loggingModule.logDebug('[interface-recipe-store] add: already exists', { recipeId });
    return { ok: false, reason: 'already_exists' };
  }
  const now = new Date().toISOString();
  const candidate = {
    recipe_id: recipeId,
    name: input.name,
    family_adapter_id: input.family_adapter_id,
    success_when: input.success_when,
    ...(input.failure_when === undefined ? {} : { failure_when: input.failure_when }),
    ...(input.failure_reason === undefined ? {} : { failure_reason: input.failure_reason }),
    result: input.result,
    requires_auth: input.requires_auth ?? false,
    created_at: now,
    updated_at: now,
  };
  const parsed = InterfaceRecipeSchema.safeParse(candidate);
  if (!parsed.success) {
    loggingModule.logDebug('[interface-recipe-store] add: invalid recipe', {
      recipeId,
      error: parsed.error.message,
    });
    return { ok: false, reason: 'invalid_recipe' };
  }
  const file = getFile();
  commitFile({ ...file, recipes: [...file.recipes, parsed.data] });
  return { ok: true, recipe: parsed.data };
};

/**
 * 可改字段（与 `InterfaceRecipeUpdateBodySchema` 同口径）。
 *
 * `family_adapter_id` 与 `recipe_id` 不可改（改族等于换配方身份，改名走删除重建）。
 * 各字段缺省 = 保持现有值；出现 = 整体替换。
 *
 * `failure_when` 是三态（与记录侧 `recipe_id` 同口径）：缺省 = 不动该键；`null` = 从存储
 * 对象上**删除该键**（不写 `null`：契约实体里它是可选条件树，`null` 不是合法值）；
 * 条件树 = 替换。
 */
export type UpdateInterfaceRecipePatch = {
  name?: string;
  success_when?: RecipeCondition;
  failure_when?: RecipeCondition | null;
  /** 与 `failure_when` 同口径三态：缺省保持、`null` 删除该键、文本替换。 */
  failure_reason?: string | null;
  result?: RecipeResultForm;
  requires_auth?: boolean;
};

export type UpdateInterfaceRecipeResult =
  | { ok: true; recipe: InterfaceRecipe }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'invalid_recipe' };

const updateInterfaceRecipe = (
  recipeId: string,
  patch: UpdateInterfaceRecipePatch,
): UpdateInterfaceRecipeResult => {
  const id = normalizeRecipeId(recipeId);
  if (!id) return { ok: false, reason: 'not_found' };
  const file = getFile();
  const index = file.recipes.findIndex((item) => item.recipe_id === id);
  if (index < 0) {
    loggingModule.logDebug('[interface-recipe-store] update: not found', { recipeId: id });
    return { ok: false, reason: 'not_found' };
  }
  const existing = file.recipes[index];
  if (existing === undefined) return { ok: false, reason: 'not_found' };
  const candidate: InterfaceRecipe = {
    ...existing,
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.success_when === undefined ? {} : { success_when: patch.success_when }),
    ...(patch.result === undefined ? {} : { result: patch.result }),
    ...(patch.requires_auth === undefined ? {} : { requires_auth: patch.requires_auth }),
    updated_at: new Date().toISOString(),
  };
  // failure_when 三态：缺省保持、null 删除该键、条件树替换。删除而不是写 null——
  // `.strict()` 实体 schema 里该键是可选条件树，`null` 会让整条配方解析失败。
  if (patch.failure_when === null) {
    delete candidate.failure_when;
  } else if (patch.failure_when !== undefined) {
    candidate.failure_when = patch.failure_when;
  }
  // failure_reason 三态同上：`.strict()` 实体 schema 里它是可选文本，`null` 不是合法值。
  if (patch.failure_reason === null) {
    delete candidate.failure_reason;
  } else if (patch.failure_reason !== undefined) {
    candidate.failure_reason = patch.failure_reason;
  }
  const parsed = InterfaceRecipeSchema.safeParse(candidate);
  if (!parsed.success) {
    loggingModule.logDebug('[interface-recipe-store] update: invalid recipe value', {
      recipeId: id,
      error: parsed.error.message,
    });
    return { ok: false, reason: 'invalid_recipe' };
  }
  const next = file.recipes.map((item, i) => (i === index ? parsed.data : item));
  commitFile({ ...file, recipes: next });
  return { ok: true, recipe: parsed.data };
};

/** 删除配方；返回 false 表示没有这个配方。引用它的模型记录由投影侧按「配方失效」回落。 */
const removeInterfaceRecipe = (recipeId: unknown): boolean => {
  const id = normalizeRecipeId(recipeId);
  if (!id) return false;
  const file = getFile();
  if (!file.recipes.some((item) => item.recipe_id === id)) {
    loggingModule.logDebug('[interface-recipe-store] remove: not found', { recipeId: id });
    return false;
  }
  commitFile({ ...file, recipes: file.recipes.filter((item) => item.recipe_id !== id) });
  return true;
};

const clearCacheForTest = (): void => {
  cache = null;
};

export {
  listInterfaceRecipes,
  getInterfaceRecipe,
  addInterfaceRecipe,
  updateInterfaceRecipe,
  removeInterfaceRecipe,
  onInterfaceRecipesChanged,
  generateInterfaceRecipeId,
  clearCacheForTest,
};
