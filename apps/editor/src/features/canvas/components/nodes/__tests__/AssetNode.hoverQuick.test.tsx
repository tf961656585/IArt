import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { NodeProps } from '@xyflow/react';
import type { GraphNode } from '@/features/canvas/types/node';
import type { AssetNodeData } from '@/features/canvas/types/taskNode';
import {
  createMediaAssetFixture,
  createMediaAssetMapFixture,
} from '../../__tests__/fixtures/canvasTestBuilders';
import { toNodePropsData } from '../../__tests__/fixtures/canvasComponentFixtures';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

const storeRef: { state: Record<string, unknown> } = { state: {} };
vi.mock('../../../store/canvasStore', () => ({
  useCanvasStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(storeRef.state),
    { getState: () => storeRef.state },
  ),
}));

// 节点投影：直接喂 fixture（useNodeFromStore 的真实行为由投影服务测试覆盖）。
let mockNode: GraphNode<AssetNodeData>;
vi.mock('../../../hooks/useNodeFromStore', () => ({
  useNodeFromStore: () => ({ node: mockNode, data: mockNode.data }),
}));

const downloadMedia = vi.fn(async (..._args: unknown[]): Promise<void> => undefined);
vi.mock('@/client/utils/download', () => ({
  downloadMedia: (input: unknown, opts: unknown): Promise<void> =>
    downloadMedia(input, opts),
}));

// reveal 封装 mock（断言只看「点了没有、交了哪条地址」；toast 分级语义归封装自己的测试）。
const revealFilesUrlWithToast = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
vi.mock('@/client/utils/revealFilesUrlWithToast', () => ({
  revealFilesUrlWithToast: (url: unknown, opts: unknown) =>
    revealFilesUrlWithToast(url, opts),
}));

import { AssetNode } from '../AssetNode';

const assetNodeData: AssetNodeData = {
  label: '雪山图',
  sourceBatchId: 'b1',
  sourceTaskId: 't1',
  sourceModelId: 'gpt-image-2',
  mediaType: 'image',
  assetId: 'asset-1',
};

const nodeProps = (selected: boolean): NodeProps => ({
  id: mockNode.id,
  data: toNodePropsData(mockNode),
  type: 'asset',
  width: 240,
  height: 180,
  selected,
  dragging: false,
  zIndex: 0,
  isConnectable: false,
  positionAbsoluteX: 0,
  positionAbsoluteY: 0,
  draggable: true,
  selectable: true,
  deletable: true,
});

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockNode = {
    id: 'node-1',
    type: 'asset',
    position: { x: 0, y: 0 },
    data: assetNodeData,
    draggable: true,
    size: undefined,
    style: undefined,
    groupId: undefined,
  };
  storeRef.state = {
    mediaAssets: createMediaAssetMapFixture([createMediaAssetFixture({ id: 'asset-1' })]),
  };
});

describe('AssetNode · hover 个体动作（D22/H1 暗 scrim）', () => {
  it('渲染 .asset-media-quick：放大预览 + 下载（生成资产不可变，无替换钮）', () => {
    const { container } = render(<AssetNode {...nodeProps(false)} />);
    const quick = container.querySelector('.asset-media-quick');
    expect(quick).toBeTruthy();
    expect(screen.getByRole('button', { name: '放大预览' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '下载' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /替换/ })).toBeNull();
  });

  it('旧白色复用 pill 已退役（复用归选中底栏 chrome）', () => {
    const { container } = render(<AssetNode {...nodeProps(true)} />);
    expect(container.querySelector('.asset-actions')).toBeNull();
    expect(container.querySelector('.asset-reuse-btn')).toBeNull();
  });

  it('点击下载 → downloadMedia 以资产 url 与标签调用', () => {
    render(<AssetNode {...nodeProps(false)} />);
    fireEvent.click(screen.getByRole('button', { name: '下载' }));
    expect(downloadMedia).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ filename: '雪山图' }),
    );
  });

  it('点击放大预览 → 打开预览 Dialog', () => {
    render(<AssetNode {...nodeProps(false)} />);
    fireEvent.click(screen.getByRole('button', { name: '放大预览' }));
    expect(screen.getByText('资产预览')).toBeTruthy();
  });
});

/**
 * 预览工具栏两态同形（docs/editor/本地文件快捷跳转.md LFJ-005）：
 * 视频预览模态与图片预览共用同一份工具栏 JSX（下载 / 打开文件所在位置 / 关闭预览），
 * 视频不再是没有定位入口的「另一模态」。
 *
 * 覆盖边界说明：fireEvent.click 直接投递目标节点，覆盖不了真机指针语义；预览 Dialog
 * 渲染在 portal 里、工具栏按钮不在画布节点 DOM 子树内，无节点拖拽捕获干扰，jsdom
 * 前置断言成立即可，真机点击按 spec「真机类验收」双轨人工点验（SKIP 注记：真机项）。
 */
describe('AssetNode · 预览工具栏两态同形（LFJ-005）', () => {
  it('视频预览模态提供与图片预览一致的工具栏，定位点击交给 reveal 封装', () => {
    // @spec: LFJ-005
    mockNode = {
      ...mockNode,
      data: { ...assetNodeData, mediaType: 'video', label: '演示视频' },
    };
    storeRef.state = {
      mediaAssets: createMediaAssetMapFixture([
        createMediaAssetFixture({ id: 'asset-1', mediaType: 'video' }),
      ]),
    };
    render(<AssetNode {...nodeProps(false)} />);
    fireEvent.click(screen.getByRole('button', { name: '放大预览' }));
    // Radix 模态 Dialog 把 portal 外的节点面（hover 快捷钮）标成 aria-hidden，role 查询
    // 只看得见弹窗内的工具栏：这里恰好 1 颗「下载」（工具栏），定位 / 关闭亦只在工具栏。
    expect(screen.getAllByRole('button', { name: '下载' }).length).toBe(1);
    expect(screen.getByRole('button', { name: '打开文件所在位置' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '关闭预览' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '打开文件所在位置' }));
    expect(revealFilesUrlWithToast).toHaveBeenCalledTimes(1);
    expect(revealFilesUrlWithToast.mock.calls[0]?.[0]).toBe(
      '/project-media/project-a/asset-1',
    );
    expect(revealFilesUrlWithToast.mock.calls[0]?.[1]).toBeUndefined();
  });
});
