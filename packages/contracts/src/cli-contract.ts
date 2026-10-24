import * as z from 'zod';
import { CliGenerateParamsSchema } from './cli-generate-contract';

import { CliErrorSchema } from './cli-error-code';
import { ExecutableModelDirectoryEntrySchema } from './executable-model-catalog-contract';
import { RuntimeTaskViewSchema, UnifiedGenerationStatusSchema } from './schemas/runtime-transaction.schema';
import { TaskCancelAcceptedResponseSchema } from './task-cancel-contract';
import { CliGenerationArchiveSchema } from './cli-generation-archive-contract';
import {
  CliCanvasNodeEntrySchema,
  CliCanvasGroupSummarySchema,
  CliCanvasGroupAddOutcomeSchema,
  CliCanvasGroupRemoveOutcomeSchema,
  CliTaskCanvasIdentitySchema,
  CliCanvasGroupCreateParamsSchema, CliCanvasGroupCreateResultSchema,
  CliCanvasGroupDissolveParamsSchema, CliCanvasGroupMembersParamsSchema,
  CliCanvasGroupRenameParamsSchema, CliCanvasGroupRenameResultSchema,
  CliCanvasNodeMoveParamsSchema, CliCanvasNodeDeleteParamsSchema, CliCanvasLayoutParamsSchema,
  CliCanvasNodeCreateParamsSchema, CliCanvasNodeCreateResultSchema,
} from './cli-canvas-contract';
import { CliAssetImportParamsSchema, CliAssetImportResultSchema } from './cli-asset-import-contract';
import { CliCanvasInspectResultSchema } from './cli-canvas-inspect-contract';
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
import {
  CliProjectSummarySchema,
  CliAssetSummarySchema,
  CliAssetWithLocalPathSchema,
  CliAppStatusOpenedProjectSchema,
  CliTaskTerminalResultSchema,
  CliGenerateAcceptanceSchema,
  CliTaskCancelParamsSchema,
} from './cli-response-dto-contract';

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
 * 共 33 条：项目生命周期 6 + 只读查询 10（含 canvas.inspect 整张画布场景图）+ 画布命令 13
 * （asset.import 入口在资产域、执行归画布命令通道与撤销语义；批次二新增 group.move /
 * nodes.move / undo；资产回填批次新增 node.create；组织面收尾批次新增 group.rename）
 * + 生成与任务 3 + 应用状态感知 1。
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
  'canvas.inspect',
  'asset.import',
  'canvas.group.create',
  'canvas.group.rename',
  'canvas.group.dissolve',
  'canvas.group.add',
  'canvas.group.remove',
  'canvas.node.move',
  'canvas.nodes.move',
  'canvas.group.move',
  'canvas.node.delete',
  'canvas.node.create',
  'canvas.layout',
  'canvas.undo',
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
  /**
   * 项目清单（spec §5.1）：集合可能无限增长，支持与 asset list 同形的分页参数。
   * `--limit` 缺省 null=不限；`--offset` 缺省 0。响应不新增 total（不改变既有形状）。
   */
  z
    .object({
      command: z.literal('project.list'),
      limit: z.number().int().positive().nullable().default(null),
      offset: z.number().int().nonnegative().default(0),
    })
    .strict(),
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
      /**
       * `--on-canvas <true|false>` 画布引用过滤（spec CLI-056）：true=至少被一个画布节点
       * 引用、false=未被任何节点引用；缺省 null=不过滤。在其他过滤之后、分页之前生效。
       */
      on_canvas: z.boolean().nullable().default(null),
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
  // 整张画布场景图（只读，存储投影 + 可选窗口精确几何合并）：项目未打开也可用。
  z
    .object({
      command: z.literal('canvas.inspect'),
      project: ProjectParamSchema,
      /** `--full`：返回嵌套资产完整摘要与完整提示词（缺省 false = compact）。 */
      full: z.boolean().optional(),
      /** `--group <容器id>`：只返回该容器及后代成员/容器/绑定注释；未知组由执行侧报 group_not_found。 */
      group: z.string().min(1).optional(),
      /** `--prompt-limit N`：提示词截断长度（int ≥0；0=不输出；缺省 compact 200、full 不截断）。 */
      prompt_limit: z.number().int().nonnegative().optional(),
      /** `--no-unplaced`：不输出未落画布资产（缺省 true = 输出）。 */
      include_unplaced: z.boolean().optional(),
    })
    .strict(),
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
      command: z.literal('canvas.group.rename'),
      project: ProjectParamSchema,
      ...CliCanvasGroupRenameParamsSchema.shape,
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
  // 批量相对移动（spec §5.3 / CLI-053）：允许含容器 id，按引擎既有展开语义连成员一起移动。
  z
    .object({
      command: z.literal('canvas.nodes.move'),
      project: ProjectParamSchema,
      ...CliCanvasNodesMoveParamsSchema.shape,
    })
    .strict(),
  // 容器寻址移动（spec §5.3 / CLI-052）：相对位移或绝对落点二选一。
  z
    .object({
      command: z.literal('canvas.group.move'),
      project: ProjectParamSchema,
      ...CliCanvasGroupMoveParamsSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.node.delete'),
      project: ProjectParamSchema,
      ...CliCanvasNodeDeleteParamsSchema.shape,
    })
    .strict(),
  // 资产回填画布（spec §5.3 / CLI-056）：把已存在资产物化为资产节点（素材节点仍只经导入链）。
  z
    .object({
      command: z.literal('canvas.node.create'),
      project: ProjectParamSchema,
      ...CliCanvasNodeCreateParamsSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.layout'),
      project: ProjectParamSchema,
      ...CliCanvasLayoutParamsSchema.shape,
    })
    .strict(),
  // 按操作撤销（spec §5.3 / CLI-054）：只回退该次位置写入，不影响其间用户手工编辑。
  z
    .object({
      command: z.literal('canvas.undo'),
      project: ProjectParamSchema,
      ...CliCanvasUndoParamsSchema.shape,
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
  CliCanvasGroupCreateParamsSchema, CliCanvasGroupCreateResultSchema,
  CliCanvasGroupDissolveParamsSchema, CliCanvasGroupMembersParamsSchema,
  CliCanvasGroupRenameParamsSchema, CliCanvasGroupRenameResultSchema,
  CliCanvasNodeMoveParamsSchema, CliCanvasNodeDeleteParamsSchema, CliLayoutScopeSchema, CliCanvasLayoutParamsSchema,
  CliCanvasLayoutOrderModeSchema,
  CliCanvasNodeCreateParamsSchema, CliCanvasNodeCreateResultSchema,
} from './cli-canvas-contract';
export type {
  CliCanvasPosition,
  CliCanvasNodeEntry,
  CliTaskCanvasIdentity,
  CliCanvasGroupSummary,
  CliCanvasGroupAddOutcome,
  CliCanvasGroupRemoveOutcome,
  CliCanvasSelection,
  CliCanvasGroupCreateParams, CliCanvasGroupCreateResult, CliCanvasGroupDissolveParams, CliCanvasGroupMembersParams,
  CliCanvasGroupRenameParams, CliCanvasGroupRenameResult,
  CliCanvasNodeMoveParams, CliCanvasNodeDeleteParams, CliLayoutScope, CliCanvasLayoutParams,
  CliCanvasLayoutOrderMode,
  CliCanvasNodeCreateParams, CliCanvasNodeCreateResult,
} from './cli-canvas-contract';

// 画布场景图 DTO（canvas.inspect 结果 / canvas.geometry.get 几何快照）承载在
// cli-canvas-inspect-contract.ts（行数预算拆分，先例同上）；re-export 保持单一取用面。
export * from './cli-canvas-inspect-contract';

// 画布写原语 DTO（批次二：group/nodes move 参数、执行报告、结果、按操作撤销）承载在
// cli-canvas-write-contract.ts（行数预算拆分，先例同上）；re-export 保持单一取用面。
export {
  CliCanvasOperationSkipSchema,
  CliCanvasOperationSummarySchema,
  CliCanvasWriteTrailerSchema,
  CliCanvasGroupMoveParamsSchema,
  CliCanvasNodesMoveParamsSchema,
  CliCanvasNodesMovePositionSchema,
  CliCanvasUndoParamsSchema,
  CliCanvasLayoutResultSchema,
  CliCanvasLayoutOrderChangeSchema,
  CliCanvasNodeMoveResultSchema,
  CliCanvasGroupMoveResultSchema,
  CliCanvasNodesMoveResultSchema,
  CliCanvasUndoResultSchema,
} from './cli-canvas-write-contract';
export type {
  CliCanvasOperationSkip,
  CliCanvasOperationSummary,
  CliCanvasGroupMoveParams,
  CliCanvasNodesMoveParams,
  CliCanvasNodesMovePosition,
  CliCanvasUndoParams,
  CliCanvasLayoutResult,
  CliCanvasLayoutOrderChange,
  CliCanvasNodeMoveResult,
  CliCanvasGroupMoveResult,
  CliCanvasNodesMoveResult,
  CliCanvasUndoResult,
} from './cli-canvas-write-contract';

// 命令面/代理通道共用的响应域对象与共享参数形状（项目摘要、资产摘要/本地路径、
// app.status 已打开项目条目、任务终态结果、generate 受理结果、任务取消参数）承载在
// cli-response-dto-contract.ts（行数预算拆分，先例同上）；re-export 保持单一取用面。
export {
  CliProjectSummarySchema,
  CliAssetSummarySchema,
  CliAssetWithLocalPathSchema,
  CliAppStatusOpenedProjectSchema,
  CliTaskTerminalResultSchema,
  CliGenerateTaskIdentitySchema,
  CliGenerateAcceptanceSchema,
  CliTaskCancelParamsSchema,
} from './cli-response-dto-contract';
export type {
  CliProjectSummary,
  CliAssetSummary,
  CliAssetWithLocalPath,
  CliAppStatusOpenedProject,
  CliTaskTerminalResult,
  CliGenerateTaskIdentity,
  CliGenerateAcceptance,
  CliTaskCancelParams,
} from './cli-response-dto-contract';

// 代理执行通道契约（命令 / 结果 / 错误三个判别联合）承载在 cli-proxy-contract.ts
// （行数预算拆分，先例同上）；re-export 保持单一取用面。
export * from './cli-proxy-contract';

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


// 生成终态信息性提示 DTO（CLI-050）承载在 cli-generation-warning-contract.ts（行数预算拆分，先例同 cli-canvas-contract）；re-export 保持单一取用面。
export { CliGenerationWarningSchema, type CliGenerationWarning } from './cli-generation-warning-contract';


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
  // 整张画布场景图（节点 + 容器 + 未落画布资产 + 视口/选中态）。
  z.object({ command: z.literal('canvas.inspect'), ok: z.literal(true), ...CliCanvasInspectResultSchema.shape }).strict(),
  // 素材导入（CLI-047）：结果与代理执行通道共享同一形状（CliAssetImportResultSchema，不复制字段）。
  z
    .object({
      command: z.literal('asset.import'),
      ok: z.literal(true),
      ...CliAssetImportResultSchema.shape,
    })
    .strict(),
  z
    .object({
      command: z.literal('canvas.group.create'),
      ok: z.literal(true),
      // 结果形状与代理执行通道共享（CliCanvasGroupCreateResultSchema，不复制字段）：
      // member_ids 是创建后实际在组内的成员标识（空组为空数组）。
      ...CliCanvasGroupCreateResultSchema.shape,
    })
    .strict(),
  /** 重命名结果（spec §5.3 / CLI-057）：非位置类，operation_id 恒为 null（不登记按操作撤销）。 */
  z
    .object({
      command: z.literal('canvas.group.rename'),
      ok: z.literal(true),
      ...CliCanvasGroupRenameResultSchema.shape,
    })
    .strict(),
  /** 解散结果：目标容器标识 + 受影响成员列表（成员保留画布原位，归属解除）。 */
  z
    .object({
      command: z.literal('canvas.group.dissolve'),
      ok: z.literal(true),
      dissolved: z.literal(true),
      group_node_id: z.string().min(1),
      member_ids: z.array(z.string().min(1)),
      /** 操作标识（批次二）：解散不支持按操作撤销。 */
      operation_id: z.string().min(1),
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
      // 结果形状与代理执行通道共享（CliCanvasNodeMoveResultSchema，不复制字段）。
      ...CliCanvasNodeMoveResultSchema.shape,
    })
    .strict(),
  /** 批量移动结果（spec §5.3 / CLI-053）：最终位置 + 位移集合 + 执行报告。 */
  z
    .object({
      command: z.literal('canvas.nodes.move'),
      ok: z.literal(true),
      ...CliCanvasNodesMoveResultSchema.shape,
    })
    .strict(),
  /** 容器移动结果（spec §5.3 / CLI-052）：成员 + 容器最终位置 + 位移集合 + 执行报告。 */
  z
    .object({
      command: z.literal('canvas.group.move'),
      ok: z.literal(true),
      ...CliCanvasGroupMoveResultSchema.shape,
    })
    .strict(),
  /** 删除结果：实际删除的节点集合（请求集 + 伴随节点级联；组节点删除即解散，成员不在其中）。 */
  z
    .object({
      command: z.literal('canvas.node.delete'),
      ok: z.literal(true),
      deleted: z.literal(true),
      deleted_node_ids: z.array(z.string().min(1)),
      /** 操作标识（批次二）：删除不支持按操作撤销。 */
      operation_id: z.string().min(1),
    })
    .strict(),
  /** 资产物化结果（spec §5.3 / CLI-056）：结果形状与代理执行通道共享。 */
  z
    .object({
      command: z.literal('canvas.node.create'),
      ok: z.literal(true),
      ...CliCanvasNodeCreateResultSchema.shape,
    })
    .strict(),
  /** 受影响节点的最终（或 dry-run 计划）位置映射 + 执行报告（CliCanvasLayoutResultSchema）。 */
  z.object({ command: z.literal('canvas.layout'), ok: z.literal(true), ...CliCanvasLayoutResultSchema.shape }).strict(),
  /** 按操作撤销结果（spec §5.3 / CLI-054）。 */
  z.object({ command: z.literal('canvas.undo'), ok: z.literal(true), ...CliCanvasUndoResultSchema.shape }).strict(),
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
  z.object({ command: z.literal('canvas.inspect'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('asset.import'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('canvas.group.create'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('canvas.group.rename'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('canvas.group.dissolve'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('canvas.group.add'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('canvas.group.remove'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('canvas.node.move'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('canvas.nodes.move'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('canvas.group.move'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('canvas.node.delete'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('canvas.node.create'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('canvas.layout'), ok: z.literal(false), error: CliErrorSchema }).strict(),
  z.object({ command: z.literal('canvas.undo'), ok: z.literal(false), error: CliErrorSchema }).strict(),
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
