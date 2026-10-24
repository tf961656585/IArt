import * as z from 'zod';

import { PromptDockBatchTaskAcceptanceSchema } from './promptdock-batch-contract';
import { RuntimeMediaAssetViewSchema, RuntimeTaskViewSchema } from './schemas/runtime-transaction.schema';
import { CliCanvasSelectionSchema, CliTaskCanvasIdentitySchema } from './cli-canvas-contract';
import { CliGenerationWarningSchema } from './cli-generation-warning-contract';

/**
 * CLI 命令面 / 代理执行通道复用的响应域对象与共享参数形状。
 *
 * 从 cli-contract.ts 拆出的职责边界（行数预算拆分，先例同 cli-canvas-contract /
 * cli-proxy-contract）：本文件只承载被 B 命令面响应与 C 代理执行通道**共同**引用的
 * 组合形状（项目摘要、资产摘要/本地路径、app.status 已打开项目条目、任务终态结果、
 * generate 受理结果、任务取消参数）。字段口径与 cli-contract 一致（snake_case），
 * 由 cli-contract re-export 保持 '@iart/contracts' 单一取用面。
 */

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
 * 资产清单条目（spec §5.2 asset list：资产标识、媒体类型、生成来源摘要、画布引用）。
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
    /**
     * 引用该资产的画布节点标识（spec CLI-056）：资产节点与图片/视频/音频素材节点的
     * data.assetId 同口径（CLI-017）。未上画布为空数组；同一资产可被多个节点引用。
     */
    node_ids: z.array(z.string().min(1)),
    /** 生成来源批次标识；导入素材与无产出来源的资产为 null（spec CLI-056）。 */
    batch_id: z.string().min(1).nullable(),
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

/** 任务取消参数：目标任务标识。 */
export const CliTaskCancelParamsSchema = z
  .object({
    task_id: z.string().min(1),
  })
  .strict();
export type CliTaskCancelParams = z.infer<typeof CliTaskCancelParamsSchema>;
