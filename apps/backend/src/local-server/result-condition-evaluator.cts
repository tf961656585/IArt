import { readValueByPath } from "./task-engine-polling-utils.cts";
import { normalizeString } from "./task-normalizer.cts";

/**
 * 声明式结果条件树求值器。
 *
 * 事实源与边界：
 * - 形状由 `packages/contracts/src/interface-recipe-contract.ts` 的 `RecipeCondition` 承载；
 * - 本文件是 Runtime Backend 侧唯一求值实现，HTTP 提交失败判定（`failure_condition`）与
 *   轮询判定（`success_condition` / `failure_condition`）共用它，禁止再维护第二套实现；
 * - 只解释响应值，不产生任务状态、不读不写任何存储。
 *
 * 原子操作（与 `RECIPE_ATOM_OPS` 对齐）：
 * `exists / missing / empty / not_empty / eq / neq / in / not_in / contains / gt / gte / lt / lte`
 *
 * 比较语义（唯一口径）：
 * - `eq / neq / in / not_in`：字符串忽略大小写；任一侧是数字时按数值比较（另一侧可解析为
 *   有限数字才成立）；布尔严格相等（`true` 不等于字符串 `"true"`）；对象/数组按 JSON 值比较。
 * - `gt / gte / lt / lte`：只对可转成有限数字的值生效（数字或纯数字字符串），否则为 false。
 * - `contains`：字符串包含子串；数组包含目标元素（元素比较沿用上面的语义）。
 * - `exists`：路径读到的值不是 `undefined`（`null` 也算存在）；`missing` 为其否定。
 * - `empty`：`undefined / null / 空串 / 空白串 / 空数组 / 空对象`。
 *
 * 路径读取与响应头回落：
 * - 复用轮询链路既有 `readValueByPath`，不新写路径解析；
 * - body 未命中（`undefined / null / 空串`）时回落同名响应头，与轮询扁平策略
 *   `isStatusMatchingSuccess` 的既有行为保持一致（部分上游只在响应头携带状态）。
 */

type MatchedConditionPath = {
  path: string;
  value: unknown;
};

type RecipeConditionEvaluation = {
  matched: boolean;
  matchedPaths: MatchedConditionPath[];
};

type OpenObject = object;

const MAX_CONDITION_DEPTH = 16;
const CONDITION_OPS_REQUIRING_NUMERIC_COMPARISON = new Set([
  "gt",
  "gte",
  "lt",
  "lte",
]);
const CONDITION_OP_SET = new Set([
  "exists",
  "missing",
  "empty",
  "not_empty",
  "eq",
  "neq",
  "in",
  "not_in",
  "contains",
  "gt",
  "gte",
  "lt",
  "lte",
]);

const isOpenObject = (value: unknown): value is OpenObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readField = (source: OpenObject | null, key: string): unknown =>
  source ? Reflect.get(source, key) : undefined;

const emptyEvaluation = (): RecipeConditionEvaluation => ({
  matched: false,
  matchedPaths: [],
});

const toScalarString = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return normalizeString(value) || null;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
};

const isEmptyValue = (value: unknown): boolean => {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return normalizeString(value).length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (isOpenObject(value)) return Object.keys(value).length === 0;
  return false;
};

/** 可转成有限数字的值；布尔、对象、空串一律不参与数值比较。 */
const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length === 0) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const compareValues = (actual: unknown, expected: unknown): boolean => {
  if (typeof actual === "boolean" || typeof expected === "boolean") {
    return actual === expected;
  }
  if (typeof actual === "number" || typeof expected === "number") {
    const actualNumber = toFiniteNumber(actual);
    const expectedNumber = toFiniteNumber(expected);
    return (
      actualNumber !== null &&
      expectedNumber !== null &&
      actualNumber === expectedNumber
    );
  }
  if (typeof actual === "string" || typeof expected === "string") {
    return String(actual).toLowerCase() === String(expected).toLowerCase();
  }
  if (actual === null || expected === null) return Object.is(actual, expected);
  try {
    return JSON.stringify(actual) === JSON.stringify(expected);
  } catch {
    return false;
  }
};

const valueContains = (source: unknown, expected: unknown): boolean => {
  if (typeof source === "string") {
    const expectedText = toScalarString(expected);
    return expectedText ? source.includes(expectedText) : false;
  }
  if (Array.isArray(source)) {
    return source.some((item) => compareValues(item, expected));
  }
  return false;
};

const compareNumeric = (
  op: string,
  actual: unknown,
  expected: unknown,
): boolean => {
  if (!CONDITION_OPS_REQUIRING_NUMERIC_COMPARISON.has(op)) return false;
  const actualNumber = toFiniteNumber(actual);
  const expectedNumber = toFiniteNumber(expected);
  if (actualNumber === null || expectedNumber === null) return false;
  if (op === "gt") return actualNumber > expectedNumber;
  if (op === "gte") return actualNumber >= expectedNumber;
  if (op === "lt") return actualNumber < expectedNumber;
  return actualNumber <= expectedNumber;
};

const isHeaderFallbackCandidate = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === "string" && value.trim().length === 0);

/**
 * body 优先、响应头兜底。`Headers.get` 本身大小写不敏感；body 风格路径
 * （如 `data.status`）在响应头上查询返回 null，无副作用。
 */
const resolveActualValue = (
  body: unknown,
  pathText: string,
  headers: Headers | null | undefined,
): unknown => {
  if (!pathText) return body;
  const bodyValue = readValueByPath(body, pathText, {
    silent: true,
    parseJsonString: undefined,
  });
  if (!isHeaderFallbackCandidate(bodyValue)) return bodyValue;
  if (!headers) return bodyValue;
  const headerValue = headers.get(pathText);
  if (headerValue !== null && headerValue.trim() !== "") return headerValue;
  return bodyValue;
};

const evaluateAtom = (
  op: string,
  actual: unknown,
  expected: unknown,
): boolean => {
  if (op === "exists") return actual !== undefined;
  if (op === "missing") return actual === undefined;
  if (op === "empty") return isEmptyValue(actual);
  if (op === "not_empty") return !isEmptyValue(actual);
  if (op === "eq") return compareValues(actual, expected);
  if (op === "neq") return !compareValues(actual, expected);
  if (op === "in") {
    return Array.isArray(expected)
      ? expected.some((item) => compareValues(actual, item))
      : false;
  }
  if (op === "not_in") {
    return Array.isArray(expected)
      ? !expected.some((item) => compareValues(actual, item))
      : true;
  }
  if (op === "contains") return valueContains(actual, expected);
  if (CONDITION_OPS_REQUIRING_NUMERIC_COMPARISON.has(op)) {
    return compareNumeric(op, actual, expected);
  }
  return false;
};

const evaluateConditionInternal = (
  conditionInput: unknown,
  body: unknown,
  headers: Headers | null | undefined,
  depth: number,
): RecipeConditionEvaluation => {
  if (depth > MAX_CONDITION_DEPTH) return emptyEvaluation();
  const condition = isOpenObject(conditionInput) ? conditionInput : null;
  if (!condition) return emptyEvaluation();
  const op = normalizeString(readField(condition, "op")).toLowerCase();
  const childrenValue = readField(condition, "children");

  if (op === "all") {
    if (!Array.isArray(childrenValue) || childrenValue.length === 0) {
      return emptyEvaluation();
    }
    const matchedPaths: MatchedConditionPath[] = [];
    let matched = true;
    for (const child of childrenValue) {
      const childResult = evaluateConditionInternal(child, body, headers, depth + 1);
      matchedPaths.push(...childResult.matchedPaths);
      if (!childResult.matched) matched = false;
    }
    return { matched, matchedPaths };
  }

  if (op === "any") {
    if (!Array.isArray(childrenValue) || childrenValue.length === 0) {
      return emptyEvaluation();
    }
    const matchedPaths: MatchedConditionPath[] = [];
    let matched = false;
    for (const child of childrenValue) {
      const childResult = evaluateConditionInternal(child, body, headers, depth + 1);
      matchedPaths.push(...childResult.matchedPaths);
      if (childResult.matched) matched = true;
    }
    return { matched, matchedPaths };
  }

  if (op === "not") {
    const explicitNested = readField(condition, "condition");
    // Array.isArray 收窄后的元素下标仍是 any，先落到显式 unknown 再合并。
    const legacyNested: unknown = Array.isArray(childrenValue)
      ? childrenValue[0]
      : undefined;
    const nested = explicitNested ?? legacyNested;
    if (nested === undefined) return emptyEvaluation();
    const nestedResult = evaluateConditionInternal(nested, body, headers, depth + 1);
    return {
      matched: !nestedResult.matched,
      matchedPaths: nestedResult.matchedPaths,
    };
  }

  if (!CONDITION_OP_SET.has(op)) return emptyEvaluation();

  const pathText =
    normalizeString(readField(condition, "path")) ||
    normalizeString(readField(condition, "field"));
  const actual = resolveActualValue(body, pathText, headers);
  const expected = readField(condition, "value");
  const matched = evaluateAtom(op, actual, expected);
  return {
    matched,
    matchedPaths:
      matched && pathText
        ? [{ path: pathText, value: actual }]
        : ([] as MatchedConditionPath[]),
  };
};

const evaluateRecipeCondition = (
  condition: unknown,
  body: unknown,
  headers?: Headers | null,
): RecipeConditionEvaluation =>
  evaluateConditionInternal(condition, body, headers ?? null, 0);

const collectPathsInternal = (
  conditionInput: unknown,
  collected: string[],
  depth: number,
): void => {
  if (depth > MAX_CONDITION_DEPTH) return;
  const condition = isOpenObject(conditionInput) ? conditionInput : null;
  if (!condition) return;
  const op = normalizeString(readField(condition, "op")).toLowerCase();
  const childrenValue = readField(condition, "children");
  if (op === "all" || op === "any") {
    if (Array.isArray(childrenValue)) {
      for (const child of childrenValue) {
        collectPathsInternal(child, collected, depth + 1);
      }
    }
    return;
  }
  if (op === "not") {
    const explicitNested = readField(condition, "condition");
    // Array.isArray 收窄后的元素下标仍是 any，先落到显式 unknown 再合并。
    const legacyNested: unknown = Array.isArray(childrenValue)
      ? childrenValue[0]
      : undefined;
    const nested = explicitNested ?? legacyNested;
    collectPathsInternal(nested, collected, depth + 1);
    return;
  }
  if (!CONDITION_OP_SET.has(op)) return;
  const pathText =
    normalizeString(readField(condition, "path")) ||
    normalizeString(readField(condition, "field"));
  if (pathText) collected.push(pathText);
};

/**
 * 收集条件树里引用的全部路径（去重），供诊断使用：
 * 连续多轮「所有引用路径在 body 与响应头都不存在」通常意味着路径填错。
 */
const collectRecipeConditionPaths = (condition: unknown): string[] => {
  const collected: string[] = [];
  collectPathsInternal(condition, collected, 0);
  return Array.from(new Set(collected));
};

/**
 * 路径是否可观测：body 读到非空值，或回落响应头可读到非空值。
 * 与求值器的 body/响应头回落口径一致，只用于诊断留痕，不参与判定。
 */
const isRecipeConditionPathObservable = (
  body: unknown,
  pathText: string,
  headers?: Headers | null,
): boolean => {
  if (!pathText) return true;
  const value = resolveActualValue(body, pathText, headers ?? null);
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
};

export {
  type MatchedConditionPath,
  type RecipeConditionEvaluation,
  evaluateRecipeCondition,
  collectRecipeConditionPaths,
  isRecipeConditionPathObservable,
};
