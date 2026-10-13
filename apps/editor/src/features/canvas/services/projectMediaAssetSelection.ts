import type { ProjectMediaAssets } from "@iart/contracts";

import type { ModelNodeData, NodeGraph, ResultAreaFormalSlot } from "../types";
import { normalizeString } from "./projectMediaAssetUtils";
import { normalizeProjectMediaAssets } from "./projectMediaAssetRecords";

const getModelResultAreaSlots = (
  nodeGraphNode: NodeGraph["nodes"][number],
): ResultAreaFormalSlot[] => {
  if (nodeGraphNode.type !== "model") return [];
  const data = nodeGraphNode.data as ModelNodeData | undefined;
  const resultArea =
    data !== null && data !== undefined ? data.resultArea : undefined;
  const slots =
    resultArea !== null && resultArea !== undefined ? resultArea.slots : undefined;
  if (!Array.isArray(slots)) return [];
  return slots;
};

export const collectReferencedProjectMediaAssetIds = (
  nodeGraph: NodeGraph,
): string[] => {
  const ids = new Set<string>();
  const nodes = Array.isArray((nodeGraph !== null && nodeGraph !== undefined ? nodeGraph.nodes : undefined)) ? nodeGraph.nodes : [];
  for (const node of nodes) {
    if ((node !== null && node !== undefined ? node.type : undefined) !== "model") continue;
    const items = getModelResultAreaSlots(node);
    for (const item of items) {
      const assetId = normalizeString((item !== null && item !== undefined ? item.assetId : undefined));
      if (!assetId) continue;
      ids.add(assetId);
    }
  }
  return Array.from(ids);
};

export const pickProjectMediaAssetsForNodeGraph = (
  nodeGraph: NodeGraph,
  _mediaAssets: ProjectMediaAssets,
): ProjectMediaAssets => {
  const normalizedAssets = normalizeProjectMediaAssets(_mediaAssets);
  const referencedIds = collectReferencedProjectMediaAssetIds(nodeGraph);
  if (referencedIds.length === 0) return {};

  const picked: ProjectMediaAssets = {};
  for (const assetId of referencedIds) {
    const asset = normalizedAssets[assetId];
    if (!asset) continue;
    picked[assetId] = asset;
  }
  return picked;
};

export const findMissingReferencedProjectMediaAssetIds = (
  nodeGraph: NodeGraph,
  _mediaAssets: ProjectMediaAssets,
): string[] => {
  const normalizedAssets = normalizeProjectMediaAssets(_mediaAssets);
  return collectReferencedProjectMediaAssetIds(nodeGraph).filter(
    (assetId) => !normalizedAssets[assetId],
  );
};
