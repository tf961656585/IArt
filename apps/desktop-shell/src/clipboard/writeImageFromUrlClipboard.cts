import * as fs from 'node:fs';
import type { NativeImage } from 'electron';
import projectPathsUtils = require('@iart/utils/project-paths');
import {
  isSafeFilesKey,
  resolvePathWithin,
  pickProjectPath,
} from '../reveal/revealFilesUrl.cjs';
import {
  ClipboardWriteImageResponseSchema,
  type ClipboardWriteImageResponse,
} from '@iart/contracts';

const { getProjectFolderPaths } = projectPathsUtils;

type WriteImageFromUrlClipboardParams = {
  url: string | null | undefined;
  storedProjectPath: string | null | undefined;
  hintedProjectPath: string | null | undefined;
  clipboard: {
    writeImage: (image: NativeImage) => void;
  } | null | undefined;
  nativeImage: {
    createFromPath: (path: string) => NativeImage;
  } | null | undefined;
  urlResolverRegistry: {
    resolve: ((url: string, context: { projectPath: string }) => {
      ok: boolean | undefined;
      reason: string | undefined;
      fileKey: string | null | undefined;
    } | null) | undefined;
  } | null | undefined;
};

const normalizeString = (value: unknown): string =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

/**
 * 从 local-media:// URL 解析物理文件路径，写入系统剪贴板。
 *
 * 复用 revealFilesUrl 的 URL 解析 + 安全校验链路（urlResolverRegistry + isSafeFilesKey +
 * resolvePathWithin），末端动作从 shell.showItemInFolder 换成 clipboard.writeImage。
 *
 * 路径必须解析到 <project>/media 目录内，防 path traversal。
 * nativeImage.createFromPath 对损坏文件返回 empty image（不抛异常），用 isEmpty() 判别失败。
 */
export const writeImageFromUrlClipboard = async ({
  url,
  storedProjectPath,
  hintedProjectPath,
  clipboard,
  nativeImage,
  urlResolverRegistry,
}: WriteImageFromUrlClipboardParams): Promise<ClipboardWriteImageResponse> => {
  const normalizedUrl = normalizeString(url);
  if (!normalizedUrl) {
    return ClipboardWriteImageResponseSchema.parse({
      ok: false,
      reason: 'missing-url',
    });
  }

  const projectPath = pickProjectPath(storedProjectPath, hintedProjectPath);
  if (!projectPath) {
    return ClipboardWriteImageResponseSchema.parse({
      ok: false,
      reason: 'missing-project-path',
    });
  }

  const resolverResult =
    urlResolverRegistry !== null &&
    urlResolverRegistry !== undefined &&
    urlResolverRegistry.resolve !== null &&
    urlResolverRegistry.resolve !== undefined
      ? urlResolverRegistry.resolve(normalizedUrl, { projectPath })
      : undefined;
  if (resolverResult === null || resolverResult === undefined) {
    return ClipboardWriteImageResponseSchema.parse({
      ok: false,
      reason: 'not-files-url',
    });
  }
  if (!resolverResult.ok) {
    const reason = normalizeString(resolverResult.reason) || 'resolve-failed';
    // reason 来自 resolver，归一到 contracts 的合法 reason 集合
    if (reason === 'not-files-url' || reason === 'resolve-failed') {
      return ClipboardWriteImageResponseSchema.parse({ ok: false, reason });
    }
    return ClipboardWriteImageResponseSchema.parse({
      ok: false,
      reason: 'resolve-failed',
    });
  }

  const fileKey = normalizeString(resolverResult.fileKey);
  if (!fileKey) {
    return ClipboardWriteImageResponseSchema.parse({
      ok: false,
      reason: 'invalid-file-key',
    });
  }
  if (!isSafeFilesKey(fileKey)) {
    return ClipboardWriteImageResponseSchema.parse({
      ok: false,
      reason: 'unsafe-file-key',
    });
  }

  const folderPaths = getProjectFolderPaths(projectPath);
  const mediaDir =
    folderPaths !== null && folderPaths !== undefined ? folderPaths.media : undefined;
  if (!mediaDir) {
    return ClipboardWriteImageResponseSchema.parse({
      ok: false,
      reason: 'missing-media-dir',
    });
  }

  const filePath = resolvePathWithin(mediaDir, fileKey);
  if (filePath === null) {
    return ClipboardWriteImageResponseSchema.parse({
      ok: false,
      reason: 'path-outside-media',
    });
  }

  if (!fs.existsSync(filePath)) {
    return ClipboardWriteImageResponseSchema.parse({
      ok: false,
      reason: 'not-found',
    });
  }

  if (
    clipboard === null ||
    clipboard === undefined ||
    typeof clipboard.writeImage !== 'function' ||
    nativeImage === null ||
    nativeImage === undefined ||
    typeof nativeImage.createFromPath !== 'function'
  ) {
    return ClipboardWriteImageResponseSchema.parse({
      ok: false,
      reason: 'read-failed',
    });
  }

  let image: NativeImage;
  try {
    image = nativeImage.createFromPath(filePath);
  } catch {
    return ClipboardWriteImageResponseSchema.parse({
      ok: false,
      reason: 'read-failed',
    });
  }

  // Electron nativeImage 对损坏文件返回 empty image（不抛异常），必须用 isEmpty() 判别
  if (
    image === null ||
    image === undefined ||
    typeof image.isEmpty !== 'function' ||
    image.isEmpty()
  ) {
    return ClipboardWriteImageResponseSchema.parse({
      ok: false,
      reason: 'read-failed',
    });
  }

  try {
    clipboard.writeImage(image);
    return ClipboardWriteImageResponseSchema.parse({ ok: true, filePath });
  } catch {
    return ClipboardWriteImageResponseSchema.parse({
      ok: false,
      reason: 'read-failed',
    });
  }
};
