import type { ImageProcessingMediaAsset } from '@iart/contracts/media-processing-contract';
import { processImage, requireSingleImageProcessingResult } from './imageProcessing';

export type EdgeDetectMode = 'sobel';

/** 图片边缘检测结果 */
export interface EdgeDetectImageResult {
  success: boolean;
  assetId: string;
  mediaAsset: ImageProcessingMediaAsset;
  url: string;
  width: number;
  height: number;
  mode: EdgeDetectMode;
  threshold: number;
}

/**
 * 调用后端统一图片处理能力执行边缘检测（Sobel）
 * @param sourceUrl 可被 Backend 解析的媒体正式地址
 * @param threshold 阈值 (0-255)
 */
export async function edgeDetectImage(
  sourceUrl: string,
  threshold: number,
  mode: EdgeDetectMode = 'sobel'
): Promise<EdgeDetectImageResult> {
  const result = requireSingleImageProcessingResult(
    await processImage(sourceUrl, { type: 'edgeDetect', threshold, mode }),
    'edgeDetect',
  );
  return result;
}
