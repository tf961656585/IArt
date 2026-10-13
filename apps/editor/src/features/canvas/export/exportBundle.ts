/**
 * Bundle 导出模块
 * - 将 NodeGraph 导出为 .iarts ZIP 打包格式
 * - 支持媒体去重和压缩
 */

import JSZip from 'jszip';
import type { NodeGraph } from '../types';
import { sanitizeNodeGraphForExport } from './export';
import { sanitizeNodeGraphResultAreaItemsForPersistence } from '../services/projectMediaAssets';
import {
  BUNDLE_FORMAT_VERSION,
  BUNDLE_FILE_EXTENSION,
  BUNDLE_PATHS,
  createAbortError,
  type BundleManifest,
  type BundleExportOptions,
  type BundleProjectDocument,
  type BundleExportResult,
} from './bundleTypes';
import { triggerBlobDownload } from '@/client/utils/fileSaver';
import { getBundleAssetHandlers } from './bundleHandlers';
import type { BundleZipWriteOptions } from './bundleHandlers/types';

const DEFAULT_BUNDLE_EXPORT_OPTIONS: BundleExportOptions = {
  compressionLevel: undefined,
  customFileName: undefined,
  enableCompression: undefined,
  onProgress: undefined,
  signal: undefined,
};

const normalizeBundleProjectDocument = (
  input: BundleProjectDocument | NodeGraph,
): BundleProjectDocument => {
  if (input && typeof input === 'object' && 'nodeGraph' in input) {
    const projectDocument = input as BundleProjectDocument;
    return {
      nodeGraph: projectDocument.nodeGraph,
      mediaAssets: projectDocument.mediaAssets ?? {},
    };
  }
  return {
    nodeGraph: input as NodeGraph,
    mediaAssets: {},
  };
};

/**
 * 构建安全的文件名
 */
function safeFileName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_\u4e00-\u9fa5]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'canvas';
}

/**
 * 将 NodeGraph 导出为 Bundle
 */
export async function buildBundleExport(
  projectDocumentOrNodeGraph: BundleProjectDocument | NodeGraph,
  appVersion: string,
  options: BundleExportOptions = DEFAULT_BUNDLE_EXPORT_OPTIONS
): Promise<BundleExportResult> {
  const {
    compressionLevel = 6,
    enableCompression = true,
    customFileName,
    onProgress,
    signal,
  } = options;

  // 1. 清理节点运行时状态
  const projectDocument = normalizeBundleProjectDocument(projectDocumentOrNodeGraph);
  const sanitizedNodeGraph = sanitizeNodeGraphResultAreaItemsForPersistence(
    sanitizeNodeGraphForExport(projectDocument.nodeGraph),
    projectDocument.mediaAssets,
  );
  let exportProjectDocument: BundleProjectDocument = {
    nodeGraph: sanitizedNodeGraph,
    mediaAssets: projectDocument.mediaAssets,
  };

  // 2. 创建 ZIP
  const zip = new JSZip();
  const compression: BundleZipWriteOptions['compression'] = enableCompression ? 'DEFLATE' : 'STORE';
  const compressionOptions = enableCompression
    ? { level: compressionLevel as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 }
    : undefined;
  const zipWriteOptions: BundleZipWriteOptions = {
    compression,
    compressionOptions,
  };

  const errors: string[] = [];
  const warnings: string[] = [];
  const manifest: BundleManifest = {
    version: BUNDLE_FORMAT_VERSION,
    format: 'iarts-bundle',
    exportedAt: new Date().toISOString(),
    appVersion,
    compression: enableCompression ? 'deflate' : 'store',
    mediaManifest: {},
    filesManifest: undefined,
    mediaStats: {
      totalCount: 0,
      totalSizeBytes: 0,
      deduplicatedSizeBytes: 0,
    },
  };

  for (const handler of getBundleAssetHandlers()) {
    const next = handler.export
      ? await handler.export({
          zip,
          zipWriteOptions,
          projectDocument: exportProjectDocument,
          manifest,
          errors,
          warnings,
          onProgress,
          signal,
        })
      : undefined;
    if (next) {
      exportProjectDocument = next;
    }
  }

  if (errors.length > 0) {
    throw new Error(errors[0] ?? '导出失败');
  }

  zip.file(BUNDLE_PATHS.PROJECT, JSON.stringify(exportProjectDocument));
  zip.file(BUNDLE_PATHS.MANIFEST, JSON.stringify(manifest, null, 2));

  // 3. 生成 ZIP Blob
  if ((signal !== null && signal !== undefined ? signal.aborted : undefined)) {
    throw createAbortError();
  }

  if (onProgress) {
    onProgress({ stage: 'zip', messageKey: 'bundle.export.zip', processed: undefined, total: undefined, percent: 0 });
  }
  const blob = await zip.generateAsync(
    {
      type: 'blob',
      compression,
      ...(compressionOptions ? { compressionOptions } : {}),
    },
    (metadata) => {
      if ((signal !== null && signal !== undefined ? signal.aborted : undefined)) {
        throw createAbortError();
      }
      if (typeof (metadata !== null && metadata !== undefined ? metadata.percent : undefined) === 'number') {
        if (onProgress) {
          onProgress({ stage: 'zip', messageKey: 'bundle.export.zip', processed: undefined, total: undefined, percent: metadata.percent });
        }
      }
    }
  );
  if ((signal !== null && signal !== undefined ? signal.aborted : undefined)) {
    throw createAbortError();
  }
  if (onProgress) {
    onProgress({ stage: 'zip', messageKey: 'bundle.export.zip', processed: undefined, total: undefined, percent: 100 });
  }

  const customBaseName = customFileName !== null && customFileName !== undefined ? customFileName.trim() : undefined;
  const baseName = customBaseName !== undefined && customBaseName.length > 0 ? customBaseName : exportProjectDocument.nodeGraph.name;
  const fileName = `${safeFileName(baseName)}${BUNDLE_FILE_EXTENSION}`;

  return { blob, fileName, manifest };
}

/**
 * 导出 NodeGraph 为 Bundle 文件并触发下载
 */
export async function exportNodeGraphToBundleFile(
  projectDocumentOrNodeGraph: BundleProjectDocument | NodeGraph,
  appVersion = 'dev',
  options: BundleExportOptions = DEFAULT_BUNDLE_EXPORT_OPTIONS
): Promise<BundleExportResult> {
  const result = await buildBundleExport(projectDocumentOrNodeGraph, appVersion, options);
  if ((options.signal !== null && options.signal !== undefined ? options.signal.aborted : undefined)) {
    throw createAbortError();
  }
  await triggerBlobDownload(result.blob, result.fileName, undefined);
  return result;
}
