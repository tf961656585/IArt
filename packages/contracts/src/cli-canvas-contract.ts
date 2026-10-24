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
    /** 显示名：组取组名（data.name），其余节点取 data.label；缺失为空串（CLI-057）。 */
    name: z.string(),
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
    /** 操作标识（批次二）：成员增删不支持按操作撤销（canvas.undo 返回 command_rejected）。 */
    operation_id: z.string().min(1),
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
    /** 操作标识（批次二）：成员增删不支持按操作撤销（canvas.undo 返回 command_rejected）。 */
    operation_id: z.string().min(1),
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
 * `canvas group create` 结果（B 命令面响应与 C 代理执行通道结果共享同一形状）。
 *
 * `member_ids` 是创建后**实际**在组内的成员标识（空组为空数组）；`operation_id` 属于
 * 「不支持按操作撤销」的创建类标识（`canvas.undo` 返回 `command_rejected`）。
 */
export const CliCanvasGroupCreateResultSchema = z
  .object({
    group_node_id: z.string().min(1),
    member_ids: z.array(z.string().min(1)),
    /** 操作标识（批次二）：建组不支持按操作撤销，canvas.undo 对该标识返回 command_rejected。 */
    operation_id: z.string().min(1),
  })
  .strict();
export type CliCanvasGroupCreateResult = z.infer<typeof CliCanvasGroupCreateResultSchema>;

/**
 * `canvas group rename` 参数（spec §5.3 / CLI-057）：目标节点组标识 + 新组名。
 * 组名去除首尾空白后必须非空（执行侧兜底 `command_rejected`）。
 */
export const CliCanvasGroupRenameParamsSchema = z
  .object({
    group: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();
export type CliCanvasGroupRenameParams = z.infer<typeof CliCanvasGroupRenameParamsSchema>;

/**
 * `canvas group rename` 结果（B 命令面响应与 C 代理执行通道结果共享同一形状）。
 *
 * 命名不是位置类操作，按既有按操作撤销范围**不登记**：`operation_id` 恒为 null
 * （与创建类返回「撤销不了的操作标识」不同，本命令没有可登记的操作）。
 */
export const CliCanvasGroupRenameResultSchema = z
  .object({
    group_node_id: z.string().min(1),
    name: z.string().min(1),
    operation_id: z.null(),
  })
  .strict();
export type CliCanvasGroupRenameResult = z.infer<typeof CliCanvasGroupRenameResultSchema>;

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
    /** 计划模式（批次二）：只返回计划坐标，零写入、零撤销记录；缺省 false。 */
    dry_run: z.boolean().optional(),
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

/**
 * `canvas node create` 参数（spec §5.3 / CLI-056）：把已存在的项目资产物化为一个资产节点。
 *
 * - `asset` 必填：项目媒体资产标识（不存在 → `asset_not_found`）。
 * - `group` 可选：目标节点组标识（必须存在且 `type=group`；Agent 容器不接受）。
 * - `x`/`y` 可选：绝对落点；两轴必须同时给出或同时不给（只给一个轴由执行侧
 *   `command_rejected` 拒绝，解析器侧先按用法错误拒绝一次）。
 * - `dry_run` 可选：只做校验与落位计算，零写入、零撤销记录。
 *
 * schema 不承载 x/y 成对 refine：与 group move 同口径，业务拒绝走执行侧
 * `command_rejected`，不把业务语义降级成边界解析失败。
 */
export const CliCanvasNodeCreateParamsSchema = z
  .object({
    asset: z.string().min(1),
    group: z.string().min(1).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    dry_run: z.boolean().optional(),
  })
  .strict();
export type CliCanvasNodeCreateParams = z.infer<typeof CliCanvasNodeCreateParamsSchema>;

/**
 * `canvas node create` 结果（命令面响应与代理执行通道结果共享同一形状）。
 *
 * `node_id` 在 dry-run 时为 null（零写入 ⇒ 没有节点标识，不得伪造）；
 * `operation_id` 同样在 dry-run 时为 null；真实创建时返回画布窗口生成的标识，
 * 该标识登记为「不支持按操作撤销」（`canvas.undo` 返回 `command_rejected`，与建组/导入同口径）。
 * `group_id` 为节点的组归属（未指定 `--group` 为 null）。
 */
export const CliCanvasNodeCreateResultSchema = z
  .object({
    node_id: z.string().min(1).nullable(),
    asset_id: z.string().min(1),
    position: CliCanvasPositionSchema,
    group_id: z.string().min(1).nullable(),
    operation_id: z.string().min(1).nullable(),
    dry_run: z.boolean(),
  })
  .strict();
export type CliCanvasNodeCreateResult = z.infer<typeof CliCanvasNodeCreateResultSchema>;

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

/**
 * 整理排序模式（`--order-mode`）：position = 视觉阅读序（缺省，从上到下、从左到右），
 * created = 创建时间序，insertion = 现状数组序（插入序）。
 */
export const CliCanvasLayoutOrderModeSchema = z.enum(['position', 'created', 'insertion']);
export type CliCanvasLayoutOrderMode = z.infer<typeof CliCanvasLayoutOrderModeSchema>;

/**
 * `canvas layout` 参数：scope + 可选列数 + 可选显式顺序/排序模式 + 容器看板排布（pack）
 * + 格子间距（gap），或一次计划（plan_path）。
 *
 * `scope` 与 `plan_path` 二选一（至少给一个，由解析器按用法错误裁定；schema 只承载形状）：
 * `plan_path` 存在时由主进程按该绝对路径读取计划文件，解析器负责 `path.resolve`。
 *
 * `pack` 仅对 `scope=containers` 合法：把顶层容器按渲染框排成行列看板（spec CLI-055）。
 * `columns` / `order` / `order_mode` / `gap` 在 `scope=containers` 且不带 `pack` 时不接受
 * （执行侧产出 `command_rejected`，不降级为边界解析失败）。
 * `gap` 对 `scope=all|group` 与 `--pack` 都生效（非负整数，缺省 120，与既有 NODE_GAP 同值），
 * 是格子内间距的精确值（不再逐点吸附网格；整块锚点吸附到最近网格点由执行侧完成）。
 * 显式 `order` 优先于 `order_mode`；两者都没给时按视觉阅读序（position）。
 */
export const CliCanvasLayoutParamsSchema = z
  .object({
    /** 整理范围；与 plan_path 二选一，两者都缺由解析器按用法错误拒绝（schema 只承载形状）。 */
    scope: CliLayoutScopeSchema.optional(),
    /**
     * 计划文件绝对路径（批次 1b）：由 CLI 解析器 `path.resolve` 后写入，主进程按该路径读取；
     * 与 scope/columns/order/order_mode/gap/pack 互斥（解析器按用法错误拒绝）。
     */
    plan_path: z.string().min(1).optional(),
    columns: z.number().int().min(1).optional(),
    /**
     * `--order` 显式摆放顺序（可选，spec CLI-030）：数组序即最高优先摆放序，未指定的参与节点
     * 按当前排序模式（或现状数组序）跟排在指定节点之后；缺省时按 `order_mode` 排序。
     * order 中的节点标识必须存在且属于本次整理作用域，执行侧前置校验。
     */
    order: z.array(z.string().min(1)).min(1).optional(),
    /** `--order-mode` 排序模式：缺省 position（视觉阅读序）；显式 order 优先于本字段。 */
    order_mode: CliCanvasLayoutOrderModeSchema.optional(),
    /**
     * 容器看板排布（spec CLI-055）：把顶层容器按渲染框排成行列看板。
     * 仅 `scope=containers` 合法；缺省 false（旧 containers 路径只消除相交，行为不变）。
     */
    pack: z.boolean().optional(),
    /**
     * 格子内间距（非负整数，0 合法）：scope=all/group 的格子间距缺省 120（与既有 NODE_GAP
     * 同值）；`--pack` 时是看板容器间距。
     */
    gap: z.number().int().nonnegative().optional(),
    /** 计划模式（批次二）：只返回计划位置，零写入、零撤销记录；缺省 false。 */
    dry_run: z.boolean().optional(),
  })
  .strict();
export type CliCanvasLayoutParams = z.infer<typeof CliCanvasLayoutParamsSchema>;
