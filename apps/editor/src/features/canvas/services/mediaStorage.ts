import { uploadMediaBlob } from '@/client/api/upload';
import { isHubRuntime } from '@/client/utils/hubFetch';
import { persistResultMedia } from '@/client/api/media';
import { getRuntimeBackendBaseUrl, getRuntimeProjectPath } from '@/client/store/runtimeStore';
import { base64DataUrlToBlob, extractMimeType } from '../utils/mediaUtils';

// 媒体存储结果 - 只支持落盘到本地后端，不再使用 IndexedDB
export type StoredMediaResult = {
  kind: 'url';
  url: string;
  mimeType: string;
  sizeBytes: number;
};

export interface MediaStorageContext {
  nodeGraphId: string;
  nodeId: string;
  source: string | undefined;
  originalUrl: string | undefined;
  filenamePrefix: string | undefined;
}

const EXTENSION_MAP: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
};

type Base64MediaNormalizationResult = {
  blob: Blob;
  mimeType: string;
};

const PCM_AUDIO_MIME_TYPES = new Set(['audio/l16', 'audio/pcm']);

const parseDataUrlMeta = (dataUrl: string): { mimeType: string; params: Record<string, string> } => {
  const match = /^data:([^,]+)/i.exec(dataUrl);
  const header = (match !== null && match !== undefined ? match[1] : undefined) ?? '';
  const segments = header
    .split(';')
    .map((segment) => segment.trim())
    .filter(Boolean);

  const mimeType = segments[0] || 'application/octet-stream';
  const params: Record<string, string> = {};

  for (const segment of segments.slice(1)) {
    if (!segment || segment.toLowerCase() === 'base64') continue;
    const [rawKey, ...rest] = segment.split('=');
    const key = rawKey !== null && rawKey !== undefined ? rawKey.trim().toLowerCase() : '';
    const value = rest.join('=').trim();
    if (!key || !value) continue;
    params[key] = value;
  }

  return { mimeType, params };
};

const createWavBlobFromPcm = (pcmBytes: Uint8Array, sampleRate: number): Blob => {
  const channelCount = 1;
  const bitsPerSample = 16;
  const blockAlign = channelCount * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const buffer = new ArrayBuffer(44 + pcmBytes.length);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + pcmBytes.length, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, 'data');
  view.setUint32(40, pcmBytes.length, true);
  new Uint8Array(buffer, 44).set(pcmBytes);

  return new Blob([buffer], { type: 'audio/wav' });
};

const decodeBase64Payload = (dataUrl: string): Uint8Array => {
  const base64Index = dataUrl.indexOf('base64,');
  const payload = (base64Index >= 0 ? dataUrl.slice(base64Index + 7) : dataUrl).replace(/\s+/g, '');
  const binaryString = atob(payload);
  const bytes = new Uint8Array(binaryString.length);
  for (let index = 0; index < binaryString.length; index += 1) {
    bytes[index] = binaryString.charCodeAt(index);
  }
  return bytes;
};

const normalizeBase64MediaForStorage = async (base64Url: string): Promise<Base64MediaNormalizationResult> => {
  const blob = base64DataUrlToBlob(base64Url);
  const { mimeType, params } = parseDataUrlMeta(base64Url);
  const normalizedMime = mimeType.trim() || extractMimeType(base64Url);
  const lowerMime = normalizedMime.toLowerCase();

  if (!PCM_AUDIO_MIME_TYPES.has(lowerMime)) {
    return { blob, mimeType: normalizedMime };
  }

  const pcmBytes = decodeBase64Payload(base64Url);
  const sampleRate = Number.parseInt((params as { rate: string | undefined }).rate ?? '', 10);
  const safeSampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 24000;
  const wavBlob = createWavBlobFromPcm(pcmBytes, safeSampleRate);
  return {
    blob: wavBlob,
    mimeType: 'audio/wav',
  };
};

const sanitizePrefix = (value: string | undefined): string => {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'media';
};

const guessExtension = (mimeType: string): string => {
  const normalized = mimeType.toLowerCase().trim();
  if (EXTENSION_MAP[normalized]) {
    return EXTENSION_MAP[normalized];
  }
  if (normalized.includes('/')) {
    const [, extToken] = normalized.split('/');
    const ext = extToken !== null && extToken !== undefined ? extToken.toLowerCase() : undefined;
    if (ext) return ext;
  }
  return 'bin';
};

const buildFileName = (prefix: string, mimeType: string): string => {
  const safePrefix = sanitizePrefix(prefix);
  const ext = guessExtension(mimeType);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${safePrefix}_${Date.now()}_${rand}.${ext}`;
};

const uploadToDisk = async (
  blob: Blob,
  mimeType: string,
  context: MediaStorageContext
): Promise<{ url: string; mimeType: string; sizeBytes: number } | null> => {
  if (!getRuntimeBackendBaseUrl()) {
    return null;
  }
  try {
    const filename = buildFileName(
      context.filenamePrefix ?? context.source ?? 'media',
      mimeType
    );
    const canUseProjectPersist = isHubRuntime() && Boolean(getRuntimeProjectPath());
    const url = canUseProjectPersist
        ? (
          await persistResultMedia({
            blob,
            filename,
            filenamePrefix: context.filenamePrefix ?? context.source ?? 'media',
            ...(context.originalUrl ? { originalUrl: context.originalUrl } : {}),
          })
        ).url
      : await uploadMediaBlob(blob, filename);
    return { url, mimeType, sizeBytes: blob.size };
  } catch (error) {
    console.warn('[mediaStorage] 本地磁盘写入失败', error);
    return null;
  }
};

export async function storeBlobMedia(
  blob: Blob,
  context: MediaStorageContext & { mimeType: string | undefined }
): Promise<StoredMediaResult> {
  const resolvedMime =
    (context.mimeType && context.mimeType.trim()) ||
    blob.type ||
    'application/octet-stream';

  if (!getRuntimeBackendBaseUrl()) {
    throw new Error('无法保存素材，请先启动项目管理应用。');
  }

  const disk = await uploadToDisk(blob, resolvedMime, context);
  if (disk) {
    return { kind: 'url', ...disk };
  }

  // 上传失败，抛出错误而不是降级到 IndexedDB
  throw new Error('没能把文件写进项目，请确认项目管理应用正在运行。');
}

export async function storeBase64Media(
  base64Url: string,
  context: MediaStorageContext
): Promise<StoredMediaResult> {
  const { blob, mimeType } = await normalizeBase64MediaForStorage(base64Url);
  return storeBlobMedia(blob, { ...context, mimeType });
}
