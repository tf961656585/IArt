import {
  extractQueryParamNamesFromPath,
  isForbiddenRequestHeaderName,
  isValidHttpHeaderName,
  isValidHttpHeaderValue,
  isValidQueryParamName,
  isValidQueryParamValue,
} from "@iart/contracts";
import { invalidArguments } from "./errors.cts";
import { isPlainObject } from "./utils.cts";

/**
 * 请求线路（URL / 查询参数 / 请求头）的共用装配原语（**唯一实现**）。
 *
 * 提交、轮询、结果获取、媒体下载四条请求链路都要做同一组事情：把声明里的查询参数合并进
 * 地址、替换模板占位（路径段保留 `/`、查询串完整编码）、校验固定头名称/值、把凭证从任何
 * 会落盘或进日志的文本里抹掉。四处各写一份会出现「同一声明在提交能过、在轮询被拒」的漂移。
 *
 * 边界：
 * - 本模块只做字符串/结构装配，不决定「什么时候注入凭证」（时机归各执行段）。
 * - 名称合法性的判据来自共享契约（`@iart/contracts`），这里只负责把它们串成可读错误。
 */

export type WireQueryEntry = { name: string; value: string };

/**
 * 开放结构的 JSON 对象（键由请求声明或上游响应决定）。
 *
 * 用 `Dynamic*` 命名表达边界：本模块只做占位替换，不拥有这些键的固定字段形状。
 */
type DynamicJsonObject = Record<string, unknown>;

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const normalizeString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

/** 标量 → 查询串取值；对象/数组序列化为 JSON 文本（保持声明的值不丢失）。 */
const stringifyQueryValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value !== null && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
};

const assertQueryEntry = (name: string, value: string, context: string): WireQueryEntry => {
  if (!isValidQueryParamName(name)) {
    throw invalidArguments(
      `${context}: invalid query parameter name "${name}" (letters, digits, "_", ".", "-" and "[]" only)`,
    );
  }
  if (!isValidQueryParamValue(value)) {
    throw invalidArguments(`${context}: query parameter "${name}" contains control characters`);
  }
  return { name, value };
};

/**
 * 把 `api.query` / polling `query` 的声明归一为一组 (name, value)。
 *
 * 支持两种声明形态：`[{name,value}]`（实体轮询段）与 `{name: value}`（请求规则求值产物）。
 * 数组值按重复键展开（`a=1&a=2`）；`undefined` / `null` 跳过；空字符串保留。
 */
export const normalizeQueryEntries = (
  value: unknown,
  context: string,
): WireQueryEntry[] => {
  const entries: WireQueryEntry[] = [];
  if (value === undefined || value === null) return entries;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isPlainObject(item)) continue;
      const name = normalizeString(Reflect.get(item, "name"));
      if (!name) continue;
      const rawValue: unknown = Reflect.get(item, "value");
      if (rawValue === undefined || rawValue === null) continue;
      entries.push(assertQueryEntry(name, stringifyQueryValue(rawValue), context));
    }
    return entries;
  }
  if (!isPlainObject(value)) {
    throw invalidArguments(`${context}: query declaration must be an object or an array of {name,value}`);
  }
  for (const [name, rawValue] of Object.entries(value)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const item of values) {
      if (item === undefined || item === null) continue;
      entries.push(assertQueryEntry(name, stringifyQueryValue(item), context));
    }
  }
  return entries;
};

/**
 * 固定请求头归一（对象或 [{name,value}]），并在装配期完成名称/值校验。
 *
 * 禁止头（`content-type` / `authorization` / 逐跳头）直接报错：它们的单一来源分别是表单
 * `content_type` 与鉴权形状，允许固定头覆盖会让「用户声明 A、实际发 B」变成静默错误。
 */
export const normalizeFixedHeaders = (
  value: unknown,
  context: string,
): Record<string, string> => {
  const result: Record<string, string> = {};
  const entries: Array<[string, unknown]> = [];
  if (value === undefined || value === null) return result;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isPlainObject(item)) continue;
      const name = normalizeString(Reflect.get(item, "name"));
      if (!name) continue;
      entries.push([name, Reflect.get(item, "value")]);
    }
  } else if (isPlainObject(value)) {
    for (const [name, item] of Object.entries(value)) {
      entries.push([name, item]);
    }
  } else {
    throw invalidArguments(`${context}: header declaration must be an object or an array of {name,value}`);
  }
  for (const [name, rawValue] of entries) {
    if (!isValidHttpHeaderName(name)) {
      throw invalidArguments(`${context}: invalid request header name "${name}"`);
    }
    if (isForbiddenRequestHeaderName(name)) {
      throw invalidArguments(
        `${context}: request header "${name}" is managed by the runtime and cannot be declared as a fixed header`,
      );
    }
    if (rawValue === undefined || rawValue === null) continue;
    const text = Array.isArray(rawValue)
      ? rawValue.map((item) => String(item)).join(", ")
      : String(rawValue);
    if (!isValidHttpHeaderValue(text)) {
      throw invalidArguments(`${context}: request header "${name}" contains control characters`);
    }
    result[name] = text;
  }
  return result;
};

/** 断言一组已渲染值的请求头（轮询占位替换后使用；值里不得出现换行等控制字符）。 */
export const assertHeaderValueSafe = (name: string, value: string, context: string): void => {
  if (!isValidHttpHeaderName(name)) {
    throw invalidArguments(`${context}: invalid request header name "${name}"`);
  }
  if (isForbiddenRequestHeaderName(name)) {
    throw invalidArguments(`${context}: request header "${name}" is managed by the runtime`);
  }
  if (!isValidHttpHeaderValue(value)) {
    throw invalidArguments(`${context}: request header "${name}" contains control characters`);
  }
};

const querySeparator = (url: string): string => {
  if (!url.includes("?")) return "?";
  if (url.endsWith("?") || url.endsWith("&")) return "";
  return "&";
};

/**
 * 把查询参数追加到地址（重复键保持重复）。使用 URLSearchParams 编码单值。
 *
 * 纯字符串拼接而不是 `new URL()`：提交地址在装配期可能仍含 `{model}` 占位
 * （模型注入发生在派发期），`new URL` 会把 `{}` 转义成 %7B/%7D，破坏上游路径语义。
 */
export const appendQueryEntries = (url: string, entries: WireQueryEntry[]): string => {
  if (entries.length === 0) return url;
  const params = new URLSearchParams();
  for (const entry of entries) params.append(entry.name, entry.value);
  return `${url}${querySeparator(url)}${params.toString()}`;
};

/**
 * 设置/替换一个查询参数（同名参数全部替换为一个）。用于鉴权查询参数与模型 ID 查询注入。
 *
 * 入参是派发期的绝对地址（`{model}` 已替换），因此可以安全地交给 `URL` 解析。
 */
export const setQueryParamValue = (url: string, name: string, value: string): string => {
  const absolute = /^https?:\/\//i.test(url);
  // 提交地址在派发早期仍可能是相对路径；用一个占位 origin 解析后拼回相对形态。
  const parsed = new URL(url, "http://relative.invalid");
  parsed.searchParams.set(name, value);
  return absolute
    ? parsed.toString()
    : `${parsed.pathname}${parsed.search}${parsed.hash}`;
};

const PLACEHOLDER_PATTERN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const replacePlaceholders = (
  segment: string,
  values: Record<string, string>,
  encode: boolean,
): string =>
  segment.replace(PLACEHOLDER_PATTERN, (match: string, name: string) => {
    if (!hasOwn(values, name)) return match;
    const value = values[name] ?? "";
    return encode ? encodeURIComponent(value) : value;
  });

/**
 * URL 模板占位替换：路径段保留原文（`operation_name` 是 `models/x/operations/y` 形态，
 * 整体编码会破坏上游层级），查询串里的占位完整 `encodeURIComponent`。
 */
export const replaceUrlTemplatePlaceholders = (
  template: string,
  values: Record<string, string>,
): string => {
  const queryIndex = template.indexOf("?");
  if (queryIndex < 0) return replacePlaceholders(template, values, false);
  return (
    replacePlaceholders(template.slice(0, queryIndex), values, false) +
    replacePlaceholders(template.slice(queryIndex), values, true)
  );
};

/** 普通字符串（请求头值 / 请求体字符串）里的占位替换：按原文替换，不做编码。 */
export const replaceTextPlaceholders = (
  text: string,
  values: Record<string, string>,
): string => replacePlaceholders(text, values, false);
/** 递归替换 JSON 结构里的字符串占位（请求体保留原结构，只换叶子字符串）。 */
export const replaceJsonPlaceholders = (
  value: unknown,
  values: Record<string, string>,
): unknown => {
  if (typeof value === "string") return replaceTextPlaceholders(value, values);
  if (Array.isArray(value)) return value.map((item) => replaceJsonPlaceholders(item, values));
  if (isPlainObject(value)) {
    const next: DynamicJsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      next[key] = replaceJsonPlaceholders(item, values);
    }
    return next;
  }
  return value;
};

/** 路径里的静态查询参数名（冲突校验用；共享契约提供解码口径）。 */
export const readStaticQueryParamNames = (url: string): string[] =>
  extractQueryParamNamesFromPath(url);

/**
 * 从任意文本里抹掉凭证（明文与百分号编码两种形态）。
 *
 * 用场景：网络错误消息（`String(error)`）可能带上完整 URL，而查询参数鉴权的凭证就在 URL 里。
 * 凭证只允许存在于 fetch 的那一次调用栈内，不得进入任务记录 / 归档事件 / 日志。
 */
export const redactSecrets = (text: string, secrets: ReadonlyArray<string | null | undefined>): string => {
  let next = text;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length === 0) continue;
    next = next.split(secret).join("***");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) next = next.split(encoded).join("***");
  }
  return next;
};
