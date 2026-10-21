import type { MediaAsset, ProjectMediaAssets } from '@iart/contracts';

import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import type { GraphNode } from '@/features/canvas/types/node';
import type { AssetNodeData } from '@/features/canvas/types/taskNode';
import { usePromptDockStore } from './promptDockStore';
import type { PromptDockReference } from './PromptDock.types';
import { defaultSlotId } from './referenceSlotModel';

/**
 * PromptDock 参考区共享操作层（单一事实源）。
 *
 * 「用作参考」的候选判定、去重在此收口（spec：docs/editor/多选图片加入PromptDock参考区交互.md
 * 核心规则 1–4 / PD-MR-003/004），供三处消费：
 * - 画布资产节点选中态底栏（AssetNodeChrome，设计层 D21/D26）；
 * - PromptDock 参考区「加入选中」按钮（PromptDockReferenceArea）；
 * - 会话视图产物的「用作参考」——按**素材身份 id** 直加（spec docs/agent/04 · AG-EX-002：
 *   存量会话产物不补落画布节点，该入口不依赖画布上存在持有该素材的节点）。
 *
 * 反馈呈现不在此层：操作层只返回结构化结果（discriminated union），
 * 由各呈现面自行映射（底栏 toast / dock 行内短文案 / 会话视图 toast），禁止复制判定逻辑。
 *
 * 媒体边界（现役 spec 收口，O5）：**资产身份**（资产节点与按素材 id 直加）的参考加入只处理
 * 图片资产；素材节点（imageInput/videoInput/audioInput）维持现状可加入的媒体类型，不扩大也不收窄。
 * 同一资产在参考区只保留一份引用；重复加入由呈现面反馈「已在参考里」，不静默重复。
 */

/** 不可加入原因分类（呈现面据此选择反馈形态；用户文案由呈现面自拟） */
export type ReferenceRejectionKind =
  | 'media-unsupported'  // 媒体类型不符准入（资产身份非图片 / 非媒体素材节点）
  | 'asset-unavailable'; // 资产已删除/不可访问（罕见，呈现面静默跳过 + debug 留痕）

export type ReferenceCandidate =
  | { ok: true; assetId: string; mediaType: PromptDockReference['mediaType']; label: string }
  | { ok: false; reason: string; kind: ReferenceRejectionKind };

/** 媒体类型的用户可读名（拒绝原因里定位对象用）。 */
const mediaTypeLabel = (mediaType: string): string =>
  mediaType === 'video' ? '视频' : mediaType === 'audio' ? '音频' : '其他素材';

/** 资产不可访问（未注册 / 没有可用原文件）的拒绝原因。 */
const ASSET_UNAVAILABLE_REASON = '素材已被删除，无法加入参考';

/**
 * 参考准入的「资产身份」判定（资产节点路径与按素材 id 直加路径共用同一套规则）：
 * 只放行图片资产；资产须在注册表且可访问（有 original.url）。
 * 判定只此一处——两条入口的差别只在媒体类型与标签从哪来、拒绝措辞用哪一路。
 */
const resolveAssetIdentityCandidate = (params: {
  assetId: string;
  /** 资产媒体类型（资产节点取节点 data；按素材 id 直加取注册表条目） */
  mediaType: string;
  /** 加入时的呈现标签（仅呈现，不参与提交） */
  label: string;
  /** 从哪条路径进来（决定拒绝措辞：节点路径说「当前选中的是…」，按 id 直加说「…不能用作参考」） */
  origin: 'node' | 'asset-id';
  mediaAssets: ProjectMediaAssets;
}): ReferenceCandidate => {
  if (params.mediaType !== 'image') {
    return {
      ok: false,
      reason:
        params.origin === 'node'
          ? `参考素材只支持图片，当前选中的是${mediaTypeLabel(params.mediaType)}`
          : `参考素材只支持图片，${mediaTypeLabel(params.mediaType)}不能用作参考`,
      kind: 'media-unsupported',
    };
  }
  const asset: MediaAsset | undefined = params.mediaAssets[params.assetId];
  if (!asset || !(asset.original?.url ?? '')) {
    return { ok: false, reason: ASSET_UNAVAILABLE_REASON, kind: 'asset-unavailable' };
  }
  return { ok: true, assetId: params.assetId, mediaType: 'image', label: params.label };
};

/** 从画布节点解析参考候选（资产访问性与类型判定；不可访问/已删除资产给出可定位原因）。 */
export const resolveReferenceCandidate = (
  node: GraphNode,
  mediaAssets: ProjectMediaAssets,
): ReferenceCandidate => {
  if (node.type === 'asset') {
    const data = node.data as AssetNodeData;
    return resolveAssetIdentityCandidate({
      assetId: data.assetId,
      mediaType: data.mediaType,
      label: data.label,
      origin: 'node',
      mediaAssets,
    });
  }
  // 素材节点：维持现状（image/video/audio 可加入，文本不加入）。
  const mediaType =
    node.type === 'imageInput' ? 'image'
      : node.type === 'videoInput' ? 'video'
        : node.type === 'audioInput' ? 'audio'
          : null;
  if (!mediaType) {
    return {
      ok: false,
      reason: '这个对象不是图片、视频或音频，无法加入参考',
      kind: 'media-unsupported',
    };
  }
  const assetId = (node.data as { assetId?: unknown }).assetId;
  if (typeof assetId !== 'string' || !assetId || !(assetId in mediaAssets)) {
    return { ok: false, reason: ASSET_UNAVAILABLE_REASON, kind: 'asset-unavailable' };
  }
  const label = (node.data as { label?: unknown }).label;
  return {
    ok: true,
    assetId,
    mediaType,
    label: typeof label === 'string' && label ? label : assetId,
  };
};

/**
 * 从**素材身份 id** 解析参考候选：不要求画布上存在持有该素材的节点（存量会话产物只有资产
 * 记录、没有节点）。准入判定与资产节点路径同一套（`resolveAssetIdentityCandidate`）。
 * 标签取法不在本函数（呈现口径由调用方给，见 `referenceLabelForAssetId`）。
 */
export const resolveReferenceCandidateByAssetId = (params: {
  assetId: string;
  label: string;
  mediaAssets: ProjectMediaAssets;
}): ReferenceCandidate => {
  const asset: MediaAsset | undefined = params.mediaAssets[params.assetId];
  if (!asset) {
    // 注册表查不到：资产已删除 / 不可访问（与节点路径同一种拒绝，反馈可定位到该素材 id）。
    return { ok: false, reason: ASSET_UNAVAILABLE_REASON, kind: 'asset-unavailable' };
  }
  return resolveAssetIdentityCandidate({
    assetId: params.assetId,
    mediaType: asset.mediaType,
    label: params.label,
    origin: 'asset-id',
    mediaAssets: params.mediaAssets,
  });
};

/**
 * 参考条目的呈现标签：优先画布上持有该资产的节点的标签，缺失退 assetId
 * （与 `assetReuse` 的快照回填同口径；标签仅呈现，不参与提交）。
 */
export const referenceLabelForAssetId = (
  assetId: string,
  nodes: readonly GraphNode[],
): string => {
  const holder = nodes.find(
    (node) => (node.data as { assetId?: unknown }).assetId === assetId,
  );
  const label = holder === undefined ? undefined : (holder.data as { label?: unknown }).label;
  return typeof label === 'string' && label ? label : assetId;
};

/** 不可加入项（reason 可定位到具体对象；kind 供呈现面区分反馈形态） */
export type RejectedReference = {
  label: string;
  reason: string;
  kind: ReferenceRejectionKind;
};

export type AddReferencesOutcome = {
  /** 实际新增的引用（顺序即草稿呈现顺序） */
  added: PromptDockReference[];
  /** 已存在于参考区（未重复添加）的 assetId */
  alreadyInRefs: string[];
  /** 不可加入项及可定位原因（PD-MR-004：须能定位到具体资产） */
  rejected: RejectedReference[];
};

/**
 * 加入参考的结构化结果（discriminated union，呈现面自行映射反馈）。
 * 部分有效（既有新增也有跳过项）统一归 `added`——chip 数量变化即反馈，
 * 跳过明细随结果携带，呈现面可对不可访问项 debug 留痕。
 */
export type AddReferencesResult =
  | {
      kind: 'added';
      addedCount: number;
      /** 同批命中已有引用的数量 */
      duplicates: number;
      /** 同批不可加入项 */
      rejected: readonly RejectedReference[];
    }
  | {
      kind: 'duplicate';
      /** 命中已有引用的数量 */
      duplicates: number;
      /** 同批不可加入项（与重复并存时呈现面自行取舍） */
      rejected: readonly RejectedReference[];
    }
  | {
      kind: 'rejected';
      duplicates: 0;
      rejected: readonly RejectedReference[];
    };

/** 从节点数据尽力读取显示标签（拒绝反馈定位用）。 */
const nodeLabel = (node: GraphNode): string => {
  const label = (node.data as { label?: unknown }).label;
  return typeof label === 'string' && label ? label : node.id;
};

/**
 * 合并输入：候选 + 它的可定位标签（反馈要能定位到具体对象，两条入口的标签来源不同：
 * 节点路径取节点标签，按素材 id 直加取资产标签）。
 */
export type ReferenceMergeEntry = { label: string; candidate: ReferenceCandidate };

/**
 * 纯函数：把候选集合合并进现有 references（去重，保持加入顺序）。
 * 反馈文案由调用方决定（chrome 与「加入选中」按钮的 toast 策略一致但呈现可微调）。
 */
export const mergeReferences = (
  existing: PromptDockReference[],
  candidates: readonly ReferenceMergeEntry[],
  /**
   * 新引用的默认用途解析器（设计 §4.3 的默认落位）。
   *
   * 由调用方注入而不是在纯函数里读 store：本层只做「合并与去重」，用途语义归
   * `referenceSlotModel`。不传即视为「无用途模型」，新引用落未指定。
   */
  resolveDefaultSlotId: (mediaType: PromptDockReference['mediaType']) => string | null = () => null,
): { outcome: AddReferencesOutcome; next: PromptDockReference[] } => {
  const outcome: AddReferencesOutcome = { added: [], alreadyInRefs: [], rejected: [] };
  let next = existing;
  for (const { label, candidate } of candidates) {
    if (!candidate.ok) {
      outcome.rejected.push({
        label,
        reason: candidate.reason,
        kind: candidate.kind,
      });
      continue;
    }
    if (next.some((r) => r.assetId === candidate.assetId)) {
      outcome.alreadyInRefs.push(candidate.assetId);
      continue;
    }
    const ref: PromptDockReference = {
      refId: candidate.assetId,
      assetId: candidate.assetId,
      mediaType: candidate.mediaType,
      label: candidate.label,
      slotId: resolveDefaultSlotId(candidate.mediaType),
    };
    outcome.added.push(ref);
    next = [...next, ref];
  }
  return { outcome, next };
};

/** 参考区当前是否已持有该资产引用。 */
export const isAssetInReferences = (
  references: PromptDockReference[],
  assetId: string,
): boolean => references.some((r) => r.assetId === assetId);

/**
 * store 接线：把候选集合合并进当前草稿参考区并收口成结构化结果。
 * 两条入口（节点路径 / 按素材 id 直加）共用此处，不各写一份写入与结果分档。
 */
const commitReferences = (candidates: readonly ReferenceMergeEntry[]): AddReferencesResult => {
  const store = usePromptDockStore.getState();
  // 新引用的默认用途按「当前所选模型」判定（§4.3）：多张位绑多张位、全单张位落未指定。
  const entry = store.catalog.find((item) => item.model_id === store.draft.modelId) ?? null;
  const { outcome, next } = mergeReferences(store.draft.references, candidates, (mediaType) =>
    defaultSlotId(entry, mediaType),
  );
  if (outcome.added.length > 0) {
    store.setDraft({ references: next });
    return {
      kind: 'added',
      addedCount: outcome.added.length,
      duplicates: outcome.alreadyInRefs.length,
      rejected: outcome.rejected,
    };
  }
  if (outcome.alreadyInRefs.length > 0) {
    return {
      kind: 'duplicate',
      duplicates: outcome.alreadyInRefs.length,
      rejected: outcome.rejected,
    };
  }
  return { kind: 'rejected', duplicates: 0, rejected: outcome.rejected };
};

/**
 * store 接线：把一批画布节点加入当前草稿参考区（去重）。
 * 供 AssetNodeChrome 底栏与 PromptDockReferenceArea「加入选中」共用；
 * 返回结构化结果，反馈呈现（toast / 行内文案）由调用方映射。
 */
export const addNodesToReferences = (nodes: GraphNode[]): AddReferencesResult => {
  const mediaAssets = useCanvasStore.getState().mediaAssets;
  return commitReferences(
    nodes.map((node) => ({
      label: nodeLabel(node),
      candidate: resolveReferenceCandidate(node, mediaAssets),
    })),
  );
};

/**
 * store 接线：按**素材身份 id** 把一批资产加入当前草稿参考区（去重）。
 *
 * 与 `addNodesToReferences` 共用准入判定与合并收口，差别只在候选从资产注册表解析 ——
 * 不要求画布上存在持有该素材的节点（存量会话产物、跨空间引用；spec docs/agent/04 · AG-EX-002）。
 * 返回结构化结果，反馈呈现由调用方映射（会话视图 toast）。
 */
export const addAssetIdsToReferences = (assetIds: readonly string[]): AddReferencesResult => {
  const canvas = useCanvasStore.getState();
  const mediaAssets = canvas.mediaAssets;
  const nodes = canvas.nodeGraph?.nodes ?? [];
  return commitReferences(
    assetIds.map((assetId) => {
      const label = referenceLabelForAssetId(assetId, nodes);
      return {
        label,
        candidate: resolveReferenceCandidateByAssetId({ assetId, label, mediaAssets }),
      };
    }),
  );
};

/** store 接线：把一批资产从参考区移除（chrome「取消参考」）。 */
export const removeAssetsFromReferences = (assetIds: string[]): void => {
  if (assetIds.length === 0) return;
  const store = usePromptDockStore.getState();
  const idSet = new Set(assetIds);
  const next = store.draft.references.filter((r) => !idSet.has(r.assetId));
  if (next.length !== store.draft.references.length) {
    store.setDraft({ references: next });
  }
};

/**
 * 参考区资产 id → 持有该资产的画布节点 id（chrome 移除参考钮与节点反查用，O(n) 单次）。
 */
export const findNodeIdsByAssetId = (assetId: string): string[] => {
  const graph = useCanvasStore.getState().nodeGraph;
  if (!graph) return [];
  return graph.nodes
    .filter((node) => {
      const data = node.data as { assetId?: unknown };
      return typeof data.assetId === 'string' && data.assetId === assetId;
    })
    .map((node) => node.id);
};
