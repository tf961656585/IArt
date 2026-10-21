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
});

export type TaskSubmitMediaInput = z.infer<typeof TaskSubmitMediaInputSchema>;
export type TaskSubmitMediaKind = z.infer<typeof TaskSubmitMediaKindSchema>;
export type TaskSubmitMediaSourceKind = z.infer<typeof TaskSubmitMediaSourceKindSchema>;
