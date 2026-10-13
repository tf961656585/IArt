import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ContainerTidyGridPicker } from './ContainerTidyGridPicker';
import {
  CONTAINER_TIDY_GRID_MAX_COLUMNS,
  CONTAINER_TIDY_GRID_MAX_ROWS,
  resolveContainerTidyGridShape,
  resolveContainerTidyRows,
} from './ContainerTidyGridPicker.hooks';

describe('ContainerTidyGridPicker 网格快速选择', () => {
  // @spec: CM-020
  it('网格展示范围不超过成员数', () => {
    expect(resolveContainerTidyGridShape(3)).toEqual({ memberCount: 3, rows: 3, columns: 3 });
    expect(resolveContainerTidyGridShape(30)).toEqual({
      memberCount: 30,
      rows: CONTAINER_TIDY_GRID_MAX_ROWS,
      columns: CONTAINER_TIDY_GRID_MAX_COLUMNS,
    });
  });

  it('行数由列数与成员数派生（与算法 ceil 口径一致）', () => {
    expect(resolveContainerTidyRows(10, 3)).toBe(4);
    expect(resolveContainerTidyRows(9, 3)).toBe(3);
    expect(resolveContainerTidyRows(7, 1)).toBe(7);
  });

  it('未划过时按单列给出预览文案', () => {
    render(<ContainerTidyGridPicker memberCount={6} objectWord="本组" onSelect={vi.fn()} />);

    expect(screen.getByText('6 行 × 1 列 · 共 6 个节点')).toBeInTheDocument();
    // 每列只有一个可聚焦选项（行数是派生结果，不构成第二个选择维度）
    expect(screen.getAllByRole('button')).toHaveLength(6);
  });

  it('划过单元按该列数更新预览，点击回调携带列数', () => {
    const onSelect = vi.fn();
    render(<ContainerTidyGridPicker memberCount={6} objectWord="本组" onSelect={onSelect} />);

    const cell = screen.getByLabelText('整理为 2 行 3 列');
    fireEvent.mouseEnter(cell);
    expect(screen.getByText('2 行 × 3 列 · 共 6 个节点')).toBeInTheDocument();

    fireEvent.click(cell);
    expect(onSelect).toHaveBeenCalledWith(3);
  });

  it('行数多于可用槽位时按推导行数修正预览文案', () => {
    render(<ContainerTidyGridPicker memberCount={12} objectWord="本组" onSelect={vi.fn()} />);

    fireEvent.mouseEnter(screen.getByLabelText('整理为 4 行 3 列'));

    expect(screen.getByText('4 行 × 3 列 · 共 12 个节点')).toBeInTheDocument();
  });

  it('键盘聚焦单元与鼠标悬停共用同一预览', () => {
    render(<ContainerTidyGridPicker memberCount={12} objectWord="本组" onSelect={vi.fn()} />);

    const cell = screen.getByLabelText('整理为 6 行 2 列');
    fireEvent.focus(cell);

    expect(screen.getByText('6 行 × 2 列 · 共 12 个节点')).toBeInTheDocument();
  });

  it('左右方向键在选项行内移动焦点并同步预览', () => {
    render(<ContainerTidyGridPicker memberCount={12} objectWord="本组" onSelect={vi.fn()} />);

    const first = screen.getByLabelText('整理为 12 行 1 列');
    fireEvent.focus(first);
    fireEvent.keyDown(first, { key: 'ArrowRight' });

    expect(document.activeElement).toBe(screen.getByLabelText('整理为 6 行 2 列'));
    expect(screen.getByText('6 行 × 2 列 · 共 12 个节点')).toBeInTheDocument();
  });

  it('预览网格的其余行不是可聚焦控件（只作结果预览）', () => {
    render(<ContainerTidyGridPicker memberCount={6} objectWord="本组" onSelect={vi.fn()} />);

    // 6 行 6 列共 36 格，其中只有第一行 6 格是选项按钮
    const grid = screen.getByRole('group', { name: '整理本组：选择网格列数' });
    expect(grid.querySelectorAll('[data-tidy-grid-cell]')).toHaveLength(36);
    expect(screen.getAllByRole('button')).toHaveLength(6);
  });

  it('对象词经 props 注入：Agent 容器网格的无障碍名带「本容器」，触发项 label 与之对称', () => {
    render(<ContainerTidyGridPicker memberCount={6} onSelect={vi.fn()} objectWord="本容器" />);

    expect(screen.getByRole('group', { name: '整理本容器：选择网格列数' })).toBeInTheDocument();
    // 容器中性文案一字不动：标题与预览不随对象词变化
    expect(screen.getByText('整理为网格')).toBeInTheDocument();
    expect(screen.getByText('6 行 × 1 列 · 共 6 个节点')).toBeInTheDocument();
  });

  it('对象词「本组」渲染组侧既有无障碍名（组侧文案一字不动）', () => {
    render(<ContainerTidyGridPicker memberCount={6} objectWord="本组" onSelect={vi.fn()} />);

    expect(screen.getByRole('group', { name: '整理本组：选择网格列数' })).toBeInTheDocument();
  });
});
