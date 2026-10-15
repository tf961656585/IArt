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
 * 引用解析口径（2026-10-15 拍板）：
 * - 快照带 reference_asset_ids 时优先直接用；
 * - 否则由 media_refs 的 fileKey 推导资产 id——复用既有推导（Editor assetReuse 的 fileKey
 *   反查思路 + asset get 等价类的「同媒体类型 + 同内容指纹」判据，判据解析单一入口
 *   extractContentHashFromFileKey，资产 id 公式文档源 docs/architecture/contracts/storage-schema.md，
 *   不在此内联公式）；
 * - 能查到资产实体就附媒体类型、文件键与本地文件路径（复用 asset get 现有实体读取与
 *   resolveLocalMediaFilePath 路径解析），查不到只给 asset_id；
 * - media_refs 缺省时 references 为空数组。
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
 * 引用解析：reference_asset_ids 优先直接用；旧快照无该字段时由 media_refs 反查兜底
 * （attachment 引用的 value 是提交时资产 original.url，与 Editor assetReuse 同思路；
 * 非 attachment 引用不对应画布资产，跳过并留痕）。
 */
const resolveReferences = (
  snapshot: BatchIntentSnapshot,
  projectPath: string,
  assets: CliGenerationArchiveAssetSource,
): CliGenerationArchiveReference[] => {
  if (snapshot.reference_asset_ids !== undefined && snapshot.reference_asset_ids.length > 0) {
    return snapshot.reference_asset_ids.map((assetId) => buildReferenceFromAsset(projectPath, assetId, assets));
  }
  const mediaRefs = snapshot.media_refs ?? [];
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
    references.push(buildReferenceFromAsset(projectPath, assetId, assets));
  }
  return references;
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
    params: snapshot.params,
    references: resolveReferences(snapshot, params.projectPath, params.assets),
    task_ids: [...snapshot.task_ids],
    created_at: snapshot.created_at,
  };
};
