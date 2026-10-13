import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  normalizeString,
  isPlainObject,
  type MediaRefSource,
  isSerializedFormDataBody,
  type SerializedFormDataBody,
  type SerializedFormData,
  type SerializedFormDataField,
  type SerializedFormDataFile,
} from '@iart/contracts';
import * as uploadWriteModule from '../upload-write.cts';
import * as contractsModule from '../contracts.cts';
import * as imageProcessingModule from '../image-processing.cts';
import { getMimeType } from '../mime.cts';
import * as imageProcessingSourceResolverModule from '../image-processing-source-resolver.cts';
import * as publicRelayCapabilityModule from '../public-relay-capability.cts';
import * as loggingModule from '../logging.cts';
import { getFetchDispatcher } from '../fetch-dispatcher.cts';
import { resolveProjectRefByPath } from '../project-media-scope.cts';
import { guessFileExtension } from '../request-assembler-runtime.cts';

type FetchInitWithDispatcher = RequestInit & { dispatcher: unknown | undefined };

const { isUploadWriteError, writeProjectMediaUploadFromSerialized } = uploadWriteModule;
const { resolveFilesUrlToFilePathInProject } = imageProcessingModule;
const { resolveImageProcessingSource } = imageProcessingSourceResolverModule;
const { resolvePublicRelayEndpoint } = publicRelayCapabilityModule;
const {
  EDITOR_BACKEND_MEDIA_UPLOAD_MODE,
} = contractsModule;

type BusinessErrorInput = object & {
  code: unknown | undefined;
  message: unknown | undefined;
};

type ProjectRelayFormDataParams = {
  buffer: Uint8Array;
  contentType: unknown | undefined;
  filename: unknown | undefined;
};

type UploadSubmit = object & {
  projectPath: unknown | undefined;
  payload: unknown | undefined;
};

type MediaUploadPayload = object & {
  formData: unknown | undefined;
  targetType: unknown | undefined;
  mode: unknown | undefined;
  fileKey: unknown | undefined;
};

type PreparedMedia = {
  buffer: Buffer;
  contentType: string;
};

type ResolvedFilePath = object & {
  filePath: unknown | undefined;
};

type StoredUpload = object & {
  urlPath: unknown | undefined;
  mimeType: unknown | undefined;
  finalName: unknown | undefined;
};

type PublicUploadResponse = object & {
  error: unknown | undefined;
  message: unknown | undefined;
  url: unknown | undefined;
  success: unknown | undefined;
};

type UploadWriteErrorPayload = object & {
  code: unknown | undefined;
  message: unknown | undefined;
};

const readBusinessErrorInput = (value: unknown): BusinessErrorInput | null =>
  isPlainObject(value) ? value as BusinessErrorInput : null;

const readSerializedFormDataBody = (value: unknown): SerializedFormDataBody | null =>
  isPlainObject(value) ? value as SerializedFormDataBody : null;

const readUploadSubmit = (value: unknown): UploadSubmit | null =>
  isPlainObject(value) ? value as UploadSubmit : null;

const readMediaUploadPayload = (value: unknown): MediaUploadPayload | null =>
  isPlainObject(value) ? value as MediaUploadPayload : null;

const readResolvedFilePath = (value: unknown): ResolvedFilePath | null =>
  isPlainObject(value) ? value as ResolvedFilePath : null;

const readStoredUpload = (value: unknown): StoredUpload | null =>
  isPlainObject(value) ? value as StoredUpload : null;

const readPublicUploadResponse = (value: unknown): PublicUploadResponse | null =>
  isPlainObject(value) ? value as PublicUploadResponse : null;

const readUploadWriteErrorPayload = (value: unknown): UploadWriteErrorPayload | null =>
  isPlainObject(value) ? value as UploadWriteErrorPayload : null;

const normalizeBusinessError = (error: unknown, fallbackCode = 'business_action_failed') => {
  const errorInput = readBusinessErrorInput(error);
  if (errorInput) {
    const code = normalizeString(errorInput.code) || fallbackCode;
    const message = normalizeString(errorInput.message) || 'Business action failed';
    return { code, message };
  }
  return {
    code: fallbackCode,
    message: normalizeString(error) || 'Business action failed',
  };
};

const buildFormDataFromSerialized = (payload: SerializedFormData) => {
  const form = new FormData();
  const fields = Array.isArray(payload.fields) ? payload.fields : [];
  const files = Array.isArray(payload.files) ? payload.files : [];

  for (const rawField of fields) {
    const field = rawField as SerializedFormDataField;
    const name = normalizeString(field.name);
    if (!name) continue;
    form.append(name, field.value === undefined || field.value === null ? '' : String(field.value));
  }

  for (const rawFile of files) {
    const file = rawFile as SerializedFormDataFile;
    const name = normalizeString(file.name);
    const dataBase64 = typeof file.dataBase64 === 'string' ? file.dataBase64 : '';
    if (!name || !dataBase64) continue;
    let buffer: Buffer;
    try {
      buffer = Buffer.from(dataBase64, 'base64');
    } catch {
      continue;
    }
    const contentType = normalizeString(file.contentType) || 'application/octet-stream';
    const filename = normalizeString(file.filename) || 'file';
    form.append(name, new Blob([new Uint8Array(buffer)], { type: contentType }), filename);
  }

  return form;
};

const buildProjectRelayFormData = (params: ProjectRelayFormDataParams) => {
  const form = new FormData();
  const contentType = normalizeString(params.contentType) || 'application/octet-stream';
  const filename = normalizeString(params.filename) || 'file';
  form.append('file', new Blob([new Uint8Array(params.buffer)], { type: contentType }), filename);
  return form;
};

const resolvePublicUploadEndpoint = resolvePublicRelayEndpoint;

const parseJsonSafe = async (response: Response): Promise<PublicUploadResponse | null> => {
  try {
    const parsed = await response.json() as unknown;
    return readPublicUploadResponse(parsed);
  } catch {
    return null;
  }
};

const resolveProjectFilePath = (projectPath: string, filesUrl: string) => {
  const resolved = resolveFilesUrlToFilePathInProject(projectPath, filesUrl) as unknown;
  const resolvedFile = readResolvedFilePath(resolved); return normalizeString(resolvedFile !== null && resolvedFile !== undefined ? resolvedFile.filePath : undefined);
};

const decodeInlineDataSource = (source: MediaRefSource): PreparedMedia | null => {
  if (source.kind !== 'inline_data') {
    return null;
  }
  const data = source.data.trim();
  if (!data) {
    return null;
  }
  try {
    return {
      buffer: Buffer.from(data, 'base64'),
      contentType: source.mimeType || 'application/octet-stream',
    };
  } catch {
    return null;
  }
};

const readFileAsPreparedMedia = (filePath: string): PreparedMedia | null => {
  try {
    if (!fs.statSync(filePath).isFile()) return null;
    return {
      buffer: fs.readFileSync(filePath),
      contentType: getMimeType(filePath),
    };
  } catch {
    return null;
  }
};

const decodeFileUrlPath = (rawUrl: string) => {
  if (!rawUrl.startsWith('file:')) return '';
  try {
    return fileURLToPath(rawUrl);
  } catch {
    return '';
  }
};

const decodeProjectLocalUrlSource = (
  projectPath: string,
  rawUrl: string,
): PreparedMedia | null => {
  if (
    !rawUrl.startsWith('/files/') &&
    !rawUrl.startsWith('/project-media/') &&
    !rawUrl.startsWith('local-media://')
  ) {
    return null;
  }
  try {
    const resolved = resolveImageProcessingSource(projectPath, rawUrl);
    return readFileAsPreparedMedia(resolved.sourceFilePath);
  } catch {
    return null;
  }
};

const decodeUrlSource = (projectPath: string, source: MediaRefSource): PreparedMedia | null => {
  if (source.kind !== 'url') {
    return null;
  }
  const rawUrl = source.url;
  if (!rawUrl || !projectPath) {
    return null;
  }

  const projectLocal = decodeProjectLocalUrlSource(projectPath, rawUrl);
  if (projectLocal) return projectLocal;

  const fileUrlPath = decodeFileUrlPath(rawUrl);
  if (fileUrlPath) return readFileAsPreparedMedia(fileUrlPath);

  return null;
};

const readUploadWriteFailure = (error: unknown) => {
  if (!isUploadWriteError(error)) return null;
  const uploadError = readUploadWriteErrorPayload(error);
  return {
    ok: false,
    code: normalizeString((uploadError !== null && uploadError !== undefined ? uploadError.code : undefined)) || 'upload_failed',
    message: normalizeString((uploadError !== null && uploadError !== undefined ? uploadError.message : undefined)) || 'Upload failed',
  };
};

const uploadPreparedTaskInputMedia = async (params: {
  projectPath: string;
  source: MediaRefSource;
  targetType: string;
  filename: string;
}) => {
  const endpointResult = resolvePublicUploadEndpoint(params.targetType);
  if (!endpointResult.ok) {
    loggingModule.logWarn('[media-upload] endpoint resolution failed', {
      targetType: params.targetType,
      code: endpointResult.code,
      message: endpointResult.message,
    });
    return endpointResult;
  }
  const targetType = endpointResult.targetType;

  const prepared =
    decodeInlineDataSource(params.source) ||
    decodeUrlSource(params.projectPath, params.source);
  if (!prepared) {
    loggingModule.logWarn('[media-upload] input source decode failed', {
      sourceKind: params.source.kind,
      filename: params.filename,
      targetType: params.targetType,
    });
    return { ok: false, code: 'invalid_input_upload_source', message: 'Invalid input upload source' };
  }

  const relayBody = buildProjectRelayFormData({
    buffer: prepared.buffer,
    contentType: prepared.contentType,
    filename: params.filename || `input.${guessFileExtension(prepared.contentType)}`,
  });

  let response: Response;
  try {
    response = await fetch(endpointResult.endpoint, {
      method: 'POST',
      body: relayBody,
      dispatcher: getFetchDispatcher(),
    } as FetchInitWithDispatcher);
  } catch (error: unknown) {
    loggingModule.logWarn('[media-upload] network error', {
      targetType: params.targetType,
      filename: params.filename,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      code: 'upload_network_error',
      message: error instanceof Error && normalizeString(error.message) ? error.message : 'Upload network error',
    };
  }
  const data = await parseJsonSafe(response);
  const errorMessage =
    normalizeString((data !== null && data !== undefined ? data.error : undefined)) ||
    normalizeString((data !== null && data !== undefined ? data.message : undefined)) ||
    `HTTP ${response.status}`;
  if (!response.ok) {
    loggingModule.logWarn('[media-upload] server rejected', {
      targetType: params.targetType,
      status: response.status,
      errorMessage,
    });
    return { ok: false, code: 'upload_failed', message: errorMessage };
  }

  const url = normalizeString((data !== null && data !== undefined ? data.url : undefined));
  if (!url) {
    loggingModule.logWarn('[media-upload] no url in response', {
      targetType: params.targetType,
      status: response.status,
    });
    return { ok: false, code: 'upload_failed', message: 'Upload succeeded but no url returned' };
  }

  return {
    ok: true,
    result: {
      success: (data !== null && data !== undefined ? data.success : undefined) !== false,
      url,
      targetType,
      owner: 'backend',
    },
  };
};

const relayPublicMediaUpload = async (submit: unknown, payload: unknown) => {
  const input = readMediaUploadPayload(payload);
  const formDataPayload = readSerializedFormDataBody((input !== null && input !== undefined ? input.formData : undefined));
  if (!input || !formDataPayload || !isSerializedFormDataBody(input.formData)) {
    return { ok: false, code: 'invalid_payload', message: 'Invalid public upload payload' };
  }

  const endpointResult = resolvePublicUploadEndpoint(input.targetType);
  if (!endpointResult.ok) {
    loggingModule.logWarn('[media-upload] relay endpoint resolution failed', {
      code: endpointResult.code,
      message: endpointResult.message,
    });
    return endpointResult;
  }
  const targetType = endpointResult.targetType;
  const endpoint = endpointResult.endpoint;

  let relayBody = buildFormDataFromSerialized(formDataPayload.__formData);
  const submitInput = readUploadSubmit(submit);
  const projectPath = normalizeString((submitInput !== null && submitInput !== undefined ? submitInput.projectPath : undefined));
  if (!projectPath) {
    return { ok: false, code: 'invalid_project', message: 'Missing projectPath' };
  }
  try {
    const storedRaw = await writeProjectMediaUploadFromSerialized(formDataPayload, {
      strategyId: 'content-hash',
      fileKey: undefined, maxUploadSize: undefined, buildFileTooLargeMessage: undefined,
      projectPath,
      projectRef: resolveProjectRefByPath(projectPath) ?? undefined,
    }) as unknown;
    const stored = readStoredUpload(storedRaw);
    const filePath = resolveProjectFilePath(projectPath, normalizeString((stored !== null && stored !== undefined ? stored.urlPath : undefined)));
    if (!filePath || !fs.existsSync(filePath)) {
      return { ok: false, code: 'upload_failed', message: 'Formal image file not found' };
    }
    relayBody = buildProjectRelayFormData({
      buffer: fs.readFileSync(filePath),
      contentType: normalizeString((stored !== null && stored !== undefined ? stored.mimeType : undefined)) || 'image/png',
      filename: normalizeString((stored !== null && stored !== undefined ? stored.finalName : undefined)) || 'image.png',
    });
  } catch (error: unknown) {
    loggingModule.logWarn('[media-upload] relay local storage write failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    const uploadWriteFailure = readUploadWriteFailure(error);
    return uploadWriteFailure || normalizeBusinessError(error, 'upload_failed');
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    body: relayBody,
    dispatcher: getFetchDispatcher(),
  } as FetchInitWithDispatcher);
  const data = await parseJsonSafe(response);
  const errorMessage =
    normalizeString((data !== null && data !== undefined ? data.error : undefined)) ||
    normalizeString((data !== null && data !== undefined ? data.message : undefined)) ||
    `HTTP ${response.status}`;

  if (!response.ok) {
    loggingModule.logWarn('[media-upload] relay server rejected', {
      status: response.status,
      errorMessage,
    });
    return { ok: false, code: 'upload_failed', message: errorMessage };
  }

  const url = normalizeString((data !== null && data !== undefined ? data.url : undefined));
  if (!url) {
    loggingModule.logWarn('[media-upload] relay no url in response', {
      status: response.status,
    });
    return { ok: false, code: 'upload_failed', message: 'Upload succeeded but no url returned' };
  }

  return {
    ok: true,
    result: {
      success: (data !== null && data !== undefined ? data.success : undefined) !== false,
      url,
      targetType,
      owner: 'backend',
    },
  };
};

const storeProjectMediaUpload = async (submit: unknown, payload: unknown) => {
  const input = readMediaUploadPayload(payload);
  const formDataPayload = readSerializedFormDataBody((input !== null && input !== undefined ? input.formData : undefined));
  if (!input || !formDataPayload || !isSerializedFormDataBody(input.formData)) {
    return { ok: false, code: 'invalid_payload', message: 'Invalid serialized upload payload' };
  }

  const submitInput = readUploadSubmit(submit);
  try {
    const writeOptions: Parameters<typeof writeProjectMediaUploadFromSerialized>[1] = {
      strategyId: 'content-hash',
      projectPath: normalizeString((submitInput !== null && submitInput !== undefined ? submitInput.projectPath : undefined)),
      projectRef: resolveProjectRefByPath(normalizeString((submitInput !== null && submitInput !== undefined ? submitInput.projectPath : undefined))) ?? undefined,
      fileKey: normalizeString(input.fileKey),
      maxUploadSize: undefined,
      buildFileTooLargeMessage: undefined,
    };
    const storedRaw = await writeProjectMediaUploadFromSerialized(formDataPayload, writeOptions);
    const stored = readStoredUpload(storedRaw);

    return {
      ok: true,
      result: {
        success: true,
        url: normalizeString((stored !== null && stored !== undefined ? stored.urlPath : undefined)),
        owner: 'backend',
        adapter: {
          route: '/api/upload',
          mode: 'backend_internal_adapter',
        },
      },
    };
  } catch (error: unknown) {
    const uploadWriteFailure = readUploadWriteFailure(error);
    return uploadWriteFailure || normalizeBusinessError(error, 'upload_failed');
  }
};

const executeModelInputUploadSync = async (submit: unknown) => {
  const submitInput = readUploadSubmit(submit);
  const payload = readMediaUploadPayload((submitInput !== null && submitInput !== undefined ? submitInput.payload : undefined));
  const mode = normalizeString((payload !== null && payload !== undefined ? payload.mode : undefined)).toLowerCase();

  if (mode === EDITOR_BACKEND_MEDIA_UPLOAD_MODE.PUBLIC_RELAY) {
    return relayPublicMediaUpload(submit, payload);
  }

  if (mode !== EDITOR_BACKEND_MEDIA_UPLOAD_MODE.PROJECT_LOCAL) {
    return {
      ok: false,
      code: 'unsupported_mode',
      message: `Unsupported media upload mode: ${mode || '(empty)'}`,
    };
  }

  return storeProjectMediaUpload(submit, payload);
};

export {
  executeModelInputUploadSync,
  uploadPreparedTaskInputMedia,
};
