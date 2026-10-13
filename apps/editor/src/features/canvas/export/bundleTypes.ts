/**
 * Bundle 打包格式类型定义
 * - 定义 .iarts ZIP 打包格式的核心类型
 */

import type { ProjectMediaAssets } from '@iart/contracts';
import type { NodeGraph } from '../types';

/** Bundle 格式版本 */
export const BUNDLE_FORMAT_VERSION = 3;

/** Bundle 文件扩展名 */
export const BUNDLE_FILE_EXTENSION = '.iarts';

/** Bundle 内部文件路径 */
export const BUNDLE_PATHS = {
  MANIFEST: 'manifest.json',
  PROJECT: 'project.json',
  MEDIA_DIR: 'media',
  FILES_DIR: 'files',
} as const;

export interface BundleProjectDocument {
  nodeGraph: NodeGraph;
  mediaAssets: ProjectMediaAssets;
}

/** 媒体清单条目 */
export interface MediaManifestEntry {
  /** 相对路径（如 media/a1b2c3d4.png） */
  path: string;
  /** MIME 类型 */
  mimeType: string;
  /** 文件大小（字节） */
  sizeBytes: number;
  /** 原始 URL 列表（用于去重追溯） */
  originalUrls: string[];
}

/** /files 资源清单条目 */
export interface FilesManifestEntry {
  /** 相对路径（如 files/<originalFileKey>） */
  path: string;
  /** MIME 类型 */
  mimeType: string;
  /** 文件大小（字节） */
  sizeBytes: number;
  /** 原始 URL 列表（用于调试追溯） */
  originalUrls: string[];
}

/** Bundle 清单 */
export interface BundleManifest {
  /** 格式版本 */
  version: number;
  /** 格式标识 */
  format: 'iarts-bundle';
  /** 导出时间 */
  exportedAt: string;
  /** 应用版本 */
  appVersion: string;
  /** 压缩方式 */
  compression: 'deflate' | 'store';
  /** 媒体清单（key 为媒体 hash） */
  mediaManifest: Record<string, MediaManifestEntry>;
  /** /files 资源清单（key 为导出片段内引用到的 originalFileKey，向后兼容可选） */
  filesManifest: Record<string, FilesManifestEntry> | undefined;
  /** 媒体统计 */
  mediaStats: {
    /** 媒体文件总数 */
    totalCount: number;
    /** 媒体文件总大小（字节） */
    totalSizeBytes: number;
    /** 去重节省的大小（字节） */
    deduplicatedSizeBytes: number;
  };
}

/** Bundle 任务进度事件（导入/导出复用） */
export type BundleTaskProgressEvent = {
  /** Stage identifier (e.g. sanitize/media/files/zip). */
  stage: string;
  /** i18n message key for UI. */
  messageKey: string | undefined;
  /** Processed count for the stage. */
  processed: number | undefined;
  /** Total count for the stage. */
  total: number | undefined;
  /** Percent in [0, 100]. */
  percent: number | undefined;
};

/** Bundle 任务进度回调 */
export type BundleTaskProgressCallback = (event: BundleTaskProgressEvent) => void;

/** Bundle 导出进度事件 */
export type BundleExportProgressEvent = BundleTaskProgressEvent;

/** Bundle 导出进度回调 */
export type BundleExportProgressCallback = BundleTaskProgressCallback;

/** Bundle 导入进度事件 */
export type BundleImportProgressEvent = BundleTaskProgressEvent;

/** Bundle 导入进度回调 */
export type BundleImportProgressCallback = BundleTaskProgressCallback;

/** Bundle 导出选项 */
export interface BundleExportOptions {
  /** 压缩级别 (1-9)，默认 6 */
  compressionLevel: number | undefined;
  /** 自定义文件名（不含扩展名） */
  customFileName: string | undefined;
  /** 是否启用压缩，默认 true */
  enableCompression: boolean | undefined;
  /** 进度回调 */
  onProgress: BundleExportProgressCallback | undefined;
  /** 取消信号 */
  signal: AbortSignal | undefined;
}

/** Bundle 导入选项 */
export interface BundleImportOptions {
  /** 进度回调 */
  onProgress: BundleImportProgressCallback | undefined;
  /** 取消信号 */
  signal: AbortSignal | undefined;
}

/** Create a normalized AbortError instance. */
export const createAbortError = (message = 'Aborted'): Error => {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
};

/** Check if the provided error is an AbortError. */
export const isAbortError = (error: unknown): error is Error => {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return false;
  return (error as { name: unknown | undefined }).name === 'AbortError';
};

/** Bundle 导出结果 */
export interface BundleExportResult {
  /** 导出的 Blob */
  blob: Blob;
  /** 文件名 */
  fileName: string;
  /** 清单信息 */
  manifest: BundleManifest;
}

/** Bundle 导入结果 */
export interface BundleImportResult {
  /** 是否有效 */
  valid: boolean;
  /** 错误列表 */
  errors: string[];
  /** 警告列表 */
  warnings: string[];
  /** 解析后的 NodeGraph */
  nodeGraph: NodeGraph | undefined;
  /** 解析后的项目媒体资产表 */
  mediaAssets: ProjectMediaAssets | undefined;
  /** 清单信息 */
  manifest: BundleManifest | undefined;
}

/** 去重后的媒体信息 */
export interface DedupedMedia {
  /** 内容 hash */
  hash: string;
  /** 媒体 Blob */
  blob: Blob;
  /** MIME 类型 */
  mimeType: string;
  /** 原始 URL 列表 */
  originalUrls: string[];
  /** 引用此媒体的节点 ID 列表 */
  nodeIds: string[];
}

/** 节点媒体引用（导出时使用） */
export interface NodeMediaRef {
  /** 媒体 hash */
  mediaRef: string;
}
