import {
  RECIPE_ATOM_OPS_REQUIRING_ARRAY_VALUE,
  RECIPE_ATOM_OPS_REQUIRING_VALUE,
  RECIPE_CONDITION_LIMITS,
  type InterfaceRecipe,
  type RecipeCondition,
  type RecipeDirectResult,
  type RecipeResultForm,
} from '@iart/contracts';
import { getFamilyTemplate } from './generation-family-templates.registry.cts';

/**
 * 接口配方语义校验（`docs/custom-providers/接口配方-design.md` §7「保存配方时校验」）。
 *
 * 唯一实现：保存路径（POST/PUT 配方路由）与试跑路径共用同一套函数。
 * **不写成 schema refine**（仓库纪律「持久化 JSON 的 schema 演进」②）：历史文件里一条不一致
 * 会让整条配方在读取时被静默丢弃，跨字段不变量必须落在写入侧。
 *
 * 校验不修改输入、不做 IO（族登记查询走注册表内存表）。
 */

export type InterfaceRecipeViolation = {
  /** 出错字段（契约字段名，供界面定位）；缺省表示整体性错误。 */
  field?: string;
  message: string;
};

/**
 * 校验输入：完整配方语义面（创建体全量 / 更新时由调用方合并既有值后传入）。
 *
 * `requires_auth` / `name` 不参与语义校验，故不要求出现。
 */
export type InterfaceRecipeValidationInput = {
  family_adapter_id: string;
  success_when: RecipeCondition;
  failure_when?: RecipeCondition;
  result: RecipeResultForm;
};

const MAX_NODES = RECIPE_CONDITION_LIMITS.maxNodes;
const MAX_DEPTH = RECIPE_CONDITION_LIMITS.maxDepth;

type ConditionWalkStats = {
  nodes: number;
  maxDepth: number;
};

const normalizePathForConflict = (path: string): string => path.trim().replace(/^\/+/, '');

/** 稳定序列化取值：只用于「同一路径同一取值」判重，不参与业务语义。 */
const stableValueKey = (value: unknown): string => {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

type ValueFact = { path: string; valueKey: string };

const collectValueFacts = (
  condition: RecipeCondition,
  facts: ValueFact[],
): void => {
  if (condition.op === 'all' || condition.op === 'any') {
    for (const child of condition.children) collectValueFacts(child, facts);
    return;
  }
  if (condition.op === 'not') {
    collectValueFacts(condition.condition, facts);
    return;
  }
  if (condition.value === undefined) return;
  facts.push({
    path: normalizePathForConflict(condition.path),
    valueKey: stableValueKey(condition.value),
  });
};

const describeConditionField = (field: string): string =>
  field === 'failure_when' ? '失败判定' : '成功判定';

const walkCondition = (
  condition: RecipeCondition,
  field: string,
  depth: number,
  stats: ConditionWalkStats,
  violations: InterfaceRecipeViolation[],
): void => {
  stats.nodes += 1;
  if (depth > stats.maxDepth) stats.maxDepth = depth;
  const label = describeConditionField(field);

  if (condition.op === 'all' || condition.op === 'any') {
    if (condition.children.length === 0) {
      violations.push({
        field,
        message: `${label}里有一个「全部满足 / 任一满足」分组是空的，请至少放一个条件进去。`,
      });
      return;
    }
    for (const child of condition.children) {
      walkCondition(child, field, depth + 1, stats, violations);
    }
    return;
  }

  if (condition.op === 'not') {
    walkCondition(condition.condition, field, depth + 1, stats, violations);
    return;
  }

  const path = condition.path.trim();
  if (path.length === 0) {
    violations.push({
      field,
      message: `${label}里有一个条件没有填写字段路径，请补上。`,
    });
  }
  if (RECIPE_ATOM_OPS_REQUIRING_VALUE.has(condition.op) && condition.value === undefined) {
    violations.push({
      field,
      message: `${label}里的「${path || '未填路径'}」需要填写比较的值。`,
    });
    return;
  }
  if (RECIPE_ATOM_OPS_REQUIRING_ARRAY_VALUE.has(condition.op) && !Array.isArray(condition.value)) {
    violations.push({
      field,
      message: `${label}里的「${path || '未填路径'}」需要用「属于 / 不属于」时，比较值要写成列表。`,
    });
  }
};

const collectDirectResultPaths = (result: RecipeDirectResult): string[] =>
  result.media_field_paths.map((path) => path.trim()).filter((path) => path.length > 0);

const validateResultForm = (
  result: RecipeResultForm,
  violations: InterfaceRecipeViolation[],
): void => {
  if (result.kind === 'direct_url' || result.kind === 'inline_media') {
    if (collectDirectResultPaths(result).length === 0) {
      violations.push({
        field: 'result',
        message: '请至少填写一个产物所在的字段路径。',
      });
    }
    return;
  }

  // needs_fetch：只给标识、产物要再取一次（设计 §5.2 第三形态）。
  if (result.identity_field_path.trim().length === 0) {
    violations.push({
      field: 'result',
      message: '请填写从哪里读取任务标识的字段路径。',
    });
  }
  if (!result.content_url_template.includes('{id}')) {
    violations.push({
      field: 'result',
      message: '结果地址模板里必须带上 {id}，系统会用它替换成任务标识。',
    });
  }
  if (result.accept === 'binary' && result.media_type === undefined) {
    violations.push({
      field: 'result',
      message: '最终结果是媒体文件时，需要说明它是图片、视频还是音频。',
    });
  }
  if (result.accept === 'json') {
    if (result.after === undefined) {
      violations.push({
        field: 'result',
        message: '最终结果返回的是结构化内容时，需要说明产物在哪个字段。',
      });
    } else if (collectDirectResultPaths(result.after).length === 0) {
      violations.push({
        field: 'result',
        message: '请至少填写一个产物所在的字段路径。',
      });
    }
  }
};

/**
 * 校验一份配方能否保存（返回逐条可读原因；空数组 = 通过）。
 *
 * 覆盖：条件树非空 / 节点数与深度上限 / 原子节点路径非空 / 需要值的操作必须带值 /
 * 需要列表的操作值必须是数组 / needs_fetch 的 `{id}` 占位符与两种 `accept` 的必填项 /
 * 成功与失败条件对同一路径同一取值不得同时成立 / 族必须是已登记族。
 */
const validateInterfaceRecipe = (
  input: InterfaceRecipeValidationInput,
): InterfaceRecipeViolation[] => {
  const violations: InterfaceRecipeViolation[] = [];

  if (getFamilyTemplate(input.family_adapter_id) === null) {
    violations.push({
      field: 'family_adapter_id',
      message: '这个接口类型没有登记，不能用来创建配方。',
    });
  }

  const successStats: ConditionWalkStats = { nodes: 0, maxDepth: 0 };
  walkCondition(input.success_when, 'success_when', 0, successStats, violations);
  if (successStats.nodes === 0) {
    violations.push({ field: 'success_when', message: '请至少填写一个判定成功的条件。' });
  }
  if (successStats.nodes > MAX_NODES) {
    violations.push({
      field: 'success_when',
      message: `成功判定的条件太多了（最多 ${MAX_NODES} 个），请合并或删掉一些。`,
    });
  }
  if (successStats.maxDepth > MAX_DEPTH) {
    violations.push({
      field: 'success_when',
      message: `成功判定的嵌套层级太深（最多 ${MAX_DEPTH} 层），请简化分组。`,
    });
  }

  if (input.failure_when !== undefined) {
    const failureStats: ConditionWalkStats = { nodes: 0, maxDepth: 0 };
    walkCondition(input.failure_when, 'failure_when', 0, failureStats, violations);
    if (failureStats.nodes > MAX_NODES) {
      violations.push({
        field: 'failure_when',
        message: `失败判定的条件太多了（最多 ${MAX_NODES} 个），请合并或删掉一些。`,
      });
    }
    if (failureStats.maxDepth > MAX_DEPTH) {
      violations.push({
        field: 'failure_when',
        message: `失败判定的嵌套层级太深（最多 ${MAX_DEPTH} 层），请简化分组。`,
      });
    }

    // 冲突检测：同一路径同一取值同时被成功与失败条件命中，判定会自相矛盾。
    const successFacts: ValueFact[] = [];
    const failureFacts: ValueFact[] = [];
    collectValueFacts(input.success_when, successFacts);
    collectValueFacts(input.failure_when, failureFacts);
    const failureKeys = new Set(failureFacts.map((fact) => `${fact.path}\u0000${fact.valueKey}`));
    const reported = new Set<string>();
    for (const fact of successFacts) {
      const key = `${fact.path}\u0000${fact.valueKey}`;
      if (!failureKeys.has(key) || reported.has(key)) continue;
      reported.add(key);
      violations.push({
        field: 'failure_when',
        message: `字段「${fact.path}」在成功与失败判定里被允许了同一个取值，两处会互相矛盾，请改掉其中一处。`,
      });
    }
  }

  validateResultForm(input.result, violations);

  return violations;
};

/**
 * 记录引用配方的写入侧校验（纯函数：调用方先取配方再传入）。
 *
 * 返回 null = 可以引用；否则返回可读原因。两条失败必须分开说清，不合并成「配方无效」：
 * 「配方被删了」用户要重新选，族不匹配用户要换配方。
 */
const validateRecipeReference = (
  familyAdapterId: string,
  recipe: InterfaceRecipe | null,
): string | null => {
  if (recipe === null) {
    return '选择的接口配方不存在了，请重新选择一份，或不选配方使用默认判定';
  }
  if (recipe.family_adapter_id !== familyAdapterId) {
    return '这份接口配方绑定的接口类型和当前模型不一致，请换一份配方，或不选配方使用默认判定';
  }
  return null;
};

export { validateInterfaceRecipe, validateRecipeReference, MAX_NODES, MAX_DEPTH };
