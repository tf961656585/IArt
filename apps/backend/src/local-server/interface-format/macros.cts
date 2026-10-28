import { GenerationMediaSlotIdSchema } from '@iart/contracts';
import type { GenerationMediaSlotId } from '@iart/contracts';
import type { InterfaceFormatJsonValue } from './schema.cts';

/**
 * 合成期宏（纯函数，禁止 `eval` / `new Function`）。
 *
 * 为什么需要宏：接口格式是**数据**，而真实族的请求规则树里存在两类只有合成期才知道的事实——
 * ① 某条规则只在某个素材位被本记录接受时才存在（`body.image`、`contents` 的尾帧条目）；
 * ② 某些规则要求「另一个素材位被接受」才成立（keyframe 判断参考位）。用变体 patch 表达这两
 * 件事会让同一份规则树在预设里出现多份拷贝（正是一族一份 TypeScript 工厂的老问题）。
 *
 * 语义：
 * - `{"$slot_present":"<slotId>"}` → boolean；
 * - `{"$any_slot_present":true}` → boolean（本记录至少接受一个素材位）；
 * - `{"$if":<布尔宏|布尔字面量>,"then":<json>,"else":<json>?}` → 选中分支；无 `else` 时结果
 *   为 `$OMIT`；
 * - `$OMIT` 是**内部哨兵**：出现在对象位置时删除该键，出现在数组位置时删除该元素（`then`
 *   分支解析成 `$OMIT` 同样按此传播）；
 * - 处理顺序由调用方保证：先做字符串占位符替换，再调用本模块。
 *
 * 失败一律抛错（错误码可读）：宏是预设作者的意图表达，静默留下 `$if` 会被下游当成一条普通
 * 请求规则，或在请求体里发出一个 `{"$if":...}` 对象。
 */

/** 宏求值上下文：只有「本记录接受哪些素材位」一个事实。 */
export type InterfaceFormatMacroScope = {
  acceptedMediaSlots: ReadonlySet<GenerationMediaSlotId>;
};

/** 内部哨兵：表示「这里什么都不产出」。不进入任何合成产物。 */
const OMIT = Symbol('interface_format_macro_omit');

type MacroResolution = InterfaceFormatJsonValue | typeof OMIT;

/** 出现在最终产物里即视为残留的宏键名（这些键不允许漏到运行时）。 */
const MACRO_RESIDUE_KEYS: ReadonlySet<string> = new Set([
  '$if',
  '$slot_present',
  '$any_slot_present',
  '$OMIT',
]);

const isPlainObject = (
  value: InterfaceFormatJsonValue,
): value is Record<string, InterfaceFormatJsonValue> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const describePath = (path: string): string => (path.length === 0 ? '<root>' : path);

const resolveSlotId = (value: InterfaceFormatJsonValue | undefined, path: string): GenerationMediaSlotId => {
  const parsed = GenerationMediaSlotIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`interface_format_macro_slot_unknown: ${describePath(path)}`);
  }
  return parsed.data;
};

/**
 * 布尔宏求值：只接受布尔字面量与 `$slot_present` / `$any_slot_present`。
 *
 * 嵌套 `$if` 不作为条件（条件必须是「已确定的事实」，不是再选一次分支）——那会让预设作者
 * 写出两层条件却以为它是短路求值，直接拒绝比猜测意图更安全。
 */
const resolveBooleanMacro = (
  value: InterfaceFormatJsonValue | undefined,
  scope: InterfaceFormatMacroScope,
  path: string,
): boolean => {
  if (typeof value === 'boolean') return value;
  if (value === undefined || !isPlainObject(value)) {
    throw new Error(`interface_format_macro_condition_invalid: ${describePath(path)}`);
  }
  const keys = Object.keys(value);
  if (keys.length !== 1) {
    throw new Error(`interface_format_macro_condition_invalid: ${describePath(path)}`);
  }
  if (value.$slot_present !== undefined) {
    const slotId = resolveSlotId(value.$slot_present, `${path}.$slot_present`);
    return scope.acceptedMediaSlots.has(slotId);
  }
  if (value.$any_slot_present !== undefined) {
    if (value.$any_slot_present !== true) {
      throw new Error(`interface_format_macro_any_slot_present_invalid: ${describePath(path)}`);
    }
    return scope.acceptedMediaSlots.size > 0;
  }
  const unknownKey = keys[0] ?? '';
  throw new Error(`interface_format_macro_unknown: ${unknownKey} at ${describePath(path)}`);
};

const resolveMacroObject = (
  value: Record<string, InterfaceFormatJsonValue>,
  macroKey: string,
  scope: InterfaceFormatMacroScope,
  path: string,
): MacroResolution => {
  const keys = Object.keys(value);

  if (macroKey === '$slot_present') {
    if (keys.length !== 1) {
      throw new Error(`interface_format_macro_shape_invalid: ${describePath(path)}`);
    }
    const slotId = resolveSlotId(value.$slot_present, `${path}.$slot_present`);
    return scope.acceptedMediaSlots.has(slotId);
  }

  if (macroKey === '$any_slot_present') {
    if (keys.length !== 1 || value.$any_slot_present !== true) {
      throw new Error(`interface_format_macro_any_slot_present_invalid: ${describePath(path)}`);
    }
    return scope.acceptedMediaSlots.size > 0;
  }

  if (macroKey === '$if') {
    const allowedKeys = new Set(['$if', 'then', 'else']);
    const unexpectedKey = keys.find((key) => !allowedKeys.has(key));
    if (unexpectedKey !== undefined || !('then' in value)) {
      throw new Error(`interface_format_macro_if_shape_invalid: ${describePath(path)}`);
    }
    const condition = resolveBooleanMacro(value.$if, scope, `${path}.$if`);
    const branch = condition ? value.then : value.else;
    if (branch === undefined) return OMIT;
    return resolveValue(branch, scope, `${path}.${condition ? 'then' : 'else'}`);
  }

  throw new Error(`interface_format_macro_unknown: ${macroKey} at ${describePath(path)}`);
};

const resolveValue = (
  value: InterfaceFormatJsonValue,
  scope: InterfaceFormatMacroScope,
  path: string,
): MacroResolution => {
  if (Array.isArray(value)) {
    const items: InterfaceFormatJsonValue[] = [];
    for (const [index, item] of value.entries()) {
      const resolved = resolveValue(item, scope, `${path}[${index}]`);
      if (resolved === OMIT) continue;
      items.push(resolved);
    }
    return items;
  }
  if (!isPlainObject(value)) return value;

  const macroKey = Object.keys(value).find((key) => key.startsWith('$'));
  if (macroKey !== undefined) return resolveMacroObject(value, macroKey, scope, path);

  const resolvedObject: Record<string, InterfaceFormatJsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    const resolved = resolveValue(child, scope, `${path}.${key}`);
    if (resolved === OMIT) continue;
    resolvedObject[key] = resolved;
  }
  return resolvedObject;
};

/**
 * 求值一棵 JSON 树（返回新对象，输入不被修改）。
 *
 * 根节点解析成 `$OMIT` 视为预设错误：调用方要的是一段实际存在的规则/策略，整段消失说明
 * 宏条件写反了（例如拿 `$if` 包裹整棵树却给了不成立的条件）。
 */
export const resolveMacroTree = (
  value: InterfaceFormatJsonValue,
  scope: InterfaceFormatMacroScope,
): InterfaceFormatJsonValue => {
  const resolved = resolveValue(value, scope, '');
  if (resolved === OMIT) {
    throw new Error('interface_format_macro_omitted_root');
  }
  return resolved;
};

const collectMacroResidues = (value: unknown, into: string[]): void => {
  if (into.length >= 5) return;
  if (Array.isArray(value)) {
    for (const item of value) collectMacroResidues(item, into);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (MACRO_RESIDUE_KEYS.has(key)) into.push(key);
      collectMacroResidues(child, into);
    }
  }
};

/**
 * 合成产物终检：仍有宏键即抛错。
 *
 * 宏只允许出现在声明的四个位置（payload_rules / request_strategy / capability /
 * runtime_extras）；出现在别处（如 localization）说明作者把宏当普通 JSON 写进了不该写的段落，
 * 它不会报任何别的错，只会在界面上变成一个 `$if` 字面量。
 */
export const assertNoMacroResidue = (value: unknown): void => {
  const residues: string[] = [];
  collectMacroResidues(value, residues);
  if (residues.length > 0) {
    throw new Error(`interface_format_macro_residue: ${residues.join(' | ')}`);
  }
};
