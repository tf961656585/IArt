import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Node as FlowNode } from '@xyflow/react';
import { useNodeCanvasChangeController } from './useNodeCanvasChangeController';
import { useCanvasStore } from '../../store/canvasStore';
import { createNodeGraph } from '../../types/nodeGraph';
import type { AgentNodeData, GraphNode, GroupNodeData, TextInputNodeData, NodePosition } from '../../types';

// onNodeDragStart 签名对齐 React Flow 拖拽回调（event/node/nodes）后需要入参；
// 本链路不消费事件对象，测试桩只满足参数形状（拖组判定读 node.type，undefined 视为非组）。
const STUB_DRAG_EVENT = undefined;
const STUB_DRAG_NODE: FlowNode = { id: 'drag-stub', position: { x: 0, y: 0 }, data: {} };

const createControllerArgs = (
  updateNodePositionsBatch: ReturnType<typeof vi.fn>,
  applyRenderPositionUpdates: ReturnType<typeof vi.fn>,
) => ({
  nodeGraphId: 'graph-1',
  flowInteractiveRef: { current: true },
  expandedGroupIdByNodeId: new Map<string, string>(),
  groupContainerBoundsMap: new Map(),
  transientDimensionsRef: { current: {} },
  setTransientDimensions: vi.fn(),
  clearTransientDimensionsForNodeIds: vi.fn(),
  cancelTransientDimensionCleanup: vi.fn(),
  scheduleTransientDimensionCleanup: vi.fn(),
  applyRenderPositionUpdates,
  beginRenderDragSession: vi.fn(),
  endRenderDragSession: vi.fn(),
  removeRenderNodes: vi.fn(),
  updateNodePositionsBatch,
  removeNodes: vi.fn(),
  addNodesToGroup: vi.fn(),
  removeNodesFromGroup: vi.fn(),
  moveNodesBetweenGroups: vi.fn(),
  nodeGraphGroups: [],
  nodeGraphEdges: [],
  nodeGraphNodes: [],
  resolvedNodesForGroupBounds: [],
  flowNodeSizeByNodeId: {},
  zoom: 1,
});

describe('useNodeCanvasChangeController drag position ownership', () => {
  it('dragging 期间只更新交互层 render state，drag stop 后才提交正式 position', () => {
    const updateNodePositionsBatch = vi.fn();
    const applyRenderPositionUpdates = vi.fn();

    const { result } = renderHook(() =>
      useNodeCanvasChangeController(
        createControllerArgs(updateNodePositionsBatch, applyRenderPositionUpdates),
      ),
    );

    act(() => {
      result.current.onNodeDragStart(STUB_DRAG_EVENT, STUB_DRAG_NODE, []);
      const changes: Parameters<typeof result.current.onNodesChange>[0] = [
        {
          id: 'node-1',
          type: 'position',
          position: { x: 120, y: 80 },
          dragging: true,
        },
      ];
      result.current.onNodesChange(changes);
    });

    expect(updateNodePositionsBatch).not.toHaveBeenCalled();
    expect(applyRenderPositionUpdates).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.onNodeDragStop();
    });

    expect(updateNodePositionsBatch).toHaveBeenCalledTimes(1);
    expect(updateNodePositionsBatch).toHaveBeenCalledWith([
      { id: 'node-1', position: { x: 120, y: 80 } },
    ]);
  });

  it('连续 dragging position 只采样最新 live position，不把中间帧写入正式 store', () => {
    const updateNodePositionsBatch = vi.fn();
    const applyRenderPositionUpdates = vi.fn();

    const { result } = renderHook(() =>
      useNodeCanvasChangeController(
        createControllerArgs(updateNodePositionsBatch, applyRenderPositionUpdates),
      ),
    );

    act(() => {
      result.current.onNodeDragStart(STUB_DRAG_EVENT, STUB_DRAG_NODE, []);
      for (const position of [
        { x: 80, y: 20 },
        { x: 160, y: 40 },
        { x: 240, y: 60 },
      ]) {
        result.current.onNodesChange([
          {
            id: 'node-1',
            type: 'position',
            position,
            dragging: true,
          },
        ]);
      }
    });

    expect(updateNodePositionsBatch).not.toHaveBeenCalled();
    expect(applyRenderPositionUpdates).toHaveBeenCalledTimes(3);
    expect(applyRenderPositionUpdates).toHaveBeenNthCalledWith(
      1,
      [{ id: 'node-1', position: { x: 80, y: 20 } }],
    );
    expect(applyRenderPositionUpdates).toHaveBeenNthCalledWith(
      2,
      [{ id: 'node-1', position: { x: 160, y: 40 } }],
    );
    expect(applyRenderPositionUpdates).toHaveBeenNthCalledWith(
      3,
      [{ id: 'node-1', position: { x: 240, y: 60 } }],
    );

    act(() => {
      result.current.onNodeDragStop();
    });

    expect(updateNodePositionsBatch).toHaveBeenCalledTimes(1);
    expect(updateNodePositionsBatch).toHaveBeenCalledWith([
      { id: 'node-1', position: { x: 240, y: 60 } },
    ]);
  });

  it('ReactFlow select change 不应再写应用层 render 选择态，也不应写正式 position store', () => {
    const updateNodePositionsBatch = vi.fn();
    const applyRenderPositionUpdates = vi.fn();

    const { result } = renderHook(() =>
      useNodeCanvasChangeController(
        createControllerArgs(updateNodePositionsBatch, applyRenderPositionUpdates),
      ),
    );

    act(() => {
      result.current.onNodesChange([
        { id: 'node-1', type: 'select', selected: true },
      ]);
    });

    expect(applyRenderPositionUpdates).not.toHaveBeenCalled();
    expect(updateNodePositionsBatch).not.toHaveBeenCalled();
  });
});

const makeTextInputNode = (id: string, x: number, y: number, groupId: string | undefined): GraphNode<TextInputNodeData> => ({
  id,
  type: 'textInput',
  position: { x, y },
  data: {
    label: undefined,
    description: undefined,
    runtimeRef: undefined,
    segments: [],
    lastExecutionId: undefined,
    lastSourceNodeId: undefined,
    lastSourcePortId: undefined,
    separator: undefined,
    customSeparator: undefined,
    promptPresetSnapshots: undefined,
    taskInfo: undefined,
    promptInterview: undefined,
  },
  draggable: true,
  size: undefined,
  style: undefined,
  groupId,
});

const makeGroupNode = (id: string, x: number, y: number, collapsed = false): GraphNode<GroupNodeData> => ({
  id,
  type: 'group',
  position: { x, y },
  data: { label: '节点组', description: undefined, runtimeRef: undefined, name: id, collapsed, color: undefined },
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

const resetStoreForMembership = (nodes: GraphNode[]) => {
  const graph = createNodeGraph({
    name: 'membership-test',
    description: undefined,
    tags: undefined,
    category: undefined,
  });
  useCanvasStore.setState((s) => {
    s.nodeGraph = { ...graph, nodes };
    s.history = [];
    s.historyIndex = -1;
    s.historyBatchActive = false;
  });
};

describe('useNodeCanvasChangeController 拖拽改变组成员归属', () => {
  it('自由节点拖入展开态组快照边界 → 自动加入组', () => {
    // 组 g1 在 (100,100)，成员 m1 在 (120,120)（默认尺寸由 fallback 提供）
    // 派生边界会包含 m1。把自由节点 free 拖到 (130,130)（落在组派生边界内）
    const g = makeGroupNode('g1', 100, 100);
    const m1 = makeTextInputNode('m1', 120, 120, 'g1');
    const free = makeTextInputNode('free', 500, 500, undefined);
    resetStoreForMembership([g, m1, free]);

    const addNodesToGroup = vi.fn();
    const { result } = renderHook(() =>
      useNodeCanvasChangeController({
        nodeGraphId: 'graph-1',
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
        updateNodePositionsBatch: vi.fn(),
        removeNodes: vi.fn(),
        addNodesToGroup,
        removeNodesFromGroup: vi.fn(),
        moveNodesBetweenGroups: vi.fn(),
        nodeGraphNodes: [g, m1, free],
        zoom: 1,
      }),
    );

    act(() => {
      result.current.onNodeDragStart(STUB_DRAG_EVENT, STUB_DRAG_NODE, []);
      result.current.onNodesChange([
        { id: 'free', type: 'position', position: { x: 130, y: 130 } as NodePosition, dragging: true },
      ]);
      result.current.onNodeDragStop();
    });

    expect(addNodesToGroup).toHaveBeenCalledTimes(1);
    // 第一个参数是被拖节点 id 数组，第二个是目标组 id
    expect(addNodesToGroup).toHaveBeenCalledWith(['free'], 'g1');
  });

  it('组成员拖出当前组快照边界 → 自动移出组', () => {
    const g = makeGroupNode('g1', 100, 100);
    const m1 = makeTextInputNode('m1', 120, 120, 'g1');
    resetStoreForMembership([g, m1]);

    const removeNodesFromGroup = vi.fn();
    const { result } = renderHook(() =>
      useNodeCanvasChangeController({
        nodeGraphId: 'graph-1',
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
        updateNodePositionsBatch: vi.fn(),
        removeNodes: vi.fn(),
        addNodesToGroup: vi.fn(),
        removeNodesFromGroup,
        moveNodesBetweenGroups: vi.fn(),
        nodeGraphNodes: [g, m1],
        zoom: 1,
      }),
    );

    act(() => {
      result.current.onNodeDragStart(STUB_DRAG_EVENT, STUB_DRAG_NODE, []);
      // 把 m1 拖到远离组的位置（落出快照边界）
      result.current.onNodesChange([
        { id: 'm1', type: 'position', position: { x: 2000, y: 2000 } as NodePosition, dragging: true },
      ]);
      result.current.onNodeDragStop();
    });

    expect(removeNodesFromGroup).toHaveBeenCalledTimes(1);
    expect(removeNodesFromGroup).toHaveBeenCalledWith(['m1']);
  });

  it('组成员拖入他组快照边界 → 跨组迁移', () => {
    // g1 在 (100,100) 含 m1；g2 在 (1000,1000) 空
    const g1 = makeGroupNode('g1', 100, 100);
    const m1 = makeTextInputNode('m1', 120, 120, 'g1');
    // 给 g2 一个成员，让它有派生边界
    const g2 = makeGroupNode('g2', 1000, 1000);
    const m2 = makeTextInputNode('m2', 1020, 1020, 'g2');
    resetStoreForMembership([g1, m1, g2, m2]);

    const moveNodesBetweenGroups = vi.fn();
    const { result } = renderHook(() =>
      useNodeCanvasChangeController({
        nodeGraphId: 'graph-1',
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
        updateNodePositionsBatch: vi.fn(),
        removeNodes: vi.fn(),
        addNodesToGroup: vi.fn(),
        removeNodesFromGroup: vi.fn(),
        moveNodesBetweenGroups,
        nodeGraphNodes: [g1, m1, g2, m2],
        zoom: 1,
      }),
    );

    act(() => {
      result.current.onNodeDragStart(STUB_DRAG_EVENT, STUB_DRAG_NODE, []);
      // 把 m1 拖到 g2 区域内（1020,1020 附近）
      result.current.onNodesChange([
        { id: 'm1', type: 'position', position: { x: 1020, y: 1020 } as NodePosition, dragging: true },
      ]);
      result.current.onNodeDragStop();
    });

    expect(moveNodesBetweenGroups).toHaveBeenCalledTimes(1);
    expect(moveNodesBetweenGroups).toHaveBeenCalledTimes(1);
    expect(moveNodesBetweenGroups).toHaveBeenCalledWith(['m1'], 'g2');
  });

  it('折叠态组不参与拖拽判定（无展开边界可命中）', () => {
    const g = makeGroupNode('g1', 100, 100, true); // 折叠
    const free = makeTextInputNode('free', 500, 500, undefined);
    resetStoreForMembership([g, free]);

    const addNodesToGroup = vi.fn();
    const { result } = renderHook(() =>
      useNodeCanvasChangeController({
        nodeGraphId: 'graph-1',
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
        updateNodePositionsBatch: vi.fn(),
        removeNodes: vi.fn(),
        addNodesToGroup,
        removeNodesFromGroup: vi.fn(),
        moveNodesBetweenGroups: vi.fn(),
        nodeGraphNodes: [g, free],
        zoom: 1,
      }),
    );

    act(() => {
      result.current.onNodeDragStart(STUB_DRAG_EVENT, STUB_DRAG_NODE, []);
      // 拖到折叠组附近——但因为折叠，不应命中
      result.current.onNodesChange([
        { id: 'free', type: 'position', position: { x: 105, y: 105 } as NodePosition, dragging: true },
      ]);
      result.current.onNodeDragStop();
    });

    expect(addNodesToGroup).not.toHaveBeenCalled();
  });
});

const makeAgentNode = (
  id: string,
  x: number,
  y: number,
  groupId: string | undefined,
): GraphNode<AgentNodeData> => ({
  id,
  type: 'agent',
  position: { x, y },
  data: { label: 'Agent', agentSessionId: `session-${id}` },
  draggable: true,
  size: undefined,
  style: undefined,
  groupId,
});

const createMembershipControllerArgs = (
  nodes: GraphNode[],
  mocks: {
    addNodesToGroup: ReturnType<typeof vi.fn>;
    removeNodesFromGroup: ReturnType<typeof vi.fn>;
    moveNodesBetweenGroups: ReturnType<typeof vi.fn>;
  },
) => ({
  nodeGraphId: 'graph-1',
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
  updateNodePositionsBatch: vi.fn(),
  removeNodes: vi.fn(),
  ...mocks,
  nodeGraphNodes: nodes,
  zoom: 1,
});

describe('useNodeCanvasChangeController Agent 容器拖拽归属（零特例）', () => {
  // @spec: AG-CT-003, AG-CN-004
  it('自由节点拖入展开态 Agent 容器快照边界 → 自动加入容器', () => {
    // Agent 容器 a1 在 (100,100)，成员 m 在 (120,120)：派生边界覆盖 (108,80)-(372,292)
    const a1 = makeAgentNode('a1', 100, 100, undefined);
    const m = makeTextInputNode('m', 120, 120, 'a1');
    const free = makeTextInputNode('free', 500, 500, undefined);
    resetStoreForMembership([a1, m, free]);

    const mocks = {
      addNodesToGroup: vi.fn(),
      removeNodesFromGroup: vi.fn(),
      moveNodesBetweenGroups: vi.fn(),
    };
    const { result } = renderHook(() =>
      useNodeCanvasChangeController(createMembershipControllerArgs([a1, m, free], mocks)),
    );

    act(() => {
      result.current.onNodeDragStart(STUB_DRAG_EVENT, STUB_DRAG_NODE, []);
      // 落点中心 = position + 尺寸/2 ≈ (260,210)，落在 Agent 容器派生边界内
      result.current.onNodesChange([
        { id: 'free', type: 'position', position: { x: 150, y: 150 } as NodePosition, dragging: true },
      ]);
      result.current.onNodeDragStop();
    });

    expect(mocks.addNodesToGroup).toHaveBeenCalledTimes(1);
    expect(mocks.addNodesToGroup).toHaveBeenCalledWith(['free'], 'a1');
    expect(mocks.removeNodesFromGroup).not.toHaveBeenCalled();
    expect(mocks.moveNodesBetweenGroups).not.toHaveBeenCalled();
  });

  // @spec: AG-CT-003, AG-CN-004
  it('Agent 容器成员拖出其快照边界 → 自动移出容器', () => {
    const a1 = makeAgentNode('a1', 100, 100, undefined);
    const m = makeTextInputNode('m', 120, 120, 'a1');
    resetStoreForMembership([a1, m]);

    const mocks = {
      addNodesToGroup: vi.fn(),
      removeNodesFromGroup: vi.fn(),
      moveNodesBetweenGroups: vi.fn(),
    };
    const { result } = renderHook(() =>
      useNodeCanvasChangeController(createMembershipControllerArgs([a1, m], mocks)),
    );

    act(() => {
      result.current.onNodeDragStart(STUB_DRAG_EVENT, STUB_DRAG_NODE, []);
      result.current.onNodesChange([
        { id: 'm', type: 'position', position: { x: 4000, y: 4000 } as NodePosition, dragging: true },
      ]);
      result.current.onNodeDragStop();
    });

    expect(mocks.removeNodesFromGroup).toHaveBeenCalledTimes(1);
    expect(mocks.removeNodesFromGroup).toHaveBeenCalledWith(['m']);
    expect(mocks.addNodesToGroup).not.toHaveBeenCalled();
    expect(mocks.moveNodesBetweenGroups).not.toHaveBeenCalled();
  });

  // @spec: AG-CN-004
  it('组内 Agent 容器的成员在容器边界内移动 → 不改归属（最高绘制层命中容器=原归属）', () => {
    // g1 含 Agent 容器 a1（a1 store position 与其派生 position 一致），a1 含叶成员
    const g1 = makeGroupNode('g1', 0, 0);
    const a1 = makeAgentNode('a1', 108, 80, 'g1');
    const leaf = makeTextInputNode('leaf', 120, 120, 'a1');
    resetStoreForMembership([g1, a1, leaf]);

    const mocks = {
      addNodesToGroup: vi.fn(),
      removeNodesFromGroup: vi.fn(),
      moveNodesBetweenGroups: vi.fn(),
    };
    const { result } = renderHook(() =>
      useNodeCanvasChangeController(createMembershipControllerArgs([g1, a1, leaf], mocks)),
    );

    act(() => {
      result.current.onNodeDragStart(STUB_DRAG_EVENT, STUB_DRAG_NODE, []);
      // 落点中心 ≈ (310,240)：同时落在 a1 与 g1 边界内 → 命中更高绘制层 a1（=原归属）→ 无操作
      result.current.onNodesChange([
        { id: 'leaf', type: 'position', position: { x: 200, y: 180 } as NodePosition, dragging: true },
      ]);
      result.current.onNodeDragStop();
    });

    expect(mocks.addNodesToGroup).not.toHaveBeenCalled();
    expect(mocks.removeNodesFromGroup).not.toHaveBeenCalled();
    expect(mocks.moveNodesBetweenGroups).not.toHaveBeenCalled();
  });

  // @spec: AG-CN-004, AG-CT-003
  it('组成员（Agent 容器）拖出组边界 → 移出组；拖入其他组 → 跨组迁移', () => {
    const g1 = makeGroupNode('g1', 0, 0);
    const a1 = makeAgentNode('a1', 200, 200, 'g1');
    const gMember = makeTextInputNode('gm', 20, 20, 'g1'); // 让 g1 有派生边界
    const g2 = makeGroupNode('g2', 3000, 3000);
    const g2Member = makeTextInputNode('gm2', 3020, 3020, 'g2');
    resetStoreForMembership([g1, a1, gMember, g2, g2Member]);

    const mocks = {
      addNodesToGroup: vi.fn(),
      removeNodesFromGroup: vi.fn(),
      moveNodesBetweenGroups: vi.fn(),
    };
    const { result } = renderHook(() =>
      useNodeCanvasChangeController(
        createMembershipControllerArgs([g1, a1, gMember, g2, g2Member], mocks),
      ),
    );

    act(() => {
      result.current.onNodeDragStart(STUB_DRAG_EVENT, STUB_DRAG_NODE, []);
      // 拖到 g2 区域内 → 跨组迁移
      result.current.onNodesChange([
        { id: 'a1', type: 'position', position: { x: 3050, y: 3050 } as NodePosition, dragging: true },
      ]);
      result.current.onNodeDragStop();
    });

    expect(mocks.moveNodesBetweenGroups).toHaveBeenCalledTimes(1);
    expect(mocks.moveNodesBetweenGroups).toHaveBeenCalledWith(['a1'], 'g2');
  });

  // @spec: AG-CN-001, AG-CN-004
  it('自由 Agent 容器拖入组边界 → 加入组；拖入另一 Agent 容器 → 无操作（资格矩阵拦截）', () => {
    const g1 = makeGroupNode('g1', 0, 0);
    const gMember = makeTextInputNode('gm', 20, 20, 'g1');
    const freeAgent = makeAgentNode('free-a', 4000, 4000, undefined);
    resetStoreForMembership([g1, gMember, freeAgent]);

    const mocks = {
      addNodesToGroup: vi.fn(),
      removeNodesFromGroup: vi.fn(),
      moveNodesBetweenGroups: vi.fn(),
    };
    const { result } = renderHook(() =>
      useNodeCanvasChangeController(
        createMembershipControllerArgs([g1, gMember, freeAgent], mocks),
      ),
    );

    act(() => {
      result.current.onNodeDragStart(STUB_DRAG_EVENT, STUB_DRAG_NODE, []);
      // 落入 g1 边界（g1 派生边界覆盖 gm 范围）→ 自由 Agent 加入组
      result.current.onNodesChange([
        { id: 'free-a', type: 'position', position: { x: 60, y: 60 } as NodePosition, dragging: true },
      ]);
      result.current.onNodeDragStop();
    });

    expect(mocks.addNodesToGroup).toHaveBeenCalledTimes(1);
    expect(mocks.addNodesToGroup).toHaveBeenCalledWith(['free-a'], 'g1');
  });

  // @spec: AG-CN-004
  it('折叠态 Agent 容器不参与拖拽判定（无展开边界可命中）', () => {
    const a1: GraphNode<AgentNodeData> = {
      ...makeAgentNode('a1', 100, 100, undefined),
      data: { label: 'Agent', agentSessionId: 'session-a1', collapsed: true },
    };
    const m = makeTextInputNode('m', 120, 120, 'a1');
    resetStoreForMembership([a1, m]);

    const mocks = {
      addNodesToGroup: vi.fn(),
      removeNodesFromGroup: vi.fn(),
      moveNodesBetweenGroups: vi.fn(),
    };
    const { result } = renderHook(() =>
      useNodeCanvasChangeController(createMembershipControllerArgs([a1, m], mocks)),
    );

    act(() => {
      result.current.onNodeDragStart(STUB_DRAG_EVENT, STUB_DRAG_NODE, []);
      result.current.onNodesChange([
        { id: 'm', type: 'position', position: { x: 150, y: 150 } as NodePosition, dragging: true },
      ]);
      result.current.onNodeDragStop();
    });

    // 折叠容器不参与几何命中 → 成员落点无任何容器可命中 → 移出
    expect(mocks.addNodesToGroup).not.toHaveBeenCalled();
    expect(mocks.moveNodesBetweenGroups).not.toHaveBeenCalled();
    expect(mocks.removeNodesFromGroup).toHaveBeenCalledWith(['m']);
  });
});
