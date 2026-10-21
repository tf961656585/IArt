import { z } from 'zod';

/**
 * 生成终态信息性提示（spec docs/integrations/CLI与本地Agent集成.md §5.4 / CLI-050）。
 *
 * 任务成功但实际产物与请求不一致时随终态结果输出。信息性字段——不改变任务状态、
 * 不翻转 ok、不改变 assets（呈现层守护，不是受理前校验）。目前唯一枚举
 * `requested_size_not_honored`（请求尺寸未被实际产物满足）。
 */
export const CliGenerationWarningSchema = z
  .object({
    code: z.literal('requested_size_not_honored'),
    /** 面向用户的完整提示，可直接展示。 */
    message: z.string().min(1),
    /** 请求尺寸，形如 "2560x1440"（小写 x；`auto`/档位值/缺失不产生提示）。 */
    requested_size: z.string().min(1),
    /** 去重后的实际图片产物尺寸（字典序），形如 ["1903x2560"]。 */
    actual_sizes: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type CliGenerationWarning = z.infer<typeof CliGenerationWarningSchema>;
