import { isHubRuntime } from '../utils/hubFetch';
import { submitBusinessSyncAction } from '../utils/businessActionSocket';
import { serializeFormDataForBusinessAction } from './client';
import { getRuntimeProjectPath } from '@/client/store/runtimeStore';
import { EDITOR_BACKEND_ACTION_NAME } from '@iart/contracts/editor-backend-contract';
import type { MediaAsset } from '@iart/contracts';

type PersistResultMediaParamDefaults = {
  url: string | undefined;
  blob: Blob | undefined;
  filename: string | undefined;
  filenamePrefix: string | undefined;
  originalUrl: string | undefined;
  mediaType: 'image' | 'video' | 'audio' | undefined;
};

export type PersistResultMediaParams = Partial<PersistResultMediaParamDefaults>;

interface MediaPersistPayload {
  mediaType: string | undefined;
  filename: string | undefined;
  filenamePrefix: string | undefined;
  originalUrl: string | undefined;
  formData: unknown | undefined;
  url: string | undefined;
}

const getCurrentProjectPath = async (): Promise<string | null> => {
  if (typeof window === 'undefined') return null;

  try {
    const projectPath = getRuntimeProjectPath();
    if (!projectPath) return null;
    return projectPath;
  } catch {
    return null;
  }
};

const createBusinessActionId = (): string => {
  try {
    return (globalThis.crypto !== null && globalThis.crypto !== undefined && globalThis.crypto.randomUUID !== null && globalThis.crypto.randomUUID !== undefined ? globalThis.crypto.randomUUID() : undefined) ?? `action_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  } catch {
    return `action_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
};

interface RawMediaPersistResult {
  url: unknown | undefined;
  originalUrl: unknown | undefined;
  assetId: unknown | undefined;
  mediaAsset: unknown | undefined;
  mediaType: unknown | undefined;
  mimeType: unknown | undefined;
  sizeBytes: unknown | undefined;
}

const normalizeString = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed || '';
};

export async function localizeRemoteMedia(params: {
  url: string;
  mediaType: 'image' | 'video' | 'audio' | undefined;
}): Promise<{
  url: string;
  originalUrl: string;
  assetId: string | null | undefined;
  mediaAsset: MediaAsset | null | undefined;
  mediaType: string | null | undefined;
  mimeType: string | null | undefined;
  sizeBytes: number | null | undefined;
}> {
  if (!isHubRuntime()) {
    throw new Error('当前环境无法保存远程媒体，请在桌面客户端里打开项目后重试。');
  }

  const projectPath = await getCurrentProjectPath();
  if (!projectPath) {
    throw new Error('还没有打开项目，无法保存这个文件。请先打开项目后重试。');
  }

  const result = await submitBusinessSyncAction<{
    url: string | undefined;
    originalUrl: string | undefined;
    assetId: string | null | undefined;
    mediaAsset: MediaAsset | null | undefined;
    mediaType: string | null | undefined;
    mimeType: string | null | undefined;
    sizeBytes: number | null | undefined;
  }>({
    actionId: createBusinessActionId(),
    actionName: EDITOR_BACKEND_ACTION_NAME.MEDIA_LOCALIZE,
    projectPath,
    payload: {
      url: params.url,
      mediaType: params.mediaType,
    },
  });

  const data = result.result as RawMediaPersistResult;
  if (!data || typeof data !== 'object' || typeof data.url !== 'string') {
    throw new Error('这个文件没能保存到项目，请重试。');
  }

  return {
    url: data.url,
    originalUrl: typeof data.originalUrl === 'string' ? data.originalUrl : params.url,
    assetId: typeof data.assetId === 'string' ? data.assetId : null,
    mediaAsset: data.mediaAsset && typeof data.mediaAsset === 'object' ? (data.mediaAsset as MediaAsset) : null,
    mediaType: typeof data.mediaType === 'string' ? data.mediaType : null,
    mimeType: typeof data.mimeType === 'string' ? data.mimeType : null,
    sizeBytes: typeof data.sizeBytes === 'number' ? data.sizeBytes : null,
  };
}

export async function persistResultMedia(params: PersistResultMediaParams): Promise<{
  url: string;
  originalUrl: string;
  assetId: string | null | undefined;
  mediaAsset: MediaAsset | null | undefined;
  mediaType: string | null | undefined;
  mimeType: string | null | undefined;
  sizeBytes: number | null | undefined;
}> {
  if (!isHubRuntime()) {
    throw new Error('当前环境无法保存生成结果，请在桌面客户端里打开项目后重试。');
  }

  const projectPath = await getCurrentProjectPath();
  if (!projectPath) {
    throw new Error('还没有打开项目，无法保存这次生成的结果。请先打开项目后重试。');
  }

  const payload: MediaPersistPayload = {
    mediaType: params.mediaType,
    filename: normalizeString(params.filename) || undefined,
    filenamePrefix: normalizeString(params.filenamePrefix) || undefined,
    originalUrl: normalizeString(params.originalUrl) || undefined,
    formData: undefined,
    url: undefined,
  };

  if (params.blob instanceof Blob) {
    const form = new FormData();
    form.append('file', params.blob, normalizeString(params.filename) || 'result-media.bin');
    payload.formData = await serializeFormDataForBusinessAction(form);
  } else {
    payload.url = params.url;
  }

  const result = await submitBusinessSyncAction<{
    url: string | undefined;
    originalUrl: string | undefined;
    assetId: string | null | undefined;
    mediaAsset: MediaAsset | null | undefined;
    mediaType: string | null | undefined;
    mimeType: string | null | undefined;
    sizeBytes: number | null | undefined;
  }>({
    actionId: createBusinessActionId(),
    actionName: EDITOR_BACKEND_ACTION_NAME.MEDIA_PERSIST_RESULT,
    projectPath,
    payload,
  });

  const data = result.result as RawMediaPersistResult;
  if (!data || typeof data !== 'object' || typeof data.url !== 'string') {
    throw new Error('生成结果没能保存到项目，请重试。');
  }

  return {
    url: data.url,
    originalUrl:
      typeof data.originalUrl === 'string' && data.originalUrl.trim()
        ? data.originalUrl
        : normalizeString(params.originalUrl) || normalizeString(params.url) || data.url,
    assetId: typeof data.assetId === 'string' ? data.assetId : null,
    mediaAsset: data.mediaAsset && typeof data.mediaAsset === 'object' ? (data.mediaAsset as MediaAsset) : null,
    mediaType: typeof data.mediaType === 'string' ? data.mediaType : params.mediaType ?? null,
    mimeType: typeof data.mimeType === 'string' ? data.mimeType : null,
    sizeBytes: typeof data.sizeBytes === 'number' ? data.sizeBytes : null,
  };
}
