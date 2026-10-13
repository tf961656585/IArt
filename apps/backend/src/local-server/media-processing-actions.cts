import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import type { Sharp, SharpOptions } from 'sharp';
import { logWarn } from './logging.cts';
const requireOptional = createRequire(__filename);
type SharpFactory = (input: string | Buffer, options: SharpOptions | undefined) => Sharp;
const getRequireErrorMeta = (error: unknown) => {
  if (error instanceof Error) {
    const code =
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : '';
    return {
      module: 'sharp',
      code,
      message: error.message,
      stackHead: typeof error.stack === 'string' ? error.stack.split(/\r?\n/, 1)[0] : '',
    };
  }
  return { module: 'sharp', code: '', message: String(error), stackHead: '' };
};
let sharp: SharpFactory | null = null;
try {
  sharp = requireOptional('sharp') as SharpFactory;
} catch (error) {
  logWarn('optional native dependency unavailable', getRequireErrorMeta(error));
  sharp = null;
}
let ffmpegStatic: string | null = null;
try {
  const resolvedFfmpegStatic: unknown = requireOptional('ffmpeg-static');
  ffmpegStatic = typeof resolvedFfmpegStatic === 'string' ? resolvedFfmpegStatic : null;
} catch {
  ffmpegStatic = null;
}
import {
  ensureFilesUrlToFilePathInProject,
} from './image-processing.cts';
import {
  buildImageProcessingRequestFromLegacyPayload,
  executeImageProcessing,
} from './image-processing-executor.cts';
import { ensureProjectFolderDirs, isValidProjectFolder } from './storage.cts';
import { resolveExecutablePath } from './executable-path.cts';
import { resolveLocalMediaUrl, resolveProjectRefByPath } from './project-media-scope.cts';
type MediaProcessingError = Error & {
  code: string | undefined;
  status: number | undefined;
};
const normalizeString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
type MediaActionPayload = {
  projectPath: unknown | undefined;
  sourceUrl: unknown | undefined;
  source: unknown | undefined;
  operation: unknown | undefined;
  maxEdge: unknown | undefined;
  quality: unknown | undefined;
  width: unknown | undefined;
  height: unknown | undefined;
  percent: unknown | undefined;
  x: unknown | undefined;
  y: unknown | undefined;
  left: unknown | undefined;
  top: unknown | undefined;
  w: unknown | undefined;
  h: unknown | undefined;
  horizontalPercents: unknown | undefined;
  verticalPercents: unknown | undefined;
  timeSec: unknown | undefined;
  threshold: unknown | undefined;
  mode: unknown | undefined;
  ops: unknown | undefined;
};
const asMediaActionPayload = (value: unknown): MediaActionPayload => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {} as MediaActionPayload;
  return value as MediaActionPayload;
};
const createMediaProcessingError = (code: string, message: string, status = 400) => {
  const error = new Error(message) as MediaProcessingError;
  error.code = code;
  error.status = status;
  return error;
};
const readGeneratedImageDimensions = async (filePath: string) => {
  if (!sharp || !filePath) {
    return { thumbnailWidth: null, thumbnailHeight: null };
  }
  try {
    const metadata = await sharp(filePath, undefined).metadata();
    return {
      thumbnailWidth: Number.isFinite((metadata !== null && metadata !== undefined ? metadata.width : undefined)) ? Number(metadata.width) : null,
      thumbnailHeight: Number.isFinite((metadata !== null && metadata !== undefined ? metadata.height : undefined)) ? Number(metadata.height) : null,
    };
  } catch {
    return { thumbnailWidth: null, thumbnailHeight: null };
  }
};
const clampImageThumbnailQuality = (value: unknown) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0.8;
  return Math.min(0.95, Math.max(0.1, num));
};
const clampImageThumbnailMaxEdge = (value: unknown) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 512;
  return Math.min(2048, Math.max(64, Math.round(num)));
};
const clampVideoThumbnailWidth = (value: unknown) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 512;
  return Math.min(512, Math.max(64, Math.round(num)));
};
const clampVideoThumbnailQuality = (value: unknown) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0.7;
  return Math.min(0.95, Math.max(0.1, num));
};
const clampVideoThumbnailTime = (value: unknown) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, num);
};
const ensureProjectSourceFile = (projectPath: unknown, sourceUrl: unknown) => {
  const normalizedProjectPath = normalizeString(projectPath);
  const normalizedSourceUrl = normalizeString(sourceUrl);
  if (!normalizedProjectPath || !isValidProjectFolder(normalizedProjectPath) || !normalizedSourceUrl) {
    throw createMediaProcessingError('INVALID_PROJECT', 'Invalid payload');
  }
  const folderPaths = ensureProjectFolderDirs(normalizedProjectPath);
  if (!(folderPaths !== null && folderPaths !== undefined ? folderPaths.media : undefined)) {
    throw createMediaProcessingError('INVALID_PROJECT', 'Project media dir not available', 500);
  }
  const resolved = ensureFilesUrlToFilePathInProject(normalizedProjectPath, normalizedSourceUrl);
  if (!resolved || !resolved.filePath || !fs.existsSync(resolved.filePath)) {
    throw createMediaProcessingError('FILE_NOT_FOUND', 'Source file not found', 404);
  }
  return {
    projectPath: normalizedProjectPath,
    sourceUrl: normalizedSourceUrl,
    folderPaths,
    sourceFilePath: resolved.filePath,
    sourceFileKey: resolved.fileKey,
  };
};
const resolveFfmpegPath = () => resolveExecutablePath(ffmpegStatic);
const runFfmpeg = async (ffmpegPath: string, args: string[]): Promise<boolean> =>
  await new Promise<boolean>((resolve, reject) => {
    let stderr = '';
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer | string) => {
        try {
          stderr += chunk.toString();
        } catch { void 0; }
      });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(true);
        return;
      }
      const message = stderr ? stderr.trim().slice(-2000) : `ffmpeg exited with code ${code}`;
      reject(new Error(message));
    });
  });
const executeImageThumbnail = async (payload: unknown) => {
  const input = asMediaActionPayload(payload);
  const { projectPath, folderPaths, sourceFilePath, sourceFileKey, sourceUrl } = ensureProjectSourceFile(
    input.projectPath,
    input.sourceUrl,
  );
  const projectRef = resolveProjectRefByPath(projectPath);
  if (!projectRef) throw createMediaProcessingError('INVALID_PROJECT', 'Failed to build project ref', 500);
  const maxEdge = clampImageThumbnailMaxEdge(input.maxEdge);
  const quality = clampImageThumbnailQuality(input.quality);
  const format = 'webp';
  let stat;
  try {
    stat = fs.statSync(sourceFilePath);
  } catch {
    throw createMediaProcessingError('FILE_NOT_FOUND', 'Source file not found', 404);
  }
  const normalizedKey = typeof sourceFileKey === 'string' ? sourceFileKey.replace(/\\/g, '/') : '';
  const keyPayload = JSON.stringify({
    kind: 'image-thumbnail',
    key: normalizedKey,
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs || 0),
    maxEdge,
    quality: Math.round(quality * 100),
    format,
  });
  const digest = crypto.createHash('sha256').update(keyPayload).digest('hex');
  if (folderPaths === null) throw new Error('folderPaths is null');
  const thumbnailsDir = path.join(folderPaths.media, 'thumbnails');
  try {
    fs.mkdirSync(thumbnailsDir, { recursive: true });
  } catch { void 0; }
  const outputFilename = `thumb-${digest}.${format}`;
  const outputPath = path.join(thumbnailsDir, outputFilename);
  const outputKey = path.posix.join('thumbnails', outputFilename);
  let sourceWidth = 0;
  let sourceHeight = 0;
  let sourceAspectRatio = 0;
  if (sharp) {
    try {
      const metadata = await sharp(sourceFilePath, undefined).metadata();
      const rawWidth = Number((metadata !== null && metadata !== undefined ? metadata.width : undefined)) || 0;
      const rawHeight = Number((metadata !== null && metadata !== undefined ? metadata.height : undefined)) || 0;
      const orientation = Number((metadata !== null && metadata !== undefined ? metadata.orientation : undefined)) || 1;
      const rotate90 = orientation >= 5 && orientation <= 8;
      const width = rotate90 ? rawHeight : rawWidth;
      const height = rotate90 ? rawWidth : rawHeight;
      if (width > 0 && height > 0) {
        sourceWidth = width;
        sourceHeight = height;
        sourceAspectRatio = Number((width / height).toFixed(4));
      }
    } catch { void 0; }
  }
  const meta = {
    maxEdge,
    quality,
    format,
    ...(sourceWidth && sourceHeight
      ? { sourceWidth, sourceHeight, sourceAspectRatio }
      : {}),
  };
  if (fs.existsSync(outputPath)) {
    try {
      const thumbStat = fs.statSync(outputPath);
      if (thumbStat.size > 0) {
        const thumbnailSize = await readGeneratedImageDimensions(outputPath);
        const thumbnailUrl = resolveLocalMediaUrl(projectRef, outputKey);
        return {
          success: true,
          url: thumbnailUrl,
          meta: {
            ...meta,
            ...thumbnailSize,
          },
        };
      }
    } catch { void 0; }
  }
  if (!sharp) {
    throw createMediaProcessingError('SHARP_NOT_AVAILABLE', 'Sharp library not installed', 501);
  }
  const tmpPath = path.join(
    thumbnailsDir,
    `.tmp-img-thumb-${digest}-${Date.now()}-${Math.random().toString(16).slice(2)}.${format}`,
  );
  try {
    await sharp(sourceFilePath, undefined)
      .rotate()
      .resize({
        width: maxEdge,
        height: maxEdge,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: Math.round(quality * 100) })
      .toFile(tmpPath);
    try {
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
    } catch { void 0; }
    try {
      fs.renameSync(tmpPath, outputPath);
    } catch {
      fs.copyFileSync(tmpPath, outputPath);
      fs.unlinkSync(tmpPath);
    }
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch { void 0; }
    const errorMsg = error instanceof Error ? error.message : String(error);
    logWarn('image thumbnail failed', { sourceUrl, maxEdge, quality, error: errorMsg });
    throw createMediaProcessingError('THUMBNAIL_FAILED', `Thumbnail failed: ${errorMsg}`, 500);
  }
  const thumbnailSize = await readGeneratedImageDimensions(outputPath);
  const thumbnailUrl = resolveLocalMediaUrl(projectRef, outputKey);
  return {
    success: true,
    url: thumbnailUrl,
    meta: {
      ...meta,
      ...thumbnailSize,
    },
  };
};
const executeVideoThumbnail = async (payload: unknown) => {
  const input = asMediaActionPayload(payload);
  const { projectPath, folderPaths, sourceFilePath, sourceFileKey, sourceUrl } = ensureProjectSourceFile(
    input.projectPath,
    input.sourceUrl,
  );
  const projectRef = resolveProjectRefByPath(projectPath);
  if (!projectRef) throw createMediaProcessingError('INVALID_PROJECT', 'Failed to build project ref', 500);
  const width = clampVideoThumbnailWidth(input.width);
  const quality = clampVideoThumbnailQuality(input.quality);
  const timeSec = clampVideoThumbnailTime(input.timeSec);
  let stat;
  try {
    stat = fs.statSync(sourceFilePath);
  } catch {
    throw createMediaProcessingError('FILE_NOT_FOUND', 'Source file not found', 404);
  }
  const normalizedKey = typeof sourceFileKey === 'string' ? sourceFileKey.replace(/\\/g, '/') : '';
  const keyPayload = JSON.stringify({
    key: normalizedKey,
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs || 0),
    width,
    quality: Math.round(quality * 100),
    timeSec: Math.round(timeSec * 1000) / 1000,
  });
  const digest = crypto.createHash('sha256').update(keyPayload).digest('hex');
  if (folderPaths === null) throw new Error('folderPaths is null');
  const thumbnailsDir = path.join(folderPaths.media, 'thumbnails');
  try {
    fs.mkdirSync(thumbnailsDir, { recursive: true });
  } catch { void 0; }
  const outputFilename = `thumb-${digest}.jpg`;
  const outputPath = path.join(thumbnailsDir, outputFilename);
  const outputKey = path.posix.join('thumbnails', outputFilename);
  if (fs.existsSync(outputPath)) {
    try {
      const thumbStat = fs.statSync(outputPath);
      if (thumbStat.size > 0) {
        const thumbnailSize = await readGeneratedImageDimensions(outputPath);
        const thumbnailUrl = resolveLocalMediaUrl(projectRef, outputKey);
        return {
          success: true,
          url: thumbnailUrl,
          meta: { width, quality, timeSec, ...thumbnailSize },
        };
      }
    } catch { void 0; }
  }
  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) {
    throw createMediaProcessingError(
      'FFMPEG_NOT_AVAILABLE',
      'ffmpeg 不可用：缺少 ffmpeg-static 依赖或二进制路径无效',
      500,
    );
  }
  const qscale = Math.min(31, Math.max(2, Math.round(2 + (1 - quality) * 28)));
  const args = [
    '-y',
    '-ss',
    String(timeSec),
    '-i',
    sourceFilePath,
    '-frames:v',
    '1',
    '-vf',
    `scale=${width}:-1:flags=lanczos`,
    '-q:v',
    String(qscale),
    outputPath,
  ];
  try {
    await runFfmpeg(ffmpegPath, args);
  } catch (error) {
    try {
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
    } catch { void 0; }
    const errorMsg = error instanceof Error ? error.message : String(error);
    logWarn('video thumbnail failed', { sourceUrl, timeSec, width, quality, error: errorMsg });
    throw createMediaProcessingError('THUMBNAIL_FAILED', `Thumbnail failed: ${errorMsg}`, 500);
  }
  const thumbnailSize = await readGeneratedImageDimensions(outputPath);
  const thumbnailUrl = resolveLocalMediaUrl(projectRef, outputKey);
  return {
    success: true,
    url: thumbnailUrl,
    meta: { width, quality, timeSec, ...thumbnailSize },
  };
};
export {
  buildImageProcessingRequestFromLegacyPayload,
  ensureProjectSourceFile,
  executeImageThumbnail,
  executeImageProcessing,
  executeVideoThumbnail,
  createMediaProcessingError,
  resolveFfmpegPath,
  runFfmpeg,
};
