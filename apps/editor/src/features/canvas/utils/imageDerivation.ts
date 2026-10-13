import type { MediaAsset } from '@iart/contracts';
import { markNodeDirty, useCanvasStore } from '../store/canvasStore';
import { nodeRegistry } from '../nodes/registry';
import { trackCurrentProjectNodeTypeUsage } from '../storage';
import {
  computeDerivedNodePosition,
  DERIVED_NODE_HEIGHT_ESTIMATE,
  DERIVED_NODE_OFFSET_X,
  DERIVED_NODE_WIDTH_ESTIMATE,
  isOverlapping,
} from './derivedNodePlacement';
import type { GraphNode, ImageDerivedOp } from '../types';

type CreateDerivedImageInputNodeSelectionArg =
  | {
      selectNodes: (nodeIds: string[], reason: string) => void;
    }
	  | {
	      selectNodes: undefined;
	    }
	  | Record<never, never>;

type CreateDerivedImageInputNodesGridSelectionArg =
  | {
      selectNodes: (nodeIds: string[], reason: string) => void;
    }
	  | {
	      selectNodes: undefined;
	    }
	  | Record<never, never>;

export type CreateDerivedImageInputNodeParams = {
  sourceNodeId: string;
  resultUrl: string;
  assetId: string;
  mediaAsset: MediaAsset | null | undefined;
  derivedOp: ImageDerivedOp;
} & CreateDerivedImageInputNodeSelectionArg;

export type CreateDerivedImageInputNodesGridParams = {
  sourceNodeId: string;
  rows: number;
  cols: number;
  horizontalPercents: number[];
  verticalPercents: number[];
  tiles: Array<{
    index: number;
    row: number;
    col: number;
    assetId: string;
    mediaAsset: MediaAsset | null | undefined;
    url: string;
    width: number;
    height: number;
  }>;
} & CreateDerivedImageInputNodesGridSelectionArg;

const GRID_GAP_X = 40;
const GRID_GAP_Y = 40;

export const createDerivedImageInputNode = (
  params: CreateDerivedImageInputNodeParams
): GraphNode | null => {
  const { sourceNodeId, resultUrl, derivedOp } = params;
  const selectNodes =
    "selectNodes" in params ? params.selectNodes : undefined;
  const { nodeGraph, addNode, setProjectMediaAssets } =
    useCanvasStore.getState();
  if (!nodeGraph) return null;

  const sourceNode = nodeGraph.nodes.find((node) => node.id === sourceNodeId);
  if (!sourceNode) return null;
  if (!params.assetId) return null;
  const mediaAsset = params.mediaAsset ?? null;
  if (mediaAsset !== null && mediaAsset !== undefined && mediaAsset.id) {
    setProjectMediaAssets({
      [mediaAsset.id]: mediaAsset,
    }, { source: 'user-action' });
  }

  const position = computeDerivedNodePosition(sourceNode, nodeGraph.nodes, undefined);
  // 素材节点不持有输入端口（spec docs/runtime/已退场对象与术语.md）：衍生内容直接落为节点自持内容，
  // 血缘由 derivedFromNodeId 承载，不创建 source -> 素材节点连线。
  const newNode = addNode('imageInput', position, {
    imageUrl: resultUrl,
    assetId: params.assetId,
    valueSource: 'processed',
    derivedFromNodeId: sourceNodeId,
    derivedOp,
    imageMeta: null,
    originalImageMeta: null,
    resizePercent: 100,
  });

  if (!newNode) return null;

  if (selectNodes) {
    selectNodes([newNode.id], "image-derivation");
  }

  return newNode;
};

export const createDerivedImageInputNodesGrid = (
  params: CreateDerivedImageInputNodesGridParams
): GraphNode[] | null => {
  const { sourceNodeId, rows, cols, horizontalPercents, verticalPercents, tiles } = params;
  const selectNodes =
    "selectNodes" in params ? params.selectNodes : undefined;
  const { nodeGraph, saveToHistory, setProjectMediaAssets } = useCanvasStore.getState();
  if (!nodeGraph) return null;

  const sourceNode = nodeGraph.nodes.find((node) => node.id === sourceNodeId);
  if (!sourceNode) return null;
  if (tiles.some((tile) => !tile.assetId)) return null;

  const mediaAssetsPatch: Record<string, MediaAsset> = {};
  for (const tile of tiles) {
    const mediaAsset = tile.mediaAsset ?? null;
    if (mediaAsset !== null && mediaAsset !== undefined && mediaAsset.id) {
      mediaAssetsPatch[mediaAsset.id] = mediaAsset;
    }
  }
  if (Object.keys(mediaAssetsPatch).length > 0) {
    setProjectMediaAssets(mediaAssetsPatch, { source: 'user-action' });
  }

  const baseX = ((sourceNode.position !== null && sourceNode.position !== undefined ? sourceNode.position.x : undefined) ?? 0) + DERIVED_NODE_OFFSET_X;
  const baseY = (sourceNode.position !== null && sourceNode.position !== undefined ? sourceNode.position.y : undefined) ?? 0;

  const colStep = DERIVED_NODE_WIDTH_ESTIMATE + GRID_GAP_X;
  const rowStep = DERIVED_NODE_HEIGHT_ESTIMATE + GRID_GAP_Y;

  const createdNodes: GraphNode[] = [];

  for (const tile of tiles) {
    const desiredX = baseX + tile.col * colStep;
    const desiredY = baseY + tile.row * rowStep;

    let y = desiredY;
    while (isOverlapping([...nodeGraph.nodes, ...createdNodes], desiredX, y, undefined)) {
      y += DERIVED_NODE_HEIGHT_ESTIMATE;
    }

    const width = Number(tile.width) || 0;
    const height = Number(tile.height) || 0;
    const aspectRatio = width > 0 && height > 0 ? Number((width / height).toFixed(6)) : 1;

    // 素材节点不持有输入端口（spec docs/runtime/已退场对象与术语.md）：图块内容直接落为节点自持内容，不创建连线
    const node = nodeRegistry.createNode('imageInput', { x: desiredX, y }, {
      label: `图块 ${tile.row + 1}-${tile.col + 1}`,
      imageUrl: tile.url,
      assetId: tile.assetId,
      valueSource: 'processed',
      derivedFromNodeId: sourceNodeId,
      derivedOp: {
        type: 'split',
        rows,
        cols,
        horizontalPercents,
        verticalPercents,
        tile: { row: tile.row, col: tile.col, index: tile.index },
      } satisfies ImageDerivedOp,
      imageMeta: width && height ? { width, height, aspectRatio } : null,
      originalImageMeta: null,
      resizePercent: 100,
    });

    if (!node) continue;

    createdNodes.push(node);
  }

  if (createdNodes.length === 0) return null;

  useCanvasStore.setState((state) => {
    if (!state.nodeGraph) return;
    state.nodeGraph.nodes.push(...createdNodes);
    if (state.nodeGraph.meta) {
      state.nodeGraph.meta.updatedAt = new Date().toISOString();
    }
    for (const node of createdNodes) {
      markNodeDirty(state, node.id);
    }
    state.structureRevision += 1;
  });

  saveToHistory();
  if (selectNodes) {
    selectNodes(
      createdNodes.map((node) => node.id),
      "image-derivation",
    );
  }
  void trackCurrentProjectNodeTypeUsage(['imageInput']);

  return createdNodes;
};

export type SmartSplitTile = {
  index: number;
  assetId: string;
  mediaAsset: MediaAsset | null | undefined;
  url: string;
  width: number;
  height: number;
  x: number;
  y: number;
};

export type CreateDerivedImageInputNodesFromSmartSplitParams = {
  sourceNodeId: string;
  alphaThreshold: number;
  minArea: number;
  dilateIterations: number;
  padding: number;
  tiles: SmartSplitTile[];
} & CreateDerivedImageInputNodesGridSelectionArg;

export const createDerivedImageInputNodesFromSmartSplit = (
  params: CreateDerivedImageInputNodesFromSmartSplitParams,
): GraphNode[] | null => {
  const { sourceNodeId, alphaThreshold, minArea, dilateIterations, padding, tiles } = params;
  const selectNodes =
    "selectNodes" in params ? params.selectNodes : undefined;
  const { nodeGraph, saveToHistory, setProjectMediaAssets } = useCanvasStore.getState();
  if (!nodeGraph) return null;

  const sourceNode = nodeGraph.nodes.find((node) => node.id === sourceNodeId);
  if (!sourceNode) return null;
  if (tiles.some((tile) => !tile.assetId)) return null;

  const mediaAssetsPatch: Record<string, MediaAsset> = {};
  for (const tile of tiles) {
    const mediaAsset = tile.mediaAsset ?? null;
    if (mediaAsset !== null && mediaAsset !== undefined && mediaAsset.id) {
      mediaAssetsPatch[mediaAsset.id] = mediaAsset;
    }
  }
  if (Object.keys(mediaAssetsPatch).length > 0) {
    setProjectMediaAssets(mediaAssetsPatch, { source: 'user-action' });
  }

  const baseX = ((sourceNode.position !== null && sourceNode.position !== undefined ? sourceNode.position.x : undefined) ?? 0) + DERIVED_NODE_OFFSET_X;
  const baseY = (sourceNode.position !== null && sourceNode.position !== undefined ? sourceNode.position.y : undefined) ?? 0;

  const createdNodes: GraphNode[] = [];

  for (let i = 0; i < tiles.length; i += 1) {
    const tile = tiles[i];
    if (!tile) continue;
    const desiredX = baseX;
    const desiredY = baseY + i * (DERIVED_NODE_HEIGHT_ESTIMATE + GRID_GAP_Y);

    let y = desiredY;
    while (isOverlapping([...nodeGraph.nodes, ...createdNodes], desiredX, y, undefined)) {
      y += DERIVED_NODE_HEIGHT_ESTIMATE;
    }

    const width = Number(tile.width) || 0;
    const height = Number(tile.height) || 0;
    const aspectRatio = width > 0 && height > 0 ? Number((width / height).toFixed(6)) : 1;

    // 素材节点不持有输入端口（spec docs/runtime/已退场对象与术语.md）：元素内容直接落为节点自持内容，不创建连线
    const node = nodeRegistry.createNode('imageInput', { x: desiredX, y }, {
      label: `元素 ${i + 1}`,
      imageUrl: tile.url,
      assetId: tile.assetId,
      valueSource: 'processed',
      derivedFromNodeId: sourceNodeId,
      derivedOp: {
        type: 'smartSplit',
        alphaThreshold,
        minArea,
        dilateIterations,
        padding,
        tile: { index: tile.index, x: tile.x, y: tile.y, width: tile.width, height: tile.height },
      } satisfies ImageDerivedOp,
      imageMeta: width > 0 && height > 0 ? { width, height, aspectRatio } : null,
      originalImageMeta: null,
      resizePercent: 100,
    });

    if (node === null) continue;

    createdNodes.push(node);
  }

  if (createdNodes.length === 0) return null;

  useCanvasStore.setState((state) => {
    if (state.nodeGraph === null) return;
    state.nodeGraph.nodes.push(...createdNodes);
    if (state.nodeGraph.meta) {
      state.nodeGraph.meta.updatedAt = new Date().toISOString();
    }
    for (const node of createdNodes) {
      markNodeDirty(state, node.id);
    }
    state.structureRevision += 1;
  });

  saveToHistory();
  if (selectNodes) {
    selectNodes(
      createdNodes.map((node) => node.id),
      "image-derivation",
    );
  }
  void trackCurrentProjectNodeTypeUsage(['imageInput']);

  return createdNodes;
};
