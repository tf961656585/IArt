import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ExecutableCatalogMediaSlot, ProjectMediaType } from '@iart/contracts';
import type { GraphNode } from '@/features/canvas/types/node';
import type { AssetNodeData } from '@/features/canvas/types/taskNode';

import {
  createMediaAssetFixture,
  createMediaAssetMapFixture,
  createTestNodeGraph,
} from '@/features/canvas/components/__tests__/fixtures/canvasTestBuilders';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import type { PromptDockReference } from '../PromptDock.types';
import { usePromptDockStore } from '../promptDockStore';
import { addNodesToReferences } from '../referenceOps';
import type * as referenceOpsModule from '../referenceOps';
import { PromptDockReferenceArea } from '../components/PromptDockReferenceArea';
import { createCatalogEntryWithSlots } from './fixtures/promptDockCatalogEntry';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

// 操作层默认透传真实实现（与画布底栏共用同一接线）；个别用例用
// mockReturnValueOnce 注入结构化结果，单测组件侧的结果→行内反馈映射。
vi.mock('../referenceOps', async (importOriginal) => {
  const actual = await importOriginal<typeof referenceOpsModule>();
  return {
    ...actual,
    addNodesToReferences: vi.fn((nodes: GraphNode[]) => actual.addNodesToReferences(nodes)),
  };
});

const reference = (
  assetId: string,
  mediaType: ProjectMediaType,
  label = `素材 ${assetId}`,
): PromptDockReference => ({
  refId: assetId,
  assetId,
  mediaType,
  label,
});

const assetNode = (
  id: string,
  overrides: Partial<AssetNodeData> = {},
): GraphNode => ({
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

const setDraftReferences = (references: PromptDockReference[]) => {
  usePromptDockStore.setState((state) => ({
    draft: { ...state.draft, references },
  }));
};

const setMediaAssets = (...assets: ReturnType<typeof createMediaAssetFixture>[]) => {
  useCanvasStore.setState((state) => {
    state.mediaAssets = createMediaAssetMapFixture(assets);
  });
};

const setNodeGraph = (nodes: GraphNode[]) => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = createTestNodeGraph({ nodes });
  });
};

const setSelection = (ids: string[]) => {
  useCanvasStore.setState((state) => {
    state.selectedNodeIds = ids;
  });
};

/**
 * 设置当前模型（目录条目 + 草稿 modelId 同步），并返回该条目给组件 prop。
 * 两处同源：组件用 prop 预判计数，点「加入选中」时操作层按 store 目录裁定，必须一致。
 */
const setModel = (slots: ExecutableCatalogMediaSlot[]): ReturnType<typeof createCatalogEntryWithSlots> => {
  const entry = createCatalogEntryWithSlots(slots);
  usePromptDockStore.setState((state) => ({
    catalog: [entry],
    draft: { ...state.draft, modelId: entry.model_id, modelVersion: entry.model_version },
  }));
  return entry;
};

const imageOnlySlots: ExecutableCatalogMediaSlot[] = [
  { slotId: 'reference_image', fieldKey: 'referenceImage', required: false, maxFiles: 4, mediaKind: 'image', label: '参考图' },
];
const videoRefSlots: ExecutableCatalogMediaSlot[] = [
  { slotId: 'reference_video', fieldKey: 'referenceVideo', required: false, maxFiles: 4, mediaKind: 'video', label: '参考视频' },
];

beforeEach(() => {
  cleanup();
  usePromptDockStore.setState((state) => ({
    catalog: [],
    draft: { ...state.draft, modelId: null, modelVersion: null, references: [] },
  }));
  setMediaAssets();
  setNodeGraph([]);
  setSelection([]);
});

describe('PromptDockReferenceArea（参考区 chip 对齐原型：缩略图 + 标签 + hover 预览）', () => {
  it('图片引用：chip 显示资产标签 + 真实缩略图（original.url 直出）', () => {
    setMediaAssets(createMediaAssetFixture({ id: 'asset-img' }));
    setDraftReferences([reference('asset-img', 'image')]);

    const { container } = render(<PromptDockReferenceArea />);
    expect(screen.getByTestId('promptdock-reference-area')).not.toBeNull();
    expect(screen.getByText('素材 asset-img')).not.toBeNull();
    const thumb = container.querySelector('img[src*="asset-img"]');
    expect(thumb).not.toBeNull();
  });

  it('视频引用：缩略图取首帧（video 元素）+ 展示时长（durationMs → m:ss）', () => {
    setMediaAssets(createMediaAssetFixture({ id: 'asset-vid', mediaType: 'video' }));
    setDraftReferences([reference('asset-vid', 'video')]);

    const { container } = render(<PromptDockReferenceArea />);
    expect(container.querySelector('video[src*="asset-vid"]')).not.toBeNull();
    expect(screen.getByText('0:05')).not.toBeNull();
  });

  it('音频引用：无视觉面，退类型图标占位（不渲染破图）+ 展示时长', () => {
    setMediaAssets(createMediaAssetFixture({ id: 'asset-aud', mediaType: 'audio' }));
    setDraftReferences([reference('asset-aud', 'audio')]);

    const { container } = render(<PromptDockReferenceArea />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
    expect(screen.getByText('素材 asset-aud')).not.toBeNull();
    expect(screen.getByText('0:05')).not.toBeNull();
  });

  it('资产不可访问：退类型图标占位，标签仍可识别', () => {
    setDraftReferences([reference('asset-gone', 'image')]);

    const { container } = render(<PromptDockReferenceArea />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('素材 asset-gone')).not.toBeNull();
  });

  it('hover 预览说明行携带尺寸信息（标签 + W×H 由 HoverCardContent 承载，挂载时不渲染）', () => {
    setMediaAssets(createMediaAssetFixture({ id: 'asset-img' }));
    setDraftReferences([reference('asset-img', 'image')]);

    render(<PromptDockReferenceArea />);
    // Radix HoverCard 懒挂载：hover 前预览层不在 DOM（不抢交互、不挡画布）
    expect(screen.queryByText('800×600')).toBeNull();
  });

  it('点击移除按钮 → store 中引用被移除（PD-MR 草稿编辑）', () => {
    setMediaAssets(
      createMediaAssetFixture({ id: 'asset-a' }),
      createMediaAssetFixture({ id: 'asset-b' }),
    );
    setDraftReferences([reference('asset-a', 'image'), reference('asset-b', 'image')]);

    render(<PromptDockReferenceArea />);
    const chips = screen.getAllByRole('button', { name: '移除参考' });
    fireEvent.click(chips[0] as HTMLButtonElement);
    expect(
      usePromptDockStore.getState().draft.references.map((r) => r.assetId),
    ).toEqual(['asset-b']);
  });
});

describe('PromptDockReferenceArea · 去文案化交互（回形针 + 计数按钮 + 行内反馈）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(addNodesToReferences).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('空态：无「参考」文字标签与空态文案；回形针图标（aria 参考素材）+ 禁用的「加入选中」', () => {
    render(<PromptDockReferenceArea />);
    expect(screen.queryByText('参考')).toBeNull();
    expect(screen.queryByText('还没有参考素材')).toBeNull();
    expect(screen.getByRole('img', { name: '参考素材' })).not.toBeNull();
    const button = screen.getByRole('button', { name: '加入选中' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', '在画布选中素材后可加入');
  });

  it('计数：选中 2 个图片资产 → 「加入选中 (2)」且可点（计数只含符合准入的选中项）', () => {
    setNodeGraph([
      assetNode('n1', { assetId: 'asset-a' }),
      assetNode('n2', { assetId: 'asset-b' }),
    ]);
    setMediaAssets(
      createMediaAssetFixture({ id: 'asset-a' }),
      createMediaAssetFixture({ id: 'asset-b' }),
    );
    setSelection(['n1', 'n2']);

    render(<PromptDockReferenceArea />);
    const button = screen.getByRole('button', { name: '加入选中 (2)' });
    expect(button).not.toBeDisabled();
    expect(button).not.toHaveAttribute('title');
  });

  it('n=0（视频不在当前模型的参考能力内）→ 禁用 + 说明模型不支持', () => {
    const entry = setModel(imageOnlySlots);
    setNodeGraph([assetNode('n1', { mediaType: 'video', assetId: 'asset-v' })]);
    setMediaAssets(createMediaAssetFixture({ id: 'asset-v', mediaType: 'video' }));
    setSelection(['n1']);

    render(<PromptDockReferenceArea entry={entry} />);
    const button = screen.getByRole('button', { name: '加入选中' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', '当前模型不支持视频参考');
  });

  it('视频资产 + 支持视频的模型 → 计入候选并可加入（来源无关）', () => {
    const entry = setModel(videoRefSlots);
    setNodeGraph([assetNode('n1', { mediaType: 'video', assetId: 'asset-v' })]);
    setMediaAssets(createMediaAssetFixture({ id: 'asset-v', mediaType: 'video' }));
    setSelection(['n1']);

    render(<PromptDockReferenceArea entry={entry} />);
    fireEvent.click(screen.getByRole('button', { name: '加入选中 (1)' }));
    expect(
      usePromptDockStore.getState().draft.references.map((r) => r.assetId),
    ).toEqual(['asset-v']);
  });

  it('点击加入：选中资产写入参考区（PD-MR-003）', () => {
    setNodeGraph([assetNode('n1', { assetId: 'asset-a' })]);
    setMediaAssets(createMediaAssetFixture({ id: 'asset-a' }));
    setSelection(['n1']);

    render(<PromptDockReferenceArea />);
    fireEvent.click(screen.getByRole('button', { name: '加入选中 (1)' }));
    expect(
      usePromptDockStore.getState().draft.references.map((r) => r.assetId),
    ).toEqual(['asset-a']);
  });

  it('重复 → 行内「已在参考里」，2.5s 自动消失，引用不翻倍', () => {
    setDraftReferences([reference('asset-a', 'image')]);
    setNodeGraph([assetNode('n1', { assetId: 'asset-a' })]);
    setMediaAssets(createMediaAssetFixture({ id: 'asset-a' }));
    setSelection(['n1']);

    render(<PromptDockReferenceArea />);
    fireEvent.click(screen.getByRole('button', { name: '加入选中 (1)' }));
    expect(screen.getByText('已在参考里')).not.toBeNull();
    expect(usePromptDockStore.getState().draft.references).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(screen.queryByText('已在参考里')).toBeNull();
  });

  it('部分有效：只加当前模型接受的项（图片加入、视频被模型能力拦下），不进行内反馈', () => {
    const entry = setModel(imageOnlySlots);
    setNodeGraph([
      assetNode('n1', { assetId: 'asset-a' }),
      assetNode('n2', { mediaType: 'video', assetId: 'asset-v' }),
    ]);
    setMediaAssets(
      createMediaAssetFixture({ id: 'asset-a' }),
      createMediaAssetFixture({ id: 'asset-v', mediaType: 'video' }),
    );
    setSelection(['n1', 'n2']);

    render(<PromptDockReferenceArea entry={entry} />);
    fireEvent.click(screen.getByRole('button', { name: '加入选中 (1)' }));
    expect(
      usePromptDockStore.getState().draft.references.map((r) => r.assetId),
    ).toEqual(['asset-a']);
    expect(screen.queryByText('已在参考里')).toBeNull();
    expect(screen.queryByText('当前模型不支持视频参考')).toBeNull();
  });

  it('准入不符（操作层返回 rejected）→ 行内说明模型不支持，2.5s 自动消失', () => {
    vi.mocked(addNodesToReferences).mockReturnValueOnce({
      kind: 'rejected',
      duplicates: 0,
      rejected: [
        {
          label: '资产 n1',
          reason: '当前模型不支持视频参考',
          kind: 'media-unsupported',
        },
      ],
    });
    setNodeGraph([assetNode('n1', { assetId: 'asset-a' })]);
    setMediaAssets(createMediaAssetFixture({ id: 'asset-a' }));
    setSelection(['n1']);

    render(<PromptDockReferenceArea />);
    fireEvent.click(screen.getByRole('button', { name: '加入选中 (1)' }));
    expect(screen.getByText('当前模型不支持视频参考')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(screen.queryByText('当前模型不支持视频参考')).toBeNull();
  });

  it('不可访问资产（已删除等罕见情形）→ debug 留痕 + 静默跳过，不进行内反馈', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.mocked(addNodesToReferences).mockReturnValueOnce({
      kind: 'rejected',
      duplicates: 0,
      rejected: [
        {
          label: '资产 n1',
          reason: '素材已被删除，无法加入参考',
          kind: 'asset-unavailable',
        },
      ],
    });
    setNodeGraph([assetNode('n1', { assetId: 'asset-a' })]);
    setMediaAssets(createMediaAssetFixture({ id: 'asset-a' }));
    setSelection(['n1']);

    render(<PromptDockReferenceArea />);
    fireEvent.click(screen.getByRole('button', { name: '加入选中 (1)' }));
    expect(screen.queryByText('当前选中不能作参考')).toBeNull();
    expect(screen.queryByText('已在参考里')).toBeNull();
    expect(debugSpy).toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it('同批部分加入但超量被拒 → 行内说明超量（部分成功不能静默吞掉容量拒绝）', () => {
    vi.mocked(addNodesToReferences).mockReturnValueOnce({
      kind: 'added',
      addedCount: 1,
      duplicates: 0,
      rejected: [
        {
          label: '资产 n2',
          reason: '当前模型的图片参考最多 2 张，参考区已经放满，先移除一张再加入',
          kind: 'slot-capacity-exceeded',
        },
      ],
    });
    setNodeGraph([assetNode('n1', { assetId: 'asset-a' }), assetNode('n2', { assetId: 'asset-b' })]);
    setMediaAssets(
      createMediaAssetFixture({ id: 'asset-a' }),
      createMediaAssetFixture({ id: 'asset-b' }),
    );
    setSelection(['n1', 'n2']);

    render(<PromptDockReferenceArea />);
    fireEvent.click(screen.getByRole('button', { name: '加入选中 (2)' }));
    expect(
      screen.getByText('当前模型的图片参考最多 2 张，参考区已经放满，先移除一张再加入'),
    ).not.toBeNull();
  });
});
