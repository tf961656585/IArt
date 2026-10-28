import {
  BatchIntentSnapshotSchema,
  TaskSubmitMediaKindSchema,
  type BatchIntentSnapshot,
  type CliGenerationArchive,
  type CliGenerationArchiveReference,
  type RuntimeMediaAssetView,
  type RuntimeTaskView,
} from "@iart/contracts";
import { resolveLocalMediaFilePath } from "./cli-canvas-projection.cjs";
import mediaFileKeyModule = require("@iart/utils/media-file-key");
const { extractContentHashFromFileKey, extractMediaFileKey } = mediaFileKeyModule;

/**
 * 生成档案构建（spec docs/integrations/CLI与本地Agent集成.md §5.2 batch get / CLI-038）。
 *
 * **单一构建出口**：batch get、asset get 内联与 task get 内联三入口都必须经
 * buildGenerationArchive 产出同一档案形状（契约 CliGenerationArchiveSchema），
 * 任何入口不得出现字段子集——三入口档案字段一致性由接缝测试 deep-equal 机械守护。
 *
 * 引用解析口径（2026-10-26 更新）：
 * - 新快照 media_refs 带 asset_id 时由它构建（一次拿到资产 + 用途 + 字段绑定）；
 * - 其次 reference_asset_ids（旧提交面只带 id）；
 * - 再次由 media_refs 的 fileKey 推导资产 id——复用既有推导（Editor assetReuse 的 fileKey
 *   反查思路 + asset get 等价类的「同媒体类型 + 同内容指纹」判据，判据解析单一入口
 *   extractContentHashFromFileKey，资产 id 公式文档源 docs/architecture/contracts/storage-schema.md，
 *   不在此内联公式）；
 * - 能查到资产实体就附媒体类型、文件键与本地文件路径（复用 asset get 现有实体读取与
 *   resolveLocalMediaFilePath 路径解析），查不到只给 asset_id；
 * - media_refs 缺省时 references 为空数组。
 * - params 里被媒体实际占用的字段键在投影层剥离（快照本身不可变）：档案不再出现
 *   「references 有图、params 里却是空数组」的假事实。
 *
 * prompt 承载提交提示词全文：任务 metadata 里的提示词预览是 512 字符截断摘要
 * （task-storage-summary-projector 写入口径），本档案是 CLI 面唯一的全文读取位。
 */

/** 资产来源注入面：与 asset get 现有实体读取通道同一底座（CliCommandExecutorStorage 收窄视图）。 */
export interface CliGenerationArchiveAssetSource {
  readAssetById: (assetId: string) => RuntimeMediaAssetView | null;
  listAssets: () => readonly RuntimeMediaAssetView[];
}

/**
 * 任务的批次归属解析：任务视图 batchId 列优先；旧行缺列投影时回落任务 metadata 双键
 * （batchId/batch_id，与 cli-storage-queries 生成来源索引同一口径，不新写第二份键序）。
 */
export const resolveTaskBatchId = (task: RuntimeTaskView): string | null => {
  if (typeof task.batchId === "string" && task.batchId.length > 0) return task.batchId;
  const metadataBatchId = task.metadata?.batchId;
  if (typeof metadataBatchId === "string" && metadataBatchId.length > 0) return metadataBatchId;
  const metadataBatchIdLegacy = task.metadata?.batch_id;
  if (typeof metadataBatchIdLegacy === "string" && metadataBatchIdLegacy.length > 0) return metadataBatchIdLegacy;
  return null;
};

/** 资产媒体类型收窄到提交媒体输入的媒体类型枚举；其余值缺省（引用条目不编造型别）。 */
const toMediaKind = (mediaType: string): "image" | "video" | "audio" | undefined => {
  const parsed = TaskSubmitMediaKindSchema.safeParse(mediaType);
  return parsed.success ? parsed.data : undefined;
};

/** 单条引用投影：实体可查则附媒体类型/文件键/本地路径；查不到只给 asset_id（拍板口径）。 */
const buildReferenceFromAsset = (
  projectPath: string,
  assetId: string,
  assets: CliGenerationArchiveAssetSource,
): CliGenerationArchiveReference => {
  const asset = assets.readAssetById(assetId);
  if (asset === null) {
    console.debug("[cli-generation-archive] 引用资产实体不存在，只输出资产标识", { assetId });
    return { asset_id: assetId };
  }
  const fileKey =
    typeof asset.original.fileKey === "string" && asset.original.fileKey.length > 0
      ? asset.original.fileKey
      : extractMediaFileKey(asset.original.url);
  const localFilePath = resolveLocalMediaFilePath(projectPath, asset);
  const mediaKind = toMediaKind(asset.mediaType);
  return {
    asset_id: assetId,
    ...(mediaKind !== undefined ? { media_kind: mediaKind } : {}),
    ...(typeof fileKey === "string" && fileKey.length > 0 ? { file_key: fileKey } : {}),
    ...(localFilePath !== null ? { local_file_path: localFilePath } : {}),
  };
};

/**
 * 资产注册表的「媒体类型:内容指纹」→ 资产 id 索引。判据与 asset get 等价类同一把尺
 * （extractContentHashFromFileKey，同媒体类型 + 同内容指纹），只是查询方向反置：
 * 从引用 fileKey 反查资产 id。同内容同类型在项目库内至多一行（upsert 收敛），首见即唯一。
 */
const buildContentKeyIndex = (assets: readonly RuntimeMediaAssetView[]): Map<string, string> => {
  const index = new Map<string, string>();
  for (const asset of assets) {
    const fileKey =
      typeof asset.original.fileKey === "string" && asset.original.fileKey.length > 0
        ? asset.original.fileKey
        : extractMediaFileKey(asset.original.url);
    if (typeof fileKey !== "string" || fileKey.length === 0) continue;
    const contentHash = extractContentHashFromFileKey(fileKey);
    if (contentHash === null) continue;
    const key = `${asset.mediaType}:${contentHash}`;
    if (!index.has(key)) index.set(key, asset.assetId);
  }
  return index;
};

/**
 * 引用解析（2026-10-26 口径）：
 * - 新快照的 media_refs 自带资产身份（提交面 `asset_id`）时优先由它构建——一次拿到资产、
 *   产品级用途（slot_id）与执行层字段键（field_key），不再靠内容指纹反推；
 * - reference_asset_ids 里未被 media_refs 覆盖的资产补在末尾（旧提交面仍只带 id）；
 * - 旧快照没有 asset_id 时沿用 reference_asset_ids 直接用；再旧时才由 media_refs 的
 *   fileKey 反查（attachment 引用的 value 是提交时资产 original.url，与 Editor assetReuse
 *   同思路；非 attachment 引用不对应画布资产，跳过并留痕）。
 */
const resolveReferences = (
  snapshot: BatchIntentSnapshot,
  projectPath: string,
  assets: CliGenerationArchiveAssetSource,
): CliGenerationArchiveReference[] => {
  const mediaRefs = snapshot.media_refs ?? [];
  const referenceAssetIds = snapshot.reference_asset_ids ?? [];
  const buildWithBinding = (
    assetId: string,
    binding: { fieldKey: string | undefined; slotId: string | undefined },
  ): CliGenerationArchiveReference => ({
    ...buildReferenceFromAsset(projectPath, assetId, assets),
    ...(binding.fieldKey ? { field_key: binding.fieldKey } : {}),
    ...(binding.slotId ? { slot_id: binding.slotId } : {}),
  });

  if (mediaRefs.some((ref) => typeof ref.asset_id === "string" && ref.asset_id.length > 0)) {
    const references: CliGenerationArchiveReference[] = [];
    const seen = new Set<string>();
    for (const ref of mediaRefs) {
      const assetId = ref.asset_id;
      if (typeof assetId !== "string" || assetId.length === 0 || seen.has(assetId)) continue;
      seen.add(assetId);
      references.push(
        buildWithBinding(assetId, {
          fieldKey: typeof ref.field_key === "string" ? ref.field_key : undefined,
          slotId: typeof ref.slot_id === "string" ? ref.slot_id : undefined,
        }),
      );
    }
    for (const assetId of referenceAssetIds) {
      if (seen.has(assetId)) continue;
      seen.add(assetId);
      references.push(buildReferenceFromAsset(projectPath, assetId, assets));
    }
    return references;
  }

  if (referenceAssetIds.length > 0) {
    return referenceAssetIds.map((assetId) => buildReferenceFromAsset(projectPath, assetId, assets));
  }
  if (mediaRefs.length === 0) return [];
  const contentKeyToAssetId = buildContentKeyIndex(assets.listAssets());
  const references: CliGenerationArchiveReference[] = [];
  for (const ref of mediaRefs) {
    if (ref.source_kind !== "attachment") {
      console.debug("[cli-generation-archive] media_ref 非 attachment 引用，不对应画布资产，跳过", {
        batchId: snapshot.batch_id,
        sourceKind: ref.source_kind,
      });
      continue;
    }
    const kind = TaskSubmitMediaKindSchema.safeParse(ref.media_kind);
    if (!kind.success) {
      console.debug("[cli-generation-archive] media_ref 媒体类型不在 image/video/audio 内，跳过", {
        batchId: snapshot.batch_id,
        mediaKind: ref.media_kind,
      });
      continue;
    }
    const refFileKey = extractMediaFileKey(ref.value);
    if (refFileKey === null || refFileKey.length === 0) {
      console.debug("[cli-generation-archive] media_ref 无法解析内容文件键，跳过", {
        batchId: snapshot.batch_id,
      });
      continue;
    }
    const refHash = extractContentHashFromFileKey(refFileKey);
    const assetId = refHash === null ? undefined : contentKeyToAssetId.get(`${kind.data}:${refHash}`);
    if (assetId === undefined) {
      console.debug("[cli-generation-archive] media_ref 内容指纹未命中资产注册表，跳过", {
        batchId: snapshot.batch_id,
        fileKey: refFileKey,
      });
      continue;
    }
    references.push(
      buildWithBinding(assetId, {
        fieldKey: typeof ref.field_key === "string" ? ref.field_key : undefined,
        slotId: undefined,
      }),
    );
  }
  return references;
};

/**
 * 模型参数快照（开放结构：键集合由模型目录的 parameter_schema 决定）。
 * 别名在此表达边界，避免在稳定业务区出现裸 Record<string, unknown>。
 */
type DynamicParamsMap = Record<string, unknown>;

/**
 * 剥离「已被媒体绑定占用」的参数键。
 *
 * 参数表单会把媒体位的默认值（空数组）一并写进快照；媒体真实内容走 media_refs。两处并存时
 * 档案里会出现「references 有 2 条、params.referenceImage 却是 []」的假事实。这里只剥掉
 * **确实有媒体绑定**的字段键（media_refs 的 field_key），未绑定的媒体位保持原样（空数组此时
 * 表达的是「没有媒体」，是准确事实）。
 */
const stripBoundMediaParams = (
  params: DynamicParamsMap,
  mediaRefs: readonly { field_key?: string | undefined }[],
): DynamicParamsMap => {
  const boundKeys = new Set(
    mediaRefs.map((ref) => ref.field_key).filter((key): key is string => typeof key === "string" && key.length > 0),
  );
  if (boundKeys.size === 0) return params;
  const stripped: DynamicParamsMap = {};
  for (const [key, value] of Object.entries(params)) {
    if (!boundKeys.has(key)) stripped[key] = value;
  }
  return stripped;
};

/**
 * 生成档案唯一构建出口：读快照（Zod parse）→ 引用解析 → 本地路径解析。
 * 快照形状非法（payload 损坏等）返回 null 并留痕，由调用方决定降级形态。
 */
export const buildGenerationArchive = (params: {
  projectPath: string;
  /** 受理时冻结的批次快照（存储读或 HTTP 读的原始载荷，统一在此过契约校验）。 */
  snapshot: unknown;
  assets: CliGenerationArchiveAssetSource;
}): CliGenerationArchive | null => {
  const parsed = BatchIntentSnapshotSchema.safeParse(params.snapshot);
  if (!parsed.success) {
    console.debug("[cli-generation-archive] 批次快照未通过受理快照契约校验，无法构建生成档案", {
      issue: parsed.error.message.slice(0, 200),
    });
    return null;
  }
  const snapshot = parsed.data;
  return {
    batch_id: snapshot.batch_id,
    model_id: snapshot.model_id,
    prompt: snapshot.prompt,
    params: stripBoundMediaParams(snapshot.params, snapshot.media_refs ?? []),
    references: resolveReferences(snapshot, params.projectPath, params.assets),
    task_ids: [...snapshot.task_ids],
    created_at: snapshot.created_at,
  };
};
