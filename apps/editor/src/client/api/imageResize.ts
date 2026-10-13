import type { ImageProcessingMediaAsset, ResizeKernel } from '@iart/contracts/media-processing-contract';
import { processImage, requireSingleImageProcessingResult } from './imageProcessing';

/**
 * 图片缩放结果
 */
export interface ResizeImageResult {
  success: boolean;
  assetId: string;
  mediaAsset: ImageProcessingMediaAsset;
  url: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  percent: number;
  kernel: ResizeKernel;
}

/**
 * 调用后端统一图片处理能力缩放图片
 * @param sourceUrl 可被 Backend 解析的媒体正式地址
 * @param percent 缩放百分比 (10-100)
 * @param kernel 缩放插值模式
 * @returns 缩放后的图片信息
 */
export async function resizeImage(
  sourceUrl: string,
  percent: number,
  kernel: ResizeKernel
): Promise<ResizeImageResult> {
  const result = requireSingleImageProcessingResult(
    await processImage(sourceUrl, { type: 'resize', percent, kernel }),
    'resize',
  );
  return result;
}
