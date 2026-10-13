import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MediaAsset } from '@iart/contracts';
import { deriveContentAddressedAssetId } from './media-asset-id.cts';
import {
  ImageProcessingRequestSchema,
  ImageProcessingResultSchema,
  type ImageProcessingOperation,
  type ImageProcessingRequest,
  type ImageProcessingResult,
} from '@iart/contracts/media-processing-contract';
import {
  applyCrop,
  applySharpOps,
  applySobelEdgeDetect,
  applyChromaKey,
  buildSharpResizeOptions,
  loadImageSharp,
  writeBufferToSameDirDedup,
} from './image-processing.cts';
import { applyDifferenceKey } from './image-difference-key.cts';
import { createSmartSplitExecutor } from './smart-split-executor.cts';
import {
  buildImageProcessingRequestFromLegacyPayload as buildLegacyImageProcessingRequest,
} from './image-processing-legacy-input.cts';
import { resolveImageProcessingSource } from './image-processing-source-resolver.cts';
import { logWarn } from './logging.cts';
import { resolveLocalMediaUrl, resolveProjectRefByPath } from './project-media-scope.cts';
import { persistRuntimeMediaAsset } from './runtime-media-assets.cts';
import { repairProjectMediaAssetThumbnail } from './media-asset-registry.cts';

type MediaProcessingError = Error & {
  code: string | undefined;
  status: number | undefined;
};

const sharp = loadImageSharp();
const normalizeString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const createMediaProcessingError = (code: string, message: string, status = 400) => {
  const error: MediaProcessingError = new Error(message) as MediaProcessingError;
  error.code = code;
  error.status = status;
  return error;
};

const getErrorCode = (value: unknown): string => {
  if (!value || typeof value !== 'object') return '';
  if (!('code' in value)) return '';
  return normalizeString(value.code);
};

const getErrorStatus = (value: unknown): number => {
  if (!value || typeof value !== 'object' || !('status' in value)) return 500;
  const status = Number(value.status);
  return Number.isFinite(status) ? status : 500;
};

const normalizePercentList = (value: number[], maxLen: number, fieldName: string) => {
  if (value.length > maxLen) {
    throw createMediaProcessingError('SPLIT_TOO_MANY_LINES', `${fieldName} too many (max ${maxLen})`, 400);
  }
  const percents = [...value].sort((a, b) => a - b);
  let previous: number | null = null;
  for (const current of percents) {
    if (!Number.isFinite(current) || current <= 0 || current >= 100) {
      throw createMediaProcessingError('SPLIT_INVALID_LINES', `${fieldName} must be in (0, 100)`, 400);
    }
    if (previous !== null && current <= previous) {
      throw createMediaProcessingError('SPLIT_INVALID_LINES', `${fieldName} contains duplicate values`, 400);
    }
    previous = current;
  }
  return percents;
};

const toPixelStops = (percents: number[], totalPx: number, fieldName: string) => {
  const stops: number[] = [];
  for (const percent of percents) {
    const px = Math.round((percent / 100) * totalPx);
    if (!Number.isFinite(px) || px <= 0 || px >= totalPx) {
      throw createMediaProcessingError('SPLIT_LINE_OUT_OF_RANGE', `${fieldName} out of range`, 400);
    }
    stops.push(px);
  }
  for (let i = 1; i < stops.length; i += 1) {
    const current = stops[i];
    const previous = stops[i - 1];
    if (current === undefined || previous === undefined || current <= previous) {
      throw createMediaProcessingError('SPLIT_DUPLICATE_PIXEL', `${fieldName} produces duplicate pixel stops`, 400);
    }
  }
  return stops;
};

const getImageMimeTypeForExt = (ext: unknown) => {
  const normalized = normalizeString(ext).toLowerCase();
  if (normalized === '.jpg' || normalized === '.jpeg') return 'image/jpeg';
  if (normalized === '.webp') return 'image/webp';
  if (normalized === '.gif') return 'image/gif';
  if (normalized === '.avif') return 'image/avif';
  if (normalized === '.tif' || normalized === '.tiff') return 'image/tiff';
  return 'image/png';
};

const normalizeOutputExt = (ext: unknown) => {
  const normalized = normalizeString(ext).toLowerCase();
  if (!normalized) return '.png';
  return normalized.startsWith('.') ? normalized : `.${normalized}`;
};

const computeFileContentHash = async (filePath: string) => {
  const buffer = await fs.promises.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
};

const buildProcessedImageAsset = async (params: {
  projectPath: string;
  sourceUrl: string;
  fileKey: string;
  filePath: string;
  url: string;
  mimeType: string;
  width: number;
  height: number;
}): Promise<{ assetId: string; mediaAsset: MediaAsset }> => {
  const projectRef = resolveProjectRefByPath(params.projectPath);
  if (!projectRef) {
    throw createMediaProcessingError('INVALID_PROJECT', 'Invalid project ref', 500);
  }
  const contentHash = await computeFileContentHash(params.filePath);
  const stat = await fs.promises.stat(params.filePath);
  const assetId = deriveContentAddressedAssetId('image', contentHash);
  const now = Date.now();
  const mediaAsset: MediaAsset = {
    id: assetId,
    mediaType: 'image',
    original: {
      url: params.url,
      projectRef,
      fileKey: params.fileKey,
      sourceUrl: params.sourceUrl,
      sourceFileName: null,
      mimeType: params.mimeType,
      sizeBytes: Number.isFinite(stat.size) ? stat.size : null,
      width: params.width > 0 ? params.width : null,
      height: params.height > 0 ? params.height : null,
      durationMs: null,
      fps: null,
    },
    thumbnail: {
      url: null,
      mimeType: null,
      width: null,
      height: null,
      status: 'missing',
      generatedAt: null,
      error: null,
    },
    lifecycle: { createdAt: now, updatedAt: now },
  };
  return { assetId, mediaAsset };
};

const persistProcessedImageResult = async (params: {
  projectPath: string;
  sourceUrl: string;
  mediaDir: string;
  buffer: Buffer;
  ext: string;
  width: number;
  height: number;
}) => {
  const outputDir = path.join(params.mediaDir, 'processed');
  fs.mkdirSync(outputDir, { recursive: true });
  const output = writeBufferToSameDirDedup(params.buffer, params.ext, outputDir);
  const fileKey = path.posix.join('processed', output.filename);
  const projectRef = resolveProjectRefByPath(params.projectPath);
  if (!projectRef) {
    throw createMediaProcessingError('INVALID_PROJECT', 'Invalid project ref', 500);
  }
  const url = resolveLocalMediaUrl(projectRef, fileKey);
  if (!url) {
    throw createMediaProcessingError('INVALID_PROJECT', 'Invalid project media url', 500);
  }
  const { assetId, mediaAsset } = await buildProcessedImageAsset({
    projectPath: params.projectPath,
    sourceUrl: params.sourceUrl,
    fileKey,
    filePath: output.targetPath,
    url,
    mimeType: getImageMimeTypeForExt(params.ext),
    width: params.width,
    height: params.height,
  });
  const persisted = await persistRuntimeMediaAsset(params.projectPath, mediaAsset);
  if (!persisted) {
    throw createMediaProcessingError(
      'MEDIA_ASSET_PERSIST_FAILED',
      'Failed to persist processed media asset',
      500,
    );
  }
  repairProjectMediaAssetThumbnail(params.projectPath, {
    assetId,
    mediaType: 'image',
    maxEdge: undefined,
    quality: undefined,
    width: undefined,
    timeSec: undefined,
  }).catch((err: unknown) => {
    logWarn('[image-processing-executor] Thumbnail repair failed for asset', { assetId, error: err instanceof Error ? err.message : String(err) });
  });
  return {
    assetId,
    mediaAsset,
    url,
    width: params.width,
    height: params.height,
  };
};

const parseImageProcessingRequest = (payload: unknown): ImageProcessingRequest => {
  const result = ImageProcessingRequestSchema.safeParse(payload);
  if (result.success) return result.data;
  throw createMediaProcessingError('INVALID_PAYLOAD', result.error.message, 400);
};

const executeSingleImageOperation = async (params: {
  projectPath: string;
  sourceUrl: string;
  sourceFilePath: string;
  mediaDir: string;
  operation: Exclude<ImageProcessingOperation, { type: 'split' }>;
}): Promise<ImageProcessingResult> => {
  const { projectPath, sourceUrl, sourceFilePath, mediaDir, operation } = params;
  if (operation.type === 'resize') {
    if (!sharp) throw createMediaProcessingError('SHARP_NOT_AVAILABLE', 'Sharp library not installed', 501);
    const metadata = await sharp(sourceFilePath, undefined).metadata();
    const originalWidth = Number((metadata !== null && metadata !== undefined ? metadata.width : undefined)) || 0;
    const originalHeight = Number((metadata !== null && metadata !== undefined ? metadata.height : undefined)) || 0;
    if (!originalWidth || !originalHeight) {
      throw createMediaProcessingError('INVALID_IMAGE', 'Cannot read image dimensions', 400);
    }
    const percent = Math.round(operation.percent);
    const newWidth = Math.max(1, Math.round((originalWidth * percent) / 100));
    const newHeight = Math.max(1, Math.round((originalHeight * percent) / 100));
    const outputBuffer = await sharp(sourceFilePath, undefined)
      .resize(buildSharpResizeOptions(newWidth, newHeight, operation.kernel))
      .toBuffer();
    const persisted = await persistProcessedImageResult({
      projectPath,
      sourceUrl,
      mediaDir,
      buffer: outputBuffer,
      ext: normalizeOutputExt(path.extname(sourceFilePath)),
      width: newWidth,
      height: newHeight,
    });
    return ImageProcessingResultSchema.parse({
      resultType: 'single',
      operationType: 'resize',
      success: true,
      ...persisted,
      originalWidth,
      originalHeight,
      percent,
      kernel: operation.kernel,
    });
  }

  if (operation.type === 'crop') {
    const result = await applyCrop(sourceFilePath, { x: undefined, y: undefined, left: operation.x, top: operation.y, width: operation.width, height: operation.height, w: undefined, h: undefined });
    const width = (result.info !== null && result.info !== undefined ? result.info.width : undefined) || (result.meta !== null && result.meta !== undefined ? result.meta.width : undefined) || 0;
    const height = (result.info !== null && result.info !== undefined ? result.info.height : undefined) || (result.meta !== null && result.meta !== undefined ? result.meta.height : undefined) || 0;
    const persisted = await persistProcessedImageResult({
      projectPath,
      sourceUrl,
      mediaDir,
      buffer: result.buffer,
      ext: normalizeOutputExt(path.extname(sourceFilePath)),
      width,
      height,
    });
    return ImageProcessingResultSchema.parse({
      resultType: 'single',
      operationType: 'crop',
      success: true,
      ...persisted,
      originalWidth: Number((result.meta !== null && result.meta !== undefined ? result.meta.originalWidth : undefined) ?? 0) || 0,
      originalHeight: Number((result.meta !== null && result.meta !== undefined ? result.meta.originalHeight : undefined) ?? 0) || 0,
      x: Number((result.meta !== null && result.meta !== undefined ? result.meta.x : undefined) ?? 0) || 0,
      y: Number((result.meta !== null && result.meta !== undefined ? result.meta.y : undefined) ?? 0) || 0,
    });
  }

  if (operation.type === 'edgeDetect') {
    const result = await applySobelEdgeDetect(sourceFilePath, { threshold: operation.threshold, maxDimension: undefined });
    const width = (result.info !== null && result.info !== undefined ? result.info.width : undefined) || (result.meta !== null && result.meta !== undefined ? result.meta.width : undefined) || 0;
    const height = (result.info !== null && result.info !== undefined ? result.info.height : undefined) || (result.meta !== null && result.meta !== undefined ? result.meta.height : undefined) || 0;
    const persisted = await persistProcessedImageResult({
      projectPath,
      sourceUrl,
      mediaDir,
      buffer: result.buffer,
      ext: '.png',
      width,
      height,
    });
    return ImageProcessingResultSchema.parse({
      resultType: 'single',
      operationType: 'edgeDetect',
      success: true,
      ...persisted,
      mode: 'sobel',
      threshold: operation.threshold,
    });
  }

  if (operation.type === 'chromaKey') {
    if (!sharp) throw createMediaProcessingError('SHARP_NOT_AVAILABLE', 'Sharp library not installed', 501);
    const result = await applyChromaKey(sourceFilePath, {
      targetColor: operation.targetColor,
      tolerance: operation.tolerance,
      feather: operation.feather,
    });
    const width = result.info.width || 0;
    const height = result.info.height || 0;
    const persisted = await persistProcessedImageResult({
      projectPath, sourceUrl, mediaDir,
      buffer: result.buffer,
      ext: '.png',
      width, height,
    });
    return ImageProcessingResultSchema.parse({
      resultType: 'single',
      operationType: 'chromaKey',
      success: true,
      ...persisted,
      targetColor: operation.targetColor,
      tolerance: operation.tolerance,
      feather: operation.feather,
    });
  }

  if (operation.type === 'differenceKey') {
    if (!sharp) throw createMediaProcessingError('SHARP_NOT_AVAILABLE', 'Sharp library not installed', 501);
    // 解析第二图(背景B)。复用顶层 source 的解析器,它接受 local-media:// URL。
    const secondResolved = resolveImageProcessingSource(projectPath, operation.secondSource.url);
    let diffResult: { buffer: Buffer; info: { width: number; height: number } };
    try {
      diffResult = await applyDifferenceKey(sourceFilePath, secondResolved.sourceFilePath, {
        threshold: operation.threshold,
        softness: operation.softness,
      });
    } catch (error) {
      const code = getErrorCode(error);
      if (code === 'DIFFERENCE_KEY_SIZE_MISMATCH') {
        throw createMediaProcessingError(
          'DIFFERENCE_KEY_SIZE_MISMATCH',
          error instanceof Error ? error.message : 'Both images must have identical dimensions for difference keying',
          400,
        );
      }
      throw error;
    }
    const width = diffResult.info.width || 0;
    const height = diffResult.info.height || 0;
    const persisted = await persistProcessedImageResult({
      projectPath, sourceUrl, mediaDir,
      buffer: diffResult.buffer,
      ext: '.png',
      width, height,
    });
    return ImageProcessingResultSchema.parse({
      resultType: 'single',
      operationType: 'differenceKey',
      success: true,
      ...persisted,
      threshold: operation.threshold,
      softness: operation.softness,
    });
  }

  if (operation.type === 'transform') {
    const result = await applySharpOps(sourceFilePath, operation.ops);
    const width = (result.info !== null && result.info !== undefined ? result.info.width : undefined) || 0;
    const height = (result.info !== null && result.info !== undefined ? result.info.height : undefined) || 0;
    const persisted = await persistProcessedImageResult({
      projectPath,
      sourceUrl,
      mediaDir,
      buffer: result.buffer,
      ext: normalizeOutputExt(path.extname(sourceFilePath)),
      width,
      height,
    });
    return ImageProcessingResultSchema.parse({
      resultType: 'single',
      operationType: 'transform',
      success: true,
      ...persisted,
    });
  }

  throw createMediaProcessingError('UNSUPPORTED_OPERATION', `Unsupported image operation type: ${(operation as { type: string }).type}`, 400);
};

const executeSplitImageOperation = async (params: {
  projectPath: string;
  sourceUrl: string;
  sourceFilePath: string;
  mediaDir: string;
  operation: Extract<ImageProcessingOperation, { type: 'split' }>;
}): Promise<ImageProcessingResult> => {
  const { projectPath, sourceUrl, sourceFilePath, mediaDir, operation } = params;
  if (!sharp) throw createMediaProcessingError('SHARP_NOT_AVAILABLE', 'Sharp library not installed', 501);
  const horizontalPercents = normalizePercentList(operation.horizontalPercents, 4, 'horizontalPercents');
  const verticalPercents = normalizePercentList(operation.verticalPercents, 4, 'verticalPercents');
  const metadata = await sharp(sourceFilePath, undefined).metadata();
  const originalWidth = (metadata !== null && metadata !== undefined ? metadata.width : undefined) || 0;
  const originalHeight = (metadata !== null && metadata !== undefined ? metadata.height : undefined) || 0;
  if (!originalWidth || !originalHeight) {
    throw createMediaProcessingError('INVALID_IMAGE', 'Cannot read image dimensions', 400);
  }
  const xStops = [0, ...toPixelStops(verticalPercents, originalWidth, 'verticalPercents'), originalWidth];
  const yStops = [0, ...toPixelStops(horizontalPercents, originalHeight, 'horizontalPercents'), originalHeight];
  const cols = xStops.length - 1;
  const rows = yStops.length - 1;
  const tileCount = rows * cols;
  if (rows > 5 || cols > 5 || tileCount > 25) {
    throw createMediaProcessingError('SPLIT_LIMIT_EXCEEDED', 'Split limit exceeded (max 5x5=25)', 400);
  }

  const basePipeline = sharp(sourceFilePath, undefined);
  const tiles: Array<{
    index: number;
    row: number;
    col: number;
    assetId: string;
    mediaAsset: MediaAsset;
    url: string;
    width: number;
    height: number;
    x: number;
    y: number;
  }> = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const left = xStops[col] ?? 0;
      const top = yStops[row] ?? 0;
      const nextX = xStops[col + 1] ?? originalWidth;
      const nextY = yStops[row + 1] ?? originalHeight;
      const width = nextX - left;
      const height = nextY - top;
      if (width <= 0 || height <= 0) {
        throw createMediaProcessingError('SPLIT_INVALID_GRID', 'Invalid split grid', 400);
      }
      const { data, info } = await basePipeline.clone().extract({ left, top, width, height }).toBuffer({ resolveWithObject: true });
      const persisted = await persistProcessedImageResult({
        projectPath,
        sourceUrl,
        mediaDir,
        buffer: data,
        ext: normalizeOutputExt(path.extname(sourceFilePath)),
        width: (info !== null && info !== undefined ? info.width : undefined) || width,
        height: (info !== null && info !== undefined ? info.height : undefined) || height,
      });
      tiles.push({
        index: tiles.length,
        row,
        col,
        ...persisted,
        x: left,
        y: top,
      });
    }
  }
  return ImageProcessingResultSchema.parse({
    resultType: 'split',
    operationType: 'split',
    success: true,
    rows,
    cols,
    tiles,
    originalWidth,
    originalHeight,
    horizontalPercents,
    verticalPercents,
  });
};

const executeSmartSplitImageOperation = createSmartSplitExecutor({
  sharp,
  persistProcessedImageResult,
  createMediaProcessingError,
});

const executeImageProcessing = async (
  projectPath: unknown,
  payload: unknown,
): Promise<ImageProcessingResult> => {
  const request = parseImageProcessingRequest(payload);
  const resolved = resolveImageProcessingSource(projectPath, request.source.url);
  try {
    if (request.operation.type === 'split') {
      return await executeSplitImageOperation({
        projectPath: resolved.projectPath,
        sourceUrl: resolved.sourceUrl,
        sourceFilePath: resolved.sourceFilePath,
        mediaDir: resolved.mediaDir,
        operation: request.operation,
      });
    }
    if (request.operation.type === 'smartSplit') {
      return await executeSmartSplitImageOperation({
        projectPath: resolved.projectPath,
        sourceUrl: resolved.sourceUrl,
        sourceFilePath: resolved.sourceFilePath,
        mediaDir: resolved.mediaDir,
        operation: request.operation,
      });
    }
    return await executeSingleImageOperation({
      projectPath: resolved.projectPath,
      sourceUrl: resolved.sourceUrl,
      sourceFilePath: resolved.sourceFilePath,
      mediaDir: resolved.mediaDir,
      operation: request.operation,
    });
  } catch (error) {
    const code = getErrorCode(error);
    if (code === 'SHARP_NOT_AVAILABLE') {
      throw createMediaProcessingError('SHARP_NOT_AVAILABLE', 'Sharp library not installed', 501);
    }
    if (code) {
      throw createMediaProcessingError(
        code,
        error instanceof Error ? error.message : String(error),
        getErrorStatus(error),
      );
    }
    throw error;
  }
};

const buildImageProcessingRequestFromLegacyPayload = (
  payload: unknown,
  operationType: ImageProcessingOperation['type'],
): ImageProcessingRequest =>
  buildLegacyImageProcessingRequest(
    payload,
    operationType,
    (code, message, status) => createMediaProcessingError(code, message, status ?? 400),
  );

export {
  buildImageProcessingRequestFromLegacyPayload,
  createMediaProcessingError,
  executeImageProcessing,
};
