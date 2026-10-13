import type { HubConfigUpdatePayload } from '@iart/contracts';

/**
 * 把部分配置补全成完整更新体：未提供的字段写 `undefined`，backend 按「保留原值」处理。
 *
 * 补全动作只在这里做一份：`/api/config` 的更新体是所有字段平铺的完整对象，每处各写一份
 * 会在新增配置项时漏掉其中一处——漏掉的那处会把该配置静默当成「不改」，表现为「设置保存了但没生效」。
 */
export const buildConfigUpdatePayload = (
  patch: Partial<HubConfigUpdatePayload>,
): HubConfigUpdatePayload => ({
  maxBatchTasks: undefined,
  expandInlineParamsOnStartup: undefined,
  agentDefaultModelId: undefined,
  generationDefaultModelId: undefined,
  proxyMode: undefined,
  proxyUrl: undefined,
  publicRelayTargets: undefined,
  ...patch,
});
