import type { ImageProcessingMediaAsset } from '@iart/contracts/media-processing-contract';
import { processImage, requireSingleImageProcessingResult } from './imageProcessing';

export interface DifferenceKeyImageResult {
  assetId: string;
  mediaAsset: ImageProcessingMediaAsset;
  url: string;
  width: number;
  height: number;
  threshold: number;
  softness: number;
}

/**
 * 调用后端统一图片处理能力执行差异抠图。
 * 输入两张同一角色、不同纯色背景的图,逐像素比较 RGB 距离生成透明背景 PNG。
 * @param sourceUrl 背景A(顶层 source),可被 Backend 解析的 local-media:// 地址
 * @param secondSourceUrl 背景B(secondSource),必须与背景A尺寸完全一致
 * @param threshold 差异判定门槛 (0-100),差异 >= threshold 视为背景丢弃
 * @param softness 边缘羽化宽度 (0-50),threshold ± softness 区间内线性过渡 alpha
 */
export async function differenceKeyImage(
  sourceUrl: string,
  secondSourceUrl: string,
  threshold: number,
  softness: number,
): Promise<DifferenceKeyImageResult> {
  const result = requireSingleImageProcessingResult(
    await processImage(sourceUrl, {
      type: 'differenceKey',
      secondSource: { type: 'media-url', url: secondSourceUrl },
      threshold,
      softness,
    }),
    'differenceKey',
  );
  return result;
}
