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
import type { CanvasAnnotation } from '../../types';

describe('insertBundleIntoCanvas 注释写入链路', () => {
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

  it('bundle 含 annotations（含降级注释）时，逐条写入画布 store', async () => {
    const annotationFromBundle: CanvasAnnotation = {
      id: 'bundle-ann-1',
      content: '来自 bundle 的注释',
      position: { x: 10, y: 20 },
      size: { width: 240, height: 80 },
      binding: { type: 'free' },
      style: { color: '#fef3c7', fontSize: 14 },
    };

    importNodeGraphFromBundleMock.mockResolvedValue({
      valid: true,
      nodeGraph: {
        id: 'bundle-graph-1',
        name: 'bundle',
        nodes: [
          {
            id: 'text-1',
            type: 'textInput',
            position: { x: 0, y: 0 },
            data: { segments: [] },
            inputs: [],
            outputs: [],
          },
        ],
        edges: [],
        annotations: [annotationFromBundle],
        settings: {},
      },
      mediaAssets: {},
      warnings: [],
      errors: [],
    });
    getCurrentProjectPathMock.mockResolvedValue(undefined);
    buildClipboardPayloadFromNodeGraphSnippetMock.mockImplementation(({ nodeGraph }: { nodeGraph: { nodes: unknown[]; edges: unknown[] } }) => ({
      nodes: nodeGraph.nodes,
      edges: nodeGraph.edges,
      groups: [],
      annotations: [],
    }));

    const insertAnnotationsBatchCalls: Array<{ annotations: CanvasAnnotation[]; offset: unknown; saveHistory: boolean }> = [];
    useCanvasStore.setState({
      insertAnnotationsBatch: ((annotations: CanvasAnnotation[], options: { offset: unknown; saveHistory: boolean }) => {
        insertAnnotationsBatchCalls.push({ annotations, offset: options.offset, saveHistory: options.saveHistory });
        return annotations;
      }) as never,
    } as Partial<ReturnType<typeof useCanvasStore.getState>>);

    await insertBundleIntoCanvas({
      file: new File(['bundle'], 'bundle.zip', { type: 'application/zip' }),
      targetPosition: undefined,
      onProgress: undefined,
      signal: undefined,
    });

    expect(insertAnnotationsBatchCalls).toHaveLength(1);
    const firstCall = insertAnnotationsBatchCalls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) return;
    expect(firstCall.annotations).toHaveLength(1);
    const firstAnnotation = firstCall.annotations[0];
    expect(firstAnnotation?.content).toBe('来自 bundle 的注释');
    expect(firstAnnotation?.binding).toEqual({ type: 'free' });
  });

  it('bundle 只有降级注释（无合法节点）时，仍写入注释且不抛"导入内容为空"', async () => {
    importNodeGraphFromBundleMock.mockResolvedValue({
      valid: true,
      nodeGraph: {
        id: 'bundle-graph-2',
        name: 'only-annotations',
        nodes: [],
        edges: [],
        annotations: [
          {
            id: 'downgraded-ann',
            content: '降级得到的注释',
            position: { x: 0, y: 0 },
            size: { width: 240, height: 80 },
            binding: { type: 'free' },
            style: { color: '#fef3c7', fontSize: 14 },
          },
        ],
        settings: {},
      },
      mediaAssets: {},
      warnings: [],
      errors: [],
    });
    getCurrentProjectPathMock.mockResolvedValue(undefined);
    buildClipboardPayloadFromNodeGraphSnippetMock.mockImplementation(() => ({
      nodes: [],
      edges: [],
      groups: [],
      annotations: [],
    }));

    const insertAnnotationsBatchCalls: Array<{ annotations: CanvasAnnotation[] }> = [];
    useCanvasStore.setState({
      insertAnnotationsBatch: ((annotations: CanvasAnnotation[]) => {
        insertAnnotationsBatchCalls.push({ annotations });
        return annotations;
      }) as never,
      pasteClipboardPayload: (() =>
        cast<unknown>({ nodes: [], edges: [], nodeIds: [], edgeIds: [] })) as never,
    } as Partial<ReturnType<typeof useCanvasStore.getState>>);

    const result = await insertBundleIntoCanvas({
      file: new File(['bundle'], 'bundle.zip', { type: 'application/zip' }),
      targetPosition: undefined,
      onProgress: undefined,
      signal: undefined,
    });

    expect(result.insertedNodes).toEqual([]);
    expect(insertAnnotationsBatchCalls).toHaveLength(1);
    const firstCall = insertAnnotationsBatchCalls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) return;
    expect(firstCall.annotations).toHaveLength(1);
    expect(firstCall.annotations[0]?.content).toBe('降级得到的注释');
  });
});
