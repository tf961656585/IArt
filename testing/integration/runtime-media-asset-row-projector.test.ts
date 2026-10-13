import { describe, expect, it } from 'vitest';

import {
  projectRuntimeMediaAssetRowToMediaAsset,
  projectRuntimeMediaAssetRowsToProjectMediaAssets,
} from '@iart/contracts/media-asset-row-projector';

describe('runtime media asset row projector', () => {
  it('uses row identity and payload media facts to hydrate MediaAsset', () => {
    const asset = projectRuntimeMediaAssetRowToMediaAsset({
      assetId: 'asset-video-1',
      mediaType: 'video',
      payloadJson: JSON.stringify({
        original: {
          url: '/files/video.mp4',
          projectRef: 'project-a',
          fileKey: 'video.mp4',
          sourceUrl: 'https://example.test/video.mp4',
          mimeType: 'video/mp4',
          sizeBytes: '1024',
          width: '1920',
          height: 1080,
          durationMs: '33000',
        },
        thumbnail: {
          url: '/files/video-thumb.jpg',
          mimeType: 'image/jpeg',
          width: '320',
          height: 180,
          status: 'ready',
          generatedAt: '20',
          error: null,
        },
      }),
      createdAt: 10,
      updatedAt: 20,
    });

    expect(asset).toMatchObject({
      id: 'asset-video-1',
      mediaType: 'video',
      original: {
        url: '/files/video.mp4',
        projectRef: 'project-a',
        fileKey: 'video.mp4',
        sourceUrl: 'https://example.test/video.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 1024,
        width: 1920,
        height: 1080,
        durationMs: 33000,
      },
      thumbnail: {
        url: '/files/video-thumb.jpg',
        status: 'ready',
        width: 320,
        height: 180,
        generatedAt: 20,
      },
      lifecycle: {
        createdAt: 10,
        updatedAt: 20,
      },
    });
  });

  it('uses payload lifecycle before row timestamps', () => {
    const asset = projectRuntimeMediaAssetRowToMediaAsset({
      assetId: 'asset-image-1',
      mediaType: 'image',
      payloadJson: JSON.stringify({
        original: { url: '/files/image.png' },
        lifecycle: { createdAt: 100, updatedAt: 200 },
      }),
      createdAt: 10,
      updatedAt: 20,
    });

    expect(asset?.lifecycle).toEqual({ createdAt: 100, updatedAt: 200 });
  });

  it('keeps row identity when payload contains an old complete MediaAsset shape', () => {
    const asset = projectRuntimeMediaAssetRowToMediaAsset({
      assetId: 'asset-row-wins',
      mediaType: 'image',
      payloadJson: JSON.stringify({
        id: 'asset-payload-loses',
        mediaType: 'video',
        original: { url: '/files/image.png' },
        thumbnail: { status: 'ready' },
      }),
      createdAt: 1,
      updatedAt: 2,
    });

    expect(asset).toMatchObject({
      id: 'asset-row-wins',
      mediaType: 'image',
      lifecycle: { createdAt: 1, updatedAt: 2 },
    });
  });

  it('normalizes missing or invalid thumbnail state to missing', () => {
    const missingThumbnail = projectRuntimeMediaAssetRowToMediaAsset({
      assetId: 'asset-missing-thumb',
      mediaType: 'image',
      payloadJson: JSON.stringify({ original: { url: '/files/image.png' } }),
    }, { now: 123 });
    const invalidThumbnail = projectRuntimeMediaAssetRowToMediaAsset({
      assetId: 'asset-invalid-thumb',
      mediaType: 'image',
      payloadJson: JSON.stringify({
        original: { url: '/files/image.png' },
        thumbnail: { status: 'unexpected' },
      }),
    }, { now: 123 });

    expect(missingThumbnail?.thumbnail).toEqual({
      url: null,
      mimeType: null,
      width: null,
      height: null,
      status: 'missing',
      generatedAt: null,
      error: null,
    });
    expect(invalidThumbnail?.thumbnail.status).toBe('missing');
    expect(missingThumbnail?.lifecycle).toEqual({ createdAt: 123, updatedAt: 123 });
  });

  it('returns null when original.url is missing and skips invalid rows in map projection', () => {
    const invalid = {
      assetId: 'asset-invalid',
      mediaType: 'image',
      payloadJson: JSON.stringify({ original: { mimeType: 'image/png' } }),
      createdAt: 1,
      updatedAt: 1,
    };
    const valid = {
      assetId: 'asset-valid',
      mediaType: 'image',
      payloadJson: JSON.stringify({ original: { url: '/files/valid.png' } }),
      createdAt: 1,
      updatedAt: 1,
    };

    expect(projectRuntimeMediaAssetRowToMediaAsset(invalid)).toBeNull();
    expect(projectRuntimeMediaAssetRowsToProjectMediaAssets([invalid, valid])).toMatchObject({
      'asset-valid': {
        id: 'asset-valid',
        original: { url: '/files/valid.png' },
      },
    });
  });
});
