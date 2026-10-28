import type { MediaAsset, ProjectMediaAssets } from '@iart/contracts';

import type { GraphNode, GraphNodeType } from '../../types/node';
import type { AudioInputNodeData, ImageInputNodeData, VideoInputNodeData } from '../../types/nodeDataTypes';
import type { AssetNodeData } from '../../types/taskNode';

/**
 * 媒体节点主体投影（选中态 chrome 的单一事实源）。
 *
 * 画布上承载媒体的节点有两个家族：导入素材节点（imageInput/videoInput/audioInput）与
 * 生成/加工产出的资产节点（asset）。两者在数据层不同（素材节点自持 URL、可替换；资产节点
 * 只持 assetId、不可变），但**在 chrome 里的行为主体是同一件事**：一份可访问的媒体资产。
 *
 * 设计层 D27 把两者放进同一套双层 chrome，差异只按来源分档（复用仅生成资产、替换仅本地
 * 导入）。本投影把「节点家族」「媒体类型」「资产身份」「来源」收敛成一个对象，供选区判定、
 * 工具清单、底栏动作与工具执行器共用，避免各处按节点类型分支。
 */

export type MediaNodeFamily = 'asset' | 'imageInput' | 'videoInput' | 'audioInput';

export type ChromeMediaType = 'image' | 'video' | 'audio';

export type MediaNodeOrigin = 'generated' | 'imported';

export type ChromeSubject = {
  /** 持有媒体的画布节点 */
  node: GraphNode;
  family: MediaNodeFamily;
  mediaType: ChromeMediaType;
  /** 资产身份 id：素材节点在历史路径（如角色坞）可能缺失 */
  assetId: string | null;
  /** 呈现标签（参考区反馈、复用提示用；仅呈现，不参与提交） */
  label: string;
  /** 来源分档：生成/加工产出（asset）或本地导入（*Input） */
  origin: MediaNodeOrigin;
  /** 生成来源（仅 asset 可能有；加工产出为空串 → 不呈现复用） */
  sourceModelId: string;
  sourceTaskId: string;
  /** 注册表条目（可访问性判定与加工源地址） */
  mediaAsset: MediaAsset | null;
  /** 加工源地址：注册表 original.url 优先，素材节点回落节点自持 URL */
  sourceUrl: string;
  /**
   * 资产身份可访问：有 assetId、注册表有条目且有原文件地址。
   * 不可访问的主体不呈现顶栏（spec 媒体工具加工.md「工具入口的可用性与资产存在性对齐」）。
   */
  available: boolean;
};

const MEDIA_NODE_TYPES: ReadonlySet<GraphNodeType> = new Set<GraphNodeType>([
  'asset',
  'imageInput',
  'videoInput',
  'audioInput',
]);

export const isMediaNodeType = (type: GraphNodeType): type is MediaNodeFamily =>
  MEDIA_NODE_TYPES.has(type);

const readString = (value: unknown): string => (typeof value === 'string' ? value : '');

const readNodeMediaUrl = (node: GraphNode): string => {
  const data = node.data as { imageUrl?: unknown; videoUrl?: unknown; audioUrl?: unknown };
  return (
    readString(data.imageUrl).trim() ||
    readString(data.videoUrl).trim() ||
    readString(data.audioUrl).trim()
  );
};

const DEFAULT_FAMILY_LABEL: Record<MediaNodeFamily, string> = {
  asset: '资产',
  imageInput: '图片素材',
  videoInput: '视频素材',
  audioInput: '音频素材',
};

const resolveAssetPart = (
  mediaAssets: ProjectMediaAssets,
  assetId: string | null,
): { mediaAsset: MediaAsset | null; registeredUrl: string } => {
  if (assetId === null) return { mediaAsset: null, registeredUrl: '' };
  const mediaAsset = mediaAssets[assetId] ?? null;
  return { mediaAsset, registeredUrl: readString(mediaAsset?.original?.url).trim() };
};

/**
 * 画布节点 → chrome 媒体主体。非媒体节点（task/agent/text/group）返回 null。
 */
export const resolveChromeSubject = (
  node: GraphNode,
  mediaAssets: ProjectMediaAssets,
): ChromeSubject | null => {
  if (!isMediaNodeType(node.type)) return null;

  if (node.type === 'asset') {
    const data = node.data as AssetNodeData;
    const assetId = readString(data.assetId) || null;
    const { mediaAsset, registeredUrl } = resolveAssetPart(mediaAssets, assetId);
    return {
      node,
      family: 'asset',
      mediaType: data.mediaType,
      assetId,
      label: readString(data.label) || DEFAULT_FAMILY_LABEL.asset,
      origin: 'generated',
      sourceModelId: readString(data.sourceModelId),
      sourceTaskId: readString(data.sourceTaskId),
      mediaAsset,
      sourceUrl: registeredUrl,
      available: registeredUrl !== '',
    };
  }

  const data =
    node.type === 'imageInput'
      ? (node.data as ImageInputNodeData)
      : node.type === 'videoInput'
        ? (node.data as VideoInputNodeData)
        : (node.data as AudioInputNodeData);
  const assetId = readString((data as { assetId?: unknown }).assetId) || null;
  const { mediaAsset, registeredUrl } = resolveAssetPart(mediaAssets, assetId);
  const mediaType: ChromeMediaType =
    node.type === 'imageInput' ? 'image' : node.type === 'videoInput' ? 'video' : 'audio';
  return {
    node,
    family: node.type,
    mediaType,
    assetId,
    label: readString(data.label) || DEFAULT_FAMILY_LABEL[node.type],
    origin: 'imported',
    sourceModelId: '',
    sourceTaskId: '',
    mediaAsset,
    sourceUrl: registeredUrl || readNodeMediaUrl(node),
    available: registeredUrl !== '',
  };
};
