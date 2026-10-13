import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cast } from '@/lib/utils';

const {
  importNodeGraphFromBundleMock,
  buildClipboardPayloadFromNodeGraphSnippetMock,
  getCurrentProjectPathMock,
  importBundleRuntimeAssetsMock,
} = vi.hoisted(() => ({
  importNodeGraphFromBundleMock: vi.fn(),
  buildClipboardPayloadFromNodeGraphSnippetMock: vi.fn(),
  getCurrentProjectPathMock: vi.fn(),
  importBundleRuntimeAssetsMock: vi.fn(),
}));

vi.mock('../../export/importBundle', () => ({
  importNodeGraphFromBundle: importNodeGraphFromBundleMock,
}));

vi.mock('../snippetTransfer', () => ({
  buildClipboardPayloadFromNodeGraphSnippet: buildClipboardPayloadFromNodeGraphSnippetMock,
}));

vi.mock('../../storage', () => ({
  getCurrentProjectPath: getCurrentProjectPathMock,
  importBundleRuntimeAssets: importBundleRuntimeAssetsMock,
}));

import { useCanvasStore } from '../../store/canvasStore';
import { insertBundleIntoCanvas } from '../insertBundleIntoCanvas';

describe('insertBundleIntoCanvas runtime asset write', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    importNodeGraphFromBundleMock.mockReset();
    buildClipboardPayloadFromNodeGraphSnippetMock.mockReset();
    getCurrentProjectPathMock.mockReset();
    importBundleRuntimeAssetsMock.mockReset();

    useCanvasStore.setState((state) => {
      state.nodeGraph = null;
      state.mediaAssets = {};
    });
  });

  it('bundle 含媒体资产时先走 importBundleRuntimeAssets，再以 source=user-action 合并 runtime patch 并重写片段 assetId', async () => {
    importNodeGraphFromBundleMock.mockResolvedValue({
      valid: true,
      nodeGraph: {
        id: 'bundle-graph-1',
        name: 'bundle',
        nodes: [
          {
            id: 'model-1',
            type: 'model',
            position: { x: 0, y: 0 },
            data: {
              resultArea: {
                slots: [
                  {
                    id: 'item-1',
                    targetKey: 'result-area_model-1_item-1',
                    itemType: 'media',
                    assetId: 'bundle-asset-1',
                    createdAt: 1,
                    updatedAt: 1,
                  },
                ],
                collapsed: false,
                outputSlotIds: [],
                targetKeyId: 'model-1',
              },
            },
            inputs: [],
            outputs: [],
          },
        ],
        edges: [],
        settings: {},
      },
      mediaAssets: {
        'bundle-asset-1': {
          id: 'bundle-asset-1',
          mediaType: 'image',
          original: {
            url: '/files/bundle-asset-1.png',
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
          },
          lifecycle: {
            createdAt: 1,
            updatedAt: 1,
          },
        },
      },
      warnings: [],
      errors: [],
    });
    getCurrentProjectPathMock.mockResolvedValue('/tmp/demo.iartproj');
    importBundleRuntimeAssetsMock.mockResolvedValue({
      assetIdMap: {
        'bundle-asset-1': 'formal-asset-1',
      },
      mediaAssetsPatch: {
        'formal-asset-1': {
          id: 'formal-asset-1',
          mediaType: 'image',
          original: {
            url: '/files/formal-asset-1.png',
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
          },
          lifecycle: {
            createdAt: 1,
            updatedAt: 1,
          },
        },
      },
    });
    buildClipboardPayloadFromNodeGraphSnippetMock.mockImplementation(({ nodeGraph }: { nodeGraph: { nodes: unknown[]; edges: unknown[] } }) => ({
      nodes: nodeGraph.nodes,
      edges: nodeGraph.edges,
      groups: [],
      annotations: [],
    }));

    const state = useCanvasStore.getState();
    const setProjectMediaAssetsSpy = vi.spyOn(state, 'setProjectMediaAssets');
    const pasteClipboardPayloadSpy = vi
      .spyOn(state, 'pasteClipboardPayload')
      .mockReturnValue(cast<ReturnType<typeof state.pasteClipboardPayload>>({ nodes: [{ id: 'model-1' }], edges: [] }));

    const result = await insertBundleIntoCanvas({
      file: new File(['bundle'], 'bundle.zip', { type: 'application/zip' }),
      targetPosition: undefined,
      onProgress: undefined,
      signal: undefined,
    });

    const importRuntimeAssetsCall = cast<Array<[string, Record<string, { id?: string }>]>>(
      importBundleRuntimeAssetsMock.mock.calls,
    ).at(0);
    expect(importRuntimeAssetsCall?.[0]).toBe('/tmp/demo.iartproj');
    expect(importRuntimeAssetsCall?.[1]['bundle-asset-1']?.id).toBe('bundle-asset-1');
    const setProjectMediaAssetsCall = cast<Array<[Record<string, { id?: string }>, { source: string }]>>(
      setProjectMediaAssetsSpy.mock.calls,
    ).at(0);
    expect(setProjectMediaAssetsCall?.[0]['formal-asset-1']?.id).toBe('formal-asset-1');
    expect(setProjectMediaAssetsCall?.[1]).toEqual({ source: 'user-action' });
    const importOrder = importBundleRuntimeAssetsMock.mock.invocationCallOrder.at(0);
    const pasteOrder = pasteClipboardPayloadSpy.mock.invocationCallOrder.at(0);
    expect(typeof importOrder).toBe('number');
    expect(typeof pasteOrder).toBe('number');
    expect(importOrder).toBeLessThan(pasteOrder ?? 0);
    const snippetCall = cast<Array<[{ nodeGraph: { nodes: Array<{ data?: { resultArea?: { slots?: Array<{ assetId?: string }> } } }> } }]>>(
      buildClipboardPayloadFromNodeGraphSnippetMock.mock.calls,
    ).at(0);
    expect(snippetCall?.[0].nodeGraph.nodes.at(0)?.data?.resultArea?.slots?.at(0)?.assetId).toBe('formal-asset-1');
    expect(result.insertedNodes).toEqual([{ id: 'model-1' }]);
  });
});
