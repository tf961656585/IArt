'use client';

import { resolveApiEndpoint } from '@/client/utils/apiConfig';
import { normalizeLocalFileUrl } from './mediaUrl';
import { estimateBase64Size, isBase64DataUrl } from './mediaUtils';

const filesSizeCache = new Map<string, Promise<number | null>>();

const parseContentRangeTotal = (value: string): number | null => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;
  const slash = trimmed.lastIndexOf('/');
  if (slash < 0) return null;
  const totalRaw = trimmed.slice(slash + 1).trim();
  if (!totalRaw || totalRaw === '*') return null;
  const total = Number.parseInt(totalRaw, 10);
  if (!Number.isFinite(total) || total < 0) return null;
  return total;
};

const fetchFilesSizeBytes = async (filesPath: string): Promise<number | null> => {
  const fetchUrl = resolveApiEndpoint(filesPath);
  try {
    const response = await fetch(fetchUrl, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
    });
    const responseBody = response.body;
    const contentRange = response.headers.get('content-range');
    const contentLength = response.headers.get('content-length');
    try {
      await (responseBody ? responseBody.cancel() : undefined);
    } catch {
      // ignore
    }
    if (contentRange) {
      const total = parseContentRangeTotal(contentRange);
      if (total !== null) return total;
    }
    if (contentLength) {
      const total = Number.parseInt(contentLength, 10);
      if (Number.isFinite(total) && total >= 0) return total;
    }
    return null;
  } catch (error) {
    console.warn('[mediaSize] 读取文件大小失败', error);
    return null;
  }
};

/**
 * 读取媒体大小（bytes）。
 * - base64 data URL：用字符串长度估算（不发网络请求）
 * - /files/...：发 Range(bytes=0-0) 请求，优先从 Content-Range 解析 total，
 *   否则回退 Content-Length，随后取消 body（不下载整文件）
 * - 其他 URL：返回 null（按业务决策 D3=A：不尝试远程）
 */
export const getMediaSizeBytes = async (url: string | null | undefined): Promise<number | null> => {
  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (!trimmed) return null;

  if (isBase64DataUrl(trimmed)) {
    try {
      return estimateBase64Size(trimmed);
    } catch {
      return null;
    }
  }

  const filesPath = normalizeLocalFileUrl(trimmed);
  if (!filesPath) return null;

  const cached = filesSizeCache.get(filesPath);
  if (cached) return cached;

  const promise = fetchFilesSizeBytes(filesPath);
  filesSizeCache.set(filesPath, promise);
  return promise;
};

export const formatBytesCompact = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const digits = idx === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[idx]}`;
};
