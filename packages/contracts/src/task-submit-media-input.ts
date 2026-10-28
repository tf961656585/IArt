import { z } from 'zod';

export const TaskSubmitMediaKindSchema = z.enum(['image', 'video', 'audio']);
export const TaskSubmitMediaSourceKindSchema = z.enum(['base64', 'url', 'local_path', 'attachment']);

/**
 * 提交体的单条媒体输入。
 *
 * `field_key` 是**显式字段绑定**（可选）：调用方（创作面）知道这张图该进模型的哪个素材位时，
 * 直接把该素材位对应的参数字段键写在这里，后端按它分桶、不再自行推断。
 *
 * 为什么需要它：模型可能有多个同媒体类型的素材位（如视频生成的首帧 + 尾帧，都是图片）。
 * 只按媒体类型分桶时后写会覆盖先写，图片会被整体倒进最后声明的那一个位——界面上「标了首帧」
 * 与最终请求不一致，且不报错。显式绑定让「用户表达的位置」一路传到组装层。
 *
 * 缺省语义：不传表示调用方未指定位置，由后端在该媒体类型**只有一个候选位**时按类型兜底；
 * 有多个候选位时明确失败并点名候选位，不做顺序启发式（宁可报错，也不猜错位）。
 */
export const TaskSubmitMediaInputSchema = z.object({
  media_kind: TaskSubmitMediaKindSchema,
  source_kind: TaskSubmitMediaSourceKindSchema,
  value: z.string(),
  mime_type: z.union([z.string(), z.null()]),
  filename: z.union([z.string(), z.null()]),
  /** 显式字段绑定：该条媒体要落进的参数字段键。仅在调用方明确知道素材位时给出。 */
  field_key: z.string().min(1).optional(),
  /**
   * 资产身份（可选）：该条媒体来自项目资产时的素材标识。
   *
   * 用途：提交档案把「实际出网的媒体文件」对回具体资产。没有它时只能按内容指纹/字节数反推，
   * 一旦同一内容存在多个资产身份或指纹未命中，就静默失去溯源（见生成档案 references 兜底路径）。
   */
  asset_id: z.string().min(1).optional(),
  /**
   * 素材位标识（可选）：该条媒体绑定到的产品级用途 id（模型目录 `media_slots[].slotId`）。
   *
   * 与 field_key 的分工：field_key 是执行层字段键（后端按它分桶），slot_id 是产品层用途标识
   * （命令行 `--ref <素材>:<用途>` 与界面用途徽章同源）。二者由目录条目关联，提交时一并记录，
   * 让档案无需再查目录即可读出「哪张图是什么用途」。
   */
  slot_id: z.string().min(1).optional(),
});

export type TaskSubmitMediaInput = z.infer<typeof TaskSubmitMediaInputSchema>;
export type TaskSubmitMediaKind = z.infer<typeof TaskSubmitMediaKindSchema>;
export type TaskSubmitMediaSourceKind = z.infer<typeof TaskSubmitMediaSourceKindSchema>;
