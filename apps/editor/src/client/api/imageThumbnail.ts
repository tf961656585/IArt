import { request } from './client';
import { isHubRuntime } from '../utils/hubFetch';
import { submitBusinessSyncAction } from '../utils/businessActionSocket';
import { createBusinessActionId } from './businessActionRuntime';
import { EDITOR_BACKEND_ACTION_NAME } from '@iart/contracts/editor-backend-contract';
import type { MediaAsset } from '@iart/contracts';
import type { DynamicRecord } from '@/client/utils/typeGuards';

export interface ImageThumbnailResponse {
  success: boolean | undefined;
  assetId: string | undefined;
  mediaAsset: MediaAsset | undefined;
  url: string | undefined;
  meta: DynamicRecord | undefined;
  error: string | undefined;
  code: string | undefined;
}

type ImageThumbnailResult = {
  url: string;
  assetId: string | undefined;
  mediaAsset: MediaAsset | undefined;
  meta: DynamicRecord | undefined;
};

type ImageThumbnailPayloadDefaults = {
  projectPath: string;
  assetId: string;
  maxEdge: number | undefined;
  quality: number | undefined;
};
type ImageThumbnailRequestBody = DynamicRecord & {
  path: string;
  assetId: string;
  mediaType: 'image';
  maxEdge: number | undefined;
  quality: number | undefined;
};

export type ImageThumbnailPayload =
  Pick<ImageThumbnailPayloadDefaults, 'projectPath' | 'assetId'> &
  Partial<Omit<ImageThumbnailPayloadDefaults, 'projectPath' | 'assetId'>>;

export async function createImageThumbnail(payload: ImageThumbnailPayload): Promise<ImageThumbnailResult> {
  const projectPath = typeof (payload !== null && payload !== undefined ? payload.projectPath : undefined) === 'string' ? payload.projectPath.trim() : '';
  const assetId = typeof (payload !== null && payload !== undefined ? payload.assetId : undefined) === 'string' ? payload.assetId.trim() : '';
  const maxEdge = Number((payload !== null && payload !== undefined ? payload.maxEdge : undefined));
  const quality = Number((payload !== null && payload !== undefined ? payload.quality : undefined));
  if (!projectPath) throw new Error('还没有打开项目，请先打开项目后重试。');
  if (!assetId) throw new Error('没有找到对应的素材，请重新选择后再试。');

  const body: ImageThumbnailRequestBody = {
    path: projectPath,
    assetId,
    mediaType: 'image',
    maxEdge: undefined,
    quality: undefined,
  };
  if (Number.isFinite(maxEdge)) {
    body.maxEdge = maxEdge;
  }
  if (Number.isFinite(quality)) {
    body.quality = quality;
  }

  if (isHubRuntime()) {
    const result = await submitBusinessSyncAction<ImageThumbnailResponse>({
      actionId: createBusinessActionId(),
      actionName: EDITOR_BACKEND_ACTION_NAME.MEDIA_IMAGE_THUMBNAIL,
      projectPath,
      payload: {
        assetId,
        ...(Number.isFinite(maxEdge) ? { maxEdge } : {}),
        ...(Number.isFinite(quality) ? { quality } : {}),
      },
      timeoutMs: 30_000,
    });

    if (!(result !== null && result !== undefined && result.result !== null && result.result !== undefined ? result.result.success : undefined) || !(result !== null && result !== undefined && result.result !== null && result.result !== undefined ? result.result.url : undefined)) {
      throw new Error((result !== null && result !== undefined && result.result !== null && result.result !== undefined ? result.result.error : undefined) || '没能生成图片预览图，请重试。');
    }

    const url = result.result.url;
    if (url === undefined) throw new Error('没能生成图片预览图，请重试。');
    return {
      url,
      assetId: result.result.assetId,
      mediaAsset: result.result.mediaAsset,
      meta: result.result.meta,
    };
  }

  const result = await request<ImageThumbnailResponse>({
    method: 'POST',
    endpoint: '/api/media/image/thumbnail',
    body,
    includeAuth: false,
    resolveEndpoint: true,
    useBackendTask: false,
  });

  if (!(result !== null && result !== undefined ? result.success : undefined) || !(result !== null && result !== undefined ? result.url : undefined)) {
    throw new Error((result !== null && result !== undefined ? result.error : undefined) || '没能生成图片预览图，请重试。');
  }

  const url = result.url;
  if (url === undefined) throw new Error('没能生成图片预览图，请重试。');
  return {
    url,
    assetId: result.assetId,
    mediaAsset: result.mediaAsset,
    meta: result.meta,
  };
}
