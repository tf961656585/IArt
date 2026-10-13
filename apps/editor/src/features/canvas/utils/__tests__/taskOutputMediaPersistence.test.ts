import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveTaskOutputMediaCandidatesForResultAreaItem,
  resolveTaskOutputMediaCandidatesForNode,
} from '../taskOutputMediaPersistence';
import { ContentCacheManager } from '../../services/contentCacheManager';
import { storeBase64Media } from '../../services/mediaStorage';
import { ensureLocalFilesImageUrl } from '../mediaUtils';

vi.mock('../../services/contentCacheManager', () => ({
  ContentCacheManager: {
    enqueue: vi.fn(),
  },
}));

vi.mock('../../services/mediaStorage', () => ({
  storeBase64Media: vi.fn(),
}));

vi.mock('../mediaUtils', () => ({
  ensureLocalFilesImageUrl: vi.fn(),
}));

describe('taskOutputMediaPersistence', () => {
  const resolveAssetId = (): string | null => null;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('优先落盘 base64（成功时返回 local-media URL，不触发远程缓存）', async () => {
    vi.mocked(storeBase64Media).mockResolvedValue({
      kind: 'url',
      url: 'local-media://prj_demo/mock.png',
      mimeType: 'image/png',
      sizeBytes: 10,
    });

    const resolved = await resolveTaskOutputMediaCandidatesForNode({
      candidates: ['data:image/png;base64,QUJD', 'https://example.com/out.png'],
      nodeGraphId: 'graph_1',
      nodeId: 'node_1',
      mediaType: 'image',
      source: 'execution',
      originalUrl: 'execution://node_1',
      filenamePrefix: 'canvas',
    });

    // 返回值契约为 { url, assetId }；测试环境无打开项目，assetId 为 null
    expect(resolved).toEqual({ url: 'local-media://prj_demo/mock.png', assetId: null });
    expect(vi.mocked(ContentCacheManager.enqueue)).not.toHaveBeenCalled();
  });

  it('base64 落盘失败时不回退远程，并触发 ContentCacheManager.enqueue', async () => {
    vi.mocked(storeBase64Media).mockRejectedValue(new Error('disk write failed'));

    const resolved = await resolveTaskOutputMediaCandidatesForNode({
      candidates: ['data:image/png;base64,QUJD', 'https://example.com/out.png'],
      nodeGraphId: 'graph_1',
      nodeId: 'node_1',
      mediaType: 'image',
      source: 'execution',
      originalUrl: 'execution://node_1',
      filenamePrefix: 'canvas',
    });

    expect(resolved).toBeNull();
    expect(vi.mocked(ContentCacheManager.enqueue)).toHaveBeenCalledWith({
      nodeId: 'node_1',
      nodeGraphId: 'graph_1',
      url: 'https://example.com/out.png',
      mediaType: 'image',
    });
  });

  it.each([
    ['image', 'https://example.com/out.png'],
    ['video', 'https://example.com/out.mp4'],
    ['audio', 'https://example.com/out.mp3'],
  ])('远程 %s 不直接返回（node）', async (mediaType, url) => {
    const resolved = await resolveTaskOutputMediaCandidatesForNode({
      candidates: [url],
      nodeGraphId: 'graph_1',
      nodeId: 'node_1',
      mediaType: mediaType as 'image' | 'video' | 'audio',
      source: 'execution',
      originalUrl: 'execution://node_1',
      filenamePrefix: 'canvas',
    });

    expect(resolved).toBeNull();
    expect(vi.mocked(ContentCacheManager.enqueue)).toHaveBeenCalledWith({
      nodeId: 'node_1',
      nodeGraphId: 'graph_1',
      url,
      mediaType,
    });
  });

  it.each([
    ['image', 'https://example.com/out.png'],
    ['video', 'https://example.com/out.mp4'],
    ['audio', 'https://example.com/out.mp3'],
  ])('远程 %s 不直接返回（结果区域 item）', async (mediaType, url) => {
    vi.mocked(ensureLocalFilesImageUrl).mockRejectedValue(new Error('fail'));

    const resolved = await resolveTaskOutputMediaCandidatesForResultAreaItem({
      candidates: [url],
      nodeGraphId: 'graph_1',
      resultAreaNodeId: 'node_resultArea',
      itemId: 'item_1',
      mediaType: mediaType as 'image' | 'video' | 'audio',
      source: 'result-reload',
      originalUrl: 'result://node_resultArea/item_1',
      filenamePrefix: 'canvas',
      allowDiskWrite: true,
      resolveAssetId,
    });

    expect(resolved).toBeNull();
  });

  it('结果区域 image 远程候选即使转成本地文件，拿不到 formal assetId 时也不会返回正式结果', async () => {
    vi.mocked(ensureLocalFilesImageUrl).mockResolvedValue('/files/image-local.png');

    const resolved = await resolveTaskOutputMediaCandidatesForResultAreaItem({
      candidates: ['https://example.com/out.png'],
      nodeGraphId: 'graph_1',
      resultAreaNodeId: 'node_resultArea',
      itemId: 'item_1',
      mediaType: 'image',
      source: 'result-reload',
      originalUrl: 'result://node_resultArea/item_1',
      filenamePrefix: 'canvas',
      allowDiskWrite: true,
      resolveAssetId,
    });

    expect(resolved).toBeNull();
    expect(vi.mocked(ensureLocalFilesImageUrl)).toHaveBeenCalledWith('https://example.com/out.png');
  });

  it('结果区域已有 formal asset 映射时可复用本地 local-media 结果并返回 assetId', async () => {
    const resolved = await resolveTaskOutputMediaCandidatesForResultAreaItem({
      candidates: ['local-media://prj_demo/already-owned.png'],
      nodeGraphId: 'graph_1',
      resultAreaNodeId: 'node_resultArea',
      itemId: 'item_1',
      mediaType: 'image',
      source: 'result-reload',
      originalUrl: 'result://node_resultArea/item_1',
      filenamePrefix: 'canvas',
      allowDiskWrite: true,
      resolveAssetId: (url, mediaType) =>
        url === 'local-media://prj_demo/already-owned.png' && mediaType === 'image' ? 'asset_image_existing' : null,
    });

    expect(resolved).toEqual({
      url: 'local-media://prj_demo/already-owned.png',
      assetId: 'asset_image_existing',
      mediaAsset: null,
      mediaType: 'image',
      mimeType: null,
      sizeBytes: null,
    });
  });

  it.each([
    ['video', 'https://example.com/out.mp4'],
    ['audio', 'https://example.com/out.mp3'],
  ])('非 Hub / compat 下结果区域 %s 远程候选不会再由该 helper 直接落盘', async (mediaType, url) => {
    const resolved = await resolveTaskOutputMediaCandidatesForResultAreaItem({
      candidates: [url],
      nodeGraphId: 'graph_1',
      resultAreaNodeId: 'node_resultArea',
      itemId: 'item_1',
      mediaType: mediaType as 'video' | 'audio',
      source: 'result-reload',
      originalUrl: 'result://node_resultArea/item_1',
      filenamePrefix: 'canvas',
      allowDiskWrite: true,
      resolveAssetId,
    });

    expect(resolved).toBeNull();
  });
});
