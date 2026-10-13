import { beforeEach, describe, expect, it, vi } from 'vitest';

const submitBusinessSyncActionMock = vi.fn<(...args: unknown[]) => unknown>();
const getRuntimeProjectPathMock = vi.fn<() => string | null>();

vi.mock('@/client/api/businessActionRuntime', () => ({
  createBusinessActionId: () => 'action-thumbnail-report',
}));

vi.mock('@/client/store/runtimeStore', () => ({
  getRuntimeProjectPath: () => getRuntimeProjectPathMock(),
}));

vi.mock('@/client/utils/businessActionSocket', () => ({
  submitBusinessSyncAction: (...args: unknown[]) => submitBusinessSyncActionMock(...args),
}));

describe('thumbnailHealthReporter', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getRuntimeProjectPathMock.mockReturnValue('/tmp/demo.iartproj');
    submitBusinessSyncActionMock.mockResolvedValue({
      result: {
        accepted: true,
        scheduled: true,
        downgradedAssetIds: ['asset-image-1'],
      },
    });
  });

  it('reports render error through shared business action contract', async () => {
    const { reportThumbnailRenderFailure } = await import('../thumbnailHealthReporter');

    const result = await reportThumbnailRenderFailure({
      assetId: 'asset-image-1',
      mediaType: 'image',
      failedUrl: '/project-media/prj_demo/thumbnails/missing.webp',
    });

    expect(submitBusinessSyncActionMock).toHaveBeenCalledWith({
      actionId: 'action-thumbnail-report',
      actionName: 'media.thumbnail_report_missing',
      projectPath: '/tmp/demo.iartproj',
      payload: {
        projectPath: '/tmp/demo.iartproj',
        assetId: 'asset-image-1',
        mediaType: 'image',
        thumbnailUrl: '/project-media/prj_demo/thumbnails/missing.webp',
        reason: 'render_error',
      },
    });
    expect(result).toEqual({
      accepted: true,
      scheduled: true,
      downgradedAssetIds: ['asset-image-1'],
    });
  });

  it('dedupes repeated asset/url reports in a short window', async () => {
    const { reportThumbnailRenderFailure } = await import('../thumbnailHealthReporter');

    await reportThumbnailRenderFailure({
      assetId: 'asset-image-1',
      mediaType: 'image',
      failedUrl: '/project-media/prj_demo/thumbnails/missing.webp',
    });
    await reportThumbnailRenderFailure({
      assetId: 'asset-image-1',
      mediaType: 'image',
      failedUrl: '/project-media/prj_demo/thumbnails/missing.webp',
    });

    expect(submitBusinessSyncActionMock).toHaveBeenCalledTimes(1);
  });
});
