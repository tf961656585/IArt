import { toast } from 'sonner';
import type { ProjectMediaAssets } from '@iart/contracts';

import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import type { GraphNode } from '@/features/canvas/types/node';
import type { AssetNodeData } from '@/features/canvas/types/taskNode';
import { resolveMediaAssetForThumbnail } from '@/features/canvas/services/mediaThumbnailResolver';
import { usePackageAreaStore } from './store/packageAreaStore';

/**
 * 打包区共享操作层（单一事实源）。
 *
 * 「添加到打包区」的候选判定、去重与反馈（spec：docs/editor/右侧工作区与打包区服务.md）
 * 在此收口，供两处消费：
 * - 画布对象右键菜单（资产/素材节点，单选与多选变体）；
 * - 媒体节点选中态管理栏（MediaNodeChrome 底栏）。
 *
 * 媒体边界：图片、视频、音频三类媒体资产均可加入打包区（打包带走的目标就是全部媒体类型）。
 * 同一画布内同一资产在打包区只保留一个条目；重复加入反馈「已在打包区」，不静默重复。
 */

export type PackageAreaMediaType = 'image' | 'video' | 'audio';

export type PackageAreaCandidate =
  | { ok: true; assetId: string; mediaType: PackageAreaMediaType; label: string }
  | { ok: false; reason: string };

/** 从画布节点解析打包区候选（资产访问性与类型判定；不可访问/已删除资产给出可定位原因）。 */
export const resolvePackageAreaCandidate = (
  node: GraphNode,
  mediaAssets: ProjectMediaAssets,
): PackageAreaCandidate => {
  if (node.type === 'asset') {
    const data = node.data as AssetNodeData;
    const asset = mediaAssets[data.assetId];
    if (!asset || !(asset.original?.url ?? '')) {
      return { ok: false, reason: '素材已被删除，无法加入打包区' };
    }
    return { ok: true, assetId: data.assetId, mediaType: data.mediaType, label: data.label };
  }
  // 素材节点（imageInput/videoInput/audioInput）：与资产节点同口径可打包。
  const mediaType =
    node.type === 'imageInput' ? 'image'
      : node.type === 'videoInput' ? 'video'
        : node.type === 'audioInput' ? 'audio'
          : null;
  if (!mediaType) {
    return { ok: false, reason: '这个对象不是图片、视频或音频，无法加入打包区' };
  }
  const directAssetId = (node.data as { assetId?: unknown }).assetId;
  if (typeof directAssetId === 'string' && directAssetId && directAssetId in mediaAssets) {
    const label = (node.data as { label?: unknown }).label;
    return {
      ok: true,
      assetId: directAssetId,
      mediaType,
      label: typeof label === 'string' && label ? label : directAssetId,
    };
  }
  // 历史音频节点兜底：用 audioUrl 反查 media_assets（与导入链历史节点回填同口径）。
  if (node.type === 'audioInput') {
    const audioUrl = (node.data as { audioUrl?: unknown }).audioUrl;
    if (typeof audioUrl === 'string' && audioUrl) {
      const resolved = resolveMediaAssetForThumbnail({
        mediaAssets,
        mediaType: 'audio',
        assetId: undefined,
        sourceUrl: audioUrl,
        projectRef: undefined,
        fileKey: undefined,
      });
      if (resolved.assetId !== null && resolved.assetId !== undefined) {
        return { ok: true, assetId: resolved.assetId, mediaType: 'audio', label: resolved.assetId };
      }
    }
  }
  return { ok: false, reason: '素材已被删除，无法加入打包区' };
};

/** 从节点数据尽力读取显示标签（拒绝反馈定位用）。 */
const nodeLabel = (node: GraphNode): string => {
  const label = (node.data as { label?: unknown }).label;
  return typeof label === 'string' && label ? label : node.id;
};

export type AddToPackageAreaOutcome = {
  /** 实际新增的 assetId */
  added: string[];
  /** 已存在于打包区（未重复添加）的 assetId */
  alreadyInArea: string[];
  /** 不可加入项及可定位原因 */
  rejected: { label: string; reason: string }[];
};

/**
 * store 接线：把一批画布节点加入当前画布打包区（去重 + 反馈）。
 * 供画布右键菜单与 MediaNodeChrome 底栏共用。
 */
export const addNodesToPackageArea = async (
  nodes: GraphNode[],
  opts: { withFeedback?: boolean } = {},
): Promise<AddToPackageAreaOutcome> => {
  const withFeedback = opts.withFeedback ?? true;
  const graph = useCanvasStore.getState().nodeGraph;
  const mediaAssets = useCanvasStore.getState().mediaAssets;
  const graphId = graph ? graph.id : null;

  const outcome: AddToPackageAreaOutcome = { added: [], alreadyInArea: [], rejected: [] };
  if (graphId === null) {
    if (withFeedback) toast.error('画布还没准备好，请稍后再试');
    return outcome;
  }

  const store = usePackageAreaStore.getState();
  // 打包区未加载时先加载（如刚通过右键操作而面板从未打开）。
  let currentArea = store.packageArea;
  if (currentArea === null) {
    await store.loadPackageArea(graphId);
    currentArea = usePackageAreaStore.getState().packageArea;
  }
  const existingAssetIds = new Set((currentArea?.entries ?? []).map((entry) => entry.assetId));

  const newEntries: { assetId: string; mediaType: PackageAreaMediaType }[] = [];
  for (const node of nodes) {
    const candidate = resolvePackageAreaCandidate(node, mediaAssets);
    if (!candidate.ok) {
      outcome.rejected.push({ label: nodeLabel(node), reason: candidate.reason });
      continue;
    }
    if (existingAssetIds.has(candidate.assetId)) {
      outcome.alreadyInArea.push(candidate.assetId);
      continue;
    }
    existingAssetIds.add(candidate.assetId);
    newEntries.push({ assetId: candidate.assetId, mediaType: candidate.mediaType });
    outcome.added.push(candidate.assetId);
  }

  if (newEntries.length > 0) {
    const next = await usePackageAreaStore.getState().submitMutation(graphId, {
      action: 'add-entries',
      entries: newEntries,
    });
    if (next === null) {
      if (withFeedback) toast.error('加入打包区失败，请重试');
      return { added: [], alreadyInArea: outcome.alreadyInArea, rejected: outcome.rejected };
    }
  }

  if (withFeedback) {
    if (outcome.added.length > 0) {
      toast.success(outcome.added.length === 1 ? '已加入打包区' : `已加入打包区 ${outcome.added.length} 项`);
    }
    if (outcome.alreadyInArea.length > 0) {
      toast.info(
        outcome.alreadyInArea.length === 1
          ? '这个素材已经在打包区里了'
          : `${outcome.alreadyInArea.length} 项已经在打包区里了`,
      );
    }
    if (outcome.rejected.length > 0) {
      const firstReason = outcome.rejected[0]?.reason ?? '无法加入打包区';
      toast.warning(
        outcome.rejected.length === 1
          ? firstReason
          : `${outcome.rejected.length} 项无法加入：${firstReason}`,
      );
    }
  }
  return outcome;
};
