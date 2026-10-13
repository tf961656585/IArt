import type { ImageProcessingMediaAsset } from '@iart/contracts/media-processing-contract';
import { processImage, requireSingleImageProcessingResult } from './imageProcessing';

/** 图片裁剪结果 */
export interface CropImageResult {
  success: boolean;
  assetId: string;
  mediaAsset: ImageProcessingMediaAsset;
  url: string;
  width: number;
  height: number;
  originalWidth: number | undefined;
  originalHeight: number | undefined;
  x: number | undefined;
  y: number | undefined;
}

export type CropImageRect = { x: number; y: number; width: number; height: number };

/**
 * 调用后端统一图片处理能力裁剪图片
 * @param sourceUrl 可被 Backend 解析的媒体正式地址
 * @param rect 裁剪区域（像素）
 */
export async function cropImage(
  sourceUrl: string,
  rect: CropImageRect
): Promise<CropImageResult> {
  const result = requireSingleImageProcessingResult(
    await processImage(sourceUrl, { type: 'crop', ...rect }),
    'crop',
  );
  return result;
}
