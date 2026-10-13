import { beforeEach, describe, expect, it } from 'vitest';

import { createNodeGraph } from '../../types/nodeGraph';
import {
  createTestNodeGraphParams,
  createTextInputDataFixture,
  createTextInputNodeFixture,
} from '../../components/__tests__/fixtures/canvasTestBuilders';
import {
  buildProjectDelta,
  markFullGraphDirty,
  markViewportDirty,
  useCanvasStore,
} from '../canvasStore';

const resetStore = () => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.mediaAssets = {};
    state.hasUnsavedChanges = false;
    state.dirtyRevision = 0;
    state.dirty = {
      graph: false,
      viewport: false,
      fullReplace: false,
      mediaAssets: false,
      nodes: {},
      removedNodes: {},
    };
  });
};

describe('canvasStore dirty / delta', () => {
  beforeEach(() => {
    resetStore();
  });

  it('无 dirty 时 buildProjectDelta 返回 null，但保留 expectedDirtyRevision', () => {
    const graph = createNodeGraph(createTestNodeGraphParams('delta-clean'));
    const result = buildProjectDelta({
      nodeGraph: graph,
      mediaAssets: {},
      dirtyRevision: 3,
      dirty: {
        graph: false,
        viewport: false,
        fullReplace: false,
        mediaAssets: false,
        nodes: {},
        removedNodes: {},
      },
    }, undefined);

    expect(result).toEqual({
      delta: null,
      expectedDirtyRevision: 3,
    });
  });

  it('forceFullReplace 会输出 fullReplace graph 与全部节点', () => {
    const graph = createNodeGraph(createTestNodeGraphParams('delta-full'));
    graph.id = 'graph-full';
    graph.nodes = [
      createTextInputNodeFixture({
        id: 'node-1',
        position: { x: 0, y: 0 },
        data: createTextInputDataFixture({
          label: '文本',
          segments: [{ kind: 'local', id: 'local-1', enabled: true, text: 'hello' }],
          separator: 'comma',
          customSeparator: '',
        }),
      }),
    ];

    const result = buildProjectDelta(
      {
        nodeGraph: graph,
        mediaAssets: {},
        dirtyRevision: 1,
        dirty: {
          graph: false,
          viewport: false,
          fullReplace: false,
          mediaAssets: false,
          nodes: {},
          removedNodes: {},
        },
      },
      { forceFullReplace: true }
    );

    expect(result.delta?.fullReplace).toBe(true);
    expect(result.delta?.graph?.id).toBe('graph-full');
    expect(result.delta?.nodes?.upsert).toHaveLength(1);
  });

  it('增量 dirty 会只输出被标脏的节点', () => {
    const graph = createNodeGraph(createTestNodeGraphParams('delta-incremental'));
    graph.id = 'graph-incremental';
    graph.nodes = [
      createTextInputNodeFixture({
        id: 'node-1',
        position: { x: 0, y: 0 },
        data: createTextInputDataFixture({
          label: '文本',
          segments: [{ kind: 'local', id: 'local-1', enabled: true, text: 'hello' }],
          separator: 'comma',
          customSeparator: '',
        }),
      }),
      createTextInputNodeFixture({
        id: 'node-2',
        position: { x: 10, y: 0 },
        data: createTextInputDataFixture({
          label: '文本2',
          segments: [{ kind: 'local', id: 'local-1', enabled: true, text: 'world' }],
          separator: 'comma',
          customSeparator: '',
        }),
      }),
    ];

    const dirty = {
      graph: false,
      viewport: false,
      fullReplace: false,
      mediaAssets: false,
      nodes: { 'node-2': true as const },
      removedNodes: {},
    };

    const result = buildProjectDelta({
      nodeGraph: graph,
      mediaAssets: {},
      dirtyRevision: 5,
      dirty,
    }, undefined);

    expect(result.delta?.graph?.id).toBe('graph-incremental');
    expect(result.delta?.nodes?.upsert?.map((node) => node.id)).toEqual(['node-2']);
  });

  it('markAsSaved(expectedDirtyRevision) 不会误吞并发后的新修改', () => {
    const graph = createNodeGraph(createTestNodeGraphParams('mark-as-saved'));
    graph.nodes = [];

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
    });

    useCanvasStore.setState((state) => {
      markFullGraphDirty(state);
    });
    const firstRevision = useCanvasStore.getState().dirtyRevision;

    useCanvasStore.setState((state) => {
      markViewportDirty(state);
    });
    const secondRevision = useCanvasStore.getState().dirtyRevision;

    useCanvasStore.getState().markAsSaved(firstRevision);
    expect(useCanvasStore.getState().dirtyRevision).toBe(secondRevision);
    expect(useCanvasStore.getState().dirty.graph).toBe(true);

    useCanvasStore.getState().markAsSaved(secondRevision);
    expect(useCanvasStore.getState().dirtyRevision).toBe(0);
    expect(useCanvasStore.getState().hasUnsavedChanges).toBe(false);
  });
});
