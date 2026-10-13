import type { MediaAsset } from '@iart/contracts';
import { useCanvasStore } from '../store/canvasStore';
import { computeDerivedNodePosition } from './derivedNodePlacement';
import type { GraphNode, VideoDerivedOp, VideoMeta } from '../types';

type CreateDerivedVideoInputNodeSelectionArg =
  | {
      selectNodes: (nodeIds: string[], reason: string) => void;
    }
  | {
      selectNodes: undefined;
    }
  | Record<never, never>;

export type CreateDerivedVideoInputNodeParams = {
  sourceNodeId: string;
  resultUrl: string;
  assetId: string;
  mediaAsset: MediaAsset | null | undefined;
  derivedOp: VideoDerivedOp;
  videoMeta: VideoMeta | null | undefined;
} & CreateDerivedVideoInputNodeSelectionArg;

/**
 * 创建视频加工产出的派生 videoInput 素材节点（与 createDerivedImageInputNode 对称）。
 * 素材节点不持有输入端口（spec docs/runtime/已退场对象与术语.md）：派生内容直接落为节点自持内容，
 * 血缘由 derivedFromNodeId / derivedOp 承载，不创建 source -> 素材节点连线。
 */
export const createDerivedVideoInputNode = (
  params: CreateDerivedVideoInputNodeParams
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
  const newNode = addNode('videoInput', position, {
    videoUrl: resultUrl,
    assetId: params.assetId,
    valueSource: 'processed',
    derivedFromNodeId: sourceNodeId,
    derivedOp,
    videoMeta: params.videoMeta ?? null,
  });

  if (!newNode) return null;

  if (selectNodes) {
    selectNodes([newNode.id], "video-derivation");
  }

  return newNode;
};
