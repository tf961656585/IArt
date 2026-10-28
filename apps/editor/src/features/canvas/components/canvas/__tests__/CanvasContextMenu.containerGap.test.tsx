import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { GraphNode } from "@/features/canvas/types";
import type { AgentNodeData } from "@/features/canvas/types/agentNode";
import type { ContextMenuTarget } from "@/features/canvas/types/clipboard";
import { CanvasContextMenu } from "../CanvasContextMenu";

/**
 * 容器内空白（组 / Agent 容器背板空隙）右键的合并菜单：
 * 容器段在前 + 唯一分隔线 + 画布段在后，危险项聚全菜单末尾相邻；
 * 容器段动作显式绑定命中容器 id（不依赖选中态）。
 *
 * 与 `CanvasContextMenu.test.tsx` 同一套 mock 接线；本文件只承载容器内空白
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
  dissolveAgentContainer: ReturnType<typeof vi.fn>;
  requestAgentDeleteConfirm: ReturnType<typeof vi.fn>;
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
  ungroupNode: ReturnType<typeof vi.fn>;
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

const buildNode = (overrides?: Partial<GraphNode>): GraphNode => ({
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
    taskInfo: undefined,
    cachedContent: undefined,
  },
  draggable: undefined,
  size: undefined,
  style: undefined,
  groupId: undefined,
  ...overrides,
});

const buildGroupNode = (
  id = "group-1",
  name = "组一",
  collapsed = false,
): GraphNode => ({
  id,
  type: "group",
  position: { x: 0, y: 0 },
  data: {
    label: "节点组",
    description: undefined,
    runtimeRef: undefined,
    name,
    collapsed,
    color: undefined,
  },
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
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

describe("CanvasContextMenu 容器内空白合并菜单", () => {
  // @spec: CM-001
  const onCloseMock = vi.fn();

  const buildMockState = (
    nodes: GraphNode[],
    overrides: Partial<MockCanvasContextMenuState> = {},
  ): MockCanvasContextMenuState => ({
    addNode: vi.fn(),
    copySelectedNodes: vi.fn(),
    pasteNodes: vi.fn(),
    hasClipboardContent: vi.fn(() => false),
    removeNodes: vi.fn(),
    dissolveAgentContainer: vi.fn(),
    requestAgentDeleteConfirm: vi.fn(),
    selectAll: vi.fn(),
    selectNodes: vi.fn(),
    selectAnnotation: vi.fn(),
    nodeGraph: { nodes },
    mediaAssets: {},
    selectedNodeIds: [],
    updateNodeData: vi.fn(),
    createAnnotation: vi.fn(),
    addAnnotationForNode: vi.fn(),
    removeAnnotation: vi.fn(),
    unbindAnnotation: vi.fn(),
    startAnnotationBinding: vi.fn(),
    autoLayoutContainer: vi.fn(async () => ({ positions: {}, changedCount: 0 })),
    toggleGroupCollapse: vi.fn(),
    ungroupNode: vi.fn(),
    ui: { annotations: [] },
    ...overrides,
  });

  const buildMember = (id: string, groupId = "group-1"): GraphNode => ({
    ...buildNode({ id }),
    groupId,
  });

  const containerGapTarget = (
    containerNodeId: string,
    containerKind: "group" | "agentContainer" = "group",
  ): ContextMenuTarget => ({
    type: "containerGap",
    containerNodeId,
    containerKind,
    position: { x: 0, y: 0 },
  });

  const renderGapMenu = (target: ContextMenuTarget) =>
    render(
      <CanvasContextMenu
        open
        target={target}
        screenPosition={{ x: 20, y: 20 }}
        onRequestBundleExport={vi.fn()}
        onRequestBundleImportInsert={vi.fn()}
        isBundleImportRunning={false}
        measuredSizeByNodeId={undefined}
        derivedSizeByNodeId={undefined}
        onClose={onCloseMock}
      />,
    );

  /** a 在 DOM 序上先于 b */
  const precedes = (a: Element, b: Element): boolean =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  beforeEach(() => {
    vi.clearAllMocks();
    getNodeMediaUrlForRevealMock.mockReturnValue(null);
  });

  // @spec: CM-028
  it("合并菜单排布：容器段在前 + 唯一分隔线 + 画布段在后，危险项聚全菜单末尾相邻", () => {
    mockCanvasState = buildMockState([
      buildGroupNode(),
      buildMember("m1"),
      buildMember("m2"),
    ]);
    renderGapMenu(containerGapTarget("group-1"));

    const menu = document.querySelector("[data-canvas-context-menu]");
    expect(menu).not.toBeNull();
    const scope = within(menu as HTMLElement);

    // 容器段齐备（组专属项 + 容器标准行为项），画布段齐备
    expect(scope.getByRole("menuitem", { name: "重命名组" })).toBeInTheDocument();
    expect(scope.getByRole("menuitem", { name: "折叠组" })).toBeInTheDocument();
    expect(scope.getByRole("group", { name: "组颜色" })).toBeInTheDocument();
    expect(scope.getByRole("menuitem", { name: "整理本组" })).toBeInTheDocument();
    expect(scope.getByRole("menuitem", { name: "解组" })).toBeInTheDocument();
    expect(scope.getByRole("menuitem", { name: "导入并插入" })).toBeInTheDocument();
    // 粘贴/全选行的可访问名含快捷键尾巴（图标 + 文案 + 快捷键拼接）
    expect(scope.getByRole("menuitem", { name: /^粘贴/ })).toBeInTheDocument();
    expect(scope.getByRole("menuitem", { name: /^全选/ })).toBeInTheDocument();
    expect(scope.getByRole("menuitem", { name: "创建注释" })).toBeInTheDocument();

    // 唯一分隔线：只分隔容器段与画布段（容器菜单内部既有语义分组不加分隔线）
    const separators = scope.getAllByRole("separator");
    expect(separators).toHaveLength(1);
    const separator = separators[0] as Element;
    const buttonOf = (name: string | RegExp) => scope.getByRole("menuitem", { name });
    expect(precedes(buttonOf("解组"), separator)).toBe(true);
    expect(precedes(separator, buttonOf("导入并插入"))).toBe(true);

    // 危险项聚全菜单末尾相邻：删除组及全部成员 → 删除失败节点（均 destructive）
    const deleteGroup = buttonOf("删除组及全部成员");
    const deleteFailed = buttonOf(/^删除失败节点/);
    expect(precedes(buttonOf("创建注释"), deleteGroup)).toBe(true);
    expect(precedes(deleteGroup, deleteFailed)).toBe(true);
    expect(deleteGroup.className).toContain("text-destructive");
    expect(deleteFailed.className).toContain("text-destructive");
  });

  // @spec: CM-027
  it("容器段动作绑定命中容器 id：不依赖选中态（选中为空也按 target.containerNodeId 执行）", () => {
    mockCanvasState = buildMockState([buildGroupNode(), buildMember("m1")]);
    renderGapMenu(containerGapTarget("group-1"));

    fireEvent.click(screen.getByRole("menuitem", { name: "折叠组" }));
    expect(mockCanvasState.toggleGroupCollapse).toHaveBeenCalledWith("group-1");

    fireEvent.click(screen.getByRole("menuitem", { name: "解组" }));
    expect(mockCanvasState.ungroupNode).toHaveBeenCalledWith("group-1");
  });

  it("Agent 容器空白合并菜单：容器段为容器中性项（无组专属项），解散为非危险项不入末尾危险组", () => {
    mockCanvasState = buildMockState([
      buildAgentContainerNode("agent-1"),
      buildMember("am1", "agent-1"),
    ]);

    renderGapMenu(containerGapTarget("agent-1", "agentContainer"));

    const scope = within(
      document.querySelector("[data-canvas-context-menu]") as HTMLElement,
    );
    expect(scope.getByRole("menuitem", { name: "折叠容器" })).toBeInTheDocument();
    expect(scope.getByRole("menuitem", { name: "整理本容器" })).toBeInTheDocument();
    expect(scope.getByRole("menuitem", { name: "解散容器" })).toBeInTheDocument();
    expect(scope.queryByRole("menuitem", { name: "重命名组" })).toBeNull();
    expect(scope.queryByRole("group", { name: "组颜色" })).toBeNull();
    expect(scope.queryByRole("menuitem", { name: "解组" })).toBeNull();
    // Agent 容器段无 destructive 项：末尾危险组只有画布段的删除失败节点
    expect(scope.getAllByRole("separator")).toHaveLength(1);
    expect(
      scope.getByRole("menuitem", { name: /^删除失败节点/ }).className,
    ).toContain("text-destructive");
  });

  it("命中容器在图中已不存在：降级为画布段菜单并留 debug 痕迹", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    try {
      mockCanvasState = buildMockState([]);
      renderGapMenu(containerGapTarget("ghost-1"));

      const scope = within(
        document.querySelector("[data-canvas-context-menu]") as HTMLElement,
      );
      expect(scope.getByRole("menuitem", { name: "导入并插入" })).toBeInTheDocument();
      expect(scope.queryByRole("menuitem", { name: "重命名组" })).toBeNull();
      expect(scope.queryByRole("separator")).toBeNull();
      expect(debugSpy).toHaveBeenCalled();
    } finally {
      debugSpy.mockRestore();
    }
  });
});
