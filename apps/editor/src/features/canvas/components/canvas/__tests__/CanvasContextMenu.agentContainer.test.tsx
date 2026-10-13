import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import type { GraphNode } from "@/features/canvas/types";
import type { AgentNodeData } from "@/features/canvas/types/agentNode";
import type { ContextMenuTarget } from "@/features/canvas/types/clipboard";
import { CanvasContextMenu } from "../CanvasContextMenu";

/**
 * Agent 容器的容器标准行为菜单项（整理本容器 / 折叠容器 · 展开容器）。
 *
 * 与 `CanvasContextMenu.test.tsx` 同一套 mock 接线；本文件只承载 Agent 容器
 * 侧用例（主文件超出 max-lines 门禁后拆分）。
 */

const mockSelectionCommands = vi.hoisted(() => ({
  selectAnnotations: vi.fn(),
  selectEntireCanvas: vi.fn(),
  selectNodes: vi.fn(),
}));

type MockCanvasContextMenuState = {
  addNode: ReturnType<typeof vi.fn>;
  copySelectedNodes: ReturnType<typeof vi.fn>;
  pasteNodes: ReturnType<typeof vi.fn>;
  hasClipboardContent: ReturnType<typeof vi.fn>;
  removeNodes: ReturnType<typeof vi.fn>;
  selectAll: ReturnType<typeof vi.fn>;
  selectNodes: ReturnType<typeof vi.fn>;
  selectAnnotation: ReturnType<typeof vi.fn>;
  nodeGraph: { nodes: GraphNode[] };
  mediaAssets: Record<string, never>;
  selectedNodeIds: string[];
  updateNodeData: ReturnType<typeof vi.fn>;
  createAnnotation: ReturnType<typeof vi.fn>;
  addAnnotationForNode: ReturnType<typeof vi.fn>;
  removeAnnotation: ReturnType<typeof vi.fn>;
  unbindAnnotation: ReturnType<typeof vi.fn>;
  startAnnotationBinding: ReturnType<typeof vi.fn>;
  autoLayoutContainer: ReturnType<typeof vi.fn>;
  toggleGroupCollapse: ReturnType<typeof vi.fn>;
  ui: { annotations: [] };
};

let mockCanvasState: MockCanvasContextMenuState;

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("../../../store/canvasStore", () => {
  const useCanvasStore = <T,>(
    selector: (state: MockCanvasContextMenuState) => T,
  ) => selector(mockCanvasState);
  useCanvasStore.getState = () => mockCanvasState;
  return { useCanvasStore };
});

vi.mock("../useCanvasSelectionBridge", () => ({
  useCanvasSelectionBridge: () => mockSelectionCommands,
}));

vi.mock("../../../store/characterUIStore", () => ({
  useCharacterUIStore: <T,>(
    selector: (state: { openSaveDialog: ReturnType<typeof vi.fn> }) => T,
  ) => selector({ openSaveDialog: vi.fn() }),
}));

vi.mock("@/client/store/runtimeStore", () => ({
  getRuntimeProjectPath: () => "/tmp/demo.iartproj",
}));

vi.mock("@iart/backend-sdk/electron-bridge", () => ({
  revealTaskArchive: vi.fn(async () => ({ ok: true })),
  writeTextToClipboard: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/client/utils/revealFilesUrlWithToast", () => ({
  revealFilesUrlWithToast: vi.fn(async () => ({ ok: true })),
}));

const getNodeMediaUrlForRevealMock = vi.hoisted(() =>
  vi.fn<(node: GraphNode) => string | null>(() => null),
);
vi.mock("../../../utils/nodeMediaUrlRegistry", () => ({
  getNodeMediaUrlForReveal: getNodeMediaUrlForRevealMock,
}));

const buildNode = (
  overrides?: Partial<GraphNode>,
): GraphNode => ({
  id: "node-1",
  type: "imageInput",
  position: { x: 0, y: 0 },
  data: {
    label: "图片节点",
    description: undefined,
    runtimeRef: undefined,
    assetId: undefined,
    imageUrl: "/files/archive-test.png",
    imageMeta: undefined,
    lastExecutionId: undefined,
    lastSourceNodeId: undefined,
    lastSourcePortId: undefined,
    valueSource: undefined,
    mediaError: undefined,
    derivedFromNodeId: undefined,
    derivedOp: undefined,
    taskInfo: undefined,
    cachedContent: undefined,
    originalImageMeta: undefined,
    resizePercent: undefined,
    outpaintModelId: undefined,
  },
  draggable: undefined,
  size: undefined,
  style: undefined,
  groupId: undefined,
  ...overrides,
});

const buildAgentContainerNode = (
  id = "agent-1",
  collapsed = false,
): GraphNode => ({
  id,
  type: "agent",
  position: { x: 0, y: 0 },
  data: {
    label: "Agent 节点",
    agentSessionId: `session-${id}`,
    collapsed,
  } satisfies AgentNodeData,
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

const buildMembers = (count: number): GraphNode[] =>
  Array.from({ length: count }, (_, i) => ({
    ...buildNode({ id: `am${i + 1}` }),
    groupId: "agent-1",
  }));

describe("CanvasContextMenu Agent 容器整理与折叠（容器标准行为）", () => {
  const onCloseMock = vi.fn();

  const seedAgentContainer = (collapsed = false, memberCount = 3) => {
    mockCanvasState = {
      addNode: vi.fn(),
      copySelectedNodes: vi.fn(),
      pasteNodes: vi.fn(),
      hasClipboardContent: vi.fn(() => false),
      removeNodes: vi.fn(),
      selectAll: vi.fn(),
      selectNodes: vi.fn(),
      selectAnnotation: vi.fn(),
      nodeGraph: {
        nodes: [buildAgentContainerNode("agent-1", collapsed), ...buildMembers(memberCount)],
      },
      mediaAssets: {},
      selectedNodeIds: ["agent-1"],
      updateNodeData: vi.fn(),
      createAnnotation: vi.fn(),
      addAnnotationForNode: vi.fn(),
      removeAnnotation: vi.fn(),
      unbindAnnotation: vi.fn(),
      startAnnotationBinding: vi.fn(),
      autoLayoutContainer: vi.fn(async () => ({ positions: {}, changedCount: 0 })),
      toggleGroupCollapse: vi.fn(),
      ui: { annotations: [] },
    };
  };

  const renderAgentMenu = () =>
    render(
      <CanvasContextMenu
        open
        target={
          {
            type: "node",
            nodeId: "agent-1",
            position: { x: 0, y: 0 },
          } satisfies ContextMenuTarget
        }
        screenPosition={{ x: 20, y: 20 }}
        onRequestBundleExport={vi.fn()}
        onRequestBundleImportInsert={vi.fn()}
        isBundleImportRunning={false}
        measuredSizeByNodeId={undefined}
        derivedSizeByNodeId={undefined}
        onClose={onCloseMock}
      />,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    getNodeMediaUrlForRevealMock.mockReturnValue(null);
    seedAgentContainer();
  });

  // @spec: CM-019
  it("Agent 容器菜单出现「整理本容器」子菜单触发项，展开后承载容器中性网格行", () => {
    renderAgentMenu();

    const trigger = screen.getByRole("menuitem", { name: "整理本容器" });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("group", { name: "整理本容器：选择网格列数" }),
    ).toBeInTheDocument();
    // 容器中性文案一字不动：标题、预览、格子无障碍名
    expect(screen.getByText("整理为网格")).toBeInTheDocument();
    expect(screen.getByText("3 行 × 1 列 · 共 3 个节点")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^整理为 / })).toHaveLength(3);
    // 触发项不承载动作：展开不下发整理
    expect(mockCanvasState.autoLayoutContainer).not.toHaveBeenCalled();
  });

  // @spec: CM-020
  it("点击 Agent 容器网格单元按所选列数下发容器内整理", async () => {
    renderAgentMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "整理本容器" }));

    fireEvent.click(screen.getByLabelText("整理为 2 行 2 列"));

    await vi.waitFor(() => {
      expect(mockCanvasState.autoLayoutContainer).toHaveBeenCalledWith(
        "agent-1",
        expect.objectContaining({ columns: 2 }),
      );
    });
  });

  it("折叠态 Agent 容器「整理本容器」灰置且不可展开", () => {
    seedAgentContainer(true);
    renderAgentMenu();

    const trigger = screen.getByRole("menuitem", { name: "整理本容器" });
    expect(trigger).toBeDisabled();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: "整理本容器：选择网格列数" })).toBeNull();
  });

  it("空 Agent 容器「整理本容器」灰置（可整理成员数为 0）", () => {
    seedAgentContainer(false, 0);
    renderAgentMenu();

    expect(screen.getByRole("menuitem", { name: "整理本容器" })).toBeDisabled();
  });

  it("折叠容器 / 展开容器 label 随 collapsed 取反，激活调用容器折叠 action", () => {
    renderAgentMenu();
    const collapse = screen.getByRole("menuitem", { name: "折叠容器" });
    expect(collapse).toBeInTheDocument();

    fireEvent.click(collapse);
    expect(mockCanvasState.toggleGroupCollapse).toHaveBeenCalledWith("agent-1");
  });

  it("已折叠的 Agent 容器菜单显示「展开容器」", () => {
    seedAgentContainer(true);
    renderAgentMenu();

    expect(screen.getByRole("menuitem", { name: "展开容器" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "折叠容器" })).toBeNull();
  });

  // 拒绝 toast 分因（菜单层双门挡不住的帧间漂移路径：菜单开启期间容器状态变化，
  // 子菜单按开启时刻捕获的网格行仍可激活）。漂移以「原地改写」同一 mock 状态对象模拟：
  // 动作内判因读执行时刻的 store 状态（getState），捕获回调的 action 引用不变、
  // 改写其 implementation 复现 store 门拒绝。
  const menuProps = {
    open: true,
    screenPosition: { x: 20, y: 20 },
    onRequestBundleExport: vi.fn(),
    onRequestBundleImportInsert: vi.fn(),
    isBundleImportRunning: false,
    measuredSizeByNodeId: undefined,
    derivedSizeByNodeId: undefined,
    onClose: onCloseMock,
  } satisfies Omit<React.ComponentProps<typeof CanvasContextMenu>, "target">;
  const agentTarget = {
    type: "node",
    nodeId: "agent-1",
    position: { x: 0, y: 0 },
  } satisfies ContextMenuTarget;

  const driftGraph = (nodes: GraphNode[]) => {
    mockCanvasState.nodeGraph = { nodes };
  };

  /** 帧间漂移共用流程：展开态开菜单 → 状态漂移 → 重渲染 → 激活旧子菜单网格格 */
  const driftAndTidy = async (nodes: GraphNode[], expectedToast: string) => {
    const { rerender } = render(<CanvasContextMenu {...menuProps} target={agentTarget} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "整理本容器" }));
    expect(
      screen.getByRole("group", { name: "整理本容器：选择网格列数" }),
    ).toBeInTheDocument();

    driftGraph(nodes);
    // store 门拒绝（漂移后的容器状态不再满足整理门）
    mockCanvasState.autoLayoutContainer.mockImplementation(async () => null);
    rerender(<CanvasContextMenu {...menuProps} target={agentTarget} />);

    fireEvent.click(screen.getByLabelText("整理为 2 行 2 列"));
    await vi.waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith(expectedToast);
    });
  };

  it("漂移为折叠态后激活整理：拒绝 toast 按因给「已折叠，先展开」出路", async () => {
    await driftAndTidy(
      [buildAgentContainerNode("agent-1", true), ...buildMembers(3)],
      "本容器已折叠，先展开再试试",
    );
  });

  it("漂移为无成员后激活整理：拒绝 toast 按因给实情，不误导「先展开」", async () => {
    await driftAndTidy(
      [buildAgentContainerNode("agent-1", false)],
      "本容器还没有成员，暂不能整理",
    );
  });

  it("漂移为容器不存在后激活整理：防御兜底 toast 只给重试出路", async () => {
    await driftAndTidy([], "整理没有生效，请重试");
  });
});
