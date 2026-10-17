import * as z from 'zod';

/**
 * CLI 素材导入契约（spec §5.3 / CLI-047）—— `asset import` 命令的共享 DTO。
 *
 * 独立成文件判定：被 B 命令面（cli-contract 的请求/响应判别变体）与 C 代理执行通道
 * （命令/结果/错误判别变体）共同消费；cli-contract.ts 贴 max-lines 1000 上限，按本仓
 * 既有行数预算拆分先例（cli-canvas-contract / cli-error-code / cli-generation-archive-contract）
 * 独立承载。本文件无向上依赖（禁反向 import cli-contract，避免 CJS 循环），
 * 由 cli-contract re-export 保持 '@iart/contracts' 单一取用面。
 */

/**
 * `asset import` 参数：本地媒体文件导入。
 * `file` 为源文件绝对路径列表（至少一个，`--file` 可重复）；执行侧继承界面导入链路的
 * 媒体类型校验与内容寻址去重，全部文件先校验后执行——任一文件不存在/不可读/类型不支持
 * 即整体拒绝（不产生部分导入）。
 */
export const CliAssetImportParamsSchema = z
  .object({
    file: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type CliAssetImportParams = z.infer<typeof CliAssetImportParamsSchema>;

/** 单个导入产物条目：源文件名 + 资产标识 + 画布素材节点标识 + 媒体类型。 */
export const CliImportedAssetEntrySchema = z
  .object({
    file_name: z.string().min(1),
    asset_id: z.string().min(1),
    node_id: z.string().min(1),
    media_type: z.enum(['image', 'video', 'audio']),
  })
  .strict();
export type CliImportedAssetEntry = z.infer<typeof CliImportedAssetEntrySchema>;

/** 素材导入结果（B 命令面响应与 C 代理执行通道结果共享同一形状，不复制字段）。 */
export const CliAssetImportResultSchema = z
  .object({
    imported: z.array(CliImportedAssetEntrySchema),
  })
  .strict();
export type CliAssetImportResult = z.infer<typeof CliAssetImportResultSchema>;
