import * as z from 'zod';

import { TaskSubmitMediaKindSchema } from './task-submit-media-input';

/**
 * CLI 生成档案 DTO（spec docs/integrations/CLI与本地Agent集成.md §5.2，CLI-038/039/040）。
 * 从 cli-contract.ts 拆出的职责边界：batch get / asset get 内联 / task get 内联共用的
 * 提交意图投影形状。字段口径与 cli-contract 一致（snake_case）。
 */

/**
 * 生成档案的单条引用（批次提交时的参考资产）：asset_id 必载；实体可查才附类型/文件键/本地路径。
 *
 * slot_id / field_key 来自受理快照的 media_refs（提交面显式绑定）：前者是产品级用途标识
 * （与 `--ref <素材>:<用途>`、界面用途徽章同源），后者是执行层字段键。旧快照没有这两项时缺省。
 */
export const CliGenerationArchiveReferenceSchema = z
  .object({
    asset_id: z.string().min(1),
    /** 引用资产媒体类型（复用提交媒体输入的媒体类型枚举）；实体不可查证时缺省。 */
    media_kind: TaskSubmitMediaKindSchema.optional(),
    /** 资产内容文件键（`<内容sha256>.<扩展名>` 形态）；实体不可查证时缺省。 */
    file_key: z.string().min(1).optional(),
    /** 本地媒体文件绝对路径；实体不可查证或缺本地文件承载时缺省。 */
    local_file_path: z.string().min(1).optional(),
    /** 提交时绑定的素材位标识（模型目录 media_slots[].slotId）；旧快照或未绑定时缺省。 */
    slot_id: z.string().min(1).optional(),
    /** 提交时绑定的执行层字段键（media_inputs[].field_key）；旧快照或未绑定时缺省。 */
    field_key: z.string().min(1).optional(),
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
/**
 * 单意图档案（spec 45 §5.1 / CLI spec §5.2）：一份意图的提示词全文、参数、引用与它名下的任务。
 */
export const CliGenerationArchiveIntentSchema = z
  .object({
    prompt: z.string(),
    params: z.record(z.unknown()),
    references: z.array(CliGenerationArchiveReferenceSchema),
    task_ids: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type CliGenerationArchiveIntent = z.infer<typeof CliGenerationArchiveIntentSchema>;

export const CliGenerationArchiveSchema = z
  .object({
    batch_id: z.string().min(1),
    model_id: z.string().min(1),
    /**
     * 单意图批次的提交提示词全文（非任务 metadata 的 512 字符预览摘要）。
     * 多意图批次省略该字段——消费方遍历 `intents[]`，不得把顶层 prompt 当作整批提示词。
     */
    prompt: z.string().optional(),
    /** 单意图批次的提交参数（与受理快照同形透传）；多意图批次省略。 */
    params: z.record(z.unknown()).optional(),
    /** 单意图批次的参考资产引用；多意图批次省略。 */
    references: z.array(CliGenerationArchiveReferenceSchema).optional(),
    /** 按序意图档案：恒输出，长度等于该批次的意图数。 */
    intents: z.array(CliGenerationArchiveIntentSchema).min(1),
    /** 批次固定任务成员（受理期任务标识全集）。 */
    task_ids: z.array(z.string().min(1)).min(1),
    /** 受理时刻（快照冻结值，UTC ISO 8601 存储口径）。 */
    created_at: z.string().min(1),
  })
  .strict();
export type CliGenerationArchive = z.infer<typeof CliGenerationArchiveSchema>;
