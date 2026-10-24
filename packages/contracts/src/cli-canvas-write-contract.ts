import * as z from 'zod';

import { CliCanvasPositionSchema } from './cli-canvas-contract';

/**
 * CLI 画布写原语（批次二）：容器寻址移动 / 批量移动 / dry-run / 执行报告 / 按操作撤销。
 *
 * 从 cli-contract.ts 拆出的职责边界（行数预算拆分，先例同 cli-canvas-contract /
 * cli-canvas-inspect-contract / cli-asset-import-contract）：本文件只承载本批写命令的
 * 参数形状、执行报告与结果形状，以及供 cli-contract 判别联合展开的变体数组。
 * 命令面请求-响应判别联合与代理执行通道的组装仍在 cli-contract.ts。
 *
 * 口径（spec docs/integrations/CLI与本地Agent集成.md §5.3 / §9）：
 * - 字段 snake_case，与既有 CLI 契约一致；
 * - 「两条通道共享同一 schema」：B 命令面请求与 C 代理执行通道命令都展开同一 params shape，
 *   响应/结果同样共享同一 result shape（禁止两处复制字段）；
 * - `dry_run` 缺省 false；dry-run 必须零写入、零撤销记录，`operation_id` 因此为 null
 *   （没有可撤销的操作，不得伪造一个撤销不了的操作标识）。
 */

// ---------------------------------------------------------------------------
// 执行报告（summary）：本批四个位置写命令统一形状
// ---------------------------------------------------------------------------

/**
 * 跳过项：被检查但本命令没有（也无法）处理的画布对象与稳定短句原因。
 * 稳定原因取值（新增须同步 spec 错误/跳过原因表）：
 * - `no_derived_box`：容器没有派生框（无法确定渲染框，无法移动/让位）；
 * - `position_search_failed`：防重叠搜索未能给出可行位（保持原位）；
 * - `not_a_container`：目标不是容器节点；
 * - `no_layout_output`：布局引擎未给该节点产出位置。
 */
export const CliCanvasOperationSkipSchema = z
  .object({
    node_id: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();
export type CliCanvasOperationSkip = z.infer<typeof CliCanvasOperationSkipSchema>;

/**
 * 执行报告（spec §5.3 / CLI-052）：
 * - inspected：本命令纳入考虑的候选节点/容器数（按命令作用域口径，见各命令注释）；
 * - moved：实际发生位移的节点总数（含级联伴随节点；dry-run 时为计划位移数）；
 * - cascaded：moved 中不属于 inspected 的伴随/级联节点数（如容器展开带出的成员）；
 * - unchanged：检查过但无需移动的候选数；
 * - skipped：被跳过的对象与原因（条件跳过必须 debug 留痕，本字段是机器可读对照面）。
 *
 * 存在意义：让 `--scope containers` 这类命令能区分「检查了 N 个容器、无相交」与
 * 「什么也没做」——只看 positions 为空无法区分两者。
 */
export const CliCanvasOperationSummarySchema = z
  .object({
    inspected: z.number().int().nonnegative(),
    moved: z.number().int().nonnegative(),
    /** moved 中不属于 inspected 的伴随/级联节点数；旧响应缺省按 0 兜底。 */
    cascaded: z.number().int().nonnegative().default(0),
    unchanged: z.number().int().nonnegative(),
    skipped: z.array(CliCanvasOperationSkipSchema),
  })
  .strict();
export type CliCanvasOperationSummary = z.infer<typeof CliCanvasOperationSummarySchema>;

/** 本批四个位置写命令共用的响应尾三字段（summary / operation_id / dry_run）。 */
export const CliCanvasWriteTrailerSchema = z
  .object({
    summary: CliCanvasOperationSummarySchema,
    /**
     * 按操作撤销的标识（画布窗口内存登记表）。成功写入时为 crypto.randomUUID()；
     * dry-run 为 null（零写入 ⇒ 无可撤销操作，不得返回撤销不了的标识）。
     */
    operation_id: z.string().min(1).nullable(),
    /** 本次是否为计划模式（true = 零写入、零撤销记录，positions 为计划值）。 */
    dry_run: z.boolean(),
  })
  .strict();

// ---------------------------------------------------------------------------
// 参数（B 命令面请求与 C 代理执行通道命令共享同一 shape）
// ---------------------------------------------------------------------------

/**
 * `canvas group move` 参数：容器寻址 + 相对位移（dx/dy）或绝对落点（x/y），两族互斥。
 *
 * - 相对族：容器渲染框（派生框左上角）加 (dx, dy)；两轴至少给一个，缺省轴按 0 位移。
 * - 绝对族：目标渲染框左上角 = (x ?? 当前框.x, y ?? 当前框.y)；两轴至少给一个。
 * - 两族同时出现 → command_rejected（解析器侧先按用法错误拒绝，执行侧再兜一次）。
 * - 空容器无成员：直接写容器自身 position（按同一 delta），不展开成员。
 *
 * schema 不承载互斥 refine：契约层面允许两族同时出现，由执行侧产出
 * `command_rejected`（spec §9 错误码），避免把业务拒绝降级成边界解析失败。
 */
export const CliCanvasGroupMoveParamsSchema = z
  .object({
    group: z.string().min(1),
    dx: z.number().optional(),
    dy: z.number().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    dry_run: z.boolean().optional(),
  })
  .strict();
export type CliCanvasGroupMoveParams = z.infer<typeof CliCanvasGroupMoveParamsSchema>;

/** 绝对坐标族条目：一个节点的目标画布坐标（`--positions <node_id>=<x>,<y>`）。 */
export const CliCanvasNodesMovePositionSchema = z
  .object({
    node_id: z.string().min(1),
    x: z.number(),
    y: z.number(),
  })
  .strict();
export type CliCanvasNodesMovePosition = z.infer<typeof CliCanvasNodesMovePositionSchema>;

/**
 * `canvas nodes move` 参数：相对位移族（nodes + dx + dy）或绝对坐标族（positions），两族互斥。
 *
 * - 相对族：nodes 至少一项且 dx/dy 必填，整体平移；允许包含容器 id（按引擎既有展开语义
 *   连成员一起移动，重复展开去重）。
 * - 绝对族：positions 至少一项，每个节点各自落到绝对坐标。
 * - 两族同时出现或都没给 → 解析器先按用法错误拒绝，执行侧再兜 `command_rejected`。
 *
 * schema 用单对象 + 可选字段（不用 discriminatedUnion：字段同处一个 params 形状，
 * 互斥是业务语义，不降级为边界解析失败；`.shape` 展开在请求/代理两侧保持同形）。
 */
export const CliCanvasNodesMoveParamsSchema = z
  .object({
    nodes: z.array(z.string().min(1)).min(1).optional(),
    dx: z.number().optional(),
    dy: z.number().optional(),
    /** 绝对坐标族（可重复 `--positions`；每个节点一条）。 */
    positions: z.array(CliCanvasNodesMovePositionSchema).min(1).optional(),
    dry_run: z.boolean().optional(),
  })
  .strict();
export type CliCanvasNodesMoveParams = z.infer<typeof CliCanvasNodesMoveParamsSchema>;

/**
 * `canvas undo` 参数：目标操作标识。
 * 只回退该次操作写入的位置，不影响其间的用户手工编辑；撤销本身作为一条新的历史记录
 * （可被 Cmd+Z 反悔）。本批只支持位置类操作（layout / node.move / group.move / nodes.move）。
 */
export const CliCanvasUndoParamsSchema = z
  .object({
    operation: z.string().min(1),
  })
  .strict();
export type CliCanvasUndoParams = z.infer<typeof CliCanvasUndoParamsSchema>;

// ---------------------------------------------------------------------------
// 结果（B 命令面响应与 C 代理执行通道结果共享同一 shape）
// ---------------------------------------------------------------------------

/** 整理顺序变化条目：节点从 from_slot 移到 to_slot（0 基槽位序号）。 */
export const CliCanvasLayoutOrderChangeSchema = z
  .object({
    node_id: z.string().min(1),
    from_slot: z.number().int().nonnegative(),
    to_slot: z.number().int().nonnegative(),
  })
  .strict();
export type CliCanvasLayoutOrderChange = z.infer<typeof CliCanvasLayoutOrderChangeSchema>;

/**
 * `canvas layout` 结果：受影响节点最终（或计划）位置 + 顺序变化报告 + 执行报告 + 撤销标识
 * + dry_run。
 *
 * `columns` / `gap` 是**实际使用的值**（spec CLI-055：人读与机器输出都回报实际列数与间距）：
 * - scope=all / group 缺省 columns=1、gap=120；
 * - scope=containers 带 `--pack` 时为实际列数/间距；
 * - scope=containers 不带 `--pack` 时为 null（该路径不做网格排布）。
 *
 * `content_reordered` / `order_changes` 描述本次整理是否改变了节点顺序（旧响应缺省为
 * false / 空数组）。
 */
export const CliCanvasLayoutResultSchema = z
  .object({
    /** 受影响节点位置映射（node_id → 位置）；dry-run 时为计划值。 */
    positions: z.record(CliCanvasPositionSchema),
    /** 实际使用的列数；scope=containers 非 pack 为 null。 */
    columns: z.number().int().min(1).nullable(),
    /** 实际使用的间距；scope=containers 非 pack 为 null。 */
    gap: z.number().int().nonnegative().nullable(),
    /**
     * 本次是否为计划文件模式（`canvas layout --plan`）。true 时 columns/gap 为 null，
     * 人读输出按「按计划整理」呈现；scope 模式（含 containers 非 pack）缺省/undefined。
     */
    plan_applied: z.boolean().optional(),
    /** 本次整理是否改变了节点顺序（视觉阅读序与现状不同）。 */
    content_reordered: z.boolean().default(false),
    /** 顺序变化明细（未变化的节点不列出）。 */
    order_changes: z.array(CliCanvasLayoutOrderChangeSchema).default([]),
    ...CliCanvasWriteTrailerSchema.shape,
  })
  .strict();
export type CliCanvasLayoutResult = z.infer<typeof CliCanvasLayoutResultSchema>;

/** `canvas node move` 结果：目标最终坐标 + 实际位移集合 + 执行报告 + 撤销标识 + dry_run。 */
export const CliCanvasNodeMoveResultSchema = z
  .object({
    node_id: z.string().min(1),
    position: CliCanvasPositionSchema,
    moved_node_ids: z.array(z.string().min(1)),
    ...CliCanvasWriteTrailerSchema.shape,
  })
  .strict();
export type CliCanvasNodeMoveResult = z.infer<typeof CliCanvasNodeMoveResultSchema>;

/** `canvas group move` 结果：容器 + 成员最终位置 + 实际位移集合 + 执行报告 + 撤销标识。 */
export const CliCanvasGroupMoveResultSchema = z
  .object({
    group_node_id: z.string().min(1),
    /** 成员 + 容器的最终（或计划）位置。 */
    positions: z.record(CliCanvasPositionSchema),
    moved_node_ids: z.array(z.string().min(1)),
    ...CliCanvasWriteTrailerSchema.shape,
  })
  .strict();
export type CliCanvasGroupMoveResult = z.infer<typeof CliCanvasGroupMoveResultSchema>;

/** `canvas nodes move` 结果：批量位移后的最终位置 + 执行报告 + 撤销标识。 */
export const CliCanvasNodesMoveResultSchema = z
  .object({
    positions: z.record(CliCanvasPositionSchema),
    moved_node_ids: z.array(z.string().min(1)),
    ...CliCanvasWriteTrailerSchema.shape,
  })
  .strict();
export type CliCanvasNodesMoveResult = z.infer<typeof CliCanvasNodesMoveResultSchema>;

/** `canvas undo` 结果：被回退的操作标识 + 回退后位置映射（无 dry_run/operation_id）。 */
export const CliCanvasUndoResultSchema = z
  .object({
    undone: z.literal(true),
    operation_id: z.string().min(1),
    positions: z.record(CliCanvasPositionSchema),
  })
  .strict();
export type CliCanvasUndoResult = z.infer<typeof CliCanvasUndoResultSchema>;
