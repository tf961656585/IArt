import type { MediaAsset, ProjectMediaAssets } from "@iart/contracts";

import type { GraphNode, ModelNodeData, NodeGraph, ResultAreaFormalSlot } from "../types";
import { normalizeString } from "./projectMediaAssetUtils";
import { normalizeProjectMediaAssets } from "./projectMediaAssetRecords";

const getModelResultAreaSlots = (node: GraphNode): ResultAreaFormalSlot[] => {
  if (node.type !== "model") return [];
  const data = node.data as ModelNodeData | undefined;
  const resultArea =
    data !== null && data !== undefined ? data.resultArea : undefined;
  const slots =
    resultArea !== null && resultArea !== undefined ? resultArea.slots : undefined;
  if (!Array.isArray(slots)) return [];
  return slots;
};

const stripImportedMediaAssetThumbnail = (asset: MediaAsset): MediaAsset => {
  const now = Date.now();
  return {
    ...asset,
    thumbnail: {
      url: null,
      mimeType: null,
      width: null,
      height: null,
      status: "missing",
      generatedAt: null,
      error: null,
    },
    lifecycle: {
      createdAt: (asset.lifecycle !== null && asset.lifecycle !== undefined ? asset.lifecycle.createdAt : undefined) ?? now,
      updatedAt: (asset.lifecycle !== null && asset.lifecycle !== undefined ? asset.lifecycle.updatedAt : undefined) ?? now,
    },
  };
};

const areImportedMediaAssetsEquivalent = (
  left: MediaAsset | undefined,
  right: MediaAsset | undefined,
): boolean => {
  if (!left || !right) return false;
  return (
    left.mediaType === right.mediaType &&
    JSON.stringify(left.original) === JSON.stringify(right.original)
  );
};

const remapNodeGraphResultAreaAssetIds = (
  nodeGraph: NodeGraph,
  assetIdMap: Map<string, string>,
): NodeGraph => {
  if (assetIdMap.size === 0) return nodeGraph;
  return {
    ...nodeGraph,
    nodes: nodeGraph.nodes.map((node) => {
      if (node.type !== "model") return node;
      const modelData = node.data as ModelNodeData;
      const items = getModelResultAreaSlots(node);
      const needsRemap = items.some((item) => {
        const assetId = normalizeString(item.assetId);
        return assetId !== null && assetIdMap.has(assetId);
      });
      if (!needsRemap) return node;
      const nextSlots = items.map((item) => {
        const assetId = normalizeString(item.assetId);
        if (!assetId || !assetIdMap.has(assetId)) return item;
        return {
          ...item,
          assetId: assetIdMap.get(assetId) ?? assetId,
        };
      });
      return {
        ...node,
        data: {
          ...modelData,
          resultArea: {
            ...modelData.resultArea,
            slots: nextSlots,
          },
        },
      } as GraphNode;
    }),
  };
};

export const applyImportedAssetIdMapToNodeGraph = (
  nodeGraph: NodeGraph,
  assetIdMap: Record<string, string>,
): NodeGraph =>
  remapNodeGraphResultAreaAssetIds(
    nodeGraph,
    new Map(Object.entries(assetIdMap ?? {})),
  );

export const remapImportedProjectMediaAssets = (params: {
  nodeGraph: NodeGraph;
  mediaAssets: ProjectMediaAssets;
  existingMediaAssets: ProjectMediaAssets;
}): { nodeGraph: NodeGraph; mediaAssets: ProjectMediaAssets } => {
  const importedAssets = normalizeProjectMediaAssets(params.mediaAssets);
  const existingAssets = normalizeProjectMediaAssets(
    params.existingMediaAssets,
  );
  const takenIds = new Set(Object.keys(existingAssets));
  const assetIdMap = new Map<string, string>();
  const nextMediaAssets: ProjectMediaAssets = {};

  for (const [assetId, asset] of Object.entries(importedAssets)) {
    const sanitizedImportedAsset = stripImportedMediaAssetThumbnail(asset);
    const existing = existingAssets[assetId];
    if (
      !existing ||
      areImportedMediaAssetsEquivalent(existing, sanitizedImportedAsset)
    ) {
      nextMediaAssets[assetId] = sanitizedImportedAsset;
      takenIds.add(assetId);
      continue;
    }

    let suffix = 1;
    let nextAssetId = `${assetId}__import_${suffix}`;
    while (takenIds.has(nextAssetId)) {
      suffix += 1;
      nextAssetId = `${assetId}__import_${suffix}`;
    }
    takenIds.add(nextAssetId);
    assetIdMap.set(assetId, nextAssetId);
    nextMediaAssets[nextAssetId] = {
      ...sanitizedImportedAsset,
      id: nextAssetId,
    };
  }

  return {
    nodeGraph: remapNodeGraphResultAreaAssetIds(params.nodeGraph, assetIdMap),
    mediaAssets: nextMediaAssets,
  };
};
