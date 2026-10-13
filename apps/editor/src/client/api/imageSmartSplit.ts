import type { ImageProcessingMediaAsset, ImageProcessingSmartSplitResult } from '@iart/contracts/media-processing-contract';
import type { ImageProcessingOperation } from './imageProcessing';
import { processImage, requireSmartSplitImageProcessingResult } from './imageProcessing';

type SmartSplitOperation = Extract<ImageProcessingOperation, { type: 'smartSplit' }>;
type SmartSplitImageParams = Omit<SmartSplitOperation, 'type'>;

type SmartSplitImageResult = {
  tiles: ImageProcessingSmartSplitResult['tiles'];
  originalWidth: number;
  originalHeight: number;
  tileCount: number;
};

export async function smartSplitImage(
  sourceUrl: string,
  params: SmartSplitImageParams,
): Promise<SmartSplitImageResult> {
  const result = requireSmartSplitImageProcessingResult(
    await processImage(sourceUrl, { type: 'smartSplit', ...params }),
  );
  return result;
}

export type { SmartSplitImageParams, SmartSplitImageResult, ImageProcessingMediaAsset as SmartSplitMediaAsset };
