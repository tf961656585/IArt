import * as z from 'zod';

import { CliCanvasPositionSchema } from './cli-canvas-contract';

/**
 * `canvas layout --plan` 计划文件形状（批次 1b 共享层）。
 *
 * 计划文件是用户侧输入（CLI 读取后交主进程，再经代理通道下发画布窗口），
 * 必须按严格 schema 承载：未知键一律拒绝，避免拼写错误被静默忽略。
 *
 * 三段均可选，三段都空即 no-op。执行顺序（groups 数组序 → containers → positions）
 * 与冲突裁定（目标必须是顶层容器、显式坐标不得命中已被覆盖的节点等）由执行侧负责，
 * 本 schema 只承载形状，不把业务语义降级成边界解析失败。
 */

/**
 * 计划内的排序模式：仅 position（视觉阅读序，缺省）与 insertion（现状插入序）。
 * created（创建时间序）不支持计划文件——它是现成节点上的运行期查询语义，执行侧拒绝。
 */
export const CliCanvasPlanOrderModeSchema = z.enum(['position', 'insertion']);
export type CliCanvasPlanOrderMode = z.infer<typeof CliCanvasPlanOrderModeSchema>;

/** 计划中的单组网格排布条目：组标识必填，其余约束与 `canvas layout` 同级参数一致。 */
export const CliCanvasLayoutPlanGroupSchema = z
  .object({
    group_id: z.string().min(1),
    /** 网格列数（正整数）；缺省由执行侧按 1 兜底。 */
    columns: z.number().int().min(1).optional(),
    /** 格子内间距（非负整数，0 合法）；缺省由执行侧按 120 兜底。 */
    gap: z.number().int().nonnegative().optional(),
    /** 显式摆放顺序（非空节点标识数组）；优先于排序模式。 */
    order: z.array(z.string().min(1)).min(1).optional(),
    /** 排序模式；缺省 position（视觉阅读序）。 */
    order_mode: CliCanvasPlanOrderModeSchema.optional(),
  })
  .strict();
export type CliCanvasLayoutPlanGroup = z.infer<typeof CliCanvasLayoutPlanGroupSchema>;

/** 计划中的整版容器排布：作用于全部顶层容器，字段语义与组条目一致（无 group_id）。 */
export const CliCanvasLayoutPlanContainersSchema = z
  .object({
    columns: z.number().int().min(1).optional(),
    gap: z.number().int().nonnegative().optional(),
    order: z.array(z.string().min(1)).min(1).optional(),
    order_mode: CliCanvasPlanOrderModeSchema.optional(),
  })
  .strict();
export type CliCanvasLayoutPlanContainers = z.infer<typeof CliCanvasLayoutPlanContainersSchema>;

/**
 * 计划文件根形状：groups / containers / positions 三段均可选。
 *
 * `positions` 是 `node_id -> {x,y}` 的显式坐标映射；只允许非容器节点，
 * 是否命中容器、是否与 groups/containers 覆盖范围冲突由执行侧裁定。
 */
export const CliCanvasLayoutPlanSchema = z
  .object({
    groups: z.array(CliCanvasLayoutPlanGroupSchema).optional(),
    containers: CliCanvasLayoutPlanContainersSchema.optional(),
    positions: z.record(z.string().min(1), CliCanvasPositionSchema).optional(),
  })
  .strict();
export type CliCanvasLayoutPlan = z.infer<typeof CliCanvasLayoutPlanSchema>;
