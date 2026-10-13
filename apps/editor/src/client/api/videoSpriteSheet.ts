import { request } from './client';
import { isHubRuntime } from '../utils/hubFetch';
import { submitBusinessSyncAction } from '../utils/businessActionSocket';
import { createBusinessActionId, getCurrentProjectPathForBusinessAction } from './businessActionRuntime';
import { EDITOR_BACKEND_ACTION_NAME } from '@iart/contracts/editor-backend-contract';
import {
  VideoSpriteSheetRequestSchema,
  VideoSpriteSheetResultSchema,
  type VideoSpriteSheetResult,
} from '@iart/contracts/media-processing-contract';

type SpriteSheetOperation = {
  startTime: number;
  endTime: number;
  fpsMultiplier: number;
};

export type ProcessVideoSpriteSheetPayload = SpriteSheetOperation;

/**
 * 独立的视频序列帧图集 API client，不复用 processImage。
 * 支持 Hub 和 HTTP 两种模式。
 */
export async function processVideoSpriteSheet(
  sourceUrl: string,
  operation: ProcessVideoSpriteSheetPayload,
): Promise<VideoSpriteSheetResult> {
  const normalizedUrl = typeof sourceUrl === 'string' ? sourceUrl.trim() : '';
  if (!normalizedUrl) {
    throw new Error('sourceUrl is required');
  }

  const parsedRequest = VideoSpriteSheetRequestSchema.safeParse({
    source: { type: 'media-url', url: normalizedUrl },
    operation,
  });
  if (!parsedRequest.success) {
    throw new Error(`Invalid sprite sheet request: ${parsedRequest.error.message}`);
  }

  if (isHubRuntime()) {
    const projectPath = await getCurrentProjectPathForBusinessAction();
    if (!projectPath) {
      throw new Error('还没有打开项目，无法生成视频图集。请先打开项目后重试。');
    }

    const result = await submitBusinessSyncAction<VideoSpriteSheetResult>({
      actionId: createBusinessActionId(),
      actionName: EDITOR_BACKEND_ACTION_NAME.MEDIA_VIDEO_SPRITESHEET,
      projectPath,
      payload: parsedRequest.data,
      timeoutMs: 120_000,
    });

    const hubResult = result.result;
    if (hubResult === null || hubResult === undefined || !hubResult.outputUrl) {
      throw new Error('没能生成视频图集，请重试。');
    }

    return VideoSpriteSheetResultSchema.parse(hubResult);
  }

  const body = {
    source: parsedRequest.data.source,
    operation: parsedRequest.data.operation,
  };

  const httpResponse = await request<unknown>({
    method: 'POST',
    endpoint: '/api/media/video/spritesheet',
    body,
    includeAuth: false,
    resolveEndpoint: true,
    useBackendTask: false,
  });

  return VideoSpriteSheetResultSchema.parse(httpResponse);
}
