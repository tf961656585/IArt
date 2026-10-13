import * as crypto from 'node:crypto';

import { parseFilesKeyFromUrl } from './files-url.cts';
import {
  isUploadWriteError,
  writeProjectMediaUploadFromSerialized,
} from './upload-write.cts';
import { localizeRemoteMediaToFiles } from './media-localization/remote-localize.cts';
import {
  EDITOR_BACKEND_MEDIA_CONTRACT,
  buildEditorLocalizedMediaDescriptor,
} from './contracts.cts';
import { resolveLocalMediaUrl, resolveProjectRefByPath } from './project-media-scope.cts';

type MimeExtensionMap = Readonly<{
  'image/png': 'png';
  'image/jpeg': 'jpg';
  'image/jpg': 'jpg';
  'image/webp': 'webp';
  'image/gif': 'gif';
  'image/bmp': 'bmp';
  'image/svg+xml': 'svg';
  'image/avif': 'avif';
  'video/mp4': 'mp4';
  'video/webm': 'webm';
  'video/quicktime': 'mov';
  'audio/mpeg': 'mp3';
  'audio/mp3': 'mp3';
  'audio/wav': 'wav';
  'audio/ogg': 'ogg';
  'audio/aac': 'aac';
  'audio/mp4': 'm4a';
}>;

type KnownMimeType = keyof MimeExtensionMap;

type SerializedField = {
  name: string;
  value: unknown;
};

type SerializedFile = {
  name: string;
  filename: string | undefined;
  contentType: string | undefined;
  dataBase64: string | undefined;
  size: unknown | undefined;
};

type SerializedFormData = {
  fields: SerializedField[];
  files: SerializedFile[];
};

type SerializedUploadPayload = {
  __formData: SerializedFormData;
};

type RawSerializedUploadPayload = {
  __formData: unknown | undefined;
};

type RawResultMediaPersistenceParams = {
  projectPath: unknown | undefined;
  url: unknown | undefined;
  originalUrl: unknown | undefined;
  mediaType: unknown | undefined;
  mimeType: unknown | undefined;
  sizeBytes: unknown | undefined;
  source: unknown | undefined;
  filenamePrefix: unknown | undefined;
  filename: unknown | undefined;
  formData: unknown | undefined;
};

const EMPTY_RAW_RESULT_MEDIA_PERSISTENCE_PARAMS: RawResultMediaPersistenceParams = {
  projectPath: undefined,
  url: undefined,
  originalUrl: undefined,
  mediaType: undefined,
  mimeType: undefined,
  sizeBytes: undefined,
  source: undefined,
  filenamePrefix: undefined,
  filename: undefined,
  formData: undefined,
};

const EMPTY_RAW_SERIALIZED_UPLOAD_PAYLOAD: RawSerializedUploadPayload = {
  __formData: undefined,
};

type PersistSerializedUploadParams = {
  projectPath: unknown | undefined;
  originalUrl: unknown | undefined;
  mediaType: unknown | undefined;
  mimeType: unknown | undefined;
  sizeBytes: unknown | undefined;
  formData: SerializedUploadPayload | undefined;
};

type DataUrlDecodeResult =
  | {
      ok: true;
      mimeType: string;
      buffer: Buffer;
    }
  | {
      ok: false;
      code: 'invalid_data_url';
      message: string;
    };

const MIME_EXTENSION_MAP: MimeExtensionMap = Object.freeze({
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
});

const normalizeString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const hasErrorMessage = (value: unknown): value is { message: unknown | undefined } => {
  return Boolean(value && typeof value === 'object' && 'message' in value);
};
const isHttpUrl = (value: unknown) => /^https?:\/\//i.test(String(value || ''));
const isDataUrl = (value: unknown) => /^data:[^,]+;base64,/i.test(String(value || ''));

const isRawObject = (value: unknown): value is object => {
  return Boolean(value && typeof value === 'object');
};

const readOwnObjectValue = (value: object, key: string): unknown | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor ? descriptor.value : undefined;
};

const isKnownMimeType = (value: string): value is KnownMimeType => {
  return Object.hasOwn(MIME_EXTENSION_MAP, value);
};

const toRawResultMediaPersistenceParams = (value: unknown): RawResultMediaPersistenceParams => {
  if (!isRawObject(value)) return EMPTY_RAW_RESULT_MEDIA_PERSISTENCE_PARAMS;
  return {
    projectPath: readOwnObjectValue(value, 'projectPath'),
    url: readOwnObjectValue(value, 'url'),
    originalUrl: readOwnObjectValue(value, 'originalUrl'),
    mediaType: readOwnObjectValue(value, 'mediaType'),
    mimeType: readOwnObjectValue(value, 'mimeType'),
    sizeBytes: readOwnObjectValue(value, 'sizeBytes'),
    source: readOwnObjectValue(value, 'source'),
    filenamePrefix: readOwnObjectValue(value, 'filenamePrefix'),
    filename: readOwnObjectValue(value, 'filename'),
    formData: readOwnObjectValue(value, 'formData'),
  };
};

const toRawSerializedUploadPayload = (value: unknown): RawSerializedUploadPayload => {
  if (!isRawObject(value)) return EMPTY_RAW_SERIALIZED_UPLOAD_PAYLOAD;
  return { __formData: readOwnObjectValue(value, '__formData') };
};

const normalizeSerializedField = (value: unknown): SerializedField | null => {
  if (!isRawObject(value)) return null;
  const name = normalizeString(readOwnObjectValue(value, 'name'));
  if (!name) return null;
  return { name, value: readOwnObjectValue(value, 'value') };
};

const normalizeSerializedFile = (value: unknown): SerializedFile | null => {
  if (!isRawObject(value)) return null;
  const name = normalizeString(readOwnObjectValue(value, 'name'));
  if (!name) return null;
  const filename = normalizeString(readOwnObjectValue(value, 'filename'));
  const contentType = normalizeString(readOwnObjectValue(value, 'contentType'));
  const dataBase64 = normalizeString(readOwnObjectValue(value, 'dataBase64'));

  return {
    name,
    filename: filename || undefined,
    contentType: contentType || undefined,
    dataBase64: dataBase64 || undefined,
    size: readOwnObjectValue(value, 'size'),
  };
};

const normalizeSerializedFormData = (value: unknown): SerializedFormData | null => {
  if (!isRawObject(value)) return null;
  const fieldsValue = readOwnObjectValue(value, 'fields');
  const filesValue = readOwnObjectValue(value, 'files');
  const rawFields = Array.isArray(fieldsValue) ? fieldsValue : [];
  const rawFiles = Array.isArray(filesValue) ? filesValue : [];

  const fields = rawFields
    .map((field) => normalizeSerializedField(field))
    .filter((field): field is SerializedField => Boolean(field));
  const files = rawFiles
    .map((file) => normalizeSerializedFile(file))
    .filter((file): file is SerializedFile => Boolean(file));

  return { fields, files };
};

const normalizeSerializedUploadPayload = (value: unknown): SerializedUploadPayload | null => {
  const raw = toRawSerializedUploadPayload(value);
  const formData = normalizeSerializedFormData(raw.__formData);
  return formData ? { __formData: formData } : null;
};

const getFiniteNumber = (value: unknown): number | null => {
  return Number.isFinite(value) ? Number(value) : null;
};

const sanitizeFilenamePrefix = (value: unknown) => {
  const normalized = normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'result-media';
};

const guessExtensionFromMimeType = (mimeType: unknown) => {
  const normalized = normalizeString(mimeType).toLowerCase().split(';')[0] || '';
  if (!normalized) return 'bin';
  if (isKnownMimeType(normalized)) {
    return MIME_EXTENSION_MAP[normalized];
  }
  if (normalized.includes('/')) {
    const ext = normalized.split('/')[1];
    if (ext) return ext;
  }
  return 'bin';
};

const buildUploadFilename = (
  filenamePrefix: unknown,
  mimeType: unknown,
  explicitFilename: unknown,
) => {
  const explicit = normalizeString(explicitFilename);
  if (explicit) return explicit;
  const prefix = sanitizeFilenamePrefix(filenamePrefix);
  const ext = guessExtensionFromMimeType(mimeType);
  return `${prefix}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${ext}`;
};

const toFilesUrl = (fileKey: unknown, projectRef: string | undefined) => {
  const normalized = normalizeString(fileKey);
  if (!normalized) return '';
  if (projectRef) return resolveLocalMediaUrl(projectRef, normalized) ?? '';
  return `/files/${encodeURIComponent(normalized)}`;
};

const normalizeFilesUrl = (value: unknown, projectRef: string | undefined) => {
  if (typeof value !== 'string') return '';
  const fileKey = parseFilesKeyFromUrl(value);
  return fileKey ? toFilesUrl(fileKey, projectRef) : '';
};

const buildContractPayload = () => ({
  owner: EDITOR_BACKEND_MEDIA_CONTRACT.owner,
  localizedUrlPrefix: EDITOR_BACKEND_MEDIA_CONTRACT.localizedUrlPrefix,
  displayRequiresLocalizedFile: EDITOR_BACKEND_MEDIA_CONTRACT.displayRequiresLocalizedFile,
});

const buildSuccessResult = (value: unknown) => ({
  ok: true,
  ...buildEditorLocalizedMediaDescriptor(value),
  contract: buildContractPayload(),
});

const decodeDataUrl = (dataUrl: unknown): DataUrlDecodeResult => {
  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,([\s\S]+)$/i.exec(normalizeString(dataUrl));
  if (!match) {
    return { ok: false, code: 'invalid_data_url', message: 'Invalid data url' };
  }

  const mimeType = normalizeString(match[1]) || 'application/octet-stream';
  const payload = normalizeString(match[2]).replace(/\s+/g, '');
  if (!payload) {
    return { ok: false, code: 'invalid_data_url', message: 'Missing data url payload' };
  }

  try {
    return {
      ok: true,
      mimeType,
      buffer: Buffer.from(payload, 'base64'),
    };
  } catch {
    return { ok: false, code: 'invalid_data_url', message: 'Invalid base64 payload' };
  }
};

const buildSerializedUploadPayload = ({
  buffer,
  mimeType,
  filename,
}: {
  buffer: Buffer;
  mimeType: string;
  filename: string;
}): SerializedUploadPayload => ({
  __formData: {
    fields: [],
    files: [
      {
        name: 'file',
        filename,
        contentType: mimeType,
        dataBase64: buffer.toString('base64'),
        size: buffer.length,
      },
    ],
  },
});

const persistSerializedUploadToFiles = async (params: PersistSerializedUploadParams = {} as PersistSerializedUploadParams) => {
  try {
    const stored = await writeProjectMediaUploadFromSerialized(params.formData, {
      strategyId: 'content-hash',
      projectPath: normalizeString(params.projectPath),
      projectRef: resolveProjectRefByPath(normalizeString(params.projectPath)) ?? undefined,
      fileKey: undefined,
      maxUploadSize: undefined,
      buildFileTooLargeMessage: undefined,
    } as Parameters<typeof writeProjectMediaUploadFromSerialized>[1]);
    return buildSuccessResult({
      url: stored.urlPath,
      originalUrl: normalizeString(params.originalUrl) || null,
      mediaType: normalizeString(params.mediaType) || null,
      mimeType: normalizeString(params.mimeType) || null,
      sizeBytes: getFiniteNumber(params.sizeBytes),
    });
  } catch (error: unknown) {
    if (isUploadWriteError(error)) {
      return {
        ok: false,
        code: normalizeString(error.code) || 'upload_failed',
        message: normalizeString(error.message) || 'Upload failed',
      };
    }
    return {
      ok: false,
      code: 'upload_failed',
      message: hasErrorMessage(error) ? normalizeString(error.message) || 'Upload failed' : 'Upload failed',
    };
  }
};

const persistResultMediaToFiles = async (rawParams: unknown = {}) => {
  const params = toRawResultMediaPersistenceParams(rawParams);
  const projectPath = normalizeString(params.projectPath);
  if (!projectPath) {
    return { ok: false, code: 'missing_project_path', message: '缺少项目路径' };
  }

  const url = normalizeString(params.url);
  const projectRef = resolveProjectRefByPath(projectPath) ?? undefined;
  const normalizedLocalUrl = normalizeFilesUrl(url, projectRef);
  if (normalizedLocalUrl) {
    return buildSuccessResult({
      url: normalizedLocalUrl,
      originalUrl: normalizedLocalUrl,
      mediaType: normalizeString(params.mediaType) || null,
      mimeType: normalizeString(params.mimeType) || null,
      sizeBytes: getFiniteNumber(params.sizeBytes),
    });
  }

  if (url && isHttpUrl(url)) {
    return await localizeRemoteMediaToFiles({
      projectPath,
      url,
      mediaType: normalizeString(params.mediaType) || null,
      mimeType: undefined,
      source: normalizeString(params.source) || 'ws:business:media-persist-result',
    } as Parameters<typeof localizeRemoteMediaToFiles>[0]);
  }

  if (url && isDataUrl(url)) {
    const decoded = decodeDataUrl(url);
    if (!decoded.ok) {
      return decoded;
    }
    const filename = buildUploadFilename(
      params.filenamePrefix,
      decoded.mimeType,
      params.filename,
    );
    return await persistSerializedUploadToFiles({
      projectPath,
      originalUrl: normalizeString(params.originalUrl) || url,
      mediaType: normalizeString(params.mediaType) || null,
      mimeType: decoded.mimeType,
      sizeBytes: decoded.buffer.length,
      formData: buildSerializedUploadPayload({
        buffer: decoded.buffer,
        mimeType: decoded.mimeType,
        filename,
      }),
    });
  }

  const formData = normalizeSerializedUploadPayload(params.formData);
  if (formData) {
    const files = formData.__formData.files;
    const primaryFile = files.find((item) => normalizeString(item.name) === 'file') ?? files[0] ?? null;
    const mimeType = normalizeString((primaryFile !== null && primaryFile !== undefined ? primaryFile.contentType : undefined)) || 'application/octet-stream';
    const filename = buildUploadFilename(
      params.filenamePrefix,
      mimeType,
      normalizeString(params.filename) || (primaryFile !== null && primaryFile !== undefined ? primaryFile.filename : undefined),
    );
    const primaryFileIndex = primaryFile ? files.indexOf(primaryFile) : -1;
    const normalizedFormData: SerializedUploadPayload = {
      __formData: {
        fields: formData.__formData.fields.slice(),
        files: files.map((item, index) => {
          if (index !== primaryFileIndex) return item;
          return {
            ...item,
            filename,
            contentType: mimeType,
          };
        }),
      },
    };
    return await persistSerializedUploadToFiles({
      projectPath,
      originalUrl: normalizeString(params.originalUrl) || null,
      mediaType: normalizeString(params.mediaType) || null,
      mimeType,
      sizeBytes: getFiniteNumber((primaryFile !== null && primaryFile !== undefined ? primaryFile.size : undefined)),
      formData: normalizedFormData,
    });
  }

  return {
    ok: false,
    code: 'unsupported_media_source',
    message: 'Unsupported result media source',
  };
};

export {
  persistResultMediaToFiles,
};
