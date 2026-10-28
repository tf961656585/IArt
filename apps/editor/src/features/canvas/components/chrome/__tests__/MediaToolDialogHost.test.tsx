import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { MediaAsset } from '@iart/contracts';
import type { AssetNodeData, GraphNode } from '@/features/canvas/types';

/**
 * 媒体加工弹窗宿主（spec：docs/editor/媒体工具加工.md「入口表面」/@spec: CM-031）。
 *
 * 宿主是两处加工入口（工具栏、画布右键菜单）共用的唯一弹窗渲染点：
 * `open` 请求 + 画布主体投影决定打开哪个弹窗，主体不可用即自动关闭。
 */

const selectNodesMock = vi.hoisted(() => vi.fn());

const storeRef: { state: Record<string, unknown> } = { state: {} };

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('../../../store/canvasStore', () => ({
  useCanvasStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(storeRef.state),
}));

vi.mock('../../canvas/useCanvasSelectionBridge', () => ({
  useCanvasSelectionBridge: () => ({ selectNodes: selectNodesMock }),
}));

vi.mock('@/client/config/runtimeModelSelection', () => ({
  listRuntimeProjectedImageToImageModels: () => [],
}));

// 执行器只在本测试里作占位：确认按钮接线由菜单/执行器各自的专项测试覆盖。
vi.mock('../mediaToolExecutors', () => ({
  runAnnotate: vi.fn(),
  runChromaKey: vi.fn(),
  runCrop: vi.fn(),
  runDiffKey: vi.fn(),
  runEdgeDetect: vi.fn(),
  runFrameCapture: vi.fn(),
  runOutpaint: vi.fn(),
  runResize: vi.fn(),
  runSmartSplit: vi.fn(),
  runSplit: vi.fn(),
  runSpriteSheet: vi.fn(),
  runTrim: vi.fn(),
}));

vi.mock('../../dialogs/ImageCropDialog', () => ({
  ImageCropDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="dialog-crop" /> : null),
}));
vi.mock('../../dialogs/ImageResizeDialog', () => ({
  ImageResizeDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="dialog-resize" /> : null),
}));
vi.mock('../../dialogs/ImageSplitDialog', () => ({
  ImageSplitDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="dialog-split" /> : null),
}));
vi.mock('../../dialogs/ImageSmartSplitDialog', () => ({
  ImageSmartSplitDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="dialog-smartsplit" /> : null,
}));
vi.mock('../../dialogs/ImageOutpaintDialog', () => ({
  ImageOutpaintDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="dialog-outpaint" /> : null,
}));
vi.mock('../../dialogs/ImageEdgeDetectDialog', () => ({
  ImageEdgeDetectDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="dialog-edgedetect" /> : null,
}));
vi.mock('../../dialogs/ImageChromaKeyDialog', () => ({
  ImageChromaKeyDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="dialog-chromakey" /> : null,
}));
vi.mock('../../dialogs/ImageDifferenceKeyDialog', () => ({
  ImageDifferenceKeyDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="dialog-diffkey" /> : null,
}));
vi.mock('../../dialogs/ImageAnnotateDialog', () => ({
  ImageAnnotateDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="dialog-annotate" /> : null,
}));
vi.mock('../../dialogs/VideoTrimDialog', () => ({
  VideoTrimDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="dialog-trim" /> : null),
}));
vi.mock('../../dialogs/VideoFrameCaptureDialog', () => ({
  VideoFrameCaptureDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="dialog-framecapture" /> : null,
}));
vi.mock('../../dialogs/VideoSpriteSheetDialog', () => ({
  VideoSpriteSheetDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="dialog-spritesheet" /> : null,
}));

import {
  closeMediaToolDialog,
  openMediaToolDialog,
  useMediaToolDialogStore,
} from '../mediaToolDialogStore';
import { MediaToolDialogHost } from '../MediaToolDialogHost';

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

const assetNode = (id: string, mediaType: 'image' | 'video', assetId: string): GraphNode => ({
  id,
  type: 'asset',
  position: { x: 0, y: 0 },
  data: {
    label: `资产 ${id}`,
    sourceBatchId: '',
    sourceTaskId: '',
    sourceModelId: '',
    mediaType,
    assetId,
  } satisfies AssetNodeData,
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

const seedStore = (nodes: GraphNode[], selectedNodeIds: string[]): void => {
  storeRef.state = {
    nodeGraph: { id: 'g1', nodes, annotations: [] },
    selectedNodeIds,
    mediaAssets: {
      [IMAGE_ASSET_ID]: createMediaAsset(IMAGE_ASSET_ID, 'image'),
      [VIDEO_ASSET_ID]: createMediaAsset(VIDEO_ASSET_ID, 'video'),
    },
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  closeMediaToolDialog();
});

describe('MediaToolDialogHost', () => {
  // @spec: CM-031
  it('图片主体 + 裁剪工具请求 → 只打开裁剪弹窗（其余弹窗不渲染）', () => {
    seedStore([assetNode('asset-image', 'image', IMAGE_ASSET_ID)], ['asset-image']);
    openMediaToolDialog('asset-image', 'crop');
    render(<MediaToolDialogHost />);

    expect(screen.getByTestId('dialog-crop')).toBeInTheDocument();
    expect(screen.queryByTestId('dialog-annotate')).toBeNull();
    expect(screen.queryByTestId('dialog-trim')).toBeNull();
  });

  // @spec: CM-031
  it('视频主体 + 裁切工具请求 → 打开视频裁切弹窗', () => {
    seedStore([assetNode('asset-video', 'video', VIDEO_ASSET_ID)], ['asset-video']);
    openMediaToolDialog('asset-video', 'trim');
    render(<MediaToolDialogHost />);

    expect(screen.getByTestId('dialog-trim')).toBeInTheDocument();
    expect(screen.queryByTestId('dialog-crop')).toBeNull();
  });

  // @spec: CM-031
  it('节点已删除 → 自动关闭并清理请求', async () => {
    seedStore([], []);
    openMediaToolDialog('asset-image', 'crop');
    render(<MediaToolDialogHost />);

    await waitFor(() => expect(useMediaToolDialogStore.getState().open).toBeNull());
    expect(screen.queryByTestId('dialog-crop')).toBeNull();
  });

  // @spec: CM-031
  it('资产不可访问（注册表无条目）→ 自动关闭', async () => {
    seedStore([assetNode('asset-image', 'image', 'ffffffffffffffff')], ['asset-image']);
    openMediaToolDialog('asset-image', 'crop');
    render(<MediaToolDialogHost />);

    await waitFor(() => expect(useMediaToolDialogStore.getState().open).toBeNull());
  });

  // @spec: CM-031
  it('工具与媒体类型不匹配（图片主体 + 视频工具）→ 自动关闭', async () => {
    seedStore([assetNode('asset-image', 'image', IMAGE_ASSET_ID)], ['asset-image']);
    openMediaToolDialog('asset-image', 'trim');
    render(<MediaToolDialogHost />);

    await waitFor(() => expect(useMediaToolDialogStore.getState().open).toBeNull());
  });

  // @spec: CM-031
  it('节点脱离选中集合 → 自动关闭', async () => {
    seedStore([assetNode('asset-image', 'image', IMAGE_ASSET_ID)], ['asset-image']);
    openMediaToolDialog('asset-image', 'crop');
    const view = render(<MediaToolDialogHost />);
    expect(screen.getByTestId('dialog-crop')).toBeInTheDocument();

    seedStore([assetNode('asset-image', 'image', IMAGE_ASSET_ID)], []);
    view.rerender(<MediaToolDialogHost />);

    await waitFor(() => expect(useMediaToolDialogStore.getState().open).toBeNull());
  });
});
