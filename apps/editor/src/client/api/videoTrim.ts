import { request } from './client';
import type { MediaAsset } from '@iart/contracts';
import type { DynamicRecord } from '@/client/utils/typeGuards';

export interface TrimVideoResponse {
  success: boolean | undefined;
  url: string | undefined;
  assetId: string | null | undefined;
  mediaAsset: MediaAsset | null | undefined;
  meta: DynamicRecord | undefined;
  error: string | undefined;
  code: string | undefined;
}

export async function trimVideo(payload: {
  projectPath: string;
  sourceUrl: string;
  startTime: number;
  endTime: number;
  format: 'mp4' | undefined;
  withAudio: boolean | undefined;
}): Promise<{ url: string; assetId: string | null; mediaAsset: MediaAsset | null; meta: DynamicRecord | undefined }> {
  const projectPath = typeof (payload !== null && payload !== undefined ? payload.projectPath : undefined) === 'string' ? payload.projectPath.trim() : '';
  const sourceUrl = typeof (payload !== null && payload !== undefined ? payload.sourceUrl : undefined) === 'string' ? payload.sourceUrl.trim() : '';
  const startTime = Number((payload !== null && payload !== undefined ? payload.startTime : undefined));
  const endTime = Number((payload !== null && payload !== undefined ? payload.endTime : undefined));
  if (!projectPath) throw new Error('还没有打开项目，请先打开项目后重试。');
  if (!sourceUrl) throw new Error('没有找到要处理的视频，请重新选择后再试。');
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    throw new Error('时间设置不正确，请重新设置后再试。');
  }

  const result = await request<TrimVideoResponse>({
    method: 'POST',
    endpoint: '/api/media/video/trim',
    body: {
      path: projectPath,
      sourceUrl,
      startTime,
      endTime,
      format: (payload !== null && payload !== undefined ? payload.format : undefined) ?? 'mp4',
      withAudio: (payload !== null && payload !== undefined ? payload.withAudio : undefined) ?? true,
    },
    includeAuth: false,
    resolveEndpoint: true,
    useBackendTask: false,
  });

  if (!(result !== null && result !== undefined ? result.success : undefined) || !(result !== null && result !== undefined ? result.url : undefined)) {
    throw new Error((result !== null && result !== undefined ? result.error : undefined) || '没能裁切视频，请重试。');
  }

  const url = result.url;
  if (url === undefined) throw new Error('没能裁切视频，请重试。');

  return {
    url,
    assetId: (result !== null && result !== undefined ? result.assetId : undefined) ?? null,
    mediaAsset: (result !== null && result !== undefined ? result.mediaAsset : undefined) ?? null,
    meta: result.meta,
  };
}
