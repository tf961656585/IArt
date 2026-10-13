import { fetchBlobWithHub } from '@/client/utils/hubFetch';
import { uploadMediaBlob } from '@/client/api/upload';
import { normalizeLocalFileUrl } from './mediaUrl';
import { classifyMediaUrl } from '@/features/models/shared/mediaResolutionTypes';

/** 检测是否为 base64 data URL */
export const isBase64DataUrl = (url: string): boolean => {
  return url.startsWith('data:') && url.includes('base64,');
};

/** 从 base64 data URL 提取 MIME 类型 */
export const extractMimeType = (dataUrl: string): string => {
  const match = /^data:([^;,]+)/.exec(dataUrl);
  return (match !== null && match !== undefined ? match[1] : undefined) || 'application/octet-stream';
};

/** base64 data URL 转 Blob */
export const base64DataUrlToBlob = (dataUrl: string): Blob => {
  const mimeType = extractMimeType(dataUrl);
  const base64Index = dataUrl.indexOf('base64,');
  const base64Data = base64Index >= 0 ? dataUrl.slice(base64Index + 7) : dataUrl;

  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
};

/** Blob 转 base64 data URL */
export const blobToDataUrl = (blob: Blob, _mimeType: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
};

/** 估算 base64 字符串解码后的字节大小 */
export const estimateBase64Size = (str: string): number => {
  // base64 是原始数据的 4/3 倍，需要反向计算
  const [, encodedPart] = str.split('base64,');
  const base64Part = str.includes('base64,') ? encodedPart ?? '' : str;
  return Math.ceil(base64Part.length * 0.75);
};

/**
 * 从图片节点提取图片 Blob 数据
 * @param imageUrl - 图片 URL（可能是 base64 data URL）
 * @returns 图片 Blob 和 MIME 类型，或 null
 */
export async function extractImageBlobFromImageNode(
  imageUrl: string | null
): Promise<{ blob: Blob; mimeType: string } | null> {
  if (!imageUrl) return null;

  // 优先级 1：从 imageUrl 获取（base64）
  if (isBase64DataUrl(imageUrl)) {
    try {
      const mimeType = extractMimeType(imageUrl);
      const blob = base64DataUrlToBlob(imageUrl);
      return { blob, mimeType };
    } catch (error) {
      console.warn('[mediaUtils] 从 base64 URL 解析图片失败', error);
    }
  }

  // 优先级 2：从远程/本地 URL 获取（fetch -> Blob）
  try {
    const { blob, mimeType } = await fetchBlobWithHub(imageUrl, {
      cache: 'no-store',
      signal: undefined,
      timeoutMs: undefined,
    });
    const [firstPart] = (mimeType ?? blob.type ?? 'image/png').split(';');
    const resolved = firstPart !== undefined && firstPart.trim() ? firstPart.trim() : 'image/png';
    return { blob, mimeType: resolved };
  } catch (error) {
    console.warn('[mediaUtils] fetch 图片失败', error);
  }

  // 优先级 3：通过 canvas 代理能力兜底（可处理无 CORS 的签名 URL）
  try {
    const { fetchUrlAsBase64 } = await import('./contentCacheService');
    const cached = await fetchUrlAsBase64(imageUrl, {
      maxSizeBytes: 20 * 1024 * 1024,
      signal: undefined,
    });
    if (cached !== null && cached.data.startsWith('data:') && cached.data.includes('base64,')) {
      const mimeType = cached.mimeType || extractMimeType(cached.data);
      const blob = base64DataUrlToBlob(cached.data);
      return { blob, mimeType };
    }
  } catch (error) {
    console.warn('[mediaUtils] 通过代理获取图片失败', error);
  }

  return null;
}

const guessImageFileExt = (mimeType: string): string => {
  const [firstPart] = (mimeType || '').split(';');
  const normalized = firstPart !== undefined ? firstPart.trim().toLowerCase() : '';
  if (normalized === 'image/jpeg') return '.jpg';
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/gif') return '.gif';
  if (normalized === 'image/avif') return '.avif';
  return '.png';
};

/**
 * 确保图片 URL 可被 Runtime Backend 本地图像处理能力解析。
 * - /project-media/...、历史 /files/...：直接返回正式 pathname
 * - local-media://...：直接作为正式 source 传给 Backend
 * - data/blob/远端 URL：先落到项目媒体目录，再返回可处理 source
 */
export async function ensureBackendConsumableImageSource(imageUrl: string | null): Promise<string> {
  const normalized = typeof imageUrl === 'string' && imageUrl.trim() ? imageUrl.trim() : '';
  if (classifyMediaUrl(normalized).kind === 'local-media') return normalized;
  const local = normalizeLocalFileUrl(imageUrl);
  if (local) return local;
  if (!normalized) throw new Error('invalid imageUrl');

  const extracted = await extractImageBlobFromImageNode(normalized);
  if (!extracted) throw new Error('无法获取图片数据');

  const ext = guessImageFileExt(extracted.mimeType);
  const uploadedUrl = await uploadMediaBlob(extracted.blob, `image${ext}`);
  const uploadedLocal = normalizeLocalFileUrl(uploadedUrl);
  if (!uploadedLocal) {
    if (classifyMediaUrl(uploadedUrl).kind === 'local-media') return uploadedUrl;
    throw new Error('上传未返回可处理的媒体地址');
  }
  return uploadedLocal;
}

export async function ensureLocalFilesImageUrl(imageUrl: string | null): Promise<string> {
  return ensureBackendConsumableImageSource(imageUrl);
}
