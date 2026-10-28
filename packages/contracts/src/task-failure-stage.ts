/**
 * 任务失败阶段契约（跨进程共享）。
 *
 * 失败阶段描述「任务在哪一步失败」，用于两件事：
 * - 用户可见的失败归因（重新查询只对其中三类开放）；
 * - 重新查询的资格判定（唯一可执行判据见 `isRequeryEligibleFailureStage`）。
 *
 * 口径（已拍板）：
 * - 可重查：`polling_request`（轮询请求网络/HTTP 非 2xx）、`polling_timeout`（超过最大尝试次数）、
 *   `result_mapping`（结果输出映射未命中）。
 * - 不可重查但需记录：`submit`（提交阶段失败）、`remote_failure`（远端明确判失败）、
 *   `result_acquisition`（取结果地址失败）、`download`（媒体下载/本地化失败）、
 *   `recovery`（恢复/启动收口/轮询配置类失败）、`unknown`（未分类兜底）。
 *
 * 归属：阶段只随失败信息进入 `failureJson`（不做独立 DB 列）；旧记录无 stage 仍合法。
 */

export const TASK_FAILURE_STAGES = [
  'submit',
  'polling_request',
  'polling_timeout',
  'remote_failure',
  'result_mapping',
  'result_acquisition',
  'download',
  'recovery',
  'unknown',
] as const;

export type TaskFailureStage = (typeof TASK_FAILURE_STAGES)[number];

export const TASK_FAILURE_STAGE_SET = new Set<string>(TASK_FAILURE_STAGES);

/** 允许「重新查询」的失败阶段：轮询请求失败、轮询超时、结果映射未命中。 */
export const REQUERY_ELIGIBLE_FAILURE_STAGES = [
  'polling_request',
  'polling_timeout',
  'result_mapping',
] as const satisfies readonly TaskFailureStage[];

export const REQUERY_ELIGIBLE_FAILURE_STAGE_SET = new Set<string>(
  REQUERY_ELIGIBLE_FAILURE_STAGES,
);

export const isTaskFailureStage = (value: unknown): value is TaskFailureStage =>
  typeof value === 'string' && TASK_FAILURE_STAGE_SET.has(value);

export const isRequeryEligibleFailureStage = (
  stage: unknown,
): stage is (typeof REQUERY_ELIGIBLE_FAILURE_STAGES)[number] =>
  typeof stage === 'string' && REQUERY_ELIGIBLE_FAILURE_STAGE_SET.has(stage);
