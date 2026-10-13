import { storeBlobMedia } from '../../services/mediaStorage';
import { BUNDLE_PATHS, createAbortError, type FilesManifestEntry } from '../bundleTypes';
import {
  extractPathnameFromUrl,
  normalizeLoopbackFilesUrls,
  rewriteFilesReferences,
  scanFilesReferences,
} from '../filesRef';
import { registerBundleAssetHandler } from './registry';
import type { BundleAssetHandler } from './types';
import { resolveRuntimeUrl } from '@/client/utils/runtimeUrl';

const ensureNotAborted = (currentSignal: AbortSignal | undefined) => {
  if ((currentSignal !== null && currentSignal !== undefined ? currentSignal.aborted : undefined)) {
    throw createAbortError();
  }
};

const normalizeMimeType = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const firstPart = value.trim().split(';')[0];
  const normalized = firstPart !== undefined ? firstPart.trim() : '';
  return normalized;
};

const fetchFilesBlob = async (
  fileKey: string,
  signal: AbortSignal | undefined
): Promise<{ blob: Blob; mimeType: string } | null> => {
  if (typeof fetch !== 'function') {
    return null;
  }

  const path = `/files/${fileKey}`;
  let url = path;
  try {
    url = resolveRuntimeUrl(path);
  } catch {
    url = path;
  }

  const response = await fetch(url, signal ? { signal } : undefined);
  if (!response.ok) {
    return null;
  }

  const blob = await response.blob();
  const headerMime = normalizeMimeType(response.headers.get('content-type'));
  const mimeType = headerMime || normalizeMimeType(blob.type) || 'application/octet-stream';
  return { blob, mimeType };
};

const handler: BundleAssetHandler = {
  id: 'bundle.assets.filesRef',
  export: async ({ projectDocument, zip, zipWriteOptions, manifest, errors, onProgress, signal }) => {
    const normalizedProjectDocument = normalizeLoopbackFilesUrls(projectDocument);
    const scan = scanFilesReferences(normalizedProjectDocument);
    if (scan.fileKeys.length === 0) return normalizedProjectDocument;

    const total = scan.fileKeys.length;
    let processed = 0;

    if (onProgress) {
      onProgress({ stage: 'files', messageKey: 'bundle.export.files', processed, total, percent: undefined });
    }

    const filesManifest: Record<string, FilesManifestEntry> = {};
    for (const fileKey of scan.fileKeys) {
      ensureNotAborted(signal);
      let fetched: { blob: Blob; mimeType: string } | null = null;
      try {
        fetched = await fetchFilesBlob(fileKey, signal);
      } catch (error) {
        if ((signal !== null && signal !== undefined ? signal.aborted : undefined)) {
          throw createAbortError();
        }
        throw error;
      }
      ensureNotAborted(signal);
      if (!fetched) {
        // 文件内路径只进日志：界面只说明结果。
        console.error(`[bundle.export] 文件里缺少素材 fileKey=${fileKey}`);
        errors.push('有素材没能导出，请重试。');
        processed += 1;
        if (onProgress) {
          onProgress({ stage: 'files', messageKey: 'bundle.export.files', processed, total, percent: undefined });
        }
        continue;
      }

      const path = `${BUNDLE_PATHS.FILES_DIR}/${fileKey}`;
      const fileBytes = new Uint8Array(await fetched.blob.arrayBuffer());
      zip.file(path, fileBytes, {
        compression: zipWriteOptions.compression,
        compressionOptions: zipWriteOptions.compressionOptions ?? null,
      });

      const scannedRecord = scan.byFileKey[fileKey];
      const originalUrls = scannedRecord !== undefined ? scannedRecord.originalUrls : [];
      filesManifest[fileKey] = {
        path,
        mimeType: fetched.mimeType,
        sizeBytes: fetched.blob.size,
        originalUrls: originalUrls.length > 0 ? originalUrls : [`/files/${fileKey}`],
      };
      processed += 1;
      if (onProgress) {
        onProgress({ stage: 'files', messageKey: 'bundle.export.files', processed, total, percent: undefined });
      }
    }

    if (Object.keys(filesManifest).length > 0) {
      manifest.filesManifest = filesManifest;
    }

    return normalizedProjectDocument;
  },
  import: async ({ projectDocument, nodeGraphId, zip, manifest, errors, onProgress, signal }) => {
    const filesManifest = manifest.filesManifest;
    if (!filesManifest || typeof filesManifest !== 'object') {
      return projectDocument;
    }

    const entries = Object.entries(filesManifest);
    const total = entries.length;
    let processed = 0;
    let lastEmit = 0;
    const emitProgress = (force = false) => {
      if (!onProgress || total <= 0) return;
      const now = Date.now();
      if (!force && now - lastEmit < 80) return;
      lastEmit = now;
      onProgress({ stage: 'files', messageKey: 'bundle.import.files', processed, total, percent: undefined });
    };

    emitProgress(true);

    const mapping: Record<string, string> = {};
    for (const [fileKey, entry] of entries) {
      ensureNotAborted(signal);
      const record = entry as FilesManifestEntry | null | undefined;
      if (record === null || record === undefined) {
        console.error(`[bundle.import] 文件里的素材信息读不出来 fileKey=${fileKey}`);
        errors.push('有素材信息读不出来。');
        processed += 1;
        emitProgress();
        continue;
      }
      const manifestPath = typeof (record !== null && record !== undefined ? record.path : undefined) === 'string' && record.path.trim().length > 0
        ? record.path
        : `${BUNDLE_PATHS.FILES_DIR}/${fileKey}`;

      const file = zip.file(manifestPath) ?? zip.file(`${BUNDLE_PATHS.FILES_DIR}/${fileKey}`);
      if (!file) {
        console.error(
          `[bundle.import] 文件里缺少素材 fileKey=${fileKey} path=${manifestPath}`,
        );
        errors.push('有素材没能从文件里读出来。');
        processed += 1;
        emitProgress();
        continue;
      }

      try {
        ensureNotAborted(signal);
        const blob = await file.async('blob');
        ensureNotAborted(signal);
        const mimeType =
          normalizeMimeType((record !== null && record !== undefined ? record.mimeType : undefined)) || normalizeMimeType(blob.type) || 'application/octet-stream';
        const typedBlob = new Blob([blob], { type: mimeType });

        ensureNotAborted(signal);
        const stored = await storeBlobMedia(typedBlob, {
          nodeGraphId,
          nodeId: `bundle-files:${fileKey}`,
          source: 'bundle',
          originalUrl: Array.isArray(record.originalUrls) ? (record.originalUrls[0] ?? '') : '',
          filenamePrefix: 'bundle-files',
          mimeType,
        });
        ensureNotAborted(signal);

        const pathname = extractPathnameFromUrl(stored.url);
        if (!pathname) {
          // 内部 URL 只进日志：界面只说明结果。
          console.error(`[bundle.import] 上传返回 URL 无法解析 url=${stored.url}`);
          errors.push('有素材没能保存到项目，请重试。');
          continue;
        }
        mapping[fileKey] = pathname;
      } catch (error) {
        if ((signal !== null && signal !== undefined ? signal.aborted : undefined)) {
          throw createAbortError();
        }
        const message = error instanceof Error ? error.message : '未知错误';
        // 文件内路径与异常原文只进日志：界面只说明结果。
        console.error(`[bundle.import] 素材保存到项目失败 fileKey=${fileKey}`, message);
        errors.push('有素材没能保存到项目，请重试。');
      } finally {
        processed += 1;
        emitProgress();
      }
    }

    emitProgress(true);

    if (Object.keys(mapping).length === 0) {
      return projectDocument;
    }

    return rewriteFilesReferences(projectDocument, mapping);
  },
};

registerBundleAssetHandler(handler);
