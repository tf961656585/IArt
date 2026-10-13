'use client';

/**
 * 「整理为网格」快速选择行（容器右键菜单内联行，组与 Agent 容器共用）。
 *
 * 交互语义：横向划过选择**列数**，行数由成员数与列数派生（`ceil(成员数 / 列数)`）；被填充的格子
 * 始终是本次整理后的真实占位范围，因此这个二维网格是「结果的预览」，而非两个可独立选择的维度。
 * 点击任一列即按该列数执行容器内整理并关闭菜单；键盘用左右方向键在第一行选项间移动。
 *
 * 与「组颜色」色板行同为菜单内联控制行：不渲染标准按钮行，菜单在该行上保持打开直到用户选定。
 * 对象词（本组/本容器）经 `objectWord` 注入分组无障碍名；标题、预览与格子名是容器中性文案。
 *
 * spec：docs/editor/画布对象右键菜单.md §7.3、docs/runtime/画布自动布局算法.md「网格摆放」。
 */

import { cn } from '@/lib/utils';
import {
  resolveContainerTidyRows,
  useContainerTidyGrid,
} from './ContainerTidyGridPicker.hooks';
import type {
  ContainerTidyGridCell,
  ContainerTidyGridPickerProps,
} from './ContainerTidyGridPicker.types';

export function ContainerTidyGridPicker({
  memberCount,
  objectWord,
  onSelect,
}: ContainerTidyGridPickerProps) {
  const {
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
  } = useContainerTidyGrid({ memberCount, onSelect });

  const rows: number[] = [];
  for (let row = 1; row <= shape.rows; row += 1) rows.push(row);
  const columns: number[] = [];
  for (let column = 1; column <= shape.columns; column += 1) columns.push(column);

  return (
    <div
      ref={gridRef}
      role="group"
      aria-label={`整理${objectWord}：选择网格列数`}
      className="relative flex w-full flex-col gap-1 rounded-sm px-2 py-1.5"
      onMouseLeave={handleGridLeave}
    >
      <span className="text-left text-sm">整理为网格</span>
      <div className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <div key={row} className="flex gap-1.5">
            {columns.map((column) => {
              const cell: ContainerTidyGridCell = { row, column };
              const cellClassName = cn(
                'size-5 rounded-sm border transition-colors',
                isCellFilled(cell) ? 'bg-primary/50' : 'bg-transparent',
                isCellHovered(cell) ? 'border-primary' : 'border-border',
              );
              // 第一行是该行唯一可聚焦/可提交的选项（选择维度只有列数，行数是派生结果）；
              // 其余行只作结果预览，鼠标划过与点击仍按所在列生效。
              if (row === 1) {
                return (
                  <button
                    key={column}
                    type="button"
                    data-tidy-grid-cell={`${row}-${column}`}
                    aria-label={`整理为 ${resolveContainerTidyRows(memberCount, column)} 行 ${column} 列`}
                    aria-pressed={column === activeColumn}
                    className={cn(
                      cellClassName,
                      'cursor-pointer hover:border-primary focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-ring',
                    )}
                    onMouseEnter={() => handleCellEnter(cell)}
                    onFocus={() => handleCellFocus(cell)}
                    onClick={() => handleCellSelect(cell)}
                    onKeyDown={(event) => handleCellKeyDown(event, cell)}
                  />
                );
              }
              return (
                <span
                  key={column}
                  aria-hidden="true"
                  data-tidy-grid-cell={`${row}-${column}`}
                  className={cn(cellClassName, 'cursor-pointer')}
                  onMouseEnter={() => handleCellEnter(cell)}
                  onClick={() => handleCellSelect(cell)}
                />
              );
            })}
          </div>
        ))}
      </div>
      <span className="text-left text-xs text-muted-foreground" aria-live="polite">
        {previewRows} 行 × {activeColumn} 列 · 共 {memberCount} 个节点
      </span>
    </div>
  );
}

export default ContainerTidyGridPicker;
