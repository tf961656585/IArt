import type {
  MediaAsset,
  ProjectMediaAssets,
  ProjectMediaType,
} from "@iart/contracts";

import {
  extractFileKeyFromRuntimeMediaUrl,
  normalizeLocalFileUrl,
} from "../utils/mediaUrl";
import mediaConstantsModule from '@iart/utils/media-constants';
const { buildLocalMediaUrl } = mediaConstantsModule;
import mediaFileKeyModule from '@iart/utils/media-file-key';
const { parseLocalMediaUrl } = mediaFileKeyModule;
import { classifyMediaUrl } from "@/features/models/shared/mediaResolutionTypes";
import { normalizeProjectMediaAssets } from "./projectMediaAssetRecords";
import { normalizeMediaType, normalizeString } from "./projectMediaAssetUtils";

export type MediaThumbnailResolveInput = {
  mediaAssets: ProjectMediaAssets;
  mediaType: ProjectMediaType;
  assetId: string | null | undefined | undefined;
  sourceUrl: string | null | undefined | undefined;
  projectRef: string | null | undefined | undefined;
  fileKey: string | null | undefined | undefined;
};

export type MediaThumbnailResolveResult = {
  asset: MediaAsset | null;
  assetId: string | null;
  sourceUrl: string | null;
  isLocalMedia: boolean;
  projectRef: string | null;
  fileKey: string | null;
};

const parseLocalMediaUrlParts = (
  rawUrl: string | null | undefined,
): { projectRef: string | null; fileKey: string | null } => {
  if (!rawUrl || typeof rawUrl !== 'string') return { projectRef: null, fileKey: null };
  // 复用 utils 统一解析（获得 V2 spid_ 支持与 scope 校验）。
  // 保留 projectRef 字段名与宽容 null 语义，最小化下游改动：
  // projectRef 字段实际承载 scope（V1/V2/global），语义在本文件上下文成立。
  // 剥离 query/hash 后缀（旧实现用 indexOf 不含后缀，这里对齐）。
  const queryIndex = rawUrl.indexOf('?');
  const hashIndex = rawUrl.indexOf('#');
  const cutIndexes = [queryIndex, hashIndex].filter((index) => index >= 0);
  const urlWithoutSuffix = cutIndexes.length === 0 ? rawUrl : rawUrl.slice(0, Math.min(...cutIndexes));
  const parsed = parseLocalMediaUrl(urlWithoutSuffix);
  if (parsed === null) return { projectRef: null, fileKey: null };
  return { projectRef: parsed.scope, fileKey: parsed.fileKey };
};

const normalizeComparableRuntimeUrl = (
  rawUrl: string | null | undefined,
): string | null => normalizeLocalFileUrl(rawUrl) ?? null;

const sameRuntimeUrl = (
  left: string | null | undefined,
  right: string | null | undefined,
): boolean => {
  const normalizedLeft = normalizeComparableRuntimeUrl(left);
  const normalizedRight = normalizeComparableRuntimeUrl(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
};

const normalizeSourceUrlForThumbnail = (sourceUrl: string | null | undefined) => {
  const trimmed = normalizeString(sourceUrl);
  if (!trimmed) return { sourceUrl: null, isLocalMedia: false };
  if (classifyMediaUrl(trimmed).kind === 'local-media') return { sourceUrl: trimmed, isLocalMedia: true };
  return {
    sourceUrl: normalizeComparableRuntimeUrl(trimmed),
    isLocalMedia: false,
  };
};

export const resolveMediaAssetForThumbnail = (
  input: MediaThumbnailResolveInput,
): MediaThumbnailResolveResult => {
  const mediaType = normalizeMediaType(input.mediaType);
  const normalizedAssets = normalizeProjectMediaAssets(input.mediaAssets ?? {});
  const requestedAssetId = normalizeString(input.assetId);
  const source = normalizeSourceUrlForThumbnail(input.sourceUrl);
  const sourceParts = parseLocalMediaUrlParts(source.sourceUrl);
  const requestedProjectRef =
    normalizeString(input.projectRef) || sourceParts.projectRef || null;
  const requestedFileKey =
    normalizeString(input.fileKey) ||
    sourceParts.fileKey ||
    (source.sourceUrl ? extractFileKeyFromRuntimeMediaUrl(source.sourceUrl) : null) ||
    null;

  const assetMatchesType = (asset: MediaAsset | null | undefined) =>
    Boolean(asset && (!mediaType || asset.mediaType === mediaType));

  if (requestedAssetId && assetMatchesType(normalizedAssets[requestedAssetId])) {
    const asset = normalizedAssets[requestedAssetId] ?? null;
    return {
      asset,
      assetId: (asset !== null && asset !== undefined ? asset.id : undefined) ?? requestedAssetId,
      sourceUrl: source.sourceUrl,
      isLocalMedia: source.isLocalMedia,
      projectRef: requestedProjectRef,
      fileKey: requestedFileKey,
    };
  }

  // miss 路径单轮扫描：原实现为 4 轮 Object.values 全表扫描（projectRef+fileKey 精确匹配 →
  // original.url/projectedUrl 运行时地址匹配 → fileKey 唯一匹配 → original.sourceUrl 匹配），
  // 各轮迭代同一集合、同一次序、条件互不依赖，故合并为单轮遍历：分别记录各条件的首个命中与
  // fileKey 命中计数，遍历后按原优先级裁决，匹配结果与多轮实现完全一致。
  // projectRef+fileKey 为最高优先级，命中即终止（同原首轮循环的 early return）；
  // 次优先级命中且无更高优先级条件时同样提前终止（同原次轮 early return）。
  const canMatchProjectRefFileKey = Boolean(requestedProjectRef && requestedFileKey);
  const canMatchSourceUrl = Boolean(source.sourceUrl);
  const rawSourceUrl = canMatchSourceUrl ? normalizeString(input.sourceUrl) : "";

  let projectRefFileKeyMatch: MediaAsset | null = null;
  let runtimeUrlMatch: MediaAsset | null = null;
  let fileKeyMatchCount = 0;
  let fileKeyUniqueMatch: MediaAsset | null = null;
  let originalSourceUrlMatch: MediaAsset | null = null;

  for (const asset of Object.values(normalizedAssets)) {
    if (!assetMatchesType(asset)) continue;
    const assetProjectRef = normalizeString((asset.original !== null && asset.original !== undefined ? asset.original.projectRef : undefined));
    const assetFileKey = normalizeString((asset.original !== null && asset.original !== undefined ? asset.original.fileKey : undefined));

    if (
      canMatchProjectRefFileKey &&
      assetProjectRef === requestedProjectRef &&
      assetFileKey === requestedFileKey
    ) {
      projectRefFileKeyMatch = asset;
      break;
    }

    if (canMatchSourceUrl && runtimeUrlMatch === null) {
      const projectedUrl = buildLocalMediaUrl(
        (asset.original !== null && asset.original !== undefined ? asset.original.projectRef : undefined),
        (asset.original !== null && asset.original !== undefined ? asset.original.fileKey : undefined),
      );
      if (
        sameRuntimeUrl((asset.original !== null && asset.original !== undefined ? asset.original.url : undefined), source.sourceUrl) ||
        sameRuntimeUrl(projectedUrl, source.sourceUrl)
      ) {
        runtimeUrlMatch = asset;
        if (!canMatchProjectRefFileKey) break;
      }
    }

    if (requestedFileKey && assetFileKey === requestedFileKey) {
      fileKeyMatchCount += 1;
      if (fileKeyUniqueMatch === null) fileKeyUniqueMatch = asset;
    }

    if (canMatchSourceUrl && originalSourceUrlMatch === null) {
      const assetSourceUrl = normalizeString((asset.original !== null && asset.original !== undefined ? asset.original.sourceUrl : undefined));
      if (assetSourceUrl && (assetSourceUrl === rawSourceUrl || assetSourceUrl === source.sourceUrl)) {
        originalSourceUrlMatch = asset;
      }
    }
  }

  const matchedAsset =
    projectRefFileKeyMatch ??
    runtimeUrlMatch ??
    (fileKeyMatchCount === 1 ? fileKeyUniqueMatch : null) ??
    originalSourceUrlMatch;

  if (matchedAsset !== null) {
    return {
      asset: matchedAsset,
      assetId: matchedAsset.id,
      sourceUrl: source.sourceUrl,
      isLocalMedia: source.isLocalMedia,
      projectRef: requestedProjectRef,
      fileKey: requestedFileKey,
    };
  }

  return {
    asset: null,
    assetId: requestedAssetId || null,
    sourceUrl: source.sourceUrl,
    isLocalMedia: source.isLocalMedia,
    projectRef: requestedProjectRef,
    fileKey: requestedFileKey,
  };
};
