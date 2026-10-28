import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { MediaAsset } from '@iart/contracts';
import type { AssetNodeData, GraphNode, ImageInputNodeData } from '@/features/canvas/types';
import type { ContextMenuTarget } from '@/features/canvas/types/clipboard';
import { CanvasContextMenu } from '../CanvasContextMenu';

/**
 * 画布右键菜单「加工」子菜单（spec：docs/editor/媒体工具加工.md「入口表面」/
 * 画布对象右键菜单.md §7.1 / @spec: CM-031）。
 *
 * 入口只表达「对哪个节点用哪个工具」：直接变换点即执行（经 useCanvasSelectionBridge
 * 注入派生节点选中），弹窗工具只登记打开请求（弹窗与执行归 MediaToolDialogHost）。
 */

const selectNodesMock = vi.hoisted(() => vi.fn());
const openMediaToolDialogMock = vi.hoisted(() => vi.fn());
const runDirectTransformMock = vi.hoisted(() =>
  vi.fn<(ctx: unknown, toolId: string) => Promise<void>>(async () => undefined),
);

type MockCanvasContextMenuState = {
  copySelectedNodes: ReturnType<typeof vi.fn>;
  pasteNodes: ReturnType<typeof vi.fn>;
  hasClipboardContent: ReturnType<typeof vi.fn>;
  removeNodes: ReturnType<typeof vi.fn>;
  dissolveAgentContainer: ReturnType<typeof vi.fn>;
  requestAgentDeleteConfirm: ReturnType<typeof vi.fn>;
  nodeGraph: { nodes: GraphNode[] };
  mediaAssets: Record<string, MediaAsset>;
  selectedNodeIds: string[];
};

let mockCanvasState: MockCanvasContextMenuState;

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../../../store/canvasStore', () => {
  const useCanvasStore = <T,>(selector: (state: MockCanvasContextMenuState) => T) =>
    selector(mockCanvasState);
  useCanvasStore.getState = () => mockCanvasState;
  return { useCanvasStore };
});

vi.mock('../useCanvasSelectionBridge', () => ({
  useCanvasSelectionBridge: () => ({
    selectAnnotations: vi.fn(),
    selectEntireCanvas: vi.fn(),
    selectNodes: selectNodesMock,
  }),
}));

vi.mock('../../../store/characterUIStore', () => ({
  useCharacterUIStore: <T,>(
    selector: (state: { openSaveDialog: ReturnType<typeof vi.fn> }) => T,
  ) => selector({ openSaveDialog: vi.fn() }),
}));

vi.mock('../../../store/executionStore', () => {
  const useExecutionStore = <T,>(
    selector: (state: { getTransientNodeOutputs: () => undefined }) => T,
  ) => selector({ getTransientNodeOutputs: () => undefined });
  useExecutionStore.getState = () => ({
    getTransientNodeOutputs: () => undefined,
  });
  return { useExecutionStore };
});

vi.mock('@/client/store/runtimeStore', () => ({
  getRuntimeProjectPath: () => '/tmp/demo.iartproj',
}));

vi.mock('@iart/backend-sdk/electron-bridge', () => ({
  revealTaskArchive: vi.fn(async () => ({ ok: true })),
  writeTextToClipboard: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/client/utils/revealFilesUrlWithToast', () => ({
  revealFilesUrlWithToast: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../../services/projectMediaAssets', () => ({
  resolveMediaSlotType: vi.fn(),
  resolveMediaSlotValue: vi.fn(),
}));

vi.mock('../../../clipboard/selectionPayload', () => ({
  buildClipboardPayloadFromSelection: vi.fn(),
}));

vi.mock('../../../services/snippetTransfer', () => ({
  buildNodeGraphSnippetFromClipboardPayload: vi.fn(),
}));

vi.mock('../../../utils/nodeMediaUrlRegistry', () => ({
  getNodeMediaUrlForReveal: vi.fn(() => null),
}));

// 执行器与弹窗宿主是加工链路的专项覆盖对象，这里只验证菜单接线。
vi.mock('../../chrome/mediaToolExecutors', () => ({
  runDirectTransform: runDirectTransformMock,
}));

vi.mock('../../chrome/mediaToolDialogStore', () => ({
  openMediaToolDialog: openMediaToolDialogMock,
  closeMediaToolDialog: vi.fn(),
}));

const IMAGE_ASSET_ID = 'a1b2c3d4e5f60718';
const VIDEO_ASSET_ID = 'b1b2c3d4e5f60718';

const createMediaAsset = (id: string, mediaType: 'image' | 'video'): MediaAsset => ({
  id,
  mediaType,
  original: {
    url: `/project-media/project-a/${id}`,
    projectRef: 'project-a',
    fileKey: `${mediaType}s/${id}`,
    sourceUrl: `/files/${id}`,
    sourceFileName: null,
    mimeType: mediaType === 'image' ? 'image/png' : 'video/mp4',
    sizeBytes: 1024,
    width: 800,
    height: 600,
    durationMs: mediaType === 'image' ? null : 5000,
    fps: mediaType === 'image' ? null : 24,
  },
  thumbnail: {
    url: null,
    mimeType: null,
    width: null,
    height: null,
    status: 'missing',
    generatedAt: null,
    error: null,
  },
  lifecycle: { createdAt: 1, updatedAt: 1 },
});

const imageAssetNode: GraphNode = {
  id: 'asset-image',
  type: 'asset',
  position: { x: 0, y: 0 },
  data: {
    label: '图片资产',
    sourceBatchId: '',
    sourceTaskId: '',
    sourceModelId: '',
    mediaType: 'image',
    assetId: IMAGE_ASSET_ID,
  } satisfies AssetNodeData,
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
};

const videoAssetNode: GraphNode = {
  id: 'asset-video',
  type: 'asset',
  position: { x: 0, y: 0 },
  data: {
    label: '视频资产',
    sourceBatchId: '',
    sourceTaskId: '',
    sourceModelId: '',
    mediaType: 'video',
    assetId: VIDEO_ASSET_ID,
  } satisfies AssetNodeData,
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
};

const unregisteredImageInputNode: GraphNode = {
  id: 'image-input',
  type: 'imageInput',
  position: { x: 0, y: 0 },
  data: {
    label: '图片素材',
    description: undefined,
    runtimeRef: undefined,
    assetId: 'c1b2c3d4e5f60718',
    imageUrl: '/local/image.png',
    imageMeta: null,
    lastExecutionId: undefined,
    lastSourceNodeId: undefined,
    lastSourcePortId: undefined,
    valueSource: 'upload',
    mediaError: undefined,
    taskInfo: undefined,
    cachedContent: undefined,
  } satisfies ImageInputNodeData,
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
};

const taskNode: GraphNode = {
  ...imageAssetNode,
  id: 'task-1',
  type: 'task',
};

const buildState = (nodes: GraphNode[], selectedNodeIds: string[]): void => {
  mockCanvasState = {
    copySelectedNodes: vi.fn(),
    pasteNodes: vi.fn(),
    hasClipboardContent: vi.fn(() => false),
    removeNodes: vi.fn(),
    dissolveAgentContainer: vi.fn(),
    requestAgentDeleteConfirm: vi.fn(),
    nodeGraph: { nodes },
    mediaAssets: {
      [IMAGE_ASSET_ID]: createMediaAsset(IMAGE_ASSET_ID, 'image'),
      [VIDEO_ASSET_ID]: createMediaAsset(VIDEO_ASSET_ID, 'video'),
    },
    selectedNodeIds,
  };
};

const renderMenu = (target: ContextMenuTarget, onClose = vi.fn()) => {
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
  return onClose;
};

const renderNodeMenu = (nodeId: string, onClose = vi.fn()) =>
  renderMenu({ type: 'node', nodeId, position: { x: 0, y: 0 } }, onClose);

const openToolSubmenu = (): void => {
  fireEvent.click(screen.getByRole('menuitem', { name: '加工' }));
};

const submenuLabels = (): string[] =>
  screen
    .getAllByRole('menuitem')
    .map((item) => item.textContent ?? '')
    .filter((label) =>
      [
        '水平镜像',
        '垂直镜像',
        '旋转 90°',
        '裁剪图片',
        '调整尺寸',
        '图片分割',
        '智能切图',
        '扩图',
        '边缘检测',
        '色度抠图',
        '差异抠图',
        '画笔标注',
        '裁切视频',
        '截取帧',
        '序列帧图集',
      ].includes(label),
    );

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CanvasContextMenu · 加工子菜单', () => {
  // @spec: CM-031
  it('单节点图片资产：出现「加工」子菜单，工具清单与工具栏同源（12 项、A｜B 顺序）', () => {
    buildState([imageAssetNode], [imageAssetNode.id]);
    renderNodeMenu(imageAssetNode.id);

    expect(screen.getByRole('menuitem', { name: '加工' })).toBeInTheDocument();
    openToolSubmenu();
    expect(submenuLabels()).toEqual([
      '水平镜像',
      '垂直镜像',
      '旋转 90°',
      '裁剪图片',
      '调整尺寸',
      '图片分割',
      '智能切图',
      '扩图',
      '边缘检测',
      '色度抠图',
      '差异抠图',
      '画笔标注',
    ]);
  });

  // @spec: CM-031
  it('弹窗工具项只登记打开请求并先关闭菜单（弹窗与执行归宿主）', () => {
    buildState([imageAssetNode], [imageAssetNode.id]);
    const onClose = renderNodeMenu(imageAssetNode.id);

    openToolSubmenu();
    fireEvent.click(screen.getByRole('menuitem', { name: '裁剪图片' }));

    expect(onClose).toHaveBeenCalled();
    expect(openMediaToolDialogMock).toHaveBeenCalledWith(imageAssetNode.id, 'crop');
    expect(runDirectTransformMock).not.toHaveBeenCalled();
  });

  // @spec: CM-031
  it('直接变换项点即执行，选中通道复用画布选择桥', () => {
    buildState([imageAssetNode], [imageAssetNode.id]);
    const onClose = renderNodeMenu(imageAssetNode.id);

    openToolSubmenu();
    fireEvent.click(screen.getByRole('menuitem', { name: '水平镜像' }));

    expect(onClose).toHaveBeenCalled();
    expect(runDirectTransformMock).toHaveBeenCalledTimes(1);
    const firstCall = runDirectTransformMock.mock.calls[0];
    expect(firstCall?.[1]).toBe('mirrorX');
    expect(firstCall?.[0]).toMatchObject({ subject: { node: { id: imageAssetNode.id } } });
    const ctxArg = firstCall?.[0];
    const ctxSelectNodes =
      typeof ctxArg === 'object' && ctxArg !== null && 'selectNodes' in ctxArg
        ? (ctxArg as { selectNodes: unknown }).selectNodes
        : undefined;
    expect(ctxSelectNodes).toBe(selectNodesMock);
    expect(openMediaToolDialogMock).not.toHaveBeenCalled();
  });

  // @spec: CM-031
  it('视频资产只出现视频三工具（无直接变换项）', () => {
    buildState([videoAssetNode], [videoAssetNode.id]);
    renderNodeMenu(videoAssetNode.id);

    openToolSubmenu();
    expect(submenuLabels()).toEqual(['裁切视频', '截取帧', '序列帧图集']);
  });

  // @spec: CM-031
  it('资产不可访问（未在注册表登记）→ 不出现「加工」', () => {
    buildState([unregisteredImageInputNode], [unregisteredImageInputNode.id]);
    mockCanvasState.mediaAssets = {};
    renderNodeMenu(unregisteredImageInputNode.id);

    expect(screen.queryByRole('menuitem', { name: '加工' })).toBeNull();
  });

  // @spec: CM-031
  it('非媒体节点（任务节点）→ 不出现「加工」', () => {
    buildState([taskNode], [taskNode.id]);
    renderNodeMenu(taskNode.id);

    expect(screen.queryByRole('menuitem', { name: '加工' })).toBeNull();
  });

  // @spec: CM-031
  it('多选目标 → 不出现「加工」（工具只作用单资产）', () => {
    buildState([imageAssetNode, videoAssetNode], [imageAssetNode.id, videoAssetNode.id]);
    renderMenu({
      type: 'selection',
      nodeIds: [imageAssetNode.id, videoAssetNode.id],
      position: { x: 0, y: 0 },
    });

    expect(screen.queryByRole('menuitem', { name: '加工' })).toBeNull();
  });
});
