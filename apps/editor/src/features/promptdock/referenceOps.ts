import type { MediaAsset, ProjectMediaAssets } from '@iart/contracts';

import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import type { GraphNode } from '@/features/canvas/types/node';
import type { AssetNodeData } from '@/features/canvas/types/taskNode';
import { usePromptDockStore } from './promptDockStore';
import type { PromptDockReference } from './PromptDock.types';
import {
  resolveAddPlacement,
  resolveMediaSupport,
  type AddPlacement,
  type SlotCatalogEntry,
} from './referenceSlotModel';

/**
 * PromptDock 参考区共享操作层（单一事实源）。
 *
 * 「用作参考」的候选判定、去重在此收口（spec：docs/editor/多选图片加入PromptDock参考区交互.md
 * 核心规则 1–4 / PD-MR-003/004），供三处消费：
 * - 画布媒体节点选中态底栏（MediaNodeChrome，设计层 D21/D26）；
 * - PromptDock 参考区「加入选中」按钮（PromptDockReferenceArea）；
 * - 会话视图产物的「用作参考」——按**素材身份 id** 直加（spec docs/agent/04 · AG-EX-002：
 *   存量会话产物不补落画布节点，该入口不依赖画布上存在持有该素材的节点）。
 *
 * 反馈呈现不在此层：操作层只返回结构化结果（discriminated union），
 * 由各呈现面自行映射（底栏 toast / dock 行内短文案 / 会话视图 toast），禁止复制判定逻辑。
 *
 * 准入依据（2026-10-27 产品裁决）：**当前所选模型是否接受该媒体类型 + 该类型参考位是否还有余量**，
 * 与素材来源无关——导入素材、生成资产、加工产出、会话存量产物完全平权。媒体身份不再按节点家族
 * 分叉：资产节点、素材节点、按素材 id 直加三条入口共用同一套「资产可访问 + 媒体类型」判定。
 * 模型能力判据（`media_slots`）在 `referenceSlotModel.resolveMediaSupport`，本层只做准入收口。
 * 同一资产在参考区只保留一份引用；重复加入由呈现面反馈「已在参考里」，不静默重复。
 */

/** 不可加入原因分类（呈现面据此选择反馈形态；用户文案由呈现面自拟） */
export type ReferenceRejectionKind =
  | 'media-unsupported'  // 当前模型不接受该媒体类型（或对象本身不是媒体素材）
  | 'slot-capacity-exceeded' // 该媒体类型的用途位已放满（用途张数上限）
  | 'asset-unavailable'; // 资产已删除/不可访问（罕见，呈现面静默跳过 + debug 留痕）

export type ReferenceCandidate =
  | { ok: true; assetId: string; mediaType: PromptDockReference['mediaType']; label: string }
  | { ok: false; reason: string; kind: ReferenceRejectionKind };

/** 参考区容量文案里的媒体类型用词与量词（图片论张、音视频论段）。 */
const MEDIA_TYPE_CAPACITY_COPY: Record<
  'image' | 'video' | 'audio',
  { label: string; unit: string; one: string }
> = {
  image: { label: '图片', unit: '张', one: '一张' },
  video: { label: '视频', unit: '段', one: '一段' },
  audio: { label: '音频', unit: '段', one: '一段' },
};

/** 资产不可访问（未注册 / 没有可用原文件）的拒绝原因。 */
const ASSET_UNAVAILABLE_REASON = '素材已被删除，无法加入参考';

/** 对象本身不是可作参考的媒体（文本等）的拒绝原因（与「模型不支持」是两回事）。 */
const NOT_MEDIA_REASON = '这个对象不是图片、视频或音频，无法加入参考';

/**
 * 媒体身份 + 资产可访问性判定（三条入口共用，不按节点家族分叉）。
 *
 * 媒体类型以资产注册表为准（节点/调用方给的类型只在查表前用于定位，查表命中后即被注册表覆盖），
 * 可用性要求资产存在且有原文件（`original.url`）。
 */
const resolveMediaIdentityCandidate = (params: {
  assetId: string;
  mediaType: PromptDockReference['mediaType'];
  label: string;
  mediaAssets: ProjectMediaAssets;
}): ReferenceCandidate => {
  const asset: MediaAsset | undefined = params.mediaAssets[params.assetId];
  if (!asset || !(asset.original?.url ?? '')) {
    return { ok: false, reason: ASSET_UNAVAILABLE_REASON, kind: 'asset-unavailable' };
  }
  return {
    ok: true,
    assetId: params.assetId,
    mediaType: asset.mediaType,
    label: params.label,
  };
};

/** 节点承载的媒体类型（资产节点取节点 data；素材节点取节点家族；其余对象不可作参考）。 */
const nodeMediaType = (node: GraphNode): PromptDockReference['mediaType'] | null => {
  if (node.type === 'asset') return (node.data as AssetNodeData).mediaType;
  if (node.type === 'imageInput') return 'image';
  if (node.type === 'videoInput') return 'video';
  if (node.type === 'audioInput') return 'audio';
  return null;
};

/** 节点数据里的标签（仅呈现，不参与提交；缺失退 assetId）。 */
const nodeReferenceLabel = (node: GraphNode, assetId: string): string => {
  const label = (node.data as { label?: unknown }).label;
  return typeof label === 'string' && label ? label : assetId;
};

/** 从画布节点解析参考候选（资产可访问性 + 媒体身份判定；不可访问/已删除资产给出可定位原因）。 */
export const resolveReferenceCandidate = (
  node: GraphNode,
  mediaAssets: ProjectMediaAssets,
): ReferenceCandidate => {
  const mediaType = nodeMediaType(node);
  if (mediaType === null) {
    return { ok: false, reason: NOT_MEDIA_REASON, kind: 'media-unsupported' };
  }
  const assetId = (node.data as { assetId?: unknown }).assetId;
  if (typeof assetId !== 'string' || !assetId) {
    return { ok: false, reason: ASSET_UNAVAILABLE_REASON, kind: 'asset-unavailable' };
  }
  return resolveMediaIdentityCandidate({
    assetId,
    mediaType,
    label: nodeReferenceLabel(node, assetId),
    mediaAssets,
  });
};

/**
 * 从**素材身份 id** 解析参考候选：不要求画布上存在持有该素材的节点（存量会话产物只有资产
 * 记录、没有节点）。准入判定与画布节点路径同一套（`resolveMediaIdentityCandidate`）。
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
  return resolveMediaIdentityCandidate({
    assetId: params.assetId,
    mediaType: asset.mediaType,
    label: params.label,
    mediaAssets: params.mediaAssets,
  });
};

/** 参考加入的准入结论（UI 预判与批量加入过滤共用同一条判定）。 */
export type ReferenceAdmission =
  | { ok: true }
  | {
      ok: false;
      kind: ReferenceRejectionKind;
      /** 用户可读原因（可直接作为行内提示 / toast 文案） */
      reason: string;
    };

/** 容量放满的统一措辞（加入路径与合并层共用，避免两处文案漂移）。 */
const capacityExceededReason = (placement: Extract<AddPlacement, { kind: 'full' }>): string => {
  const copy = MEDIA_TYPE_CAPACITY_COPY[placement.mediaType];
  return `当前模型的${copy.label}参考最多 ${placement.capacity} ${copy.unit}，参考区已经放满，先移除${copy.one}再加入`;
};

/**
 * 候选级准入判定（三条入口共用的收口）：资产可访问 → 当前模型接受该媒体类型 → 该类型参考位有余量。
 * 已在参考区的资产直接放行，由合并层记「重复」（不能因容量已满把它误报成容量拒绝）。
 */
const resolveCandidateAdmission = (
  candidate: ReferenceCandidate,
  entry: SlotCatalogEntry | null | undefined,
  references: readonly PromptDockReference[],
): ReferenceAdmission => {
  if (!candidate.ok) {
    return { ok: false, kind: candidate.kind, reason: candidate.reason };
  }
  if (references.some((ref) => ref.assetId === candidate.assetId)) return { ok: true };
  const support = resolveMediaSupport(entry, candidate.mediaType);
  if (support === 'unsupported') {
    return {
      ok: false,
      kind: 'media-unsupported',
      reason: `当前模型不支持${MEDIA_TYPE_CAPACITY_COPY[candidate.mediaType].label}参考`,
    };
  }
  // `no-slot-model`（模型没有任何素材位）= 无用途模型，沿用既有行为：允许加入、落未指定。
  if (support === 'supported') {
    const placement = resolveAddPlacement(entry, candidate.mediaType, references);
    if (placement.kind === 'full') {
      return {
        ok: false,
        kind: 'slot-capacity-exceeded',
        reason: capacityExceededReason(placement),
      };
    }
  }
  return { ok: true };
};

/**
 * 参考准入预判（UI 用）：给定选中节点、资产注册表、当前模型目录条目与草稿现有引用，
 * 判定这一项能否加入参考区，以及不能加入时的可定位原因。
 *
 * 判据与 `mergeReferences` 的合并口径同源：模型能力看 `media_slots`，余量看该类型参考位的
 * 当前绑定数；批内多个候选用**加入前**的引用快照预判，批内边加边扣余量由合并层承担。
 */
export const resolveReferenceAdmission = (params: {
  node: GraphNode;
  mediaAssets: ProjectMediaAssets;
  entry: SlotCatalogEntry | null | undefined;
  references: readonly PromptDockReference[];
}): ReferenceAdmission =>
  resolveCandidateAdmission(
    resolveReferenceCandidate(params.node, params.mediaAssets),
    params.entry,
    params.references,
  );

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
 *
 * `resolvePlacement` 拿到**在途**引用列表：同批多张会边加边扣余量，不能拿进来之前的快照
 * 一次性判断（否则一批 5 张会全部通过容量校验）。
 */
export const mergeReferences = (
  existing: readonly PromptDockReference[],
  candidates: readonly ReferenceMergeEntry[],
  /**
   * 新引用的落位解析器（设计 §4.3 的默认落位 + 张数余量）。
   *
   * 由调用方注入而不是在纯函数里读 store：本层只做「合并与去重」，用途语义归
   * `referenceSlotModel`。不传即视为「无用途模型」，新引用落未指定。
   */
  resolvePlacement: (
    mediaType: PromptDockReference['mediaType'],
    next: readonly PromptDockReference[],
  ) => AddPlacement = () => ({ kind: 'unspecified' }),
): { outcome: AddReferencesOutcome; next: PromptDockReference[] } => {
  const outcome: AddReferencesOutcome = { added: [], alreadyInRefs: [], rejected: [] };
  let next: PromptDockReference[] = [...existing];
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
    const placement = resolvePlacement(candidate.mediaType, next);
    if (placement.kind === 'full') {
      outcome.rejected.push({
        label,
        reason: capacityExceededReason(placement),
        kind: 'slot-capacity-exceeded',
      });
      continue;
    }
    const ref: PromptDockReference = {
      refId: candidate.assetId,
      assetId: candidate.assetId,
      mediaType: candidate.mediaType,
      label: candidate.label,
      slotId: placement.kind === 'slot' ? placement.slotId : null,
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

/** store 接线时的同一份快照（准入预判与合并落位看到相同的引用列表）。 */
type ReferenceCommitContext = {
  mediaAssets: ProjectMediaAssets;
  entry: SlotCatalogEntry | null;
  references: readonly PromptDockReference[];
};

/** 把准入结论收敛成合并层的候选形态：不通过时转成「不可加入」候选（进入 rejected，不参与合并）。 */
const gateEntry = (
  label: string,
  candidate: ReferenceCandidate,
  admission: ReferenceAdmission,
): ReferenceMergeEntry => {
  if (candidate.ok && !admission.ok) {
    return { label, candidate: { ok: false, kind: admission.kind, reason: admission.reason } };
  }
  return { label, candidate };
};

/**
 * store 接线：把一批候选项合并进当前草稿参考区并收口成结构化结果。
 * 两条入口（节点路径 / 按素材 id 直加）共用此处，不各写一份准入、写入与结果分档。
 */
const commitReferences = (
  buildEntries: (context: ReferenceCommitContext) => readonly ReferenceMergeEntry[],
): AddReferencesResult => {
  const store = usePromptDockStore.getState();
  // 新引用的落位按「当前所选模型」判定（§4.3）：多张位有余量才绑，放满后落未指定；
  // 该媒体类型的候选位全满则拒绝加入（不在参考区堆交不出去的草稿）。
  const entry = store.catalog.find((item) => item.model_id === store.draft.modelId) ?? null;
  const context: ReferenceCommitContext = {
    mediaAssets: useCanvasStore.getState().mediaAssets,
    entry,
    references: store.draft.references,
  };
  // 准入预判只拦「模型不接受的媒体类型」；同批边加边扣余量仍由合并层承担（余量唯一口径）。
  const entries = buildEntries(context);
  const { outcome, next } = mergeReferences(context.references, entries, (mediaType, next) =>
    resolveAddPlacement(entry, mediaType, next),
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
 * 供 MediaNodeChrome 底栏与 PromptDockReferenceArea「加入选中」共用；
 * 返回结构化结果，反馈呈现（toast / 行内文案）由调用方映射。
 */
export const addNodesToReferences = (nodes: GraphNode[]): AddReferencesResult =>
  commitReferences(({ mediaAssets, entry, references }) =>
    nodes.map((node) => {
      const label = nodeLabel(node);
      const candidate = resolveReferenceCandidate(node, mediaAssets);
      return gateEntry(label, candidate, resolveCandidateAdmission(candidate, entry, references));
    }),
  );

/**
 * store 接线：按**素材身份 id** 把一批资产加入当前草稿参考区（去重）。
 *
 * 与 `addNodesToReferences` 共用准入判定与合并收口，差别只在候选从资产注册表解析 ——
 * 不要求画布上存在持有该素材的节点（存量会话产物、跨空间引用；spec docs/agent/04 · AG-EX-002）。
 * 返回结构化结果，反馈呈现由调用方映射（会话视图 toast）。
 */
export const addAssetIdsToReferences = (assetIds: readonly string[]): AddReferencesResult =>
  commitReferences(({ mediaAssets, entry, references }) => {
    const nodes = useCanvasStore.getState().nodeGraph?.nodes ?? [];
    return assetIds.map((assetId) => {
      const label = referenceLabelForAssetId(assetId, nodes);
      const candidate = resolveReferenceCandidateByAssetId({ assetId, label, mediaAssets });
      return gateEntry(label, candidate, resolveCandidateAdmission(candidate, entry, references));
    });
  });

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
