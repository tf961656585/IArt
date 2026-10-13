import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { Sharp, SharpOptions } from 'sharp';
import {
  VideoSpriteSheetRequestSchema,
} from '@iart/contracts/media-processing-contract';
import type { MediaAsset } from '@iart/contracts';
import { deriveContentAddressedAssetId } from './media-asset-id.cts';
import {
  ensureProjectSourceFile,
  resolveFfmpegPath,
  runFfmpeg,
  createMediaProcessingError,
} from './media-processing-actions.cts';
import { resolveLocalMediaUrl, resolveProjectRefByPath } from './project-media-scope.cts';
import { logWarn, logDebug } from './logging.cts';
import { persistRuntimeMediaAsset } from './runtime-media-assets.cts';
import { repairProjectMediaAssetThumbnail } from './media-asset-registry.cts';

const requireOptional = createRequire(__filename);

type SharpFactory = {
  (input: string | Buffer, options: SharpOptions | undefined): Sharp;
  (options: SharpOptions | undefined): Sharp;
};

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

let sharpInstance: SharpFactory | null = null;
try {
  const loaded: unknown = requireOptional('sharp');
  if (typeof loaded === 'function') {
    sharpInstance = loaded as SharpFactory;
  } else {
    sharpInstance = null;
  }
} catch (error) {
  logWarn('optional native dependency unavailable [sprite-sheet]', getRequireErrorMeta(error));
  sharpInstance = null;
}


const resolveVideoMetadataFromPath = (ffmpegPath: string, filePath: string): { width: number; height: number; fps: number } => {
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-i', filePath], {
    encoding: 'utf-8',
    windowsHide: true,
  });
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const output = stderr || stdout;

  const dimMatch = /(?:^|,|\s)(\d{1,5})x(\d{1,5})(?:[,\s]|$)/.exec(output);
  if (!dimMatch) {
    throw createMediaProcessingError('VIDEO_METADATA_FAILED', 'Failed to parse video dimensions from ffmpeg output', 500);
  }
  const width = Number(dimMatch[1]);
  const height = Number(dimMatch[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw createMediaProcessingError('VIDEO_METADATA_FAILED', 'Invalid video dimensions', 500);
  }

  const fpsMatch = /(\d+(?:\.\d+)?)\s*(?:fps|tbr)|(\d+)\/(\d+)\s*(?:fps|tbr)/.exec(output);
  let fps: number | undefined;
  if (fpsMatch) {
    if (fpsMatch[2] !== undefined && fpsMatch[3] !== undefined) {
      const numerator = parseFloat(fpsMatch[2]);
      const denominator = parseFloat(fpsMatch[3]);
      if (denominator !== 0 && Number.isFinite(numerator) && Number.isFinite(denominator)) {
        fps = numerator / denominator;
      }
    } else if (fpsMatch[1] !== undefined) {
      const value = parseFloat(fpsMatch[1]);
      if (Number.isFinite(value)) {
        fps = value;
      }
    }
  }
  if (fps === undefined || !Number.isFinite(fps) || fps <= 0) {
    throw createMediaProcessingError('VIDEO_METADATA_FAILED', 'Failed to parse video fps from ffmpeg output', 500);
  }

  return { width, height, fps };
};

const computeSpriteSheetLayout = (
  fps: number,
  fpsMultiplier: number,
  startTime: number,
  endTime: number,
  videoWidth: number,
  videoHeight: number,
) => {
  const duration = Math.max(0, endTime - startTime);
  const frameCount = Math.max(1, Math.floor(fps * fpsMultiplier * duration));
  const frameAspect = videoWidth / videoHeight;

  let cols = Math.ceil(Math.sqrt(frameCount * frameAspect));
  let rows = Math.ceil(frameCount / cols);

  while (cols > 1 && (cols - 1) * rows >= frameCount) {
    cols -= 1;
    rows = Math.ceil(frameCount / cols);
  }

  const MAX_ATLAS_SIZE = 8192;
  let frameWidth = videoWidth;
  let frameHeight = videoHeight;
  let atlasWidth = frameWidth * cols;
  let atlasHeight = frameHeight * rows;
  if (atlasWidth > MAX_ATLAS_SIZE || atlasHeight > MAX_ATLAS_SIZE) {
    const scale = Math.min(MAX_ATLAS_SIZE / atlasWidth, MAX_ATLAS_SIZE / atlasHeight);
    frameWidth = Math.floor(videoWidth * scale);
    frameHeight = Math.floor(videoHeight * scale);
    atlasWidth = frameWidth * cols;
    atlasHeight = frameHeight * rows;
  }

  return {
    frameCount,
    rows,
    cols,
    frameWidth,
    frameHeight,
    atlasWidth,
    atlasHeight,
  };
};

const persistSpriteSheetResult = async (params: {
  projectPath: string;
  sourceUrl: string;
  mediaDir: string;
  buffer: Buffer;
  width: number;
  height: number;
}): Promise<{ url: string; fileKey: string; filePath: string; assetId: string; mediaAsset: MediaAsset }> => {
  const outputDir = path.join(params.mediaDir, 'processed');
  fs.mkdirSync(outputDir, { recursive: true });
  const digest = crypto.createHash('sha256').update(params.buffer).digest('hex');
  const filename = `${digest}.png`;
  const targetPath = path.join(outputDir, filename);
  if (!fs.existsSync(targetPath)) {
    fs.writeFileSync(targetPath, params.buffer);
  }
  const fileKey = path.posix.join('processed', filename);
  const projectRef = resolveProjectRefByPath(params.projectPath);
  if (!projectRef) {
    throw createMediaProcessingError('INVALID_PROJECT', 'Invalid project ref', 500);
  }
  const url = resolveLocalMediaUrl(projectRef, fileKey);
  if (!url) {
    throw createMediaProcessingError('INVALID_PROJECT', 'Invalid project media url', 500);
  }
  const contentHash = digest;
  const stat = fs.statSync(targetPath);
  const assetId = deriveContentAddressedAssetId('image', contentHash);
  const now = Date.now();
  const mediaAsset: MediaAsset = {
    id: assetId,
    mediaType: 'image',
    original: {
      url,
      projectRef,
      fileKey,
      sourceUrl: params.sourceUrl,
      sourceFileName: null,
      mimeType: 'image/png',
      sizeBytes: Number.isFinite(stat.size) ? stat.size : null,
      width: params.width > 0 ? params.width : null,
      height: params.height > 0 ? params.height : null,
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

  const persisted = await persistRuntimeMediaAsset(params.projectPath, mediaAsset);
  if (!persisted) {
    throw createMediaProcessingError('MEDIA_ASSET_PERSIST_FAILED', 'Failed to persist sprite sheet media asset', 500);
  }

  repairProjectMediaAssetThumbnail(params.projectPath, {
    assetId,
    mediaType: 'image',
    maxEdge: undefined,
    quality: undefined,
    width: undefined,
    timeSec: undefined,
  }).catch((err: unknown) => {
    logDebug('[sprite-sheet] Thumbnail repair failed for asset', { assetId, error: err instanceof Error ? err.message : String(err) });
  });

  return { url, fileKey, filePath: targetPath, assetId, mediaAsset };
};

const executeVideoSpriteSheet = async (projectPath: string, payload: unknown) => {
  const parsed = VideoSpriteSheetRequestSchema.safeParse(payload);
  if (!parsed.success) {
    throw createMediaProcessingError('INVALID_PAYLOAD', `Invalid sprite sheet request: ${parsed.error.message}`, 400);
  }
  const request = parsed.data;

  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) {
    throw createMediaProcessingError(
      'FFMPEG_NOT_AVAILABLE',
      'ffmpeg not available: missing ffmpeg-static dependency or invalid binary path',
      500,
    );
  }

  if (!sharpInstance) {
    throw createMediaProcessingError(
      'SHARP_NOT_AVAILABLE',
      'Sharp library not installed',
      501,
    );
  }

  const { projectPath: normalizedProjectPath, folderPaths, sourceFilePath, sourceUrl } = ensureProjectSourceFile(
    projectPath,
    request.source.url,
  );

  if (!folderPaths || !folderPaths.media) {
    throw createMediaProcessingError('INVALID_PROJECT', 'Project media dir not available', 500);
  }

  const videoMeta = resolveVideoMetadataFromPath(ffmpegPath, sourceFilePath);
  const layout = computeSpriteSheetLayout(
    videoMeta.fps,
    request.operation.fpsMultiplier,
    request.operation.startTime,
    request.operation.endTime,
    videoMeta.width,
    videoMeta.height,
  );

  const tmpDir = path.join(os.tmpdir(), `spritesheet-${crypto.randomUUID()}`);
  let tmpDirCreated = false;
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    tmpDirCreated = true;

    const fpsFilter = videoMeta.fps * request.operation.fpsMultiplier;
    const ffmpegArgs = [
      '-y',
      '-ss', String(request.operation.startTime),
      '-to', String(request.operation.endTime),
      '-i', sourceFilePath,
      '-vf', `fps=${fpsFilter}`,
      '-q:v', '2',
      path.join(tmpDir, 'frame_%06d.jpg'),
    ];

    await runFfmpeg(ffmpegPath, ffmpegArgs);

    const frameFiles = fs.readdirSync(tmpDir)
      .filter((name) => name.startsWith('frame_') && name.endsWith('.jpg'))
      .sort();

    if (frameFiles.length === 0) {
      throw createMediaProcessingError('FRAME_EXTRACTION_FAILED', 'ffmpeg extracted zero frames', 500);
    }

    logDebug('[sprite-sheet] extracted frames', { frameCount: frameFiles.length, expectedFrames: layout.frameCount });

    const composites: Array<{ input: Buffer; left: number; top: number }> = [];
    let loadedCount = 0;
    for (const frameFile of frameFiles) {
      if (loadedCount >= layout.frameCount) break;
      const framePath = path.join(tmpDir, frameFile);
      const resizedBuffer = await sharpInstance(framePath, undefined)
        .resize(layout.frameWidth, layout.frameHeight, { fit: 'inside' })
        .png()
        .toBuffer();
      const col = loadedCount % layout.cols;
      const row = Math.floor(loadedCount / layout.cols);
      composites.push({
        input: resizedBuffer,
        left: col * layout.frameWidth,
        top: row * layout.frameHeight,
      });
      loadedCount += 1;
    }

    if (composites.length === 0) {
      throw createMediaProcessingError('FRAME_COMPOSITE_FAILED', 'No frames to composite', 500);
    }

    const pngBuffer = await sharpInstance({
      create: {
        width: layout.atlasWidth,
        height: layout.atlasHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite(composites)
      .png()
      .toBuffer();

    const persisted = await persistSpriteSheetResult({
      projectPath: normalizedProjectPath,
      sourceUrl,
      mediaDir: folderPaths.media,
      buffer: pngBuffer,
      width: layout.atlasWidth,
      height: layout.atlasHeight,
    });

    return {
      frameCount: layout.frameCount,
      rows: layout.rows,
      cols: layout.cols,
      frameWidth: layout.frameWidth,
      frameHeight: layout.frameHeight,
      atlasWidth: layout.atlasWidth,
      atlasHeight: layout.atlasHeight,
      outputUrl: persisted.url,
      assetId: persisted.assetId,
      mediaAsset: persisted.mediaAsset,
    };
  } finally {
    if (tmpDirCreated) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (cleanupError) {
        logDebug('[sprite-sheet] failed to clean up temp dir', {
          tmpDir,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
    }
  }
};

export {
  computeSpriteSheetLayout,
  executeVideoSpriteSheet,
};
