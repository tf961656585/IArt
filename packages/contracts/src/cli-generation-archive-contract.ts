import * as z from 'zod';

import { TaskSubmitMediaKindSchema } from './task-submit-media-input';

/**
 * CLI 生成档案 DTO（spec docs/integrations/CLI与本地Agent集成.md §5.2，CLI-038/039/040）。
 * 从 cli-contract.ts 拆出的职责边界：batch get / asset get 内联 / task get 内联共用的
 * 提交意图投影形状。字段口径与 cli-contract 一致（snake_case）。
 */

/** 生成档案的单条引用（批次提交时的参考资产）：asset_id 必载；实体可查才附类型/文件键/本地路径。 */
export const CliGenerationArchiveReferenceSchema = z
  .object({
    asset_id: z.string().min(1),
    /** 引用资产媒体类型（复用提交媒体输入的媒体类型枚举）；实体不可查证时缺省。 */
    media_kind: TaskSubmitMediaKindSchema.optional(),
    /** 资产内容文件键（`<内容sha256>.<扩展名>` 形态）；实体不可查证时缺省。 */
    file_key: z.string().min(1).optional(),
    /** 本地媒体文件绝对路径；实体不可查证或缺本地文件承载时缺省。 */
    local_file_path: z.string().min(1).optional(),
  })
  .strict();
export type CliGenerationArchiveReference = z.infer<typeof CliGenerationArchiveReferenceSchema>;

/**
 * 生成档案（CLI-038）：批次受理时冻结的提交意图（BatchIntentSnapshot）面向 CLI 的投影；
 * media_refs / reference_asset_ids 两种承载统一投影为 references 并尽量附资产实体信息与本地路径。
 * prompt 承载提示词**全文**（任务 metadata 预览是 512 字符截断摘要，档案是唯一全文读取位）；
 * params 与快照同形透传。三入口（batch get / asset get / task get 内联）经同一构建函数产出本形状，
 * 任何入口不得出现字段子集。
 */
export const CliGenerationArchiveSchema = z
  .object({
    batch_id: z.string().min(1),
    model_id: z.string().min(1),
    /** 提交提示词全文（非任务 metadata 的 512 字符预览摘要）。 */
    prompt: z.string(),
    /** 提交时冻结的模型参数（与受理快照同形透传）。 */
    params: z.record(z.unknown()),
    /** 参考资产引用（快照无 media_refs 时为空数组，不以 null 占位）。 */
    references: z.array(CliGenerationArchiveReferenceSchema),
    /** 批次固定任务成员（受理期任务标识全集）。 */
    task_ids: z.array(z.string().min(1)).min(1),
    /** 受理时刻（快照冻结值，UTC ISO 8601 存储口径）。 */
    created_at: z.string().min(1),
  })
  .strict();
export type CliGenerationArchive = z.infer<typeof CliGenerationArchiveSchema>;
