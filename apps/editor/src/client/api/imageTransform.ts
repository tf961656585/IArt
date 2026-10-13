import type { ImageProcessingMediaAsset } from '@iart/contracts/media-processing-contract';
import { processImage, requireSingleImageProcessingResult } from './imageProcessing';

export type ImageTransformOp =
  | { type: 'mirrorX' }
  | { type: 'mirrorY' }
  | { type: 'rotate'; deg: 0 | 90 | 180 | 270 };      

/** 图片处理结果 */
export interface TransformImageResult {
  success: boolean;
  assetId: string;
  mediaAsset: ImageProcessingMediaAsset;
  url: string;
  width: number;
  height: number;
}

/**
 * 调用后端统一图片处理能力（镜像/旋转等）
 * @param sourceUrl 可被 Backend 解析的媒体正式地址
 * @param ops 操作列表
 */
export async function transformImage(
  sourceUrl: string,
  ops: ImageTransformOp[]
): Promise<TransformImageResult> {
  const result = requireSingleImageProcessingResult(
    await processImage(sourceUrl, { type: 'transform', ops }),
    'transform',
  );
  return result;
}
