import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '../canvasStore';
import { createNodeGraph } from '../../types/nodeGraph';

import type { CanvasAnnotation, GraphNode } from '../../types';
import {
  createTextInputDataFixture,
  createTextInputNodeFixture,
} from '../../components/__tests__/fixtures/canvasTestBuilders';

const makeNode = (overrides: Partial<GraphNode> & { id: string }): GraphNode => ({
  ...createTextInputNodeFixture({ id: overrides.id, data: createTextInputDataFixture({ label: overrides.id }) }),
  ...overrides,
});

const makeAnnotation = (overrides: Partial<CanvasAnnotation> & { id: string }): CanvasAnnotation => {
  const { id, ...rest } = overrides;
  return {
    id,
    content: 'test-annotation',
    position: { x: 0, y: 0 },
    size: { width: 200, height: 60 },
    binding: { type: 'free' },
    style: { color: '#fef3c7', fontSize: 14 },
    ...rest,
  };
};

const createTestGraph = () =>
  createNodeGraph({
    name: 'delete-test',
    description: undefined,
    tags: undefined,
    category: undefined,
  });

const resetStore = () => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.mediaAssets = {};
    state.selectedNodeIds = [];
    state.selectedAnnotationIds = [];
    state.editingAnnotationId = null;
    state.pendingAnnotationBinding = null;
    state.history = [];
    state.historyIndex = -1;
    state.deferredHistoryBaseline = null;
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
    state.structureRevision = 0;
    state.taskRevision = 0;
    state.historyBatchActive = false;
  });
};

/** 断言 nodeGraph 不为 null 并返回，避免重复非空检查 */
const getGraph = () => {
  const graph = useCanvasStore.getState().nodeGraph;
  expect(graph).not.toBeNull();
  return graph as NonNullable<typeof graph>;
};

describe('canvasStore.deleteSelectedElements', () => {
  beforeEach(() => {
    resetStore();
  });

  it('无选中时调用无操作', () => {
    const graph = createTestGraph();
    graph.nodes = [makeNode({ id: 'a' })];
    graph.annotations = [makeAnnotation({ id: 'ann1' })];

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
      state.selectedNodeIds = [];
        state.selectedAnnotationIds = [];
      });

    const historyBefore = useCanvasStore.getState().history.length;

    useCanvasStore.getState().deleteSelectedElements();

    const g = getGraph();
    expect(g.nodes).toHaveLength(1);
    expect(g.annotations).toHaveLength(1);
    expect(useCanvasStore.getState().history).toHaveLength(historyBefore);
  });

  // @spec: CM-014
  it('只选中节点：删除节点 + 绑定注释级联删除，history 有 1 条新记录', () => {
    const graph = createTestGraph();
    graph.nodes = [
      makeNode({ id: 'a' }),
      makeNode({ id: 'b', position: { x: 100, y: 0 } }),
    ];
    graph.annotations = [
      makeAnnotation({ id: 'ann1', binding: { type: 'node', nodeId: 'a' } }),
      makeAnnotation({ id: 'ann2', binding: { type: 'node', nodeId: 'b' } }),
    ];
  
    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
      state.selectedNodeIds = ['a'];
        state.selectedAnnotationIds = [];
      });

    const historyBefore = useCanvasStore.getState().history.length;

    useCanvasStore.getState().deleteSelectedElements();

    const g = getGraph();
    expect(g.nodes.map((n) => n.id)).toEqual(['b']);
    // ann1 绑定 a，应被级联删除；ann2 绑定 b，应保留
    const anns = g.annotations;
    expect(anns !== undefined ? anns.map((a) => a.id) : []).toEqual(['ann2']);
    expect(useCanvasStore.getState().history).toHaveLength(historyBefore + 1);
  });

  it('只选中注释：删除注释，history 有 1 条新记录', () => {
    const graph = createTestGraph();
    graph.nodes = [makeNode({ id: 'a' })];
    graph.annotations = [
      makeAnnotation({ id: 'ann1' }),
      makeAnnotation({ id: 'ann2' }),
    ];
  
    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
      state.selectedNodeIds = [];
        state.selectedAnnotationIds = ['ann1'];
      });

    const historyBefore = useCanvasStore.getState().history.length;

    useCanvasStore.getState().deleteSelectedElements();

    const g = getGraph();
    expect(g.nodes).toHaveLength(1);
    const anns2 = g.annotations;
    expect(anns2 !== undefined ? anns2.map((a) => a.id) : []).toEqual(['ann2']);
    expect(useCanvasStore.getState().history).toHaveLength(historyBefore + 1);
  });

  it('同时选中节点和注释：删除节点 + 级联注释 + 独立注释，history 有 1 条新记录', () => {
    const graph = createTestGraph();
    graph.nodes = [
      makeNode({ id: 'a' }),
      makeNode({ id: 'b', position: { x: 100, y: 0 } }),
    ];
    graph.annotations = [
      makeAnnotation({ id: 'ann1', binding: { type: 'node', nodeId: 'a' } }),
      makeAnnotation({ id: 'ann2', binding: { type: 'free' } }),
    ];
  
    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
      state.selectedNodeIds = ['a'];
        state.selectedAnnotationIds = ['ann2'];
      });

    const historyBefore = useCanvasStore.getState().history.length;

    useCanvasStore.getState().deleteSelectedElements();

    const g = getGraph();
    // a 被删除
    expect(g.nodes.map((n) => n.id)).toEqual(['b']);
    // ann1 绑定 a 被级联删除，ann2 被选中删除
    expect(g.annotations).toHaveLength(0);
    expect(useCanvasStore.getState().history).toHaveLength(historyBefore + 1);
  });

  it('混合选中：选中节点+注释，一次 deleteSelectedElements 产生 1 条 history', () => {
    const graph = createTestGraph();
    graph.nodes = [
      makeNode({ id: 'a' }),
      makeNode({ id: 'b', position: { x: 100, y: 0 } }),
      makeNode({ id: 'c', position: { x: 200, y: 0 } }),
    ];
    graph.annotations = [
      makeAnnotation({ id: 'ann1', binding: { type: 'node', nodeId: 'a' } }),
      makeAnnotation({ id: 'ann2', binding: { type: 'free' } }),
    ];

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
      state.selectedNodeIds = ['a'];
      state.selectedAnnotationIds = ['ann2'];
    });

    const historyBefore = useCanvasStore.getState().history.length;

    useCanvasStore.getState().deleteSelectedElements();

    const g = getGraph();
    // a 被删除，b 和 c 保留
    expect(g.nodes.map((n) => n.id)).toEqual(['b', 'c']);
    // ann1 绑定 a 被级联删除，ann2 被选中删除
    expect(g.annotations).toHaveLength(0);
    // b 和 c 保留
    const nodeB = g.nodes.find((n) => n.id === 'b');
    const nodeC = g.nodes.find((n) => n.id === 'c');
    expect(nodeB).not.toBeUndefined();
    expect(nodeC).not.toBeUndefined();
    expect(useCanvasStore.getState().history).toHaveLength(historyBefore + 1);
  });

  it('undo 恢复：删除后 undo，所有元素恢复', () => {
    const graph = createTestGraph();
    graph.nodes = [
      makeNode({ id: 'a' }),
      makeNode({ id: 'b', position: { x: 100, y: 0 } }),
    ];
    graph.annotations = [makeAnnotation({ id: 'ann1' })];

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
      state.selectedNodeIds = ['a'];
      state.selectedAnnotationIds = ['ann1'];
    });

    // 先保存一个历史基线
    useCanvasStore.getState().saveToHistory();
    const historyBeforeDelete = useCanvasStore.getState().history.length;

    useCanvasStore.getState().deleteSelectedElements();

    // 确认删除生效
    const gAfterDelete = getGraph();
    expect(gAfterDelete.nodes.map((n) => n.id)).toEqual(['b']);
    expect(useCanvasStore.getState().history).toHaveLength(historyBeforeDelete + 1);

    // undo
    useCanvasStore.getState().undo();

    const gAfterUndo = getGraph();
    expect(gAfterUndo.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    const undoAnns = gAfterUndo.annotations;
    expect(undoAnns !== undefined ? undoAnns.map((a) => a.id) : []).toEqual(['ann1']);
  });

  it('historyBatchActive 不影响单独调用：直接调 removeNodes 仍产生独立 history', () => {
    const graph = createTestGraph();
    graph.nodes = [
      makeNode({ id: 'a' }),
      makeNode({ id: 'b', position: { x: 100, y: 0 } }),
    ];
    graph.annotations = [];
  
    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
      state.selectedNodeIds = [];
        state.selectedAnnotationIds = [];
      });

    // 先保存一个历史基线
    useCanvasStore.getState().saveToHistory();
    const historyBaseline = useCanvasStore.getState().history.length;

    // 直接调 removeNodes（不走 deleteSelectedElements），应独立产生 1 条 history
    useCanvasStore.getState().removeNodes(['a'], undefined);

    const g1 = getGraph();
    expect(useCanvasStore.getState().history).toHaveLength(historyBaseline + 1);
    expect(g1.nodes.map((n) => n.id)).toEqual(['b']);

    // 再调一次 removeNodes，应再产生 1 条 history
    useCanvasStore.getState().removeNodes(['b'], undefined);

    const g2 = getGraph();
    expect(useCanvasStore.getState().history).toHaveLength(historyBaseline + 2);
    expect(g2.nodes).toHaveLength(0);
  });
});
