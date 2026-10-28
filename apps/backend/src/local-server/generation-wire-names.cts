import {
  GENERATION_MEDIA_SLOT_IDS,
  InterfaceFormatBodyPathSchema,
  interfaceFormatBodyPathsOverlap,
  isForbiddenRequestHeaderName,
  isValidHttpHeaderName,
  isValidQueryParamName,
  normalizeHeaderName,
  parseInterfaceFormatRuleTarget,
} from '@iart/contracts';
import { collectPayloadRuleFieldReferences } from './model-package-catalog.payload-rule-references.cts';
import type { JsonObject } from './model-package-catalog.types.cts';

/**
 * 请求线路上「字段的落点与已占用名称」的唯一事实提取（2026-10-27 请求落点批次）。
 *
 * 背景：参数、提示词、模型 ID 的发送落点从「只在请求体」扩展到请求体 / 查询参数 / 请求头；
 * 请求头名大小写不敏感、查询参数名与请求体路径的字符集各不相同。参数编辑器的即时提示
 * （描述符的 `wire_location` / `reserved_wire_names`）、保存期校验（别名 / 自定义参数查重）
 * 与合成期改写（别名、禁用裁剪）必须用**同一份** target 解析，否则三处会得出不同结论。
 *
 * 本模块只做只读提取，不实现任何业务校验或合成：
 * - `collectReservedWireNames`：三个命名空间里已被规则树占用的名称；
 * - `collectWireNamesByFieldKey`：每个字段当前落在哪个命名空间、叫什么；
 * - `ownedFieldKeyOfRule`：一条规则是否只发出某一个字段的取值。
 *
 * 从 `generation-parameter-overrides.cts` 拆出的原因只是文件行数上限；语义与导出名不变。
 */

/** 参数可以落到的三个命名空间（与请求规则 target 的 kind 同名）。 */
export type FieldWireLocation = 'body' | 'query' | 'header';

/** 一个字段当前在 wire 上的落点：位置 + 该位置内的名称（请求体给完整路径）。 */
export type FieldWireFact = {
  wire_location: FieldWireLocation;
  wire_name: string;
};

/** 三个命名空间各自的已占用名称。 */
export type ReservedWireNames = {
  body: Set<string>;
  query: Set<string>;
  header: Set<string>;
};

/**
 * 系统注入/模态保留的发出键名：任何别名与自定义参数都不得占用。
 *
 * `model` 由 remote_model_id 注入；`prompt`/`input` 是提示词系统键；素材位词表里的每个 id
 * 都保留（它们会作为请求体键或 form 字段名出现，不得被别的参数顶替）。素材位 id 从 contracts
 * 的受控词表派生，不在这里另写一份清单——词表扩容时保留键自动跟随。
 */
export const SYSTEM_RESERVED_WIRE_NAMES: ReadonlySet<string> = new Set([
  'model',
  'prompt',
  'input',
  ...GENERATION_MEDIA_SLOT_IDS,
]);

/**
 * 收集 payload_rules 已占用的线路名称（按命名空间分开）。
 *
 * - 请求体：`body.<路径>` 的**第一段**（祖孙路径写同一个对象，第一段是冲突粒度）+
 *   无点号的顶层键（`prompt` / `input` 等系统回显键）+ 系统保留键；
 * - 查询参数：`api.query.<名称>` 的名称；
 * - 请求头：`api.headers.<名称>` 的名称，**归一化为小写**（HTTP 头名大小写不敏感，
 *   同一个头名在不同大小写下是同一个头）。
 *
 * 导出给族模板的参数描述符构建复用（GET /api/generation-family-templates/:familyAdapterId），
 * 与校验共用同一份保留键事实，不得另写第二份。
 */
export const collectReservedWireNames = (payloadRules: JsonObject | null): ReservedWireNames => {
  const reserved: ReservedWireNames = {
    body: new Set<string>(SYSTEM_RESERVED_WIRE_NAMES),
    query: new Set<string>(),
    header: new Set<string>(),
  };
  if (payloadRules === null) return reserved;
  for (const targetPath of Object.keys(payloadRules)) {
    if (!targetPath.includes('.')) {
      reserved.body.add(targetPath);
      continue;
    }
    const parsed = parseInterfaceFormatRuleTarget(targetPath);
    if (parsed.kind === 'body_field') {
      const first = parsed.path.split('.')[0];
      if (first !== undefined && first.length > 0) reserved.body.add(first);
      continue;
    }
    if (parsed.kind === 'query') {
      reserved.query.add(parsed.name);
      continue;
    }
    if (parsed.kind === 'header') {
      reserved.header.add(normalizeHeaderName(parsed.name));
    }
  }
  return reserved;
};

/** 合并两份保留键集合（描述符要并入其它请求分支的规则）。 */
export const mergeReservedWireNames = (target: ReservedWireNames, extra: ReservedWireNames): void => {
  for (const name of extra.body) target.body.add(name);
  for (const name of extra.query) target.query.add(name);
  for (const name of extra.header) target.header.add(name);
};

/**
 * 规则树「归属字段」的判定：这条规则是否只发出某一个字段的取值（唯一实现）。
 *
 * 判据是**取值引用恰好一个字段**（`kind:'field'` 的深层遍历，含 `compute.args` / `when` 分支）：
 * - 直接 `{kind:'field'}` → 归属该字段；
 * - `when` 包着同一个字段的取值（可选素材位的常见形态）→ 仍归属该字段；
 * - `assert_array_length` 这类断言包装 → 归属其唯一实参字段；
 * - 引用了多个字段、或只发字面量（如 `body.n` 的默认档）→ 不归属任何字段。
 *
 * 为什么不用「kind === 'field'」直接判定：那样包在条件/断言里的素材位规则找不到归属，改名
 * 会静默不生效（保存期已放行、运行时仍发旧字段名），是比报错更危险的形态。
 *
 * 导出给 `interface-format/draft-merge.cts` 复用：编辑合并时的「这条规则属于哪个字段」
 * 必须与别名/禁用共用同一判定，不得在合并侧另写一份。
 */
export const ownedFieldKeyOfRule = (rule: unknown): string | null => {
  const valueKeys = new Set<string>();
  for (const reference of collectPayloadRuleFieldReferences(rule)) {
    if (reference.role === 'value') valueKeys.add(reference.field_key);
  }
  if (valueKeys.size !== 1) return null;
  const only = [...valueKeys];
  return only[0] ?? null;
};

/**
 * 收集每个已声明字段当前的落点与名称（来自 payload_rules 的三个命名空间）。
 *
 * 只看能寻址到 wire 的 target（请求体 / 查询参数 / 请求头）：`meta.*` 是面板语义字段、
 * 顶层 `prompt` / `input` 是回显键，都不参与「参数的发出名称」。同一字段出现多条规则时
 * 取**第一条**（规则树顺序稳定，且同一字段的正常形态只有一处发出）。
 *
 * 导出给描述符构建、校验与别名改写共用同一份 wire 名事实。
 */
export const collectWireNamesByFieldKey = (
  payloadRules: JsonObject | null,
): Map<string, FieldWireFact> => {
  const factByFieldKey = new Map<string, FieldWireFact>();
  if (payloadRules === null) return factByFieldKey;
  for (const [targetPath, rule] of Object.entries(payloadRules)) {
    const parsed = parseInterfaceFormatRuleTarget(targetPath);
    const fieldKey = ownedFieldKeyOfRule(rule);
    if (fieldKey === null || factByFieldKey.has(fieldKey)) continue;
    if (parsed.kind === 'body_field') {
      factByFieldKey.set(fieldKey, { wire_location: 'body', wire_name: parsed.path });
      continue;
    }
    if (parsed.kind === 'query') {
      factByFieldKey.set(fieldKey, { wire_location: 'query', wire_name: parsed.name });
      continue;
    }
    if (parsed.kind === 'header') {
      factByFieldKey.set(fieldKey, { wire_location: 'header', wire_name: parsed.name });
    }
  }
  return factByFieldKey;
};

/** 一条线路名称违规（错误码 + 面向用户的中文句子）；与参数覆盖校验的违规形状兼容。 */
export type WireNameViolation = { code: string; message: string };

// ---------------------------------------------------------------------------
// 发出名称（别名 / 自定义参数）的按位置校验
// ---------------------------------------------------------------------------

const firstBodySegment = (path: string): string => path.split('.')[0] ?? path;

export const isSameWireName = (left: string, right: string, location: FieldWireLocation): boolean =>
  location === 'header' ? normalizeHeaderName(left) === normalizeHeaderName(right) : left === right;

export const wireNameConflicts = (
  left: FieldWireFact,
  right: FieldWireFact,
): boolean => {
  if (left.wire_location !== right.wire_location) return false;
  if (left.wire_location === 'body') return interfaceFormatBodyPathsOverlap(left.wire_name, right.wire_name);
  if (left.wire_location === 'header') {
    return normalizeHeaderName(left.wire_name) === normalizeHeaderName(right.wire_name);
  }
  return left.wire_name === right.wire_name;
};

/**
 * 按字段当前落点校验别名：请求体路径用共享路径规则、查询参数与请求头用共享名称规则。
 *
 * 位置不同，合法字符集不同（请求头是 token、查询参数名放开方括号、请求体路径按点号分段），
 * 混用一份正则会让界面放行的名字在保存时被拒（或反之）。
 */
export const validateAliasName = (
  wire: string,
  location: FieldWireLocation,
  shownName: string,
): WireNameViolation | null => {
  if (location === 'body') {
    return InterfaceFormatBodyPathSchema.safeParse(wire).success
      ? null
      : {
          code: 'wire_name_format',
          message: `参数「${shownName}」的发送名称「${wire}」格式不对：请用字母、数字、_、-，层级之间用点号分隔。`,
        };
  }
  if (location === 'query') {
    return isValidQueryParamName(wire)
      ? null
      : {
          code: 'wire_name_format',
          message: `参数「${shownName}」的查询参数名称「${wire}」格式不对：只能用字母、数字、下划线、点、短横线和方括号。`,
        };
  }
  if (!isValidHttpHeaderName(wire)) {
    return {
      code: 'wire_name_format',
      message: `参数「${shownName}」的请求头名称「${wire}」格式不对：只能用字母、数字和 !#$%&'*+-.^_\`|~ 这些符号。`,
    };
  }
  if (isForbiddenRequestHeaderName(wire)) {
    return {
      code: 'wire_name_reserved',
      message: `参数「${shownName}」的请求头名称「${wire}」由软件自动管理（如 Content-Type、Authorization），请换一个名称。`,
    };
  }
  return null;
};

/**
 * 别名是否撞上「不归这个字段」的既有名称。
 *
 * 请求体按第一段判定（同一棵树上的祖孙路径写同一个对象）；查询参数按名称全等；请求头按
 * 名称大小写不敏感。字段自己当前的名称不算冲突（「改回原名」在调用点已按未修改处理）。
 */
export const aliasHitsReservedName = (
  wire: string,
  location: FieldWireLocation,
  current: FieldWireFact | null,
  reserved: ReservedWireNames,
): boolean => {
  if (location === 'body') {
    if (SYSTEM_RESERVED_WIRE_NAMES.has(wire)) return true;
    const ownFirst = current === null ? null : firstBodySegment(current.wire_name);
    for (const name of reserved.body) {
      if (name === ownFirst) continue;
      if (firstBodySegment(wire) === name) return true;
    }
    return false;
  }
  if (location === 'query') {
    const ownName = current?.wire_name ?? null;
    for (const name of reserved.query) {
      if (name !== ownName && name === wire) return true;
    }
    return false;
  }
  const ownHeader = current === null ? null : normalizeHeaderName(current.wire_name);
  const normalized = normalizeHeaderName(wire);
  for (const name of reserved.header) {
    if (name !== ownHeader && name === normalized) return true;
  }
  return false;
};

