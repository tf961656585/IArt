import type {
  MediaAsset,
  MediaAssetThumbnailStatus,
  ProjectMediaAssets,
} from "@iart/contracts";

import { normalizeProjectMediaAssets } from "./projectMediaAssetRecords";

/**
 * mediaAssets 写入来源标识。merge 规则按来源裁决并发冲突，详见
 * docs/runtime/媒体展示态与缩略图语义.md「MediaAsset 并发写入裁决规则」。
 *
 * - backend-notification: backend 主动通知的增量更新（media-assets:changed、thumbnail repair 完成）
 * - backend-projection: backend 周期性快照回写（task projection 的 mediaAssets）
 * - user-action: 前端用户操作触发的写入（smart-split、本地导入、裁剪/缩放、bundle 导入）
 * - project-load: 项目加载/恢复的全量写入（loadNodeGraph、recovery flush）
 */
export type MediaAssetWriteSource =
  | "backend-notification"
  | "backend-projection"
  | "user-action"
  | "project-load";

/**
 * thumbnail status 单调序。用于 user-action 来源的裁决：
 * user-action 不得把 store 中的 thumbnail 降级到更低 rank。
 *
 * 排序依据见 docs/runtime/媒体展示态与缩略图语义.md「thumbnail status 单调序」。
 * 缺失或未知 status rank 视为 0（missing 等价）。
 */
const THUMBNAIL_STATUS_RANK: Record<MediaAssetThumbnailStatus, number> = {
  missing: 0,
  generating: 1,
  stale: 2,
  failed: 3,
  ready: 4,
};

const getThumbnailStatusRank = (
  status: MediaAssetThumbnailStatus,
): number => {
  return THUMBNAIL_STATUS_RANK[status] ?? 0;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/**
 * 判断是否应采纳 incoming 的 thumbnail 字段。按来源和 spec 裁决规则。
 *
 * - backend-notification: 无条件采纳（权威增量通知）
 * - backend-projection: 按 updatedAt 裁决（旧快照不覆盖新状态）
 * - user-action: 按 status 单调序保护（不降级）
 */
const shouldAdoptThumbnail = (
  existing: MediaAsset,
  incoming: MediaAsset,
  source: MediaAssetWriteSource,
): boolean => {
  if (source === "backend-notification") {
    return true;
  }

  if (source === "backend-projection") {
    // updatedAt 缺失时按来源优先级裁决：backend-projection 优先于 user-action，
    // 但此处 existing 也可能是 backend-notification 写入的（优先级更高），所以
    // updatedAt 缺失时不无条件采纳——保守采纳（spec: updatedAt 缺失按来源优先级，
    // backend-projection > user-action，但 < backend-notification 无法仅凭 source 判断）。
    // spec 字面规则：updatedAt 缺失时按来源优先级，backend-projection 高于 user-action，
    // 因此对 existing（无论其来源）统一采纳 incoming——保守地信任 backend 数据。
    // 但当 updatedAt 都存在时，严格按 updatedAt 比较。
    const existingUpdatedAt = existing.lifecycle.updatedAt;
    const incomingUpdatedAt = incoming.lifecycle.updatedAt;
    if (
      typeof existingUpdatedAt === "number" &&
      typeof incomingUpdatedAt === "number"
    ) {
      return incomingUpdatedAt >= existingUpdatedAt;
    }
    return true;
  }

  // source === "user-action"
  const existingRank = getThumbnailStatusRank(existing.thumbnail.status);
  const incomingRank = getThumbnailStatusRank(incoming.thumbnail.status);
  return incomingRank >= existingRank;
};

/**
 * 合并两个 MediaAsset 的 lifecycle.updatedAt（取较大值）。
 * createdAt 取 existing（保留原始创建时刻），updatedAt 取 max。
 */
const mergeLifecycle = (
  existing: MediaAsset,
  incoming: MediaAsset,
): { createdAt: number; updatedAt: number } => {
  const createdAt = existing.lifecycle.createdAt;
  const existingUpdatedAt = existing.lifecycle.updatedAt;
  const incomingUpdatedAt = incoming.lifecycle.updatedAt;
  const updatedAt =
    typeof existingUpdatedAt === "number" &&
    typeof incomingUpdatedAt === "number"
      ? Math.max(existingUpdatedAt, incomingUpdatedAt)
      : typeof incomingUpdatedAt === "number"
        ? incomingUpdatedAt
        : typeof existingUpdatedAt === "number"
          ? existingUpdatedAt
          : createdAt;
  return { createdAt, updatedAt };
};

/**
 * 判断是否应采纳 incoming 的 original 字段。last-write-wins by updatedAt。
 * updatedAt 缺失或相等时采纳 incoming（last-write-wins 默认）。
 */
const shouldAdoptOriginal = (
  existing: MediaAsset,
  incoming: MediaAsset,
): boolean => {
  const existingUpdatedAt = existing.lifecycle.updatedAt;
  const incomingUpdatedAt = incoming.lifecycle.updatedAt;
  if (
    typeof existingUpdatedAt === "number" &&
    typeof incomingUpdatedAt === "number"
  ) {
    return incomingUpdatedAt >= existingUpdatedAt;
  }
  return true;
};

/**
 * 合并单个 asset 的字段级裁决。返回裁决后的完整 MediaAsset。
 *
 * 裁决规则严格按 docs/runtime/媒体展示态与缩略图语义.md「字段级裁决规则」。
 */
const mergeSingleAsset = (
  existing: MediaAsset,
  incoming: MediaAsset,
  source: MediaAssetWriteSource,
): MediaAsset => {
  const adoptThumbnail = shouldAdoptThumbnail(existing, incoming, source);
  const adoptOriginal = shouldAdoptOriginal(existing, incoming);
  const lifecycle = mergeLifecycle(existing, incoming);

  return {
    id: incoming.id,
    mediaType: incoming.mediaType,
    original: adoptOriginal ? incoming.original : existing.original,
    thumbnail: adoptThumbnail ? incoming.thumbnail : existing.thumbnail,
    lifecycle: {
      createdAt: lifecycle.createdAt,
      updatedAt: lifecycle.updatedAt,
    },
  };
};

/**
 * mediaAssets 并发写入的单一 merge 漏斗。
 *
 * 所有 mediaAssets 写入必须经过 setProjectMediaAssets action 内部调用此函数。
 * 禁止调用点自建 { ...mediaAssets快照, ...patch } 的整体替换模式。
 *
 * @param prev - store 中当前的 mediaAssets（裁决基准）
 * @param patch - 本次写入的新增/变更资产（调用方已 normalize）
 * @param source - 写入来源标识，决定裁决规则
 * @returns 裁决后的完整 ProjectMediaAssets
 *
 * project-load source 走全量替换（不走字段级 merge），返回 normalize 后的 patch，
 * 清空 prev 中不在 patch 的资产——项目加载时磁盘数据是唯一事实源。
 */
export const mergeMediaAssets = (
  prev: ProjectMediaAssets,
  patch: ProjectMediaAssets,
  source: MediaAssetWriteSource,
): ProjectMediaAssets => {
  if (source === "project-load") {
    // 全量替换豁免：项目加载时磁盘数据是唯一事实源，清空旧状态。
    return normalizeProjectMediaAssets(patch);
  }

  const out: ProjectMediaAssets = { ...prev };

  for (const [assetId, incoming] of Object.entries(patch)) {
    if (!isNonEmptyString(assetId) || incoming === null || incoming === undefined) {
      continue;
    }
    const existing = out[assetId];
    if (existing === null || existing === undefined) {
      // prev 中不存在该 id：直接采纳 incoming（调用方已 normalize）。
      out[assetId] = incoming;
    } else {
      out[assetId] = mergeSingleAsset(existing, incoming, source);
    }
  }

  return out;
};
