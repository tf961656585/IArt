'use client';

import { uploadMediaBlob } from '@/client/api/upload';
import { isHubRuntime } from '@/client/utils/hubFetch';
import { normalizeLocalFileUrl } from '../utils/mediaUrl';

const stripQuery = (url: string): string => {
  try {
    const u = new URL(url, 'http://editor.local');
    return u.pathname;
  } catch {
    const q = url.indexOf('?');
    return q >= 0 ? url.slice(0, q) : url;
  }
};

const guessFilename = (url: string, contentType: string | null): string => {
  const safeType = typeof contentType === 'string' ? contentType.toLowerCase() : '';
  const extFromType = (() => {
    if (safeType.includes('image/png')) return 'png';
    if (safeType.includes('image/jpeg')) return 'jpg';
    if (safeType.includes('image/webp')) return 'webp';
    if (safeType.includes('image/gif')) return 'gif';
    return '';
  })();

  const path = stripQuery(url);
  const match = /\.([a-z0-9]{2,5})$/i.exec(path);
  const extFromUrl = match !== null && match !== undefined && match[1] !== null && match[1] !== undefined ? match[1].toLowerCase() : '';
  const ext = extFromType || extFromUrl || 'png';
  return `image.${ext}`;
};

/**
 * Ensure an image URL is safe to draw into canvas export.
 * - Requires Hub runtime so we can localize into `/files/...`.
 */
export async function ensureLocalImageUrl(inputUrl: string): Promise<string> {
  const url = typeof inputUrl === 'string' ? inputUrl.trim() : '';
  if (!url) throw new Error('还没有可用的图片，请先选一张');

  if (url.startsWith('/files/')) {
    return stripQuery(url);
  }

  if (!isHubRuntime()) {
    throw new Error('当前环境无法把这张外部图片保存到本地，请在桌面应用里操作。');
  }

  const response = await fetch(url, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`下载图片失败：${response.status}`);
  }
  const blob = await response.blob();
  const filename = guessFilename(url, response.headers.get('content-type'));
  const uploadedUrl = await uploadMediaBlob(blob, filename);
  const filesUrl = normalizeLocalFileUrl(uploadedUrl) ?? uploadedUrl;
  if (!filesUrl.startsWith('/files/')) {
    throw new Error('没能把这张外部图片保存到本地');
  }
  return stripQuery(filesUrl);
}
