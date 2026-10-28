import * as z from 'zod';

import type { RuntimeTaskFailure } from './schemas/runtime-transaction.schema';
import { isRequeryEligibleFailureStage } from './task-failure-stage';

/**
 * 失败任务重新查询契约（跨边界响应 DTO）。
 *
 * 口径（已拍板）：
 * - 重新查询只对 `polling_request` / `polling_timeout` / `result_mapping` 三类失败开放，
 *   且任务必须已有远端任务号（`remoteRequestId`）；
 * - 重新查询复用同一 taskId / remoteRequestId，不新建 batch、不新建 task；
 * - 读取规则用当前最新接口格式与配方，服务商 base_url / executionSnapshot / 凭证版本 pin 在
 *   原快照；给一轮新的等待预算。
 *
 * 本文件只定义跨边界 DTO 与资格判据；服务与路由见
 * `apps/backend/src/local-server/task-requery.cts` 与 `POST /api/tasks/:id/requery`。
 */

export const TaskRequeryAcceptedSchema = z
  .object({
    accepted: z.literal(true),
    taskId: z.string().min(1),
    status: z.literal('polling'),
    requestedAt: z.string(),
  })
  .strict();

export type TaskRequeryAccepted = z.infer<typeof TaskRequeryAcceptedSchema>;

/**
 * 重新查询资格判据（共享纯函数，唯一实现）。
 *
 * 条件：失败阶段属于可重查集合，且远端任务号非空。不读取任务状态——调用方负责先确认任务
 * 处于 `failed` 终态。缺失 stage（旧记录）一律不可重查。
 */
export const isRequeryEligibleFailure = (
  failure: RuntimeTaskFailure | null | undefined,
  remoteRequestId: unknown,
): boolean => {
  if (!failure) return false;
  if (typeof remoteRequestId !== 'string' || remoteRequestId.trim() === '') return false;
  return isRequeryEligibleFailureStage(failure.stage);
};
