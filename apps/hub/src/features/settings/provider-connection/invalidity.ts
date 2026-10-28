import type { ExecutableModelFailureCode, InterfaceRecipe } from '@iart/contracts';

/**
 * 可执行模型失效原因码 → 界面文案的映射（纯数据 + 一个计数工具，可单测）。
 *
 * 口径（`docs/custom-providers/provider-config-ui-design.md` §5 与 §3）：
 * - 失效状态的**唯一来源**是后端可执行模型目录端点的 `deployable` 与 `failure_code`；
 *   后端只回原因码、不回展示文案，人话由本模块（Hub 侧唯一映射点）渲染。
 *   Editor 有它自己的一份措辞（它只提示"去主窗口修"），两处不共享文案。
 * - 界面不再使用「退役」：`retired` 与 `disabled` 对用户是同一种状态「已停用」，
 *   区别只在能否恢复；`retired` 仍然后端生命周期事实，只是不翻译成用户可见词。
 * - 不做连接测试：后端无健康探测端点，因此「可用」只表示配置完整、接入关系成立，
 *   不代表已验证连通性，界面不得出现「已通过 / 连接正常」这类结论。
 *
 * 完整性由 `__tests__/invalidity.test.ts` 按 contracts 的 `EXECUTABLE_MODEL_FAILURE_CODES`
 * 全量比对守卫：漏一个原因码就会在界面上出现空白状态，类型系统拦不住。
 */

/**
 * 可执行模型失效原因码 → Hub 文案。
 *
 * 键集合以 contracts 的 `EXECUTABLE_MODEL_FAILURE_CODES` 为准；`none` 表示可执行，
 * 不参与渲染，取值为空串。
 */
export const MODEL_FAILURE_MESSAGE: Readonly<Record<ExecutableModelFailureCode, string>> = {
  none: '',
  // 原因码取值沿用 `no_active_deployment`（跨边界已分发，改名会打断历史数据与 Editor 文案表），
  // 语义是「这个模型没有 active 接入目标」——2026-10-19 部署载体退场后不再指部署。
  no_active_deployment: '还没添加到服务商',
  connection_missing: '关联的服务商已不存在',
  connection_disabled: '服务商已停用',
  connection_retired: '服务商已停用',
  credential_missing: '缺少密钥',
  adapter_missing: '接口格式不可用',
  format_missing: '接口格式已删除',
  format_not_ready: '接口格式未就绪',
  recipe_missing: '缺少接口配方',
  remote_model_id_empty: '还没填模型 ID',
  deployment_invalid: '配置不完整',
};

/**
 * 模型记录引用的接口配方，在界面上处于哪种状态
 * （`docs/custom-providers/接口配方-design.md` §8.5「删除配方后的可见性」）。
 *
 * - `none`：没有引用，按该族内置默认运行——正常状态，不显示任何标记；
 * - `effective`：引用命中同族配方，按用户的配方运行；
 * - `missing`：配方库已成功加载，但这条引用解析不到——运行时回落到内置默认，
 *   界面必须标记，否则用户以为仍在按自己的配方运行（静默降级）；
 * - `unknown`：配方库读取失败——**未知不等于缺失**，不得据此标记任何记录。
 *
 * 判据与运行时同源（`apps/backend/src/local-server/generation-declaration-projection.cts`
 * 的 `resolveReferencedRecipe`）：配方不存在**或**族与记录不一致，都会回落内置默认，
 * 因此两者在界面上同为 `missing`。
 *
 * 本函数是这一判定的唯一实现：模型列表的行标记与「修改配置」弹层里的单点提示共用它，
 * 不得各写一份（两处口径分叉会让列表说失效、弹层说没事）。
 */
export type RecipeReferenceState = 'none' | 'effective' | 'missing' | 'unknown';

export function resolveRecipeReferenceState({
  recipeId,
  familyAdapterId,
  recipes,
  recipesUnavailable,
}: {
  /** 记录上的配方引用；`undefined` = 未引用 */
  recipeId: string | undefined;
  /** 记录自带的接口格式：配方只在同族内有效 */
  familyAdapterId: string;
  /** 配方公共库（全局共享） */
  recipes: readonly InterfaceRecipe[];
  /** 配方库读取失败（对应 `interfaceRecipesUnavailable`） */
  recipesUnavailable: boolean;
}): RecipeReferenceState {
  // 先判「读不到」：此时列表是空的，若继续往下查会把全部引用误判成缺失
  if (recipesUnavailable) return 'unknown';
  if (recipeId === undefined) return 'none';
  const resolved = recipes.some(
    (recipe) => recipe.recipe_id === recipeId && recipe.family_adapter_id === familyAdapterId,
  );
  return resolved ? 'effective' : 'missing';
}

/** 行内失效标记的文案（非交互徽章；详细说明挂在同一行的「?」上） */
export const RECIPE_MISSING_BADGE_LABEL = '配方已失效';

/**
 * 失效标记的悬停说明（可编辑的行）：说清当前实际行为与修复入口。
 *
 * 「重新选一个配方」与「使用内置默认」是记录编辑弹层里「接口配方」下拉的两个选项，
 * 两条路都能让这条标记消失——只写「重新选择配方」会把「我本来就不想用配方」的用户挡在门外。
 */
export const RECIPE_MISSING_HINT =
  '这个模型现在用内置默认判定，不再按你之前选的配方运行。'
  + '想改回来：点这一行的「⋯」菜单，选「修改配置」，在「接口配方」里重新选一个配方，或选「使用内置默认」。';

/** 失效标记的悬停说明（只读行：服务商已停用，行内没有可点的修改入口，不指一条走不通的路） */
export const RECIPE_MISSING_HINT_READONLY =
  '这个模型现在用内置默认判定，不再按你之前选的配方运行。';

/**
 * 统计每个服务商名下有多少个模型（服务商卡片摘要与删除影响面提示用它）。
 *
 * 2026-10-19 起模型只有用户记录一种载体，因此计数只按记录归属数一次——不再有「接入数 + 记录数」
 * 两个来源相加（部署载体退场，那个来源已不存在）。
 */
export function countModelsByConnection(
  records: readonly { connection_id: string }[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const record of records) {
    const current = counts.get(record.connection_id) ?? 0;
    counts.set(record.connection_id, current + 1);
  }
  return counts;
}
