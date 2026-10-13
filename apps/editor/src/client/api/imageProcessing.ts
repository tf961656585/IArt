import {
  EDITOR_BACKEND_ACTION_NAME,
} from '@iart/contracts/editor-backend-contract';
import {
  ImageProcessingRequestSchema,
  ImageProcessingResultSchema,
  type ImageProcessingOperation,
  type ImageProcessingRequest,
  type ImageProcessingResult,
  type ImageProcessingSingleResult,
  type ImageProcessingSplitResult,
  type ImageProcessingSmartSplitResult,
} from '@iart/contracts/media-processing-contract';
import { request } from './client';
import { isHubRuntime } from '../utils/hubFetch';
import { submitBusinessSyncAction } from '../utils/businessActionSocket';
import {
  createBusinessActionId,
  getCurrentProjectPathForBusinessAction,
} from './businessActionRuntime';

const normalizeString = (value: unknown): string =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

export type {
  ImageProcessingOperation,
  ImageProcessingRequest,
  ImageProcessingResult,
  ImageProcessingSingleResult,
  ImageProcessingSplitResult,
  ImageProcessingSmartSplitResult,
};

type ImageProcessingHttpResponse =
  | ImageProcessingResult
  | { success: false | undefined; error: string | undefined; message: string | undefined };

type ImageProcessingSingleOperationType = ImageProcessingSingleResult['operationType'];
type ImageProcessingSingleResultFor<T extends ImageProcessingSingleOperationType> = Extract<
  ImageProcessingSingleResult,
  { operationType: T }
>;

const buildImageProcessingRequest = (
  sourceUrl: string,
  operation: ImageProcessingOperation,
): ImageProcessingRequest =>
  ImageProcessingRequestSchema.parse({
    source: { type: 'media-url', url: sourceUrl },
    operation,
  });

export async function processImage(
  sourceUrl: string,
  operation: ImageProcessingOperation,
): Promise<ImageProcessingResult> {
  const projectPath = await getCurrentProjectPathForBusinessAction();
  if (!projectPath) {
    throw new Error('还没有打开项目，无法处理图片。请先打开项目后重试。');
  }

  const payload = buildImageProcessingRequest(sourceUrl, operation);

  if (isHubRuntime()) {
    const result = await submitBusinessSyncAction<ImageProcessingResult>({
      actionId: createBusinessActionId(),
      actionName: EDITOR_BACKEND_ACTION_NAME.MEDIA_IMAGE_PROCESS,
      projectPath,
      payload,
      timeoutMs: 60_000,
    });
    return ImageProcessingResultSchema.parse((result !== null && result !== undefined ? result.result : undefined));
  }

  const result = await request<ImageProcessingHttpResponse>({
    method: 'POST',
    endpoint: '/api/image/process',
    body: { projectPath, ...payload },
    includeAuth: false,
    resolveEndpoint: true,
    useBackendTask: false,
  });

  if (!result || result.success !== true) {
    const failedResult = result;
    const errorText = failedResult
      ? normalizeString(failedResult.error) || normalizeString(failedResult.message)
      : '';
    throw new Error(errorText || '图片处理失败，请重试。');
  }

  return ImageProcessingResultSchema.parse(result);
}

const isSingleImageProcessingResultFor = <T extends ImageProcessingSingleOperationType>(
  result: ImageProcessingSingleResult,
  operationType: T,
): result is ImageProcessingSingleResultFor<T> => result.operationType === operationType;

export function requireSingleImageProcessingResult(
  result: ImageProcessingResult,
): ImageProcessingSingleResult;
export function requireSingleImageProcessingResult<T extends ImageProcessingSingleOperationType>(
  result: ImageProcessingResult,
  operationType: T,
): ImageProcessingSingleResultFor<T>;
export function requireSingleImageProcessingResult<T extends ImageProcessingSingleOperationType>(
  result: ImageProcessingResult,
  operationType: T | undefined = undefined,
): ImageProcessingSingleResult {
  if (result.resultType !== 'single') {
    throw new Error('图片处理没能完成，请重试。');
  }
  if (!result.assetId) {
    throw new Error('图片处理结果没有保存成功，请重试。');
  }
  if (operationType !== undefined && !isSingleImageProcessingResultFor(result, operationType)) {
    throw new Error('图片处理没能完成，请重试。');
  }
  return result;
}

export const requireSplitImageProcessingResult = (
  result: ImageProcessingResult,
): ImageProcessingSplitResult => {
  if (result.resultType !== 'split') {
    throw new Error('图片分割没能完成，请重试。');
  }
  if (result.tiles.some((tile) => !tile.assetId)) {
    throw new Error('图片分割结果没有保存成功，请重试。');
  }
  return result;
};

export const requireSmartSplitImageProcessingResult = (
  result: ImageProcessingResult,
): ImageProcessingSmartSplitResult => {
  if (result.resultType !== 'smartSplit') {
    throw new Error('智能切图没能完成，请重试。');
  }
  if (result.tiles.some((tile) => !tile.assetId)) {
    throw new Error('智能切图结果没有保存成功，请重试。');
  }
  return result;
};
