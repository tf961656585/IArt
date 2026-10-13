import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { buildBundleExport } from '@/features/canvas/export/exportBundle';
import { importNodeGraphFromBundle } from '@/features/canvas/export/importBundle';
import { registerBundleAssetHandler } from '@/features/canvas/export/bundleHandlers';
import { insertBundleIntoCanvas } from '@/features/canvas/services/insertBundleIntoCanvas';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { createNodeGraph } from '@/features/canvas/types/nodeGraph';
import type { NodeGraph, GraphNode } from '@/features/canvas/types';

// ─── Gallery test types ──────────────────────────────────────────
// Gallery node types are not in the GraphNodeData union, so test code
// uses dedicated interfaces instead of `any`.

interface GalleryItem {
  id: string;
  targetKey: string;
  itemType: string;
  assetId?: string;
  textValue: string | null;
  mediaType?: string;
  value?: string;
  createdAt: number;
  updatedAt: number;
}

interface GalleryNodeData {
  label: string;
  items: GalleryItem[];
  selectedItemIds: string[];
  collapsed: boolean;
}

interface MediaAssetOriginal {
  url: string;
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
}

interface MediaAssetThumbnail {
  url: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  status: string;
  generatedAt?: number | null;
}

interface MediaAssetEntry {
  id: string;
  mediaType: string;
  original: MediaAssetOriginal;
  thumbnail: MediaAssetThumbnail;
  lifecycle: { createdAt: number; updatedAt: number };
}

// Manifest mediaStats structure used in test bundle construction.
interface BundleMediaStats {
  totalCount: number;
  totalSizeBytes: number;
  deduplicatedSizeBytes: number;
}

// Helper to create a gallery node for test data.
// Gallery is not in GraphNodeData union; this function wraps the construction
// so callers don't need `as any`.
function makeGalleryNode(
  id: string,
  items: GalleryItem[],
  opts?: { selected?: boolean },
): GraphNode {
  const data: GalleryNodeData = {
    label: 'gallery',
    items,
    selectedItemIds: [],
    collapsed: false,
  };
  return {
    id,
    type: 'gallery',
    position: { x: 0, y: 0 },
    data: data as NodeGraph['nodes'][number]['data'],
    inputs: [],
    outputs: [],
    ...(opts?.selected !== undefined ? { selected: opts.selected } : {}),
  };
}

// Helper to access gallery data from an inserted GraphNode at runtime.
function getGalleryItems(node: GraphNode): GalleryItem[] {
  const data = node.data as Record<string, unknown>;
  return (data.items ?? []) as GalleryItem[];
}

function getGalleryItem(node: GraphNode, index: number): GalleryItem | undefined {
  return getGalleryItems(node)[index];
}

vi.mock('@/client/api/upload', () => ({
  uploadMediaBlob: vi.fn(async () => 'http://127.0.0.1:15911/files/new-file-key'),
  uploadImageFile: vi.fn(async () => 'http://127.0.0.1:15911/files/new-image.png'),
}));

vi.mock('@/client/utils/hubCanvasStartupConfig', () => ({
  getResolvedExpandInlineParamsOnStartup: vi.fn(async () => false),
  peekResolvedExpandInlineParamsOnStartup: vi.fn(() => false),
}));

const resetStore = () => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.selectedNodeIds = [];
    state.selectedEdgeIds = [];
    state.selectedAnnotationIds = [];
    state.editingAnnotationId = null;
    state.pendingAnnotationBinding = null;
    state.isDragging = false;
    state.isConnecting = false;
    state.connectionSnap = null;
    state.portQuickAddRequest = null;
    state.history = [];
    state.historyIndex = -1;
    state.hasUnsavedChanges = false;
    state.defaultEdgeType = 'bezier';
    state.structureRevision = 0;
    state.positionRevision = 0;
    state.viewportRevision = 0;
    state.layoutRevision = 0;
    state.clipboardPayload = null;
    state.mediaAssets = {};
  });
};

const createMediaAssets = (url: string, mediaType: 'image' | 'video' | 'audio' = 'image') => ({
  asset_gallery_1: {
    id: 'asset_gallery_1',
    mediaType,
    original: {
      url,
      mimeType: mediaType === 'video' ? 'video/mp4' : 'image/png',
      sizeBytes: 128,
      width: mediaType === 'video' ? null : 64,
      height: mediaType === 'video' ? null : 64,
      durationMs: mediaType === 'video' ? 1000 : null,
    },
    thumbnail: {
      url: null,
      mimeType: null,
      width: null,
      height: null,
      status: 'missing' as const,
      generatedAt: null,
    },
    lifecycle: {
      createdAt: 1,
      updatedAt: 1,
    },
  },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface ParsedManifest {
  filesManifest?: Record<string, { path?: string }>;
}

interface ParsedProject {
  mediaAssets?: {
    asset_gallery_1?: {
      original?: {
        url?: string;
      };
    };
  };
  nodeGraph?: {
    nodes?: Array<{
      data?: {
        items?: Array<{
          assetId?: string;
          value?: unknown;
        }>;
      };
    }>;
  };
}

const parseJsonRecord = (text: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(text);
  return isRecord(parsed) ? parsed : {};
};

const parseManifest = (text: string): ParsedManifest => parseJsonRecord(text) as ParsedManifest;
const parseProject = (text: string): ParsedProject => parseJsonRecord(text) as ParsedProject;

// Reusable manifest header for test bundles.
const makeManifestJson = (overrides?: { mediaStats?: BundleMediaStats }) =>
  JSON.stringify({
    format: 'iarts-bundle',
    version: 3,
    exportedAt: new Date().toISOString(),
    appVersion: 'test',
    compression: 'deflate',
    mediaManifest: {},
    mediaStats: overrides?.mediaStats ?? {
      totalCount: 0,
      totalSizeBytes: 0,
      deduplicatedSizeBytes: 0,
    },
  });

const _lintKeep = [buildBundleExport, registerBundleAssetHandler, insertBundleIntoCanvas, makeGalleryNode, getGalleryItem, createMediaAssets, parseManifest, parseProject];
void _lintKeep;

describe('bundle snippet export/import insert', () => {

beforeEach(() => {
    resetStore();
    window.__IART_LOCAL_API_BASE__ = 'http://127.0.0.1:15911';
  });

  afterEach(() => {
    delete window.__IART_LOCAL_API_BASE__;
    vi.unstubAllGlobals();
  });

it('rejects bundle when legacy nodeGraph.json is present alongside formal project.json', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', makeManifestJson());

    const formalGraph = createNodeGraph({ name: 'Formal Bundle' });
    formalGraph.id = 'ng_formal_bundle';
    formalGraph.nodes = [
      {
        id: 'gallery_1',
        type: 'gallery',
        position: { x: 0, y: 0 },
        data: {
          label: 'gallery',
          items: [
            {
              id: 'item-formal-1',
              targetKey: 'target-formal-1',
              itemType: 'media',
              assetId: 'asset_formal_1',
              textValue: null,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          selectedItemIds: [],
          collapsed: false,
        } satisfies GalleryNodeData,
        inputs: [],
        outputs: [],
      },
    ];
    formalGraph.groups = [];

    zip.file(
      'project.json',
      JSON.stringify({
        nodeGraph: formalGraph,
        mediaAssets: {
          asset_formal_1: {
            id: 'asset_formal_1',
            mediaType: 'image',
            original: {
              url: '/files/formal-only.png',
              mimeType: 'image/png',
              sizeBytes: 99,
              width: 64,
              height: 64,
              durationMs: null,
            },
            thumbnail: {
              url: null,
              mimeType: null,
              width: null,
              height: null,
              status: 'missing',
              generatedAt: null,
            },
            lifecycle: {
              createdAt: 1,
              updatedAt: 1,
            },
          },
        } as Record<string, MediaAssetEntry>,
      }),
    );
    zip.file('nodeGraph.json', JSON.stringify({ id: 'legacy-graph', nodes: [] }));

    const blob = await zip.generateAsync({ type: 'blob' });
    const file = new File([blob], 'formal-project-source.iarts', { type: 'application/zip' });

    const imported = await importNodeGraphFromBundle(file);
    expect(imported.valid).toBe(false);
    expect(imported.errors[0]).toContain('这个文件来自较旧版本，请用新版重新导出后再导入');
  });

it('bundle import 遇到非法 formal mediaAssets 记录时会直接失败，而不是静默过滤', async () => {
    const zip = new JSZip();
    zip.file(
      'manifest.json',
      makeManifestJson({
        mediaStats: {
          totalCount: 0,
          totalSizeBytes: 0,
          deduplicatedSizeBytes: 0,
        } satisfies BundleMediaStats,
      }),
    );
    zip.file(
      'project.json',
      JSON.stringify({
        nodeGraph: {
          id: 'ng_invalid_media_asset_import',
          name: 'Invalid Media Asset Import',
          nodes: [],
          groups: [],
        },
        mediaAssets: {
          asset_bad_1: {
            id: 'asset_bad_1',
            mediaType: 'image',
            original: {
              url: '',
              mimeType: 'image/png',
              sizeBytes: 1,
            },
          },
        } as Record<string, { id: string; mediaType: string; original: { url: string; mimeType: string; sizeBytes: number } }>,
      }),
    );

    const blob = await zip.generateAsync({ type: 'blob' });
    const file = new File([blob], 'invalid-media-asset-import.iarts', { type: 'application/zip' });

    const imported = await importNodeGraphFromBundle(file);
    expect(imported.valid).toBe(false);
    expect(imported.errors[0]).toContain('invalid-media-asset-record');
  });

it('bundle import 若 mediaAssets 顶层不是对象/数组，会直接失败而不是静默当成空表', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', makeManifestJson());
    zip.file(
      'project.json',
      JSON.stringify({
        nodeGraph: {
          id: 'ng_invalid_media_assets_root_import',
          name: 'Invalid Media Assets Root Import',
          nodes: [],
          groups: [],
        },
        mediaAssets: 'bad-root-media-assets',
      }),
    );

    const blob = await zip.generateAsync({ type: 'blob' });
    const file = new File([blob], 'invalid-media-assets-root-import.iarts', { type: 'application/zip' });

    const imported = await importNodeGraphFromBundle(file);
    expect(imported.valid).toBe(false);
    expect(imported.errors[0]).toContain('invalid-media-asset-record');
  });

it('bundle import 若缺失 mediaAssets 顶层字段，会直接失败而不是自动补 {}', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', makeManifestJson());
    zip.file(
      'project.json',
      JSON.stringify({
        nodeGraph: {
          id: 'ng_missing_media_assets_root_import',
          name: 'Missing Media Assets Root Import',
          nodes: [],
          groups: [],
        },
      }),
    );

    const blob = await zip.generateAsync({ type: 'blob' });
    const file = new File([blob], 'missing-media-assets-root-import.iarts', { type: 'application/zip' });

    const imported = await importNodeGraphFromBundle(file);
    expect(imported.valid).toBe(false);
    expect(imported.errors[0]).toContain('invalid-media-asset-record');
  });

});
