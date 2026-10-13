import * as crypto from "node:crypto";

/**
 * 内容寻址资产 id 派生（唯一文档事实源：docs/architecture/contracts/storage-schema.md
 * runtime_domain.media_assets「资产 id 派生规则」）。
 *
 * 运行域产出路径（任务产物物化与媒体工具加工）统一经本函数派生：
 * `sha256("<mediaType>:<contentHash>")` 前 16 字符；contentHash 为文件内容的 sha256
 * 十六进制摘要；mediaType 按产出资产的实际媒体类型取值（截帧/雪碧图产出图片资产取
 * `image`，裁切产出视频资产取 `video`）。
 *
 * 禁止在物化/执行器路径内再内联该公式（漂移按契约缺陷处理）。
 * 导入/登记路径（Main storage 媒体模块的 buildAssetId）2026-10-07 起收敛为同一内容寻址
 * 公式（storage-schema.md id 派生规则单规则化），不再按 original.url 来源寻址派生。
 */
export const deriveContentAddressedAssetId = (mediaType: string, contentHash: string): string =>
  crypto.createHash("sha256").update(`${mediaType}:${contentHash}`).digest("hex").slice(0, 16);
