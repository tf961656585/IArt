// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryResponse, createMockRequest, parseMemoryResponseJson, readStringProperty, type RouterModule } from './helpers/http-test-types';
import { cjsImportAs, clearCjsCache, createCjsMock, resolveCjsPath } from './helpers/cjs-mock';
import { clearIartsDataRoot, setIartsDataRoot } from './helpers/runtime-globals';

describe('backend router /api/media/video/thumbnail - formal repair entrypoint', () => {
  const cjs = createCjsMock();
  let tempRoot: string;
  let storageRoot: string;
  let projectPath: string;

  const clearBackendModule = (specifier: string) => {
    clearCjsCache(resolveCjsPath(specifier));
  };

  const loadRouterWithRepair = async (repairProjectMediaAssetThumbnail: ReturnType<typeof vi.fn>) => {
    clearBackendModule('../../apps/backend/dist/local-server/routes/media-routes.cjs');
    clearBackendModule('../../apps/backend/dist/local-server/router.cjs');
    cjs.replace('../../apps/backend/dist/local-server/media-asset-registry.cjs', {
      repairProjectMediaAssetThumbnail,
    });
    return cjsImportAs<RouterModule>('../../apps/backend/dist/local-server/router.cjs');
  };

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iarts-router-video-thumb-'));
    storageRoot = path.join(tempRoot, 'storage');
    projectPath = path.join(tempRoot, 'project.iartproj');
    fs.mkdirSync(projectPath, { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'manifest.json'), JSON.stringify({ version: 1, name: 'demo' }), 'utf-8');
    setIartsDataRoot(storageRoot);
    vi.clearAllMocks();
  });

  afterEach(() => {
    cjs.restore();
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
    clearIartsDataRoot();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('assetId 优先进入 Runtime MediaAsset.thumbnail repair，并返回正式 mediaAsset', async () => {
    const repairProjectMediaAssetThumbnail = vi.fn(async () => ({
      assetId: 'asset-video-1',
      asset: {
        id: 'asset-video-1',
        mediaType: 'video',
        original: { url: '/files/original.mp4' },
        thumbnail: {
          status: 'ready',
          url: '/files/thumbnails/formal-video.jpg',
          mimeType: 'image/jpeg',
          width: 512,
          height: 288,
          generatedAt: 1,
          error: null,
        },
        lifecycle: { createdAt: 1, updatedAt: 2 },
      },
      result: {
        url: '/files/thumbnails/formal-video.jpg',
        meta: { thumbnailWidth: 512, thumbnailHeight: 288 },
      },
    }));
    const router = await loadRouterWithRepair(repairProjectMediaAssetThumbnail);
    const handler = router.createRequestHandler({ baseDir: process.cwd() });

    const req = createMockRequest({
      method: 'POST',
      url: '/api/media/video/thumbnail',
      body: Buffer.from(
        JSON.stringify({
          path: projectPath,
          assetId: 'asset-video-1',
          width: 512,
          quality: 0.7,
          timeSec: 0,
        }),
        'utf-8',
      ),
      headers: { 'content-type': 'application/json' },
    });
    const res = new MemoryResponse();

    await handler(req, res);
    await new Promise((resolve) => res.once('finish', resolve));

    expect(res.statusCode).toBe(200);
    expect(repairProjectMediaAssetThumbnail).toHaveBeenCalledWith(projectPath, expect.objectContaining({
      assetId: 'asset-video-1',
      mediaType: 'video',
      width: 512,
      quality: 0.7,
      timeSec: 0,
    }));
    expect(repairProjectMediaAssetThumbnail.mock.calls[0]?.[1]).not.toHaveProperty('sourceUrl');
    const parsed = parseMemoryResponseJson(res);
    expect(parsed.success).toBe(true);
    expect(readStringProperty(parsed, 'assetId')).toBe('asset-video-1');
    expect(readStringProperty(parsed, 'url')).toContain('/files/thumbnails/formal-video.jpg');
    expect(parsed.mediaAsset).toMatchObject({
      id: 'asset-video-1',
      thumbnail: {
        status: 'ready',
        url: '/files/thumbnails/formal-video.jpg',
      },
    });
  });

  it('sourceUrl-only 请求被拒绝，不再作为正式 repair 身份', async () => {
    const repairProjectMediaAssetThumbnail = vi.fn(async () => ({
      assetId: 'asset-video-from-source',
      asset: {
        id: 'asset-video-from-source',
        mediaType: 'video',
        original: { url: '/files/source-only.mp4' },
        thumbnail: {
          status: 'ready',
          url: '/files/thumbnails/source-only.jpg',
          mimeType: 'image/jpeg',
          width: 320,
          height: 180,
          generatedAt: 1,
          error: null,
        },
        lifecycle: { createdAt: 1, updatedAt: 2 },
      },
      result: {
        url: '/files/thumbnails/source-only.jpg',
        meta: { thumbnailWidth: 320, thumbnailHeight: 180 },
      },
    }));
    const router = await loadRouterWithRepair(repairProjectMediaAssetThumbnail);
    const handler = router.createRequestHandler({ baseDir: process.cwd() });

    const req = createMockRequest({
      method: 'POST',
      url: '/api/media/video/thumbnail',
      body: Buffer.from(
        JSON.stringify({
          path: projectPath,
          sourceUrl: '/files/source-only.mp4',
          width: 320,
          quality: 0.6,
          timeSec: 1.25,
        }),
        'utf-8',
      ),
      headers: { 'content-type': 'application/json' },
    });
    const res = new MemoryResponse();

    await handler(req, res);
    await new Promise((resolve) => res.once('finish', resolve));

    expect(res.statusCode).toBe(400);
    expect(repairProjectMediaAssetThumbnail).not.toHaveBeenCalled();
    const parsed = parseMemoryResponseJson(res);
    expect(parsed.success).toBe(false);
    expect(readStringProperty(parsed, 'code')).toBe('missing_media_asset_id');
  });
});
