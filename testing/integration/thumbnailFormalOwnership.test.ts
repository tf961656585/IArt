import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sharedRequire } from './helpers/cjs-mock';
import { isJsonObject } from './helpers/http-test-types';

const requireBackend = sharedRequire;

const clearRequireCache = (modulePath: string) => {
  const resolved = requireBackend.resolve(modulePath);
  delete requireBackend.cache[resolved];
};

describe('thumbnail formal ownership helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearRequireCache('../../apps/backend/dist/local-server/router.cjs');
    clearRequireCache('../../apps/backend/dist/local-server/media-asset-registry.cjs');
    clearRequireCache('../../apps/backend/dist/local-server/runtime-media-assets.cjs');
  });

  it('thumbnail lifecycle 只从 runtime media_assets row 解析正式 MediaAsset', () => {
    const { parseRuntimeMediaAssetRowToMediaAsset } = requireBackend(
      '../../apps/backend/dist/local-server/media-asset-registry.cjs',
    ) as {
      parseRuntimeMediaAssetRowToMediaAsset: (row: unknown) => unknown;
    };
    const result = parseRuntimeMediaAssetRowToMediaAsset({
      assetId: 'asset-formal-1',
      mediaType: 'image',
      payloadJson: JSON.stringify({
        original: {
          url: 'local-media://prj_123/formal.png',
          projectRef: 'prj_123',
          fileKey: 'formal.png',
          sourceUrl: 'https://example.test/formal.png',
          mimeType: 'image/png',
          sizeBytes: 128,
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
      }),
      createdAt: 1,
      updatedAt: 2,
    });
    if (!isJsonObject(result)) {
      throw new Error('Expected runtime media asset');
    }

    expect(result).toMatchObject({
      id: 'asset-formal-1',
      mediaType: 'image',
      original: {
        url: 'local-media://prj_123/formal.png',
        projectRef: 'prj_123',
        fileKey: 'formal.png',
        sourceUrl: 'https://example.test/formal.png',
      },
      thumbnail: { status: 'missing' },
      lifecycle: { createdAt: 1, updatedAt: 2 },
    });
  });

  it('正式 thumbnail ready 写回失败时，repair 会直接失败而不是返回伪成功结果', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iarts-thumb-repair-'));
    fs.mkdirSync(path.join(projectRoot, 'media'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'media', 'formal.png'), Buffer.from('fake-image'), 'utf-8');
    try {
      const projectStorage = requireBackend('../../apps/backend/dist/local-server/project-storage.cjs') as {
        loadProjectDocument: (projectPath: string) => unknown;
      };
      const mediaProcessing = requireBackend(
        '../../apps/backend/dist/local-server/media-processing-actions.cjs',
      ) as {
        executeImageThumbnail: (payload: unknown) => Promise<unknown>;
      };
      const backendIpcSender = requireBackend(
        '../../apps/backend/dist/local-server/backend-ipc-sender.cjs',
      ) as {
        sendReadMediaAssetById: (payload: unknown) => Promise<unknown>;
        sendRuntimeTransaction: (payload: unknown) => Promise<unknown>;
        sendMediaAssetsChangedNotification: (payload: unknown) => void;
      };

      const loadProjectDocumentSpy = vi.spyOn(projectStorage, 'loadProjectDocument').mockReturnValue(null);
      vi.spyOn(backendIpcSender, 'sendReadMediaAssetById').mockResolvedValue({
        success: true,
        data: {
          assetId: 'asset-formal-1',
          mediaType: 'image',
          payloadJson: JSON.stringify({
            original: {
              url: 'local-media://prj_0123456789abcdef0123456789abcdef/formal.png',
              mimeType: 'image/png',
              sizeBytes: 128,
              width: 512,
              height: 512,
              durationMs: null,
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
          }),
          createdAt: 1,
          updatedAt: 1,
        },
      });
      vi.spyOn(backendIpcSender, 'sendRuntimeTransaction')
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValue({ success: false, error: 'write_failed' });
      vi.spyOn(backendIpcSender, 'sendMediaAssetsChangedNotification').mockImplementation(() => {});
      vi.spyOn(mediaProcessing, 'executeImageThumbnail').mockResolvedValue({
        url: 'local-media://prj_0123456789abcdef0123456789abcdef/thumbnails/thumb.webp',
        meta: {
          thumbnailWidth: 256,
          thumbnailHeight: 128,
        },
      });

      const { repairProjectMediaAssetThumbnail } = requireBackend(
        '../../apps/backend/dist/local-server/media-asset-registry.cjs',
      ) as {
        repairProjectMediaAssetThumbnail: (projectPath: string, params: Record<string, unknown>) => Promise<unknown>;
      };

      await expect(
        repairProjectMediaAssetThumbnail(projectRoot, {
          assetId: 'asset-formal-1',
          mediaType: 'image',
        }),
      ).rejects.toMatchObject({
        message: 'thumbnail_formal_state_persist_failed',
      });
      expect(loadProjectDocumentSpy).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
