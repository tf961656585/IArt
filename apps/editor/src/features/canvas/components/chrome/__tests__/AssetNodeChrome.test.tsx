import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { OverlayEscapeDispatcher } from '@iart/ui';
import type { GraphNode } from '@/features/canvas/types/node';
import type { AssetNodeData } from '@/features/canvas/types/taskNode';
import {
  createMediaAssetFixture,
  createMediaAssetMapFixture,
} from '../../__tests__/fixtures/canvasTestBuilders';

const deleteSelectedElements = vi.fn();

// 可变 store 快照：canvasStore mock 闭包引用，各用例经 seedStore 重写。
const storeRef: { state: Record<string, unknown> } = { state: {} };

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('../../../store/canvasStore', () => ({
  useCanvasStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(storeRef.state),
    {
      getState: () => storeRef.state,
      setState: (fn: (s: Record<string, unknown>) => void) => fn(storeRef.state),
    },
  ),
  markNodeDirty: vi.fn(),
}));

vi.mock('@xyflow/react', () => ({
  useStore: (selector: (s: unknown) => unknown) =>
    selector({
      transform: [0, 0, 1],
      nodeLookup: new Map(
        ((storeRef.state['nodeGraph'] as { nodes: Array<{ id: string }> })?.nodes ?? []).map(
          (n) => [
            n.id,
            {
              internals: { positionAbsolute: { x: 0, y: 0 }, z: 1 },
              measured: { width: 240, height: 180 },
              dragging: false,
            },
          ],
        ),
      ),
    }),
}));

vi.mock('../../canvas/useCanvasSelectionBridge', () => ({
  useCanvasSelectionBridge: () => ({ selectNodes: vi.fn() }),
}));

// 直接变换执行在组件测试中打桩（执行链路归 assetToolExecutors 专项覆盖）。
vi.mock('../assetToolExecutors', () => ({
  runDirectTransform: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/client/config/runtimeModelSelection', () => ({
  listRuntimeProjectedImageToImageModels: () => [],
}));

// 弹窗整体 stub：open 时渲染标记，验证「工具钮 → 打开对应弹窗」接线。
vi.mock('../../dialogs/ImageCropDialog', () => ({
  ImageCropDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="dialog-crop" /> : null),
}));
vi.mock('../../dialogs/ImageResizeDialog', () => ({
  ImageResizeDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="dialog-resize" /> : null,
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

import { usePromptDockStore } from '@/features/promptdock/promptDockStore';
import { AssetNodeChrome } from '../AssetNodeChrome';

const assetNode = (id: string, overrides: Partial<AssetNodeData> = {}): GraphNode => ({
  id,
  type: 'asset',
  position: { x: 0, y: 0 },
  data: {
    label: `资产 ${id}`,
    sourceBatchId: '',
    sourceTaskId: '',
    sourceModelId: '',
    mediaType: 'image',
    assetId: `asset-${id}`,
    ...overrides,
  } as AssetNodeData,
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

const seedStore = (nodes: GraphNode[], selectedNodeIds: string[]) => {
  storeRef.state = {
    nodeGraph: { id: 'g1', nodes, annotations: [] },
    selectedNodeIds,
    mediaAssets: createMediaAssetMapFixture([
      createMediaAssetFixture({ id: 'asset-a1' }),
      createMediaAssetFixture({ id: 'asset-a2' }),
      createMediaAssetFixture({ id: 'asset-a3', mediaType: 'audio' }),
    ]),
    deleteSelectedElements,
    removeNode: vi.fn(),
    updateNodeData: vi.fn(),
  };
  usePromptDockStore.setState((state) => ({
    draft: { ...state.draft, references: [] },
  }));
};

const renderChrome = () => {
  const canvasRef = { current: document.createElement('div') };
  return render(
    <>
      {/* 真实分发器：Esc 必须经浮层栈派发（spec docs/editor/浮层堆栈管理.md） */}
      <OverlayEscapeDispatcher />
      <AssetNodeChrome canvasRef={canvasRef} />
    </>,
  );
};

const bar = (testid: string) => screen.getByTestId(testid) as HTMLElement;
const queryIn = (testid: string, selector: string) =>
  bar(testid).querySelector(selector) as HTMLElement | null;

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AssetNodeChrome · 顶栏（D19 图片 12 工具）', () => {
  it('单选图片资产 → 顶栏渲染 12 个工具钮（A｜B 分组顺序）', () => {
    seedStore([assetNode('a1')], ['a1']);
    renderChrome();
    const top = bar('asset-chrome-top');
    const labels = Array.from(top.querySelectorAll('button')).map(
      (b) => b.getAttribute('aria-label') ?? '',
    );
    expect(labels).toEqual([
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
    expect(top.querySelectorAll('.grp')).toHaveLength(2);
    expect(top.querySelectorAll('.sep')).toHaveLength(1);
  });

  it('点击裁剪工具 → 打开裁剪弹窗（与素材节点入口同一 Dialog）', () => {
    seedStore([assetNode('a1')], ['a1']);
    renderChrome();
    fireEvent.click(screen.getByRole('button', { name: '裁剪图片' }));
    expect(screen.getByTestId('dialog-crop')).toBeTruthy();
  });

  it('音频资产无顶栏（O1 如实呈现），底栏仍在', () => {
    seedStore([assetNode('a3', { mediaType: 'audio', assetId: 'asset-a3' })], ['a3']);
    renderChrome();
    expect(screen.queryByTestId('asset-chrome-top')).toBeNull();
    expect(screen.getByTestId('asset-chrome-bottom')).toBeTruthy();
  });

  it('多选资产 → 顶栏隐藏，底栏批量「用作参考 · N 项」；点击加入全部图片', () => {
    seedStore([assetNode('a1'), assetNode('a2')], ['a1', 'a2']);
    renderChrome();
    expect(screen.queryByTestId('asset-chrome-top')).toBeNull();
    const batch = queryIn('asset-chrome-bottom', '[data-act="ref-batch"]');
    expect(batch?.textContent).toContain('用作参考 · 2 项');
    fireEvent.click(batch as HTMLElement);
    expect(
      usePromptDockStore.getState().draft.references.map((r) => r.assetId).sort(),
    ).toEqual(['asset-a1', 'asset-a2']);
  });

  it('非全资产选中（混入任务节点）→ 整体不渲染', () => {
    const task: GraphNode = { ...assetNode('t1'), type: 'task' };
    seedStore([assetNode('a1'), task], ['a1', 't1']);
    const { container } = renderChrome();
    expect(container.textContent).toBe('');
  });
});

describe('AssetNodeChrome · 底栏（D21 用作参考｜复用｜删除）', () => {
  it('导入资产无复用钮；生成资产（sourceModelId）有复用钮', () => {
    seedStore([assetNode('a1')], ['a1']);
    renderChrome();
    expect(screen.queryByText('复用')).toBeNull();
    cleanup();

    seedStore([assetNode('a1', { sourceModelId: 'gpt-image-2', sourceTaskId: 't1' })], ['a1']);
    renderChrome();
    expect(screen.getByText('复用')).toBeTruthy();
  });

  it('用作参考 → 写入 PromptDock 草稿参考区，钮转「取消参考」活跃态；再点移除', () => {
    seedStore([assetNode('a1')], ['a1']);
    renderChrome();
    const refBtn = queryIn('asset-chrome-bottom', '[data-act="ref"]');
    expect(refBtn).toBeTruthy();
    fireEvent.click(refBtn as HTMLElement);
    expect(usePromptDockStore.getState().draft.references.map((r) => r.assetId)).toEqual([
      'asset-a1',
    ]);
    const refBtn2 = queryIn('asset-chrome-bottom', '[data-act="ref"]');
    expect(refBtn2?.getAttribute('data-active')).toBe('true');
    expect(refBtn2?.textContent).toContain('取消参考');
    fireEvent.click(refBtn2 as HTMLElement);
    expect(usePromptDockStore.getState().draft.references).toHaveLength(0);
  });

  it('删除 inline 确认：del → 确认删除翻转；确认触发 deleteSelectedElements；Esc 取消', () => {
    seedStore([assetNode('a1')], ['a1']);
    renderChrome();
    fireEvent.click(queryIn('asset-chrome-bottom', '[data-act="del"]') as HTMLElement);
    expect(queryIn('asset-chrome-bottom', '[data-act="del-confirm"]')).toBeTruthy();
    expect(deleteSelectedElements).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(queryIn('asset-chrome-bottom', '[data-act="del"]')).toBeTruthy();

    fireEvent.click(queryIn('asset-chrome-bottom', '[data-act="del"]') as HTMLElement);
    fireEvent.click(queryIn('asset-chrome-bottom', '[data-act="del-confirm"]') as HTMLElement);
    expect(deleteSelectedElements).toHaveBeenCalledTimes(1);
  });
});
