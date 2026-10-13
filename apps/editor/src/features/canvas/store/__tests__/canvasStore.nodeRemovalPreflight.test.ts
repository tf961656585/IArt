import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCanvasStore } from '../canvasStore';
import { createNodeGraph } from '../../types/nodeGraph';
import { useCanvasDeleteShortcuts } from '../../hooks/useCanvasDeleteShortcuts';
import { useCanvasContextMenuActions } from '../../components/canvas/useCanvasContextMenuActions';
import { useNodeCanvasChangeController } from '../../components/canvas/useNodeCanvasChangeController';
import {
  registerNodeRemovalPreflight,
  runNodeRemovalPreflight,
  unregisterNodeRemovalPreflight,
} from '../internal/nodeRemovalPreflight';
import type { CanvasAnnotation, GraphNode, GroupNodeData } from '../../types';import {
  createTextInputDataFixture,
  createTextInputNodeFixture,
} from '../../components/__tests__/fixtures/canvasTestBuilders';

/**
 * 删除咽喉前置钩子回归（spec docs/agent/02「删除 Agent 节点 → 先在途终止再删除」）。
 *
 * 覆盖要求：四条历史缺陷路径（键盘多选删除 / 右键菜单删除 / ReactFlow 删除 / 组连删成员）
 * 必须全部经过 `removeNodes` 咽喉；钩子在删除生效之前同步调用一次，入参与删除集一致；
 * 无注册者时删除行为与之前一致。
 *
 * 本文件用最小集成方式接线（不重写组件测试）：钩子只做「被调用 + 入参 + 调用时机」断言，
 * 真正的在途终止语义由 features/agent 侧用例覆盖。
 */

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

// 右键菜单动作 hook 依赖选择桥（其内部 useReactFlow 需要 ReactFlow provider）。
// 本用例只验证「菜单删除 → 删除咽喉」这一段，选择桥用最小替身挡掉。
vi.mock('../../components/canvas/useCanvasSelectionBridge', () => ({
  useCanvasSelectionBridge: () => ({
    selectAnnotations: vi.fn(),
    selectEntireCanvas: vi.fn(),
    selectNodes: vi.fn(),
  }),
}));

const createTestGraph = () =>
  createNodeGraph({
    name: 'node-removal-preflight-test',
    description: undefined,
    tags: undefined,
    category: undefined,
  });

const makeNode = (overrides: Partial<GraphNode> & { id: string }): GraphNode => ({
  ...createTextInputNodeFixture({ id: overrides.id, data: createTextInputDataFixture({ label: overrides.id }) }),
  ...overrides,
});

const makeGroupNode = (overrides: Partial<GraphNode> & { id: string }): GraphNode => ({
  ...makeNode(overrides),
  type: 'group',
  data: {
    name: overrides.id,
    collapsed: false,
    color: undefined,
  } as GroupNodeData,
});

const resetStore = () => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
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

/** 装载含指定节点的测试图（返回图对象，便于读取 id）。 */
const seedGraph = (nodes: GraphNode[], annotations: CanvasAnnotation[] = []) => {
  const graph = createTestGraph();
  graph.nodes = nodes;
  graph.annotations = annotations;
  useCanvasStore.setState((state) => {
    state.nodeGraph = graph;
  });
  return graph;
};

const graphNodeIds = (): string[] => useCanvasStore.getState().nodeGraph?.nodes.map((n) => n.id) ?? [];

/** 记录钩子入参的探针（同时记录调用顺序号，用于与删除生效时机对账）。 */
type PreflightProbe = {
  calls: string[][];
  nodeIdsPresentAtCall: boolean[];
};

const installProbe = (): PreflightProbe => {
  const probe: PreflightProbe = { calls: [], nodeIdsPresentAtCall: [] };
  registerNodeRemovalPreflight((nodeIds) => {
    probe.calls.push([...nodeIds]);
    const currentIds = new Set(graphNodeIds());
    probe.nodeIdsPresentAtCall.push(nodeIds.every((id) => currentIds.has(id)));
  });
  return probe;
};

beforeEach(() => {
  resetStore();
  unregisterNodeRemovalPreflight();
});

afterEach(() => {
  unregisterNodeRemovalPreflight();
});

describe('canvasStore 删除咽喉：前置钩子调用契约', () => {
  it('removeNodes 先调用钩子再删节点：调用一次、入参等于删除集、调用时节点仍在图上', () => {
    seedGraph([makeNode({ id: 'a' }), makeNode({ id: 'b' })]);
    const probe = installProbe();

    useCanvasStore.getState().removeNodes(['a'], undefined);

    expect(probe.calls).toEqual([['a']]);
    expect(probe.nodeIdsPresentAtCall).toEqual([true]);
    expect(graphNodeIds()).toEqual(['b']);
  });

  it('removeNode 委托咽喉：钩子只被调用一次（不重复触发）', () => {
    seedGraph([makeNode({ id: 'a' }), makeNode({ id: 'b' })]);
    const probe = installProbe();

    useCanvasStore.getState().removeNode('a', undefined);

    expect(probe.calls).toEqual([['a']]);
    expect(graphNodeIds()).toEqual(['b']);
  });

  it('组连删成员：请求集与展开新增的成员都进入钩子（成员会话同样先终止）', () => {
    seedGraph([
      makeGroupNode({ id: 'g1' }),
      makeNode({ id: 'm1', groupId: 'g1' }),
      makeNode({ id: 'm2', groupId: 'g1' }),
      makeNode({ id: 'outside' }),
    ]);
    const probe = installProbe();

    useCanvasStore.getState().removeNodes(['g1'], { deleteGroupMembers: true });

    // 先按请求集调用，再对展开新增的成员补调一次；两次都在图数据变更之前。
    expect(probe.calls).toEqual([['g1'], ['m1', 'm2']]);
    expect(probe.nodeIdsPresentAtCall).toEqual([true, true]);
    expect(graphNodeIds()).toEqual(['outside']);
  });

  it('组解散（删组不删成员）：钩子只收到组节点，成员不被连带删除', () => {
    seedGraph([
      makeGroupNode({ id: 'g1' }),
      makeNode({ id: 'm1', groupId: 'g1' }),
      makeNode({ id: 'm2', groupId: 'g1' }),
    ]);
    const probe = installProbe();

    useCanvasStore.getState().removeNodes(['g1'], undefined);

    expect(probe.calls).toEqual([['g1']]);
    expect(probe.nodeIdsPresentAtCall).toEqual([true]);
    expect(graphNodeIds()).toEqual(['m1', 'm2']);
  });

  it('无注册者时删除行为与之前一致（不阻断、不改删除结果）', () => {
    seedGraph([makeNode({ id: 'a' }), makeNode({ id: 'b' })]);
    useCanvasStore.getState().saveToHistory();
    const historyBefore = useCanvasStore.getState().history.length;

    expect(runNodeRemovalPreflight(['a'])).toBe(false);
    useCanvasStore.getState().removeNodes(['a'], undefined);

    expect(graphNodeIds()).toEqual(['b']);
    expect(useCanvasStore.getState().history).toHaveLength(historyBefore + 1);
  });
});

describe('canvasStore 删除咽喉：四条既有删除路径都经过咽喉', () => {
  it('键盘多选删除（useCanvasDeleteShortcuts → deleteSelectedElements）经过咽喉', () => {
    seedGraph([makeNode({ id: 'a' }), makeNode({ id: 'b' }), makeNode({ id: 'c' })]);
    useCanvasStore.setState((state) => {
      state.selectedNodeIds = ['a', 'b'];
    });
    const probe = installProbe();

    const { unmount } = renderHook(() => useCanvasDeleteShortcuts(true));
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }),
      );
    });

    expect(probe.calls).toEqual([['a', 'b']]);
    expect(graphNodeIds()).toEqual(['c']);
    unmount();
  });

  it('右键菜单「删除节点」（useCanvasContextMenuActions.handleDeleteNodes）经过咽喉', () => {
    seedGraph([makeNode({ id: 'a' }), makeNode({ id: 'b' })]);
    const probe = installProbe();

    const { result, unmount } = renderHook(() =>
      useCanvasContextMenuActions({
        target: { type: 'node', nodeId: 'a', position: { x: 0, y: 0 } },
        onRequestBundleExport: undefined,
        onRequestBundleImportInsert: undefined,
        isBundleImportRunning: undefined,
        measuredSizeByNodeId: undefined,
        derivedSizeByNodeId: undefined,
        onClose: () => {},
      }),
    );
    act(() => {
      result.current.handleDeleteNodes();
    });

    expect(probe.calls).toEqual([['a']]);
    expect(graphNodeIds()).toEqual(['b']);
    unmount();
  });

  it('ReactFlow 删除变更（onNodesChange remove → removeNodes）经过咽喉', async () => {
    const graph = seedGraph([makeNode({ id: 'a' }), makeNode({ id: 'b' })]);
    const probe = installProbe();

    const { result } = renderHook(() =>
      useNodeCanvasChangeController({
        nodeGraphId: graph.id,
        flowInteractiveRef: { current: true },
        transientDimensionsRef: { current: {} },
        setTransientDimensions: vi.fn(),
        clearTransientDimensionsForNodeIds: vi.fn(),
        cancelTransientDimensionCleanup: vi.fn(),
        scheduleTransientDimensionCleanup: vi.fn(),
        applyRenderPositionUpdates: vi.fn(),
        beginRenderDragSession: vi.fn(),
        endRenderDragSession: vi.fn(),
        removeRenderNodes: vi.fn(),
        updateNodePositionsBatch: useCanvasStore.getState().updateNodePositionsBatch,
        removeNodes: useCanvasStore.getState().removeNodes,
        addNodesToGroup: useCanvasStore.getState().addNodesToGroup,
        removeNodesFromGroup: useCanvasStore.getState().removeNodesFromGroup,
        moveNodesBetweenGroups: useCanvasStore.getState().moveNodesBetweenGroups,
        nodeGraphNodes: graph.nodes,
        zoom: 1,
      }),
    );

    act(() => {
      result.current.onNodesChange([{ id: 'a', type: 'remove' }]);
    });

    await vi.waitFor(() => {
      expect(probe.calls).toEqual([['a']]);
    });
    expect(graphNodeIds()).toEqual(['b']);
  });
});
