/**
 * 文件作用：本地 Sobel 边缘检测适配器（Hub 后端执行）
 * - 支持 UploadFileItem 的 file/src 两种输入
 * - 在桌面 Hub 环境中将未落盘图片写入项目媒体目录，再调用统一 media.image_process action
 * - 返回字段 image_url 为 /project-media 资源 URL（便于画板/项目持久化）
 */
import type { GenerationAdapter, GenerationPayload } from './types';
import type { DynamicPayload } from '@/client/api/clientTypes';
import type { UploadFileItem } from '@/features/canvas/nodes/model/mediaHelpers';
import { edgeDetectImage } from '@/client/api/imageEdgeDetect';
import { uploadMediaBlob } from '@/client/api/upload';
import { fetchBlobWithHub, isHubRuntime } from '@/client/utils/hubFetch';

const ensureHubOrThrow = () => {
  if (!isHubRuntime()) {
    throw new Error('边缘检测需要在桌面客户端里使用。');
  }
};

const normalizeThreshold = (value: unknown): number => {
  const num = Number(value);
  if (!Number.isFinite(num)) return 128;
  const rounded = Math.round(num);
  return Math.max(0, Math.min(255, rounded));
};

const guessFilename = (mimeType: string | undefined, fallback = 'edge-input'): string => {
  const lower = (mimeType || '').toLowerCase();
  if (lower === 'image/jpeg' || lower === 'image/jpg') return `${fallback}.jpg`;
  if (lower === 'image/webp') return `${fallback}.webp`;
  if (lower === 'image/gif') return `${fallback}.gif`;
  return `${fallback}.png`;
};

const resolveSourceUrlForHub = async (item: UploadFileItem): Promise<string> => {
  if (!item) {
    throw new Error('没有找到要处理的图片，请重新选择后再试。');
  }

  // 优先使用 file（将媒体写入项目目录，得到 /files URL）
  if (item.file instanceof Blob) {
    const filename =
      typeof (item.file !== null && item.file !== undefined ? (item.file as File).name : undefined) === 'string' && (item.file as File).name
        ? (item.file as File).name
        : guessFilename(item.file.type, `edge-input-${Date.now()}`);
    return uploadMediaBlob(item.file, filename);
  }

  const src = typeof item.src === 'string' ? item.src.trim() : '';
  if (!src) {
    throw new Error('这张图片无法读取，请重新选择后再试。');
  }

  // /files 已落盘：直接传给后端处理
  if (src.includes('/files/')) {
    return src;
  }

  // 其他来源（http(s)/data/blob/file 等）：拉取为 Blob → 落盘 → 再处理
  const fetched = await fetchBlobWithHub(src);
  const filename = guessFilename(fetched.mimeType || fetched.blob.type, `edge-input-${Date.now()}`);
  return uploadMediaBlob(fetched.blob, filename);
};

type LocalEdgePayloadBody = DynamicPayload & {
  images: unknown | undefined;
  mode: unknown | undefined;
  threshold: unknown | undefined;
};

const generateLocalEdge: GenerationAdapter<GenerationPayload>['generate'] = async (...args) => {
  ensureHubOrThrow();
  const payload = args[0];

  const body = payload !== null && payload !== undefined && payload.body !== null && payload.body !== undefined && typeof payload.body === 'object'
    ? payload.body as LocalEdgePayloadBody
    : {
        images: undefined,
        mode: undefined,
        threshold: undefined,
      };
  const images = body.images;
  const items = Array.isArray(images) ? (images as UploadFileItem[]) : [];
  if (items.length === 0) {
    throw new Error('请先连接至少一张图片。');
  }

  const modeRaw =
    typeof body.mode === 'string'
      ? body.mode.trim().toLowerCase()
      : 'sobel';
  if (modeRaw && modeRaw !== 'sobel') {
    throw new Error('当前不支持所选的检测方式，请换一种后再试。');
  }
  const mode = 'sobel';

  const threshold = normalizeThreshold(body.threshold);
  const firstItem = items[0];
  if (!firstItem) {
    throw new Error('请先连接要检测的图片。');
  }
  const sourceUrl = await resolveSourceUrlForHub(firstItem);

  const record = await edgeDetectImage(sourceUrl, threshold, mode);

  return {
    image_url: record.url,
    raw: {
      algorithm: mode,
      threshold,
      assetId: record.assetId,
      width: typeof record.width === 'number' ? record.width : undefined,
      height: typeof record.height === 'number' ? record.height : undefined,
      sourceUrl,
    },
  };
};

export const localEdgeAdapter: GenerationAdapter<GenerationPayload> = {
  generate: generateLocalEdge,
};

export default localEdgeAdapter;
