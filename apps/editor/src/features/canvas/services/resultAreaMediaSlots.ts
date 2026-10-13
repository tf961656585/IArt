import type { MediaAsset, ProjectMediaAssets } from "@iart/contracts";

import type {
  ResultAreaFormalSlot,
  GraphNode,
  ModelNodeData,
  NodeGraph,
  ResultAreaEmbeddedData,
  ResultAreaSlotRuntimeProjection,
  ResultAreaSlotView,
  TaskSlotErrorDetails,
} from "../types";
import { normalizeRuntimeRef } from "../utils/runtimeRef";
import { normalizeResultAreaSlotOrigin } from "../utils/resultAreaSlotOrigin";
import {
  normalizeAspectRatio,
  normalizeFiniteNumber,
  normalizeString,
} from "./projectMediaAssetUtils";

const buildResultAreaProtocolError = (
  message: string,
  current: ResultAreaSlotView["errorDetails"] | undefined,
): TaskSlotErrorDetails => {
  if (current !== undefined && current !== null && current.backendMessage !== undefined) {
    return current;
  }
  // 本地构造的协议错误，无 RuntimeTaskFailure 来源；userMessage 同文案，不可重试。
  return {
    backendMessage: message,
    userMessage: message,
    retryable: false,
  };
};

const throwInvalidResultAreaItemError = (
  reason = "invalid-result-area-item-protocol",
): never => {
  throw new Error(reason);
};

export const resolveMediaSlotType = (
  item:
    | ResultAreaFormalSlot
    | Pick<ResultAreaSlotView, "itemType" | "assetId" | "runtimeRef" | "mediaType">,
  _mediaAssets: ProjectMediaAssets,
): ResultAreaSlotView["mediaType"] => {
  if (item.itemType === "text") return "text";
  const assetId =
    normalizeString(item.assetId) || normalizeString((item.runtimeRef !== null && item.runtimeRef !== undefined ? item.runtimeRef.assetId : undefined));
  if (assetId) {
    return (_mediaAssets[assetId] !== null && _mediaAssets[assetId] !== undefined ? _mediaAssets[assetId].mediaType : undefined) ?? undefined;
  }
  return undefined;
};

export const resolveMediaSlotValue = (
  item: Pick<ResultAreaFormalSlot, "itemType" | "assetId" | "textValue" | "runtimeRef">,
  _mediaAssets: ProjectMediaAssets,
): string | null => {
  if (item.itemType === "text") {
    return typeof item.textValue === "string" ? item.textValue : "";
  }
  const assetId =
    normalizeString(item.assetId) || normalizeString((item.runtimeRef !== null && item.runtimeRef !== undefined ? item.runtimeRef.assetId : undefined));
  if (assetId) {
    return (_mediaAssets[assetId] !== null && _mediaAssets[assetId] !== undefined && _mediaAssets[assetId].original !== null && _mediaAssets[assetId].original !== undefined ? _mediaAssets[assetId].original.url : undefined) ?? null;
  }
  return null;
};

export const resolveMediaAssetOriginalAspectRatio = (
  asset: MediaAsset | null | undefined,
): number | null => {
  const width = normalizeFiniteNumber((asset !== null && asset !== undefined && asset.original !== null && asset.original !== undefined ? asset.original.width : undefined));
  const height = normalizeFiniteNumber((asset !== null && asset !== undefined && asset.original !== null && asset.original !== undefined ? asset.original.height : undefined));
  if (!width || !height || width <= 0 || height <= 0) return null;
  return width / height;
};

// original.url → 资产索引缓存：mediaAssets 不可变更新（immer），引用不变则索引有效。
// 避免每次按 URL 反查资产都 O(全量资产) 扫描；同 URL 多资产保序，查找语义与原线性扫描等价。
const mediaAssetsByOriginalUrlCache = new WeakMap<ProjectMediaAssets, Map<string, MediaAsset[]>>();

const readMediaAssetsByOriginalUrl = (
  mediaAssets: ProjectMediaAssets,
): Map<string, MediaAsset[]> => {
  const cached = mediaAssetsByOriginalUrlCache.get(mediaAssets);
  if (cached !== undefined) return cached;
  const index = new Map<string, MediaAsset[]>();
  for (const asset of Object.values(mediaAssets)) {
    const assetUrl = normalizeString(
      asset !== null && asset !== undefined && asset.original !== null && asset.original !== undefined
        ? asset.original.url
        : undefined,
    );
    if (!assetUrl) continue;
    const bucket = index.get(assetUrl);
    if (bucket !== undefined) {
      bucket.push(asset);
    } else {
      index.set(assetUrl, [asset]);
    }
  }
  mediaAssetsByOriginalUrlCache.set(mediaAssets, index);
  return index;
};

export const resolveMediaSlotDisplayAspectRatio = (
  item: Pick<
    ResultAreaSlotView,
    | "itemType"
    | "assetId"
    | "runtimeRef"
    | "value"
    | "expectedAspectRatio"
    | "displayAspectRatio"
    | "taskInfo"
    | "mediaType"
  >,
  _mediaAssets: ProjectMediaAssets,
  runtimeFallbackAspectRatio: number | null | undefined,
): number | null => {
  const derivedDisplayAspectRatio = normalizeAspectRatio(
    item.displayAspectRatio,
  );
  if (derivedDisplayAspectRatio) {
    return derivedDisplayAspectRatio;
  }

  const mediaType = resolveMediaSlotType(item, _mediaAssets) ?? item.mediaType;
  const formalAssetId =
    normalizeString(item.assetId) || normalizeString((item.runtimeRef !== null && item.runtimeRef !== undefined ? item.runtimeRef.assetId : undefined));
  const formalAspectRatio =
    mediaType === "image" || mediaType === "video"
      ? resolveMediaAssetOriginalAspectRatio(
          formalAssetId ? _mediaAssets[formalAssetId] : null,
        )
      : null;
  if ((item.taskInfo !== null && item.taskInfo !== undefined ? item.taskInfo.status : undefined) === "succeeded" && formalAspectRatio) {
    return formalAspectRatio;
  }
  if ((item.taskInfo !== null && item.taskInfo !== undefined ? item.taskInfo.status : undefined) === "succeeded") {
    const runtimeValue = normalizeString(item.value);
    if (runtimeValue) {
      const candidates = readMediaAssetsByOriginalUrl(_mediaAssets).get(runtimeValue) ?? [];
      for (const asset of candidates) {
        const runtimeAspectRatio = resolveMediaAssetOriginalAspectRatio(asset);
        if (runtimeAspectRatio) {
          return runtimeAspectRatio;
        }
      }
    }
  }

  const expectedAspectRatio = normalizeAspectRatio(item.expectedAspectRatio);
  if (expectedAspectRatio) {
    return expectedAspectRatio;
  }

  return normalizeAspectRatio(runtimeFallbackAspectRatio);
};

export const hydrateMediaSlot = (
  item: ResultAreaFormalSlot,
  _mediaAssets: ProjectMediaAssets,
  runtimeProjection: ResultAreaSlotRuntimeProjection | undefined,
): ResultAreaSlotView => {
  const runtimeAssetId =
    item.runtimeRef !== null && item.runtimeRef !== undefined
      ? item.runtimeRef.assetId
      : undefined;
  const mediaType = resolveMediaSlotType(item, _mediaAssets);
  const formalValue = resolveMediaSlotValue(item, _mediaAssets);
  const taskInfo =
    runtimeProjection !== null && runtimeProjection !== undefined
      ? runtimeProjection.taskInfo
      : undefined;
  const runtimeMediaType =
    runtimeProjection !== null && runtimeProjection !== undefined
      ? runtimeProjection.mediaType
      : undefined;
  const runtimeDisplayAspectRatio =
    runtimeProjection !== null && runtimeProjection !== undefined
      ? runtimeProjection.displayAspectRatio
      : undefined;
  const runtimeExpectedAspectRatio =
    runtimeProjection !== null && runtimeProjection !== undefined
      ? runtimeProjection.expectedAspectRatio
      : undefined;
  let errorDetails =
    runtimeProjection !== null && runtimeProjection !== undefined
      ? runtimeProjection.errorDetails
      : undefined;
  const value =
    runtimeProjection !== null && runtimeProjection !== undefined
      ? runtimeProjection.value ?? formalValue
      : formalValue;

  if (
    item.itemType !== "text" &&
    normalizeString(item.assetId) &&
    (!mediaType || !value)
  ) {
    errorDetails = buildResultAreaProtocolError(
      "这条结果引用的素材已经不在项目里，请重新生成或重新导入。",
      errorDetails,
    );
  }

  const displayAspectRatio = resolveMediaSlotDisplayAspectRatio(
    {
      ...item,
      displayAspectRatio: runtimeDisplayAspectRatio,
      mediaType: runtimeMediaType ?? mediaType,
      taskInfo,
      value,
      expectedAspectRatio: runtimeExpectedAspectRatio,
      assetId: item.assetId ?? runtimeAssetId ?? null,
    },
    _mediaAssets,
    undefined,
  );
  return {
    ...item,
    assetId: item.assetId ?? runtimeAssetId ?? null,
    taskInfo,
    value,
    mediaType: mediaType ?? runtimeMediaType,
    displayAspectRatio: displayAspectRatio ?? undefined,
    expectedAspectRatio: runtimeExpectedAspectRatio,
    errorDetails,
  };
};

export const sanitizeResultAreaItemForPersistence = (
  item: ResultAreaFormalSlot,
): ResultAreaFormalSlot => {
  return sanitizeResultAreaItemForPersistenceWithAssets(item);
};

const sanitizeResultAreaItemForPersistenceWithAssets = (
  item: ResultAreaFormalSlot,
): ResultAreaFormalSlot => {
  if (!item || typeof item !== "object") {
    throwInvalidResultAreaItemError();
  }

  const origin = normalizeResultAreaSlotOrigin(item.origin) ?? undefined;
  const runtimeRef =
    normalizeRuntimeRef({
      taskId: (item.runtimeRef !== null && item.runtimeRef !== undefined ? item.runtimeRef.taskId : undefined),
      resultId: (item.runtimeRef !== null && item.runtimeRef !== undefined ? item.runtimeRef.resultId : undefined),
      assetId: (item.runtimeRef !== null && item.runtimeRef !== undefined ? item.runtimeRef.assetId : undefined) ?? item.assetId,
    }) ?? undefined;

  const base = {
    id: item.id,
    targetKey: item.targetKey,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    origin,
    runtimeRef,
  };

  if (item.itemType === "text") {
    const textValue = normalizeString(item.textValue);
    return {
      ...base,
      itemType: "text",
      assetId: null,
      textValue: textValue || null,
    };
  }

  const assetId = normalizeString(item.assetId);
  return {
    ...base,
    itemType: "media",
    assetId: assetId || null,
    textValue: null,
  };
};

/**
 * 对单个 model 节点内嵌 resultArea 的 slots 执行 sanitize。
 * 返回新的 model 节点（data.resultArea.slots 被净化）。
 */
const sanitizeModelNodeResultAreaSlots = (node: GraphNode): GraphNode => {
  if (node.type !== "model") return node;
  const data = node.data as ModelNodeData;
  const resultArea = data.resultArea as ResultAreaEmbeddedData | undefined;
  if (resultArea === null || resultArea === undefined) return node;
  const slots = Array.isArray(resultArea.slots) ? resultArea.slots : [];
  return {
    ...node,
    data: {
      ...data,
      resultArea: {
        ...resultArea,
        slots: slots.map((item) => sanitizeResultAreaItemForPersistenceWithAssets(item)),
      },
    },
  } as GraphNode;
};

export const hydrateNodeGraphResultAreaItems = (
  nodeGraph: NodeGraph,
  _mediaAssets: ProjectMediaAssets,
): NodeGraph => ({
  ...nodeGraph,
  nodes: nodeGraph.nodes.map((node) => sanitizeModelNodeResultAreaSlots(node)),
});

export const sanitizeNodeGraphResultAreaItemsForPersistence = (
  nodeGraph: NodeGraph,
  _mediaAssets: ProjectMediaAssets = {},
): NodeGraph => ({
  ...nodeGraph,
  nodes: nodeGraph.nodes.map((node) => sanitizeModelNodeResultAreaSlots(node)),
});
