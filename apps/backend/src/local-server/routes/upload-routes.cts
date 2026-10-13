import type { IncomingHttpHeaders } from 'node:http';

import * as businessActionsModule from '../business-actions.cts';
import * as configStoreModule from '../config-store.cts';
import * as constantsModule from '../constants.cts';
import * as contractsModule from '../contracts.cts';
import * as httpUtilsModule from '../http-utils.cts';
import * as loggingModule from '../logging.cts';
import * as uploadWriteModule from '../upload-write.cts';
import type { RouteDefinition } from '../http/route-registry.cts';
import { resolveProjectRefByPath } from '../project-media-scope.cts';

type MultipartField = { name: string; value: string };
type MultipartFile = { name: string; filename: string; contentType: string; dataBase64: string };
type MultipartSubmission = {
  mode: string;
  targetType: string;
  projectPath: string;
  fileKey: string;
  formData: {
    __formData: { fields: MultipartField[]; files: MultipartFile[] };
  };
};
type BusboyInfo = { filename: string | undefined; mimeType: string | undefined };
type BusboyInstance = NodeJS.WritableStream & {
  on(event: 'field', listener: (fieldname: unknown, value: unknown) => void): BusboyInstance;
  on(event: 'file', listener: (fieldname: unknown, file: NodeJS.ReadableStream, info: BusboyInfo) => void): BusboyInstance;
  on(event: 'error', listener: (error: unknown) => void): BusboyInstance;
  on(event: 'finish', listener: () => void): BusboyInstance;
};
type BusboyFactoryOptions = { headers: IncomingHttpHeaders; limits: { fileSize: number | undefined } | undefined };
type BusboyFactory = (options: BusboyFactoryOptions) => BusboyInstance;
type UploadExecutionResultLike = { url: unknown | undefined };
type UploadExecutionLike = { ok: unknown | undefined; message: unknown | undefined; code: unknown | undefined; result: unknown | undefined };
type UploadErrorShape = { status: number | undefined; code: string | undefined };
type UploadRouteOptions = {
  buildFileTooLargeMessage: (maxBytes: unknown) => string;
  getServerPort: () => number | null;
  ensureProjectFilesResolvable: (projectPath: unknown) => void;
};

const { ERROR_CODES, HOST } = constantsModule;
const { EDITOR_BACKEND_ACTION_NAME, EDITOR_BACKEND_ACTION_CLASS } = contractsModule;
const { sendJson } = httpUtilsModule;
const { getEffectiveMaxUploadSize } = configStoreModule;
const { logWarn } = loggingModule;
const { executeBusinessSyncAction } = businessActionsModule;
const { writeProjectMediaUploadFromMultipart, writeProjectMediaUploadFromSerialized, isUploadWriteError } = uploadWriteModule;
const Busboy = require('busboy') as BusboyFactory;

const isJsonObject = (value: unknown): value is object =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const normalizeStr = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : '');
const getUploadExecutionLike = (value: unknown): UploadExecutionLike | null => isJsonObject(value) ? value as UploadExecutionLike : null;
const getUploadExecutionResultLike = (value: unknown): UploadExecutionResultLike | null => isJsonObject(value) ? value as UploadExecutionResultLike : null;
const getUploadErrorShape = (value: unknown): UploadErrorShape | null => isJsonObject(value) ? value as UploadErrorShape : null;
const getErrorShape = (error: unknown): UploadErrorShape | null => {
  const errorShape = getUploadErrorShape(error);
  if (!errorShape) return null;
  return {
    status: Number.isFinite(errorShape.status) ? Number(errorShape.status) : undefined,
    code: typeof errorShape.code === 'string' ? errorShape.code : undefined,
  };
};
const buildBaseUrl = (hostHeader: unknown, serverPort: number | null) => {
  const host = normalizeStr(hostHeader) || (serverPort ? `${HOST}:${serverPort}` : HOST);
  return host ? `http://${host}` : '';
};

/**
 * 组合上传产物 URL：相对路径（/files/...）拼 baseUrl；完整 scheme URL（local-media://...）
 * 直接原样返回。两者混用场景由 upload-write 的 urlPath 决定（有 projectRef 时产 local-media://，
 * 否则 /files/ 路径）。
 */
const buildUploadFileUrl = (baseUrl: string, urlPath: string | null | undefined) => {
  const normalized = normalizeStr(urlPath);
  if (!normalized) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) return normalized;
  return `${baseUrl}${normalized}`;
};

const readMultipartUploadSubmission = async (req: NodeJS.ReadableStream & { headers: IncomingHttpHeaders }): Promise<MultipartSubmission> => new Promise((resolve, reject) => {
  const fields: MultipartField[] = [];
  const files: MultipartFile[] = [];
  let busboy: BusboyInstance | null = null;
  try {
    busboy = Busboy({ headers: req.headers, limits: undefined });
  } catch (error) {
    reject(error);
    return;
  }
  busboy.on('field', (fieldname: unknown, value: unknown) => {
    const name = normalizeStr(fieldname);
    if (!name) return;
    fields.push({ name, value: value === undefined || value === null ? '' : String(value) });
  });
  busboy.on('file', (fieldname: unknown, file: NodeJS.ReadableStream, info: BusboyInfo) => {
    const name = normalizeStr(fieldname);
    const chunks: Buffer[] = [];
    file.on('data', (chunk: unknown) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    file.on('end', () => {
      files.push({
        name: name || 'file',
        filename: normalizeStr((info !== null && info !== undefined ? info.filename : undefined)) || 'file',
        contentType: normalizeStr((info !== null && info !== undefined ? info.mimeType : undefined)) || 'application/octet-stream',
        dataBase64: Buffer.concat(chunks).toString('base64'),
      });
    });
    file.on('error', reject);
  });
  busboy.on('error', (error: unknown) => reject(error));
  busboy.on('finish', () => {
    const getField = (fieldName: unknown) => {
      const found = fields.find((field) => field.name === normalizeStr(fieldName));
      return (found !== null && found !== undefined ? found.value : undefined) || '';
    };
    resolve({
      mode: normalizeStr(getField('mode')),
      targetType: normalizeStr(getField('targetType')),
      projectPath: normalizeStr(getField('projectPath')),
      fileKey: normalizeStr(getField('fileKey')),
      formData: { __formData: { fields, files } },
    });
  });
  req.pipe(busboy);
});

const createUploadRoutes = ({ buildFileTooLargeMessage, getServerPort, ensureProjectFilesResolvable }: UploadRouteOptions): RouteDefinition[] => [
  {
    name: 'upload',
    match: ({ req, pathname }) => req.method === 'POST' && pathname === '/api/upload',
    handle: async ({ req, res, pathname, corsHeaders }) => {
      const maxUploadSize = getEffectiveMaxUploadSize();
      const strategyId = 'content-hash';
      try {
        const contentType = normalizeStr(req.headers['content-type']);
        if (pathname === '/api/upload' && contentType.toLowerCase().includes('multipart/form-data')) {
          const submission = await readMultipartUploadSubmission(req);
          if (submission.mode === 'public_relay') {
            const execution = getUploadExecutionLike(await executeBusinessSyncAction({
              actionId: `http_upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              actionName: EDITOR_BACKEND_ACTION_NAME.MEDIA_UPLOAD,
              actionClass: EDITOR_BACKEND_ACTION_CLASS.BUSINESS_SYNC,
              projectPath: submission.projectPath,
              payload: {
                mode: submission.mode,
                targetType: submission.targetType,
                fileKey: submission.fileKey || undefined,
                formData: submission.formData,
              },
            }));
            if (execution === null || execution === undefined || !execution.ok) {
              sendJson(res, 400, {
                success: false,
                error: (execution !== null && execution !== undefined ? execution.message : undefined) || 'Upload failed',
                message: (execution !== null && execution !== undefined ? execution.message : undefined) || 'Upload failed',
                code: (execution !== null && execution !== undefined ? execution.code : undefined) || ERROR_CODES.UPLOAD_FAILED,
              }, corsHeaders);
              return;
            }
            const execResult = getUploadExecutionResultLike(execution.result);
            sendJson(res, 200, { success: true, url: normalizeStr(execResult !== null && execResult !== undefined ? execResult.url : undefined) }, corsHeaders);
            return;
          }
          const result = await writeProjectMediaUploadFromSerialized(submission.formData, {
            strategyId,
            projectPath: submission.projectPath,
            projectRef: resolveProjectRefByPath(submission.projectPath) ?? undefined,
            fileKey: undefined,
            maxUploadSize: undefined,
            buildFileTooLargeMessage: undefined,
          });
          const fileUrl = buildUploadFileUrl(buildBaseUrl(req.headers.host, getServerPort()), (result !== null && result !== undefined ? result.urlPath : undefined));
          ensureProjectFilesResolvable((result !== null && result !== undefined ? result.projectPath : undefined));
          sendJson(res, 200, { success: true, url: fileUrl }, corsHeaders);
          return;
        }
        const result = await writeProjectMediaUploadFromMultipart(req, {
          strategyId,
          projectPath: undefined,
          projectRef: undefined,
          fileKey: undefined,
          maxUploadSize,
          buildFileTooLargeMessage,
        });
        const fileUrl = buildUploadFileUrl(buildBaseUrl(req.headers.host, getServerPort()), (result !== null && result !== undefined ? result.urlPath : undefined));
        ensureProjectFilesResolvable((result !== null && result !== undefined ? result.projectPath : undefined));
        sendJson(res, 200, { success: true, url: fileUrl }, corsHeaders);
      } catch (error) {
        const errorShape = isUploadWriteError(error) ? getErrorShape(error) : null;
        const status = (errorShape !== null && errorShape !== undefined ? errorShape.status : undefined) ?? 400;
        const code = (errorShape !== null && errorShape !== undefined ? errorShape.code : undefined) ?? ERROR_CODES.UPLOAD_FAILED;
        const message = error instanceof Error ? error.message : String(error);
        logWarn('upload failed', { error: message });
        sendJson(res, status, { success: false, error: message, message, code }, corsHeaders);
      }
    },
  },
];

export { createUploadRoutes };
