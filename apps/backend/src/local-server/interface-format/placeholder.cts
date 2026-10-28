import type { InterfaceFormat } from './schema.cts';

/**
 * 预设里的占位符渲染。
 *
 * 为什么需要占位符：预设是**数据**，不能像 TypeScript 工厂那样在构建时拼接字符串。端点路径、
 * 方法、Content-Type 与 model_id 在合成期才确定，且同一份事实（如 `/v1/images/edits`）要同时
 * 出现在多个段落里（`endpoints` 声明 + 变体 patch 的条件分支）。占位符让这些值只写一次。
 *
 * 支持形态（整串或串内嵌用，`replace` 语义）：
 * - `{{model_id}}`
 * - `{{endpoint:<key>}}`：`transport.endpoints[key]`
 * - `{{method:<stage>}}`：`submit`（= `transport.submit.method`）或 `polling`
 * - `{{content_type:<stage>}}`：`submit`（= `transport.submit.content_type`）
 *
 * 解析不出或解析值不是字符串时**抛错**（错误码可读）：占位符没填是预设作者的笔误，
 * 静默保留原样会在请求组装期变成一个奇怪的 URL；静默替换成空串更糟。
 */

/** 渲染上下文：占位符取值的唯一来源。 */
export type InterfaceFormatPlaceholderContext = {
  modelId: string;
  endpoints: Readonly<Record<string, string>>;
  methods: Readonly<Record<string, string>>;
  contentTypes: Readonly<Record<string, string | null>>;
};

const PLACEHOLDER_PATTERN = /\{\{([a-z_]+)(?::([A-Za-z0-9._-]+))?\}\}/g;

/** 未闭合/未知形态的 `{{` 也按残留处理（错误码统一为 unresolved）。 */
const RESIDUE_MARKER = '{{';

const valueForPlaceholder = (expression: string, context: InterfaceFormatPlaceholderContext): unknown => {
  const match = /^([a-z_]+)(?::([A-Za-z0-9._-]+))?$/.exec(expression);
  if (match === null) return undefined;
  const name = match[1];
  const argument = match[2];
  if (name === 'model_id') {
    return argument === undefined ? context.modelId : undefined;
  }
  if (name === 'endpoint' && argument !== undefined) {
    return context.endpoints[argument];
  }
  if (name === 'method' && argument !== undefined) {
    return context.methods[argument];
  }
  if (name === 'content_type' && argument !== undefined) {
    return context.contentTypes[argument];
  }
  return undefined;
};

/** 单个占位符求值：不可解析或非字符串一律抛错（失败即预设错误，不做降级）。 */
export const resolvePlaceholder = (
  expression: string,
  context: InterfaceFormatPlaceholderContext,
): string => {
  const value = valueForPlaceholder(expression, context);
  if (value === undefined) {
    throw new Error(`interface_format_placeholder_unknown: {{${expression}}}`);
  }
  if (typeof value !== 'string') {
    throw new Error(`interface_format_placeholder_not_a_string: {{${expression}}}`);
  }
  return value;
};

const renderString = (value: string, context: InterfaceFormatPlaceholderContext): string =>
  // 用完整匹配（去掉 `{{` `}}`）作为表达式，避免依赖分组个数（`name` 与 `name:argument`
  // 两种形态的捕获组数不同，按分组取会把参数丢掉）。
  value.replace(PLACEHOLDER_PATTERN, (whole) =>
    resolvePlaceholder(whole.slice('{{'.length, -'}}'.length), context),
  );

/**
 * 占位符渲染的中间态容器（递归重建的开放 JSON 结构）。
 *
 * 命名表达边界：这里承载的是「搬运中的 JSON 值」，形状由预设 schema 在别处裁定
 * （`*Map` 后缀是稳定业务类型门禁认可的开放结构命名）。
 */
type RenderedValueMap = Record<string, unknown>;

const renderValue = (value: unknown, context: InterfaceFormatPlaceholderContext): unknown => {
  if (typeof value === 'string') return renderString(value, context);
  if (Array.isArray(value)) return value.map((item) => renderValue(item, context));
  if (value !== null && typeof value === 'object') {
    const renderedJson: RenderedValueMap = {};
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      renderedJson[key] = renderValue(child, context);
    }
    return renderedJson;
  }
  return value;
};

/** 从格式声明构建渲染上下文（endpoint 键与 stage 名的唯一出口）。 */
export const buildPlaceholderContext = (
  format: InterfaceFormat,
  modelId: string,
): InterfaceFormatPlaceholderContext => {
  const methods: Record<string, string> = { submit: format.transport.submit.method };
  const contentTypes: Record<string, string | null> = {
    submit: format.transport.submit.content_type,
  };
  const asyncTransport = format.transport.async;
  if (asyncTransport !== undefined) {
    methods.polling = asyncTransport.polling.method;
  }
  return {
    modelId,
    endpoints: format.transport.endpoints,
    methods,
    contentTypes,
  };
};

/**
 * 递归渲染一份格式声明（返回新对象，输入不被修改）。
 *
 * 返回 `unknown` 而不是 `InterfaceFormat`：渲染后由调用方用实体 schema 重新 parse 一次，
 * 让「占位符把必填字符串填成了非字符串」这类错误仍在边界暴露（而不是靠类型断言跳过校验）。
 */
export const renderInterfaceFormatPlaceholders = (
  format: InterfaceFormat,
  modelId: string,
): unknown => renderValue(format, buildPlaceholderContext(format, modelId));

/** 收集残留占位符（最多 5 处，用于报错信息）。 */
const collectResidues = (value: unknown, into: string[]): void => {
  if (into.length >= 5) return;
  if (typeof value === 'string') {
    if (value.includes(RESIDUE_MARKER)) into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectResidues(item, into);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) collectResidues(child, into);
  }
};

/**
 * 合成产物的残留占位符终检：仍有 `{{` 即抛错。
 *
 * 这是「占位符只在声明期存在」的机械保证——合成后被消费的 sources 是纯 JSON 事实，
 * 里面出现 `{{...}}` 说明有段落绕过了渲染（或作者写了不支持的形态）。
 */
export const assertNoPlaceholderResidue = (value: unknown): void => {
  const residues: string[] = [];
  collectResidues(value, residues);
  if (residues.length > 0) {
    throw new Error(`interface_format_placeholder_unresolved: ${residues.join(' | ')}`);
  }
};
