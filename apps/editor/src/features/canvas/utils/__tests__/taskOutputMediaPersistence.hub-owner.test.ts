import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveTaskOutputMediaCandidatesForResultAreaItem,
  resolveTaskOutputMediaCandidatesForNode,
} from '../taskOutputMediaPersistence';
import { ContentCacheManager } from '../../services/contentCacheManager';
import { ensureLocalFilesImageUrl } from '../mediaUtils';
import { persistResultMedia } from '@/client/api/media';
import { isHubRuntime } from '@/client/utils/hubFetch';

vi.mock('../../services/contentCacheManager', () => ({
  ContentCacheManager: {
    enqueue: vi.fn(),
  },
}));

vi.mock('../mediaUtils', () => ({
  ensureLocalFilesImageUrl: vi.fn(),
}));

vi.mock('@/client/api/media', () => ({
  persistResultMedia: vi.fn(),
}));

vi.mock('@/client/utils/hubFetch', () => ({
  isHubRuntime: vi.fn(() => true),
}));

describe('taskOutputMediaPersistence Hub owner', () => {
  const resolveAssetId = (): string | null => null;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isHubRuntime).mockReturnValue(true);
    vi.mocked(persistResultMedia).mockResolvedValue({
      url: 'local-media://project-1/from-backend.png',
      originalUrl: 'https://example.com/out.png',
      assetId: 'asset_image_backend',
      mediaAsset: {
        id: 'asset_image_backend',
        mediaType: 'image',
        original: {
          url: 'local-media://project-1/from-backend.png',
          projectRef: 'project-1',
          fileKey: 'from-backend.png',
          sourceUrl: 'https://example.com/out.png',
          sourceFileName: null,
          mimeType: 'image/png',
          sizeBytes: 1024,
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
        lifecycle: {
          createdAt: 1,
          updatedAt: 1,
        },
      },
      mediaType: 'image',
      mimeType: 'image/png',
      sizeBytes: 1024,
    });
  });

  it('node 远端结果候选在 Hub 主路径改为由 backend owner 落盘并返回 local-media URL', async () => {
    const resolved = await resolveTaskOutputMediaCandidatesForNode({
      candidates: ['https://example.com/out.png'],
      nodeGraphId: 'graph_1',
      nodeId: 'node_1',
      mediaType: 'image',
      source: 'execution',
      originalUrl: 'execution://node_1',
      filenamePrefix: 'canvas',
    });

    // 返回值契约为 { url, assetId }
    expect(resolved).toEqual({
      url: 'local-media://project-1/from-backend.png',
      assetId: 'asset_image_backend',
    });
    expect(vi.mocked(persistResultMedia)).toHaveBeenCalledWith({
      url: 'https://example.com/out.png',
      mediaType: 'image',
      filenamePrefix: 'canvas',
      originalUrl: 'execution://node_1',
    });
    expect(vi.mocked(ContentCacheManager.enqueue)).not.toHaveBeenCalled();
  });

  it('resultArea 远端结果候选在 Hub 主路径不再走 ensureLocalFilesImageUrl，而是统一交给 backend owner', async () => {
    const resolved = await resolveTaskOutputMediaCandidatesForResultAreaItem({
      candidates: ['https://example.com/out.png'],
      nodeGraphId: 'graph_1',
      resultAreaNodeId: 'resultArea_1',
      itemId: 'item_1',
      mediaType: 'image',
      source: 'result-reload',
      originalUrl: 'result://resultArea_1/item_1',
      filenamePrefix: 'canvas',
      allowDiskWrite: true,
      resolveAssetId,
    });

    expect(resolved).toEqual({
      url: 'local-media://project-1/from-backend.png',
      assetId: 'asset_image_backend',
      mediaAsset: {
        id: 'asset_image_backend',
        mediaType: 'image',
        original: {
          url: 'local-media://project-1/from-backend.png',
          projectRef: 'project-1',
          fileKey: 'from-backend.png',
          sourceUrl: 'https://example.com/out.png',
          sourceFileName: null,
          mimeType: 'image/png',
          sizeBytes: 1024,
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
        lifecycle: {
          createdAt: 1,
          updatedAt: 1,
        },
      },
      mediaType: 'image',
      mimeType: 'image/png',
      sizeBytes: 1024,
    });
    expect(vi.mocked(persistResultMedia)).toHaveBeenCalledWith({
      url: 'https://example.com/out.png',
      mediaType: 'image',
      filenamePrefix: 'canvas',
      originalUrl: 'result://resultArea_1/item_1',
    });
    expect(vi.mocked(ensureLocalFilesImageUrl)).not.toHaveBeenCalled();
  });
});
