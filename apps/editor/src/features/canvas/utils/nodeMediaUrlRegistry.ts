import type {
  AssetNodeData,
  AudioInputNodeData,
  GraphNode,
  GraphNodeType,
  ImageInputNodeData,
  ModelNodeData,
  VideoInputNodeData,
} from '../types/node';

import { useCanvasStore } from '../store';
import { resolveMediaSlotValue } from '../services/resultAreaMediaSlots';

export type NodeMediaUrlExtractor = (node: GraphNode) => string | null;

class NodeMediaUrlExtractorRegistry {
  private extractors = new Map<GraphNodeType, NodeMediaUrlExtractor>();

  register(nodeType: GraphNodeType, extractor: NodeMediaUrlExtractor) {
    this.extractors.set(nodeType, extractor);
  }

  getUrl(node: GraphNode): string | null {
    const extractor = this.extractors.get(node.type);
    if (!extractor) return null;
    return extractor(node);
  }
}

export const nodeMediaUrlExtractorRegistry = new NodeMediaUrlExtractorRegistry();

nodeMediaUrlExtractorRegistry.register('imageInput', (node) => {
  const data = node.data as ImageInputNodeData | undefined;
  const imageUrl = data !== undefined ? data.imageUrl : undefined;
  const url = typeof imageUrl === 'string' ? imageUrl.trim() : '';
  return url || null;
});

nodeMediaUrlExtractorRegistry.register('videoInput', (node) => {
  const data = node.data as VideoInputNodeData | undefined;
  const videoUrl = data !== undefined ? data.videoUrl : undefined;
  const url = typeof videoUrl === 'string' ? videoUrl.trim() : '';
  return url || null;
});

nodeMediaUrlExtractorRegistry.register('audioInput', (node) => {
  const data = node.data as AudioInputNodeData | undefined;
  const audioUrl = data !== undefined ? data.audioUrl : undefined;
  const url = typeof audioUrl === 'string' ? audioUrl.trim() : '';
  return url || null;
});

nodeMediaUrlExtractorRegistry.register('asset', (node) => {
  // 资产节点（图片/视频/音频）不在 data 上存 URL，只有 assetId；
  // 媒体地址的事实源是 store 的 mediaAssets[assetId].original.url
  const data = node.data as AssetNodeData | undefined;
  const assetId = data !== null && data !== undefined ? data.assetId : undefined;
  if (assetId === null || assetId === undefined || assetId === '') return null;
  const mediaAssets = useCanvasStore.getState().mediaAssets;
  if (mediaAssets === null || mediaAssets === undefined) return null;
  const mediaAsset = mediaAssets[assetId];
  const url = mediaAsset !== null && mediaAsset !== undefined ? mediaAsset.original?.url : undefined;
  if (typeof url !== 'string' || url.trim() === '') return null;
  return url.trim();
});

nodeMediaUrlExtractorRegistry.register('model', (node) => {
  const data = node.data as ModelNodeData | undefined;
  if (data === null || data === undefined) return null;
  const resultArea = data.resultArea;
  if (resultArea === null || resultArea === undefined) return null;
  const slots = resultArea.slots;
  if (slots === null || slots === undefined) return null;
  const mediaAssets = useCanvasStore.getState().mediaAssets;
  if (mediaAssets === null || mediaAssets === undefined) return null;
  // 复用统一的 slot→值解析器（resolveMediaSlotValue），避免与引擎层消费路径
  // 与旧 DataResolver 形成重复的 slot.assetId→url 实现已随结果区退役删除。
  // reveal 语义是"取节点任意一个可揭示的 media slot 展示地址"，遍历取第一个非空值。
  for (const slot of slots) {
    if (slot.itemType !== 'media') continue;
    const value = resolveMediaSlotValue(slot, mediaAssets);
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
});

export const getNodeMediaUrlForReveal = (node: GraphNode): string | null => {
  return nodeMediaUrlExtractorRegistry.getUrl(node);
};
