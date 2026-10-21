import * as z from 'zod';
import { CliGenerateParamsSchema } from './cli-generate-contract';

import { CliErrorSchema } from './cli-error-code';
import { ExecutableModelDirectoryEntrySchema } from './executable-model-catalog-contract';
import { PromptDockBatchTaskAcceptanceSchema } from './promptdock-batch-contract';
import { RuntimeMediaAssetViewSchema, RuntimeTaskViewSchema, UnifiedGenerationStatusSchema } from './schemas/runtime-transaction.schema';
import { TaskCancelAcceptedResponseSchema } from './task-cancel-contract';
import { CliGenerationArchiveSchema } from './cli-generation-archive-contract';
import {
  CliCanvasPositionSchema,
  CliCanvasNodeEntrySchema,
  CliCanvasGroupSummarySchema,
  CliCanvasGroupAddOutcomeSchema,
  CliCanvasGroupRemoveOutcomeSchema,
  CliCanvasSelectionSchema,
  CliTaskCanvasIdentitySchema,
  CliCanvasGroupCreateParamsSchema, CliCanvasGroupDissolveParamsSchema, CliCanvasGroupMembersParamsSchema,
  CliCanvasNodeMoveParamsSchema, CliCanvasNodeDeleteParamsSchema, CliCanvasLayoutParamsSchema,
} from './cli-canvas-contract';
import { CliAssetImportParamsSchema, CliAssetImportResultSchema } from './cli-asset-import-contract';
import { CliGenerationWarningSchema } from './cli-generation-warning-contract';

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
 * - 生成档案引用媒体类型：复用 TaskSubmitMediaKindSchema（与提交媒体输入同一枚举，不复制）；
 *   生成档案本体（CliGenerationArchiveSchema）是既有契约没有的投影形状，本文件新建。
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
// 独立承载于 ./cli-error-code（被命令面/代理通道/设置页命令日志共同消费，居下游契约之下；
// 行数预算拆分先例同 cli-canvas-contract）；此处 re-export 保持 '@iart/contracts' 单一取用面。

export { CLI_ERROR_CODES, CliErrorCodeSchema, CliErrorSchema } from './cli-error-code';
export type { CliErrorCode, CliError } from './cli-error-code';

// ---------------------------------------------------------------------------
// B. 命令面（spec §5）：请求判别联合 + 响应判别联合
// ---------------------------------------------------------------------------

/**
 * 命令名清单：`iart <名词> <动作>` 的线上一面，顺序对齐 spec §5.1–§5.5（batch.get 归 §5.2 只读查询）。
 * 共 27 条：项目生命周期 6 + 只读查询 9 + 画布命令 8（asset.import 入口在资产域、执行归画布命令
 * 通道与撤销语义）+ 生成与任务 3 + 应用状态感知 1。
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
  'canvas.group.list',
  'asset.import',
  'canvas.group.create',
  'canvas.group.dissolve',
  'canvas.group.add',
  'canvas.group.remove',
  'canvas.node.move',
  'canvas.node.delete',
  'canvas.layout',
  'generate',
  'task.list',
  'task.get',
  'task.cancel',
  'task.wait',
  'batch.get',
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

// 画布命令参数形状（group create/dissolve/add/remove、node move/delete、layout）承载在
// cli-canvas-contract.ts（行数预算拆分）；此处 import 供请求/代理判别变体组合复用，
// 并 re-export 保持 '@iart/contracts' 单一取用面不变（见下方画布域 re-export 段）。

/** 任务取消参数：目标任务标识。 */
export const CliTaskCancelParamsSchema = z
  .object({
    task_id: z.string().min(1),
  })
  .strict();
export type CliTaskCancelParams = z.infer<typeof CliTaskCancelParamsSchema>;

// generate 参数形状拆到 ./cli-generate-contract（行数预算；B 命令面与 C 代理通道共享同一 schema）。
// 此处 re-export 保持 '@iart/contracts' 单一取用面，调用方无需改导入路径。
export {
  CliGenerateArgEntrySchema,
  CliGenerateParamsSchema,
  CliGenerateRefSchema,
} from './cli-generate-contract';
export type {
  CliGenerateArgEntry,
  CliGenerateParams,
  CliGenerateRef,
} from './cli-generate-contract';

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
  // 画布组/容器清单（spec §5.2 / CLI-045）：存储只读投影，项目未打开也可用。
  z.object({ command: z.literal('canvas.group.list'), project: ProjectParamSchema }).strict(),
  z
    .object({
      command: z.literal('asset.import'),
      project: ProjectParamSchema,
      ...CliAssetImportParamsSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.group.create'),
      project: ProjectParamSchema,
      ...CliCanvasGroupCreateParamsSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.group.dissolve'),
      project: ProjectParamSchema,
      ...CliCanvasGroupDissolveParamsSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.group.add'),
      project: ProjectParamSchema,
      ...CliCanvasGroupMembersParamsSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.group.remove'),
      project: ProjectParamSchema,
      ...CliCanvasGroupMembersParamsSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.node.move'),
      project: ProjectParamSchema,
      ...CliCanvasNodeMoveParamsSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.node.delete'),
      project: ProjectParamSchema,
      ...CliCanvasNodeDeleteParamsSchema.shape,
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
  z
    .object({
      command: z.literal('task.list'),
      project: ProjectParamSchema,
      /**
       * 任务状态过滤（`--status`，spec §5.4/CLI-034）：透传运行域列表端点的既有 status 参数；
       * 非法取值在契约 parse 即失败（CLI 本地报参数错误，不发起请求）。
       */
      status: UnifiedGenerationStatusSchema.nullable().default(null),
      /**
       * 时间下界过滤（`--since`，ISO 8601 字符串，spec CLI-034）：按任务 createdAt 过滤，
       * 客户端后滤（运行域列表端点无 since 参数，改动面最小裁定）；可解析性由执行侧校验。
       */
      since: z.string().min(1).nullable().default(null),
      /**
       * 受理幂等键反查（`--request-id`，spec CLI-033 考古语义）：按批次反查该次提交受理的
       * 全部任务（配合 generate 幂等键「重提前先核对」）；未命中返回空任务列表且命令成功
       * （「该 request_id 没有对应批次」本身就是对账答案）。与 `--status`/`--since` 可组合。
       */
      client_request_id: z.string().min(1).nullable().default(null),
    })
    .strict(),
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
  // 生成档案读取（spec §5.2 / CLI-038）：只读，项目未打开也可用。
  z.object({ command: z.literal('batch.get'), project: ProjectParamSchema, batch_id: z.string().min(1) }).strict(),
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

// 画布域 DTO（节点条目 / 组容器清单 / 任务画布投影身份 / 选中状态）承载在 cli-canvas-contract.ts
// （cli-contract.ts 行数预算拆分）；此处 import 供本文件判别变体组合复用，并 re-export 保持
// '@iart/contracts' 单一取用面不变。
export {
  CliCanvasPositionSchema,
  CliCanvasNodeEntrySchema,
  CliTaskCanvasIdentitySchema,
  CliCanvasGroupSummarySchema,
  CliCanvasGroupAddOutcomeSchema,
  CliCanvasGroupRemoveOutcomeSchema,
  CliCanvasSelectionSchema,
  CliCanvasGroupCreateParamsSchema, CliCanvasGroupDissolveParamsSchema, CliCanvasGroupMembersParamsSchema,
  CliCanvasNodeMoveParamsSchema, CliCanvasNodeDeleteParamsSchema, CliLayoutScopeSchema, CliCanvasLayoutParamsSchema,
} from './cli-canvas-contract';
export type {
  CliCanvasPosition,
  CliCanvasNodeEntry,
  CliTaskCanvasIdentity,
  CliCanvasGroupSummary,
  CliCanvasGroupAddOutcome,
  CliCanvasGroupRemoveOutcome,
  CliCanvasSelection,
  CliCanvasGroupCreateParams, CliCanvasGroupDissolveParams, CliCanvasGroupMembersParams,
  CliCanvasNodeMoveParams, CliCanvasNodeDeleteParams, CliLayoutScope, CliCanvasLayoutParams,
} from './cli-canvas-contract';

// 素材导入 DTO（asset import：参数 / 产物条目 / 结果）承载在 cli-asset-import-contract.ts
// （行数预算拆分，先例同上）；此处 import 供判别变体组合复用，并 re-export 保持单一取用面。
export {
  CliAssetImportParamsSchema,
  CliImportedAssetEntrySchema,
  CliAssetImportResultSchema,
} from './cli-asset-import-contract';
export type {
  CliAssetImportParams,
  CliImportedAssetEntry,
  CliAssetImportResult,
} from './cli-asset-import-contract';

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

// 生成终态信息性提示 DTO（CLI-050）承载在 cli-generation-warning-contract.ts（行数预算拆分，先例同 cli-canvas-contract）；re-export 保持单一取用面。
export { CliGenerationWarningSchema, type CliGenerationWarning } from './cli-generation-warning-contract';

/**
 * 单个任务终态结果（spec §5.4 generate --wait / task wait：终态 + 产物资产）。
 * 任务状态复用 RuntimeTaskViewSchema（失败任务经 failure/error 字段如实逐任务承载，不整体掩盖）；
 * 产物资产复用 CliAssetWithLocalPath（资产标识 + 本地媒体文件绝对路径）；
 * 画布投影身份（node_id/group_id，CLI-046）经画布存储投影按 task_id 关联，读不到为 null。
 * warnings（CLI-050）只做终态对照提示，缺省为空数组；不进入运行域共享 DTO。
 */
export const CliTaskTerminalResultSchema = z
  .object({
    task: RuntimeTaskViewSchema,
    /** 产物资产列表；失败/取消任务可为空数组。 */
    assets: z.array(CliAssetWithLocalPathSchema),
    /** 信息性提示（如请求尺寸未兑现）；无提示为空数组，任务状态与 ok 不变。 */
    warnings: z.array(CliGenerationWarningSchema),
    ...CliTaskCanvasIdentitySchema.shape,
  })
  .strict();
export type CliTaskTerminalResult = z.infer<typeof CliTaskTerminalResultSchema>;

/**
 * generate 受理的单个任务身份（spec §5.4 / CLI-046）：批次受理身份（复用
 * PromptDockBatchTaskAcceptanceSchema 的 task_id + task_index，不复制）扩展画布投影身份——
 * node_id 为画布任务节点标识（受理投影创建后回填；幂等重放按 task_id 关联既有投影，
 * 投影缺失为 null，缺省不伪造）；group_id 为出生组标识（未指定 --group 为 null）。
 */
export const CliGenerateTaskIdentitySchema = PromptDockBatchTaskAcceptanceSchema.extend({
  node_id: z.string().min(1).nullable(),
  group_id: z.string().min(1).nullable(),
});
export type CliGenerateTaskIdentity = z.infer<typeof CliGenerateTaskIdentitySchema>;

/**
 * generate 受理结果（spec §5.4 受理成功输出）：批次标识 + 任务身份列表。
 * B 命令面响应与 C 代理执行通道结果共享同一形状（不复制）——两者都是「程序化提交受理」的
 * 同一产物；`--wait` 的逐任务终态（task_results）只在 B 命令面响应承载，不进共享形状。
 *
 * `client_request_id` / `replayed`（spec §5.4 受理幂等键 / CLI-033）：幂等键回显与幂等重放
 * 标志。新受理 `replayed: false`；同 request_id 命中已受理批次时 `replayed: true` 且任务
 * 身份来自既有批次（未重新受理）。未携带幂等键的提交两者都缺省。
 */
export const CliGenerateAcceptanceSchema = z
  .object({
    /** 批次标识。 */
    batch_id: z.string().min(1),
    /** 受理的任务身份（CLI-046 扩展 PromptDockBatchTaskAcceptance：附画布投影身份）。 */
    tasks: z.array(CliGenerateTaskIdentitySchema).min(1),
    /** 幂等键回显：仅提交携带了 `--request-id`（或 CLI 自动生成）时输出。 */
    client_request_id: z.string().min(1).optional(),
    /** 幂等重放标志：true = 命中既有批次，任务身份为既有受理结果（未重复创建）。 */
    replayed: z.boolean().optional(),
  })
  .strict();
export type CliGenerateAcceptance = z.infer<typeof CliGenerateAcceptanceSchema>;

// 生成档案（spec §5.2 batch get / asset get 与 task get 内联，CLI-038/039/040）承载在
// cli-generation-archive-contract.ts（行数预算拆分）；re-export 保持单一取用面。
export {
  CliGenerationArchiveReferenceSchema,
  CliGenerationArchiveSchema,
} from './cli-generation-archive-contract';
export type { CliGenerationArchiveReference, CliGenerationArchive } from './cli-generation-archive-contract';

/** `iart --version` 输出（spec §5.5）：版本数据源是发现文件；null = 读不到（如实承载未知，不虚构占位值）。 */
export const CliVersionReportSchema = z.object({ version: z.string().min(1).nullable() }).strict();
export type CliVersionReport = z.infer<typeof CliVersionReportSchema>;

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
      // 生成档案内联（CLI-039）：生成产物附带；导入素材等非生成产物缺省（§5.2 档案口径）。
      generation: CliGenerationArchiveSchema.optional(),
    })
    .strict(),
  z.object({ command: z.literal('canvas.nodes.list'), ok: z.literal(true), nodes: z.array(CliCanvasNodeEntrySchema) }).strict(),
  // 组/容器清单（spec §5.2 / CLI-045）：存储只读投影。
  z.object({ command: z.literal('canvas.group.list'), ok: z.literal(true), groups: z.array(CliCanvasGroupSummarySchema) }).strict(),
  // 素材导入（CLI-047）：结果与代理执行通道共享同一形状（CliAssetImportResultSchema，不复制字段）。
  z
    .object({
      command: z.literal('asset.import'),
      ok: z.literal(true),
      ...CliAssetImportResultSchema.shape,
    })
    .strict(),
  z.object({ command: z.literal('canvas.group.create'), ok: z.literal(true), group_node_id: z.string().min(1) }).strict(),
  /** 解散结果：目标容器标识 + 受影响成员列表（成员保留画布原位，归属解除）。 */
  z
    .object({
      command: z.literal('canvas.group.dissolve'),
      ok: z.literal(true),
      dissolved: z.literal(true),
      group_node_id: z.string().min(1),
      member_ids: z.array(z.string().min(1)),
    })
    .strict(),
  // 成员加入/移出结果与代理执行通道共享同一形状（CliCanvasGroupAddOutcomeSchema /
  // CliCanvasGroupRemoveOutcomeSchema，不复制字段）。
  z
    .object({
      command: z.literal('canvas.group.add'),
      ok: z.literal(true),
      ...CliCanvasGroupAddOutcomeSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.group.remove'),
      ok: z.literal(true),
      ...CliCanvasGroupRemoveOutcomeSchema.shape,
    })
    .strict(),
  /** 移动结果：目标节点最终坐标 + 实际发生位移的节点集合（目标 + 连带跟随的伴随节点）。 */
  z
    .object({
      command: z.literal('canvas.node.move'),
      ok: z.literal(true),
      node_id: z.string().min(1),
      position: CliCanvasPositionSchema,
      moved_node_ids: z.array(z.string().min(1)),
    })
    .strict(),
  /** 删除结果：实际删除的节点集合（请求集 + 伴随节点级联；组节点删除即解散，成员不在其中）。 */
  z
    .object({
      command: z.literal('canvas.node.delete'),
      ok: z.literal(true),
      deleted: z.literal(true),
      deleted_node_ids: z.array(z.string().min(1)),
    })
    .strict(),
  /** 受影响节点的最终位置映射（node_id → 位置）。 */
  z.object({ command: z.literal('canvas.layout'), ok: z.literal(true), positions: z.record(CliCanvasPositionSchema) }).strict(),
  z
    .object({
      command: z.literal('generate'),
      ok: z.literal(true),
      // 受理结果与代理执行通道共享同一形状（CliGenerateAcceptanceSchema，不复制字段）。
      ...CliGenerateAcceptanceSchema.shape,
      /**
       * 逐任务终态与产物：`--wait` 时承载每个任务的终态、产物资产与 warnings（信息性提示，CLI-050；
       * 部分失败如实逐任务输出）；非 wait 提交恒为空数组。
       */
      task_results: z.array(CliTaskTerminalResultSchema),
    })
    .strict(),
  z.object({ command: z.literal('task.list'), ok: z.literal(true), tasks: z.array(RuntimeTaskViewSchema) }).strict(),
  // 任务画布投影身份（CLI-046）：node_id/group_id 按任务标识经画布存储投影关联，读不到为 null。
  z
    .object({
      command: z.literal('task.get'),
      ok: z.literal(true),
      task: RuntimeTaskViewSchema,
      generation: CliGenerationArchiveSchema.optional(),
      ...CliTaskCanvasIdentitySchema.shape,
    })
    .strict(),
  // 生成档案读取（CLI-038）：generation 与 asset.get / task.get 内联同一形状（单一构建出口）。
  z.object({ command: z.literal('batch.get'), ok: z.literal(true), generation: CliGenerationArchiveSchema }).strict(),
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
  z.object({ command: z.literal('canvas.group.list'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('asset.import'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('canvas.group.create'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('canvas.group.dissolve'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('canvas.group.add'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('canvas.group.remove'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('canvas.node.move'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('canvas.node.delete'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('canvas.layout'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('generate'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('task.list'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('task.get'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('task.cancel'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('task.wait'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('batch.get'), ok: z.literal(false), error: CliErrorSchema }).strict(),
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
      command: z.literal('canvas.node.delete'),
      request_id: z.string().min(1),
      ...CliCanvasNodeDeleteParamsSchema.shape,
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
      group_node_id: z.string().min(1),
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
      node_id: z.string().min(1),
      /** 目标节点最终坐标（从 store 现值读取，非入参回显）。 */
      position: CliCanvasPositionSchema,
      /** 实际发生位移的节点集合（目标 + 连带跟随的伴随节点；位置未变的节点不列入）。 */
      moved_node_ids: z.array(z.string().min(1)),
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.node.delete'),
      request_id: z.string().min(1),
      deleted: z.literal(true),
      /** 实际删除的节点集合（请求集 + 伴随节点级联；组节点删除即解散，成员不在其中）。 */
      deleted_node_ids: z.array(z.string().min(1)),
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
      command: z.literal('canvas.node.delete'),
      request_id: z.string().min(1),
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
// 独立承载于 ./cli-settings-contract（Hub 消费、camelCase 边界；行数预算拆分先例同
// cli-canvas-contract）；此处 re-export 保持 '@iart/contracts' 单一取用面。
// 由 Hub 消费，字段用 camelCase。

export {
  CliCommandLogEntrySchema,
  CliEntryStatusDetailSchema,
  CliStatusDtoSchema,
  CliEntryOperationResultSchema,
} from './cli-settings-contract';
export type {
  CliCommandLogEntry,
  CliEntryStatusDetail,
  CliStatusDto,
  CliEntryOperationResult,
} from './cli-settings-contract';
