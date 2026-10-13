import type { MediaAsset } from '@iart/contracts';
import { request } from './client';
import type { DynamicRecord } from '@/client/utils/typeGuards';

export interface CaptureVideoFrameResponse {
  success: boolean | undefined;
  url: string | undefined;
  assetId: string | undefined;
  mediaAsset: MediaAsset | undefined;
  meta: DynamicRecord | undefined;
  error: string | undefined;
  code: string | undefined;
}

export type CaptureVideoFrameResult = {
  url: string;
  assetId: string;
  mediaAsset: MediaAsset | undefined;
  meta: DynamicRecord | undefined;
};

/**
 * 调用后端视频单帧截取能力（ffmpeg 抽帧落盘为 PNG 并注册媒体资产）。
 * @param payload.projectPath 当前项目路径
 * @param payload.sourceUrl 可被 Backend 解析的视频正式地址
 * @param payload.timeSec 截取时间点（秒）
 */
export async function captureVideoFrame(payload: {
  projectPath: string;
  sourceUrl: string;
  timeSec: number;
}): Promise<CaptureVideoFrameResult> {
  const projectPath = typeof (payload !== null && payload !== undefined ? payload.projectPath : undefined) === 'string' ? payload.projectPath.trim() : '';
  const sourceUrl = typeof (payload !== null && payload !== undefined ? payload.sourceUrl : undefined) === 'string' ? payload.sourceUrl.trim() : '';
  const timeSec = Number((payload !== null && payload !== undefined ? payload.timeSec : undefined));
  if (!projectPath) throw new Error('还没有打开项目，请先打开项目后重试。');
  if (!sourceUrl) throw new Error('没有找到要处理的视频，请重新选择后再试。');
  if (!Number.isFinite(timeSec) || timeSec < 0) {
    throw new Error('截取时间设置不正确，请重新设置后再试。');
  }

  const result = await request<CaptureVideoFrameResponse>({
    method: 'POST',
    endpoint: '/api/media/video/frame',
    body: {
      path: projectPath,
      sourceUrl,
      timeSec,
    },
    includeAuth: false,
    resolveEndpoint: true,
    useBackendTask: false,
  });

  if (!(result !== null && result !== undefined ? result.success : undefined) || !(result !== null && result !== undefined ? result.url : undefined)) {
    throw new Error((result !== null && result !== undefined ? result.error : undefined) || '没能截取这一帧，请重试。');
  }

  const url = result.url;
  if (url === undefined) throw new Error('没能截取这一帧，请重试。');
  const assetId = (result !== null && result !== undefined ? result.assetId : undefined) ?? '';
  if (!assetId) throw new Error('截取这一帧后没有保存成功，请重试。');

  return {
    url,
    assetId,
    mediaAsset: result.mediaAsset,
    meta: result.meta,
  };
}
