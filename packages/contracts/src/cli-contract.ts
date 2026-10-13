import * as z from 'zod';

import { ExecutableModelDirectoryEntrySchema } from './executable-model-catalog-contract';
import { PromptDockBatchTaskAcceptanceSchema } from './promptdock-batch-contract';
import { RuntimeMediaAssetViewSchema, RuntimeTaskViewSchema } from './schemas/runtime-transaction.schema';
import { TaskCancelAcceptedResponseSchema } from './task-cancel-contract';

/**
 * CLI 与本地 Agent 集成契约（contracts 层）—— `iart` 命令面、代理执行通道与设置页状态 DTO 的
 * 可执行事实源。
 *
 * 归属与口径对齐：
 * - spec 主口径：`docs/integrations/CLI与本地Agent集成.md`（§5 命令面、§6.2 本地控制服务、
 *   §6.3 代理执行通道、§8 设置页「命令行工具」子单元、§9 错误码）。
 * - 双端 schema 校验（spec CLI-014）：主进程（本地控制服务）对入站请求、CLI 客户端对响应
 *   均经本文件 schema 解析校验；非法形状在边界即失败，不流入下游。
 *
 * 命名口径：
 * - 命令面（§5）与代理执行通道（§6.3）承载 CLI JSON / 请求-响应载荷，字段用 snake_case
 *   （与 promptdock-batch-contract 等跨边界 HTTP DTO 惯例一致）；
 * - 设置页状态 DTO（§8）由 Hub 进程消费，字段用 camelCase（与 IPC DTO 惯例一致）。
 *
 * 复用判定（复用优先，禁止复制既有字段定义；一句话级判定就地注释）：
 * - 模型条目：复用 ExecutableModelDirectoryEntrySchema（deployment.deployable/failure_code
 *   已满足 §5.2「deployable 为否必须携带失败原因码」与 model get 的参数 schema 要求）。
 * - 任务状态：复用 RuntimeTaskViewSchema（任务状态契约，task list/get/wait 终态事实源）。
 * - 媒体资产：复用 RuntimeMediaAssetViewSchema；「本地媒体文件绝对路径」是既有契约没有的
 *   字段，由 CliAssetWithLocalPath 组合承载，不复制资产字段。
 * - 生成受理任务身份：复用 PromptDockBatchTaskAcceptanceSchema（批次标识+任务标识列表；
 *   不拖入 intent_snapshot，CLI 面不消费草稿快照）。
 * - 任务取消受理：复用 TaskCancelAcceptedResponseSchema 的形状（展开其 shape 组合）。
 * - generate 参数与受理结果：本文件抽出 CliGenerateParamsSchema / CliGenerateAcceptanceSchema
 *   作为共享形状，B 命令面请求/响应与 C 代理执行通道命令/结果组合复用，禁止两处复制字段。
 * - 项目注册表条目 / 画布节点条目：contracts 现有导出无 Zod 承载可复用（project-dto 为
 *   非 Zod 历史接口、画布节点投影属 Editor 内部类型），本文件新建。
 *
 * 禁止项（spec §6.1/§11/§13）：命令日志与发现文件不得记录密钥、凭证或提示词全文；
 * 生成提交不得自动重试；画布命令与生成提交在项目未打开时必须以 project_not_open 失败。
 */

// ---------------------------------------------------------------------------
// A. 错误码（spec §9，跨 spec 与测试的稳定枚举）
// ---------------------------------------------------------------------------

/**
 * CLI 错误码：与 spec §9 表格一一对应，语义以 spec 为准，不得增删改名。
 * 错误响应统一为 `{ code, message }`；message 面向使用 CLI 的开发者，使用用户视角业务语言，
 * 不暴露内部实现术语。
 */
export const CLI_ERROR_CODES = [
  'not_running',
  'auth_failed',
  'project_not_found',
  'project_name_ambiguous',
  'project_name_conflict',
  'project_not_open',
  'asset_not_found',
  'node_not_found',
  'group_not_found',
  'invalid_reference',
  'model_not_available',
  'task_not_found',
  'wait_timeout',
  'command_rejected',
  'internal_error',
] as const;

export const CliErrorCodeSchema = z.enum(CLI_ERROR_CODES);
export type CliErrorCode = z.infer<typeof CliErrorCodeSchema>;

export const CliErrorSchema = z
  .object({
    code: CliErrorCodeSchema,
    message: z.string().min(1),
  })
  .strict();
export type CliError = z.infer<typeof CliErrorSchema>;

// ---------------------------------------------------------------------------
// B. 命令面（spec §5）：请求判别联合 + 响应判别联合
// ---------------------------------------------------------------------------

/**
 * 命令名清单：`iart <名词> <动作>` 的线上一面，顺序对齐 spec §5.1–§5.5。
 * 共 19 条：项目生命周期 6 + 只读查询 7 + 画布命令 2 + 生成与任务 3 + 应用状态感知 1。
 */
export const CLI_COMMANDS = [
  'project.list',
  'project.status',
  'project.create',
  'project.open',
  'project.close',
  'project.delete',
  'model.list',
  'model.get',
  'asset.list',
  'asset.get',
  'canvas.nodes.list',
  'canvas.group.create',
  'canvas.layout',
  'generate',
  'task.list',
  'task.get',
  'task.cancel',
  'task.wait',
  'app.status',
] as const;

export type CliCommandName = (typeof CLI_COMMANDS)[number];
export const CliCommandNameSchema = z.enum(CLI_COMMANDS);

// -- 共享参数形状（B 命令面与 C 代理执行通道共用，避免两处复制） ------------------

/** `--project <路径或名称>`：接受项目绝对路径或项目名（spec §3 项目解析）。 */
const ProjectParamSchema = z.string().min(1);

/** 项目名净化：不得包含路径分隔符等非法字符（spec §5.1 project create），非法在边界即失败。 */
const ProjectNameSchema = z
  .string()
  .min(1)
  .refine((name) => !/[\\/]/.test(name) && name !== '.' && name !== '..', {
    message: 'project name must not contain path separators',
  });

/** `canvas group create` 参数：组名 + 至少一个成员节点标识（spec §5.3）。 */
export const CliCanvasGroupCreateParamsSchema = z
  .object({
    name: z.string().min(1),
    members: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type CliCanvasGroupCreateParams = z.infer<typeof CliCanvasGroupCreateParamsSchema>;

/** `canvas layout` 的 `--scope all|group:<id>`：字符串 all 或 `{ group }` 对象形态。 */
export const CliLayoutScopeSchema = z.union([
  z.literal('all'),
  z
    .object({
      group: z.string().min(1),
    })
    .strict(),
]);
export type CliLayoutScope = z.infer<typeof CliLayoutScopeSchema>;

/** `canvas layout` 参数：scope + 可选列数（正整数，映射既有自动布局列数语义）。 */
export const CliCanvasLayoutParamsSchema = z
  .object({
    scope: CliLayoutScopeSchema,
    columns: z.number().int().min(1).optional(),
  })
  .strict();
export type CliCanvasLayoutParams = z.infer<typeof CliCanvasLayoutParamsSchema>;

/** 任务取消参数：目标任务标识。 */
export const CliTaskCancelParamsSchema = z
  .object({
    task_id: z.string().min(1),
  })
  .strict();
export type CliTaskCancelParams = z.infer<typeof CliTaskCancelParamsSchema>;

/** `generate --arg k=v` 的键值对条目：参数名与取值受该模型参数 schema 约束（执行侧前置校验）。 */
export const CliGenerateArgEntrySchema = z
  .object({
    key: z.string().min(1),
    value: z.string(),
  })
  .strict();
export type CliGenerateArgEntry = z.infer<typeof CliGenerateArgEntrySchema>;

/**
 * generate 参数（spec §5.4）：B 命令面请求与 C 代理执行通道命令共享同一参数 schema（不复制）。
 * `wait`（受理后轮询至终态）的轮询执行归 CLI 客户端侧（受理后逐任务轮询至终态）；代理执行通道只承载程序化提交，
 * 画布窗口执行侧对 `wait` 不消费（契约允许携带、执行侧忽略，同 canvas.layout 的 columns 先例）。
 */
export const CliGenerateParamsSchema = z
  .object({
    /** `--prompt` / `--model` 必填（spec §5.4）。 */
    prompt: z.string(),
    model: z.string().min(1),
    /** `--count` 正整数可选：固定任务数。 */
    count: z.number().int().min(1).optional(),
    /** `--ref` 引用资产标识列表可选：必须是已存在的资产。 */
    ref: z.array(z.string().min(1)).optional(),
    /** `--arg k=v` 键值对列表可选。 */
    arg: z.array(CliGenerateArgEntrySchema).optional(),
    /** `--wait` 可选：受理后继续轮询至全部任务终态。 */
    wait: z.boolean().optional(),
  })
  .strict();
export type CliGenerateParams = z.infer<typeof CliGenerateParamsSchema>;

// -- 请求判别联合（主进程入站校验入口） -----------------------------------------

export const CliCommandRequestSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('project.list') }).strict(),
  z.object({ command: z.literal('project.status'), project: ProjectParamSchema }).strict(),
  z
    .object({
      command: z.literal('project.create'),
      /** `--name` 必填且必须净化；`--path` 必填：CLI 不推断默认父目录（spec §5.1）。 */
      name: ProjectNameSchema,
      path: z.string().min(1),
    })
    .strict(),
  z.object({ command: z.literal('project.open'), project: ProjectParamSchema }).strict(),
  z.object({ command: z.literal('project.close'), project: ProjectParamSchema }).strict(),
  z
    .object({
      command: z.literal('project.delete'),
      project: ProjectParamSchema,
      /** `--yes` 是必须的显式确认：缺省/非 true 无法通过 schema（spec §5.1）。 */
      yes: z.literal(true),
    })
    .strict(),
  z.object({ command: z.literal('model.list') }).strict(),
  z.object({ command: z.literal('model.get'), model_id: z.string().min(1) }).strict(),
  z
    .object({
      command: z.literal('asset.list'),
      project: ProjectParamSchema,
      /** `--query` 关键词：命中原始文件名与生成产物提交提示词（大小写不敏感子串）；缺省 null=不过滤（spec CLI-018）。 */
      query: z.string().min(1).nullable().default(null),
      /** `--media-type` 媒体类型过滤；缺省 null=不过滤。 */
      media_type: z.enum(['image', 'video', 'audio']).nullable().default(null),
      /** `--model` 生成所用模型过滤（model_id 精确匹配）；缺省 null=不过滤。 */
      model: z.string().min(1).nullable().default(null),
      /** `--limit` 分页大小；缺省 null=不限。 */
      limit: z.number().int().positive().nullable().default(null),
      /** `--offset` 分页偏移；缺省 0。 */
      offset: z.number().int().nonnegative().default(0),
    })
    .strict(),
  z
    .object({ command: z.literal('asset.get'), project: ProjectParamSchema, asset_id: z.string().min(1) })
    .strict(),
  z.object({ command: z.literal('canvas.nodes.list'), project: ProjectParamSchema }).strict(),
  z
    .object({
      command: z.literal('canvas.group.create'),
      project: ProjectParamSchema,
      ...CliCanvasGroupCreateParamsSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.layout'),
      project: ProjectParamSchema,
      ...CliCanvasLayoutParamsSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('generate'),
      project: ProjectParamSchema,
      // generate 参数与代理执行通道共享同一 schema（CliGenerateParamsSchema，不复制字段）。
      ...CliGenerateParamsSchema.shape,
    })
    .strict(),
  z.object({ command: z.literal('task.list'), project: ProjectParamSchema }).strict(),
  z
    .object({ command: z.literal('task.get'), project: ProjectParamSchema, task_id: z.string().min(1) })
    .strict(),
  z
    .object({
      command: z.literal('task.cancel'),
      project: ProjectParamSchema,
      ...CliTaskCancelParamsSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('task.wait'),
      project: ProjectParamSchema,
      task_id: z.string().min(1),
      /** `--timeout` 秒数可选：默认不设时限（内部通信治理：不设超时误杀长任务）。 */
      timeout: z.number().int().min(1).optional(),
    })
    .strict(),
  // 应用状态感知（spec §5.5）：无参数、全局只读，不携带项目上下文。
  z.object({ command: z.literal('app.status') }).strict(),
]);
export type CliCommandRequest = z.infer<typeof CliCommandRequestSchema>;

// -- 响应域对象 ----------------------------------------------------------------

/** 项目引用（解析结果）：项目名 + 绝对路径。 */
export const CliProjectRefSchema = z
  .object({
    name: z.string().min(1),
    path: z.string().min(1),
  })
  .strict();
export type CliProjectRef = z.infer<typeof CliProjectRefSchema>;

/**
 * 项目注册表条目（spec §5.1 project list：名称、路径、最近打开时间）。
 * 新建判定：ProjectIndexItem（project-dto.ts）是非 Zod 历史接口，无法在 parse 边界组合复用。
 */
export const CliProjectSummarySchema = z
  .object({
    name: z.string().min(1),
    path: z.string().min(1),
    /** 最近打开时间（Unix 毫秒）；从未打开为 null。 */
    last_opened_at: z.number().nullable(),
  })
  .strict();
export type CliProjectSummary = z.infer<typeof CliProjectSummarySchema>;

/**
 * 资产清单条目（spec §5.2 asset list：资产标识、媒体类型、生成来源摘要）。
 * 新建判定：清单面只需要摘要，完整媒体资产视图（含缩略图与 original 载荷）由 asset get 复用承载。
 */
export const CliAssetSummarySchema = z
  .object({
    asset_id: z.string().min(1),
    media_type: z.string().min(1),
    /** 生成来源摘要（短文本，如任务标识与模型）；摘要性承载，不含提示词全文（spec §6.1 精神）。 */
    source_summary: z.string(),
    /** 导入素材的原始文件名；生成/加工产物与旧库数据无此字段时省略（spec CLI-018 检索底座投影）。 */
    source_file_name: z.string().min(1).nullable().optional(),
  })
  .strict();
export type CliAssetSummary = z.infer<typeof CliAssetSummarySchema>;

/**
 * 带本地绝对路径的资产：媒体资产复用 RuntimeMediaAssetViewSchema（跨边界媒体资产契约），
 * 绝对路径是 spec §5.2/§5.4 要求而既有契约没有的字段，组合承载不复制资产字段。
 */
export const CliAssetWithLocalPathSchema = z
  .object({
    asset: RuntimeMediaAssetViewSchema,
    local_file_path: z.string().min(1),
    /** 同内容其他资产 id（同 mediaType + 同内容指纹的存量双 id 残留等价类）；无等价项时省略，不以空数组占位（spec CLI-019）。 */
    equivalent_asset_ids: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type CliAssetWithLocalPath = z.infer<typeof CliAssetWithLocalPathSchema>;

/**
 * 画布节点条目（spec §5.2 canvas nodes list：节点标识、类型、位置、组归属、资产/任务引用）。
 * 新建判定：画布节点投影属 Editor 内部类型，contracts 无既有跨边界承载可复用。
 */
export const CliCanvasPositionSchema = z
  .object({
    x: z.number(),
    y: z.number(),
  })
  .strict();
export type CliCanvasPosition = z.infer<typeof CliCanvasPositionSchema>;

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

/**
 * app.status 的单个已打开项目条目（spec §5.5/CLI-020：名称、路径、查询时点焦点）。
 * 每项目至多一项（每项目至多一个画布窗口）；选中态为 null 表示画布尚未就绪（CLI-021，命令不失败）。
 */
export const CliAppStatusOpenedProjectSchema = z
  .object({
    name: z.string().min(1),
    path: z.string().min(1),
    /** 查询时点是否持有焦点（spec §5.5：按查询时点逐窗口判定，不维护焦点历史）。 */
    focused: z.boolean(),
    /** 画布选中状态；画布尚未就绪（窗口已创建、画布仍在加载）为 null（spec CLI-021）。 */
    selection: CliCanvasSelectionSchema.nullable(),
  })
  .strict();
export type CliAppStatusOpenedProject = z.infer<typeof CliAppStatusOpenedProjectSchema>;

/**
 * 单个任务终态结果（spec §5.4 generate --wait / task wait：终态 + 产物资产）。
 * 任务状态复用 RuntimeTaskViewSchema（失败任务经 failure/error 字段如实逐任务承载，不整体掩盖）；
 * 产物资产复用 CliAssetWithLocalPath（资产标识 + 本地媒体文件绝对路径）。
 */
export const CliTaskTerminalResultSchema = z
  .object({
    task: RuntimeTaskViewSchema,
    /** 产物资产列表；失败/取消任务可为空数组。 */
    assets: z.array(CliAssetWithLocalPathSchema),
  })
  .strict();
export type CliTaskTerminalResult = z.infer<typeof CliTaskTerminalResultSchema>;

/**
 * generate 受理结果（spec §5.4 受理成功输出）：批次标识 + 任务身份列表。
 * B 命令面响应与 C 代理执行通道结果共享同一形状（不复制）——两者都是「程序化提交受理」的
 * 同一产物；`--wait` 的逐任务终态（task_results）只在 B 命令面响应承载，不进共享形状。
 */
export const CliGenerateAcceptanceSchema = z
  .object({
    /** 批次标识。 */
    batch_id: z.string().min(1),
    /** 受理的任务身份（复用 PromptDockBatchTaskAcceptanceSchema；原子受理恒 ≥1）。 */
    tasks: z.array(PromptDockBatchTaskAcceptanceSchema).min(1),
  })
  .strict();
export type CliGenerateAcceptance = z.infer<typeof CliGenerateAcceptanceSchema>;

// -- 响应判别联合（CLI 客户端出站校验入口） -------------------------------------
// 统一信封：{ ok: true, ...result } | { ok: false, error: { code, message } }，
// 判别字段与请求一致为 command；错误码必须走 A 的枚举。

export const CliCommandSuccessResponseSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('project.list'), ok: z.literal(true), projects: z.array(CliProjectSummarySchema) }).strict(),
  z
    .object({
      command: z.literal('project.status'),
      ok: z.literal(true),
      /** 解析结果（名称+路径）。 */
      project: CliProjectRefSchema,
      /** 注册表在册状态。 */
      registered: z.boolean(),
      /** 画布窗口状态：已打开/未打开。 */
      window_open: z.boolean(),
      /** 运行域在途任务数。 */
      active_task_count: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ command: z.literal('project.create'), ok: z.literal(true), project: CliProjectRefSchema }).strict(),
  z.object({ command: z.literal('project.open'), ok: z.literal(true), project: CliProjectRefSchema }).strict(),
  z.object({ command: z.literal('project.close'), ok: z.literal(true), closed: z.literal(true) }).strict(),
  z.object({ command: z.literal('project.delete'), ok: z.literal(true), deleted: z.literal(true) }).strict(),
  // 模型条目复用 ExecutableModelDirectoryEntrySchema（可执行状态与失败原因码随 deployment 承载）。
  z.object({ command: z.literal('model.list'), ok: z.literal(true), models: z.array(ExecutableModelDirectoryEntrySchema) }).strict(),
  z.object({ command: z.literal('model.get'), ok: z.literal(true), model: ExecutableModelDirectoryEntrySchema }).strict(),
  z.object({ command: z.literal('asset.list'), ok: z.literal(true), assets: z.array(CliAssetSummarySchema) }).strict(),
  z
    .object({
      command: z.literal('asset.get'),
      ok: z.literal(true),
      ...CliAssetWithLocalPathSchema.shape,
    })
    .strict(),
  z.object({ command: z.literal('canvas.nodes.list'), ok: z.literal(true), nodes: z.array(CliCanvasNodeEntrySchema) }).strict(),
  z.object({ command: z.literal('canvas.group.create'), ok: z.literal(true), group_node_id: z.string().min(1) }).strict(),
  /** 受影响节点的最终位置映射（node_id → 位置）。 */
  z.object({ command: z.literal('canvas.layout'), ok: z.literal(true), positions: z.record(CliCanvasPositionSchema) }).strict(),
  z
    .object({
      command: z.literal('generate'),
      ok: z.literal(true),
      // 受理结果与代理执行通道共享同一形状（CliGenerateAcceptanceSchema，不复制字段）。
      ...CliGenerateAcceptanceSchema.shape,
      /**
       * 逐任务终态与产物：`--wait` 时承载每个任务的终态与产物资产（部分失败如实逐任务输出）；
       * 非 wait 提交恒为空数组。
       */
      task_results: z.array(CliTaskTerminalResultSchema),
    })
    .strict(),
  z.object({ command: z.literal('task.list'), ok: z.literal(true), tasks: z.array(RuntimeTaskViewSchema) }).strict(),
  z.object({ command: z.literal('task.get'), ok: z.literal(true), task: RuntimeTaskViewSchema }).strict(),
  // 任务取消受理复用 TaskCancelAcceptedResponseSchema 的形状（accepted/task_id/cancelled_at）。
  z
    .object({
      command: z.literal('task.cancel'),
      ok: z.literal(true),
      ...TaskCancelAcceptedResponseSchema.shape,
    })
    .strict(),
  z.object({ command: z.literal('task.wait'), ok: z.literal(true), task_result: CliTaskTerminalResultSchema }).strict(),
  // 应用状态感知（spec §5.5/CLI-020）：已打开项目集合；无项目打开为空数组且命令成功。
  z
    .object({
      command: z.literal('app.status'),
      ok: z.literal(true),
      opened_projects: z.array(CliAppStatusOpenedProjectSchema),
    })
    .strict(),
]);
export type CliCommandSuccessResponse = z.infer<typeof CliCommandSuccessResponseSchema>;

export const CliCommandErrorResponseSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('project.list'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('project.status'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('project.create'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('project.open'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('project.close'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('project.delete'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('model.list'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('model.get'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('asset.list'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('asset.get'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('canvas.nodes.list'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('canvas.group.create'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('canvas.layout'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('generate'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('task.list'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('task.get'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('task.cancel'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('task.wait'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('app.status'), ok: z.literal(false), error: CliErrorSchema }).strict(),
]);
export type CliCommandErrorResponse = z.infer<typeof CliCommandErrorResponseSchema>;

/** CLI 命令响应全量：成功判别联合 + 错误判别联合（判别字段均为 command）。 */
export const CliCommandResponseSchema = z.union([
  CliCommandSuccessResponseSchema,
  CliCommandErrorResponseSchema,
]);
export type CliCommandResponse = z.infer<typeof CliCommandResponseSchema>;

// ---------------------------------------------------------------------------
// C. 代理执行通道命令契约（spec §6.3，Main → 画布窗口方向）
// ---------------------------------------------------------------------------
// 请求-响应形态：每条命令携带唯一请求标识 request_id，画布窗口执行完毕原路返回结果或错误。
// 参数形状与 B 命令面共用共享参数 schema（不复制）；画布窗口无响应时命令挂起，通道不设超时。

export const CliProxyCommandSchema = z.discriminatedUnion('command', [
  z
    .object({
      command: z.literal('canvas.group.create'),
      request_id: z.string().min(1),
      ...CliCanvasGroupCreateParamsSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.layout'),
      request_id: z.string().min(1),
      ...CliCanvasLayoutParamsSchema.shape,
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
]);
export type CliProxyCommand = z.infer<typeof CliProxyCommandSchema>;

export const CliProxyCommandResultSchema = z.discriminatedUnion('command', [
  z
    .object({
      command: z.literal('canvas.group.create'),
      request_id: z.string().min(1),
      group_node_id: z.string().min(1),
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.layout'),
      request_id: z.string().min(1),
      /** 受影响节点的最终位置映射（node_id → 位置）。 */
      positions: z.record(CliCanvasPositionSchema),
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
]);
export type CliProxyCommandResult = z.infer<typeof CliProxyCommandResultSchema>;

export const CliProxyCommandErrorSchema = z.discriminatedUnion('command', [
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
      command: z.literal('canvas.layout'),
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
]);
export type CliProxyCommandError = z.infer<typeof CliProxyCommandErrorSchema>;

/** 画布窗口原路返回的全量：结果判别联合 + 错误判别联合（判别字段均为 command）。 */
export const CliProxyCommandResponseSchema = z.union([
  CliProxyCommandResultSchema,
  CliProxyCommandErrorSchema,
]);
export type CliProxyCommandResponse = z.infer<typeof CliProxyCommandResponseSchema>;

// ---------------------------------------------------------------------------
// D. 设置页「命令行工具」子单元 DTO（spec §6.2 命令日志 / §8 状态展示）
// ---------------------------------------------------------------------------
// 由 Hub 消费，字段用 camelCase。

/**
 * 命令日志条目（spec §6.2：每条命令记录一条——时间、命令、参数摘要、结果状态、耗时）。
 * timestamp 为 UTC ISO 8601（内部存储口径，AGENTS.md 时间戳规范）；展示层由消费端转北京时间。
 * paramsSummary 语义是摘要：仅供诊断与设置页展示，禁止包含提示词全文与凭证/密钥（spec §6.1/§11）。
 */
export const CliCommandLogEntrySchema = z
  .object({
    timestamp: z.string().datetime(),
    command: z.string().min(1),
    paramsSummary: z.string(),
    status: z.enum(['success', 'error']),
    durationMs: z.number().nonnegative(),
    errorCode: CliErrorCodeSchema.optional(),
  })
  .strict();
export type CliCommandLogEntry = z.infer<typeof CliCommandLogEntrySchema>;

/**
 * CLI 状态 DTO（spec §8：只读状态展示——在役状态、发现文件有效性、命令入口注册状态、最近命令记录）。
 * 只读展示，不承载 CLI 行为配置，不提供令牌查看或重置（spec §7/§13）。
 */
export const CliStatusDtoSchema = z
  .object({
    serviceRunning: z.boolean(),
    port: z.number().int().min(1).nullable(),
    discoveryFileValid: z.boolean(),
    /**
     * 命令入口注册状态（spec §3 命令入口注册 / §8 注册状态展示）。
     * - true：入口已注册且内容与本应用 shim 一致；
     * - false：入口不存在，或存在但内容已被改动（非本应用 shim）；
     * - null：当前平台不支持一键注册（入口注册能力缺席），注册状态未知。
     */
    entryRegistered: z.boolean().nullable(),
    /** 最近命令记录，最多 20 条（spec §8）。 */
    recentCommands: z.array(CliCommandLogEntrySchema).max(20),
  })
  .strict();
export type CliStatusDto = z.infer<typeof CliStatusDtoSchema>;

/**
 * 命令入口注册/卸除操作结果（spec §8 一键注册与卸除注册动作的 IPC 响应形状）。
 * ok:false 时 message 引导手动注册（spec §3：手动注册指引是另一途径）；
 * message 面向用户，使用用户视角业务语言（docs/ui-copy-standard.md 的 CLI 终端外延口径）。
 */
export const CliEntryOperationResultSchema = z
  .object({
    ok: z.boolean(),
    message: z.string().min(1).optional(),
  })
  .strict();
export type CliEntryOperationResult = z.infer<typeof CliEntryOperationResultSchema>;
