import { MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY } from "@iart/contracts/model-asset-contract/protocol-constants";
import { isObjectRecord } from "./model-package-catalog.shared.cts";

/**
 * payload_rules 规则树的「字段引用」提取与「禁用裁剪判定」唯一实现。
 *
 * 谁在用这一份（禁止另写第二份遍历）：
 * - `validatePayloadRuleFieldKeysForParts`（投影校验 / 族模板合成终检）：取值引用的字段键必须存在；
 * - `validateParameterOverrides`（保存期）：禁用字段是否参与请求构造；
 * - `applyParameterOverrides`（合成期裁剪）：哪些目标可以整体移除。
 *
 * 三者口径必须一致。历史缺陷：保存期与合成期各写了一份遍历，且合成期那份经由
 * `Record` 判定（排除数组）递归，`compute.args[]` / `entries{}` 里的引用只看得见一半——
 * 保存期放行、合成期删目标或抛 `invalid_payload_rule_field_key`，投影被静默跳过。
 *
 * 采集口径（与 `RuntimeValueRule` / `ModelAssetNodeProjectionRuntimeCondition` 契约同构）：
 * - 取值引用：`{ kind: "field", field_key }`（任意嵌套，含 `fallback`）；
 * - 条件引用：条件叶子节点 `{ op: <eq|ne|gt|gte|lt|lte|includes|excludes|truthy|falsy>, field }`
 *   （`and` / `or` / `not` 是组合节点，自身不带 `field`）。
 *
 * 遍历不分派槽位、不看容器形状：数组、`args`、`entries`、`options`、
 * `build_content_blocks.parts[].value` 一律走同一份深度遍历，新增操作符无需改这里。
 */

/** 一处字段引用：区分「取值」与「条件」两种语义。 */
export type PayloadRuleFieldReference = {
  /** 'value' = kind="field" 的取值引用；'condition' = 条件叶子的判断引用。 */
  role: "value" | "condition";
  field_key: string;
};

/** 单个 payload_rules 目标的分析结果。 */
export type PayloadRuleTargetAnalysis = {
  references: PayloadRuleFieldReference[];
  /**
   * 目标内是否固化过非空字面量（协议常量、固定档位等）。
   * 这类目标被整体移除时会连带丢掉与字段无关的协议内容，因此不可因禁用字段而裁剪。
   */
  has_fixed_literal: boolean;
};

/** 条件叶子算子：这些算子的节点用 `field` 表达「判断哪个参数」。 */
const CONDITION_LEAF_OPS: ReadonlySet<string> = new Set([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "includes",
  "excludes",
  "truthy",
  "falsy",
]);

/**
 * 深度遍历任意 JSON 值，收集其中的全部字段引用。
 *
 * 只认契约里表达「引用某个参数字段」的两种形状，不做字段名猜测：参数 schema 的字段声明
 * （`parameter_schema.fields[]`）与端口声明同样带 `field_key`，靠 `kind === "field"`
 * 把它们排除在外，否则字段声明会被当成自我引用。
 */
export const collectPayloadRuleFieldReferences = (
  value: unknown,
  refs: PayloadRuleFieldReference[] = [],
): PayloadRuleFieldReference[] => {
  if (Array.isArray(value)) {
    for (const item of value) collectPayloadRuleFieldReferences(item, refs);
    return refs;
  }
  if (!isObjectRecord(value)) return refs;
  if (value.kind === "field" && typeof value.field_key === "string") {
    refs.push({ role: "value", field_key: value.field_key });
  }
  if (typeof value.op === "string" && CONDITION_LEAF_OPS.has(value.op) && typeof value.field === "string") {
    refs.push({ role: "condition", field_key: value.field });
  }
  for (const item of Object.values(value)) collectPayloadRuleFieldReferences(item, refs);
  return refs;
};

/** 规则树内是否固化过非空字面量（`{ kind: "literal", value: <非 null> }`）。 */
const hasFixedLiteral = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasFixedLiteral);
  if (!isObjectRecord(value)) return false;
  if (value.kind === "literal" && value.value !== null && value.value !== undefined) return true;
  return Object.values(value).some(hasFixedLiteral);
};

/**
 * 逐 target 分析整张 payload_rules 规则表。
 *
 * 按 target 分别分析而非合并成一个大集合：禁用判定与裁剪都按 target 粒度决策
 * （「这条目标是否只承载被禁用字段自身」），合并会丢掉「哪条目标」这层信息。
 */
export const analyzePayloadRuleTargets = (
  payloadRules: unknown,
): Map<string, PayloadRuleTargetAnalysis> => {
  const analyses = new Map<string, PayloadRuleTargetAnalysis>();
  if (!isObjectRecord(payloadRules)) return analyses;
  for (const [targetPath, rule] of Object.entries(payloadRules)) {
    if (rule === undefined || rule === null) continue;
    analyses.set(targetPath, {
      references: collectPayloadRuleFieldReferences(rule),
      has_fixed_literal: hasFixedLiteral(rule),
    });
  }
  return analyses;
};

/**
 * 禁用字段的裁剪判定：哪些 target 可以整体移除，哪些会拦住保存。
 *
 * 判据（唯一实现，保存期与合成期共用）：
 * - **可裁剪**：目标引用的字段全部落在禁用集合内，且目标内没有固化非空字面量——
 *   即「这条目标的存在意义就是发出这些字段的取值」，移除它只丢掉被禁用字段自己的发出规则。
 * - **拦截**：目标还引用了别的字段，或固化了协议常量（如 `response_format.type = "image"`）。
 *   整体移除会静默改变请求体契约，因此在保存期给出可读拒绝，不允许进入合成。
 */
export const classifyDisabledFieldTargets = (
  payloadRules: unknown,
  disabledFieldKeys: ReadonlySet<string>,
): { prunableTargets: Set<string>; blockingTargets: Map<string, string[]> } => {
  const prunableTargets = new Set<string>();
  const blockingTargets = new Map<string, string[]>();
  if (disabledFieldKeys.size === 0) return { prunableTargets, blockingTargets };
  for (const [targetPath, analysis] of analyzePayloadRuleTargets(payloadRules)) {
    const referencedDisabled = new Set<string>();
    let referencesOnlyDisabled = true;
    for (const ref of analysis.references) {
      if (disabledFieldKeys.has(ref.field_key)) {
        referencedDisabled.add(ref.field_key);
      } else {
        referencesOnlyDisabled = false;
      }
    }
    if (referencedDisabled.size === 0) continue;
    if (referencesOnlyDisabled && !analysis.has_fixed_literal) {
      prunableTargets.add(targetPath);
      continue;
    }
    blockingTargets.set(targetPath, [...referencedDisabled]);
  }
  return { prunableTargets, blockingTargets };
};

/**
 * 规则表的合法字段键集合：参数表单已声明字段 ∪ 提示词保留键（+ 调用方补充的保留键）。
 */
export const collectPayloadRuleValidFieldKeys = (
  parameterFieldKeys: ReadonlyArray<unknown>,
  extraReservedKeys: Iterable<string> = [],
): Set<string> => {
  const valid = new Set<string>();
  for (const fieldKey of parameterFieldKeys) {
    if (typeof fieldKey === "string") valid.add(fieldKey);
  }
  valid.add(MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY);
  for (const key of extraReservedKeys) valid.add(key);
  return valid;
};
