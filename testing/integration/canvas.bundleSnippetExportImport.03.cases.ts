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

const _lintKeep = [JSZip, getGalleryItem, createMediaAssets, parseManifest, parseProject, makeManifestJson];
void _lintKeep;
type _LintKeepMediaAssetEntry = MediaAssetEntry;

describe('bundle snippet export/import insert', () => {

beforeEach(() => {
    resetStore();
    window.__IART_LOCAL_API_BASE__ = 'http://127.0.0.1:15911';
  });

  afterEach(() => {
    delete window.__IART_LOCAL_API_BASE__;
    vi.unstubAllGlobals();
  });

it('invalid bundle does not mutate current canvas', async () => {
    const targetGraph = createNodeGraph({ name: '' });
    targetGraph.nodes = [];
    targetGraph.groups = [];
    useCanvasStore.setState((state) => {
      state.nodeGraph = targetGraph;
    });
    useCanvasStore.getState().saveToHistory();

    const file = new File([new Blob(['not-a-zip'], { type: 'text/plain' })], 'bad.iarts', {
      type: 'text/plain',
    });

    await expect(insertBundleIntoCanvas({ file, targetPosition: { x: 0, y: 0 } })).rejects.toBeTruthy();
    expect(useCanvasStore.getState().nodeGraph?.nodes ?? []).toHaveLength(0);
  });

it('calls onProgress during bundle import', async () => {
    const snippet = createNodeGraph({ name: 'Progress' });
    const { blob } = await buildBundleExport(snippet, 'dev', { customFileName: 'progress-test' });
    const file = new File([blob], 'progress.iarts', { type: 'application/zip' });

    const onProgress = vi.fn();
    const imported = await importNodeGraphFromBundle(file, { onProgress });

    expect(imported.valid).toBe(true);
    expect(onProgress).toHaveBeenCalled();

    const events: unknown[] = onProgress.mock.calls.map(([event]: [unknown]) => event);
    expect(
      events.some((e) => isRecord(e) && (e['messageKey'] === 'bundle.import.zip' || e['stage'] === 'zip')),
    ).toBe(true);
  });

it('cancelling insert bundle prevents canvas mutation', async () => {
    const now = new Date().toISOString();
    const snippet: NodeGraph = {
      id: 'ng_snippet_cancel',
      name: 'Snippet',
      status: 'draft',
      nodes: [
        makeGalleryNode('gallery_1', [], { selected: false }),
      ],
      groups: [],
      meta: {
        version: '1.0.0',
        createdAt: now,
        updatedAt: now,
      },
    };

    const { blob } = await buildBundleExport(snippet, 'dev', { customFileName: 'cancel-test' });
    const file = new File([blob], 'cancel.iarts', { type: 'application/zip' });

    const targetGraph = createNodeGraph({ name: '' });
    targetGraph.nodes = [];
    targetGraph.groups = [];
    useCanvasStore.setState((state) => {
      state.nodeGraph = targetGraph;
    });
    useCanvasStore.getState().saveToHistory();

    const controller = new AbortController();
    controller.abort();

    await expect(
      insertBundleIntoCanvas({
        file,
        targetPosition: { x: 0, y: 0 },
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(useCanvasStore.getState().nodeGraph?.nodes ?? []).toHaveLength(0);
  });

it('OCP: import handler can emit progress without changing orchestrators', async () => {
    const progressCalled = vi.fn();

    registerBundleAssetHandler({
      id: 'test.bundle.progressHandler',
      import: async ({ projectDocument, onProgress }) => {
        onProgress?.({ stage: 'custom', messageKey: 'test.bundle.progress' });
        return projectDocument;
      },
    });

    const snippet = createNodeGraph({ name: 'OCP-progress' });
    const { blob } = await buildBundleExport(snippet, 'dev', { customFileName: 'ocp-progress-test' });
    const file = new File([blob], 'ocp-progress.iarts', { type: 'application/zip' });

    const imported = await importNodeGraphFromBundle(file, { onProgress: progressCalled });

    expect(imported.valid).toBe(true);
    expect(progressCalled).toHaveBeenCalled();
    expect(
      progressCalled.mock.calls.some(
        (call) => isRecord(call[0])
          && (call[0]['stage'] === 'custom' || call[0]['messageKey'] === 'test.bundle.progress')
      )
    ).toBe(true);
  });

it('OCP: registering a new handler affects pipeline without changing orchestrators', async () => {
    const exportCalled = vi.fn();
    const importCalled = vi.fn();

    registerBundleAssetHandler({
      id: 'test.bundle.customHandler',
      export: async ({ projectDocument }) => {
        exportCalled();
        return projectDocument;
      },
      import: async ({ projectDocument }) => {
        importCalled();
        return projectDocument;
      },
    });

    const snippet = createNodeGraph({ name: 'OCP' });
    const { blob } = await buildBundleExport(snippet, 'dev', { customFileName: 'ocp-test' });
    const file = new File([blob], 'ocp.iarts', { type: 'application/zip' });
    const imported = await importNodeGraphFromBundle(file);

    expect(imported.valid).toBe(true);
    expect(exportCalled).toHaveBeenCalled();
    expect(importCalled).toHaveBeenCalled();
  });

});
