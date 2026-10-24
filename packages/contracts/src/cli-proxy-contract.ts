import * as z from 'zod';

import { CliErrorSchema } from './cli-error-code';
import { CliAssetImportParamsSchema, CliAssetImportResultSchema } from './cli-asset-import-contract';
import {
  CliCanvasGroupCreateParamsSchema,
  CliCanvasGroupCreateResultSchema,
  CliCanvasGroupDissolveParamsSchema,
  CliCanvasGroupMembersParamsSchema,
  CliCanvasGroupRenameParamsSchema,
  CliCanvasGroupRenameResultSchema,
  CliCanvasNodeMoveParamsSchema,
  CliCanvasNodeDeleteParamsSchema,
  CliCanvasNodeCreateParamsSchema,
  CliCanvasNodeCreateResultSchema,
  CliCanvasLayoutParamsSchema,
  CliCanvasSelectionSchema,
  CliCanvasGroupAddOutcomeSchema,
  CliCanvasGroupRemoveOutcomeSchema,
} from './cli-canvas-contract';
import { CliCanvasGeometryGetResultSchema } from './cli-canvas-inspect-contract';
import { CliCanvasLayoutPlanSchema } from './cli-canvas-plan-contract';
import {
  CliCanvasGroupMoveParamsSchema,
  CliCanvasNodesMoveParamsSchema,
  CliCanvasUndoParamsSchema,
  CliCanvasLayoutResultSchema,
  CliCanvasNodeMoveResultSchema,
  CliCanvasGroupMoveResultSchema,
  CliCanvasNodesMoveResultSchema,
  CliCanvasUndoResultSchema,
} from './cli-canvas-write-contract';
import { CliGenerateParamsSchema } from './cli-generate-contract';
import { CliGenerateAcceptanceSchema } from './cli-response-dto-contract';
import { CliTaskCancelParamsSchema } from './cli-response-dto-contract';
import { TaskCancelAcceptedResponseSchema } from './task-cancel-contract';

/**
 * CLI 代理执行通道契约（spec §6.3，Main → 画布窗口方向）。
 *
 * 从 cli-contract.ts 拆出的职责边界（行数预算拆分）：命令请求、结果与错误三个判别联合，
 * 以及全量响应联合。参数/结果形状与 B 命令面共享同一 schema（不复制字段）；
 * 画布窗口无响应时命令挂起，通道不设超时（内部通信治理）。
 */

// ---------------------------------------------------------------------------
// C. 代理执行通道命令契约（spec §6.3，Main → 画布窗口方向）
// ---------------------------------------------------------------------------
// 请求-响应形态：每条命令携带唯一请求标识 request_id，画布窗口执行完毕原路返回结果或错误。
// 参数形状与 B 命令面共用共享参数 schema（不复制）；画布窗口无响应时命令挂起，通道不设超时。

export const CliProxyCommandSchema = z.discriminatedUnion('command', [
  z
    .object({
      command: z.literal('asset.import'),
      request_id: z.string().min(1),
      // 参数与 B 命令面共享同一 schema（CliAssetImportParamsSchema，不复制字段）；
      // 执行经画布窗口内既有导入链路（与界面导入同一机制，进撤销栈）。
      ...CliAssetImportParamsSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.group.create'),
      request_id: z.string().min(1),
      ...CliCanvasGroupCreateParamsSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.group.rename'),
      request_id: z.string().min(1),
      ...CliCanvasGroupRenameParamsSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.group.dissolve'),
      request_id: z.string().min(1),
      ...CliCanvasGroupDissolveParamsSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.group.add'),
      request_id: z.string().min(1),
      ...CliCanvasGroupMembersParamsSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.group.remove'),
      request_id: z.string().min(1),
      ...CliCanvasGroupMembersParamsSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.node.move'),
      request_id: z.string().min(1),
      ...CliCanvasNodeMoveParamsSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.nodes.move'),
      request_id: z.string().min(1),
      ...CliCanvasNodesMoveParamsSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.group.move'),
      request_id: z.string().min(1),
      ...CliCanvasGroupMoveParamsSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.node.delete'),
      request_id: z.string().min(1),
      ...CliCanvasNodeDeleteParamsSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.node.create'),
      request_id: z.string().min(1),
      // 公共参数与 B 命令面共享同一 schema（不复制字段）。
      ...CliCanvasNodeCreateParamsSchema.shape,
      /**
       * 生成来源摘要（spec CLI-056）：主进程按 `readAssetGenerationIndex` 反查后补充，
       * 画布窗口据此写入资产节点的 sourceBatchId/sourceTaskId/sourceModelId。
       * 导入素材等无产出来源的资产缺省这三个字段（画布侧落空串）。
       * 公共命令面不暴露这些字段——它们是主进程已经查到的既有事实，不是调用方输入。
       */
      source_batch_id: z.string().min(1).optional(),
      source_task_id: z.string().min(1).optional(),
      source_model_id: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.layout'),
      request_id: z.string().min(1),
      ...CliCanvasLayoutParamsSchema.shape,
      /**
       * 计划文件内容（批次 1b）：主进程读取 plan_path 指向的文件并按
       * `CliCanvasLayoutPlanSchema` 校验后随代理命令下发；画布窗口一次批量写入。
       * 与 scope 族参数互斥由解析器/执行侧裁定，schema 只承载形状。
       */
      plan: CliCanvasLayoutPlanSchema.optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.undo'),
      request_id: z.string().min(1),
      ...CliCanvasUndoParamsSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('task.cancel'),
      request_id: z.string().min(1),
      ...CliTaskCancelParamsSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('generate'),
      request_id: z.string().min(1),
      // generate 参数与 B 命令面共享同一 schema（CliGenerateParamsSchema，不复制字段）；
      // `wait` 由主进程侧消费（受理后轮询），画布窗口执行侧忽略。
      ...CliGenerateParamsSchema.shape,
    })
    .strict(),
  // 画布状态只读查询（spec §6.3：不映射 action、不进撤销栈、不产生任何写入）——
  // 当前仅 app status 的选中态读取（spec §5.5）。
  z
    .object({
      command: z.literal('canvas.selection.get'),
      request_id: z.string().min(1),
    })
    .strict(),
  // 整张画布几何只读查询：画布窗口直读 store 现值，不映射 action、不进撤销栈、零写入。
  z.object({ command: z.literal('canvas.geometry.get'), request_id: z.string().min(1) }).strict(),
]);
export type CliProxyCommand = z.infer<typeof CliProxyCommandSchema>;

export const CliProxyCommandResultSchema = z.discriminatedUnion('command', [
  z
    .object({
      command: z.literal('asset.import'),
      request_id: z.string().min(1),
      // 结果与 B 命令面共享同一形状（CliAssetImportResultSchema，不复制字段）。
      ...CliAssetImportResultSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.group.create'),
      request_id: z.string().min(1),
      // 结果形状与 B 命令面共享（CliCanvasGroupCreateResultSchema，不复制字段）。
      ...CliCanvasGroupCreateResultSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.group.rename'),
      request_id: z.string().min(1),
      ...CliCanvasGroupRenameResultSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.group.dissolve'),
      request_id: z.string().min(1),
      dissolved: z.literal(true),
      /** 被解散的容器节点标识（组节点已删除；Agent 容器头节点保留回落单节点形态）。 */
      group_node_id: z.string().min(1),
      /** 解散前归属该容器的成员节点 id 列表（成员保留画布原位、归属解除）。 */
      member_ids: z.array(z.string().min(1)),
      /** 操作标识（批次二）：解散不支持按操作撤销。 */
      operation_id: z.string().min(1),
    })
    .strict(),
  // 成员加入/移出结果与 B 命令面共享同一形状（不复制字段）。
  z
    .object({
      command: z.literal('canvas.group.add'),
      request_id: z.string().min(1),
      ...CliCanvasGroupAddOutcomeSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.group.remove'),
      request_id: z.string().min(1),
      ...CliCanvasGroupRemoveOutcomeSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.node.move'),
      request_id: z.string().min(1),
      // 结果形状与 B 命令面共享（CliCanvasNodeMoveResultSchema，不复制字段）。
      ...CliCanvasNodeMoveResultSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.nodes.move'),
      request_id: z.string().min(1),
      ...CliCanvasNodesMoveResultSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.group.move'),
      request_id: z.string().min(1),
      ...CliCanvasGroupMoveResultSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.node.delete'),
      request_id: z.string().min(1),
      deleted: z.literal(true),
      /** 实际删除的节点集合（请求集 + 伴随节点级联；组节点删除即解散，成员不在其中）。 */
      deleted_node_ids: z.array(z.string().min(1)),
      /** 操作标识（批次二）：删除不支持按操作撤销。 */
      operation_id: z.string().min(1),
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.node.create'),
      request_id: z.string().min(1),
      // 结果与 B 命令面共享同一形状（不复制字段）。
      ...CliCanvasNodeCreateResultSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.layout'),
      request_id: z.string().min(1),
      ...CliCanvasLayoutResultSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.undo'),
      request_id: z.string().min(1),
      ...CliCanvasUndoResultSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('task.cancel'),
      request_id: z.string().min(1),
      // 取消受理形状复用任务取消契约（accepted/task_id/cancelled_at）。
      ...TaskCancelAcceptedResponseSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('generate'),
      request_id: z.string().min(1),
      // 受理结果与 B 命令面共享同一形状（CliGenerateAcceptanceSchema，不复制字段）：
      // 批次标识 + 任务身份列表；受理后逐任务终态轮询归 CLI 客户端侧，不经画布窗口回传。
      ...CliGenerateAcceptanceSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.selection.get'),
      request_id: z.string().min(1),
      // 选中状态与 B 命令面共享同一形状（CliCanvasSelectionSchema，不复制字段）；
      // 画布尚未就绪（nodeGraph 未载入）为 null（spec CLI-021，只读查询不失败）。
      selection: CliCanvasSelectionSchema.nullable(),
    })
    .strict(),
  // 整张画布几何只读查询结果（形状与 canvas.inspect 的 exact 合并输入同源）。
  CliCanvasGeometryGetResultSchema,
]);
export type CliProxyCommandResult = z.infer<typeof CliProxyCommandResultSchema>;

export const CliProxyCommandErrorSchema = z.discriminatedUnion('command', [
  z
    .object({
      command: z.literal('asset.import'),
      request_id: z.string().min(1),
      /** 前置校验不通过（文件不存在/不可读/类型不支持）或画布侧拦截时携带定位信息。 */
      error: CliErrorSchema,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.group.create'),
      request_id: z.string().min(1),
      /** 代理执行被画布侧前置钩子或校验拦截时为 command_rejected（携带定位信息）。 */
      error: CliErrorSchema,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.group.rename'),
      request_id: z.string().min(1),
      /** 目标不存在 / 非节点组（含 Agent 容器）等前置校验拒绝时携带定位信息。 */
      error: CliErrorSchema,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.group.dissolve'),
      request_id: z.string().min(1),
      error: CliErrorSchema,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.group.add'),
      request_id: z.string().min(1),
      /** 成员资格校验不通过（组不可入组 / 目标非节点组 / 成员不存在等）时携带定位信息。 */
      error: CliErrorSchema,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.group.remove'),
      request_id: z.string().min(1),
      error: CliErrorSchema,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.node.move'),
      request_id: z.string().min(1),
      error: CliErrorSchema,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.nodes.move'),
      request_id: z.string().min(1),
      error: CliErrorSchema,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.group.move'),
      request_id: z.string().min(1),
      error: CliErrorSchema,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.node.delete'),
      request_id: z.string().min(1),
      error: CliErrorSchema,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.node.create'),
      request_id: z.string().min(1),
      /** 目标组不可用 / 单轴坐标 / 资产不可用等前置校验拒绝时携带定位信息。 */
      error: CliErrorSchema,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.layout'),
      request_id: z.string().min(1),
      error: CliErrorSchema,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.undo'),
      request_id: z.string().min(1),
      error: CliErrorSchema,
    })
    .strict(),
  z
    .object({
      command: z.literal('task.cancel'),
      request_id: z.string().min(1),
      error: CliErrorSchema,
    })
    .strict(),
  z
    .object({
      command: z.literal('generate'),
      request_id: z.string().min(1),
      /** 程序化提交前置校验不通过 / 画布侧拦截时携带定位信息（spec §6.4）。 */
      error: CliErrorSchema,
    })
    .strict(),
  // 只读查询的防御性错误变体：接收端意外失败时原路回错误（正常路径不产出，选中态缺失走 selection null）。
  z
    .object({
      command: z.literal('canvas.selection.get'),
      request_id: z.string().min(1),
      error: CliErrorSchema,
    })
    .strict(),
  // 只读查询的防御性错误变体：接收端意外失败时原路回错误（正常路径不产出）。
  z.object({ command: z.literal('canvas.geometry.get'), request_id: z.string().min(1), error: CliErrorSchema }).strict(),
]);
export type CliProxyCommandError = z.infer<typeof CliProxyCommandErrorSchema>;

/** 画布窗口原路返回的全量：结果判别联合 + 错误判别联合（判别字段均为 command）。 */
export const CliProxyCommandResponseSchema = z.union([
  CliProxyCommandResultSchema,
  CliProxyCommandErrorSchema,
]);
export type CliProxyCommandResponse = z.infer<typeof CliProxyCommandResponseSchema>;
