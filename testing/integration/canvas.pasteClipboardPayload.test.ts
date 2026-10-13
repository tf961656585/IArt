import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { createNodeGraph } from '@/features/canvas/types/nodeGraph';
import type { ClipboardPayload } from '@/features/canvas/types';
import type { AssetNodeData, GraphNode, TextInputNodeData, TextInputSegment } from '@/features/canvas/types/node';

const makeAssetNode = (id: string, x: number, y: number): GraphNode<AssetNodeData> => ({
  id,
  type: 'asset',
  position: { x, y },
  data: { label: 'Asset', mediaType: 'image', assetId: 'asset_1', sourceBatchId: '', sourceTaskId: '', sourceModelId: '' },
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

const makeTextInputNode = (id: string, x: number, y: number): GraphNode<TextInputNodeData> => ({
  id,
  type: 'textInput',
  position: { x, y },
  data: {
    label: 'Text',
    segments: [
      { kind: 'upstream', edgeId: 'edge_old', enabled: true },
      { kind: 'local', id: 'local-1', enabled: true, text: 'Hello' },
    ],
    separator: 'comma',
    customSeparator: '',
  },
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

const getTextSegments = (node: GraphNode | undefined): TextInputSegment[] => {
  if (!node || node.type !== 'textInput') {
    throw new Error('Expected textInput node');
  }
  const data = node.data;
  if (!('segments' in data) || !Array.isArray(data.segments)) {
    throw new Error('Expected textInput segments');
  }
  return data.segments;
};

const resetStore = () => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.selectedNodeIds = [];
    state.selectedAnnotationIds = [];
    state.editingAnnotationId = null;
    state.pendingAnnotationBinding = null;
    state.isDragging = false;
    state.isConnecting = false;
    state.history = [];
    state.historyIndex = -1;
    state.hasUnsavedChanges = false;
    state.structureRevision = 0;
    state.positionRevision = 0;
    state.viewportRevision = 0;
    state.layoutRevision = 0;
    state.clipboardPayload = null;
  });
};

describe('canvasStore.pasteClipboardPayload', () => {
  beforeEach(() => {
    resetStore();
  });

  it('rewrites ids, rebuilds groups, fixes textInput segments, and supports undo', () => {
    const graph = createNodeGraph({ name: '测试画板' });
    graph.nodes = [];
    graph.groups = [];

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
    });

    // baseline history entry for undo
    useCanvasStore.getState().saveToHistory();

    const payload: ClipboardPayload = {
      copiedAt: 0,
      sourceNodeGraphId: 'ng_source',
      centerPosition: { x: 0, y: 0 },
      nodes: [
        makeAssetNode('n_source', 0, 0),
        makeTextInputNode('n_text', 100, 0),
      ],
      groups: [
        {
          originalId: 'g_old',
          name: 'Group',
          color: '#000',
          nodeIds: ['n_source', 'n_text'],
          autoLayoutSpacing: 'medium',
        },
      ],
    };

    const pasted = useCanvasStore.getState().pasteClipboardPayload(payload, { x: 100, y: 200 });
    expect(pasted.nodes).toHaveLength(2);
    expect(pasted.nodes.some((n) => n.id === 'n_source' || n.id === 'n_text')).toBe(false);

    const pastedText = pasted.nodes.find((n) => n.type === 'textInput');
    expect(pastedText).toBeTruthy();
    expect(pastedText?.position).toEqual({ x: 200, y: 200 });

    const pastedSource = pasted.nodes.find((n) => n.type === 'asset');
    expect(pastedSource).toBeTruthy();
    expect(pastedSource?.position).toEqual({ x: 100, y: 200 });

    const next = useCanvasStore.getState();
    expect(next.hasUnsavedChanges).toBe(true);
    expect(next.historyIndex).toBe(1);
    expect(next.history).toHaveLength(2);

    expect(next.nodeGraph?.nodes).toHaveLength(2);
    expect(next.selectedNodeIds).toEqual([]);

    // 旧拓扑 text-source 连线已退场（素材节点不持有输入端口）；粘贴时 textInput 的
    // upstream segment（旧连线的拓扑表达）被归一剥离，只剩 local 段。
    const segments = getTextSegments(pastedText);
    expect(segments.every((seg) => seg.kind === 'local')).toBe(true);
    expect(segments.find((seg) => seg.kind === 'upstream')).toBeUndefined();
    expect(JSON.stringify(pastedText?.data)).not.toContain('edge_old');

    useCanvasStore.getState().undo();
    const undone = useCanvasStore.getState();
    expect(undone.nodeGraph?.nodes).toHaveLength(0);
    expect(undone.nodeGraph?.groups).toHaveLength(0);
  });

  it('pasteNodes delegates to pasteClipboardPayload via clipboardPayload', () => {
    const graph = createNodeGraph({ name: '测试画板' });
    graph.nodes = [];
    graph.groups = [];

    const payload: ClipboardPayload = {
      copiedAt: 0,
      sourceNodeGraphId: 'ng_source',
      centerPosition: { x: 0, y: 0 },
      nodes: [
        makeAssetNode('n_source', 0, 0),
      ],
    };

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
      state.clipboardPayload = payload;
    });
    useCanvasStore.getState().saveToHistory();

    const pasted = useCanvasStore.getState().pasteNodes({ x: 10, y: 20 });
    expect(pasted.nodes).toHaveLength(1);
    const firstPasted = pasted.nodes[0];
    expect(firstPasted).toBeDefined();
    if (!firstPasted) {
      throw new Error('Expected pasted node');
    }
    expect(useCanvasStore.getState().selectedNodeIds).toEqual([]);
  });
});
