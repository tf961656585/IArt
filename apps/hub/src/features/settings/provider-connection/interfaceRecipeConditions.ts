import type {
  InterfaceRecipeCreateBody,
  RecipeCondition,
  RecipeConditionScalar,
} from '@iart/contracts';

/**
 * 接口配方的「简单模式」转换（`docs/custom-providers/接口配方-design.md` §5.1/§8.1）。
 *
 * 持久化只有条件树一份事实源：界面上的「一行 = 一个字段路径 + 一组允许值」是**视图态**，
 * 提交前统一编译成条件树，绝不把扁平字段一起写进请求体。
 *
 * 一行 → 一个原子条件：
 * - 没填允许值 = 只要这个字段存在（`exists`）
 * - 一个允许值 = 相等（`eq`）
 * - 多个允许值 = 属于（`in`）
 *
 * 多行之间是「任一满足」（`any`）——一家服务商的完成信号常有多种写法（状态词、布尔位、
 * 进度阈值），命中任意一种都算完成。只有一行时不套分组，树形保持最短。
 */

export type RecipeConditionRowDraft = {
  path: string;
  valuesText: string;
};

export const emptyConditionRow = (): RecipeConditionRowDraft => ({ path: '', valuesText: '' });

/** 改一行的字段路径（成功 / 失败判定共用；路径发现点选后写入）。 */
export const replaceConditionRowPath = (
  rows: RecipeConditionRowDraft[],
  index: number,
  path: string,
): RecipeConditionRowDraft[] => rows.map((row, i) => (i === index ? { ...row, path } : row));

const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * 把用户写的一个值还原成契约标量。
 *
 * 界面是文本输入：能明确识别为数字 / 布尔的值按对应类型提交（状态码、进度、完成位都常见）；
 * 想强制按文字提交时用引号包起来（例如 `"200"`）。其余一律按文字。
 */
export const parseRecipeValueToken = (raw: string): RecipeConditionScalar | undefined => {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // 引号没配对：按普通文字处理，由后端校验兜底
    }
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (NUMBER_PATTERN.test(trimmed)) return Number(trimmed);
  return trimmed;
};

/** 按英文/中文逗号切分，引号里的逗号不切。 */
const splitValueTokens = (raw: string): string[] => {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  let escaped = false;
  for (const char of raw) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quoted) {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      current += char;
      continue;
    }
    if ((char === ',' || char === '，') && !quoted) {
      tokens.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  tokens.push(current);
  return tokens;
};

/** 解析「允许的值」输入框；也接受整段 JSON 数组（`["a", "b"]`）。 */
export const parseRecipeValues = (raw: string): RecipeConditionScalar[] => {
  const trimmed = raw.trim();
  if (trimmed === '') return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (value): value is RecipeConditionScalar =>
            typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
        );
      }
    } catch {
      // 不是完整 JSON：按逗号分隔文本继续解析
    }
  }
  const values: RecipeConditionScalar[] = [];
  for (const token of splitValueTokens(trimmed)) {
    const value = parseRecipeValueToken(token);
    if (value === undefined) continue;
    if (values.some((existing) => Object.is(existing, value))) continue;
    values.push(value);
  }
  return values;
};

/** 视图态行 → 条件树；没有任何有效路径时返回 null（调用方据此提示「还差一个字段路径」）。 */
export const buildConditionFromRows = (
  rows: readonly RecipeConditionRowDraft[],
): RecipeCondition | null => {
  const children: RecipeCondition[] = [];
  for (const row of rows) {
    const path = row.path.trim();
    if (path === '') continue;
    const values = parseRecipeValues(row.valuesText);
    if (values.length === 0) {
      children.push({ op: 'exists', path });
      continue;
    }
    const first = values[0];
    if (first === undefined) continue;
    if (values.length === 1) {
      children.push({ op: 'eq', path, value: first });
      continue;
    }
    children.push({ op: 'in', path, value: values });
  }
  const only = children[0];
  if (only === undefined) return null;
  if (children.length === 1) return only;
  return { op: 'any', children };
};

/**
 * 条件树 → 视图态行。返回 null 表示「这份判定用简单模式表达不了」。
 *
 * 只接受能被简单模式**无损还原**的形状：`any` 下全部是原子行，或单个原子行。
 * 顶层 `all` 只在只有一个子节点时接受——多项 `all` 若被当成多行再提交会变成 `any`，
 * 语义从「全部满足」翻成「任一满足」，是会被静默保存的错误。
 */
export const conditionToRows = (
  condition: RecipeCondition | null | undefined,
): RecipeConditionRowDraft[] | null => {
  if (condition === null || condition === undefined) return [];

  const atomToRow = (node: RecipeCondition): RecipeConditionRowDraft | null => {
    if (node.op === 'exists') return { path: node.path, valuesText: '' };
    if (node.op === 'eq' && node.value !== undefined && !Array.isArray(node.value)) {
      return { path: node.path, valuesText: formatRecipeValue(node.value) };
    }
    if (node.op === 'in' && Array.isArray(node.value)) {
      // 空列表还原成空输入框会被再提交成 exists，语义会变；这种形状交给原始树保留
      if (node.value.length === 0) return null;
      return { path: node.path, valuesText: node.value.map(formatRecipeValue).join(', ') };
    }
    return null;
  };

  if (condition.op === 'all') {
    // 多项 all 表达不了（会被改成 any）；只有单项时与「一行」等价
    if (condition.children.length !== 1) return null;
    const only = condition.children[0];
    if (only === undefined) return null;
    const row = atomToRow(only);
    return row === null ? null : [row];
  }
  if (condition.op === 'any') {
    const rows: RecipeConditionRowDraft[] = [];
    for (const child of condition.children) {
      const row = atomToRow(child);
      if (row === null) return null;
      rows.push(row);
    }
    return rows;
  }
  const row = atomToRow(condition);
  return row === null ? null : [row];
};

/**
 * 标量 → 输入框文本。会给会被误判成数字/布尔的文字加引号，保证「打开再保存」不改变类型。
 */
export const formatRecipeValue = (value: RecipeConditionScalar): string => {
  if (typeof value !== 'string') return String(value);
  const needsQuoting =
    value === ''
    || value.trim() !== value
    || value.includes(',')
    || value.includes('，')
    || value === 'true'
    || value === 'false'
    || NUMBER_PATTERN.test(value);
  return needsQuoting ? JSON.stringify(value) : value;
};

/**
 * 试跑草稿：创建体的任意字段子集。用映射类型而不是 `Partial`——契约 schema `.partial()`
 * 推导出的键允许显式 `undefined`，与 `exactOptionalPropertyTypes` 下的 `Partial` 不同。
 */
export type InterfaceRecipeDraft = {
  [K in keyof InterfaceRecipeCreateBody]?: InterfaceRecipeCreateBody[K] | undefined;
};
