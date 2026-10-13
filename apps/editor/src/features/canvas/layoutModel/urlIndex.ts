/**
 * URL → assetId 反向索引（Layout-Model-Driven）。
 *
 * spec: docs/runtime/画布启动性能与Layout-Model架构.md
 *
 * 职责：替代 `resultAreaMediaSlots.ts` 的 O(N) 线性扫描（L116-130），
 * 让 Layout Model 媒体尺寸层 O(1) 查找 URL → assetId。
 *
 * 索引键：`asset.original.url`（参考既有线性扫描字段）。
 *
 * 约束：
 * - 纯函数，无 DOM / window / Date.now / Math.random 访问。
 * - 索引构建是只读快照；后续 mediaAssets 变化需重新构建。
 * - 重复 URL（不同 assetId 指向同一 URL）取第一个写入的 assetId（行为与既有线性扫描
 *   找到第一个匹配一致）。
 */

import type { MediaAsset, ProjectMediaAssets } from "@iart/contracts";

/**
 * URL → assetId 索引类型。
 *
 * 使用 Map 而非 Record，避免 URL 含特殊字符导致的 key 问题，且查找 O(1)。
 */
export type UrlIndex = ReadonlyMap<string, string>;

/**
 * 从单个 MediaAsset 提取索引键（original.url）。
 *
 * 纯函数：相同输入产出相同输出。
 */
function extractIndexUrl(asset: MediaAsset | null | undefined): string | null {
  if (asset === null || asset === undefined) return null;
  if (asset.original === null || asset.original === undefined) return null;
  const url = asset.original.url;
  if (typeof url !== "string" || url.length === 0) return null;
  return url;
}

/**
 * 构建 URL → assetId 反向索引。
 *
 * 纯函数：相同输入产出相同输出。
 *
 * 行为：
 * - 遍历 mediaAssets 所有条目。
 * - 提取 `asset.original.url` 作为索引键，assetId 作为值。
 * - 重复 URL（多 assetId 指向同一 URL）取第一个写入的 assetId。
 * - 无 original.url 的条目跳过。
 * - 空 mediaAssets 返回空 Map。
 *
 * @param mediaAssets 项目媒体资产集合
 * @returns URL → assetId Map
 */
export function buildUrlIndex(mediaAssets: ProjectMediaAssets): UrlIndex {
  const index = new Map<string, string>();
  if (mediaAssets === null || mediaAssets === undefined) return index;
  for (const assetId of Object.keys(mediaAssets)) {
    const asset = mediaAssets[assetId];
    if (asset === null || asset === undefined) continue;
    const url = extractIndexUrl(asset);
    if (url === null) continue;
    if (!index.has(url)) {
      index.set(url, assetId);
    }
  }
  return index;
}

/**
 * 通过 URL 反查 assetId。
 *
 * 纯函数：相同输入产出相同输出。
 *
 * @param index URL 索引（buildUrlIndex 产出）
 * @param url 待查询的 URL
 * @returns 匹配的 assetId；未匹配返回 undefined
 */
export function lookupAssetIdByUrl(
  index: UrlIndex,
  url: string | null | undefined,
): string | undefined {
  if (url === null || url === undefined) return undefined;
  if (typeof url !== "string" || url.length === 0) return undefined;
  return index.get(url);
}
