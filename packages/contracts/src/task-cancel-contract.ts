import * as z from 'zod';

/**
 * 任务取消命令契约（contracts 层）—— POST /api/tasks/:taskId/cancel 的跨边界响应 DTO。
 *
 * 归属与口径对齐：
 * - spec 主口径：`docs/architecture/contracts/task-state-machine.md`（cancel 是命令，不是状态；
 *   持久化取消记录成功后命令才可被视为已接受；结算后任务进入独立 `cancelled` 终态）
 * - spec 主口径：`docs/runtime/固定任务数批次提交与投影语义.md`（用户取消只针对所选 RuntimeTask；
 *   命令被接受并持久化取消记录后 Editor 立即移除任务投影）
 * - 禁止项：已进入正式终态的任务不接受取消；不得用 410 硬切；不得把取消并入 `failed` 或使用 `canceled` 别名。
 */

/**
 * 取消命令被接受的响应体。
 *
 * - accepted：恒为 true 表示命令已被接受且持久化取消记录已建立（否则该响应不会被发出）。
 * - task_id：被取消任务的稳定身份。
 * - cancelled_at：取消记录持久化的 UTC ISO 8601 时间戳（内部存储用途）。
 */
export const TaskCancelAcceptedResponseSchema = z
  .object({
    accepted: z.literal(true),
    task_id: z.string().min(1),
    cancelled_at: z.string(),
  })
  .strict();

export type TaskCancelAcceptedResponse = z.infer<typeof TaskCancelAcceptedResponseSchema>;
