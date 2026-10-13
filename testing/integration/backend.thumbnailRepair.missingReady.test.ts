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
    mimeType?: string | null;
    sizeBytes?: number | null;
    width?: number | null;
    height?: number | null;
    durationMs?: number | null;
  };
  thumbnail: ThumbnailState;
  lifecycle: {
    createdAt: number;
    updatedAt: number;
  };
};

type MediaAssetRegistryModule = {
  repairProjectMediaAssetThumbnail: (
    projectPath: unknown,
    params: { assetId?: unknown; mediaType?: unknown },
  ) => Promise<{ assetId: string; asset: TestMediaAsset; result: unknown }>;
  reconcileProjectThumbnails: (projectPath: string) => Promise<{ projectPath: string; downgradedAssetIds: string[] }>;
};

const cloneAsset = (asset: TestMediaAsset): TestMediaAsset => ({
  ...asset,
  original: { ...asset.original },
  thumbnail: { ...asset.thumbnail },
  lifecycle: { ...asset.lifecycle },
});

const normalizeString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const normalizeFiniteNumber = <TFallback,>(value: unknown, fallback: TFallback): number | TFallback => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return fallback;
};

const normalizeDimension = (value: unknown) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const rounded = Math.round(numeric);
  return rounded > 0 ? rounded : null;
};

const normalizeProjectMediaType = (value: unknown): 'image' | 'video' | 'audio' | null => {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'image' || normalized === 'video' || normalized === 'audio') return normalized;
  return null;
};

const createThumbnailError = (code: string, message = code, status = 500) => {
  const error = new Error(message) as Error & { code?: string; status?: number };
  error.code = code;
  error.status = status;
  return error;
};

describe('backend thumbnail repair for missing ready file', () => {
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

  it('ready 但缩略图文件缺失时会先回退到 stale，再进入 repair 主链', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iarts-thumb-repair-'));
    fs.mkdirSync(path.join(projectRoot, 'media'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'media', 'original.png'), Buffer.from('fake-image'), 'utf-8');
    try {
      const projectRef = 'prj_0123456789abcdef0123456789abcdef';
      const persistedAssets: TestMediaAsset[] = [];
      const currentAsset: TestMediaAsset = {
        id: 'asset-ready-missing',
        mediaType: 'image',
        original: {
          url: `local-media://${projectRef}/original.png`,
          mimeType: 'image/png',
          sizeBytes: 128,
          width: null,
          height: null,
          durationMs: null,
        },
        thumbnail: {
          url: `local-media://${projectRef}/thumbnails/missing.webp`,
          mimeType: 'image/webp',
          width: 256,
          height: 128,
          status: 'ready',
          generatedAt: 1,
          error: null,
        },
        lifecycle: { createdAt: 1, updatedAt: 1 },
      };
      const registry = await loadRegistry({
        currentAsset,
        persistedAssets,
        executeImageThumbnail: vi.fn(async () => ({
          url: `local-media://${projectRef}/thumbnails/regenerated.webp`,
          meta: {
            thumbnailWidth: 512,
            thumbnailHeight: 256,
          },
        })),
      });

      const result = await registry.repairProjectMediaAssetThumbnail(projectRoot, {
        assetId: 'asset-ready-missing',
        mediaType: 'image',
      });

      expect(persistedAssets.map((asset) => asset.thumbnail.status)).toEqual([
        'stale',
        'generating',
        'ready',
      ]);
      expect(persistedAssets[0]?.thumbnail).toMatchObject({
        status: 'stale',
        url: `local-media://${projectRef}/thumbnails/missing.webp`,
      });
      expect(persistedAssets[1]?.thumbnail).toMatchObject({
        status: 'generating',
        url: `local-media://${projectRef}/thumbnails/missing.webp`,
      });
      expect(persistedAssets[2]?.thumbnail).toMatchObject({
        status: 'ready',
        url: `local-media://${projectRef}/thumbnails/regenerated.webp`,
        width: 512,
        height: 256,
      });
      expect(result.asset.thumbnail).toMatchObject({
        status: 'ready',
        url: `local-media://${projectRef}/thumbnails/regenerated.webp`,
        width: 512,
        height: 256,
      });
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('generating 超时资产会在 reconcile 中回收为 stale', async () => {
    const persistedAssets: TestMediaAsset[] = [];
    const currentAsset: TestMediaAsset = {
      id: 'asset-generating-stale',
      mediaType: 'image',
      original: {
        url: '/files/original.png',
        mimeType: 'image/png',
        sizeBytes: 128,
      },
      thumbnail: {
        url: '/files/thumbnails/pending.webp',
        mimeType: 'image/webp',
        width: null,
        height: null,
        status: 'generating',
        generatedAt: null,
        error: null,
      },
      lifecycle: {
        createdAt: 1,
        updatedAt: Date.now() - 20 * 60 * 1000,
      },
    };
    const registry = await loadRegistry({ currentAsset, persistedAssets });

    const result = await registry.reconcileProjectThumbnails('/tmp/demo.iartproj');

    expect(result.downgradedAssetIds).toEqual(['asset-generating-stale']);
    expect(persistedAssets).toHaveLength(1);
    expect(persistedAssets[0]?.thumbnail).toMatchObject({
      status: 'stale',
      url: '/files/thumbnails/pending.webp',
    });
  });
});
