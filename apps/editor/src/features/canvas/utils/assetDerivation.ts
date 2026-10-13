import type { MediaAsset } from '@iart/contracts';
import { useCanvasStore } from '../store/canvasStore';
import { computeDerivedNodePosition } from './derivedNodePlacement';
import { isGroupMember } from '../services/groupMembership';
import type { GraphNode, AssetNodeData } from '../types';

/**
 * 资产节点加工产出（spec：docs/editor/媒体工具加工.md「产出与非破坏」）。
 *
 * 资产节点选中态工具栏（设计层 node-chrome D19）触发的确定性加工，产出以
 * **独立资产节点**承载（区别于素材节点入口的历史派生 imageInput），源资产与源节点
 * 不变；加工血缘（源资产引用 + 工具标识）写入产出资产节点的 derivedFrom（payload =
 * 资产 metadata 的画布投影），不进入画布关系。
 */

export type CreateDerivedAssetNodeParams = {
  /** 源资产节点 id */
  sourceNodeId: string;
  /** 加工产出的资产 id（必须已注册进 mediaAssets 或随 mediaAsset 提供） */
  assetId: string;
  mediaAsset: MediaAsset | null | undefined;
  mediaType: AssetNodeData['mediaType'];
  /** 血缘：源资产 id + 工具注册 id */
  derivedFrom: { sourceAssetId: string; tool: string };
  /** 展示标签（缺省回落工具 id） */
  label?: string | undefined;
  selectNodes?: ((nodeIds: string[], reason: string) => void) | undefined;
};

export const createDerivedAssetNode = (
  params: CreateDerivedAssetNodeParams,
): GraphNode<AssetNodeData> | null => {
  const { nodeGraph, addNode, setProjectMediaAssets } = useCanvasStore.getState();
  if (!nodeGraph) return null;
  if (!params.assetId) return null;

  const sourceNode = nodeGraph.nodes.find((node) => node.id === params.sourceNodeId);
  if (!sourceNode) {
    console.debug('[assetDerivation] source node not found, skip derive', {
      sourceNodeId: params.sourceNodeId,
    });
    return null;
  }

  const mediaAsset = params.mediaAsset ?? null;
  if (mediaAsset !== null && mediaAsset.id) {
    setProjectMediaAssets(
      { [mediaAsset.id]: mediaAsset },
      { source: 'user-action' },
    );
  }

  const position = computeDerivedNodePosition(sourceNode, nodeGraph.nodes, undefined);
  const data: AssetNodeData = {
    label: params.label ?? params.derivedFrom.tool,
    sourceBatchId: '',
    sourceTaskId: '',
    sourceModelId: '',
    mediaType: params.mediaType,
    assetId: params.assetId,
    derivedFrom: {
      sourceAssetId: params.derivedFrom.sourceAssetId,
      tool: params.derivedFrom.tool,
    },
    outpaintTaskId: undefined,
  };
  // 成员节点创建落布的系统默认初值（组 spec「成员节点创建落布时自动建立为默认初值」）：
  // 源在容器内 → 派生品入同组；源无组 → 不传 membership，自由落布。
  // 目标非法时由 addNode 的 membership 通道降级为自由节点并留痕，不裸写 groupId。
  const membership =
    isGroupMember(sourceNode) && sourceNode.groupId !== undefined
      ? { groupId: sourceNode.groupId }
      : undefined;
  const newNode = addNode('asset', position, data, membership);
  if (!newNode) return null;

  params.selectNodes?.([newNode.id], 'asset-derivation');
  return newNode as GraphNode<AssetNodeData>;
};

/** 扩图（异步 AI 加工）提交时记录任务引用；成功投影由 taskProjectionService 回填。 */
export const bindOutpaintTaskToAssetNode = (nodeId: string, taskId: string): void => {
  useCanvasStore.getState().updateNodeData(
    nodeId,
    { outpaintTaskId: taskId } satisfies Partial<AssetNodeData>,
    'asset-outpaint',
  );
};

/**
 * 扩图成功回填：把产出资产注册进 mediaAssets 并把持有该扩图任务的资产节点
 * assetId 换成结果资产、清除 outpaintTaskId。
 * 由 taskProjectionService 在匹配到 outpaintTaskId 的成功终态时调用。
 */
export const applyOutpaintResultToAssetNode = (params: {
  nodeId: string;
  resultAssetId: string;
  mediaAsset: MediaAsset | null | undefined;
}): void => {
  const state = useCanvasStore.getState();
  if (params.mediaAsset !== null && params.mediaAsset !== undefined && params.mediaAsset.id) {
    state.setProjectMediaAssets(
      { [params.mediaAsset.id]: params.mediaAsset },
      { source: 'backend-notification' },
    );
  }
  state.updateNodeData(
    params.nodeId,
    {
      assetId: params.resultAssetId,
      outpaintTaskId: undefined,
    } satisfies Partial<AssetNodeData>,
    'asset-outpaint-result',
  );
};
