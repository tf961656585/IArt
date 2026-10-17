/**
 * 本地媒体文件类型判据（画布导入链共享几何源之外的共享「判据源」）。
 *
 * owner 说明：扩展名表与「MIME 前缀优先、扩展名兜底」的判定顺序被两条导入入口共同消费——
 * 界面拖入画布（useCanvasFileDropImportController）与 CLI 素材导入（cliAssetImport，
 * 命令面只给文件路径、没有浏览器 File 类型）；判据只在本模块维护一份，禁止各自复制扩展名表。
 * 单表结构（扩展名 → 媒体类型 + MIME）同时消除「类型集合」与「MIME 表」之间的漂移可能。
 */

export type MediaFileKind = 'image' | 'video' | 'audio';

type MediaFileExtensionEntry = {
  kind: MediaFileKind;
  mimeType: string;
};

/** 可导入的本地媒体扩展名全集（小写、含前导点）。 */
const MEDIA_FILE_EXTENSIONS: Record<string, MediaFileExtensionEntry> = {
  // 图片
  '.png': { kind: 'image', mimeType: 'image/png' },
  '.jpg': { kind: 'image', mimeType: 'image/jpeg' },
  '.jpeg': { kind: 'image', mimeType: 'image/jpeg' },
  '.webp': { kind: 'image', mimeType: 'image/webp' },
  '.gif': { kind: 'image', mimeType: 'image/gif' },
  '.bmp': { kind: 'image', mimeType: 'image/bmp' },
  '.avif': { kind: 'image', mimeType: 'image/avif' },
  '.tif': { kind: 'image', mimeType: 'image/tiff' },
  '.tiff': { kind: 'image', mimeType: 'image/tiff' },
  '.svg': { kind: 'image', mimeType: 'image/svg+xml' },
  // 音频
  '.mp3': { kind: 'audio', mimeType: 'audio/mpeg' },
  '.wav': { kind: 'audio', mimeType: 'audio/wav' },
  '.m4a': { kind: 'audio', mimeType: 'audio/mp4' },
  '.aac': { kind: 'audio', mimeType: 'audio/aac' },
  '.flac': { kind: 'audio', mimeType: 'audio/flac' },
  '.ogg': { kind: 'audio', mimeType: 'audio/ogg' },
  '.opus': { kind: 'audio', mimeType: 'audio/opus' },
  // 视频
  '.mp4': { kind: 'video', mimeType: 'video/mp4' },
  '.mov': { kind: 'video', mimeType: 'video/quicktime' },
  '.m4v': { kind: 'video', mimeType: 'video/x-m4v' },
  '.mkv': { kind: 'video', mimeType: 'video/x-matroska' },
  '.avi': { kind: 'video', mimeType: 'video/x-msvideo' },
  '.wmv': { kind: 'video', mimeType: 'video/x-ms-wmv' },
  '.flv': { kind: 'video', mimeType: 'video/x-flv' },
  '.mpeg': { kind: 'video', mimeType: 'video/mpeg' },
  '.mpg': { kind: 'video', mimeType: 'video/mpeg' },
  '.ts': { kind: 'video', mimeType: 'video/mp2t' },
  '.m2ts': { kind: 'video', mimeType: 'video/mp2t' },
  '.3gp': { kind: 'video', mimeType: 'video/3gpp' },
};

const UNKNOWN_MIME_TYPE = 'application/octet-stream';

/** 取小写扩展名（含前导点）；无扩展名/纯点名返回空串。 */
export const getFileExtension = (name: string | null | undefined): string => {
  const normalized = (name ?? '').trim().toLowerCase();
  if (!normalized) return '';
  const dotIndex = normalized.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === normalized.length - 1) return '';
  return normalized.slice(dotIndex);
};

/** 从路径取文件名（CLI --file 只给路径；两类路径分隔符都处理，末尾分隔符按原样保留末段）。 */
export const getFileNameFromPath = (filePath: string): string => {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const fileName = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
  return fileName.length > 0 ? fileName : filePath;
};

/**
 * 按 MIME 前缀 + 文件名扩展名判定媒体类型：MIME 已识别（浏览器 File 场景）时以它为准，
 * 否则回退扩展名表；都不命中返回 null（调用方按「不支持的类型」处置，不猜测）。
 */
export const resolveMediaKindFromFile = (file: {
  name: string | null | undefined;
  type: string | null | undefined;
}): MediaFileKind | null => {
  const mimeType = (file.type ?? '').toLowerCase();
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';

  const entry = MEDIA_FILE_EXTENSIONS[getFileExtension(file.name)];
  return entry !== undefined ? entry.kind : null;
};

/** 按路径判定媒体类型（CLI 素材导入前置校验输入只有路径，无浏览器 File 类型）。 */
export const resolveMediaKindFromPath = (filePath: string): MediaFileKind | null =>
  resolveMediaKindFromFile({ name: filePath, type: '' });

/** 按路径取 MIME（写盘/登记链路需要 MIME）；未登记扩展名回退通用二进制类型。 */
export const resolveMimeTypeFromPath = (filePath: string): string =>
  MEDIA_FILE_EXTENSIONS[getFileExtension(filePath)]?.mimeType ?? UNKNOWN_MIME_TYPE;
