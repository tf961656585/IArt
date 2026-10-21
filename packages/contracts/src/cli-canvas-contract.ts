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
 * 当前组归属。无任务节点投影（投影未创建/已 morph/项目库无该节点或读不到）时为 null——
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
 * 组成员加入结果（spec §5.3 / CLI-049）：B 命令面 canvas.group.add 响应与 C 代理执行通道
 * 结果共享同一形状（不复制）。三组标识互斥且按本次加入前归属分类：
 * - added_node_ids：未归属任何组、本次直接加入目标组；
 * - moved_node_ids：原属其他组、本次跨组迁入目标组；
 * - unchanged_node_ids：本就属于目标组（无操作）。
 */
export const CliCanvasGroupAddOutcomeSchema = z
  .object({
    group_node_id: z.string().min(1),
    added_node_ids: z.array(z.string().min(1)),
    moved_node_ids: z.array(z.string().min(1)),
    unchanged_node_ids: z.array(z.string().min(1)),
  })
  .strict();
export type CliCanvasGroupAddOutcome = z.infer<typeof CliCanvasGroupAddOutcomeSchema>;

/**
 * 组成员移出结果（spec §5.3 / CLI-049）：B 命令面 canvas.group.remove 响应与 C 代理执行通道
 * 结果共享同一形状（不复制）。成员保留画布原位，归属解除。
 */
export const CliCanvasGroupRemoveOutcomeSchema = z
  .object({
    group_node_id: z.string().min(1),
    removed_node_ids: z.array(z.string().min(1)),
  })
  .strict();
export type CliCanvasGroupRemoveOutcome = z.infer<typeof CliCanvasGroupRemoveOutcomeSchema>;

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

// ---------------------------------------------------------------------------
// 画布命令参数形状（spec §5.3）：B 命令面请求与 C 代理执行通道命令共享同一 schema。
// 从 cli-contract.ts 拆出（行数预算拆分先例同本文件）；cli-contract 组合 .shape 并 re-export。
// ---------------------------------------------------------------------------

/**
 * `canvas group create` 参数：组名 + 成员节点标识（spec §5.3）。
 * members 允许空数组（CLI-044 空组建组，仅 CLI 侧放开：界面多选入口保持 ≥2 语义）——
 * 空组建组由执行侧经防重叠搜索在视口安全区定位初始位置。
 */
export const CliCanvasGroupCreateParamsSchema = z
  .object({
    name: z.string().min(1),
    members: z.array(z.string().min(1)),
  })
  .strict();
export type CliCanvasGroupCreateParams = z.infer<typeof CliCanvasGroupCreateParamsSchema>;

/**
 * `canvas group dissolve` 参数：目标容器节点标识（组或 Agent 容器，spec §5.3 / CLI-027）。
 * 解散语义按容器类型分述（docs/runtime/画布节点组.md「解散」）：组删除组节点、成员保留原位；
 * Agent 容器解除成员关系、头节点保留并回落单节点形态、会话保留。
 */
export const CliCanvasGroupDissolveParamsSchema = z
  .object({
    group: z.string().min(1),
  })
  .strict();
export type CliCanvasGroupDissolveParams = z.infer<typeof CliCanvasGroupDissolveParamsSchema>;

/**
 * `canvas group add` / `canvas group remove` 参数（spec §5.3 / CLI-049）：目标节点组标识 +
 * 成员节点标识列表（至少一项）。两个命令参数同形，共享本 schema（不复制字段）。
 * 目标必须是节点组（Agent 容器的成员由会话管理，不接受 add/remove）；成员资格、单次归属
 * 与整批原子性由画布窗口侧前置校验。
 */
export const CliCanvasGroupMembersParamsSchema = z
  .object({
    group: z.string().min(1),
    members: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type CliCanvasGroupMembersParams = z.infer<typeof CliCanvasGroupMembersParamsSchema>;

/**
 * `canvas node move` 参数：目标节点标识 + 目标画布坐标（spec §5.3 / CLI-028）。
 * 坐标为任意有限数值（可负、可小数）；容器节点（组 | Agent 容器）位置是成员包围盒的
 * 派生量、不独立可写，执行侧拒绝容器目标（移动一律成员级）。
 */
export const CliCanvasNodeMoveParamsSchema = z
  .object({
    node: z.string().min(1),
    x: z.number(),
    y: z.number(),
  })
  .strict();
export type CliCanvasNodeMoveParams = z.infer<typeof CliCanvasNodeMoveParamsSchema>;

/**
 * `canvas node delete` 参数：待删节点标识列表（至少一个）+ 可选显式确认（spec §5.3 / CLI-029）。
 * 删除语义与界面删除同一删除咽喉（removeNodes，不连删：删除组节点即解散，成员保留）；
 * 请求集直接命中 Agent 节点时 `yes` 必须为 true（界面删除确认框的 CLI 对应物，AG-CT-011）。
 */
export const CliCanvasNodeDeleteParamsSchema = z
  .object({
    nodes: z.array(z.string().min(1)).min(1),
    yes: z.boolean().optional(),
  })
  .strict();
export type CliCanvasNodeDeleteParams = z.infer<typeof CliCanvasNodeDeleteParamsSchema>;

/** `canvas layout` 的 `--scope all|containers|group:<id>`：字符串 all/containers 或 `{ group }` 对象形态。 */
export const CliLayoutScopeSchema = z.union([
  z.literal('all'),
  z.literal('containers'),
  z
    .object({
      group: z.string().min(1),
    })
    .strict(),
]);
export type CliLayoutScope = z.infer<typeof CliLayoutScopeSchema>;

/** `canvas layout` 参数：scope + 可选列数（正整数，映射既有自动布局列数语义）+ 可选显式顺序。 */
export const CliCanvasLayoutParamsSchema = z
  .object({
    scope: CliLayoutScopeSchema,
    columns: z.number().int().min(1).optional(),
    /**
     * `--order` 显式摆放顺序（可选，spec CLI-030）：数组序即最高优先摆放序，未指定的参与节点
     * 按现状数组序跟排在指定节点之后；缺省时整理的默认排序行为完全不变（数组序）。
     * order 中的节点标识必须存在且属于本次整理作用域，执行侧前置校验。
     */
    order: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();
export type CliCanvasLayoutParams = z.infer<typeof CliCanvasLayoutParamsSchema>;
