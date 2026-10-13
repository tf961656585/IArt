import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCanvasStore } from "../../store/canvasStore";
import { createNodeGraph } from "../../types/nodeGraph";
import { nodeRegistry } from "../../nodes";
import type {
  GraphNode,
  NodeSize,
  GroupNodeData,
} from "../../types";
import { useLocateToNode } from "../useLocateToNode";

/**
 * useLocateToNode 测试。
 *
 * 核心断言策略:mock useReactFlow 返回带 setCenter spy 的实例,
 * 直接断言 setCenter 被以正确的中心点调用(绕开 RF jsdom 无几何的限制,
 * 验证定位契约而非 RF 内部实现)。
 *
 * 覆盖场景(对应 spec 验收标准):
 * 1. 普通节点定位中心点正确(基于 measured/desired/default 解析的 size)
 * 2. 组节点定位用派生几何(派生 position + 派生 size,非 store group.position)
 * 3. 视口外节点(measured 缺失)仍能定位(走 desired/default 回退)
 * 4. 节点已删除 no-op(竞态保护)
 * 5. selectNodes 被调用(reason 正确)
 * 6. select: false 不调 selectNodes
 * 7. RF 实例不可用返回 no-op(不抛错)
 */

// hoisted mock: setCenter spy 供断言。显式类型化调用签名,避免 mock.calls 元素为 any。
const mockSetCenter = vi.hoisted(() => vi.fn<(x: number, y: number, options: { zoom: number; duration: number }) => void>());
const mockSelectNodes = vi.hoisted(() => vi.fn<(nodeIds: string[], reason: string) => void>());

vi.mock("@xyflow/react", () => ({
  useReactFlow: () => ({ setCenter: mockSetCenter }),
}));

vi.mock("../../components/canvas/useCanvasSelectionBridge", () => ({
  useCanvasSelectionBridge: () => ({
    selectNodes: mockSelectNodes,
  }),
}));

const resetStore = () => {
  useCanvasStore.setState({
    nodeGraph: null,
    selectedNodeIds: [],
    selectedAnnotationIds: [],
    editingAnnotationId: null,
    pendingAnnotationBinding: null,
    isDragging: false,
    isConnecting: false,
    history: [],
    historyIndex: -1,
    hasUnsavedChanges: false,
    structureRevision: 0,
    positionRevision: 0,
    viewportRevision: 0,
    layoutRevision: 0,
        clipboardPayload: null,
  });
};

const createTextNode = (
  id: string,
  position: { x: number; y: number },
): GraphNode => {
  const node = nodeRegistry.createNode('videoInput', position, undefined);
  if (node === null) {
    throw new Error('expected registered node type: videoInput');
  }
  return {
    ...node,
    id,
  };
};

const createGroupNode = (
  id: string,
  position: { x: number; y: number },
  opts: { collapsed: boolean; name?: string } = { collapsed: false },
): GraphNode<GroupNodeData> => ({
  id,
  type: "group",
  position,
  data: {
    label: undefined,
    description: undefined,
    runtimeRef: undefined,
    name: opts.name ?? "",
    collapsed: opts.collapsed,
    color: undefined,
  },
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

const createMemberNode = (
  id: string,
  groupId: string,
  position: { x: number; y: number },
): GraphNode => ({
  ...createTextNode(id, position),
  id,
  groupId,
});

const seedGraph = (
  nodes: GraphNode[],
  opts: {
    lastMeasuredSizeByNodeId?: Record<string, NodeSize>;
  } = {},
) => {
  const graph = createNodeGraph({
    name: "测试画板",
    description: undefined,
    tags: undefined,
    category: undefined,
  });
  graph.nodes = nodes;
  const prevUi = useCanvasStore.getState().ui;
  useCanvasStore.setState({
    nodeGraph: graph,
    ui: {
      ...prevUi,
      lastMeasuredSizeByNodeId: opts.lastMeasuredSizeByNodeId ?? {},
      desiredSizeByNodeId: {},
    },
  });
};

describe("useLocateToNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  it("普通节点定位:中心点基于 measured size", () => {
    // 节点 position (100, 200),measured size 200×120
    // 期望中心点 = (100 + 100, 200 + 60) = (200, 260)
    const node = createTextNode("n1", { x: 100, y: 200 });
    seedGraph([node], {
      lastMeasuredSizeByNodeId: { n1: { width: 200, height: 120 } },
    });

    const { result } = renderHook(() => useLocateToNode());

    act(() => {
      result.current("n1", "test-locate");
    });

    expect(mockSetCenter).toHaveBeenCalledTimes(1);
    expect(mockSetCenter).toHaveBeenCalledWith(200, 260, {
      zoom: 1,
      duration: 300,
    });
    expect(mockSelectNodes).toHaveBeenCalledWith(["n1"], "test-locate");
  });

  it("普通节点 measured 缺失时走 default 回退仍能定位", () => {
    // 无 measured、无 desired → 走注册表 default → videoInput defaultSize (240×160)
    // 节点 position (0, 0),期望中心点 = (120, 80)
    const node = createTextNode("n1", { x: 0, y: 0 });
    seedGraph([node]);

    const { result } = renderHook(() => useLocateToNode());

    act(() => {
      result.current("n1", "test-locate");
    });

    expect(mockSetCenter).toHaveBeenCalledTimes(1);
    // videoInput 注册表 defaultSize = 240×160,中心 = (120, 80)
    expect(mockSetCenter).toHaveBeenCalledWith(120, 80, {
      zoom: 1,
      duration: 300,
    });
  });

  it("组节点定位:用派生 position + 派生 size(非 store group.position)", () => {
    // store group.position = (1000, 1000)(故意远离成员)
    // 成员 m1 在 (120, 140),measured 200×120
    // 派生 position 应基于成员包围盒,不是 (1000, 1000)
    const group = createGroupNode("g1", { x: 1000, y: 1000 });
    const member = createMemberNode("m1", "g1", { x: 120, y: 140 });
    seedGraph([group, member], {
      lastMeasuredSizeByNodeId: { m1: { width: 200, height: 120 } },
    });

    const { result } = renderHook(() => useLocateToNode());

    act(() => {
      result.current("g1", "locate-group");
    });

    expect(mockSetCenter).toHaveBeenCalledTimes(1);
    const firstCall = mockSetCenter.mock.calls[0];
    expect(firstCall).toBeDefined();
    const centerX = firstCall !== undefined ? firstCall[0] : NaN;
    const centerY = firstCall !== undefined ? firstCall[1] : NaN;
    // 派生 position 不应是 store 的 (1000, 1000)
    // 成员包围盒 (120,140) 到 (320,260),派生 position 减去 padding+header
    // 中心点应远小于 1000(具体值取决于 GROUP_PADDING/HEADER,但关键是 ≠ 1000)
    expect(centerX).toBeLessThan(500);
    expect(centerY).toBeLessThan(500);
    expect(mockSelectNodes).toHaveBeenCalledWith(["g1"], "locate-group");
  });

  it("折叠组定位:中心点基于 header 推导尺寸", () => {
    const group = createGroupNode(
      "g1",
      { x: 200, y: 200 },
      { collapsed: true, name: "测试组" },
    );
    seedGraph([group]);

    const { result } = renderHook(() => useLocateToNode());

    act(() => {
      result.current("g1", "locate-group");
    });

    expect(mockSetCenter).toHaveBeenCalledTimes(1);
    const firstCall = mockSetCenter.mock.calls[0];
    expect(firstCall).toBeDefined();
    const centerX = firstCall !== undefined ? firstCall[0] : NaN;
    const centerY = firstCall !== undefined ? firstCall[1] : NaN;
    // 折叠态 position 保持 store position (200, 200)
    // 中心点 = 200 + size/2,size 是 header 推导(小尺寸)
    expect(centerX).toBeGreaterThan(200);
    expect(centerX).toBeLessThan(400);
    expect(centerY).toBeGreaterThan(200);
    expect(centerY).toBeLessThan(300);
  });

  it("节点已删除:no-op,不调 setCenter 不调 selectNodes", () => {
    // store 里没有节点
    seedGraph([]);

    const { result } = renderHook(() => useLocateToNode());

    act(() => {
      result.current("nonexistent", "test-locate");
    });

    expect(mockSetCenter).not.toHaveBeenCalled();
    expect(mockSelectNodes).not.toHaveBeenCalled();
  });

  it("select: false 时不调 selectNodes 但仍调 setCenter", () => {
    const node = createTextNode("n1", { x: 100, y: 200 });
    seedGraph([node], {
      lastMeasuredSizeByNodeId: { n1: { width: 200, height: 120 } },
    });

    const { result } = renderHook(() => useLocateToNode());

    act(() => {
      result.current("n1", "test-locate", { select: false });
    });

    expect(mockSetCenter).toHaveBeenCalledTimes(1);
    expect(mockSelectNodes).not.toHaveBeenCalled();
  });

  it("自定义 zoom 和 duration 透传给 setCenter", () => {
    const node = createTextNode("n1", { x: 0, y: 0 });
    seedGraph([node], {
      lastMeasuredSizeByNodeId: { n1: { width: 200, height: 120 } },
    });

    const { result } = renderHook(() => useLocateToNode());

    act(() => {
      result.current("n1", "test-locate", {
        zoom: 2,
        duration: 500,
      });
    });

    expect(mockSetCenter).toHaveBeenCalledWith(100, 60, {
      zoom: 2,
      duration: 500,
    });
  });
});
