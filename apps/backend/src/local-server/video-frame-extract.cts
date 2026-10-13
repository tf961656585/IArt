import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';
import type { Sharp, SharpOptions } from 'sharp';
import type { MediaAsset } from '@iart/contracts';
import { deriveContentAddressedAssetId } from './media-asset-id.cts';
import {
  ensureProjectSourceFile,
  resolveFfmpegPath,
  runFfmpeg,
  createMediaProcessingError,
} from './media-processing-actions.cts';
import { resolveLocalMediaUrl, resolveProjectRefByPath } from './project-media-scope.cts';
import { logDebug } from './logging.cts';
import { persistRuntimeMediaAsset } from './runtime-media-assets.cts';
import { repairProjectMediaAssetThumbnail } from './media-asset-registry.cts';

const requireOptional = createRequire(__filename);

type SharpFactory = {
  (input: string | Buffer, options: SharpOptions | undefined): Sharp;
  (options: SharpOptions | undefined): Sharp;
};

let sharpInstance: SharpFactory | null = null;
try {
  const loaded: unknown = requireOptional('sharp');
  sharpInstance = typeof loaded === 'function' ? loaded as SharpFactory : null;
} catch {
  sharpInstance = null;
}

const normalizeString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const readImageDimensions = async (filePath: string): Promise<{ width: number | null; height: number | null }> => {
  if (!sharpInstance) return { width: null, height: null };
  try {
    const metadata = await sharpInstance(filePath, undefined).metadata();
    const width = Number(metadata !== null && metadata !== undefined ? metadata.width : undefined);
    const height = Number(metadata !== null && metadata !== undefined ? metadata.height : undefined);
    return {
      width: Number.isFinite(width) && width > 0 ? width : null,
      height: Number.isFinite(height) && height > 0 ? height : null,
    };
  } catch {
    return { width: null, height: null };
  }
};

/**
 * 视频单帧截取：ffmpeg 抽取 timeSec 时刻的一帧 PNG，落项目 media/processed 目录，
 * 按内容 hash 去重并注册为项目媒体资产（血缘与缩略图由资产注册链路承接）。
 */
const executeVideoFrameExtract = async (projectPathInput: unknown, payload: unknown) => {
  const body = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as { sourceUrl: unknown | undefined; timeSec: unknown | undefined }
    : { sourceUrl: undefined, timeSec: undefined };
  const timeSecRaw = Number(body.timeSec);
  if (!Number.isFinite(timeSecRaw) || timeSecRaw < 0) {
    throw createMediaProcessingError('INVALID_TIME', '截取时间无效', 400);
  }
  const timeSec = timeSecRaw;

  const { projectPath, folderPaths, sourceFilePath, sourceUrl } = ensureProjectSourceFile(
    projectPathInput,
    body.sourceUrl,
  );
  if (!folderPaths || !folderPaths.media) {
    throw createMediaProcessingError('INVALID_PROJECT', 'Project media dir not available', 500);
  }
  const projectRef = resolveProjectRefByPath(projectPath);
  if (!projectRef) {
    throw createMediaProcessingError('INVALID_PROJECT', 'Invalid project ref', 500);
  }

  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) {
    throw createMediaProcessingError(
      'FFMPEG_NOT_AVAILABLE',
      'ffmpeg 不可用：缺少 ffmpeg-static 依赖或二进制路径无效',
      500,
    );
  }

  const outputDir = path.join(folderPaths.media, 'processed');
  fs.mkdirSync(outputDir, { recursive: true });
  const tmpPath = path.join(outputDir, `.tmp-frame-${crypto.randomUUID()}.png`);

  const ffmpegArgs = [
    '-y',
    '-ss', String(timeSec),
    '-i', sourceFilePath,
    '-frames:v', '1',
    tmpPath,
  ];

  let buffer: Buffer;
  try {
    await runFfmpeg(ffmpegPath, ffmpegArgs);
    if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size <= 0) {
      throw createMediaProcessingError('FRAME_EXTRACTION_FAILED', 'ffmpeg extracted zero frames', 500);
    }
    buffer = fs.readFileSync(tmpPath);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch { void 0; }
    if (error !== null && typeof error === 'object' && 'code' in error) throw error;
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw createMediaProcessingError('FRAME_EXTRACTION_FAILED', `Frame extract failed: ${errorMsg}`, 500);
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch { void 0; }
  }

  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  const filename = `${digest}.png`;
  const targetPath = path.join(outputDir, filename);
  if (!fs.existsSync(targetPath)) {
    fs.writeFileSync(targetPath, buffer);
  }
  const fileKey = path.posix.join('processed', filename);
  const url = resolveLocalMediaUrl(projectRef, fileKey);
  if (!url) {
    throw createMediaProcessingError('INVALID_PROJECT', 'Invalid project media url', 500);
  }

  const dimensions = await readImageDimensions(targetPath);
  const stat = fs.statSync(targetPath);
  const assetId = deriveContentAddressedAssetId('image', digest);
  const now = Date.now();
  const mediaAsset: MediaAsset = {
    id: assetId,
    mediaType: 'image',
    original: {
      url,
      projectRef,
      fileKey,
      sourceUrl,
      sourceFileName: null,
      mimeType: 'image/png',
      sizeBytes: Number.isFinite(stat.size) ? stat.size : null,
      width: dimensions.width,
      height: dimensions.height,
      durationMs: null,
      fps: null,
    },
    thumbnail: {
      url: null,
      mimeType: null,
      width: null,
      height: null,
      status: 'missing',
      generatedAt: null,
      error: null,
    },
    lifecycle: { createdAt: now, updatedAt: now },
  };

  const persisted = await persistRuntimeMediaAsset(projectPath, mediaAsset);
  if (!persisted) {
    throw createMediaProcessingError('MEDIA_ASSET_PERSIST_FAILED', 'Failed to persist frame media asset', 500);
  }

  repairProjectMediaAssetThumbnail(projectPath, {
    assetId,
    mediaType: 'image',
    maxEdge: undefined,
    quality: undefined,
    width: undefined,
    timeSec: undefined,
  }).catch((err: unknown) => {
    logDebug('[video-frame-extract] Thumbnail repair failed for asset', {
      assetId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return {
    success: true,
    url,
    assetId,
    mediaAsset,
    meta: {
      timeSec,
      width: dimensions.width,
      height: dimensions.height,
      sourceUrl: normalizeString(sourceUrl) || null,
    },
  };
};

export {
  executeVideoFrameExtract,
};
