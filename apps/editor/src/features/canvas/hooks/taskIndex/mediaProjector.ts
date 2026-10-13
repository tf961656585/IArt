import { resolveApiEndpoint } from "@/client/utils/apiConfig";
import { getRuntimeProjectRef } from "@/client/store/runtimeStore";
import { runtimeMediaAssetViewToMediaAsset } from "@iart/contracts";
import type { MediaAsset, RuntimeMediaAssetView, RuntimeTaskOutputRow, RuntimeTaskView } from "@iart/contracts";
import type { UnifiedGenerationOutputEntry, UnifiedGenerationProgress, UnifiedGenerationStatus } from "@iart/contracts/unified-generation";
import type { NodeTaskInfo, ResultAreaSlotView } from "../../types/node";
import { useCanvasStore } from "../../store/canvasStore";
import { normalizeProjectMediaAssets } from "../../services/projectMediaAssets";
import mediaConstantsModule from '@iart/utils/media-constants';
const { buildLocalMediaUrl } = mediaConstantsModule;
import { extractFileKeyFromRuntimeMediaUrl, normalizeLocalFileUrl } from "../../utils/mediaUrl";
import { pickMatchKey } from "../../utils/runtimeRef";
import type { DerivedMaterialOutput, RuntimeTaskCanvasOutput } from "./types";
import {
  isLocalMediaValue,
  isPlainObject,
} from "./primitives";

// ── Output conversion ──

const buildMediaAssetMapByAssetId = (
  mediaAssets: RuntimeMediaAssetView[],
): Record<string, RuntimeMediaAssetView> => {
  const byAssetId: Record<string, RuntimeMediaAssetView> = {};
  for (const ma of mediaAssets) {
    const assetId = pickMatchKey((ma !== null && ma !== undefined ? ma.assetId : undefined));
    if (!assetId) continue;
    byAssetId[assetId] = ma;
  }
  return byAssetId;
};

const readRuntimeOutputMediaType = (
  value: unknown,
): UnifiedGenerationOutputEntry["mediaType"] | null => {
  const mediaType = pickMatchKey(value);
  return mediaType === "image" ||
    mediaType === "video" ||
    mediaType === "audio" ||
    mediaType === "text"
    ? mediaType
    : null;
};

const convertRuntimeMediaAssetViewToProjectMediaAsset = (
  mediaAsset: RuntimeMediaAssetView,
): MediaAsset | null => {
  const asset = runtimeMediaAssetViewToMediaAsset(mediaAsset);
  if (!asset) return null;

  const fileKey = asset.original.fileKey ?? (asset.original.url ? extractFileKeyFromRuntimeMediaUrl(asset.original.url) : null);
  const projectRef = getRuntimeProjectRef() ?? asset.original.projectRef ?? null;
  const originalUrl = buildLocalMediaUrl(projectRef, fileKey) ?? asset.original.url;
  if (!normalizeLocalFileUrl(originalUrl)) return null;

  return normalizeProjectMediaAssets({
    [asset.id]: {
      ...asset,
      original: {
        ...asset.original,
        url: originalUrl,
        projectRef: projectRef ?? null,
        fileKey: fileKey ?? null,
      },
    },
  })[asset.id] ?? null;
};

const convertRuntimeTaskOutputRowToIndexOutput = (
  output: RuntimeTaskOutputRow,
  mediaAsset: RuntimeMediaAssetView | null,
  outputIndex: number,
): RuntimeTaskCanvasOutput | null => {
  const mediaType = readRuntimeOutputMediaType(output.mediaType);
  if (!mediaType) return null;
  const assetId = pickMatchKey(output.assetId) ?? pickMatchKey((mediaAsset !== null && mediaAsset !== undefined ? mediaAsset.assetId : undefined)) ?? null;
  return {
    outputIndex,
    entry: {
      mediaType,
      assetId,
      textValue: mediaType === "text" ? pickMatchKey(output.textValue) ?? "" : null,
      url: null,
      mediaAsset: mediaAsset ? convertRuntimeMediaAssetViewToProjectMediaAsset(mediaAsset) : null,
      mimeType: null,
      sizeBytes: null,
    },
  };
};

const toUnifiedProgress = (
  phaseValue: unknown,
): UnifiedGenerationProgress | null => {
  const phase = pickMatchKey(phaseValue);
  return phase ? { phase } : null;
};

const convertNotificationOutputs = (
  outputs: RuntimeTaskOutputRow[],
  mediaAssets: RuntimeMediaAssetView[],
): RuntimeTaskCanvasOutput[] => {
  const mediaByAssetId = buildMediaAssetMapByAssetId(mediaAssets);
  const orderedOutputs = outputs
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const leftOrder = left.row.sortOrder;
      const rightOrder = right.row.sortOrder;
      const leftHasOrder = Number.isFinite(leftOrder);
      const rightHasOrder = Number.isFinite(rightOrder);
      if (leftHasOrder && rightHasOrder && leftOrder !== rightOrder) {
        return Number(leftOrder) - Number(rightOrder);
      }
      if (leftHasOrder !== rightHasOrder) return leftHasOrder ? -1 : 1;
      return left.index - right.index;
    });

  return orderedOutputs
    .map(({ row }, index) => {
      const assetId = pickMatchKey(row.assetId);
      return convertRuntimeTaskOutputRowToIndexOutput(row, assetId ? (mediaByAssetId[assetId] ?? null) : null, index);
    })
    .filter((o): o is RuntimeTaskCanvasOutput => o !== null);
};

const resolveMediaOutputUrlFromIndex = (params: {
  mediaType: ResultAreaSlotView["mediaType"] | undefined;
  assetId: unknown | undefined;
  mediaAsset: unknown | undefined;
}): string => {
  if (params.mediaType === "text") return "";
  const assetId = pickMatchKey(params.assetId);
  if (!assetId) return "";
  const inlineMediaAsset = (() => {
    if (!isPlainObject(params.mediaAsset)) return null;
    const candidate = params.mediaAsset as Partial<MediaAsset>;
    return normalizeProjectMediaAssets({
      [assetId]: {
        id: candidate.id ?? assetId,
        mediaType: candidate.mediaType ?? params.mediaType,
        original: candidate.original,
        thumbnail: candidate.thumbnail,
        lifecycle: candidate.lifecycle,
      },
    })[assetId] ?? null;
  })();
  const inlineUrl = pickMatchKey((inlineMediaAsset !== null && inlineMediaAsset !== undefined && inlineMediaAsset.original !== null && inlineMediaAsset.original !== undefined ? inlineMediaAsset.original.url : undefined));
  if (inlineUrl) return inlineUrl;
  const asset = (useCanvasStore.getState().mediaAssets !== null && useCanvasStore.getState().mediaAssets !== undefined ? useCanvasStore.getState().mediaAssets[assetId] : undefined);
  if (asset && asset.mediaType === params.mediaType) return pickMatchKey((asset.original !== null && asset.original !== undefined ? asset.original.url : undefined)) ?? "";
  return inlineUrl ?? "";
};

const resolveIndexOutputValue = (output: RuntimeTaskCanvasOutput): string => {
  if (output.entry.mediaType === "text") return output.entry.textValue ?? "";
  const rawUrl = resolveMediaOutputUrlFromIndex(output.entry);
  if (!rawUrl) return "";
  const localUrl = normalizeLocalFileUrl(rawUrl);
  try {
    return resolveApiEndpoint(localUrl ?? rawUrl);
  } catch {
    return localUrl ?? rawUrl;
  }
};

const shouldKeepExistingLocalMediaValue = (params: {
  mediaType: ResultAreaSlotView["mediaType"] | undefined;
  currentValue: unknown | undefined;
  nextValue: unknown | undefined;
}): boolean => {
  if (params.mediaType !== "image" && params.mediaType !== "video" && params.mediaType !== "audio") return false;
  if (!isLocalMediaValue(params.currentValue)) return false;
  return !isLocalMediaValue(params.nextValue);
};

const buildDerivedMaterialOutputs = (
  convertedOutputs: RuntimeTaskCanvasOutput[],
  consumedOutputIndex: number | null | undefined,
): DerivedMaterialOutput[] =>
  convertedOutputs
    .filter((o) => o.entry.mediaType !== "text" && o.outputIndex !== consumedOutputIndex)
    .map((o) => ({
      mediaType: o.entry.mediaType as "image" | "video" | "audio",
      url: resolveIndexOutputValue(o),
      outputIndex: o.outputIndex,
    }))
    .filter((o) => Boolean(o.url));

// ── Build NodeTaskInfo from RuntimeTaskView ──

const buildTaskInfoFromRuntimeTask = (
  taskRow: RuntimeTaskView,
  existing: NodeTaskInfo | null | undefined,
): NodeTaskInfo => {
  const now = Date.now();
  const progress =
    toUnifiedProgress(taskRow.progressPhase) ?? (existing !== null && existing !== undefined ? existing.progress : undefined) ?? null;
  return {
    taskId: taskRow.taskId,
    remoteRequestId:
      taskRow.remoteRequestId ??
      (existing !== null && existing !== undefined ? existing.remoteRequestId : undefined),
    taskIndex: (existing !== null && existing !== undefined ? existing.taskIndex : undefined) ?? 0,
    modelId: (existing !== null && existing !== undefined ? existing.modelId : undefined) ?? "unknown",
    status: taskRow.status as UnifiedGenerationStatus,
    progress,
    createdAt: taskRow.createdAt ?? (existing !== null && existing !== undefined ? existing.createdAt : undefined) ?? now,
    updatedAt: taskRow.updatedAt ?? now,
    error:
      taskRow.errorMessage ??
      (existing !== null && existing !== undefined ? existing.error : undefined),
    failure:
      taskRow.status === "failed"
        ? taskRow.failure ?? (existing !== null && existing !== undefined ? existing.failure : undefined) ?? null
        : (existing !== null && existing !== undefined ? existing.failure : undefined),
    batchId:
      taskRow.batchId ??
      (existing !== null && existing !== undefined ? existing.batchId : undefined),
  };
};

export {
  buildDerivedMaterialOutputs,
  buildTaskInfoFromRuntimeTask,
  convertNotificationOutputs,
  convertRuntimeMediaAssetViewToProjectMediaAsset,
  resolveIndexOutputValue,
  shouldKeepExistingLocalMediaValue,
  toUnifiedProgress,
};
