/**
 * CLI 画布新建节点的防重叠落位（spec docs/integrations/CLI与本地Agent集成.md §5.3）。
 *
 * 从 cliAssetImport.ts 抽出的共享落位（同一几何源，批次资产回填与素材导入共用，
 * 避免第二套防重叠实现）：
 * - 视口安全区（`computeViewportRects`）→ 可见区 → 无界平面三档退让；
 * - 批内相对几何由 `computeGridCellsForSizes` 按节点类型默认尺寸（注册表 defaultSize）构造；
 * - 整块经 `searchFreeBlockPosition` 定位，不重叠是硬约束（不存在允许重叠的兜底）。
 *
 * 纯读 store：只读取 nodeGraph / canvasContainerSize 计算落位，不写任何状态。
 */

import type { GraphNodeType, NodePosition } from '@/features/canvas/types/node';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { normalizeViewport } from '@/features/canvas/components/canvas/nodeCanvasConstants';
import { resolveNodeTypeDefaultSize } from '@/features/canvas/utils/effectiveSize';
import {
  buildCanvasSizeSources,
  buildNodeOccupancyRects,
  type OccupancyRect,
} from '@/features/canvas/utils/nodeOccupancy';
import {
  TASK_BATCH_GAP_X,
  TASK_BATCH_GAP_Y,
  computeGridCellsForSizes,
  computeViewportRects,
  searchFreeBlockPosition,
} from '@/features/canvas/utils/taskNodePlacement';

/** 批量落位网格每行个数（与任务批次投影落位同口径：3 列一块）。 */
const PER_ROW = 3;

/**
 * 计算一批新节点的落位坐标（与 nodeTypes 顺序一一对应）。
 *
 * 返回 null 仅发生在图未载入（防御分支）；无界搜索不返回 null（超限在搜索内抛内部断言），
 * 走到 null 说明画布几何输入异常，由调用方如实报错。
 */
export const computeCliPlacementPositions = (
  nodeTypes: readonly GraphNodeType[],
): NodePosition[] | null => {
  const state = useCanvasStore.getState();
  const graph = state.nodeGraph;
  if (graph === null) return null;

  const { visible, safe } = computeViewportRects(
    normalizeViewport(graph.viewport),
    state.ui.canvasContainerSize,
  );
  const sizes = nodeTypes.map((nodeType) => resolveNodeTypeDefaultSize(nodeType));
  const { cells } = computeGridCellsForSizes(sizes, PER_ROW, TASK_BATCH_GAP_X, TASK_BATCH_GAP_Y);
  const firstCell = cells[0];
  if (firstCell === undefined) return [];
  const batchWidth = Math.max(...cells.map((cell) => cell.dx + cell.width));
  const batchHeight = Math.max(...cells.map((cell) => cell.dy + cell.height));
  const anchor: NodePosition = {
    x: safe.x + (safe.width - batchWidth) / 2,
    y: safe.y + (safe.height - batchHeight) / 2,
  };
  const stepX = Math.max(...sizes.map((size) => size.width)) + TASK_BATCH_GAP_X;
  const stepY = Math.max(...sizes.map((size) => size.height)) + TASK_BATCH_GAP_Y;
  const search = (target: OccupancyRect | null): NodePosition | null =>
    searchFreeBlockPosition({
      occupancy: buildNodeOccupancyRects(graph.nodes, buildCanvasSizeSources(state)),
      anchor,
      cells,
      stepX,
      stepY,
      target,
    });

  const base = search(safe) ?? search(visible) ?? search(null);
  if (base === null) {
    // 防御分支：无界搜索不返回 null，走到这里说明几何输入被污染。
    console.debug('[cliCanvasPlacement] placement search exhausted all target zones', {
      nodeCount: nodeTypes.length,
    });
    return null;
  }
  return cells.map((cell) => ({ x: base.x + cell.dx, y: base.y + cell.dy }));
};
