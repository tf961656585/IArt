import { z } from 'zod';
import { TaskSubmitMediaInputSchema } from './task-submit-media-input';

/**
 * @deprecated 本文件承载的 until-x / override 双线传输字段（providerOverride、overrideId、
 * until_x_success_enabled、untilXSuccessEnabled、target_success_count、targetSuccessCount、
 * append_count 等）与 TaskProviderOverrideSchema 已删除（spec 03 §11 废止 + 固定任务数批次
 * 提交主链：until-x 废止，任务成员不可补位/追加）。
 *
 * 删除声明：
 * - providerOverride / overrideId / TaskProviderOverrideSchema：已随 spec 03 废止（PC-08）。
 *   TaskProviderOverrideSchema 已迁移至 provider-connection-contract.ts 作为 @deprecated
 *   兼容导出（backend task-submit-helpers.cts 过渡消费），本文件不再承载。
 * - until_x_success_enabled / untilXSuccessEnabled / target_success_count /
 *   targetSuccessCount / append_count：until-x 已废止（固定任务数 N 无补位，docs/runtime/
 *   固定任务数批次提交与投影语义.md），不再作为提交传输字段。
 *
 * 新链路以 BatchIntentSnapshot（提交时）+ ExecutionSnapshot（派发时）为准
 * （docs/model-assets/45 §5.1/§5.2，DTO 见 provider-connection-contract.ts 与
 * promptdock-batch-contract.ts），禁止透传覆盖字段。
 */

/**
 * mention_map 条目（spec §5.4 / §7：提示词 @锚点 → 连线素材的绑定）。
 * media_kind 为该素材所属参考组，index 为组内连线顺序（0-based）：
 * image 组 index=0 对应 Image1，video 组 index=0 对应 Video1，audio 组 index=0 对应 Audio1。
 * label（mention_map 的 key）为 "@锚点名"（Image1/Video1/Audio1，spec §7.4）。
 */
export const MentionMapEntrySchema = z.object({
  media_kind: z.enum(['image', 'video', 'audio']),
  index: z.number().int().nonnegative(),
});

export type MentionMapEntry = z.infer<typeof MentionMapEntrySchema>;

export const TaskSubmitRequestBodySchema = z.object({
  model_id: z.union([z.string(), z.undefined()]),
  arguments: z.union([z.record(z.unknown()), z.undefined()]),
  media_inputs: z.union([z.array(TaskSubmitMediaInputSchema), z.undefined()]),
  input_assets: z.union([z.record(z.unknown()), z.undefined()]),
  metadata: z.union([z.record(z.unknown()), z.undefined()]),
  projectPath: z.union([z.string(), z.undefined()]),
  prebuilt_payload: z.union([z.record(z.unknown()), z.undefined()]),
  path: z.union([z.string(), z.undefined()]),
  sourceNodeId: z.union([z.string(), z.undefined()]),
  targetNodeId: z.union([z.string(), z.undefined()]),
  nodeGraphId: z.union([z.string(), z.undefined()]),
  executionId: z.union([z.string(), z.undefined()]),
  modelId: z.union([z.string(), z.undefined()]),
  clientTaskRef: z.union([z.string(), z.undefined()]),
  taskIndex: z.union([z.number(), z.string(), z.undefined()]),
  batch_id: z.union([z.string(), z.undefined()]),
  batchId: z.union([z.string(), z.undefined()]),
  policyTierKey: z.union([z.string(), z.undefined()]),
  // "@锚点 → 素材" 映射（spec §5.4 / §7.2 编辑器提交项）。.strip() 下必须显式
  // 声明字段，否则会被丢弃。mention 注入归后端物化层（spec §7.3）。
  mention_map: z.union([z.record(MentionMapEntrySchema), z.undefined()]),
}).strip();
