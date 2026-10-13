// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryResponse, createMockRequest, parseMemoryResponseJson, readStringProperty, type RouterModule } from './helpers/http-test-types';
import { cjsImportAs, clearCjsCache, createCjsMock, resolveCjsPath } from './helpers/cjs-mock';
import { clearIartsDataRoot, setIartsDataRoot } from './helpers/runtime-globals';

describe('backend router /api/media/image/thumbnail - formal repair entrypoint', () => {
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
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iarts-router-image-thumb-'));
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
      assetId: 'asset-image-1',
      asset: {
        id: 'asset-image-1',
        mediaType: 'image',
        original: { url: '/files/original.png' },
        thumbnail: {
          status: 'ready',
          url: '/files/thumbnails/formal-image.webp',
          mimeType: 'image/webp',
          width: 256,
          height: 128,
          generatedAt: 1,
          error: null,
        },
        lifecycle: { createdAt: 1, updatedAt: 2 },
      },
      result: {
        url: '/files/thumbnails/formal-image.webp',
        meta: { thumbnailWidth: 256, thumbnailHeight: 128 },
      },
    }));
    const router = await loadRouterWithRepair(repairProjectMediaAssetThumbnail);
    const handler = router.createRequestHandler({ baseDir: process.cwd() });

    const req = createMockRequest({
      method: 'POST',
      url: '/api/media/image/thumbnail',
      body: Buffer.from(
        JSON.stringify({
          path: projectPath,
          assetId: 'asset-image-1',
          maxEdge: 512,
          quality: 0.8,
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
      assetId: 'asset-image-1',
      mediaType: 'image',
      maxEdge: 512,
      quality: 0.8,
    }));
    expect(repairProjectMediaAssetThumbnail.mock.calls[0]?.[1]).not.toHaveProperty('sourceUrl');
    const parsed = parseMemoryResponseJson(res);
    expect(parsed.success).toBe(true);
    expect(readStringProperty(parsed, 'assetId')).toBe('asset-image-1');
    expect(readStringProperty(parsed, 'url')).toContain('/files/thumbnails/formal-image.webp');
    expect(parsed.mediaAsset).toMatchObject({
      id: 'asset-image-1',
      thumbnail: {
        status: 'ready',
        url: '/files/thumbnails/formal-image.webp',
      },
    });
  });

  it('sourceUrl-only 请求被拒绝，不再作为正式 repair 身份', async () => {
    const repairProjectMediaAssetThumbnail = vi.fn(async () => ({
      assetId: 'asset-image-from-source',
      asset: {
        id: 'asset-image-from-source',
        mediaType: 'image',
        original: { url: '/files/source-only.png' },
        thumbnail: {
          status: 'ready',
          url: '/files/thumbnails/source-only.webp',
          mimeType: 'image/webp',
          width: 128,
          height: 128,
          generatedAt: 1,
          error: null,
        },
        lifecycle: { createdAt: 1, updatedAt: 2 },
      },
      result: {
        url: '/files/thumbnails/source-only.webp',
        meta: { thumbnailWidth: 128, thumbnailHeight: 128 },
      },
    }));
    const router = await loadRouterWithRepair(repairProjectMediaAssetThumbnail);
    const handler = router.createRequestHandler({ baseDir: process.cwd() });

    const req = createMockRequest({
      method: 'POST',
      url: '/api/media/image/thumbnail',
      body: Buffer.from(
        JSON.stringify({
          path: projectPath,
          sourceUrl: '/files/source-only.png',
          maxEdge: 256,
          quality: 0.7,
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
