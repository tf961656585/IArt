import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { OverlayEscapeDispatcher } from "@iart/ui";
import { toast } from "sonner";
import type {
  AssetNodeData,
  GraphNode,
  ImageInputNodeData,
  NodeTaskInfo,
  TaskNodeData,
} from "@/features/canvas/types";
import type { AgentNodeData } from "@/features/canvas/types/agentNode";
import type { ContextMenuTarget } from "@/features/canvas/types/clipboard";
import { CanvasContextMenu } from "../CanvasContextMenu";
import { getCanvasDeleteShortcutLabel } from "@/features/canvas/shortcuts/deleteKeys";
import { revealFilesUrlWithToast } from "@/client/utils/revealFilesUrlWithToast";

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
  ui: { annotations: [] };
};

let mockCanvasState: MockCanvasContextMenuState;
const revealTaskArchiveMock = vi.fn(async () => ({ ok: true }));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/components/ui/toggle-group", () => ({
  ToggleGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ToggleGroupItem: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
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

vi.mock("../../../store/executionStore", () => {
  const useExecutionStore = <T,>(
    selector: (state: { getTransientNodeOutputs: () => undefined }) => T,
  ) => selector({ getTransientNodeOutputs: () => undefined });
  useExecutionStore.getState = () => ({
    getTransientNodeOutputs: () => undefined,
  });
  return { useExecutionStore };
});

vi.mock("@/client/store/runtimeStore", () => ({
  getRuntimeProjectPath: () => "/tmp/demo.iartproj",
}));

vi.mock("@iart/backend-sdk/electron-bridge", () => ({
  revealTaskArchive: (...args: Parameters<typeof revealTaskArchiveMock>) =>
    revealTaskArchiveMock(...args),
  writeTextToClipboard: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/client/utils/revealFilesUrlWithToast", () => ({
  revealFilesUrlWithToast: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../../services/projectMediaAssets", () => ({
  resolveMediaSlotType: vi.fn(),
  resolveMediaSlotValue: vi.fn(),
}));

vi.mock("../../../clipboard/selectionPayload", () => ({
  buildClipboardPayloadFromSelection: vi.fn(),
}));

vi.mock("../../../services/snippetTransfer", () => ({
  buildNodeGraphSnippetFromClipboardPayload: vi.fn(),
}));

const getNodeMediaUrlForRevealMock = vi.hoisted(() =>
  vi.fn<(node: GraphNode) => string | null>(() => null),
);
vi.mock("../../../utils/nodeMediaUrlRegistry", () => ({
  getNodeMediaUrlForReveal: getNodeMediaUrlForRevealMock,
}));

const buildNode = (
  overrides?: Partial<GraphNode<ImageInputNodeData>>,
): GraphNode<ImageInputNodeData> => ({
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
    taskInfo: {
      taskId: "task-ctx-1",
      remoteRequestId: undefined,
      taskIndex: undefined,
      modelId: "mock-model",
      status: "failed",
      progress: undefined,
      createdAt: 1,
      updatedAt: 1,
      error: undefined,
      failure: undefined,
      batchId: undefined,
    } satisfies NodeTaskInfo,
    cachedContent: undefined,
  } satisfies ImageInputNodeData,
  draggable: undefined,
  size: undefined,
  style: undefined,
  groupId: undefined,
  ...overrides,
});

describe("CanvasContextMenu task archive hard cut", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanvasState = {
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
      nodeGraph: {
        nodes: [buildNode()],
      },
      mediaAssets: {},
      selectedNodeIds: ["node-1"],
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
  });

  // @spec: CM-013
  it("只提供任务文件夹动作，不再提供日志或结果动作", async () => {
    render(
      <CanvasContextMenu
        open
        target={
          {
            type: "node",
            nodeId: "node-1",
            position: { x: 0, y: 0 },
          } satisfies ContextMenuTarget
        }
        screenPosition={{ x: 20, y: 20 }}
        onRequestBundleExport={vi.fn()}
        onRequestBundleImportInsert={vi.fn()}
        isBundleImportRunning={false}
        measuredSizeByNodeId={undefined}
        derivedSizeByNodeId={undefined}
        onClose={vi.fn()}
      />,
    );

    const archiveButton = screen.getByRole("menuitem", {
      name: "打开任务文件夹",
    });
    expect(archiveButton).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "打开日志位置" })).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: "打开任务结果位置" }),
    ).toBeNull();

    fireEvent.click(archiveButton);
    expect(revealTaskArchiveMock).toHaveBeenCalledWith(
      "task-ctx-1",
      "/tmp/demo.iartproj",
    );
  });
});

const buildAssetNode = (id = "asset-1"): GraphNode => ({
  id,
  type: "asset",
  position: { x: 0, y: 0 },
  data: {
    label: "资产节点",
    sourceBatchId: "batch-1",
    sourceTaskId: "task-1",
    sourceModelId: "mock-model",
    mediaType: "image",
    assetId: "media-1",
  } satisfies AssetNodeData,
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

describe("CanvasContextMenu 打开文件所在位置", () => {
  const onCloseMock = vi.fn();

  const renderAssetMenu = () =>
    render(
      <CanvasContextMenu
        open
        target={
          {
            type: "node",
            nodeId: "asset-1",
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

  const buildAssetCanvasState = () => {
    mockCanvasState = {
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
      nodeGraph: { nodes: [buildAssetNode()] },
      mediaAssets: {},
      selectedNodeIds: ["asset-1"],
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

  beforeEach(() => {
    vi.clearAllMocks();
    buildAssetCanvasState();
  });

  afterEach(() => {
    getNodeMediaUrlForRevealMock.mockImplementation(() => null);
  });

  it("资产节点媒体地址可定位时出现「打开文件所在位置」，激活调用 reveal 并关闭菜单", () => {
    const mediaUrl = "local-media://prj_0123456789abcdef0123456789abcdef/a.png";
    getNodeMediaUrlForRevealMock.mockReturnValue(mediaUrl);
    renderAssetMenu();

    const revealButton = screen.getByRole("menuitem", {
      name: "打开文件所在位置",
    });
    fireEvent.click(revealButton);

    expect(vi.mocked(revealFilesUrlWithToast)).toHaveBeenCalledWith(
      mediaUrl,
      undefined,
    );
    expect(onCloseMock).toHaveBeenCalled();
  });

  it("媒体地址不可定位时「打开文件所在位置」不出现", () => {
    getNodeMediaUrlForRevealMock.mockReturnValue(null);
    renderAssetMenu();

    expect(
      screen.queryByRole("menuitem", { name: "打开文件所在位置" }),
    ).toBeNull();
  });
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


describe("CanvasContextMenu 整理为网格", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const members = [
      { ...buildNode({ id: "m1" }), groupId: "group-1" },
      { ...buildNode({ id: "m2" }), groupId: "group-1" },
      { ...buildNode({ id: "m3" }), groupId: "group-1" },
    ];
    mockCanvasState = {
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
      nodeGraph: { nodes: [buildGroupNode(), ...members] },
      mediaAssets: {},
      selectedNodeIds: ["group-1"],
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
  });

  const renderGroupMenu = () =>
    render(
      <CanvasContextMenu
        open
        target={
          {
            type: "node",
            nodeId: "group-1",
            position: { x: 0, y: 0 },
          } satisfies ContextMenuTarget
        }
        screenPosition={{ x: 20, y: 20 }}
        onRequestBundleExport={vi.fn()}
        onRequestBundleImportInsert={vi.fn()}
        isBundleImportRunning={false}
        measuredSizeByNodeId={undefined}
        derivedSizeByNodeId={undefined}
        onClose={vi.fn()}
      />,
    );

  // @spec: CM-019
  it("组菜单的「整理本组」是子菜单触发项，激活只展开不下发整理", () => {
    renderGroupMenu();

    const trigger = screen.getByRole("menuitem", { name: "整理本组" });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    // 子菜单未展开时网格行不存在
    expect(screen.queryByRole("group", { name: "整理本组：选择网格列数" })).toBeNull();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("group", { name: "整理本组：选择网格列数" }),
    ).toBeInTheDocument();
    // 3 个成员 → 网格可选 3 列，预览文案按单列起始
    expect(screen.getByText("3 行 × 1 列 · 共 3 个节点")).toBeInTheDocument();
    // 只有第一行的 3 格是可聚焦选项（行数是派生结果）
    expect(screen.getAllByRole("button", { name: /^整理为 / })).toHaveLength(3);
    // 触发项本身不承载动作：展开不得下发整理
    expect(mockCanvasState.autoLayoutContainer).not.toHaveBeenCalled();
  });

  // @spec: CM-020
  it("点击网格单元按所选列数执行组内整理并收起子菜单", async () => {
    renderGroupMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "整理本组" }));

    fireEvent.click(screen.getByLabelText("整理为 2 行 2 列"));

    await vi.waitFor(() => {
      expect(mockCanvasState.autoLayoutContainer).toHaveBeenCalledWith(
        "group-1",
        expect.objectContaining({ columns: 2 }),
      );
    });
    expect(screen.queryByRole("group", { name: "整理本组：选择网格列数" })).toBeNull();
  });

  it("无成员的组「整理本组」灰置且不可展开（空组不产生可整理的网格）", () => {
    mockCanvasState.nodeGraph = { nodes: [buildGroupNode()] };
    renderGroupMenu();

    const trigger = screen.getByRole("menuitem", { name: "整理本组" });
    expect(trigger).toBeDisabled();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: "整理本组：选择网格列数" })).toBeNull();
  });

  it("折叠组的「整理本组」灰置且不可展开（折叠态容器内整理不可执行，需先展开）", () => {
    mockCanvasState.nodeGraph = {
      nodes: [
        buildGroupNode("group-1", "组一", true),
        { ...buildNode({ id: "m1" }), groupId: "group-1" },
        { ...buildNode({ id: "m2" }), groupId: "group-1" },
        { ...buildNode({ id: "m3" }), groupId: "group-1" },
      ],
    };
    renderGroupMenu();

    const trigger = screen.getByRole("menuitem", { name: "整理本组" });
    expect(trigger).toBeDisabled();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: "整理本组：选择网格列数" })).toBeNull();
  });

  // @spec: CM-021
  it("换 target（重复右键）即作废已展开的子菜单，不残留旧组的网格", () => {
    const menuProps = {
      open: true,
      screenPosition: { x: 20, y: 20 },
      onRequestBundleExport: vi.fn(),
      onRequestBundleImportInsert: vi.fn(),
      isBundleImportRunning: false,
      measuredSizeByNodeId: undefined,
      derivedSizeByNodeId: undefined,
      onClose: vi.fn(),
    };
    const { rerender } = render(
      <CanvasContextMenu
        {...menuProps}
        target={
          {
            type: "node",
            nodeId: "group-1",
            position: { x: 0, y: 0 },
          } satisfies ContextMenuTarget
        }
      />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "整理本组" }));
    expect(screen.getByRole("group", { name: "整理本组：选择网格列数" })).toBeInTheDocument();

    // 重复右键换到另一个组（成员数不同）：子菜单必须作废，否则会按旧组的成员数渲染网格
    mockCanvasState.nodeGraph = {
      nodes: [
        buildGroupNode(),
        buildGroupNode("group-2", "组二"),
        { ...buildNode({ id: "g2-m1" }), groupId: "group-2" },
        { ...buildNode({ id: "g2-m2" }), groupId: "group-2" },
        { ...buildNode({ id: "g2-m3" }), groupId: "group-2" },
        { ...buildNode({ id: "g2-m4" }), groupId: "group-2" },
        { ...buildNode({ id: "g2-m5" }), groupId: "group-2" },
      ],
    };
    rerender(
      <CanvasContextMenu
        {...menuProps}
        target={
          {
            type: "node",
            nodeId: "group-2",
            position: { x: 0, y: 0 },
          } satisfies ContextMenuTarget
        }
      />,
    );

    expect(screen.queryByRole("group", { name: "整理本组：选择网格列数" })).toBeNull();
    expect(screen.queryByText("3 行 × 1 列 · 共 3 个节点")).toBeNull();
  });
});

describe("CanvasContextMenu Esc 逐级关闭（浮层栈派发）", () => {
  const onCloseMock = vi.fn();

  const renderGroupMenuWithDispatcher = () =>
    render(
      <>
        {/* 真实分发器：Esc 经浮层栈派发（spec docs/editor/浮层堆栈管理.md） */}
        <OverlayEscapeDispatcher />
        <CanvasContextMenu
          open
          target={
            {
              type: "node",
              nodeId: "group-1",
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
        />
      </>,
    );

  const pressEscape = () => {
    fireEvent.keyDown(document.body, { key: "Escape" });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCanvasState = {
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
      nodeGraph: {
        nodes: [
          buildGroupNode(),
          { ...buildNode({ id: "m1" }), groupId: "group-1" },
          { ...buildNode({ id: "m2" }), groupId: "group-1" },
        ],
      },
      mediaAssets: {},
      selectedNodeIds: ["group-1"],
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
  });

  // @spec: CM-018
  it("菜单打开时 Esc 关闭菜单（替代原先自挂的 document Esc 监听）", () => {
    renderGroupMenuWithDispatcher();

    pressEscape();

    expect(onCloseMock).toHaveBeenCalledTimes(1);
  });

  // @spec: CM-021
  it("子菜单展开时 Esc 先收子菜单（菜单保持打开），再按才关菜单（spec §5.5）", () => {
    renderGroupMenuWithDispatcher();
    fireEvent.click(screen.getByRole("menuitem", { name: "整理本组" }));
    expect(
      screen.getByRole("group", { name: "整理本组：选择网格列数" }),
    ).toBeInTheDocument();

    pressEscape();

    // 后开先关：子菜单独立成层，第一次 Esc 只收它。
    expect(
      screen.queryByRole("group", { name: "整理本组：选择网格列数" }),
    ).toBeNull();
    expect(onCloseMock).not.toHaveBeenCalled();

    pressEscape();

    expect(onCloseMock).toHaveBeenCalledTimes(1);
  });
});

const buildTaskNode = (id: string, status: TaskNodeData["status"]): GraphNode => ({
  id,
  type: "task",
  position: { x: 0, y: 0 },
  data: {
    label: "任务节点",
    modelId: "mock-model",
    taskId: `task-${id}`,
    taskIndex: 0,
    batchId: "batch-1",
    status,
    progressPercent: null,
    progressPhase: null,
    errorMessage: null,
    failure: null,
    createdAt: 1,
    updatedAt: 1,
  } satisfies TaskNodeData,
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

describe("CanvasContextMenu 删除失败节点", () => {
  const onCloseMock = vi.fn();

  const buildMockState = (nodes: GraphNode[]): MockCanvasContextMenuState => ({
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
    ui: { annotations: [] },
  });

  const renderPaneMenu = () =>
    render(
      <CanvasContextMenu
        open
        target={{ type: "pane", position: { x: 0, y: 0 } } satisfies ContextMenuTarget}
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
  });

  // @spec: CM-023
  it("菜单末尾提供「删除失败节点」并带失败节点数量，非失败状态不计入", () => {
    mockCanvasState = buildMockState([
      buildTaskNode("t-failed-1", "failed"),
      buildTaskNode("t-running", "generating"),
      buildTaskNode("t-failed-2", "failed"),
      buildTaskNode("t-succeeded", "succeeded"),
      buildNode(),
    ]);

    renderPaneMenu();

    const button = screen.getByRole("menuitem", { name: "删除失败节点（2）" });
    expect(button).toBeInTheDocument();
    expect(button).toBeEnabled();
    // 危险项以 destructive 样式呈现
    expect(button.className).toContain("text-destructive");
  });

  it("画布上没有失败节点时该项灰置且不可激活", () => {
    mockCanvasState = buildMockState([buildTaskNode("t-running", "generating")]);

    renderPaneMenu();

    const button = screen.getByRole("menuitem", { name: "删除失败节点" });
    expect(button).toBeDisabled();

    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockCanvasState.removeNodes).not.toHaveBeenCalled();
  });

  // @spec: CM-024
  it("激活先弹确认框列出数量，确认后按该集合删除并提示可撤销", () => {
    mockCanvasState = buildMockState([
      buildTaskNode("t-failed-1", "failed"),
      buildTaskNode("t-failed-2", "failed"),
    ]);

    renderPaneMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "删除失败节点（2）" }));

    // 菜单先关闭，确认框独立显示
    expect(onCloseMock).toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/将删除画布上 2 个生成失败的任务节点/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

    expect(mockCanvasState.removeNodes).toHaveBeenCalledWith(
      ["t-failed-1", "t-failed-2"],
      undefined,
    );
    expect(toast.success).toHaveBeenCalledWith("已删除 2 个失败节点，可撤销");
  });

  it("取消确认框不产生任何删除", () => {
    mockCanvasState = buildMockState([buildTaskNode("t-failed-1", "failed")]);

    renderPaneMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "删除失败节点（1）" }));

    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));

    expect(mockCanvasState.removeNodes).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

const buildAgentNode = (id = "agent-1"): GraphNode<AgentNodeData> => ({
  id,
  type: "agent",
  position: { x: 0, y: 0 },
  data: { label: "Agent 节点", agentSessionId: "session-1" },
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

describe("CanvasContextMenu Agent 节点解散/删除双动作", () => {
  const onCloseMock = vi.fn();

  const renderMenuFor = (nodeId: string) =>
    render(
      <CanvasContextMenu
        open
        target={{
          type: "node",
          nodeId,
          position: { x: 0, y: 0 },
        } satisfies ContextMenuTarget}
        screenPosition={{ x: 20, y: 20 }}
        onRequestBundleExport={vi.fn()}
        onRequestBundleImportInsert={vi.fn()}
        isBundleImportRunning={false}
        measuredSizeByNodeId={undefined}
        derivedSizeByNodeId={undefined}
        onClose={onCloseMock}
      />,
    );

  const seedState = (nodes: GraphNode[], selectedId: string) => {
    mockCanvasState = {
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
      selectedNodeIds: [selectedId],
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

  beforeEach(() => {
    vi.clearAllMocks();
    getNodeMediaUrlForRevealMock.mockReturnValue(null);
  });

  // @spec: CM-025
  it("容器形态 Agent 节点（有成员）：出现「解散」（aria-label 解散容器，容器行为组）与「删除」（aria-label 删除 Agent，危险组末尾）两项", () => {
    // @spec: CM-008
    seedState(
      [buildAgentNode(), { ...buildAgentNode("m1"), groupId: "agent-1" }],
      "agent-1",
    );
    renderMenuFor("agent-1");

    const dissolve = screen.getByRole("menuitem", { name: "解散容器" });
    expect(dissolve).toBeInTheDocument();
    expect(dissolve.textContent).toContain("解散");
    // 解散是容器组织动作，非危险项（spec §7.2b：移出危险分组）
    expect(dissolve.className).not.toContain("text-destructive");
    // 「删除」仍带平台快捷键展示
    expect(screen.getByRole("menuitem", { name: "删除 Agent" }).textContent).toContain(
      getCanvasDeleteShortcutLabel(false),
    );

    const del = screen.getByRole("menuitem", { name: "删除 Agent" });
    expect(del.className).toContain("text-destructive");
    // §5.2 危险项位于菜单末尾分组：最后一个菜单行即删除
    const buttons = screen.getAllByRole("menuitem");
    expect(buttons[buttons.length - 1]).toBe(del);
  });

  // @spec: CM-025
  it("激活「解散」→ 解除成员关系（不删节点、不经删除路径），toast 明示 Agent 与生成内容保留", () => {
    seedState(
      [buildAgentNode(), { ...buildAgentNode("m1"), groupId: "agent-1" }],
      "agent-1",
    );
    renderMenuFor("agent-1");

    fireEvent.click(screen.getByRole("menuitem", { name: "解散容器" }));

    expect(mockCanvasState.dissolveAgentContainer).toHaveBeenCalledWith("agent-1");
    expect(mockCanvasState.removeNodes).not.toHaveBeenCalled();
    expect(mockCanvasState.requestAgentDeleteConfirm).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("容器已解散，Agent 和生成内容都保留");
    expect(onCloseMock).toHaveBeenCalled();
  });

  // @spec: CM-025
  it("激活「删除」→ 先弹确认请求（不经确认不删除），关闭菜单", () => {
    seedState(
      [buildAgentNode(), { ...buildAgentNode("m1"), groupId: "agent-1" }],
      "agent-1",
    );
    renderMenuFor("agent-1");

    fireEvent.click(screen.getByRole("menuitem", { name: "删除 Agent" }));

    expect(mockCanvasState.requestAgentDeleteConfirm).toHaveBeenCalledWith(["agent-1"]);
    expect(mockCanvasState.removeNodes).not.toHaveBeenCalled();
    expect(mockCanvasState.dissolveAgentContainer).not.toHaveBeenCalled();
    expect(onCloseMock).toHaveBeenCalled();
  });

  // @spec: CM-025
  it("无成员 Agent 节点（单节点形态）：不出现「解散」，只出现「删除」", () => {
    seedState([buildAgentNode()], "agent-1");
    renderMenuFor("agent-1");

    expect(screen.queryByRole("menuitem", { name: "解散容器" })).toBeNull();
    const del = screen.getByRole("menuitem", { name: "删除 Agent" });
    expect(del).toBeInTheDocument();
    expect(del.className).toContain("text-destructive");

    fireEvent.click(del);
    expect(mockCanvasState.requestAgentDeleteConfirm).toHaveBeenCalledWith(["agent-1"]);
    expect(mockCanvasState.removeNodes).not.toHaveBeenCalled();
  });

  it("对象敏感：资产节点菜单仍为「删除」，不出现「解散」", () => {
    seedState([buildAssetNode()], "asset-1");
    renderMenuFor("asset-1");

    expect(screen.getByRole("menuitem", { name: /^删除/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "解散容器" })).toBeNull();
    // 非 Agent 目标的删除不经 Agent 确认通道
    fireEvent.click(screen.getByRole("menuitem", { name: /^删除/ }));
    expect(mockCanvasState.requestAgentDeleteConfirm).not.toHaveBeenCalled();
    expect(mockCanvasState.removeNodes).toHaveBeenCalledWith(["asset-1"], undefined);
  });
});
