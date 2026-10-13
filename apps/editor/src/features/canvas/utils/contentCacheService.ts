/**
 * 内容缓存服务
 * - 将远程 URL 转换为 base64
 * - 支持图片、视频、音频类型
 * - 提供缓存状态管理
 */

import type { NodeContentCache } from '../types/node';
import { resolveStrictHubFetchTarget } from '@/client/utils/hubFetchTargetResolver';

/** 支持的媒体类型 */
export type CacheableMediaType = 'image' | 'video' | 'audio';

/** 缓存配置 */
export interface CacheOptions {
  /** 最大文件大小（字节），超过则不缓存 */
  maxSizeBytes: number | undefined;
  /** 外部 AbortSignal（用于取消/中断请求） */
  signal: AbortSignal | undefined;
}

type ResolvedCacheOptions = {
  maxSizeBytes: number;
  signal: AbortSignal | undefined;
};

const DEFAULT_OPTIONS: ResolvedCacheOptions = {
  maxSizeBytes: 100 * 1024 * 1024, // 100MB
  signal: undefined,
};

const createAbortController = (
  options: ResolvedCacheOptions
): { controller: AbortController; cleanup: () => void } => {
  const controller = new AbortController();
  let externalAbortHandler: (() => void) | undefined;

  const externalSignal = options.signal;
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalAbortHandler = () => controller.abort();
      externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
    }
  }

  const cleanup = () => {
    if (externalSignal && externalAbortHandler) {
      externalSignal.removeEventListener('abort', externalAbortHandler);
    }
  };

  return { controller, cleanup };
};

const IMAGE_EXT_REGEX = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif|tiff?)(\?.*)?$/i;
const VIDEO_EXT_REGEX = /\.(mp4|webm|mov|m4v|mkv|avi|flv|ogv|3gp|3gpp)(\?.*)?$/i;
const AUDIO_EXT_REGEX = /\.(mp3|wav|flac|aac|ogg|oga|m4a|opus|weba)(\?.*)?$/i;

const MEDIA_FALLBACK_MIME: Record<CacheableMediaType, string> = {
  image: 'image/png',
  video: 'video/mp4',
  audio: 'audio/mpeg',
};

const resolveMediaTypeFromMime = (mimeType: string | null | undefined): CacheableMediaType | null => {
  if (!mimeType) return null;
  const normalized = mimeType.toLowerCase();
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('video/')) return 'video';
  if (normalized.startsWith('audio/')) return 'audio';
  return null;
};

const normalizeMimeType = (mimeType: string | null | undefined): string | null => {
  if (!mimeType) return null;
  const [firstPart] = mimeType.split(';');
  const clean = firstPart !== undefined ? firstPart.trim() : '';
  return clean || null;
};

const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(buffer).toString('base64');
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  if (typeof btoa === 'undefined') {
    throw new Error('当前环境不支持 base64 转换');
  }
  return btoa(binary);
};

const buildDataUrl = (base64: string, mimeType: string): string =>
  `data:${mimeType || 'application/octet-stream'};base64,${base64}`;

const parseDataUrlMimeType = (value: string): string | null => {
  const match = /^data:([^;,]+)?/i.exec(value);
  return normalizeMimeType((match !== null && match !== undefined ? match[1] : undefined)) ?? null;
};

/**
 * 从 URL 获取内容并转换为 base64
 */
export async function fetchUrlAsBase64(
  url: string,
  options: CacheOptions | undefined
): Promise<NodeContentCache | null> {
  const target = url !== null && url !== undefined ? url.trim() : undefined;
  if (!target) return null;

  const mergedOptions: ResolvedCacheOptions = {
    maxSizeBytes:
      (options !== null && options !== undefined ? options.maxSizeBytes : undefined) ??
      DEFAULT_OPTIONS.maxSizeBytes,
    signal:
      (options !== null && options !== undefined ? options.signal : undefined) ??
      DEFAULT_OPTIONS.signal,
  };

  if (isBase64DataUrl(target)) {
    const mimeType = parseDataUrlMimeType(target) ?? 'application/octet-stream';
    return {
      data: target,
      mimeType,
      originalUrl: target,
      cachedAt: Date.now(),
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(target);
  } catch {
    return null;
  }

  const isBrowser = typeof window !== 'undefined';

  const fetchTarget = isBrowser
    ? resolveStrictHubFetchTarget(parsedUrl.toString(), { format: 'blob' })
    : parsedUrl.toString();

  if (isBrowser && !fetchTarget) {
    return null;
  }

  const { controller, cleanup } = createAbortController(mergedOptions);

  try {
    const response = await fetch(fetchTarget ?? parsedUrl.toString(), {
      cache: 'no-store',
      signal: controller.signal,
    });

    if (response.type === 'opaque' || !response.ok) {
      return null;
    }

    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader) {
      const declaredSize = Number(contentLengthHeader);
      if (!Number.isNaN(declaredSize) && declaredSize > mergedOptions.maxSizeBytes) {
        return null;
      }
    }

    const mimeTypeHeader = normalizeMimeType(response.headers.get('content-type'));
    const mediaType = resolveMediaTypeFromMime(mimeTypeHeader) ?? detectMediaType(target);
    if (!mediaType) {
      return null;
    }

    const blob = await response.blob();
    const blobSize = typeof blob.size === 'number' ? blob.size : 0;
    if (blobSize > mergedOptions.maxSizeBytes) {
      return null;
    }

    const resolvedMime =
      mimeTypeHeader ?? normalizeMimeType(blob.type) ?? MEDIA_FALLBACK_MIME[mediaType];

    const base64 = await blobToBase64(blob);
    const dataUrl = isBase64DataUrl(base64) ? base64 : buildDataUrl(base64, resolvedMime);

    return {
      data: dataUrl,
      mimeType: resolvedMime,
      originalUrl: parsedUrl.toString(),
      cachedAt: Date.now(),
    };
  } catch {
    return null;
  } finally {
    cleanup();
  }
}

/**
 * 检测 URL 的媒体类型
 */
export function detectMediaType(url: string): CacheableMediaType | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  if (isBase64DataUrl(trimmed)) {
    const mimeType = parseDataUrlMimeType(trimmed);
    return resolveMediaTypeFromMime(mimeType);
  }

  const [normalized = ''] = trimmed.toLowerCase().split(/[?#]/);
  if (IMAGE_EXT_REGEX.test(normalized)) return 'image';
  if (VIDEO_EXT_REGEX.test(normalized)) return 'video';
  if (AUDIO_EXT_REGEX.test(normalized)) return 'audio';

  return null;
}

/**
 * 检查 URL 是否已经是 base64 数据
 */
export function isBase64DataUrl(url: string): boolean {
  return url.startsWith('data:');
}

/**
 * 将 Blob 转换为 base64 字符串
 */
export function blobToBase64(blob: Blob): Promise<string> {
  if (typeof FileReader === 'undefined') {
    return blob
      .arrayBuffer()
      .then((buffer) => buildDataUrl(arrayBufferToBase64(buffer), blob.type || 'application/octet-stream'));
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('无法读取 Blob 数据'));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error('Blob 读取失败'));
    reader.readAsDataURL(blob);
  });
}
