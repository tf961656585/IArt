/**
 * Video Trim Executor
 *
 * 视频截取（原 `routes/media-routes.cts` 内联逻辑抽出）：按起止时间裁出 mp4 片段，
 * 产出注册为项目媒体资产。agent 加工工具（trim_video）与 HTTP 路由共用同一执行体，
 * 行为保持一致（spec 04「工具集合投影」加工工具复用本地媒体处理执行器）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import type { MediaAsset } from '@iart/contracts';
import { deriveContentAddressedAssetId } from './media-asset-id.cts';
import { ensureProjectFolderDirs, isValidProjectFolder } from './storage.cts';
import { ensureFilesUrlToFilePathInProject } from './image-processing.cts';
import { resolveLocalMediaUrl, resolveProjectRefByPath } from './project-media-scope.cts';
import { resolveFfmpegPath } from './media-processing-actions.cts';
import { persistRuntimeMediaAsset } from './runtime-media-assets.cts';
import { repairProjectMediaAssetThumbnail } from './media-asset-registry.cts';
import { logWarn } from './logging.cts';

export type VideoTrimResult = {
  url: string;
  assetId: string | null;
  mediaAsset: MediaAsset | null;
  meta: { format: string; withAudio: boolean; startTime: number; endTime: number };
};

const executeVideoTrim = async (params: {
  projectPath: string;
  sourceUrl: string;
  startTime: number;
  endTime: number;
  withAudio: boolean;
}): Promise<VideoTrimResult> => {
  const { projectPath, sourceUrl, startTime, endTime, withAudio } = params;
  if (!isValidProjectFolder(projectPath)) {
    throw new Error('Invalid payload');
  }
  const folderPaths = ensureProjectFolderDirs(projectPath);
  if (!folderPaths || !folderPaths.media) {
    throw new Error('Project media dir not available');
  }
  const resolved = ensureFilesUrlToFilePathInProject(projectPath, sourceUrl);
  if (!resolved || !resolved.filePath || !fs.existsSync(resolved.filePath)) {
    throw new Error('Source file not found');
  }

  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) {
    throw new Error('ffmpeg 不可用：缺少 ffmpeg-static 依赖或二进制路径无效');
  }

  const clipsDir = path.join(folderPaths.media, 'clips');
  fs.mkdirSync(clipsDir, { recursive: true });
  const outputFilename = `${crypto.randomUUID()}.mp4`;
  const outputPath = path.join(clipsDir, outputFilename);
  const args = [
    '-y',
    '-ss',
    String(startTime),
    '-to',
    String(endTime),
    '-i',
    resolved.filePath,
    '-c:v',
    'libx264',
    ...(withAudio ? ['-c:a', 'aac'] : ['-an']),
    '-movflags',
    '+faststart',
    outputPath,
  ];
  await new Promise<void>((resolve, reject) => {
    let stderr = '';
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    if (child.stderr) {
      child.stderr.on('data', (chunk: unknown) => {
        stderr += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr ? stderr.trim().slice(-2000) : `ffmpeg exited with code ${code}`));
    });
  }).catch(async (error: unknown) => {
    try {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch { void 0; }
    const errorMsg = error instanceof Error ? error.message : String(error);
    logWarn('video trim failed', { sourceUrl, startTime, endTime, error: errorMsg });
    throw new Error(`Trim failed: ${errorMsg}`);
  });

  const url = path.posix.join('/files/', 'clips', outputFilename);
  // 裁切结果注册为项目媒体资产（产出以资产形态进入画布素材节点），注册失败不阻断裁切结果返回
  let clipAssetId: string | null = null;
  let clipMediaAsset: MediaAsset | null = null;
  try {
    const clipBuffer = fs.readFileSync(outputPath);
    const clipDigest = crypto.createHash('sha256').update(clipBuffer).digest('hex');
    const clipProjectRef = resolveProjectRefByPath(projectPath);
    const clipFileKey = path.posix.join('clips', outputFilename);
    const clipFormalUrl = clipProjectRef ? resolveLocalMediaUrl(clipProjectRef, clipFileKey) : null;
    if (clipProjectRef && clipFormalUrl) {
      const now = Date.now();
      const asset: MediaAsset = {
        id: deriveContentAddressedAssetId('video', clipDigest),
        mediaType: 'video',
        original: {
          url: clipFormalUrl,
          projectRef: clipProjectRef,
          fileKey: clipFileKey,
          sourceUrl,
          sourceFileName: null,
          mimeType: 'video/mp4',
          sizeBytes: Number.isFinite(clipBuffer.length) ? clipBuffer.length : null,
          width: null,
          height: null,
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
      const persisted = await persistRuntimeMediaAsset(projectPath, asset);
      if (persisted) {
        clipAssetId = asset.id;
        clipMediaAsset = asset;
        repairProjectMediaAssetThumbnail(projectPath, {
          assetId: asset.id,
          mediaType: 'video',
          maxEdge: undefined,
          quality: undefined,
          width: undefined,
          timeSec: undefined,
        }).catch((err: unknown) => {
          logWarn('video trim thumbnail repair failed', {
            assetId: asset.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
  } catch (assetError) {
    logWarn('video trim asset registration failed', {
      sourceUrl,
      error: assetError instanceof Error ? assetError.message : String(assetError),
    });
  }
  return { url, assetId: clipAssetId, mediaAsset: clipMediaAsset, meta: { format: 'mp4', withAudio, startTime, endTime } };
};

export { executeVideoTrim };
