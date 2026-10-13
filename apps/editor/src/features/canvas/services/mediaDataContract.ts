/**
 * 媒体数据契约层
 * 单一权威的媒体数据处理入口
 */

import {
  assertMediaReferencesResolved,
  normalizeMediaInput as normalizeSharedMediaInput,
  resolveAllNormalizedMediaReferences,
  resolveFirstMediaReference,
  type ResolvedTargetMediaReference,
} from "@/features/models/shared/mediaReferenceResolver";
import type { ResolvedMediaItemWithMeta } from "@/features/models/shared/mediaResolverRegistry";
import type { MediaResolutionError } from "@/features/models/shared/mediaResolutionTypes";

// ============ 类型定义 ============

/** 上传文件项（表单格式） */
export interface UploadFileItem {
  id: string | undefined | undefined;
  file: File | Blob | null | undefined;
  src: string | null | undefined;
}

/** 标准化媒体项 */
export interface NormalizedMediaItem {
  id: string | undefined | undefined;
  source:
    | { type: "file"; file: File | Blob }
    | { type: "url"; url: string };
}

/** 解析后的媒体项 */
export interface ResolvedMediaItem {
  id: string | undefined | undefined;
  file: File | Blob | undefined | undefined;
  url: string | undefined | undefined;
  mimeType: string | undefined | undefined;
  /** 标记此 URL 是否为 Object URL（需要手动释放） */
  isObjectUrl: boolean | undefined | undefined;
}

/** 解析选项 */
export interface ResolveOptions {
  /** 是否下载 URL 为本地 Blob（用于需要 base64 的场景） */
  downloadUrls: boolean | undefined;
  /** 最大并发数 */
  concurrency: number | undefined;
}

export interface ResolveAllMediaItemsWithMetaResult {
  items: ResolvedMediaItemWithMeta[];
  errors: MediaResolutionError[];
}

// ============ 类型守卫 ============

export const isUploadFileItem = (value: unknown): value is UploadFileItem => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return "file" in value || "src" in value || "id" in value;
};

const createResolvedMediaItem = (fields: {
  id: string | undefined;
  file: File | Blob | undefined;
  url: string | undefined;
  mimeType: string | undefined;
  isObjectUrl: boolean | undefined;
}): ResolvedMediaItem => ({
  id: fields.id,
  file: fields.file,
  url: fields.url,
  mimeType: fields.mimeType,
  isObjectUrl: fields.isObjectUrl,
});

// ============ 规范化（同步） ============

/**
 * 将任意媒体输入规范化为标准格式
 * 这是媒体处理的唯一入口点
 */
export const normalizeMediaInput = (
  value: unknown,
  maxItems: number | undefined
): NormalizedMediaItem[] => normalizeSharedMediaInput(value, maxItems);

// ============ 解析（异步） ============

/**
 * 解析单个标准化媒体项
 */
export const resolveMediaItem = async (
  item: NormalizedMediaItem
): Promise<ResolvedMediaItem | null> => {
  const { source } = item;

  switch (source.type) {
    case "file":
      return createResolvedMediaItem({
        id: item.id,
        file: source.file,
        url: undefined,
        mimeType: source.file.type || undefined,
        isObjectUrl: undefined,
      });

    case "url":
      return createResolvedMediaItem({
        id: item.id,
        file: undefined,
        url: source.url,
        mimeType: undefined,
        isObjectUrl: undefined,
      });
  }
};

/**
 * 释放 ResolvedMediaItem 中的 Object URL
 * 调用方负责在不再需要时调用此函数
 */
export const revokeResolvedMediaItem = (item: ResolvedMediaItem | null | undefined): void => {
  if (item === null || item === undefined) return;
  if (item.isObjectUrl !== true || !item.url) return;
  try {
    URL.revokeObjectURL(item.url);
  } catch {
    // ignore
  }
};

/**
 * 批量释放 ResolvedMediaItem 中的 Object URL
 */
export const revokeAllResolvedMediaItems = (items: Array<ResolvedMediaItem | null | undefined>): void => {
  for (const item of items) {
    revokeResolvedMediaItem(item);
  }
};

/** 批量解析（带选项） */
export const resolveAllMediaItems = async (
  items: NormalizedMediaItem[],
  options: ResolveOptions | undefined
): Promise<ResolvedMediaItem[]> => {
  const { downloadUrls = false } = options ?? {};
  const resolved = await resolveAllNormalizedMediaReferences(
    items,
    downloadUrls ? "upload-file" : "file-or-url"
  );
  return resolved.items.map((item): ResolvedMediaItem => createResolvedMediaItem({
    id: item.id,
    file: item.file,
    url: item.url,
    mimeType: item.mimeType,
    isObjectUrl: item.isObjectUrl,
  }));
};

export const resolveAllMediaItemsWithMeta = async (
  items: NormalizedMediaItem[],
  options: ResolveOptions | undefined
): Promise<ResolveAllMediaItemsWithMetaResult> => {
  const { downloadUrls = false } = options ?? {};
  const result = await resolveAllNormalizedMediaReferences(
    items,
    downloadUrls ? "upload-file" : "file-or-url",
  );

  const merged: ResolvedMediaItemWithMeta[] = result.items.map((it: ResolvedTargetMediaReference) => ({
    id: it.id,
    file: it.file,
    url: it.url,
    mimeType: it.mimeType,
    isObjectUrl: it.isObjectUrl,
    meta: it.meta,
  }));

  return { items: merged, errors: result.errors };
};

// ============ 便捷方法 ============

/** 提取第一个文件 */
export const extractFirstFile = async (value: unknown): Promise<File | Blob | undefined> => {
  const resolved = await resolveFirstMediaReference(value, "upload-file");
  assertMediaReferencesResolved(resolved.errors);
  return (resolved.item !== null && resolved.item !== undefined ? resolved.item.file : undefined);
};

/** 提取所有文件 */
export const extractAllFiles = async (value: unknown): Promise<Array<File | Blob>> => {
  const items = await resolveAllNormalizedMediaReferences(normalizeMediaInput(value, undefined), "upload-file");
  assertMediaReferencesResolved(items.errors);
  return items.items.map((r) => r.file).filter((f): f is File | Blob => !!f);
};

/** 提取第一个 URL */
export const extractFirstUrl = async (value: unknown): Promise<string | undefined> => {
  const resolved = await resolveFirstMediaReference(value, "renderable-url");
  assertMediaReferencesResolved(resolved.errors);
  return (resolved.item !== null && resolved.item !== undefined ? resolved.item.url : undefined);
};

/** 提取所有 URL */
export const extractAllUrls = async (value: unknown): Promise<string[]> => {
  const resolved = await resolveAllNormalizedMediaReferences(normalizeMediaInput(value, undefined), "renderable-url");
  assertMediaReferencesResolved(resolved.errors);
  return resolved.items.map((r) => r.url).filter((u): u is string => !!u);
};

/** 提取第一个文件或 URL（优先文件） */
export const extractFirstFileOrUrl = async (
  value: unknown
): Promise<File | Blob | string | undefined> => {
  const resolved = await resolveFirstMediaReference(value, "file-or-url");
  assertMediaReferencesResolved(resolved.errors);
  return (resolved.item !== null && resolved.item !== undefined ? resolved.item.file : undefined) ?? (resolved.item !== null && resolved.item !== undefined ? resolved.item.url : undefined);
};
