/**
 * 接口格式「参数表」的默认值纯函数。
 *
 * 默认值在界面里始终以字符串持有（不同控件的原始值域不同：文本框任意文本、数字框原始输入、
 * 开关三态、枚举下拉的选项原文），提交前统一在这里换回契约值域并给出非法原因。
 * 保存前校验由 `collectIssues` 的契约校验统一驱动；本文件只补契约表达不了的默认值合法性。
 */

export type ParameterDefaultType = 'string' | 'number' | 'boolean' | 'enum';

export type ParsedDefaultValue =
  | { ok: true; value?: string | number | boolean }
  | { ok: false; message: string };

const NUMBER_INVALID_MESSAGE = '默认值要填数字';
const BOOLEAN_INVALID_MESSAGE = '默认值要选是或否';
const ENUM_INVALID_MESSAGE = '默认值要从可选值里选';

/**
 * 把界面原始值换成契约标量：
 * - `string`：空 → 不设；否则原字符串
 * - `number`：空 → 不设；有限数字 → 数字；否则报错
 * - `boolean`：`'true'` / `'false'` → 布尔；空 → 不设；其他报错
 * - `enum`：空 → 不设；必须是当前可选值之一；否则报错
 */
export const parseDefaultValue = (
  type: ParameterDefaultType,
  raw: string,
  enumValues: readonly string[],
): ParsedDefaultValue => {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true };
  switch (type) {
    case 'string':
      return { ok: true, value: trimmed };
    case 'number': {
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? { ok: true, value: parsed } : { ok: false, message: NUMBER_INVALID_MESSAGE };
    }
    case 'boolean':
      if (trimmed === 'true') return { ok: true, value: true };
      if (trimmed === 'false') return { ok: true, value: false };
      return { ok: false, message: BOOLEAN_INVALID_MESSAGE };
    case 'enum':
      return enumValues.includes(trimmed)
        ? { ok: true, value: trimmed }
        : { ok: false, message: ENUM_INVALID_MESSAGE };
  }
};

/**
 * 切换参数类型时处理默认值：新类型装得下就保留原文，装不下就清空并由调用方给弱提示。
 *
 * 兼容判据是「原文在新类型下能解析成合法值」：`1024` 切到文本仍合法（保留），
 * 布尔 `true` 切到数字装不下（清空）；枚举还要看当前可选值。
 */
export const coerceDefaultForType = (
  raw: string,
  nextType: ParameterDefaultType,
  enumValues: readonly string[],
): { value: string; cleared: boolean } => {
  if (raw.trim() === '') return { value: '', cleared: false };
  const parsed = parseDefaultValue(nextType, raw, enumValues);
  return parsed.ok ? { value: raw, cleared: false } : { value: '', cleared: true };
};
