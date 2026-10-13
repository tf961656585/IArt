import * as z from 'zod';
import { RuntimeMediaAssetViewSchema } from './runtime-transaction';

// ────────────────────────────────────────────
// 打包区（Package Area）— 画布级素材归集工作区
// ────────────────────────────────────────────
//
// 语义（spec「右侧工作区与打包区服务」）：
// - 打包区是画布级独立创作对象，每个画布有且只有一个打包区；graphId 1:1 打包区
// - 打包区条目是有序的媒体资产引用集合（assetId 锚点），不持有媒体文件 owner 语义
// - 同一画布内同一 assetId 至多一个条目（add-entries 由写入端去重）
// - 无条目即空打包区，不存在独立“打包区记录行”，无生命周期补齐链路

export const PackageAreaMediaTypeSchema = z.enum(['image', 'video', 'audio']);

/** 打包区条目（写入侧原始形状；mediaType 取添加时来源资产的媒体类型，资产缺失时占位展示用）。 */
export const PackageAreaEntrySchema = z
  .object({
    packageEntryId: z.string().min(1),
    graphId: z.string().min(1),
    order: z.number().int(),
    assetId: z.string().min(1),
    mediaType: PackageAreaMediaTypeSchema,
  })
  .strict();

/**
 * 打包区媒体引用解析结果。
 *
 * 非三态约束（spec「右侧工作区与打包区服务」失效引用判定边界）：
 * - `isMissing === true` 当且仅当 `mediaAsset === null`
 * - `isMissing === false` 当且仅当 `mediaAsset` 存在
 * - 禁止出现「未缺失但无可消费媒体结果」或「缺失但 mediaAsset 存在」的第三态
 *
 * 该约束是运行时不变量，Zod schema 层面无法直接表达，实现层（storage read）必须保证
 * 二者一致性。`isMissing` 不持久化，只在 read 链路判定。
 */
export const PackageAreaResolvedMediaSchema = z
  .object({
    assetId: z.string().min(1),
    mediaType: PackageAreaMediaTypeSchema,
    isMissing: z.boolean(),
    mediaAsset: RuntimeMediaAssetViewSchema.nullable(),
  })
  .strict();

/** 打包区条目视图（resolved：含 isMissing/mediaAsset 判定与 createdAt 展示字段）。 */
export const PackageAreaEntryViewSchema = z
  .object({
    packageEntryId: z.string().min(1),
    graphId: z.string().min(1),
    order: z.number().int(),
    assetId: z.string().min(1),
    mediaType: PackageAreaMediaTypeSchema,
    createdAt: z.number().int(),
    asset: PackageAreaResolvedMediaSchema,
  })
  .strict();

export const PackageAreaViewSchema = z
  .object({
    graphId: z.string().min(1),
    entries: z.array(PackageAreaEntryViewSchema),
  })
  .strict();

export const StorageReadPackageAreaByGraphIdParamsSchema = z
  .object({
    projectPath: z.string(),
    graphId: z.string().min(1),
  })
  .strict();

export const StorageReadPackageAreaByGraphIdResultSchema = z
  .object({
    packageArea: PackageAreaViewSchema,
  })
  .strict();

// ────────────────────────────────────────────
// 打包区命令式 mutation 契约（写入 DTO）
// ────────────────────────────────────────────
//
// 设计要点（spec「右侧工作区与打包区服务」写入契约）：
// - 打包区正式写入采用命令式 mutation 口径，Renderer 只提交明确编辑意图
// - 每个 mutation 是 discriminated union 成员，用 `action` 字段判别
// - mutation request 统一包含 projectPath / graphId / mutation
// - mutation result 统一返回更新后的 PackageAreaView（canonical 排序后的完整投影）
// - 写入入参用原始形状（assetId + mediaType），不含 isMissing/mediaAsset；
//   读取 / mutation response 用 resolved PackageAreaView

export const PackageAreaEntryInputSchema = z
  .object({
    assetId: z.string().min(1),
    mediaType: PackageAreaMediaTypeSchema,
  })
  .strict();

export const PackageAreaAddEntriesMutationSchema = z
  .object({
    action: z.literal('add-entries'),
    entries: z.array(PackageAreaEntryInputSchema).min(1),
  })
  .strict();

export const PackageAreaRemoveEntriesMutationSchema = z
  .object({
    action: z.literal('remove-entries'),
    packageEntryIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const PackageAreaReorderEntriesMutationSchema = z
  .object({
    action: z.literal('reorder-entries'),
    orderedEntryIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const PackageAreaMutationSchema = z.discriminatedUnion('action', [
  PackageAreaAddEntriesMutationSchema,
  PackageAreaRemoveEntriesMutationSchema,
  PackageAreaReorderEntriesMutationSchema,
]);

export const PackageAreaMutationRequestSchema = z
  .object({
    projectPath: z.string(),
    graphId: z.string().min(1),
    mutation: PackageAreaMutationSchema,
  })
  .strict();

export const PackageAreaMutationResultSchema = z
  .object({
    packageArea: PackageAreaViewSchema,
  })
  .strict();

// ────────────────────────────────────────────
// 包管理（执行打包产物：项目路径 packages/ 下的自描述包文件夹）
// ────────────────────────────────────────────
//
// 语义（spec「右侧工作区与打包区服务」导出包节）：
// - 执行一次打包 = 在 {projectPath}/packages/{folderName}/ 落一个包文件夹
// - 包文件夹是自描述事实源：manifest（package.json）承载包名与条目清单
// - 包文件夹可整体拷走，脱离项目仍可读；不回写项目、不参与编辑域
// - 包管理（list/rename/delete/reveal）只读或操作文件系统，不入 SQLite

/** 项目内包文件夹的固定父目录名。 */
export const PACKAGE_FOLDER_DIRNAME = 'packages';
/** 包文件夹内自描述 manifest 的固定文件名。 */
export const PACKAGE_MANIFEST_FILENAME = 'package.json';

export const PackageManifestSchema = z
  .object({
    packageId: z.string().min(1),
    name: z.string().min(1),
    createdAt: z.number().int(),
    entries: z.array(
      z
        .object({
          assetId: z.string().min(1),
          mediaType: PackageAreaMediaTypeSchema,
          /** 打包时来源媒体在 {projectPath}/media/ 内的 fileKey（溯源用）。 */
          sourceFileKey: z.string().min(1),
          /** 包文件夹内的实际文件名（{order}_{fileKey}）。 */
          fileName: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

/** 包内单个媒体文件的预览条目（url 由 Main 进程按 package-media 协议构建）。 */
export const PackageMediaPreviewSchema = z
  .object({
    fileName: z.string().min(1),
    mediaType: PackageAreaMediaTypeSchema,
    url: z.string().min(1),
  })
  .strict();

export const PackageSummarySchema = z
  .object({
    packageId: z.string().min(1),
    name: z.string().min(1),
    folderName: z.string().min(1),
    /** 包文件夹绝对路径（Finder 定位用）。 */
    path: z.string().min(1),
    createdAt: z.number().int(),
    entryCount: z.number().int().nonnegative(),
    entries: z.array(PackageMediaPreviewSchema),
  })
  .strict();

export const PackagesListParamsSchema = z
  .object({
    projectPath: z.string(),
  })
  .strict();

export const PackagesListResultSchema = z
  .object({
    packages: z.array(PackageSummarySchema),
  })
  .strict();

export const PackagesCreateParamsSchema = z
  .object({
    projectPath: z.string(),
    name: z.string().min(1).max(80),
    /** 有序 assetId（顺序即包内顺序）；失效资产在 Main 端跳过并回告。 */
    assetIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const PackagesCreateResultSchema = z
  .object({
    /** 全部资产失效时为 null（未落包）。 */
    package: PackageSummarySchema.nullable(),
    skippedAssetIds: z.array(z.string().min(1)),
  })
  .strict();

export const PackagesRenameParamsSchema = z
  .object({
    projectPath: z.string(),
    packageId: z.string().min(1),
    name: z.string().min(1).max(80),
  })
  .strict();

export const PackagesRenameResultSchema = z
  .object({
    package: PackageSummarySchema,
  })
  .strict();

export const PackagesDeleteParamsSchema = z
  .object({
    projectPath: z.string(),
    packageId: z.string().min(1),
  })
  .strict();

export const PackagesDeleteResultSchema = z
  .object({
    ok: z.boolean(),
  })
  .strict();

export const PackagesRevealParamsSchema = z
  .object({
    projectPath: z.string(),
    packageId: z.string().min(1),
  })
  .strict();

export const PackagesRevealResultSchema = z
  .object({
    ok: z.boolean(),
  })
  .strict();

export const PACKAGE_IPC_CHANNELS = {
  LIST_PACKAGES: 'packages:list',
  CREATE_PACKAGE: 'packages:create',
  RENAME_PACKAGE: 'packages:rename',
  DELETE_PACKAGE: 'packages:delete',
  REVEAL_PACKAGE: 'packages:reveal',
} as const;

export type PackageAreaMediaType = z.infer<typeof PackageAreaMediaTypeSchema>;
export type PackageAreaEntry = z.infer<typeof PackageAreaEntrySchema>;
export type PackageAreaEntryInput = z.infer<typeof PackageAreaEntryInputSchema>;
export type PackageAreaResolvedMedia = z.infer<typeof PackageAreaResolvedMediaSchema>;
export type PackageAreaEntryView = z.infer<typeof PackageAreaEntryViewSchema>;
export type PackageAreaView = z.infer<typeof PackageAreaViewSchema>;
export type StorageReadPackageAreaByGraphIdParams = z.infer<
  typeof StorageReadPackageAreaByGraphIdParamsSchema
>;
export type StorageReadPackageAreaByGraphIdResult = z.infer<
  typeof StorageReadPackageAreaByGraphIdResultSchema
>;
export type PackageAreaAddEntriesMutation = z.infer<typeof PackageAreaAddEntriesMutationSchema>;
export type PackageAreaRemoveEntriesMutation = z.infer<
  typeof PackageAreaRemoveEntriesMutationSchema
>;
export type PackageAreaReorderEntriesMutation = z.infer<
  typeof PackageAreaReorderEntriesMutationSchema
>;
export type PackageAreaMutation = z.infer<typeof PackageAreaMutationSchema>;
export type PackageAreaMutationRequest = z.infer<typeof PackageAreaMutationRequestSchema>;
export type PackageAreaMutationResult = z.infer<typeof PackageAreaMutationResultSchema>;
export type PackageManifest = z.infer<typeof PackageManifestSchema>;
export type PackageMediaPreview = z.infer<typeof PackageMediaPreviewSchema>;
export type PackageSummary = z.infer<typeof PackageSummarySchema>;
export type PackagesListParams = z.infer<typeof PackagesListParamsSchema>;
export type PackagesListResult = z.infer<typeof PackagesListResultSchema>;
export type PackagesCreateParams = z.infer<typeof PackagesCreateParamsSchema>;
export type PackagesCreateResult = z.infer<typeof PackagesCreateResultSchema>;
export type PackagesRenameParams = z.infer<typeof PackagesRenameParamsSchema>;
export type PackagesRenameResult = z.infer<typeof PackagesRenameResultSchema>;
export type PackagesDeleteParams = z.infer<typeof PackagesDeleteParamsSchema>;
export type PackagesDeleteResult = z.infer<typeof PackagesDeleteResultSchema>;
export type PackagesRevealParams = z.infer<typeof PackagesRevealParamsSchema>;
export type PackagesRevealResult = z.infer<typeof PackagesRevealResultSchema>;
