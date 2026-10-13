// 通用下载工具
// 支持多类输入：
// 1. URL（http(s) / 相对路径如 /files/... / blob: URL / file: URL）
// 2. data:URL（直接转 Blob）
// 3. 纯 base64 字符串（可提供 mimeType；未提供时默认 image/png）
// 4. Blob / File / ArrayBuffer / TypedArray（直接保存）
// 使用 file-saver 以兼容性方式触发保存（动态导入以避免 SSR/Edge 环境问题）

import { triggerBlobDownload } from './fileSaver';
import { fetchBlobWithHub } from './hubFetch';
import { isBlobLike } from '@/shared/isBlobLike';

export { triggerBlobDownload };

export interface DownloadOptions {
  filename: string | undefined;           // 用户可指定文件名
  mimeType: string | undefined;           // 对纯 base64 需要
  fallbackExtension: string | undefined;  // 默认扩展
}

const guessExtFromMime = (mime: string | undefined) => {
  if (!mime) return undefined;
  if (mime === 'image/jpeg') return 'jpg';
  if (mime.startsWith('image/')) return mime.split('/')[1];
  if (mime.startsWith('video/')) return mime.split('/')[1];
  if (mime.startsWith('audio/')) return mime.split('/')[1];
  return undefined;
};

const getExtFromUrl = (url: string) => {
  const withoutHash = url.split('#')[0] ?? url;
  const withoutQuery = withoutHash.split('?')[0] ?? withoutHash;
  const filename = withoutQuery.split('/').pop() ?? withoutQuery;
  const m = filename.match(/\.([A-Za-z0-9]+)$/);
  return m ? m[1] : undefined;
};

const createBlobPropertyBag = (type: string | undefined): BlobPropertyBag => {
  return type ? { type } : {};
};

const dataUrlToBlob = (dataUrl: string): Blob => {
  const arr = dataUrl.split(',');
  const header = arr[0] ?? '';
  const data = arr[1] ?? '';
  const mimeMatch = header.match(/^data:([^;,]+)/i);
  const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';

  if (!data) {
    return new Blob([], createBlobPropertyBag(mime));
  }

  const isBase64 = /;base64/i.test(header);
  if (!isBase64) {
    return new Blob([decodeURIComponent(data)], createBlobPropertyBag(mime));
  }

  const bstr = atob(data);
  let n = bstr.length;
  const u8 = new Uint8Array(n);
  while (n--) u8[n] = bstr.charCodeAt(n);
  return new Blob([u8], createBlobPropertyBag(mime));
};

const isTypedArray = (value: unknown): value is ArrayBufferView => {
  return typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value);
};

export type DownloadInput = string | Blob | File | ArrayBuffer | ArrayBufferView;

const DEFAULT_DOWNLOAD_OPTIONS: DownloadOptions = {
  filename: undefined,
  mimeType: undefined,
  fallbackExtension: undefined,
};

export const downloadMedia = async (input: DownloadInput, opts: DownloadOptions = DEFAULT_DOWNLOAD_OPTIONS) => {
  if (input === null || input === undefined) return;

  let blob: Blob | null = null;
  let mime: string | undefined = opts.mimeType;
  const inputUrl = typeof input === 'string' ? input.trim() : undefined;

  if (isBlobLike(input)) {
    blob = input;
    mime = blob.type || mime;
  } else if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) {
    mime = mime || 'application/octet-stream';
    blob = new Blob([input], { type: mime });
  } else if (isTypedArray(input)) {
    mime = mime || 'application/octet-stream';
    const bytes = new Uint8Array(input.byteLength);
    bytes.set(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
    blob = new Blob([bytes.buffer], { type: mime });
  } else if (typeof input === 'string') {
    if (!inputUrl) return;

    const isDataUrl = /^data:/i.test(inputUrl);
    const isBase64Prefixed = /^base64,/i.test(inputUrl);
    const isLikelyBareBase64 =
      /^[A-Za-z0-9+/=\n\r]+$/.test(inputUrl) && inputUrl.replace(/\s+/g, '').length > 100;

    if (isDataUrl) {
      blob = dataUrlToBlob(inputUrl);
      mime = blob.type || mime;
    } else if (isBase64Prefixed || isLikelyBareBase64) {
      const clean = inputUrl.replace(/^base64,/i, '').replace(/\s+/g, '');
      mime = mime || 'image/png';
      const bstr = atob(clean);
      const u8 = new Uint8Array(bstr.length);
      for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
      blob = new Blob([u8], { type: mime });
    } else {
      try {
        const fetched = await fetchBlobWithHub(inputUrl);
        blob = fetched.blob;
        mime = blob.type || fetched.mimeType || mime;
      } catch (e) {
        console.error('下载远程资源失败', e);
        // 尝试退化：直接通过 a 标签下载（可能受 CORS/签名 URL 影响）
        const a = document.createElement('a');
        a.href = inputUrl;
        a.download = opts.filename || inputUrl.split('/').pop() || 'download';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => document.body.removeChild(a), 0);
        return;
      }
    }
  } else {
    console.warn('不支持的下载数据格式');
    return;
  }

  if (!blob) return;
  mime = mime || blob.type;
  const extFromMime = guessExtFromMime(mime);
  const extFromUrl = inputUrl ? getExtFromUrl(inputUrl) : undefined;
  const ext = extFromUrl || extFromMime || opts.fallbackExtension || 'bin';
  const baseName = opts.filename || `media-${Date.now()}`;
  const filename = baseName.endsWith(`.${ext}`) ? baseName : `${baseName}.${ext}`;
  await triggerBlobDownload(blob, filename, undefined);
};

export default downloadMedia;

