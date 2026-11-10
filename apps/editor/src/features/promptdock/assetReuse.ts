import type { BatchIntent, BatchIntentSnapshot, ProjectMediaAssets } from '@iart/contracts';
import type { AssetNodeData } from '@/features/canvas/types/taskNode';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { extractFileKeyFromRuntimeMediaUrl } from '@/features/canvas/utils/mediaUrl';
import { fetchBatchIntentSnapshot } from '@/client/api/promptDockApi';
import type { PromptDockCatalogEntry } from '@/client/api/promptDockApi';
import { usePromptDockStore } from './promptDockStore';
import { legacySlotId } from './referenceSlotModel';
import type { PromptDockDraft, PromptDockReference } from './PromptDock.types';

/**
 * 资产「复用」统一入口（设计层 D21：复用钮仅任务生成资产渲染）。
 *
 * 两段回填（产品 spec「复用」段：回填模型、prompt、参数、参考和任务数）：
 * 1. 同步重置草稿为模型身份（model_id 回填、任务数回 1）——立即的用户反馈；
 * 2. restoreDraftFromBatchSnapshot 按 batch 快照异步补齐 prompt/参数/参考/任务数。
 * 不回填连接/凭证/部署/执行快照（spec PromptDock生成主链.md）。
 * AssetNode hover 钮（历史入口）与资产节点选中态底栏共用本函数，禁止并立实现。
 *
 * 多意图批次（spec 45 §5.1）：素材节点带 `sourceTaskId`，回填必须按它定位产出该素材的
 * 意图；只传 `sourceBatchId` 会让回填永远落在第一个意图上（用户点第 5 个表情包的「复用」，
 * 拿到的却是第 1 个提示词）。
 */
export const reuseAssetToDraft = (asset: AssetNodeData): void => {
  const replaceDraft = usePromptDockStore.getState().replaceDraft;
  replaceDraft({
    modelId: asset.sourceModelId || null,
    modelVersion: null,
    prompt: '',
    arguments: {},
    references: [],
    promptPresetSnapshots: undefined,
    taskCount: 1,
  });
  restoreDraftFromBatchSnapshot({
    batchId: asset.sourceBatchId,
    fallbackModelId: asset.sourceModelId || null,
    restoreTaskCount: true,
    taskId: asset.sourceTaskId,
  });
};

/**
 * 失败任务「重试」的草稿回填入口（与复用共用 batch 快照读取链路）。
 * 重试固定创建 1 个任务（spec 固定任务数批次提交与投影语义.md），任务数不回填原批次 N。
 */
export const reuseTaskToDraft = (params: {
  batchId: string | null | undefined;
  modelId: string | null | undefined;
  /** 触发重试的任务：多意图批次按它定位所属意图，缺省回填第一个意图。 */
  taskId?: string | null | undefined;
}): void => {
  const replaceDraft = usePromptDockStore.getState().replaceDraft;
  replaceDraft({
    modelId: params.modelId || null,
    modelVersion: null,
    prompt: '',
    arguments: {},
    references: [],
    promptPresetSnapshots: undefined,
    taskCount: 1,
  });
  restoreDraftFromBatchSnapshot({
    batchId: params.batchId,
    fallbackModelId: params.modelId || null,
    restoreTaskCount: false,
    taskId: params.taskId,
  });
};

/**
 * 按 batch 快照异步回填草稿的 prompt/参数/参考（复用还含任务数）。
 *
 * 只作用于发起回填那一刻的草稿对象：快照读取期间用户已编辑（draft 引用被 setDraft/
 * replaceDraft 换新）则让位，不覆盖用户输入。快照缺失/不可读时留痕并保持模型身份回填。
 */
export const restoreDraftFromBatchSnapshot = (params: {
  batchId: string | null | undefined;
  fallbackModelId: string | null;
  /** 复用回填原批次任务数（产品 spec「复用」段）；重试固定 1，不回填 */
  restoreTaskCount: boolean;
  /** 回填目标任务：多意图批次按它定位所属意图，缺省回填第一个意图。 */
  taskId?: string | null | undefined;
}): void => {
  const draftAtStart = usePromptDockStore.getState().draft;
  void fetchBatchIntentSnapshot(params.batchId ?? '').then((snapshot) => {
    if (!snapshot) return;
    const current = usePromptDockStore.getState();
    if (current.draft !== draftAtStart) return;
    current.setDraft(
      buildDraftPatchFromSnapshot(snapshot, {
        fallbackModelId: params.fallbackModelId,
        restoreTaskCount: params.restoreTaskCount,
        taskId: params.taskId,
      }),
    );
  });
};

/**
 * 任务所属意图（spec 45 §5.1）：任务按意图顺序连续分配，按 task_ids 位置累积即可定位。
 * 找不到目标任务时回填第一个意图——单意图批次就是它，多意图批次下这是「整批的主意图」。
 */
const resolveIntentForTask = (
  snapshot: BatchIntentSnapshot,
  taskId: string | null | undefined,
): BatchIntent => {
  const fallback = snapshot.intents[0] ?? { prompt: '', params: {}, task_count: 1 };
  if (!taskId) return fallback;
  const taskIndex = snapshot.task_ids.indexOf(taskId);
  if (taskIndex < 0) return fallback;
  let offset = 0;
  for (const intent of snapshot.intents) {
    offset += intent.task_count;
    if (taskIndex < offset) return intent;
  }
  return fallback;
};

const buildDraftPatchFromSnapshot = (
  snapshot: BatchIntentSnapshot,
  opts: { fallbackModelId: string | null; restoreTaskCount: boolean; taskId?: string | null | undefined },
): Partial<PromptDockDraft> => {
  const modelId = snapshot.model_id || opts.fallbackModelId;
  // model_version 取当前目录投影（能力包版本随分发演进），不回填快照历史值。
  const catalogEntry = modelId
    ? usePromptDockStore.getState().catalog.find((entry) => entry.model_id === modelId) ?? null
    : null;
  const intent = resolveIntentForTask(snapshot, opts.taskId);
  return {
    modelId: modelId || null,
    modelVersion: catalogEntry?.model_version ?? null,
    prompt: intent.prompt,
    arguments: { ...intent.params },
    references: buildReferencesFromSnapshot(intent, catalogEntry),
    // 快照回填的是提交时已展开的正文，不含预设 token：清空上一次草稿的 token 快照，避免残留。
    promptPresetSnapshots: undefined,
    ...(opts.restoreTaskCount ? { taskCount: intent.task_count } : {}),
  };
};

/**
 * 草稿参考区重建：优先快照内参考资产 id，旧快照（无该字段）按 media_refs fileKey 反查兜底。
 *
 * 用途按设计文档 §8 存量兼容处理：快照不承载用途标记，一律按**当前目录条目**的默认落位赋
 * 一次（多张位 → 普通参考，全单张位 → 未指定）。因此在全单张位模型上复用旧任务时仍要各点
 * 一次用途——这是 §8 已声明的可接受代价，不在这里按快照历史推断。
 */
const buildReferencesFromSnapshot = (
  intent: BatchIntent,
  entry: PromptDockCatalogEntry | null,
): PromptDockReference[] => {
  const mediaAssets: ProjectMediaAssets = useCanvasStore.getState().mediaAssets ?? {};
  const assetIds = intent.reference_asset_ids ?? resolveAssetIdsFromMediaRefs(intent, mediaAssets);
  const graph = useCanvasStore.getState().nodeGraph;
  const references: PromptDockReference[] = [];
  for (const assetId of assetIds) {
    const asset = mediaAssets[assetId];
    if (!asset) {
      console.debug('[assetReuse] reference asset missing from registry (skipped)', { assetId });
      continue;
    }
    // label 仅呈现：优先画布资产节点现有标签，缺失时退 assetId（referenceOps 同口径）。
    const node = graph?.nodes.find((n) => (n.data as { assetId?: unknown }).assetId === assetId);
    const nodeLabel = node ? (node.data as { label?: unknown }).label : undefined;
    references.push({
      refId: assetId,
      assetId,
      mediaType: asset.mediaType,
      label: typeof nodeLabel === 'string' && nodeLabel ? nodeLabel : assetId,
      slotId: legacySlotId(entry, asset.mediaType),
    });
  }
  return references;
};

const resolveAssetIdsFromMediaRefs = (
  intent: BatchIntent,
  mediaAssets: ProjectMediaAssets,
): string[] => {
  const mediaRefs = intent.media_refs ?? [];
  // attachment 引用的 value 是提交时资产 original.url（local-media://…fileKey），按 fileKey
  // 反查画布资产注册表；其余 source_kind（url/base64/local_path）不对应画布资产，跳过。
  const fileKeyToAssetId = new Map<string, string>();
  for (const [assetId, asset] of Object.entries(mediaAssets)) {
    const fileKey = asset.original.fileKey ?? extractFileKeyFromRuntimeMediaUrl(asset.original.url);
    if (fileKey) fileKeyToAssetId.set(fileKey, assetId);
  }
  const resolved: string[] = [];
  for (const ref of mediaRefs) {
    if (ref.source_kind !== 'attachment') continue;
    const assetId = fileKeyToAssetId.get(extractFileKeyFromRuntimeMediaUrl(ref.value) ?? '');
    if (!assetId) {
      console.debug('[assetReuse] media ref not resolvable to canvas asset (skipped)', {
        value: ref.value,
      });
      continue;
    }
    resolved.push(assetId);
  }
  return resolved;
};

/** 资产是否持有生成来源（任务投影产物）——底栏「复用」可见性判据（D21）。 */
export const hasGenerationProvenance = (asset: AssetNodeData): boolean =>
  Boolean(asset.sourceModelId) || Boolean(asset.sourceTaskId);
