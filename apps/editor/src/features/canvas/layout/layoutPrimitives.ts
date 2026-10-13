/**
 * 布局基础工具：snap grid 对齐、网格流式摆列、默认尺寸常量。
 *
 * 这些工具与具体布局引擎无关，ELK 适配器与对齐工具共同消费。
 * 从原 autoLayoutGraph.ts / autoLayoutPlacement.ts 迁移而来。
 */

import type { GraphNode, NodePosition, NodeSize } from '../types';
import { DEFAULT_NODE_SIZE } from '../utils/effectiveSize';

/**
 * 默认节点尺寸（节点缺失尺寸时的兜底）。
 *
 * 单一事实源为 `utils/effectiveSize.ts` 的 DEFAULT_NODE_SIZE（spec：画布节点尺寸管理架构.md
 * 禁止在多处复制默认尺寸常量字面量）。此处仅 re-export，避免布局层与尺寸架构层分裂为两份值。
 */
export { DEFAULT_NODE_SIZE };

/** 层间距（主轴方向相邻两层间距）。固定常量，spec：画布自动布局算法.md「布局配置项」。 */
export const LAYER_GAP = 200;

/** 同层节点间距（次轴方向相邻节点间距）。固定常量，spec：画布自动布局算法.md「布局配置项」。 */
export const NODE_GAP = 120;

/** 对齐到网格 */
export const alignToGrid = (value: number, grid: number): number =>
  Math.round(value / grid) * grid;

/** 对齐坐标点到网格 */
export const alignPosition = (pos: NodePosition, grid: [number, number]): NodePosition => ({
  x: alignToGrid(pos.x, grid[0]),
  y: alignToGrid(pos.y, grid[1]),
});

/** 向上取整对齐到网格（用于间距修正，保证不小于所需值） */
export const alignToGridCeil = (value: number, grid: number): number =>
  Math.ceil(value / grid) * grid;

/** 规范化列数：非有限值或小于 1 时回落单列，且不超过参与摆放的节点数。 */
const normalizeColumnCount = (columns: number, nodeCount: number): number => {
  if (!Number.isFinite(columns) || columns < 1) return 1;
  return Math.min(Math.floor(columns), nodeCount);
};

/**
 * 网格流式摆放：按列数分行，行内从左到右、行间自上而下。
 *
 * 列数由调用层给出（容器内整理的「整理为网格」本次选取值）；行数由节点数与列数决定
 * （`ceil(节点数 / 列数)`），不产生空行。列宽取该列节点有效宽度的最大值，行高取该行
 * 有效高度的最大值，相邻列/行间距固定 `nodeGap`，位置按 `grid` 对齐。
 * 列数为 1 时退化为单列垂直摆列（全局整理与默认容器内整理口径）。
 *
 * 只消费尺寸集合，不读写 store、不感知分组语义。
 * spec：docs/runtime/画布自动布局算法.md「网格摆放」。
 */
export const placeGridFlow = (
  nodes: GraphNode[],
  sizeMap: Map<string, NodeSize>,
  grid: [number, number],
  nodeGap: number,
  columns: number,
): Record<string, NodePosition> => {
  const positions: Record<string, NodePosition> = {};
  if (nodes.length === 0) return positions;

  const columnCount = normalizeColumnCount(columns, nodes.length);
  const rowCount = Math.ceil(nodes.length / columnCount);

  // 列宽 = 该列节点有效宽度最大值；行高 = 该行节点有效高度最大值。
  const columnWidths: number[] = Array.from({ length: columnCount }, () => 0);
  const rowHeights: number[] = Array.from({ length: rowCount }, () => 0);
  nodes.forEach((node, index) => {
    const size = sizeMap.get(node.id) ?? DEFAULT_NODE_SIZE;
    const column = index % columnCount;
    const row = Math.floor(index / columnCount);
    columnWidths[column] = Math.max(columnWidths[column] ?? 0, size.width);
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, size.height);
  });

  const columnOffsets: number[] = [];
  let currentX = 0;
  for (let column = 0; column < columnCount; column += 1) {
    columnOffsets.push(currentX);
    currentX += (columnWidths[column] ?? 0) + nodeGap;
  }
  const rowOffsets: number[] = [];
  let currentY = 0;
  for (let row = 0; row < rowCount; row += 1) {
    rowOffsets.push(currentY);
    currentY += (rowHeights[row] ?? 0) + nodeGap;
  }

  nodes.forEach((node, index) => {
    const column = index % columnCount;
    const row = Math.floor(index / columnCount);
    const rawPos: NodePosition = {
      x: columnOffsets[column] ?? 0,
      y: rowOffsets[row] ?? 0,
    };
    positions[node.id] = alignPosition(rawPos, grid);
  });

  return positions;
};
