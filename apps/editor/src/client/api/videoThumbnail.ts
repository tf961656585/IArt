import { request } from './client';
import { isHubRuntime } from '../utils/hubFetch';
import { submitBusinessSyncAction } from '../utils/businessActionSocket';
import { createBusinessActionId } from './businessActionRuntime';
import { EDITOR_BACKEND_ACTION_NAME } from '@iart/contracts/editor-backend-contract';
import type { MediaAsset } from '@iart/contracts';
import type { DynamicRecord } from '@/client/utils/typeGuards';

export interface VideoThumbnailResponse {
  success: boolean | undefined;
  assetId: string | undefined;
  mediaAsset: MediaAsset | undefined;
  url: string | undefined;
  meta: DynamicRecord | undefined;
  error: string | undefined;
  code: string | undefined;
}

type VideoThumbnailResult = {
  url: string;
  assetId: string | undefined;
  mediaAsset: MediaAsset | undefined;
  meta: DynamicRecord | undefined;
};

type VideoThumbnailPayloadDefaults = {
  projectPath: string;
  assetId: string;
  timeSec: number | undefined;
  width: number | undefined;
  quality: number | undefined;
};
type VideoThumbnailRequestBody = DynamicRecord & {
  path: string;
  assetId: string;
  mediaType: 'video';
  timeSec: number;
  width: number | undefined;
  quality: number | undefined;
};

export type VideoThumbnailPayload =
  Pick<VideoThumbnailPayloadDefaults, 'projectPath' | 'assetId'> &
  Partial<Omit<VideoThumbnailPayloadDefaults, 'projectPath' | 'assetId'>>;

export async function createVideoThumbnail(payload: VideoThumbnailPayload): Promise<VideoThumbnailResult> {
  const projectPath = typeof (payload !== null && payload !== undefined ? payload.projectPath : undefined) === 'string' ? payload.projectPath.trim() : '';
  const assetId = typeof (payload !== null && payload !== undefined ? payload.assetId : undefined) === 'string' ? payload.assetId.trim() : '';
  const timeSec = Number((payload !== null && payload !== undefined ? payload.timeSec : undefined) ?? 0);
  const width = Number((payload !== null && payload !== undefined ? payload.width : undefined));
  const quality = Number((payload !== null && payload !== undefined ? payload.quality : undefined));
  if (!projectPath) throw new Error('还没有打开项目，请先打开项目后重试。');
  if (!assetId) throw new Error('没有找到对应的素材，请重新选择后再试。');
  if (!Number.isFinite(timeSec) || timeSec < 0) {
    throw new Error('时间设置不正确，请重新设置后再试。');
  }

  const body: VideoThumbnailRequestBody = {
    path: projectPath,
    assetId,
    mediaType: 'video',
    timeSec,
    width: undefined,
    quality: undefined,
  };
  if (Number.isFinite(width)) {
    body.width = width;
  }
  if (Number.isFinite(quality)) {
    body.quality = quality;
  }

  if (isHubRuntime()) {
    const result = await submitBusinessSyncAction<VideoThumbnailResponse>({
      actionId: createBusinessActionId(),
      actionName: EDITOR_BACKEND_ACTION_NAME.MEDIA_VIDEO_THUMBNAIL,
      projectPath,
      payload: {
        assetId,
        timeSec,
        ...(Number.isFinite(width) ? { width } : {}),
        ...(Number.isFinite(quality) ? { quality } : {}),
      },
      timeoutMs: 30_000,
    });

    if (!(result !== null && result !== undefined && result.result !== null && result.result !== undefined ? result.result.success : undefined) || !(result !== null && result !== undefined && result.result !== null && result.result !== undefined ? result.result.url : undefined)) {
      throw new Error((result !== null && result !== undefined && result.result !== null && result.result !== undefined ? result.result.error : undefined) || '没能生成视频预览图，请重试。');
    }

    const url = result.result.url;
    if (url === undefined) throw new Error('没能生成视频预览图，请重试。');
    return {
      url,
      assetId: result.result.assetId,
      mediaAsset: result.result.mediaAsset,
      meta: result.result.meta,
    };
  }

  const result = await request<VideoThumbnailResponse>({
    method: 'POST',
    endpoint: '/api/media/video/thumbnail',
    body,
    includeAuth: false,
    resolveEndpoint: true,
    useBackendTask: false,
  });

  if (!(result !== null && result !== undefined ? result.success : undefined) || !(result !== null && result !== undefined ? result.url : undefined)) {
    throw new Error((result !== null && result !== undefined ? result.error : undefined) || '没能生成视频预览图，请重试。');
  }

  const url = result.url;
  if (url === undefined) throw new Error('没能生成视频预览图，请重试。');
  return {
    url,
    assetId: result.assetId,
    mediaAsset: result.mediaAsset,
    meta: result.meta,
  };
}
