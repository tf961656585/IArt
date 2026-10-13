import * as z from 'zod';
import type { MediaAsset } from './project-dto';

export const ImageProcessingSourceSchema = z.object({
  type: z.literal('media-url'),
  url: z.string().min(1),
}).strict();

export const ImageProcessingTransformOpSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mirrorX') }).strict(),
  z.object({ type: z.literal('mirrorY') }).strict(),
  z.object({ type: z.literal('rotate'), deg: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]) }).strict(),
]);

export const ResizeKernelSchema = z.enum(['lanczos3', 'nearest']);

export const ImageProcessingOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('resize'), percent: z.number().min(10).max(100), kernel: ResizeKernelSchema.default('lanczos3') }).strict(),
  z.object({
    type: z.literal('crop'),
    x: z.number().min(0),
    y: z.number().min(0),
    width: z.number().positive(),
    height: z.number().positive(),
  }).strict(),
  z.object({
    type: z.literal('split'),
    horizontalPercents: z.array(z.number().gt(0).lt(100)).max(4),
    verticalPercents: z.array(z.number().gt(0).lt(100)).max(4),
  }).strict(),
  z.object({
    type: z.literal('edgeDetect'),
    mode: z.literal('sobel'),
    threshold: z.number().min(0).max(255),
  }).strict(),
  z.object({
    type: z.literal('transform'),
    ops: z.array(ImageProcessingTransformOpSchema).min(1),
  }).strict(),
  z.object({
    type: z.literal('chromaKey'),
    targetColor: z.object({
      r: z.number().min(0).max(255),
      g: z.number().min(0).max(255),
      b: z.number().min(0).max(255),
    }).strict(),
    tolerance: z.number().min(0).max(100),
    feather: z.number().min(0).max(20),
  }).strict(),
  z.object({
    type: z.literal('differenceKey'),
    secondSource: ImageProcessingSourceSchema,
    threshold: z.number().min(0).max(100),
    softness: z.number().min(0).max(50),
  }).strict(),
  z.object({
    type: z.literal('smartSplit'),
    alphaThreshold: z.number().int().min(1).max(254).default(1),
    minArea: z.number().int().min(1).default(100),
    dilateIterations: z.number().int().min(0).max(10).default(2),
    padding: z.number().int().min(0).max(50).default(4),
  }).strict(),
]);

export const ImageProcessingRequestSchema = z.object({
  source: ImageProcessingSourceSchema,
  operation: ImageProcessingOperationSchema,
}).strict();

export const ImageProcessingMediaAssetOriginalSchema = z.object({
  url: z.string().min(1),
  // 当前保留宽松校验：测试 fixture（media-processing-contract.test.ts 等）使用 'prj_demo' 等短值。
  // 新代码消费 scope 时应使用 ScopeRefSchema（packages/contracts/src/local-media-scope.ts）严格校验。
  // 待 fixture 全部迁移到合规 prj_[a-f0-9]{32} 前缀后，收紧为 ProjectRefSchema.nullable()。
  projectRef: z.string().min(1).nullable(),
  fileKey: z.string().min(1).nullable(),
  sourceUrl: z.string().min(1).nullable(),
  /** 导入素材的原始文件名；媒体工具加工产物与旧库数据为 null/缺省（2026-10-07 素材检索底座）。default 保旧载荷兼容且推导必填键。 */
  sourceFileName: z.string().min(1).nullable().default(null),
  mimeType: z.string().min(1).nullable(),
  sizeBytes: z.number().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  durationMs: z.number().nullable(),
  fps: z.number().nullable(),
}).strict();

export const ImageProcessingMediaAssetThumbnailErrorSchema = z.object({
  code: z.string().nullable(),
  message: z.string().nullable(),
  failedAt: z.number().nullable(),
}).strict();

export const ImageProcessingMediaAssetThumbnailSchema = z.object({
  url: z.string().nullable(),
  mimeType: z.string().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  status: z.enum(['missing', 'generating', 'ready', 'stale', 'failed']),
  generatedAt: z.number().nullable(),
  error: ImageProcessingMediaAssetThumbnailErrorSchema.nullable(),
}).strict();

export const ImageProcessingMediaAssetLifecycleSchema = z.object({
  createdAt: z.number(),
  updatedAt: z.number(),
}).strict();

export const ImageProcessingMediaAssetSchema = z.object({
  id: z.string().min(1),
  mediaType: z.enum(['image', 'video', 'audio']),
  original: ImageProcessingMediaAssetOriginalSchema,
  thumbnail: ImageProcessingMediaAssetThumbnailSchema,
  lifecycle: ImageProcessingMediaAssetLifecycleSchema,
}).strict();

const ImageProcessingSingleResultBaseSchema = z.object({
  resultType: z.literal('single'),
  success: z.literal(true),
  assetId: z.string().min(1),
  mediaAsset: ImageProcessingMediaAssetSchema,
  url: z.string().min(1),
  width: z.number(),
  height: z.number(),
});

export const ImageProcessingSingleResultSchema = z.discriminatedUnion('operationType', [
  ImageProcessingSingleResultBaseSchema.extend({
    operationType: z.literal('resize'),
    originalWidth: z.number(),
    originalHeight: z.number(),
    percent: z.number(),
    kernel: ResizeKernelSchema,
  }).strict(),
  ImageProcessingSingleResultBaseSchema.extend({
    operationType: z.literal('crop'),
    originalWidth: z.number(),
    originalHeight: z.number(),
    x: z.number(),
    y: z.number(),
  }).strict(),
  ImageProcessingSingleResultBaseSchema.extend({
    operationType: z.literal('edgeDetect'),
    mode: z.literal('sobel'),
    threshold: z.number(),
  }).strict(),
  ImageProcessingSingleResultBaseSchema.extend({
    operationType: z.literal('transform'),
  }).strict(),
  ImageProcessingSingleResultBaseSchema.extend({
    operationType: z.literal('chromaKey'),
    targetColor: z.object({ r: z.number(), g: z.number(), b: z.number() }),
    tolerance: z.number(),
    feather: z.number(),
  }).strict(),
  ImageProcessingSingleResultBaseSchema.extend({
    operationType: z.literal('differenceKey'),
    threshold: z.number(),
    softness: z.number(),
  }).strict(),
]);

export const ImageProcessingSplitTileSchema = z.object({
  index: z.number(),
  row: z.number(),
  col: z.number(),
  assetId: z.string().min(1),
  mediaAsset: ImageProcessingMediaAssetSchema,
  url: z.string().min(1),
  width: z.number(),
  height: z.number(),
  x: z.number(),
  y: z.number(),
}).strict();

export const ImageProcessingSplitResultSchema = z.object({
  resultType: z.literal('split'),
  operationType: z.literal('split'),
  success: z.literal(true),
  rows: z.number(),
  cols: z.number(),
  tiles: z.array(ImageProcessingSplitTileSchema).min(1),
  originalWidth: z.number(),
  originalHeight: z.number(),
  horizontalPercents: z.array(z.number()),
  verticalPercents: z.array(z.number()),
}).strict();

export const ImageSmartSplitTileSchema = z.object({
  index: z.number(),
  assetId: z.string().min(1),
  mediaAsset: ImageProcessingMediaAssetSchema,
  url: z.string().min(1),
  width: z.number(),
  height: z.number(),
  x: z.number(),
  y: z.number(),
}).strict();

export const ImageProcessingSmartSplitResultSchema = z.object({
  resultType: z.literal('smartSplit'),
  operationType: z.literal('smartSplit'),
  success: z.literal(true),
  tiles: z.array(ImageSmartSplitTileSchema).min(1).max(50),
  originalWidth: z.number(),
  originalHeight: z.number(),
  tileCount: z.number(),
}).strict();

export const ImageProcessingResultSchema = z.union([
  ImageProcessingSingleResultSchema,
  ImageProcessingSplitResultSchema,
  ImageProcessingSmartSplitResultSchema,
]);

export type ImageProcessingTransformOp = z.infer<typeof ImageProcessingTransformOpSchema>;
export type ResizeKernel = z.infer<typeof ResizeKernelSchema>;
export type ImageProcessingOperation = z.infer<typeof ImageProcessingOperationSchema>;
export type ImageProcessingSource = z.infer<typeof ImageProcessingSourceSchema>;
export type ImageProcessingRequest = z.infer<typeof ImageProcessingRequestSchema>;
export type ImageProcessingMediaAsset = MediaAsset;
export type ImageProcessingSingleResult = z.infer<typeof ImageProcessingSingleResultSchema>;
export type ImageProcessingSplitTile = z.infer<typeof ImageProcessingSplitTileSchema>;
export type ImageProcessingSplitResult = z.infer<typeof ImageProcessingSplitResultSchema>;
export type ImageSmartSplitTile = z.infer<typeof ImageSmartSplitTileSchema>;
export type ImageProcessingSmartSplitResult = z.infer<typeof ImageProcessingSmartSplitResultSchema>;
export type ImageProcessingResult = z.infer<typeof ImageProcessingResultSchema>;

// ---------------------------------------------------------------------------
// Video Sprite Sheet — 独立于 ImageProcessing 的视频序列帧图集契约
// ---------------------------------------------------------------------------

/** 视频序列帧图集布局计算结果（前后端共享） */
export const SpriteSheetLayoutSchema = z.object({
  frameCount: z.number(),
  rows: z.number(),
  cols: z.number(),
  frameWidth: z.number(),
  frameHeight: z.number(),
  atlasWidth: z.number(),
  atlasHeight: z.number(),
}).strict();

/** 视频序列帧图集操作参数 */
export const VideoSpriteSheetOperationSchema = z.object({
  startTime: z.number().min(0),
  endTime: z.number().min(0),
  fpsMultiplier: z.number().min(0).max(1),
}).strict().refine((data) => data.endTime > data.startTime, {
  message: 'endTime must be greater than startTime',
});

/** 视频序列帧图集请求 */
export const VideoSpriteSheetRequestSchema = z.object({
  source: ImageProcessingSourceSchema,
  operation: VideoSpriteSheetOperationSchema,
}).strict();

/** 视频序列帧图集结果 */
export const VideoSpriteSheetResultSchema = z.object({
  frameCount: z.number(),
  rows: z.number(),
  cols: z.number(),
  frameWidth: z.number(),
  frameHeight: z.number(),
  atlasWidth: z.number(),
  atlasHeight: z.number(),
  outputUrl: z.string(),
  assetId: z.string().min(1),
  mediaAsset: ImageProcessingMediaAssetSchema,
}).strict();

export type SpriteSheetLayout = z.infer<typeof SpriteSheetLayoutSchema>;
export type VideoSpriteSheetOperation = z.infer<typeof VideoSpriteSheetOperationSchema>;
export type VideoSpriteSheetRequest = z.infer<typeof VideoSpriteSheetRequestSchema>;
export type VideoSpriteSheetResult = z.infer<typeof VideoSpriteSheetResultSchema>;
