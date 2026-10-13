import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
const mediaConstants = require('@iart/utils/media-constants') as {
  buildLocalMediaUrl: (projectRef: string | null | undefined, fileKey: string | null | undefined) => string | null;
  buildLocalMediaUrlV2: (stableProjectId: string | null | undefined, fileKey: string | null | undefined) => string | null;
};
const { buildLocalMediaUrl, buildLocalMediaUrlV2 } = mediaConstants;

const normalizeStr = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Media dir registry（旧 V1 projectRef → mediaDir）。
 *
 * @deprecated 由 ProjectScopeCoordinator 的三索引替代。协议处理器已迁移至 coordinator；
 * 此 Map 仅保留给未迁移的历史调用点，新代码必须使用 coordinator.getMediaDir / getMediaDirByRef。
 */
const mediaDirRegistry = new Map<string, string>();

export const registerMediaDir = (projectRef: string, mediaDir: string): void => {
  mediaDirRegistry.set(projectRef, mediaDir);
  console.log("[local-media-registry] register", { projectRef, mediaDir });
};

export const unregisterMediaDir = (projectRef: string): void => {
  const existed = mediaDirRegistry.has(projectRef);
  mediaDirRegistry.delete(projectRef);
  console.log("[local-media-registry] unregister", { projectRef, existed });
};

/**
 * @deprecated 使用 ProjectScopeCoordinator.getMediaDirByRef。仅 global scope (__global__) 注册仍使用此 Map。
 */
export const getMediaDirByRef = (projectRef: string): string | null => {
  const dir = mediaDirRegistry.get(projectRef);
  if (dir !== undefined) {
    return dir;
  }
  return null;
};

const getExtensionFromMime = (mimeType: string): string => {
  const lower = mimeType.toLowerCase().trim();
  if (lower.includes('png')) return '.png';
  if (lower.includes('jpeg') || lower.includes('jpg')) return '.jpg';
  if (lower.includes('webp')) return '.webp';
  if (lower.includes('gif')) return '.gif';
  if (lower.includes('avif')) return '.avif';
  if (lower.includes('tiff')) return '.tiff';
  if (lower.includes('bmp')) return '.bmp';
  if (lower.includes('svg')) return '.svg';
  if (lower.includes('mp4')) return '.mp4';
  if (lower.includes('webm')) return '.webm';
  if (lower.includes('mov') || lower.includes('quicktime')) return '.mov';
  if (lower.includes('mp3') || lower.includes('mpeg')) return '.mp3';
  if (lower.includes('wav')) return '.wav';
  if (lower.includes('ogg')) return '.ogg';
  if (lower.includes('flac')) return '.flac';
  if (lower.includes('aac')) return '.aac';
  if (lower.includes('m4a')) return '.m4a';
  return '';
};

const getExtensionFromFileName = (name: string): string => {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot).toLowerCase();
};

export type ImportLocalMediaArgs = {
  projectPath: string;
  projectRef: string;
  stableProjectId: string | null | undefined;
  fileData: Buffer;
  mimeType: string;
  originalFileName: string;
};

/**
 * 导入本地媒体文件并生成 local-media:// URL。
 *
 * URL 格式优先级：
 * 1. 若提供有效 stableProjectId，生成 V2 格式 local-media://<stableProjectId>/<fileKey>
 * 2. 否则 fallback 到 V1 格式 local-media://<projectRef>/<fileKey>
 *
 * stableProjectId 参数新增为可选，保持向后兼容（旧调用点未传时退化为 V1）。
 */
export const importLocalMedia = (args: ImportLocalMediaArgs): { url: string; fileName: string; isNew: boolean; sizeBytes: number } => {
  const projectPath = normalizeStr(args.projectPath);
  if (!projectPath) throw new Error('Missing projectPath');

  const buffer = args.fileData;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Missing file data');

  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const ext = getExtensionFromMime(args.mimeType) || getExtensionFromFileName(args.originalFileName) || '.bin';
  const fileName = `${hash}${ext}`;

  const mediaDir = path.join(projectPath, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  const filePath = path.join(mediaDir, fileName);

  // 优先 V2（stableProjectId），fallback V1（projectRef）
  const url =
    buildLocalMediaUrlV2(args.stableProjectId, fileName) ??
    buildLocalMediaUrl(args.projectRef, fileName);
  if (url === null) {
    throw new Error('Failed to build local-media URL: missing both stableProjectId and projectRef');
  }

  if (fs.existsSync(filePath)) {
    return {
      url,
      fileName,
      isNew: false,
      sizeBytes: buffer.length,
    };
  }

  fs.writeFileSync(filePath, buffer);

  if (!fs.existsSync(filePath)) {
    throw new Error('Failed to write media file');
  }

  return {
    url,
    fileName,
    isNew: true,
    sizeBytes: buffer.length,
  };
};
