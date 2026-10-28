import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { OverlayEscapeDispatcher } from '@iart/ui';
import type { GraphNode } from '@/features/canvas/types/node';
import type { ImageInputNodeData } from '@/features/canvas/types/nodeDataTypes';
import type { AssetNodeData } from '@/features/canvas/types/taskNode';
import type { PromptDockCatalogEntry } from '@/client/api/promptDockApi';
import {
  createMediaAssetFixture,
  createMediaAssetMapFixture,
} from '../../__tests__/fixtures/canvasTestBuilders';

const deleteSelectedElements = vi.fn();
const mockedOpenMediaTool = vi.mocked(openMediaToolDialog);

// 可变 store 快照：canvasStore mock 闭包引用，各用例经 seedStore 重写。
const storeRef: { state: Record<string, unknown> } = { state: {} };
// 拖拽态开关：chrome 在拖动期间必须保持可见（用户裁决）。
let nodeDragging = false;

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
              dragging: nodeDragging,
            },
          ],
        ),
      ),
    }),
}));

vi.mock('../../canvas/useCanvasSelectionBridge', () => ({
  useCanvasSelectionBridge: () => ({ selectNodes: vi.fn() }),
}));

// 直接变换执行在组件测试中打桩（执行链路归 mediaToolExecutors 专项覆盖）。
vi.mock('../mediaToolExecutors', () => ({
  runDirectTransform: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/client/config/runtimeModelSelection', () => ({
  listRuntimeProjectedImageToImageModels: () => [],
}));

vi.mock('../mediaToolDialogStore', () => ({
  openMediaToolDialog: vi.fn(),
  closeMediaToolDialog: vi.fn(),
  useMediaToolDialogStore: (selector: (s: { open: unknown }) => unknown) =>
    selector({ open: null }),
}));

import { usePromptDockStore } from '@/features/promptdock/promptDockStore';
import { openMediaToolDialog } from '../mediaToolDialogStore';
import { MediaNodeChrome } from '../MediaNodeChrome';

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

const imageInputNode = (id: string, overrides: Partial<ImageInputNodeData> = {}): GraphNode => ({
  id,
  type: 'imageInput',
  position: { x: 0, y: 0 },
  data: {
    label: `图片素材 ${id}`,
    assetId: `asset-${id}`,
    imageUrl: `/local/${id}.png`,
    imageMeta: null,
    lastExecutionId: undefined,
    lastSourceNodeId: undefined,
    lastSourcePortId: undefined,
    valueSource: 'upload',
    mediaError: undefined,
    taskInfo: undefined,
    cachedContent: undefined,
    ...overrides,
  } as ImageInputNodeData,
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
      createMediaAssetFixture({ id: 'asset-i1' }),
      createMediaAssetFixture({ id: 'asset-v1', mediaType: 'video' }),
      createMediaAssetFixture({ id: 'asset-a3', mediaType: 'audio' }),
      createMediaAssetFixture({ id: 'asset-v1', mediaType: 'video' }),
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
      {/* 真实分发器：Esc 必须经浮层栈派发（spec docs/editor/浮层堆叠管理.md） */}
      <OverlayEscapeDispatcher />
      <MediaNodeChrome canvasRef={canvasRef} />
    </>,
  );
};

const bar = (testid: string) => screen.getByTestId(testid) as HTMLElement;
const queryIn = (testid: string, selector: string) =>
  bar(testid).querySelector(selector) as HTMLElement | null;

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  nodeDragging = false;
  usePromptDockStore.setState((state) => ({
    catalog: [],
    draft: { ...state.draft, modelId: '' },
  }));
});

/** 只声明图片参考位、不接受视频的模型（用于验证按钮按模型能力禁用）。 */
const imageOnlyModel = (): PromptDockCatalogEntry => ({
  model_id: 'image-only-model',
  model_version: '1.0.0',
  default_task_type: 'image',
  capability: {
    input_modalities: ['text', 'image'],
    output_modalities: ['image'],
    supports_reference_media: true,
  },
  parameter_schema: {
    fields: [],
    required_fields: [],
    default_values: {},
  },
  deployment: {
    has_active_deployment: true,
    active_deployment_id: 'dep-image-only',
    deployable: true,
    failure_code: 'none',
  },
  media_slots: [
    {
      slotId: 'reference_image',
      fieldKey: 'image',
      required: false,
      maxFiles: 4,
      mediaKind: 'image',
      label: '普通参考',
    },
  ],
});

describe('MediaNodeChrome · 顶栏（D19 图片 12 工具）', () => {
  it('单选图片资产 → 顶栏渲染 12 个工具钮（A｜B 分组顺序）', () => {
    seedStore([assetNode('a1')], ['a1']);
    renderChrome();
    const top = bar('media-chrome-top');
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

  it('单选导入图片素材 → 同一套顶栏 12 工具（D27 外壳统一）', () => {
    seedStore([imageInputNode('i1')], ['i1']);
    renderChrome();
    const top = bar('media-chrome-top');
    expect(top.querySelectorAll('button')).toHaveLength(12);
    expect(screen.getByTestId('media-chrome-bottom')).toBeTruthy();
  });

  it('点击裁剪工具 → 交给统一弹窗宿主打开同一弹窗', () => {
    seedStore([assetNode('a1')], ['a1']);
    renderChrome();
    fireEvent.click(screen.getByRole('button', { name: '裁剪图片' }));
    expect(mockedOpenMediaTool).toHaveBeenCalledWith('a1', 'crop');
  });

  it('音频资产无顶栏（O1 如实呈现），底栏仍在', () => {
    seedStore([assetNode('a3', { mediaType: 'audio', assetId: 'asset-a3' })], ['a3']);
    renderChrome();
    expect(screen.queryByTestId('media-chrome-top')).toBeNull();
    expect(screen.getByTestId('media-chrome-bottom')).toBeTruthy();
  });

  it('导入素材未登记资产身份（无 assetId）→ 不呈现顶栏，底栏仍在', () => {
    seedStore([imageInputNode('legacy', { assetId: null })], ['legacy']);
    renderChrome();
    expect(screen.queryByTestId('media-chrome-top')).toBeNull();
    expect(screen.getByTestId('media-chrome-bottom')).toBeTruthy();
  });

  it('多选资产 → 顶栏隐藏，底栏批量「用作参考 · N 项」；点击加入全部图片', () => {
    seedStore([assetNode('a1'), assetNode('a2')], ['a1', 'a2']);
    renderChrome();
    expect(screen.queryByTestId('media-chrome-top')).toBeNull();
    const batch = queryIn('media-chrome-bottom', '[data-act="ref-batch"]');
    expect(batch?.textContent).toContain('用作参考 · 2 项');
    fireEvent.click(batch as HTMLElement);
    expect(
      usePromptDockStore.getState().draft.references.map((r) => r.assetId).sort(),
    ).toEqual(['asset-a1', 'asset-a2']);
  });

  it('资产 + 导入素材混选 → 底栏仍在（不再整体消失），批量参考两项都加入', () => {
    seedStore([assetNode('a1'), imageInputNode('i1')], ['a1', 'i1']);
    renderChrome();
    expect(screen.queryByTestId('media-chrome-top')).toBeNull();
    const batch = queryIn('media-chrome-bottom', '[data-act="ref-batch"]');
    expect(batch?.textContent).toContain('用作参考 · 2 项');
    fireEvent.click(batch as HTMLElement);
    expect(
      usePromptDockStore.getState().draft.references.map((r) => r.assetId).sort(),
    ).toEqual(['asset-a1', 'asset-i1']);
  });

  it('拖动节点期间 → 顶栏与底栏保持可见（不因拖拽隐藏）', () => {
    seedStore([assetNode('a1')], ['a1']);
    nodeDragging = true;
    renderChrome();
    expect(screen.getByTestId('media-chrome-top')).toBeTruthy();
    expect(screen.getByTestId('media-chrome-bottom')).toBeTruthy();
  });

  it('混入任务节点 → 整体不渲染', () => {
    const task: GraphNode = { ...assetNode('t1'), type: 'task' };
    seedStore([assetNode('a1'), task], ['a1', 't1']);
    const { container } = renderChrome();
    expect(container.textContent).toBe('');
  });
});

describe('MediaNodeChrome · 底栏（D21 用作参考｜复用｜打包｜删除）', () => {
  it('导入素材无复用钮；生成资产（sourceModelId）有复用钮', () => {
    seedStore([imageInputNode('i1')], ['i1']);
    renderChrome();
    expect(screen.queryByText('复用')).toBeNull();
    cleanup();

    seedStore([assetNode('a1', { sourceModelId: 'gpt-image-2', sourceTaskId: 't1' })], ['a1']);
    renderChrome();
    expect(screen.getByText('复用')).toBeTruthy();
  });

  it('导入素材底栏有参考、打包、删除三个动作（全量对齐）', () => {
    seedStore([imageInputNode('i1')], ['i1']);
    renderChrome();
    expect(queryIn('media-chrome-bottom', '[data-act="ref"]')).toBeTruthy();
    expect(queryIn('media-chrome-bottom', '[data-act="package-area"]')).toBeTruthy();
    expect(queryIn('media-chrome-bottom', '[data-act="del"]')).toBeTruthy();
  });

  it('用作参考 → 写入 PromptDock 草稿参考区，钮转「取消参考」活跃态；再点移除', () => {
    seedStore([assetNode('a1')], ['a1']);
    renderChrome();
    const refBtn = queryIn('media-chrome-bottom', '[data-act="ref"]');
    expect(refBtn).toBeTruthy();
    fireEvent.click(refBtn as HTMLElement);
    expect(usePromptDockStore.getState().draft.references.map((r) => r.assetId)).toEqual([
      'asset-a1',
    ]);
    const refBtn2 = queryIn('media-chrome-bottom', '[data-act="ref"]');
    expect(refBtn2?.getAttribute('data-active')).toBe('true');
    expect(refBtn2?.textContent).toContain('取消参考');
    fireEvent.click(refBtn2 as HTMLElement);
    expect(usePromptDockStore.getState().draft.references).toHaveLength(0);
  });

  it('导入图片素材「用作参考」→ 同样写入参考区（旧入口缺失的能力）', () => {
    seedStore([imageInputNode('i1')], ['i1']);
    renderChrome();
    fireEvent.click(queryIn('media-chrome-bottom', '[data-act="ref"]') as HTMLElement);
    expect(usePromptDockStore.getState().draft.references.map((r) => r.assetId)).toEqual([
      'asset-i1',
    ]);
  });

  it('模型不支持视频参考时：生成视频的「用作参考」按钮禁用并给出原因', () => {
    usePromptDockStore.setState((state) => ({
      catalog: [imageOnlyModel()],
      draft: { ...state.draft, modelId: 'image-only-model' },
    }));
    seedStore(
      [assetNode('v1', { mediaType: 'video', assetId: 'asset-v1' })],
      ['v1'],
    );
    renderChrome();
    const refBtn = queryIn('media-chrome-bottom', '[data-act="ref"]');
    expect(refBtn).toBeTruthy();
    expect((refBtn as HTMLButtonElement).disabled).toBe(true);
    expect(refBtn?.getAttribute('title')).toContain('不支持视频参考');
  });

  it('模型支持视频参考时：生成视频的「用作参考」按钮可用', () => {
    usePromptDockStore.setState((state) => ({
      catalog: [
        {
          ...imageOnlyModel(),
          model_id: 'video-model',
          media_slots: [
            {
              slotId: 'reference_video',
              fieldKey: 'video',
              required: false,
              maxFiles: 1,
              mediaKind: 'video',
              label: '视频参考',
            },
          ],
        },
      ],
      draft: { ...state.draft, modelId: 'video-model' },
    }));
    seedStore(
      [assetNode('v1', { mediaType: 'video', assetId: 'asset-v1' })],
      ['v1'],
    );
    renderChrome();
    const refBtn = queryIn('media-chrome-bottom', '[data-act="ref"]');
    expect((refBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it('删除 inline 确认：del → 确认删除翻转；确认触发 deleteSelectedElements；Esc 取消', () => {
    seedStore([assetNode('a1')], ['a1']);
    renderChrome();
    fireEvent.click(queryIn('media-chrome-bottom', '[data-act="del"]') as HTMLElement);
    expect(queryIn('media-chrome-bottom', '[data-act="del-confirm"]')).toBeTruthy();
    expect(deleteSelectedElements).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(queryIn('media-chrome-bottom', '[data-act="del"]')).toBeTruthy();

    fireEvent.click(queryIn('media-chrome-bottom', '[data-act="del"]') as HTMLElement);
    fireEvent.click(queryIn('media-chrome-bottom', '[data-act="del-confirm"]') as HTMLElement);
    expect(deleteSelectedElements).toHaveBeenCalledTimes(1);
  });
});
