'use client';

import { getRuntimeProjectPath } from '@/client/store/runtimeStore';
import type { MediaAsset, ProjectMediaType } from '@iart/contracts';
import type { MediaAssetUpsertParams, StorageUpsertMediaAssetResult } from '@iart/contracts/editor-storage-contract';
import { useCanvasStore } from '../store/canvasStore';
import { ensureImageThumbnail } from './imageThumbnailService';
import { ensureVideoThumbnail } from './videoThumbnailService';

type ImportLocalMediaResult = {
  url: string;
  fileName: string;
  isNew: boolean;
  sizeBytes: number;
};

export type LocalMediaImportResult = {
  blobUrl: string;
  persistentUrl: string;
  mediaType: 'image' | 'video' | 'audio';
  sizeBytes: number;
  isNew: boolean;
  assetId: string;
  asset: MediaAsset;
};

type LocalMediaType = LocalMediaImportResult['mediaType'];

type StorageInvoke = (args: unknown | undefined) => Promise<unknown>;

type ImageDimensions = {
  width: number;
  height: number;
};

const IMPORT_LOCAL_MEDIA_CHANNEL = 'storage:import-local-media';
const UPSERT_MEDIA_ASSET_CHANNEL = 'storage:upsert-media-asset';

function getRequiredProjectPath(): string {
  const projectPath = getRuntimeProjectPath();
  if (!projectPath) {
    throw new Error('还没有打开项目，无法导入文件');
  }
  return projectPath;
}

function getRequiredStorageChannel(channel: string): StorageInvoke {
  const storage = typeof window !== 'undefined' ? (window.electron !== null && window.electron !== undefined ? window.electron.storage : undefined) : null;
  const invoke = (storage !== null && storage !== undefined ? storage[channel] : undefined);
  if (typeof invoke !== 'function') {
    throw new Error('当前环境无法保存文件，请在桌面应用里操作');
  }
  return invoke as StorageInvoke;
}

function resolveMediaType(mimeType: string): LocalMediaType {
  if (mimeType.startsWith('image/')) {
    return 'image';
  }

  if (mimeType.startsWith('video/')) {
    return 'video';
  }

  if (mimeType.startsWith('audio/')) {
    return 'audio';
  }

  throw new Error(`不支持的本地媒体类型：${mimeType}`);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function extractImageDimensions(blobUrl: string): Promise<ImageDimensions> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve({ width: 0, height: 0 });
    image.src = blobUrl;
  });
}

async function upsertMediaAsset(projectPath: string, params: MediaAssetUpsertParams): Promise<StorageUpsertMediaAssetResult> {
  const invoke = getRequiredStorageChannel(UPSERT_MEDIA_ASSET_CHANNEL);
  const result = await invoke({ projectPath, params }) as StorageUpsertMediaAssetResult;
  if (!(result !== null && result !== undefined ? result.assetId : undefined) || !(result.asset !== null && result.asset !== undefined ? result.asset.id : undefined)) {
    throw new Error('[localMediaImport] 登记 mediaAsset 未返回完整资产');
  }
  return result;
}

export function commitImportedMediaAsset(asset: MediaAsset): void {
  if (!(asset !== null && asset !== undefined ? asset.id : undefined)) return;
  const state = useCanvasStore.getState();
  state.setProjectMediaAssets(
    { [asset.id]: asset },
    { source: 'user-action' },
  );
}

export type RegisterMediaAssetExtras = {
  sizeBytes: number | null | undefined;
  mimeType: string | null | undefined;
  width: number | null | undefined;
  height: number | null | undefined;
  durationMs: number | null | undefined;
};

export async function registerAndCommitMediaAsset(
  url: string,
  mediaType: ProjectMediaType,
  extras: RegisterMediaAssetExtras | undefined,
): Promise<{ assetId: string | null; asset: MediaAsset | null }> {
  try {
    const projectPath = getRuntimeProjectPath();
    if (!projectPath) return { assetId: null, asset: null };

    const result = await upsertMediaAsset(projectPath, {
      mediaType,
      url,
      // 该登记入口服务媒体工具/运行域回填链路（非用户导入文件），无原始文件名。
      sourceFileName: undefined,
      sizeBytes: (extras !== null && extras !== undefined ? extras.sizeBytes : undefined) ?? undefined,
      mimeType: (extras !== null && extras !== undefined ? extras.mimeType : undefined) ?? undefined,
      width: (extras !== null && extras !== undefined ? extras.width : undefined) ?? undefined,
      height: (extras !== null && extras !== undefined ? extras.height : undefined) ?? undefined,
      durationMs: (extras !== null && extras !== undefined ? extras.durationMs : undefined) ?? undefined,
      thumbnailUrl: undefined,
      thumbnailStatus: undefined,
    });

    if (result.asset) {
      commitImportedMediaAsset(result.asset);
      scheduleImportedMediaThumbnailRepair(projectPath, result.asset);
    }

    return { assetId: result.assetId, asset: result.asset };
  } catch (error) {
    console.warn('[registerAndCommitMediaAsset] 资产注册失败:', error);
    return { assetId: null, asset: null };
  }
}

export function scheduleImportedMediaThumbnailRepair(projectPath: string, asset: MediaAsset): void {
  if (!(asset !== null && asset !== undefined ? asset.id : undefined)) return;
  const sourceUrl = (asset.original !== null && asset.original !== undefined ? asset.original.url : undefined) ?? '';
  if (!sourceUrl) return;

  if (asset.mediaType === 'image') {
    void ensureImageThumbnail(sourceUrl, {
      assetId: asset.id,
      projectPath,
      maxEdge: undefined,
      quality: undefined,
    });
    return;
  }

  if (asset.mediaType === 'video') {
    void ensureVideoThumbnail(sourceUrl, {
      assetId: asset.id,
      projectPath,
      width: undefined,
      quality: undefined,
      timeSec: undefined,
    });
  }
}

export async function importLocalFile(file: File): Promise<LocalMediaImportResult> {
  const blobUrl = URL.createObjectURL(file);
  const arrayBuffer = await file.arrayBuffer();
  const fileDataBase64 = arrayBufferToBase64(arrayBuffer);
  const projectPath = getRequiredProjectPath();
  const mimeType = file.type || 'application/octet-stream';
  const mediaType = resolveMediaType(mimeType);
  const importLocalMedia = getRequiredStorageChannel(IMPORT_LOCAL_MEDIA_CHANNEL);

  const result = (await importLocalMedia({
    projectPath,
    fileDataBase64,
    mimeType,
    originalFileName: file.name,
  })) as ImportLocalMediaResult;

  const mediaAssetParams: MediaAssetUpsertParams = {
    mediaType,
    url: result.url,
    // 原始文件名是导入素材唯一自带的语义信息，随登记落库供素材检索（导入链路 spec 2026-10-07 裁定）。
    sourceFileName: file.name,
    mimeType,
    sizeBytes: result.sizeBytes,
    width: undefined,
    height: undefined,
    durationMs: undefined,
    thumbnailUrl: undefined,
    thumbnailStatus: undefined,
  };

  if (mediaType === 'image') {
    const { width, height } = await extractImageDimensions(blobUrl);
    mediaAssetParams.width = width;
    mediaAssetParams.height = height;
  }

  const upsertResult = await upsertMediaAsset(projectPath, mediaAssetParams);
  commitImportedMediaAsset(upsertResult.asset);
  scheduleImportedMediaThumbnailRepair(projectPath, upsertResult.asset);

  return {
    blobUrl,
    persistentUrl: result.url,
    mediaType,
    sizeBytes: result.sizeBytes,
    isNew: result.isNew,
    assetId: upsertResult.assetId,
    asset: upsertResult.asset,
  };
}
