import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, vi, expect, beforeEach } from 'vitest';
import { AddToGroupPopover } from './AddToGroupPopover';
import { useCanvasStore } from '../../store/canvasStore';
import { createNodeGraph } from '../../types/nodeGraph';
import type { GraphNode, GroupNodeData } from '../../types';

/**
 * 「加入组」弹层测试（键盘导航修复验收）。
 *
 * 历史缺陷：onOpenAutoFocus preventDefault 且无手动聚焦，键盘事件无可达宿主，
 * ArrowUp/Down/Enter 完全失效。本文件验收修复口径：
 * 打开 → 焦点在列表容器 → ↓ 移动 data-active 高亮 → Enter 选中 → Esc 关闭；
 * 悬停与键盘共用同一高亮索引（data-active 单账）。
 */

function makeGroupNode(id: string, name: string, collapsed = false): GraphNode {
  return {
    id,
    type: 'group',
    position: { x: 0, y: 0 },
    data: {
      label: undefined,
      description: undefined,
      runtimeRef: undefined,
      name,
      collapsed,
      color: undefined,
    } satisfies GroupNodeData,
    draggable: true,
    size: undefined,
    style: undefined,
    groupId: undefined,
  };
}

/** 两个组候选：grp-1 展开在前，grp-2 折叠在后（验证折叠组也可作为目标）。 */
const seedGroups = () => {
  const graph = createNodeGraph({
    name: '测试画板',
    description: undefined,
    tags: undefined,
    category: undefined,
  });
  graph.nodes = [makeGroupNode('grp-1', '主视觉组'), makeGroupNode('grp-2', '备用组', true)];
  useCanvasStore.setState({ nodeGraph: graph });
};

const renderPopover = () => {
  const onSelectTargetGroup = vi.fn();
  const onCancel = vi.fn();
  render(
    <AddToGroupPopover
      request={{ candidateNodeIds: ['node-a', 'node-b'] }}
      onSelectTargetGroup={onSelectTargetGroup}
      onCancel={onCancel}
    />,
  );
  return { onSelectTargetGroup, onCancel };
};

/** 取列表容器（cmdk List role=listbox，打开时的焦点落点）与全部候选项。 */
const getListAndItems = () => {
  const list = screen.getByRole('listbox');
  const items = list.querySelectorAll('[cmdk-item]');
  return { list, items };
};

describe('AddToGroupPopover 键盘导航', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCanvasStore.setState({ nodeGraph: null });
  });

  it('打开后焦点落在列表容器且首项默认高亮（键盘可达）', async () => {
    seedGroups();
    renderPopover();
    const list = await screen.findByRole('listbox');
    expect(document.activeElement).toBe(list);
    const { items } = getListAndItems();
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute('data-active', 'true');
    expect(items[1]).not.toHaveAttribute('data-active');
  });

  it('ArrowDown/ArrowUp 在候选间循环移动 data-active 高亮', async () => {
    seedGroups();
    renderPopover();
    await screen.findByRole('listbox');
    const { list, items } = getListAndItems();

    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(items[1]).toHaveAttribute('data-active', 'true');
    expect(items[0]).not.toHaveAttribute('data-active');

    // 末项再 ↓ 回绕到首项（wrap 循环）
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(items[0]).toHaveAttribute('data-active', 'true');

    // 首项 ↑ 回绕到末项
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(items[1]).toHaveAttribute('data-active', 'true');
  });

  it('Enter 选中当前高亮项：无移动时选首项，↓ 后选第二项', async () => {
    seedGroups();
    const { onSelectTargetGroup } = renderPopover();
    await screen.findByRole('listbox');
    const { list } = getListAndItems();

    fireEvent.keyDown(list, { key: 'Enter' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'Enter' });

    expect(onSelectTargetGroup).toHaveBeenCalledTimes(2);
    expect(onSelectTargetGroup).toHaveBeenNthCalledWith(1, 'grp-1');
    expect(onSelectTargetGroup).toHaveBeenNthCalledWith(2, 'grp-2');
  });

  it('Esc 经浮层栈关闭：onCancel 被调用', async () => {
    seedGroups();
    const { onCancel } = renderPopover();
    await screen.findByRole('listbox');
    const { list } = getListAndItems();

    fireEvent.keyDown(list, { key: 'Escape' });
    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });

  it('悬停同步：pointerMove 包裹层后 data-active 移到悬停项（与键盘共用同一索引）', async () => {
    seedGroups();
    renderPopover();
    await screen.findByRole('listbox');
    const { list, items } = getListAndItems();

    const secondWrapper = items[1]?.parentElement;
    if (secondWrapper === null || secondWrapper === undefined) {
      throw new Error('第二项的悬停包裹层不存在');
    }
    fireEvent.pointerMove(secondWrapper);
    expect(items[1]).toHaveAttribute('data-active', 'true');
    expect(items[0]).not.toHaveAttribute('data-active');

    // 悬停写入后键盘基于同一索引相对移动：↑ 回到首项
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(items[0]).toHaveAttribute('data-active', 'true');
  });

  it('画布上没有任何组时打开即自动取消（onCancel）', async () => {
    const { onCancel } = renderPopover();
    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });
});
