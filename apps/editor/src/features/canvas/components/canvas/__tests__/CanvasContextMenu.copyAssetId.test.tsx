import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import type { ClipboardWriteTextResponse } from "@iart/contracts";
import type {
  AssetNodeData,
  GraphNode,
  ImageInputNodeData,
  VideoInputNodeData,
} from "@/features/canvas/types";
import type { ContextMenuTarget } from "@/features/canvas/types/clipboard";
import { CanvasContextMenu } from "../CanvasContextMenu";

/**
 * 「复制素材 ID」右键菜单项（spec：画布对象右键菜单.md §7.1 / @spec: CM-030）。
 * 只读情报动作：把节点 assetId 原文写系统剪贴板，不写画布剪贴板、不改选中集合。
 */

const writeTextToClipboardMock = vi.hoisted(() =>
  vi.fn<() => Promise<ClipboardWriteTextResponse>>(async () => ({ ok: true })),
);

type MockCanvasContextMenuState = {
  copySelectedNodes: ReturnType<typeof vi.fn>;
  pasteNodes: ReturnType<typeof vi.fn>;
  hasClipboardContent: ReturnType<typeof vi.fn>;
  removeNodes: ReturnType<typeof vi.fn>;
  dissolveAgentContainer: ReturnType<typeof vi.fn>;
  requestAgentDeleteConfirm: ReturnType<typeof vi.fn>;
  nodeGraph: { nodes: GraphNode[] };
  mediaAssets: Record<string, never>;
  selectedNodeIds: string[];
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
  useCanvasSelectionBridge: () => ({
    selectAnnotations: vi.fn(),
    selectEntireCanvas: vi.fn(),
    selectNodes: vi.fn(),
  }),
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
  writeTextToClipboard: (...args: Parameters<typeof writeTextToClipboardMock>) =>
    writeTextToClipboardMock(...args),
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

const ASSET_ID = "a1b2c3d4e5f60718";

const buildImageNode = (assetId: string | undefined): GraphNode<ImageInputNodeData> => ({
  id: "image-1",
  type: "imageInput",
  position: { x: 0, y: 0 },
  data: {
    label: "图片节点",
    description: undefined,
    runtimeRef: undefined,
    assetId,
    imageUrl: assetId === undefined ? null : "/files/archive-test.png",
    imageMeta: undefined,
    lastExecutionId: undefined,
    lastSourceNodeId: undefined,
    lastSourcePortId: undefined,
    valueSource: undefined,
    mediaError: undefined,
    taskInfo: undefined,
    cachedContent: undefined,
  } satisfies ImageInputNodeData,
  draggable: undefined,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

const buildVideoNode = (assetId: string | undefined): GraphNode<VideoInputNodeData> => ({
  id: "video-1",
  type: "videoInput",
  position: { x: 0, y: 0 },
  data: {
    label: "视频节点",
    description: undefined,
    runtimeRef: undefined,
    assetId,
    videoUrl: null,
    videoMeta: undefined,
    valueSource: undefined,
    mediaError: undefined,
    lastExecutionId: undefined,
    lastSourceNodeId: undefined,
    lastSourcePortId: undefined,
    taskInfo: undefined,
    cachedContent: undefined,
  } satisfies VideoInputNodeData,
  draggable: undefined,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

const buildAssetNode = (): GraphNode<AssetNodeData> => ({
  id: "asset-1",
  type: "asset",
  position: { x: 0, y: 0 },
  data: {
    label: "资产节点",
    sourceBatchId: "batch-1",
    sourceTaskId: "task-1",
    sourceModelId: "mock-model",
    mediaType: "image",
    assetId: ASSET_ID,
  } satisfies AssetNodeData,
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

const buildState = (nodes: GraphNode[], selectedNodeIds: string[]): void => {
  mockCanvasState = {
    copySelectedNodes: vi.fn(),
    pasteNodes: vi.fn(),
    hasClipboardContent: vi.fn(() => false),
    removeNodes: vi.fn(),
    dissolveAgentContainer: vi.fn(),
    requestAgentDeleteConfirm: vi.fn(),
    nodeGraph: { nodes },
    mediaAssets: {},
    selectedNodeIds,
  };
};

const renderNodeMenu = (nodeId: string, onClose = vi.fn()) => {
  render(
    <CanvasContextMenu
      open
      target={{ type: "node", nodeId, position: { x: 0, y: 0 } } satisfies ContextMenuTarget}
      screenPosition={{ x: 20, y: 20 }}
      onRequestBundleExport={vi.fn()}
      onRequestBundleImportInsert={vi.fn()}
      isBundleImportRunning={false}
      measuredSizeByNodeId={undefined}
      derivedSizeByNodeId={undefined}
      onClose={onClose}
    />,
  );
  return onClose;
};

describe("CanvasContextMenu 复制素材 ID", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeTextToClipboardMock.mockResolvedValue({ ok: true });
  });

  // @spec: CM-030
  it("持有素材 id 的素材节点出现该项，激活写入系统剪贴板并反馈", async () => {
    buildState([buildImageNode(ASSET_ID)], ["image-1"]);
    const onClose = renderNodeMenu("image-1");

    const copyItem = screen.getByRole("menuitem", { name: "复制 Ctrl+C" });
    const copyIdItem = screen.getByRole("menuitem", { name: "复制素材 ID" });
    // 与「复制」相邻、位于「删除」之前（spec §7.1 编辑与流转组顺序）
    expect(copyItem.compareDocumentPosition(copyIdItem) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const deleteItem = screen.getByRole("menuitem", { name: "删除 Delete" });
    expect(copyIdItem.compareDocumentPosition(deleteItem) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(copyIdItem);
    expect(writeTextToClipboardMock).toHaveBeenCalledWith(ASSET_ID);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("已复制素材 ID"));
    expect(onClose).toHaveBeenCalled();
  });

  // @spec: CM-030
  it("视频素材节点同样出现该项", () => {
    buildState([buildVideoNode(ASSET_ID)], ["video-1"]);
    renderNodeMenu("video-1");
    expect(screen.getByRole("menuitem", { name: "复制素材 ID" })).toBeInTheDocument();
  });

  // @spec: CM-030
  it("资产节点（生成产物）同样出现该项", () => {
    buildState([buildAssetNode()], ["asset-1"]);
    renderNodeMenu("asset-1");
    expect(screen.getByRole("menuitem", { name: "复制素材 ID" })).toBeInTheDocument();
  });

  // @spec: CM-030
  it("空内容素材节点（无 assetId）不出现该项", () => {
    buildState([buildImageNode(undefined)], ["image-1"]);
    renderNodeMenu("image-1");
    expect(screen.queryByRole("menuitem", { name: "复制素材 ID" })).toBeNull();
  });

  // @spec: CM-030
  it("多选目标不出现该项（2026-10-07 拍板：只做单选）", () => {
    buildState([buildImageNode(ASSET_ID), buildVideoNode(ASSET_ID)], ["image-1", "video-1"]);
    render(
      <CanvasContextMenu
        open
        target={
          {
            type: "selection",
            nodeIds: ["image-1", "video-1"],
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
    expect(screen.queryByRole("menuitem", { name: "复制素材 ID" })).toBeNull();
  });

  // @spec: CM-030
  it("写入失败时给错误反馈，不报成功", async () => {
    buildState([buildImageNode(ASSET_ID)], ["image-1"]);
    writeTextToClipboardMock.mockResolvedValue({ ok: false, reason: "invoke-failed" });
    const onClose = renderNodeMenu("image-1");

    fireEvent.click(screen.getByRole("menuitem", { name: "复制素材 ID" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("复制没有成功，请重试"));
    expect(toast.success).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
