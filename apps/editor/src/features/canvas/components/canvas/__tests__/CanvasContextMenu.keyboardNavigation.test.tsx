import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { OverlayEscapeDispatcher } from "@iart/ui";
import type { GraphNode } from "@/features/canvas/types";
import type { ContextMenuTarget } from "@/features/canvas/types/clipboard";
import { CanvasContextMenu } from "../CanvasContextMenu";

/**
 * 对象右键菜单键盘导航（spec：docs/editor/画布对象右键菜单.md §5.5 / CM-010；
 * CM-011 Shift+F10 键盘呼出不在本轮范围）。
 *
 * 导航基元：@iart/ui useRovingListNavigation（形态 2，真实焦点移动）。
 * 与 `CanvasContextMenu.test.tsx` 同一套 mock 接线。
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
  revealTaskArchive: vi.fn(async () => ({ ok: true })),
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

vi.mock("../../../utils/nodeMediaUrlRegistry", () => ({
  getNodeMediaUrlForReveal: vi.fn(() => null),
}));

const buildNode = (id = "node-1"): GraphNode => ({
  id,
  type: "imageInput",
  position: { x: 0, y: 0 },
  data: {
    label: "图片节点",
    description: undefined,
    runtimeRef: undefined,
    assetId: undefined,
    imageUrl: null,
    imageMeta: undefined,
    lastExecutionId: undefined,
    lastSourceNodeId: undefined,
    lastSourcePortId: undefined,
    valueSource: undefined,
    mediaError: undefined,
    taskInfo: undefined,
    cachedContent: undefined,
  },
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

const buildGroupNode = (id = "group-1", collapsed = false): GraphNode => ({
  id,
  type: "group",
  position: { x: 0, y: 0 },
  data: {
    label: "节点组",
    description: undefined,
    runtimeRef: undefined,
    name: "组一",
    collapsed,
    color: undefined,
  },
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

const buildState = (overrides?: Partial<MockCanvasContextMenuState>) => {
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
    nodeGraph: { nodes: [buildNode()] },
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
    ...overrides,
  };
};

const paneTarget = {
  type: "pane",
  position: { x: 0, y: 0 },
} satisfies ContextMenuTarget;

const groupTarget = {
  type: "node",
  nodeId: "group-1",
  position: { x: 0, y: 0 },
} satisfies ContextMenuTarget;

const renderMenu = (target: ContextMenuTarget, onClose = vi.fn()) =>
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
      onClose={onClose}
    />,
  );

const getMainMenuPanel = (): HTMLElement => {
  const panel = document.querySelector("[data-canvas-context-menu]");
  if (panel === null) throw new Error("主菜单面板未渲染");
  return panel as HTMLElement;
};

const activeMenuItemName = (): string | null => {
  const active = document.activeElement;
  return active instanceof HTMLElement ? active.textContent : null;
};

const pressKey = (key: string) => {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) throw new Error("无焦点元素");
  fireEvent.keyDown(active, { key });
};

/**
 * 空白区菜单（画布段）的可用项序列（hasClipboard=false、无失败节点）：
 * 导入并插入 → [粘贴（禁用，跳过）] → 全选 → 创建注释 → [删除失败节点（禁用，跳过）]。
 */
describe("CanvasContextMenu 主菜单键盘导航", () => {
  // @spec: CM-010
  beforeEach(() => {
    vi.clearAllMocks();
    buildState();
  });

  it("菜单面板为 role=menu，动作行与子菜单触发项为 role=menuitem", () => {
    renderMenu(paneTarget);

    expect(getMainMenuPanel()).toHaveAttribute("role", "menu");
    const items = screen.getAllByRole("menuitem");
    // 粘贴/删除失败节点灰置但不隐藏：5 行全部在序列外可见（禁用项跳过由导航承担）
    expect(items).toHaveLength(5);
    for (const item of items) {
      expect(item.tagName).toBe("BUTTON");
    }
  });

  it("打开即聚焦第一个可用项（禁用的「粘贴」不占位）", () => {
    renderMenu(paneTarget);

    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "导入并插入" }),
    );
  });

  it("ArrowDown 在可用项间移动并跳过禁用项，末尾绕回首项", () => {
    renderMenu(paneTarget);

    // 导入并插入 → 跳过禁用的粘贴（可访问名含快捷键尾巴）→ 全选
    pressKey("ArrowDown");
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: /^全选/ }),
    );

    pressKey("ArrowDown");
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "创建注释" }),
    );

    // 末个可用项（删除失败节点禁用被跳过）再向下 → 绕回首项
    pressKey("ArrowDown");
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "导入并插入" }),
    );
  });

  it("ArrowUp 反向移动、反向绕回末个可用项", () => {
    renderMenu(paneTarget);

    // 首项向上 → 绕回末个可用项（禁用的删除失败节点被跳过）
    pressKey("ArrowUp");
    expect(activeMenuItemName()).toContain("创建注释");

    pressKey("ArrowUp");
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: /^全选/ }),
    );
  });

  it("Home 跳首可用项，End 跳末可用项", () => {
    renderMenu(paneTarget);

    pressKey("End");
    expect(activeMenuItemName()).toContain("创建注释");

    pressKey("Home");
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "导入并插入" }),
    );
  });

  it("色板行的色点不进 roving 序列，方向键跳过整行（行内控件由 Tab 可达）", () => {
    buildState({
      selectedNodeIds: ["group-1"],
      nodeGraph: {
        nodes: [
          buildGroupNode(),
          { ...buildNode("m1"), groupId: "group-1" },
          { ...buildNode("m2"), groupId: "group-1" },
          { ...buildNode("m3"), groupId: "group-1" },
        ],
      },
    });
    renderMenu(groupTarget);

    // 色点是普通 button，不是 menuitem
    const swatchDots = screen.getAllByRole("button");
    expect(swatchDots.length).toBeGreaterThan(0);
    const menuItemSet = new Set(screen.getAllByRole("menuitem"));
    for (const dot of swatchDots) {
      expect(menuItemSet.has(dot)).toBe(false);
    }

    // DOM 上折叠组与整理本组之间隔着色板行，导航序列里相邻：一次向下即到
    screen.getByRole("menuitem", { name: "折叠组" }).focus();
    pressKey("ArrowDown");
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "整理本组" }),
    );
  });

  it("焦点在子菜单触发项上按 ArrowRight 展开子菜单，焦点交给子菜单内第一个可用控件", () => {
    buildState({
      selectedNodeIds: ["group-1"],
      nodeGraph: {
        nodes: [
          buildGroupNode(),
          { ...buildNode("m1"), groupId: "group-1" },
          { ...buildNode("m2"), groupId: "group-1" },
          { ...buildNode("m3"), groupId: "group-1" },
        ],
      },
    });
    renderMenu(groupTarget);

    const trigger = screen.getByRole("menuitem", { name: "整理本组" });
    trigger.focus();

    fireEvent.keyDown(trigger, { key: "ArrowRight" });

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("group", { name: "整理本组：选择网格列数" }),
    ).toBeInTheDocument();
    // 子菜单内第一个可用控件 = 网格第一格（1 列）
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "整理为 3 行 1 列" }),
    );
  });

  it("禁用的触发项按 ArrowRight 不展开、不消费", () => {
    buildState({
      selectedNodeIds: ["group-1"],
      nodeGraph: { nodes: [buildGroupNode()] },
    });
    renderMenu(groupTarget);

    const trigger = screen.getByRole("menuitem", { name: "整理本组" });
    expect(trigger).toBeDisabled();
    trigger.focus();

    fireEvent.keyDown(trigger, { key: "ArrowRight" });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: "整理本组：选择网格列数" })).toBeNull();
  });
});

describe("CanvasContextMenu 菜单关闭后焦点交还触发来源", () => {
  const onCloseMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    onCloseMock.mockClear();
    buildState();
  });

  it("Esc 关闭菜单后焦点交还打开菜单前聚焦的元素（spec §5.5）", () => {
    const menuProps = {
      screenPosition: { x: 20, y: 20 },
      onRequestBundleExport: vi.fn(),
      onRequestBundleImportInsert: vi.fn(),
      isBundleImportRunning: false,
      measuredSizeByNodeId: undefined,
      derivedSizeByNodeId: undefined,
      onClose: onCloseMock,
    } satisfies Omit<React.ComponentProps<typeof CanvasContextMenu>, "open" | "target">;

    const { rerender } = render(
      <>
        <OverlayEscapeDispatcher />
        <button type="button" data-testid="sentinel">
          画布对象
        </button>
        <CanvasContextMenu {...menuProps} open={false} target={null} />
      </>,
    );
    const sentinel = screen.getByTestId("sentinel");
    sentinel.focus();
    expect(document.activeElement).toBe(sentinel);

    rerender(
      <>
        <OverlayEscapeDispatcher />
        <button type="button" data-testid="sentinel">
          画布对象
        </button>
        <CanvasContextMenu {...menuProps} open target={paneTarget} />
      </>,
    );
    // 打开即入键盘流
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "导入并插入" }),
    );

    // Esc：浮层栈派发关闭
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onCloseMock).toHaveBeenCalledTimes(1);

    // 宿主按 onClose 结果关菜单 → 焦点交还触发来源
    rerender(
      <>
        <OverlayEscapeDispatcher />
        <button type="button" data-testid="sentinel">
          画布对象
        </button>
        <CanvasContextMenu {...menuProps} open={false} target={null} />
      </>,
    );
    expect(document.activeElement).toBe(sentinel);
  });
});
