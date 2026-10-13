import type { MediaAsset } from '@iart/contracts';
import {
  ImageProcessingResultSchema,
  type ImageProcessingOperation,
  type ImageProcessingResult,
} from '@iart/contracts/media-processing-contract';
import type { ImageSharpFactory } from './image-processing.cts';
import { binarizeAlpha, dilateBinary, detectConnectedComponents } from './smart-split-algorithm.cts';

type PersistResult = {
  assetId: string;
  mediaAsset: MediaAsset;
  url: string;
  width: number;
  height: number;
};

type SmartSplitDeps = {
  sharp: ImageSharpFactory | null;
  persistProcessedImageResult: (params: {
    projectPath: string;
    sourceUrl: string;
    mediaDir: string;
    buffer: Buffer;
    ext: string;
    width: number;
    height: number;
  }) => Promise<PersistResult>;
  createMediaProcessingError: (code: string, message: string, status: number | undefined) => Error & { code: string | undefined; status: number | undefined };
};

export const createSmartSplitExecutor = (deps: SmartSplitDeps) => {
  const { sharp, persistProcessedImageResult, createMediaProcessingError } = deps;

  return async (params: {
    projectPath: string;
    sourceUrl: string;
    sourceFilePath: string;
    mediaDir: string;
    operation: Extract<ImageProcessingOperation, { type: 'smartSplit' }>;
  }): Promise<ImageProcessingResult> => {
    const { projectPath, sourceUrl, sourceFilePath, mediaDir, operation } = params;
    if (!sharp) throw createMediaProcessingError('SHARP_NOT_AVAILABLE', 'Sharp library not installed', 501);

    const metadata = await sharp(sourceFilePath, undefined).metadata();
    const originalWidth = (metadata !== null && metadata !== undefined ? metadata.width : undefined) || 0;
    const originalHeight = (metadata !== null && metadata !== undefined ? metadata.height : undefined) || 0;
    if (!originalWidth || !originalHeight) {
      throw createMediaProcessingError('INVALID_IMAGE', 'Cannot read image dimensions', 400);
    }

    const { data: rawData } = await sharp(sourceFilePath, undefined)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const binary = binarizeAlpha(rawData, originalWidth, originalHeight, operation.alphaThreshold);
    const dilated = dilateBinary(binary, originalWidth, originalHeight, operation.dilateIterations);
    const boundingBoxes = detectConnectedComponents(dilated, originalWidth, originalHeight, operation.minArea);

    if (boundingBoxes.length > 50) {
      throw createMediaProcessingError('SMART_SPLIT_LIMIT_EXCEEDED', `Too many elements detected: ${boundingBoxes.length} (max 50)`, 400);
    }
    if (boundingBoxes.length === 0) {
      throw createMediaProcessingError('SMART_SPLIT_NO_ELEMENTS', 'No elements detected', 400);
    }

    const basePipeline = sharp(sourceFilePath, undefined);
    const tiles: Array<{
      index: number;
      assetId: string;
      mediaAsset: MediaAsset;
      url: string;
      width: number;
      height: number;
      x: number;
      y: number;
    }> = [];

    for (let i = 0; i < boundingBoxes.length; i += 1) {
      const box = boundingBoxes[i];
      if (!box) continue;
      const pad = operation.padding;
      const left = Math.max(0, box.x - pad);
      const top = Math.max(0, box.y - pad);
      const right = Math.min(originalWidth, box.x + box.width + pad);
      const bottom = Math.min(originalHeight, box.y + box.height + pad);
      const width = right - left;
      const height = bottom - top;

      const { data, info } = await basePipeline.clone().extract({ left, top, width, height }).toBuffer({ resolveWithObject: true });
      const persisted = await persistProcessedImageResult({
        projectPath,
        sourceUrl,
        mediaDir,
        buffer: data,
        ext: '.png',
        width: (info !== null && info !== undefined ? info.width : undefined) || width,
        height: (info !== null && info !== undefined ? info.height : undefined) || height,
      });
      tiles.push({
        index: i,
        ...persisted,
        x: left,
        y: top,
      });
    }

    return ImageProcessingResultSchema.parse({
      resultType: 'smartSplit',
      operationType: 'smartSplit',
      success: true,
      tiles,
      originalWidth,
      originalHeight,
      tileCount: tiles.length,
    });
  };
};
