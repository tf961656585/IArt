import type { ExecutableModelFailureCode } from '@iart/contracts';

/**
 * 可执行模型失效原因码 → Editor 现场文案。
 *
 * 口径：目录契约只回稳定原因码（`failure_code`），展示文案由消费端本地渲染——
 * Hub 说「去补密钥」这类可操作指令，Editor 只需要告诉用户"这个模型现在不能用、去主窗口修"，
 * 两处读者与可用动作不同，因此不共享同一份文案，也不允许后端成为文案 owner。
 *
 * 归属依据：`packages/contracts` 只承载 schema 与状态集合，不承载展示文案。
 *
 * 禁止项：本表只做「原因码 → 人话」映射，不得反向成为原因码的事实源；
 * 新增原因码时以 contracts 的 `EXECUTABLE_MODEL_FAILURE_CODES` 为准同步本表。
 */

/** 原因码 → Editor 现场原因文案；`none` 表示可提交，不参与渲染 */
const DEPLOYMENT_FAILURE_TEXT: Readonly<Record<ExecutableModelFailureCode, string>> = {
  none: '',
  no_active_deployment: '这个模型还没有添加到任何服务商',
  connection_missing: '这个模型关联的服务商已不存在',
  connection_disabled: '这个模型关联的服务商已停用',
  connection_retired: '这个模型关联的服务商已停用',
  credential_missing: '这个模型关联的服务商还没填密钥',
  adapter_missing: '这个模型声明的接口类型当前用不了，请到主窗口的「服务商与模型」重新配置。',
  remote_model_id_empty: '这个模型还没填模型 ID',
  deployment_invalid: '这个模型现在用不了，请到主窗口重新配置。',
};

/**
 * 取失效原因的展示文案。
 * `deployable === true`（原因码 `none`）或原因码未在表内时返回兜底文案，
 * 保证界面永远不出现空白原因。
 */
export const describeDeploymentFailure = (failureCode: ExecutableModelFailureCode): string =>
  DEPLOYMENT_FAILURE_TEXT[failureCode] || '这个模型现在用不了，请到主窗口重新配置。';

/**
 * 失效原因 → 修复出口。'hub-providers' = 修复入口在主窗口的「设置 → 服务商与模型」，
 * 界面据此渲染跨窗口跳转动作；null = 修复在 Editor 现场完成（换模型 / 重选），
 * 不渲染跨窗口动作（docs/hub/首次指引-design.md §4.4）。
 */
export const deploymentFailureExit = (failureCode: ExecutableModelFailureCode): 'hub-providers' | null => {
  switch (failureCode) {
    case 'no_active_deployment':
    case 'connection_missing':
    case 'connection_disabled':
    case 'connection_retired':
    case 'credential_missing':
    case 'adapter_missing':
    case 'remote_model_id_empty':
    case 'deployment_invalid':
      return 'hub-providers';
    case 'none':
      return null;
  }
};
