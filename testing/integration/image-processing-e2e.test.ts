// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cjsImportAs, clearCjsCache, createCjsMock, resolveCjsPath } from './helpers/cjs-mock';

type ThumbnailState = {
  url: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  status: 'missing' | 'generating' | 'ready' | 'stale' | 'failed';
  generatedAt: number | null;
  error: unknown;
};

type TestMediaAsset = {
  id: string;
  mediaType: 'image' | 'video' | 'audio';
  original: {
    url: string;
    mimeType: string | null;
    sizeBytes: number | null;
    width: number | null;
    height: number | null;
    durationMs: number | null;
  };
  thumbnail: ThumbnailState;
  lifecycle: {
    createdAt: number;
    updatedAt: number;
  };
};

type MediaAssetRegistryModule = {
  repairProjectMediaAssetThumbnail: (
    projectPath: string,
    params: { assetId: string; mediaType: string },
  ) => Promise<{ assetId: string; asset: TestMediaAsset; result: unknown }>;
};

type MediaConstantsModule = {
  LOCAL_MEDIA_SCHEME: string;
  LOCAL_MEDIA_GLOBAL_REF: string;
  buildLocalMediaUrl: (projectRef: string | null | undefined, fileKey: string | null | undefined) => string | null;
};

type MediaFileKeyModule = {
  extractMediaFileKey: (sourceUrl: string) => string | null;
};

const cloneAsset = (asset: TestMediaAsset): TestMediaAsset => ({
  ...asset,
  original: { ...asset.original },
  thumbnail: { ...asset.thumbnail },
  lifecycle: { ...asset.lifecycle },
});

const createThumbnailError = (code: string, message = code, status = 500) => {
  const error = new Error(message) as Error & { code: string; status: number };
  error.code = code;
  error.status = status;
  return error;
};

const normalizeString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const normalizeDimension = (value: unknown): number | null => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const rounded = Math.round(numeric);
  return rounded > 0 ? rounded : null;
};

const normalizeFiniteNumber = <TFallback>(value: unknown, fallback: TFallback): number | TFallback => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return fallback;
};

const normalizeProjectMediaType = (value: unknown): 'image' | 'video' | 'audio' | null => {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'image' || normalized === 'video' || normalized === 'audio') return normalized;
  return null;
};

const VALID_PROJECT_REF = 'prj_0123456789abcdef0123456789abcdef';

describe('image processing e2e', () => {
  const cjs = createCjsMock();

  const clearBackendModule = (specifier: string) => {
    clearCjsCache(resolveCjsPath(specifier));
  };

  const loadRegistry = async (params: {
    currentAsset: TestMediaAsset;
    persistedAssets: TestMediaAsset[];
    executeImageThumbnail?: ReturnType<typeof vi.fn>;
  }) => {
    clearBackendModule('../../apps/backend/dist/local-server/media-asset-registry.cjs');
    cjs.replace('../../apps/backend/dist/local-server/runtime-media-assets.cjs', {
      createThumbnailError,
      normalizeDimension,
      normalizeFiniteNumber,
      normalizeProjectMediaType,
      normalizeString,
      parseRuntimeMediaAssetRowToMediaAsset: (row: unknown) => row,
      readAllRuntimeMediaAssets: vi.fn(async () => [cloneAsset(params.currentAsset)]),
      readRuntimeMediaAssetById: vi.fn(async () => cloneAsset(params.currentAsset)),
      persistRuntimeMediaAsset: vi.fn(async (_projectPath: string, asset: TestMediaAsset) => {
        params.currentAsset = cloneAsset(asset);
        params.persistedAssets.push(cloneAsset(asset));
        return true;
      }),
    });
    cjs.replace('../../apps/backend/dist/local-server/image-processing.cjs', {
      resolveFilesUrlToFilePathInProject: vi.fn(() => null),
      readProjectImageDimensions: vi.fn(() => null),
    });
    cjs.replace('../../apps/backend/dist/local-server/media-processing-actions.cjs', {
      executeImageThumbnail: params.executeImageThumbnail ?? vi.fn(async () => ({
        url: '/files/thumbnails/regenerated.webp',
        meta: {
          thumbnailWidth: 512,
          thumbnailHeight: 256,
        },
      })),
      executeVideoThumbnail: vi.fn(),
    });
    cjs.replace('../../apps/backend/dist/local-server/executable-path.cjs', {
      resolveExecutablePath: vi.fn(() => null),
    });
    cjs.replace('../../apps/backend/dist/local-server/logging.cjs', {
      logDebug: vi.fn(),
    });
    return cjsImportAs<MediaAssetRegistryModule>('../../apps/backend/dist/local-server/media-asset-registry.cjs');
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cjs.restore();
    vi.resetModules();
  });

  it('case 3: fileKey 含子路径时 buildLocalMediaUrl 和 extractMediaFileKey 保持一致', async () => {
    const mediaConstants = await cjsImportAs<MediaConstantsModule>('@iart/utils/media-constants');
    const mediaFileKey = await cjsImportAs<MediaFileKeyModule>('@iart/utils/media-file-key');

    const fileKey = 'processed/abc123.png';
    const url = mediaConstants.buildLocalMediaUrl(VALID_PROJECT_REF, fileKey);

    // 1. URL 格式正确
    expect(url).toBe(`local-media://${VALID_PROJECT_REF}/processed/abc123.png`);

    // 2. extractMediaFileKey 正确提取含子路径的 fileKey
    const extractedKey = mediaFileKey.extractMediaFileKey(url as string);
    expect(extractedKey).toBe('processed/abc123.png');

    // 3. fileKey 与 path.join 组合后指向正确的磁盘位置
    const projectPath = '/tmp/test-project.iartproj';
    const mediaDir = path.join(projectPath, 'media');
    const localFilePath = path.join(mediaDir, extractedKey as string);
    expect(localFilePath).toBe(path.join(projectPath, 'media', 'processed', 'abc123.png'));
  });

  it('case 4: 违规 URL（/project-media/ 路径）在 repair 时抛出 invalid_url_form 错误', async () => {
    const persistedAssets: TestMediaAsset[] = [];
    const currentAsset: TestMediaAsset = {
      id: 'asset-invalid-url',
      mediaType: 'image',
      original: {
        url: '/project-media/prj_x/foo.png',
        mimeType: 'image/png',
        sizeBytes: 128,
        width: null,
        height: null,
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
      lifecycle: { createdAt: 1, updatedAt: 1 },
    };
    const registry = await loadRegistry({ currentAsset, persistedAssets });

    let caughtError: unknown;
    try {
      await registry.repairProjectMediaAssetThumbnail('/tmp/demo.iartproj', {
        assetId: 'asset-invalid-url',
        mediaType: 'image',
      });
    } catch (error: unknown) {
      caughtError = error;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError).toBeInstanceOf(Error);
    const err = caughtError as Error & { code: string };
    expect(err.code).toBe('invalid_url_form');
  });

  it('case 5: URL 合规（local-media://）但磁盘文件缺失时抛出 file_not_found 错误', async () => {
    const persistedAssets: TestMediaAsset[] = [];
    const currentAsset: TestMediaAsset = {
      id: 'asset-missing-file',
      mediaType: 'image',
      original: {
        url: `local-media://${VALID_PROJECT_REF}/missing.png`,
        mimeType: 'image/png',
        sizeBytes: 128,
        width: null,
        height: null,
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
      lifecycle: { createdAt: 1, updatedAt: 1 },
    };
    const registry = await loadRegistry({ currentAsset, persistedAssets });

    // 使用不存在的项目路径，确保 fs.existsSync 返回 false
    let caughtError: unknown;
    try {
      await registry.repairProjectMediaAssetThumbnail('/tmp/nonexistent_test_project_xxx.iartproj', {
        assetId: 'asset-missing-file',
        mediaType: 'image',
      });
    } catch (error: unknown) {
      caughtError = error;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError).toBeInstanceOf(Error);
    const err = caughtError as Error & { code: string };
    expect(err.code).toBe('file_not_found');
  });

  it('case 1: image thumbnail repair 端到端（mock executeImageThumbnail）', async () => {
    // 创建临时项目目录和源图片文件，使 fs.existsSync 通过
    // repairProjectMediaAssetThumbnail 会检查 path.join(projectPath, 'media', fileKey)
    // 所以需要 projectPath.iartproj/media/source.png 存在
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'iart-e2e-test-'));
    const projectPath = path.join(tmpBase, 'test-project.iartproj');
    const mediaDir = path.join(projectPath, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    const sourceFilePath = path.join(mediaDir, 'source.png');
    // 写入最小 PNG 文件头（8 bytes PNG signature）
    fs.writeFileSync(sourceFilePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const thumbnailUrl = `local-media://${VALID_PROJECT_REF}/thumbnails/gen-thumb.webp`;
    const executeImageThumbnailMock = vi.fn(async () => ({
      url: thumbnailUrl,
      meta: {
        thumbnailWidth: 256,
        thumbnailHeight: 128,
      },
    }));

    const persistedAssets: TestMediaAsset[] = [];
    const currentAsset: TestMediaAsset = {
      id: 'asset-repair-e2e',
      mediaType: 'image',
      original: {
        url: `local-media://${VALID_PROJECT_REF}/source.png`,
        mimeType: 'image/png',
        sizeBytes: 128,
        width: null,
        height: null,
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
      lifecycle: { createdAt: 1, updatedAt: 1 },
    };
    const registry = await loadRegistry({
      currentAsset,
      persistedAssets,
      executeImageThumbnail: executeImageThumbnailMock,
    });

    const result = await registry.repairProjectMediaAssetThumbnail(projectPath, {
      assetId: 'asset-repair-e2e',
      mediaType: 'image',
    });

    // repair 成功
    expect(result.assetId).toBe('asset-repair-e2e');
    expect(result.asset.thumbnail.status).toBe('ready');
    expect(result.asset.thumbnail.url).toBe(thumbnailUrl);
    expect(result.asset.thumbnail.width).toBe(256);
    expect(result.asset.thumbnail.height).toBe(128);

    // verify executeImageThumbnail 被正确调用
    expect(executeImageThumbnailMock).toHaveBeenCalledTimes(1);
    expect(executeImageThumbnailMock).toHaveBeenCalledWith(
      expect.objectContaining({ sourceUrl: `local-media://${VALID_PROJECT_REF}/source.png` }),
    );

    // verify 状态转换链：missing -> generating -> ready
    const statusChain = persistedAssets.map((asset) => asset.thumbnail.status);
    expect(statusChain).toEqual(['generating', 'ready']);

    // 清理临时文件
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });
});
