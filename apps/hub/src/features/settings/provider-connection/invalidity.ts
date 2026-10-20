import type { ExecutableModelFailureCode } from '@iart/contracts';

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
  adapter_missing: '接口类型不可用',
  remote_model_id_empty: '还没填模型 ID',
  deployment_invalid: '配置不完整',
};

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
