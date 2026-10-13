import type { ImageProcessingMediaAsset } from '@iart/contracts/media-processing-contract';
import { processImage, requireSingleImageProcessingResult } from './imageProcessing';

export interface ChromaKeyImageResult {
  assetId: string;
  mediaAsset: ImageProcessingMediaAsset;
  url: string;
  width: number;
  height: number;
  targetColor: { r: number; g: number; b: number };
  tolerance: number;
  feather: number;
}

/**
 * 调用后端统一图片处理能力执行色度抠图
 * @param sourceUrl 可被 Backend 解析的媒体正式地址
 * @param targetColor 目标颜色 (RGB)
 * @param tolerance 容差 (0-100)
 * @param feather 羽化 (0-20)
 */
export async function chromaKeyImage(
  sourceUrl: string,
  targetColor: { r: number; g: number; b: number },
  tolerance: number,
  feather: number,
): Promise<ChromaKeyImageResult> {
  const result = requireSingleImageProcessingResult(
    await processImage(sourceUrl, { type: 'chromaKey', targetColor, tolerance, feather }),
    'chromaKey',
  );
  return result;
}
