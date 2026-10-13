import * as constantsModule from '../constants.cts';
import * as httpUtilsModule from '../http-utils.cts';
import * as loggingModule from '../logging.cts';
import * as mediaAssetRegistryModule from '../media-asset-registry.cts';
import * as mediaProcessingActionsModule from '../media-processing-actions.cts';
import * as videoSpriteSheetModule from '../video-sprite-sheet.cts';
import * as videoFrameExtractModule from '../video-frame-extract.cts';
import * as videoTrimExecutorModule from '../video-trim-executor.cts';
import * as remoteLocalizeModule from '../media-localization/remote-localize.cts';
import * as storageModule from '../storage.cts';
import { readJsonBodyOrSendError } from '../http/json-route.cts';
import type { RouteDefinition } from '../http/route-registry.cts';
import type { ImageProcessingOperation } from '@iart/contracts/media-processing-contract';

type ImageRequestBodyLike = {
  path: unknown | undefined;
  projectPath: unknown | undefined;
  sourceUrl: unknown | undefined;
  source: unknown | undefined;
  operation: unknown | undefined;
  percent: unknown | undefined;
  threshold: unknown | undefined;
  mode: unknown | undefined;
  x: unknown | undefined;
  left: unknown | undefined;
  y: unknown | undefined;
  top: unknown | undefined;
  width: unknown | undefined;
  w: unknown | undefined;
  height: unknown | undefined;
  h: unknown | undefined;
  horizontalPercents: unknown | undefined;
  verticalPercents: unknown | undefined;
  ops: unknown | undefined;
};

type MediaLocalizeBodyLike = { projectPath: unknown | undefined; url: unknown | undefined };
type MediaLocalizeResultLike = {
  ok: unknown | undefined;
  code: unknown | undefined;
  message: unknown | undefined;
  url: unknown | undefined;
  originalUrl: unknown | undefined;
  mediaType: unknown | undefined;
  mimeType: unknown | undefined;
  sizeBytes: unknown | undefined;
};
type MediaProcessingBodyLike = {
  assetId: unknown | undefined;
  mediaType: unknown | undefined;
  path: unknown | undefined;
  sourceUrl: unknown | undefined;
  maxEdge: unknown | undefined;
  quality: unknown | undefined;
  width: unknown | undefined;
  timeSec: unknown | undefined;
  startTime: unknown | undefined;
  endTime: unknown | undefined;
  format: unknown | undefined;
  withAudio: unknown | undefined;
};
type MediaProcessingResultLike = { url: unknown | undefined; meta: unknown | undefined };
type ThumbnailRepairResultLike = { assetId: unknown | undefined; asset: unknown | undefined; result: unknown | undefined };
type ErrorShape = { status: number | undefined; code: string | undefined };

type MediaRouteOptions = {
  getServerPort: () => number | null;
};

const { ERROR_CODES } = constantsModule;
const { sendJson, sendError } = httpUtilsModule;
const { isValidProjectFolder } = storageModule;
const { logWarn } = loggingModule;
const { repairProjectMediaAssetThumbnail } = mediaAssetRegistryModule;
const { buildImageProcessingRequestFromLegacyPayload, executeImageProcessing } =
  mediaProcessingActionsModule;
const { executeVideoSpriteSheet } = videoSpriteSheetModule;
const { executeVideoFrameExtract } = videoFrameExtractModule;
const { executeVideoTrim } = videoTrimExecutorModule;
const { localizeRemoteMediaToFiles } = remoteLocalizeModule;

const isJsonObject = (value: unknown): value is object =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const getImageRequestBodyLike = (value: unknown): ImageRequestBodyLike | null => isJsonObject(value) ? (value as ImageRequestBodyLike) : null;
const getMediaLocalizeBodyLike = (value: unknown): MediaLocalizeBodyLike | null => isJsonObject(value) ? (value as MediaLocalizeBodyLike) : null;
const getMediaLocalizeResultLike = (value: unknown): MediaLocalizeResultLike | null => isJsonObject(value) ? (value as MediaLocalizeResultLike) : null;
const getMediaProcessingBodyLike = (value: unknown): MediaProcessingBodyLike | null => isJsonObject(value) ? (value as MediaProcessingBodyLike) : null;
const getMediaProcessingResultLike = (value: unknown): MediaProcessingResultLike | null => isJsonObject(value) ? (value as MediaProcessingResultLike) : null;
const getThumbnailRepairResultLike = (value: unknown): ThumbnailRepairResultLike | null => isJsonObject(value) ? (value as ThumbnailRepairResultLike) : null;
const getErrorShape = (error: unknown): ErrorShape | null => {
  if (!isJsonObject(error)) return null;
  const source = error as ErrorShape;
  return {
    status: Number.isFinite(source.status) ? Number(source.status) : undefined,
    code: typeof source.code === 'string' ? source.code : undefined,
  } as ErrorShape;
};
const normalizeStr = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : '');
const parseMediaProcessingPayload = (body: MediaProcessingBodyLike) => {
  const projectPath = typeof body.path === 'string' && body.path.trim() ? body.path.trim() : null;
  const sourceUrl = typeof body.sourceUrl === 'string' && body.sourceUrl.trim() ? body.sourceUrl.trim() : null;
  const assetId = typeof body.assetId === 'string' && body.assetId.trim() ? body.assetId.trim() : null;
  return { projectPath, sourceUrl, assetId };
};
const parseImageProcessingProjectPath = (body: ImageRequestBodyLike) =>
  normalizeStr(body.projectPath) || normalizeStr(body.path);
const getImageProcessingOperationTypeForPathname = (
  pathname: string,
): ImageProcessingOperation['type'] | null => {
  if (pathname === '/api/image/resize') return 'resize';
  if (pathname === '/api/image/crop') return 'crop';
  if (pathname === '/api/image/split') return 'split';
  if (pathname === '/api/image/edge-detect') return 'edgeDetect';
  if (pathname === '/api/image/chroma-key') return 'chromaKey';
  if (pathname === '/api/image/transform') return 'transform';
  return null;
};
const createMediaRoutes = (_options: MediaRouteOptions): RouteDefinition[] => [
  {
    name: 'media-localize',
    match: ({ req, pathname }) => pathname === '/api/media/localize' && req.method === 'POST',
    handle: async ({ req, res, corsHeaders }) => {
      const body = await readJsonBodyOrSendError(req, res, corsHeaders);
      if (body == null) return;
      const typedBody = getMediaLocalizeBodyLike(body);
      const projectPath = typedBody !== null && typeof typedBody.projectPath === 'string' ? typedBody.projectPath.trim() : '';
      const url = typedBody !== null && typeof typedBody.url === 'string' ? typedBody.url.trim() : '';
      if (!projectPath || !isValidProjectFolder(projectPath)) {
        sendError(res, 400, ERROR_CODES.INVALID_PROJECT, 'Invalid project path', corsHeaders);
        return;
      }
      if (!url) {
        sendJson(res, 400, { error: 'Missing url', code: ERROR_CODES.INVALID_URL }, corsHeaders);
        return;
      }
      try {
        const result = getMediaLocalizeResultLike(await localizeRemoteMediaToFiles({ projectPath, url, source: 'api:media-localize', mediaType: undefined, mimeType: undefined }));
        if (!result) {
          sendJson(res, 500, { error: 'download_failed', code: 'download_failed' }, corsHeaders);
          return;
        }
        if (!result.ok) {
          if (result.code === ERROR_CODES.INVALID_URL || result.code === 'invalid_url') {
            sendJson(res, 400, { error: result.message, code: ERROR_CODES.INVALID_URL }, corsHeaders);
            return;
          }
          if (result.code === ERROR_CODES.REMOTE_HOST_NOT_ALLOWED || result.code === 'remote_host_not_allowed') {
            sendJson(res, 403, { error: result.message, code: ERROR_CODES.REMOTE_HOST_NOT_ALLOWED }, corsHeaders);
            return;
          }
          if (result.code === 'missing_media_dir' || result.code === 'invalid_project_path') {
            sendError(res, 500, ERROR_CODES.INVALID_PROJECT, result.message, corsHeaders);
            return;
          }
          sendJson(res, 500, { error: result.message, code: result.code || 'download_failed' }, corsHeaders);
          return;
        }
        const hasMediaOutput = typeof result.url === 'string' && typeof result.mediaType === 'string' && result.mediaType !== 'text';
        sendJson(res, 200, {
          success: true,
          url: result.url ?? null,
          originalUrl: result.originalUrl ?? null,
          mediaType: result.mediaType ?? null,
          mimeType: result.mimeType ?? null,
          sizeBytes: result.sizeBytes ?? null,
          ...(hasMediaOutput ? {
            assetId: null,
            mediaAsset: { mediaType: result.mediaType ?? null, original: { url: result.url ?? null, mimeType: result.mimeType ?? null, sizeBytes: result.sizeBytes ?? null } },
          } : {}),
        }, corsHeaders);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { error: message, code: 'download_failed' }, corsHeaders);
      }
    },
  },
  {
    name: 'media-thumbnail',
    match: ({ req, pathname }) => req.method === 'POST' && (pathname === '/api/media/image/thumbnail' || pathname === '/api/media/video/thumbnail'),
    handle: async ({ req, res, pathname, corsHeaders }) => {
      const body = await readJsonBodyOrSendError(req, res, corsHeaders);
      if (body == null) return;
      const typedBody = getMediaProcessingBodyLike(body) ?? ({} as MediaProcessingBodyLike);
      const { projectPath, assetId } = parseMediaProcessingPayload(typedBody);
      if (!projectPath || !isValidProjectFolder(projectPath)) {
        sendError(res, 400, ERROR_CODES.INVALID_PROJECT, 'Invalid payload', corsHeaders);
        return;
      }
      if (!assetId) {
        sendJson(res, 400, { success: false, error: 'missing_media_asset_id', code: 'missing_media_asset_id' }, corsHeaders);
        return;
      }
      try {
        const mediaType = pathname.includes('/image/') ? 'image' : 'video';
        const repair = getThumbnailRepairResultLike(await repairProjectMediaAssetThumbnail(projectPath, {
          assetId,
          mediaType,
          maxEdge: typedBody.maxEdge,
          quality: typedBody.quality,
          width: typedBody.width,
          timeSec: typedBody.timeSec,
        }));
        const mediaAssetRaw = (repair !== null && repair !== undefined ? repair.asset : undefined);
        const mediaAsset = isJsonObject(mediaAssetRaw) ? (mediaAssetRaw as { thumbnail: { url: unknown | undefined } | undefined }) : null;
        const result = getMediaProcessingResultLike((repair !== null && repair !== undefined ? repair.result : undefined));
        const mediaAssetThumbnailUrl = mediaAsset !== null && mediaAsset !== undefined && mediaAsset.thumbnail !== null && mediaAsset.thumbnail !== undefined ? mediaAsset.thumbnail.url : undefined;
        const formalThumbnailUrl = normalizeStr(mediaAssetThumbnailUrl) || normalizeStr((result !== null && result !== undefined ? result.url : undefined));
        sendJson(res, 200, {
          success: true,
          assetId: normalizeStr((repair !== null && repair !== undefined ? repair.assetId : undefined)) || assetId || null,
          mediaAsset,
          url: formalThumbnailUrl,
          meta: (result !== null && result !== undefined ? result.meta : undefined) ?? null,
        }, corsHeaders);
      } catch (error) {
        const errorShape = getErrorShape(error);
        const errorCode = (errorShape !== null && errorShape !== undefined ? errorShape.code : undefined) ?? 'THUMBNAIL_FAILED';
        const status = (errorShape !== null && errorShape !== undefined ? errorShape.status : undefined) ?? 500;
        const errorMsg = error instanceof Error ? error.message : String(error);
        sendJson(res, status, { success: false, error: errorMsg, code: errorCode }, corsHeaders);
      }
    },
  },
  {
    name: 'image-processing',
    match: ({ req, pathname }) => req.method === 'POST' && pathname.startsWith('/api/image/'),
    handle: async ({ req, res, pathname, corsHeaders }) => {
      const body = await readJsonBodyOrSendError(req, res, corsHeaders);
      if (body == null) return;
      const typedBody = getImageRequestBodyLike(body) ?? ({} as ImageRequestBodyLike);
      const projectPath = parseImageProcessingProjectPath(typedBody);
      if (!projectPath || !isValidProjectFolder(projectPath)) {
        sendError(res, 400, ERROR_CODES.INVALID_PROJECT, 'Invalid payload', corsHeaders);
        return;
      }
      const operationType = getImageProcessingOperationTypeForPathname(pathname);
      const requestPayload =
        pathname === '/api/image/process'
          ? { source: typedBody.source, operation: typedBody.operation }
          : operationType
            ? buildImageProcessingRequestFromLegacyPayload(typedBody, operationType)
            : null;
      if (!requestPayload) {
        sendJson(res, 404, { success: false, error: 'Not found', code: ERROR_CODES.NOT_FOUND }, corsHeaders);
        return;
      }
      try {
        const result = await executeImageProcessing(projectPath, requestPayload);
        sendJson(res, 200, result, corsHeaders);
      } catch (error) {
        const errorShape = getErrorShape(error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        logWarn('image processing failed', { pathname, error: errorMsg, code: (errorShape !== null && errorShape !== undefined ? errorShape.code : undefined) ?? null });
        sendJson(res, (errorShape !== null && errorShape !== undefined ? errorShape.status : undefined) ?? 500, {
          success: false,
          error: errorMsg,
          code: (errorShape !== null && errorShape !== undefined ? errorShape.code : undefined) ?? 'IMAGE_PROCESSING_FAILED',
        }, corsHeaders);
      }
    },
  },
  {
    name: 'video-spritesheet',
    match: ({ req, pathname }) => pathname === '/api/media/video/spritesheet' && req.method === 'POST',
    handle: async ({ req, res, corsHeaders }) => {
      const body = await readJsonBodyOrSendError(req, res, corsHeaders);
      if (body == null) return;
      const typedBody = getMediaProcessingBodyLike(body) ?? ({} as MediaProcessingBodyLike);
      const { projectPath } = parseMediaProcessingPayload(typedBody);
      if (!projectPath || !isValidProjectFolder(projectPath)) {
        sendError(res, 400, ERROR_CODES.INVALID_PROJECT, 'Invalid payload', corsHeaders);
        return;
      }
      try {
        const result = await executeVideoSpriteSheet(projectPath, body);
        sendJson(res, 200, result, corsHeaders);
      } catch (error) {
        const errorShape = getErrorShape(error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        logWarn('video sprite sheet failed', { error: errorMsg, code: (errorShape !== null && errorShape !== undefined ? errorShape.code : undefined) ?? null });
        sendJson(res, (errorShape !== null && errorShape !== undefined ? errorShape.status : undefined) ?? 500, {
          success: false,
          error: errorMsg,
          code: (errorShape !== null && errorShape !== undefined ? errorShape.code : undefined) ?? 'SPRITE_SHEET_FAILED',
        }, corsHeaders);
      }
    },
  },
  {
    name: 'video-trim',
    match: ({ req, pathname }) => pathname === '/api/media/video/trim' && req.method === 'POST',
    handle: async ({ req, res, corsHeaders }) => {
      const body = await readJsonBodyOrSendError(req, res, corsHeaders);
      if (body == null) return;
      const typedBody = getMediaProcessingBodyLike(body) ?? ({} as MediaProcessingBodyLike);
      const { projectPath, sourceUrl } = parseMediaProcessingPayload(typedBody);
      const startTimeRaw = Number(typedBody.startTime);
      const endTimeRaw = Number(typedBody.endTime);
      const format = typeof typedBody.format === 'string' && typedBody.format.trim() ? typedBody.format.trim().toLowerCase() : 'mp4';
      const withAudio = typedBody.withAudio !== false;
      if (!projectPath || !isValidProjectFolder(projectPath) || !sourceUrl) { sendError(res, 400, ERROR_CODES.INVALID_PROJECT, 'Invalid payload', corsHeaders); return; }
      if (format !== 'mp4') { sendJson(res, 400, { success: false, error: '仅支持 mp4', code: 'INVALID_FORMAT' }, corsHeaders); return; }
      if (!Number.isFinite(startTimeRaw) || !Number.isFinite(endTimeRaw)) { sendJson(res, 400, { success: false, error: '时间参数无效', code: 'INVALID_TIME' }, corsHeaders); return; }
      const startTime = Math.max(0, startTimeRaw);
      const endTime = Math.max(0, endTimeRaw);
      if (endTime <= startTime) { sendJson(res, 400, { success: false, error: 'endTime 必须大于 startTime', code: 'INVALID_RANGE' }, corsHeaders); return; }
      // 截取执行体抽至 video-trim-executor.cts（agent 加工工具 trim_video 共用同一执行链）
      try {
        const result = await executeVideoTrim({ projectPath, sourceUrl, startTime, endTime, withAudio });
        sendJson(res, 200, { success: true, url: result.url, assetId: result.assetId, mediaAsset: result.mediaAsset, meta: result.meta }, corsHeaders);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (errorMsg.includes('Source file not found')) {
          sendJson(res, 404, { success: false, error: 'Source file not found', code: ERROR_CODES.FILE_NOT_FOUND }, corsHeaders);
          return;
        }
        sendJson(res, 500, { success: false, error: errorMsg, code: 'TRIM_FAILED' }, corsHeaders);
      }
    },
  },
  {
    name: 'video-frame-extract',
    match: ({ req, pathname }) => pathname === '/api/media/video/frame' && req.method === 'POST',
    handle: async ({ req, res, corsHeaders }) => {
      const body = await readJsonBodyOrSendError(req, res, corsHeaders);
      if (body == null) return;
      const typedBody = getMediaProcessingBodyLike(body) ?? ({} as MediaProcessingBodyLike);
      const { projectPath, sourceUrl } = parseMediaProcessingPayload(typedBody);
      const timeSecRaw = Number(typedBody.timeSec);
      if (!projectPath || !isValidProjectFolder(projectPath) || !sourceUrl) { sendError(res, 400, ERROR_CODES.INVALID_PROJECT, 'Invalid payload', corsHeaders); return; }
      if (!Number.isFinite(timeSecRaw) || timeSecRaw < 0) { sendJson(res, 400, { success: false, error: '截取时间无效', code: 'INVALID_TIME' }, corsHeaders); return; }
      try {
        const result = await executeVideoFrameExtract(projectPath, { sourceUrl, timeSec: timeSecRaw });
        sendJson(res, 200, result, corsHeaders);
      } catch (error) {
        const errorShape = getErrorShape(error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        logWarn('video frame extract failed', { sourceUrl, timeSec: timeSecRaw, error: errorMsg, code: (errorShape !== null && errorShape !== undefined ? errorShape.code : undefined) ?? null });
        sendJson(res, (errorShape !== null && errorShape !== undefined ? errorShape.status : undefined) ?? 500, {
          success: false,
          error: errorMsg,
          code: (errorShape !== null && errorShape !== undefined ? errorShape.code : undefined) ?? 'FRAME_EXTRACTION_FAILED',
        }, corsHeaders);
      }
    },
  },
];

export { createMediaRoutes };
