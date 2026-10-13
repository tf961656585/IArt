import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaAsset } from '@iart/contracts';
import type {
  MediaAssetUpsertParams,
  StorageImportLocalMediaParams,
  StorageImportLocalMediaResult,
  StorageUpsertMediaAssetParams,
  StorageUpsertMediaAssetResult,
} from '@iart/contracts/editor-storage-contract';

import { useCanvasStore } from '../../store/canvasStore';

const getRuntimeProjectPathMock = vi.fn(() => '/tmp/project');
vi.mock('@/client/store/runtimeStore', () => ({
  getRuntimeProjectPath: () => getRuntimeProjectPathMock(),
}));

const ensureImageThumbnailMock = vi.fn<(...args: unknown[]) => Promise<void>>();
vi.mock('../imageThumbnailService', () => ({
  ensureImageThumbnail: (...args: unknown[]) => ensureImageThumbnailMock(...args),
}));

const ensureVideoThumbnailMock = vi.fn<(...args: unknown[]) => Promise<void>>();
vi.mock('../videoThumbnailService', () => ({
  ensureVideoThumbnail: (...args: unknown[]) => ensureVideoThumbnailMock(...args),
}));

type ImportLocalMediaInvoke = (args: StorageImportLocalMediaParams) => Promise<StorageImportLocalMediaResult>;
type UpsertMediaAssetInvoke = (args: StorageUpsertMediaAssetParams) => Promise<StorageUpsertMediaAssetResult>;

const importLocalMediaMock = vi.fn<ImportLocalMediaInvoke>();
const upsertMediaAssetMock = vi.fn<UpsertMediaAssetInvoke>();

const makeAsset = (overrides: Partial<MediaAsset> & { id: string; mediaType: MediaAsset['mediaType']; url: string }): MediaAsset => {
  const { id, mediaType, url, ...assetOverrides } = overrides;
  return {
    id,
    mediaType,
    original: {
      url,
      fileKey: url.startsWith('local-media://') ? url.slice('local-media://'.length) : null,
      projectRef: null,
      sourceUrl: null,
      sourceFileName: null,
      mimeType: mediaType === 'video' ? 'video/mp4' : 'image/png',
      sizeBytes: 123,
      width: mediaType === 'image' ? 800 : null,
      height: mediaType === 'image' ? 600 : null,
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
    lifecycle: { createdAt: 1, updatedAt: 1 },
    ...assetOverrides,
  };
};

const installElectronStorage = () => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      storage: {
        'storage:import-local-media': (args: StorageImportLocalMediaParams) => importLocalMediaMock(args),
        'storage:upsert-media-asset': (args: StorageUpsertMediaAssetParams) => upsertMediaAssetMock(args),
      },
    },
  });
};

const makeFile = (name: string, type: string): File => {
  const file = new File([new Uint8Array([1, 2, 3])], name, { type });
  Object.defineProperty(file, 'arrayBuffer', {
    configurable: true,
    value: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
  });
  return file;
};

function expectDefined<T>(value: T | null | undefined, message: string): T {
  expect(value, message).toBeDefined();
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

class MockImage {
  naturalWidth = 800;
  naturalHeight = 600;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

describe('importLocalFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('Image', MockImage);
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:local-media-import-test'),
    });
    installElectronStorage();
    getRuntimeProjectPathMock.mockReturnValue('/tmp/project');
    ensureImageThumbnailMock.mockResolvedValue(undefined);
    ensureVideoThumbnailMock.mockResolvedValue(undefined);
    useCanvasStore.setState((state) => {
      state.mediaAssets = {};
      state.nodeGraph = null;
    });
  });

  it('本地导入图片后提交 MediaAsset 到 store，并按 assetId 触发 thumbnail repair', async () => {
    const asset = makeAsset({
      id: 'asset-image-1',
      mediaType: 'image',
      url: 'local-media://image/imported.png',
    });
    importLocalMediaMock.mockResolvedValue({
      url: asset.original.url,
      fileName: 'imported.png',
      isNew: true,
      sizeBytes: 123,
    });
    upsertMediaAssetMock.mockResolvedValue({ assetId: asset.id, asset });

    const { importLocalFile } = await import('../localMediaImport');
    const result = await importLocalFile(makeFile('imported.png', 'image/png'));

    expect(result.assetId).toBe(asset.id);
    expect(result.asset).toBe(asset);
    expect(useCanvasStore.getState().mediaAssets[asset.id]).toMatchObject(asset);
    const upsertCall = expectDefined(upsertMediaAssetMock.mock.calls[0]?.[0], '应提交图片 MediaAsset');
    const expectedParams = {
      mediaType: 'image',
      url: asset.original.url,
      width: 800,
      height: 600,
    } satisfies Partial<MediaAssetUpsertParams>;
    expect(upsertCall.projectPath).toBe('/tmp/project');
    expect(upsertCall.params).toMatchObject(expectedParams);
    expect(ensureImageThumbnailMock).toHaveBeenCalledWith(expect.any(String), {
      assetId: asset.id,
      projectPath: '/tmp/project',
    });
    expect(ensureImageThumbnailMock.mock.calls[0]?.[1]).not.toHaveProperty('sourceUrl');
    expect(ensureVideoThumbnailMock).not.toHaveBeenCalled();
  });

  it('本地导入视频后提交 MediaAsset 到 store，并按 assetId 触发 video thumbnail repair', async () => {
    const asset = makeAsset({
      id: 'asset-video-1',
      mediaType: 'video',
      url: 'local-media://video/imported.mp4',
    });
    importLocalMediaMock.mockResolvedValue({
      url: asset.original.url,
      fileName: 'imported.mp4',
      isNew: true,
      sizeBytes: 456,
    });
    upsertMediaAssetMock.mockResolvedValue({ assetId: asset.id, asset });

    const { importLocalFile } = await import('../localMediaImport');
    const result = await importLocalFile(makeFile('imported.mp4', 'video/mp4'));

    expect(result.assetId).toBe(asset.id);
    expect(useCanvasStore.getState().mediaAssets[asset.id]).toMatchObject(asset);
    const upsertCall = expectDefined(upsertMediaAssetMock.mock.calls[0]?.[0], '应提交视频 MediaAsset');
    const expectedParams = {
      mediaType: 'video',
      url: asset.original.url,
    } satisfies Partial<MediaAssetUpsertParams>;
    expect(upsertCall.projectPath).toBe('/tmp/project');
    expect(upsertCall.params).toMatchObject(expectedParams);
    expect(ensureVideoThumbnailMock).toHaveBeenCalledWith(expect.any(String), {
      assetId: asset.id,
      projectPath: '/tmp/project',
    });
    expect(ensureVideoThumbnailMock.mock.calls[0]?.[1]).not.toHaveProperty('sourceUrl');
    expect(ensureImageThumbnailMock).not.toHaveBeenCalled();
  });
});
