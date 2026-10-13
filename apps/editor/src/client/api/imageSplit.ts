import type { ImageProcessingMediaAsset } from '@iart/contracts/media-processing-contract';
import { processImage, requireSplitImageProcessingResult } from './imageProcessing';

export type ImageSplitTile = {
  index: number;
  row: number;
  col: number;
  assetId: string;
  mediaAsset: ImageProcessingMediaAsset;
  url: string;
  width: number;
  height: number;
  x: number;
  y: number;
};

/** 图片分割结果 */
export interface SplitImageResult {
  success: boolean;
  rows: number;
  cols: number;
  tiles: ImageSplitTile[];
  originalWidth: number;
  originalHeight: number;
  horizontalPercents: number[];
  verticalPercents: number[];
}

export type SplitImageParams = {
  horizontalPercents: number[];
  verticalPercents: number[];
};

/**
 * 调用后端统一图片处理能力分割图片为多个图块
 * @param sourceUrl 可被 Backend 解析的媒体正式地址
 * @param params 分割线参数（百分比 0~100，且不包含 0/100）
 */
export async function splitImage(
  sourceUrl: string,
  params: SplitImageParams
): Promise<SplitImageResult> {
  const result = requireSplitImageProcessingResult(
    await processImage(sourceUrl, { type: 'split', ...params }),
  );
  return result;
}
