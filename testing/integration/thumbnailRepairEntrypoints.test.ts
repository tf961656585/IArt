// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cjsImportAs, clearCjsCache, createCjsMock, patchModuleLoad, resolveCjsPath } from './helpers/cjs-mock';

type BusinessActionsModule = {
  executeBusinessSyncAction: (submit: unknown) => Promise<unknown>;
};

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('thumbnail repair backend entrypoints', () => {
  const cjs = createCjsMock();

  const clearBackendModule = (specifier: string) => {
    clearCjsCache(resolveCjsPath(specifier));
  };

  const loadBusinessActionsWithRegistry = async (registryExports: Record<string, unknown>, serviceExports: Record<string, unknown> = {}) => {
    clearBackendModule('../../apps/backend/dist/local-server/business-actions.cjs');
    clearBackendModule('../../apps/backend/dist/local-server/business-actions/sync-actions.cjs');
    clearBackendModule('../../apps/backend/dist/local-server/business-actions/sync-media.cjs');
    cjs.replace('../../apps/backend/dist/local-server/media-asset-registry.cjs', registryExports);
    cjs.replace('../../apps/backend/dist/local-server/thumbnail-reconcile-service.cjs', serviceExports);
    return cjsImportAs<BusinessActionsModule>('../../apps/backend/dist/local-server/business-actions.cjs');
  };

  const loadMainProcessWithMocks = async (params: {
    projectScopeExports: Record<string, unknown>;
    thumbnailServiceExports: Record<string, unknown>;
    resumeIncompletePollingTasks: ReturnType<typeof vi.fn>;
  }) => {
    const restoreModuleLoad = patchModuleLoad({
      'node:http': {
        createServer: vi.fn(() => ({
          on: vi.fn(),
          listen: vi.fn(),
          close: vi.fn(),
          address: vi.fn(() => ({ port: 4100 })),
        })),
      },
      './local-server/constants.cjs': { HOST: '127.0.0.1' },
      './local-server/config-store.cjs': { resolveListenPort: vi.fn(() => 0) },
      './local-server/storage.cjs': { ensureStorageDirs: vi.fn() },
      './local-server/project-store.cjs': { getProjectIndex: vi.fn(() => []) },
      './local-server/logging.cjs': { logInfo: vi.fn(), logError: vi.fn() },
      './local-server/router.cjs': {
        createRequestHandler: vi.fn(() => vi.fn()),
        setServerPort: vi.fn(),
      },
      './local-server/business-actions.cjs': { attachBusinessActionWebSocketServer: vi.fn() },
      './local-server/task-engine.cjs': {
        resumeIncompletePollingTasks: params.resumeIncompletePollingTasks,
        isTaskFinalStatus: vi.fn(() => true),
        normalizeTaskStatus: vi.fn((status: unknown) => String(status ?? '')),
      },
      './local-server/backend-ipc-sender.cjs': {
        sendTaskStateSnapshot: vi.fn(),
        sendReadTasks: vi.fn(async () => ({ success: true, data: [] })),
        sendReadTaskOutputs: vi.fn(async () => ({ success: true, data: [] })),
        sendReadMediaAssetsByTask: vi.fn(async () => ({ success: true, data: [] })),
      },
      './local-server/project-media-scope.cjs': params.projectScopeExports,
      './local-server/thumbnail-reconcile-service.cjs': params.thumbnailServiceExports,
      './runtime-env-loader.cjs': { loadRuntimeEnv: vi.fn() },
      './runtime-snapshot-builder.cjs': { buildTaskStateSnapshotPayload: vi.fn(() => null) },
    });
    const trackedEvents = [
      'message',
      'SIGTERM',
      'SIGINT',
      'disconnect',
      'uncaughtException',
      'unhandledRejection',
    ];
    const beforeListeners = new Map(
      trackedEvents.map((eventName) => [eventName, new Set(process.listeners(eventName))]),
    );

    clearBackendModule('../../apps/backend/dist/main.cjs');
    await cjsImportAs<Record<string, unknown>>('../../apps/backend/dist/main.cjs');

    const dispatchMessage = async (message: unknown) => {
      const messageListeners = process
        .listeners('message')
        .filter((listener) => !beforeListeners.get('message')?.has(listener));
      for (const listener of messageListeners) {
        (listener as (msg: unknown) => void)(message);
      }
      await flushMicrotasks();
    };

    const cleanup = () => {
      restoreModuleLoad();
      for (const eventName of trackedEvents) {
        const originalListeners = beforeListeners.get(eventName) ?? new Set();
        for (const listener of process.listeners(eventName)) {
          if (!originalListeners.has(listener)) {
            process.removeListener(eventName, listener);
          }
        }
      }
      clearBackendModule('../../apps/backend/dist/main.cjs');
    };

    return { dispatchMessage, cleanup };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cjs.restore();
    vi.resetModules();
  });

  it('media.image_thumbnail business action enters formal MediaAsset.thumbnail repair', async () => {
    const repairProjectMediaAssetThumbnail = vi.fn(async () => ({
      assetId: 'asset-image-business',
      asset: {
        id: 'asset-image-business',
        mediaType: 'image',
        original: { url: '/files/image-business.png' },
        thumbnail: {
          status: 'ready',
          url: '/files/thumbnails/image-business.webp',
          mimeType: 'image/webp',
          width: 256,
          height: 128,
          generatedAt: 1,
          error: null,
        },
        lifecycle: { createdAt: 1, updatedAt: 2 },
      },
      result: {
        url: '/files/thumbnails/image-business.webp',
        meta: { thumbnailWidth: 256, thumbnailHeight: 128 },
      },
    }));
    const { executeBusinessSyncAction } = await loadBusinessActionsWithRegistry({ repairProjectMediaAssetThumbnail });

    const result = await executeBusinessSyncAction({
      actionName: 'media.image_thumbnail',
      projectPath: '/tmp/formal.iartproj',
      payload: {
        assetId: 'asset-image-business',
        maxEdge: 512,
        quality: 0.8,
      },
    }) as { ok?: boolean; result?: Record<string, unknown> };

    expect(repairProjectMediaAssetThumbnail).toHaveBeenCalledWith('/tmp/formal.iartproj', expect.objectContaining({
      assetId: 'asset-image-business',
      mediaType: 'image',
      maxEdge: 512,
      quality: 0.8,
    }));
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      success: true,
      assetId: 'asset-image-business',
      url: '/files/thumbnails/image-business.webp',
      mediaAsset: {
        id: 'asset-image-business',
        thumbnail: {
          status: 'ready',
          url: '/files/thumbnails/image-business.webp',
        },
      },
      adapter: {
        route: '/api/media/image/thumbnail',
        mode: 'backend_internal_adapter',
      },
    });
  });

  it('media.video_thumbnail business action enters the same formal repair chain', async () => {
    const repairProjectMediaAssetThumbnail = vi.fn(async () => ({
      assetId: 'asset-video-business',
      asset: {
        id: 'asset-video-business',
        mediaType: 'video',
        original: { url: '/files/video-business.mp4' },
        thumbnail: {
          status: 'ready',
          url: '/files/thumbnails/video-business.jpg',
          mimeType: 'image/jpeg',
          width: 512,
          height: 288,
          generatedAt: 1,
          error: null,
        },
        lifecycle: { createdAt: 1, updatedAt: 2 },
      },
      result: {
        url: '/files/thumbnails/video-business.jpg',
        meta: { thumbnailWidth: 512, thumbnailHeight: 288 },
      },
    }));
    const { executeBusinessSyncAction } = await loadBusinessActionsWithRegistry({ repairProjectMediaAssetThumbnail });

    const result = await executeBusinessSyncAction({
      actionName: 'media.video_thumbnail',
      projectPath: '/tmp/formal.iartproj',
      payload: {
        assetId: 'asset-video-business',
        width: 512,
        quality: 0.7,
        timeSec: 1.25,
      },
    }) as { ok?: boolean; result?: Record<string, unknown> };

    expect(repairProjectMediaAssetThumbnail).toHaveBeenCalledWith('/tmp/formal.iartproj', expect.objectContaining({
      assetId: 'asset-video-business',
      mediaType: 'video',
      width: 512,
      quality: 0.7,
      timeSec: 1.25,
    }));
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      success: true,
      assetId: 'asset-video-business',
      url: '/files/thumbnails/video-business.jpg',
      mediaAsset: {
        id: 'asset-video-business',
        thumbnail: {
          status: 'ready',
          url: '/files/thumbnails/video-business.jpg',
        },
      },
      adapter: {
        route: '/api/media/video/thumbnail',
        mode: 'backend_internal_adapter',
      },
    });
  });

  it('media.thumbnail_report_missing business action reports render errors through reconcile service', async () => {
    const reportThumbnailRenderFailure = vi.fn(async () => ({
      accepted: true,
      scheduled: true,
      downgradedAssetIds: ['asset-render-missing'],
    }));
    const { executeBusinessSyncAction } = await loadBusinessActionsWithRegistry(
      { repairProjectMediaAssetThumbnail: vi.fn() },
      {
        reportThumbnailRenderFailure,
        reportMissingThumbnailByUrl: vi.fn(),
      },
    );

    const result = await executeBusinessSyncAction({
      actionName: 'media.thumbnail_report_missing',
      projectPath: '/tmp/formal.iartproj',
      payload: {
        assetId: 'asset-render-missing',
        mediaType: 'image',
        thumbnailUrl: '/project-media/prj_demo/thumbnails/missing.webp',
        reason: 'render_error',
      },
    }) as { ok?: boolean; result?: Record<string, unknown> };

    expect(reportThumbnailRenderFailure).toHaveBeenCalledWith('/tmp/formal.iartproj', {
      assetId: 'asset-render-missing',
      mediaType: 'image',
      failedUrl: '/project-media/prj_demo/thumbnails/missing.webp',
    });
    expect(result).toMatchObject({
      ok: true,
      result: {
        accepted: true,
        scheduled: true,
        downgradedAssetIds: ['asset-render-missing'],
      },
    });
  });

  it('runtime:project-scope-register message wires scope sync, reconcile and repair scheduling', async () => {
    const reconcileProjectThumbnails = vi.fn(async () => ({
      projectPath: '/tmp/formal.iartproj',
      downgradedAssetIds: ['asset-ready-missing'],
    }));
    const scheduleProjectThumbnailRepair = vi.fn(() => true);
    const syncProjectScope = vi.fn();
    const resumeIncompletePollingTasks = vi.fn(async () => undefined);
    const { dispatchMessage, cleanup } = await loadMainProcessWithMocks({
      projectScopeExports: {
        registerRuntimeProjectScope: vi.fn(),
        registerGlobalMediaScope: vi.fn(),
        syncProjectScope,
        syncAllProjectScopes: vi.fn(),
        removeProjectScope: vi.fn(),
      },
      thumbnailServiceExports: {
        reconcileProjectThumbnails,
        scheduleProjectThumbnailRepair,
      },
      resumeIncompletePollingTasks,
    });

    try {
      await dispatchMessage({
        type: 'runtime:project-scope-register',
        stableProjectId: 'spid_demo',
        projectPath: '/tmp/formal.iartproj',
        projectRef: 'prj_0123456789abcdef0123456789abcdef',
      });

      expect(syncProjectScope).toHaveBeenCalledWith({
        stableProjectId: 'spid_demo',
        projectPath: '/tmp/formal.iartproj',
        projectRef: 'prj_0123456789abcdef0123456789abcdef',
      });
      expect(reconcileProjectThumbnails).toHaveBeenCalledWith('/tmp/formal.iartproj');
      expect(scheduleProjectThumbnailRepair).toHaveBeenCalledWith('/tmp/formal.iartproj', 'project_scope_registered');
      expect(resumeIncompletePollingTasks).toHaveBeenCalledWith({
        projectPath: '/tmp/formal.iartproj',
        limit: 200,
      });
    } finally {
      cleanup();
    }
  });

  it('runtime:project-scope-opened message wires main process reconcile before resume snapshot', async () => {
    const reconcileProjectThumbnails = vi.fn(async () => ({
      projectPath: '/tmp/formal.iartproj',
      downgradedAssetIds: ['asset-ready-missing'],
    }));
    const scheduleProjectThumbnailRepair = vi.fn(() => true);
    const registerRuntimeProjectScope = vi.fn();
    const resumeIncompletePollingTasks = vi.fn(async () => undefined);
    const { dispatchMessage, cleanup } = await loadMainProcessWithMocks({
      projectScopeExports: {
        registerRuntimeProjectScope,
        registerGlobalMediaScope: vi.fn(),
        syncProjectScope: vi.fn(),
        syncAllProjectScopes: vi.fn(),
        removeProjectScope: vi.fn(),
      },
      thumbnailServiceExports: {
        reconcileProjectThumbnails,
        scheduleProjectThumbnailRepair,
      },
      resumeIncompletePollingTasks,
    });

    try {
      await dispatchMessage({
        type: 'runtime:project-scope-opened',
        projectPath: '/tmp/formal.iartproj',
      });

      expect(registerRuntimeProjectScope).toHaveBeenCalledWith('/tmp/formal.iartproj');
      expect(reconcileProjectThumbnails).toHaveBeenCalledWith('/tmp/formal.iartproj');
      expect(scheduleProjectThumbnailRepair).toHaveBeenCalledWith('/tmp/formal.iartproj', 'project_scope_opened_legacy');
      expect(resumeIncompletePollingTasks).toHaveBeenCalledWith({
        projectPath: '/tmp/formal.iartproj',
        limit: 200,
      });
    } finally {
      cleanup();
    }
  });
});
