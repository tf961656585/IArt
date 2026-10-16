import * as z from 'zod';

/**
 * CLI 画布域 DTO（spec docs/integrations/CLI与本地Agent集成.md §5.2/§5.4/§5.5 的画布承载形状）。
 *
 * 从 cli-contract.ts 拆出的职责边界：画布投影类条目（节点条目 / 组容器清单 / 任务画布投影
 * 身份 / 选中状态）与其几何形状。命令面请求-响应判别联合与代理执行通道仍归 cli-contract.ts；
 * 本文件只承载这些判别变体复用的域对象 schema。字段口径（snake_case）与 cli-contract 一致。
 *
 * 新建判定：画布节点投影属 Editor 内部类型，contracts 无既有跨边界承载可复用。
 */

/** 画布坐标（任意有限数值，可负、可小数）。 */
export const CliCanvasPositionSchema = z
  .object({
    x: z.number(),
    y: z.number(),
  })
  .strict();
export type CliCanvasPosition = z.infer<typeof CliCanvasPositionSchema>;

/**
 * 画布节点条目（spec §5.2 canvas nodes list：节点标识、类型、位置、组归属、资产/任务引用）。
 */
export const CliCanvasNodeEntrySchema = z
  .object({
    node_id: z.string().min(1),
    /** 节点类型（资产/任务/注释/组等画布节点种类），由画布投影侧填定。 */
    node_type: z.string().min(1),
    position: CliCanvasPositionSchema,
    /** 组归属；未归属任何组为 null。 */
    group_id: z.string().min(1).nullable(),
    /** 引用的资产标识；无资产引用为 null。 */
    asset_id: z.string().min(1).nullable(),
    /** 引用的任务标识；无任务引用为 null。 */
    task_id: z.string().min(1).nullable(),
  })
  .strict();
export type CliCanvasNodeEntry = z.infer<typeof CliCanvasNodeEntrySchema>;

/**
 * 画布任务投影身份（spec §5.4 / CLI-046）：按 task_id 经画布存储投影关联的任务节点标识与
 * 当前组归属。无任务节点投影（投影未创建/已 morph/项目库无该节点）或项目已关闭时为 null——
 * 缺省不伪造（读不到如实输出 null，不以占位值冒充）。
 */
export const CliTaskCanvasIdentitySchema = z
  .object({
    /** 画布任务节点标识；无投影为 null。 */
    node_id: z.string().min(1).nullable(),
    /** 任务节点当前组归属（出生组或后续归属变更后的组）；未归属任何组为 null。 */
    group_id: z.string().min(1).nullable(),
  })
  .strict();
export type CliTaskCanvasIdentity = z.infer<typeof CliTaskCanvasIdentitySchema>;

/**
 * 画布组/容器清单条目（spec §5.2 canvas group list / CLI-045）：容器标识、名称、类型与
 * 成员计数。type 取值 group（节点组）| agent_container（Agent 容器）；member_count 按
 * 画布存储投影 groupId 归属统计（空组为 0）。
 */
export const CliCanvasGroupSummarySchema = z
  .object({
    group_node_id: z.string().min(1),
    /** 显示名：组为组名（未命名为空串）；Agent 容器为其标题。 */
    name: z.string(),
    type: z.enum(['group', 'agent_container']),
    member_count: z.number().int().nonnegative(),
  })
  .strict();
export type CliCanvasGroupSummary = z.infer<typeof CliCanvasGroupSummarySchema>;

/**
 * 画布选中状态（spec §5.5/CLI-021：节点标识列表与注释标识列表，分类型输出）。
 * B 命令面 app.status 响应与 C 代理执行通道 canvas.selection.get 结果共享同一形状（不复制）；
 * 「画布尚未就绪」的选中态缺失由外层字段 nullable 承载（整体为 null），本形状只承载已就绪的选中集合。
 */
export const CliCanvasSelectionSchema = z
  .object({
    node_ids: z.array(z.string().min(1)),
    annotation_ids: z.array(z.string().min(1)),
  })
  .strict();
export type CliCanvasSelection = z.infer<typeof CliCanvasSelectionSchema>;
