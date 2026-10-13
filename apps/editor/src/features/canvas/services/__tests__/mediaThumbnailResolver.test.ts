import { describe, expect, it } from 'vitest';

import { resolveMediaAssetForThumbnail } from '../mediaThumbnailResolver';
import type { ProjectMediaAssets } from '@iart/contracts';

// 合规 scope 值（V1 projectRef: prj_ + 32 hex）
const PROJECT_REF = 'prj_0123456789abcdef0123456789abcdef';

const mediaAssets: ProjectMediaAssets = {
  'asset-image-1': {
    id: 'asset-image-1',
    mediaType: 'image',
    original: {
      url: `local-media://${PROJECT_REF}/images/foo.png`,
      projectRef: PROJECT_REF,
      fileKey: 'images/foo.png',
      sourceUrl: '/files/foo.png',
      sourceFileName: null,
      mimeType: 'image/png',
      sizeBytes: 128,
      width: 640,
      height: 360,
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
    lifecycle: {
      createdAt: 1,
      updatedAt: 1,
    },
  },
  'asset-image-2': {
    id: 'asset-image-2',
    mediaType: 'image',
    original: {
      url: `local-media://${PROJECT_REF}/images/bar.png`,
      projectRef: PROJECT_REF,
      fileKey: 'images/bar.png',
      sourceUrl: '/files/bar.png',
      sourceFileName: null,
      mimeType: 'image/png',
      sizeBytes: 128,
      width: 640,
      height: 360,
      durationMs: null,
      fps: null,
    },
    thumbnail: {
      url: '/files/thumbnails/bar.webp',
      mimeType: 'image/webp',
      width: 256,
      height: 144,
      status: 'ready',
      generatedAt: 2,
      error: null,
    },
    lifecycle: {
      createdAt: 1,
      updatedAt: 1,
    },
  },
};

describe('resolveMediaAssetForThumbnail', () => {
  it('assetId 优先于 sourceUrl 匹配', () => {
    const resolved = resolveMediaAssetForThumbnail({
      mediaAssets,
      mediaType: 'image',
      assetId: 'asset-image-2',
      sourceUrl: `local-media://${PROJECT_REF}/images/foo.png`,
      projectRef: undefined,
      fileKey: undefined,
    });

    expect(resolved.assetId).toBe('asset-image-2');
    expect(resolved.asset?.original?.fileKey).toBe('images/bar.png');
  });

  it('可通过 projectRef + fileKey 定位正式资产（V2 spid_ URL）', () => {
    // 使用 V2 spid_ scope URL 验证新解析路径
    const stableProjectId = 'spid_0123456789abcdef01234567';
    const resolved = resolveMediaAssetForThumbnail({
      mediaAssets,
      mediaType: 'image',
      assetId: undefined,
      sourceUrl: `local-media://${stableProjectId}/images/foo.png?cache=1#view`,
      projectRef: undefined,
      fileKey: undefined,
    });

    expect(resolved.assetId).toBe('asset-image-1');
    expect(resolved.projectRef).toBe(stableProjectId);
    expect(resolved.fileKey).toBe('images/foo.png');
  });

  it('可通过 projectRef + fileKey 定位正式资产（V1 prj_ URL）', () => {
    const resolved = resolveMediaAssetForThumbnail({
      mediaAssets,
      mediaType: 'image',
      assetId: undefined,
      sourceUrl: `local-media://${PROJECT_REF}/images/foo.png?cache=1#view`,
      projectRef: undefined,
      fileKey: undefined,
    });

    expect(resolved.assetId).toBe('asset-image-1');
    expect(resolved.projectRef).toBe(PROJECT_REF);
    expect(resolved.fileKey).toBe('images/foo.png');
  });

  it('local-media 地址无 assetId 时无法匹配资产，但标记 isLocalMedia', () => {
    const resolved = resolveMediaAssetForThumbnail({
      mediaAssets,
      mediaType: 'image',
      assetId: undefined,
      sourceUrl: 'local-media://image/imported.png',
      projectRef: undefined,
      fileKey: undefined,
    });

    expect(resolved.asset).toBeNull();
    expect(resolved.isLocalMedia).toBe(true);
    expect(resolved.sourceUrl).toBe('local-media://image/imported.png');
  });

  it('local-media 地址有 assetId 时可匹配到资产并触发修复', () => {
    const resolved = resolveMediaAssetForThumbnail({
      mediaAssets,
      mediaType: 'image',
      assetId: 'asset-image-1',
      sourceUrl: 'local-media://image/imported.png',
      projectRef: undefined,
      fileKey: undefined,
    });

    expect(resolved.asset).not.toBeNull();
    expect(resolved.assetId).toBe('asset-image-1');
    expect(resolved.isLocalMedia).toBe(true);
  });
});
