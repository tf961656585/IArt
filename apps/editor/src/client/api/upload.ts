import { request, serializeFormDataForBusinessAction } from './client';
import { isHubRuntime } from '../utils/hubFetch';
import { getUploadHttpExecutor, type UploadServiceResponse } from './uploadHttpExecutor';
import { submitBusinessSyncAction } from '../utils/businessActionSocket';
import { getRuntimeProjectPath } from '@/client/store/runtimeStore';
import {
  EDITOR_BACKEND_ACTION_NAME,
  EDITOR_BACKEND_MEDIA_UPLOAD_MODE,
  EDITOR_BACKEND_MEDIA_UPLOAD_TARGET_TYPE,
} from '@iart/contracts/editor-backend-contract';

const UPLOAD_ENDPOINTS = {
  backendProjectMedia: '/api/upload',
} as const;

const normalizeString = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed || '';
};

const createBusinessActionId = (): string => {
  try {
    return (globalThis.crypto !== null && globalThis.crypto !== undefined && globalThis.crypto.randomUUID !== null && globalThis.crypto.randomUUID !== undefined ? globalThis.crypto.randomUUID() : undefined) ?? `action_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  } catch {
    return `action_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
};

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

interface ExternalErrorPayload { error: unknown | undefined; message: unknown | undefined }

const pickErrorText = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as ExternalErrorPayload;
  const errorText = typeof record.error === 'string' ? record.error.trim() : '';
  if (errorText) return errorText;
  const messageText = typeof record.message === 'string' ? record.message.trim() : '';
  if (messageText) return messageText;
  return '';
};

const uploadFileToEndpoint = async (
  endpoint: string,
  file: File | Blob,
  filename: string | undefined,
  extraFields: Record<string, string> | undefined,
  options: {
    resolveEndpoint: boolean | undefined;
  } | undefined,
): Promise<string> => {
  const fd = new FormData();
  if (extraFields) {
    for (const [key, value] of Object.entries(extraFields)) {
      if (!key) continue;
      if (value === undefined || value === null) continue;
      fd.append(key, String(value));
    }
  }
  if (file instanceof File) {
    fd.append('file', file);
  } else {
    fd.append('file', file, filename || 'upload.bin');
  }

  let j: UploadServiceResponse;
  try {
    j = await getUploadHttpExecutor().postForm(endpoint, fd, {
      includeAuth: false,
      resolveEndpoint: (options !== null && options !== undefined ? options.resolveEndpoint : undefined) ?? false,
    });
  } catch (error) {
    const fallbackMessage =
      error && typeof error === 'object' && 'message' in error && typeof (error as { message: unknown | undefined }).message === 'string'
        ? String((error as { message: unknown | undefined }).message)
        : '';
    const bodyMessage =
      error && typeof error === 'object' && 'body' in error
        ? pickErrorText((error as { body: unknown | undefined }).body)
        : '';
    throw new Error(bodyMessage || fallbackMessage || '上传失败，请重试。');
  }

  if (!j || typeof j !== 'object') {
    throw new Error('文件没能上传成功，请重试。');
  }
  if ((j !== null && j !== undefined ? j.success : undefined) === false) {
    throw new Error(pickErrorText(j) || '上传失败，请重试。');
  }
  const url = j.url;
  if (!url) throw new Error('文件没能上传成功，请重试。');
  return url;
};

type HubMediaUploadParamDefaults = {
  file: File | Blob;
  filename: string | undefined;
  mode: (typeof EDITOR_BACKEND_MEDIA_UPLOAD_MODE)[keyof typeof EDITOR_BACKEND_MEDIA_UPLOAD_MODE];
  targetType: (typeof EDITOR_BACKEND_MEDIA_UPLOAD_TARGET_TYPE)[keyof typeof EDITOR_BACKEND_MEDIA_UPLOAD_TARGET_TYPE] | undefined;
  fileKey: string | undefined;
};

type HubMediaUploadParams = Pick<HubMediaUploadParamDefaults, 'file' | 'mode'> &
  Partial<Omit<HubMediaUploadParamDefaults, 'file' | 'mode'>>;

const submitHubMediaUpload = async (params: HubMediaUploadParams): Promise<string> => {
  const projectPath = await getCurrentProjectPath();
  if (!projectPath) {
    throw new Error('还没有打开项目，无法上传文件。请先打开项目后重试。');
  }

  const form = new FormData();
  if (params.file instanceof File) {
    form.append('file', params.file);
  } else {
    form.append('file', params.file, params.filename || 'upload.bin');
  }

  const result = await submitBusinessSyncAction<{ url: string | undefined; success: boolean | undefined }>({
    actionId: createBusinessActionId(),
    actionName: EDITOR_BACKEND_ACTION_NAME.MEDIA_UPLOAD,
    projectPath,
    payload: {
      mode: params.mode,
      targetType: normalizeString(params.targetType) || undefined,
      fileKey: normalizeString(params.fileKey) || undefined,
      formData: await serializeFormDataForBusinessAction(form),
    },
  });

  const url = normalizeString((result !== null && result !== undefined && result.result !== null && result.result !== undefined ? result.result.url : undefined));
  if (!url) {
    throw new Error('文件没能上传成功，请重试。');
  }
  return url;
};

async function uploadFile(file: File | Blob, filename: string | undefined): Promise<string> {
  if (isHubRuntime()) {
    return submitHubMediaUpload({
      file,
      filename,
      mode: EDITOR_BACKEND_MEDIA_UPLOAD_MODE.PROJECT_LOCAL,
    });
  }
  return uploadFileToEndpoint(UPLOAD_ENDPOINTS.backendProjectMedia, file, filename, undefined, {
    resolveEndpoint: true,
  });
}

export async function uploadImageFile(file: File): Promise<string> {
  return uploadFile(file, undefined);
}

export async function uploadImageToPublic(
  file: File | Blob,
  filename: string | undefined,
): Promise<string> {
  if (isHubRuntime()) {
    return submitHubMediaUpload({
      file,
      filename,
      mode: EDITOR_BACKEND_MEDIA_UPLOAD_MODE.PUBLIC_RELAY,
      targetType: EDITOR_BACKEND_MEDIA_UPLOAD_TARGET_TYPE.SELF_HOSTED_IMAGE_PUBLIC_URL,
    });
  }
  const projectPath = await getCurrentProjectPath();
  const extraFields: Record<string, string> = {
    mode: EDITOR_BACKEND_MEDIA_UPLOAD_MODE.PUBLIC_RELAY,
    targetType: EDITOR_BACKEND_MEDIA_UPLOAD_TARGET_TYPE.SELF_HOSTED_IMAGE_PUBLIC_URL,
    ...(projectPath ? { projectPath } : {}),
  };
  return uploadFileToEndpoint(UPLOAD_ENDPOINTS.backendProjectMedia, file, filename, extraFields, {
    resolveEndpoint: true,
  });
}

export async function uploadMediaBlob(
  blob: Blob,
  filename = 'media.bin',
): Promise<string> {
  return uploadFile(blob, filename);
}

export async function uploadToR2(file: File | Blob, filename: string | undefined): Promise<string> {
  return uploadImageToPublic(file, filename);
}

export async function uploadMediaForGenerationAsset(
  file: File | Blob,
  filename: string | undefined,
): Promise<string> {
  return uploadImageToPublic(file, filename);
}

export async function ensureImageUrl(srcOrFile: File | string): Promise<string> {
  if (!srcOrFile) throw new Error('invalid image source');
  if (typeof srcOrFile === 'string') {
    if (srcOrFile.startsWith('data:')) {
      const blob = await request<Blob>({
        method: 'GET',
        endpoint: srcOrFile,
        responseType: 'blob',
        includeAuth: false,
        resolveEndpoint: false,
      });
      const fileType = blob.type || 'image/png';
      const f = new File([blob], 'image.png', { type: fileType });
      return await uploadImageFile(f);
    }
    return srcOrFile;
  }
  return await uploadImageFile(srcOrFile);
}

export async function uploadAllSlots(slots: { id: string; src: string; file: File | undefined }[]): Promise<string[]> {
  const urls: string[] = [];
  for (const s of slots) {
    if (s.file) {
      const url = await uploadImageFile(s.file);
      urls.push(url);
    } else if (s.src) {
      const u = await ensureImageUrl(s.src);
      urls.push(u);
    } else {
      urls.push('');
    }
  }
  return urls;
}
