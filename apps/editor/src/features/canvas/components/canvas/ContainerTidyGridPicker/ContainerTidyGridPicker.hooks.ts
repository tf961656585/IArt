'use client';

/**
 * 「整理为网格」快速选择的状态与交互逻辑。
 *
 * 语义：划过/聚焦网格单元即选定**列数**，行数由成员数派生（`ceil(成员数 / 列数)`），
 * 与布局算法口径一致（spec：画布自动布局算法.md「网格摆放」）。行数不作为独立入参，
 * 避免「用户选的行数」与「算法派生的行数」形成两个事实源。
 * 悬停与键盘聚焦共用同一高亮状态，键盘用户因此获得与鼠标一致的预览。
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type {
  ContainerTidyGridCell,
  ContainerTidyGridShape,
} from './ContainerTidyGridPicker.types';

/**
 * 网格展示上限。
 *
 * 列数上限 10：单元 20px + 间隙 6px 时网格宽 254px，连同行内边距不超过菜单最大宽度 280px
 *（spec：画布对象右键菜单.md §5.1）。
 * 行数上限 8：控制单行高度，避免行数多的容器把菜单撑到过高。超出展示范围的行由文案给出真实数字。
 * 单元 20px + 6px 间隙 = 26px 中心间距，大于 WCAG 2.2 目标尺寸的 24px 间距例外下限。
 */
export const CONTAINER_TIDY_GRID_MAX_ROWS = 8;
export const CONTAINER_TIDY_GRID_MAX_COLUMNS = 10;

const clampToRange = (value: number, max: number): number => {
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(Math.floor(value), max);
};

/**
 * 解析网格展示范围：行列上限都不超过成员数（没有空行/空列可选），也不超过展示上限。
 */
export const resolveContainerTidyGridShape = (memberCount: number): ContainerTidyGridShape => ({
  memberCount,
  rows: clampToRange(memberCount, CONTAINER_TIDY_GRID_MAX_ROWS),
  columns: clampToRange(memberCount, CONTAINER_TIDY_GRID_MAX_COLUMNS),
});

/**
 * 由列数与成员数派生实际行数。
 *
 * 与 `placeGridFlow` 的 `ceil(节点数 / 列数)` 同口径；算法层是行数的唯一派生方，
 * 本函数只用于预览文案。
 */
export const resolveContainerTidyRows = (memberCount: number, columns: number): number => {
  if (!Number.isFinite(columns) || columns < 1) return Math.max(memberCount, 1);
  return Math.max(1, Math.ceil(memberCount / Math.floor(columns)));
};

type UseGroupTidyGridArgs = {
  /** 参与整理的成员数，决定网格展示范围与实际行数 */
  memberCount: number;
  /** 选定列数后的应用回调 */
  onSelect: (columns: number) => void;
};

export const useContainerTidyGrid = ({ memberCount, onSelect }: UseGroupTidyGridArgs) => {
  const [hovered, setHovered] = useState<ContainerTidyGridCell | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const shape = useMemo(() => resolveContainerTidyGridShape(memberCount), [memberCount]);

  // 未划过任何单元时预览单列（与默认整理口径一致），让该行在菜单打开时就有可读文案。
  const activeColumn = hovered !== null ? hovered.column : 1;
  const previewRows = resolveContainerTidyRows(memberCount, activeColumn);

  /** 单元是否落在本次排布的实际占位范围内（用于「将装入成员」的填充预览）。 */
  const isCellFilled = useCallback(
    (cell: ContainerTidyGridCell): boolean => {
      const index = (cell.row - 1) * activeColumn + cell.column;
      return cell.column <= activeColumn && index <= memberCount;
    },
    [activeColumn, memberCount],
  );

  /** 单元是否位于划过位置（用于指针反馈）。 */
  const isCellHovered = useCallback(
    (cell: ContainerTidyGridCell): boolean =>
      hovered !== null && cell.row === hovered.row && cell.column === hovered.column,
    [hovered],
  );

  const handleCellEnter = useCallback((cell: ContainerTidyGridCell) => {
    setHovered(cell);
  }, []);

  const handleCellFocus = useCallback((cell: ContainerTidyGridCell) => {
    setHovered(cell);
  }, []);

  const handleGridLeave = useCallback(() => {
    setHovered(null);
  }, []);

  const handleCellSelect = useCallback(
    (cell: ContainerTidyGridCell) => {
      onSelect(cell.column);
    },
    [onSelect],
  );

  /**
   * 左右方向键在选项行内移动焦点（焦点变化经 handleCellFocus 同步预览）。
   *
   * 只有列数可被选择、行数是派生结果，因此不处理上下方向键。
   */
  const handleCellKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, cell: ContainerTidyGridCell) => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (step === 0) return;
      const nextColumn = Math.min(Math.max(cell.column + step, 1), shape.columns);
      if (nextColumn === cell.column) return;
      event.preventDefault();
      const selector = `[data-tidy-grid-cell="1-${nextColumn}"]`;
      gridRef.current?.querySelector<HTMLButtonElement>(selector)?.focus();
    },
    [gridRef, shape.columns],
  );

  return {
    gridRef,
    shape,
    activeColumn,
    previewRows,
    isCellFilled,
    isCellHovered,
    handleCellEnter,
    handleCellFocus,
    handleGridLeave,
    handleCellSelect,
    handleCellKeyDown,
  };
};

export { useContainerTidyGrid as default };
