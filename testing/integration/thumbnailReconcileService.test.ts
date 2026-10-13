// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cjsImportAs, clearCjsCache, createCjsMock, resolveCjsPath } from './helpers/cjs-mock';

type ThumbnailReconcileServiceModule = {
  reconcileProjectThumbnails: (projectPath: unknown) => Promise<{ downgradedAssetIds: string[] }>;
  reportMissingThumbnailByUrl: (projectPath: unknown, thumbnailUrl: unknown) => Promise<{ scheduled: boolean; downgradedAssetIds: string[] }>;
  reportThumbnailRenderFailure: (
    projectPath: unknown,
    params: { assetId?: unknown; mediaType?: unknown; failedUrl?: unknown },
  ) => Promise<{ scheduled: boolean; downgradedAssetIds: string[] }>;
  scheduleProjectThumbnailRepair: (projectPath: unknown, reason?: unknown) => boolean;
};

describe('thumbnail reconcile service', () => {
  const cjs = createCjsMock();

  const loadService = async (registryExports: Record<string, unknown>) => {
    clearCjsCache(resolveCjsPath('../../apps/backend/dist/local-server/thumbnail-reconcile-service.cjs'));
    cjs.replace('../../apps/backend/dist/local-server/media-asset-registry.cjs', registryExports);
    cjs.replace('../../apps/backend/dist/local-server/logging.cjs', {
      logDebug: vi.fn(),
    });
    return cjsImportAs<ThumbnailReconcileServiceModule>(
      '../../apps/backend/dist/local-server/thumbnail-reconcile-service.cjs',
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cjs.restore();
    vi.resetModules();
  });

  it('project scope opened 时 ready+missing file 会进入 repair 调度候选', async () => {
    const repairProjectMediaAssetThumbnail = vi.fn(async () => ({}));
    const service = await loadService({
      reconcileProjectThumbnails: vi.fn(async () => ({
        projectPath: '/tmp/project.iartproj',
        downgradedAssetIds: ['asset-ready-missing'],
      })),
      readAllRuntimeMediaAssets: vi.fn(async () => [{
        id: 'asset-ready-missing',
        mediaType: 'image',
        original: { url: '/project-media/prj_demo/original.png' },
        thumbnail: { status: 'stale', url: '/project-media/prj_demo/thumbnails/missing.webp' },
        lifecycle: { createdAt: 1, updatedAt: 2 },
      }]),
      readRuntimeMediaAssetById: vi.fn(),
      markProjectMediaAssetThumbnailStale: vi.fn(),
      repairProjectMediaAssetThumbnail,
      thumbnailFileExistsInProject: vi.fn(() => false),
    });

    const reconciled = await service.reconcileProjectThumbnails('/tmp/project.iartproj');
    service.scheduleProjectThumbnailRepair('/tmp/project.iartproj', 'project_scope_opened');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reconciled.downgradedAssetIds).toEqual(['asset-ready-missing']);
    expect(repairProjectMediaAssetThumbnail).toHaveBeenCalledWith('/tmp/project.iartproj', {
      assetId: 'asset-ready-missing',
      mediaType: 'image',
    });
  });

  it('project-media 404 上报会按 thumbnail URL 降级并调度 repair', async () => {
    const markProjectMediaAssetThumbnailStale = vi.fn(async () => ({
      assetId: 'asset-404',
      asset: {
        id: 'asset-404',
        mediaType: 'image',
        thumbnail: { status: 'stale', url: '/project-media/prj_demo/thumbnails/missing.webp' },
        original: { url: '/project-media/prj_demo/original.png' },
        lifecycle: { createdAt: 1, updatedAt: 2 },
      },
    }));
    const repairProjectMediaAssetThumbnail = vi.fn(async () => ({}));
    const service = await loadService({
      reconcileProjectThumbnails: vi.fn(),
      readAllRuntimeMediaAssets: vi.fn(async () => [{
        id: 'asset-404',
        mediaType: 'image',
        original: { url: '/project-media/prj_demo/original.png' },
        thumbnail: { status: 'ready', url: '/project-media/prj_demo/thumbnails/missing.webp' },
        lifecycle: { createdAt: 1, updatedAt: 2 },
      }]),
      readRuntimeMediaAssetById: vi.fn(),
      markProjectMediaAssetThumbnailStale,
      repairProjectMediaAssetThumbnail,
      thumbnailFileExistsInProject: vi.fn(() => false),
    });

    const result = await service.reportMissingThumbnailByUrl(
      '/tmp/project.iartproj',
      '/project-media/prj_demo/thumbnails/missing.webp',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(markProjectMediaAssetThumbnailStale).toHaveBeenCalledWith('/tmp/project.iartproj', { assetId: 'asset-404' });
    expect(result).toMatchObject({ scheduled: true, downgradedAssetIds: ['asset-404'] });
    expect(repairProjectMediaAssetThumbnail).toHaveBeenCalledWith('/tmp/project.iartproj', {
      assetId: 'asset-404',
      mediaType: 'image',
    });
  });

  it('render error 上报会按 assetId 降级并调度 repair', async () => {
    const markProjectMediaAssetThumbnailStale = vi.fn(async () => ({
      assetId: 'asset-render',
      asset: {
        id: 'asset-render',
        mediaType: 'video',
        thumbnail: { status: 'stale', url: '/project-media/prj_demo/thumbnails/render.jpg' },
        original: { url: '/project-media/prj_demo/video.mp4' },
        lifecycle: { createdAt: 1, updatedAt: 2 },
      },
    }));
    const repairProjectMediaAssetThumbnail = vi.fn(async () => ({}));
    const service = await loadService({
      reconcileProjectThumbnails: vi.fn(),
      readAllRuntimeMediaAssets: vi.fn(async () => [{
        id: 'asset-render',
        mediaType: 'video',
        original: { url: '/project-media/prj_demo/video.mp4' },
        thumbnail: { status: 'stale', url: '/project-media/prj_demo/thumbnails/render.jpg' },
        lifecycle: { createdAt: 1, updatedAt: 2 },
      }]),
      readRuntimeMediaAssetById: vi.fn(async () => ({
        id: 'asset-render',
        mediaType: 'video',
        original: { url: '/project-media/prj_demo/video.mp4' },
        thumbnail: { status: 'ready', url: '/project-media/prj_demo/thumbnails/render.jpg' },
        lifecycle: { createdAt: 1, updatedAt: 2 },
      })),
      markProjectMediaAssetThumbnailStale,
      repairProjectMediaAssetThumbnail,
      thumbnailFileExistsInProject: vi.fn(() => false),
    });

    const result = await service.reportThumbnailRenderFailure('/tmp/project.iartproj', {
      assetId: 'asset-render',
      mediaType: 'video',
      failedUrl: '/project-media/prj_demo/thumbnails/render.jpg',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(markProjectMediaAssetThumbnailStale).toHaveBeenCalledWith('/tmp/project.iartproj', { assetId: 'asset-render' });
    expect(result).toMatchObject({ scheduled: true, downgradedAssetIds: ['asset-render'] });
    expect(repairProjectMediaAssetThumbnail).toHaveBeenCalledWith('/tmp/project.iartproj', {
      assetId: 'asset-render',
      mediaType: 'video',
    });
  });
});
