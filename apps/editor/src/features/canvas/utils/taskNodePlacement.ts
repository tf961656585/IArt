import type {
  CanvasContainerSize,
  GraphNode,
  NodeGraphViewport,
  NodePosition,
} from '../types';
import type { FitViewOptions } from '@xyflow/react';
import { FIT_VIEW_PADDING } from '../components/canvas/nodeCanvasConstants';
import type { EffectiveSizeSources } from './effectiveSize';
import { buildNodeOccupancyRects, type OccupancyRect } from './nodeOccupancy';

/**
 * 任务节点批量落位（spec：PromptDock生成主链.md「终态画布投影」、
 * 固定任务数批次提交与投影语义.md「出生落位」）。
 *
 * 提交受理后创建的任务节点必须由构造保证落在用户眼前：
 * - 目标区优先级：视口安全区（与 fitView padding 同语义，避开 PromptDock 底部遮挡）
 *   → 全可见区 → 无界平面（前两档放不下时允许落到可见区外）；
 * - 锚点优先级：参考资产节点右侧邻近（生成从输入旁边长出来）→ 安全区中心；
 * - 防重叠：从锚点按批量网格步距向外环形搜索第一个与任何既有节点占位不相交的位置，
 *   直到找到为止——不存在「允许重叠」的兜底路径；
 * - 既有节点占位按真实有效尺寸解析（resolveEffectiveSize 主链），容器节点（组 | Agent 容器）
 *   按派生包围盒整体占位（展开态成员包围盒派生、折叠态折叠卡片），口径见 nodeOccupancy.ts；
 * - 批内整块求交：整批矩形作为整体参与搜索，批内节点由网格构造保证互不重叠。
 *
 * 纯函数，不读 store、不产生日志；调用方根据返回的 mode/containerFallback 留痕。
 * 成功任务首个资产原地 morph（spec 既有语义），因此本落位同时决定成功资产的出现位置。
 */

/** containerSize 缺失（store 未注册完成等边缘时序）时的名义画布尺寸。 */
const NOMINAL_CONTAINER_SIZE = { width: 1440, height: 900 };

/**
 * 视口可见区与安全区矩形（共享几何源）：出生落位与 CLI 空组建组的初始定位共用同一套
 * 可见区/安全区推导（fitView padding 同语义），禁止第二份反变换实现。
 */
export const computeViewportRects = (
  viewport: NodeGraphViewport,
  containerSize: CanvasContainerSize | null,
): { visible: OccupancyRect; safe: OccupancyRect; containerFallback: boolean } => {
  const containerFallback = containerSize === null;
  const container = containerSize ?? NOMINAL_CONTAINER_SIZE;
  // React Flow 语义：screen = world * zoom + pan → 可见世界矩形 = 反变换（屏幕 0,0 与容器右下角）
  const zoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1;
  const visible: OccupancyRect = {
    x: -viewport.x / zoom,
    y: -viewport.y / zoom,
    width: container.width / zoom,
    height: container.height / zoom,
  };
  // 安全区与 fitView padding 同语义：同一区域内的节点，未来 fitView 后依然可见
  const insets = fitViewPaddingRatios(FIT_VIEW_PADDING);
  const safe: OccupancyRect = {
    x: visible.x + insets.left * visible.width,
    y: visible.y + insets.top * visible.height,
    width: visible.width * (1 - insets.left - insets.right),
    height: visible.height * (1 - insets.top - insets.bottom),
  };
  return { visible, safe, containerFallback };
};

/** 批量网格列间距 / 行间距。 */
export const TASK_BATCH_GAP_X = 40;
export const TASK_BATCH_GAP_Y = 40;

/**
 * 环形搜索防御性硬上限（ring 数）。
 *
 * 无界平面上的环形搜索必然命中空闲位（障碍集合有限、候选位随 ring 无限扩展），
 * 此上限只为防御实现缺陷（如占位矩形被污染成覆盖全平面）导致的死循环：
 * 超限视为内部断言失败——记 error 级日志后抛错，绝不静默回落到允许重叠的落位。
 */
const RING_SEARCH_HARD_CAP = 200;

export type TaskBatchPlacementMode =
  | 'safe' // 安全区内命中空闲位
  | 'visible' // 安全区放不下（极端 zoom / 拥挤），退化到全可见区命中
  | 'unbounded'; // 可见区也放不下，无界平面搜索命中（允许落到可见区外，仍不重叠）

/** 单个块内格子的相对几何（相对块原点的偏移 + 自身尺寸）。 */
export type PlacementCell = {
  dx: number;
  dy: number;
  width: number;
  height: number;
};

export type TaskBatchPlacementInput = {
  /** React Flow 视口（pan 偏移 + zoom），store nodeGraph.viewport 语义 */
  viewport: NodeGraphViewport;
  /** 画布容器屏幕像素尺寸；null 时用名义尺寸兜底 */
  containerSize: CanvasContainerSize | null;
  /** 既有节点（防重叠 + 参考锚定），含组节点（按派生包围盒占位） */
  nodes: ReadonlyArray<GraphNode>;
  /** 批量任务数 N（1..10） */
  count: number;
  /** 单个任务节点尺寸 */
  nodeSize: { width: number; height: number };
  /** 批量网格每行个数 */
  perRow: number;
  /** 草稿引用的资产节点 position（画布坐标，按引用顺序）；空表示无可见参考锚定 */
  referencePositions: ReadonlyArray<NodePosition | null | undefined>;
  /** 既有节点真实有效尺寸来源（spec：画布节点尺寸管理架构.md 统一解析入口） */
  sizeSources: EffectiveSizeSources;
  /**
   * 锚点覆盖（CLI 出生入组，spec CLI-043）：指定时跳过参考资产右侧/安全区中心锚定，
   * 直接以该坐标为块原点首选位置（组内锚定由调用方计算后传入）。
   */
  anchorOverride?: NodePosition;
  /**
   * 占位排除集（CLI 出生入组）：目标容器自身派生包围盒不计为障碍（批次要扩展它），
   * 其成员仍按自身矩形占位；其他容器包围盒照常计为障碍。
   */
  excludeNodeIds?: ReadonlySet<string>;
};

export type TaskBatchPlacementResult = {
  /** 批量网格首格（task_index 0）左上角画布坐标 */
  base: NodePosition;
  mode: TaskBatchPlacementMode;
  /** containerSize 缺失，使用了名义尺寸兜底（调用方据此留痕） */
  containerFallback: boolean;
  /** 批量整块包围盒（画布坐标，随最终落位） */
  batchBounds: OccupancyRect;
  /** 可见区包围盒（画布坐标） */
  visibleBounds: OccupancyRect;
};

type FitViewPadding = NonNullable<FitViewOptions['padding']>;

/** 单侧 padding 值（"20%"）→ 比例（0.2）；非法值回退 0。 */
const readPaddingRatio = (value: string | number | undefined): number => {
  if (value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number.parseFloat(value) / 100;
  return Number.isFinite(parsed) ? parsed : 0;
};

/** 把 fitView padding（Padding union）展开为四侧比例；当前常量恒为四侧百分比对象，其余形态为防御兜底。 */
const fitViewPaddingRatios = (
  padding: FitViewPadding,
): { top: number; right: number; bottom: number; left: number } => {
  if (typeof padding === 'number' || typeof padding === 'string') {
    const uniform = readPaddingRatio(padding);
    return { top: uniform, right: uniform, bottom: uniform, left: uniform };
  }
  return {
    top: readPaddingRatio(padding.top),
    right: readPaddingRatio(padding.right),
    bottom: readPaddingRatio(padding.bottom),
    left: readPaddingRatio(padding.left),
  };
};

export const rectsIntersect = (a: OccupancyRect, b: OccupancyRect): boolean =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

/** 候选块（全部格子）是否与任一占位矩形相交。 */
const cellsIntersectAnyOccupancy = (
  occupancy: ReadonlyArray<OccupancyRect>,
  anchorOrigin: NodePosition,
  cells: ReadonlyArray<PlacementCell>,
): boolean => {
  for (const cell of cells) {
    const rect: OccupancyRect = {
      x: anchorOrigin.x + cell.dx,
      y: anchorOrigin.y + cell.dy,
      width: cell.width,
      height: cell.height,
    };
    for (const occupied of occupancy) {
      if (rectsIntersect(rect, occupied)) return true;
    }
  }
  return false;
};

/** 候选块（全部格子）是否完整落在目标区内。 */
const cellsInsideTarget = (
  anchorOrigin: NodePosition,
  cells: ReadonlyArray<PlacementCell>,
  target: OccupancyRect,
): boolean => {
  for (const cell of cells) {
    const x = anchorOrigin.x + cell.dx;
    const y = anchorOrigin.y + cell.dy;
    if (
      x < target.x ||
      y < target.y ||
      x + cell.width > target.x + target.width ||
      y + cell.height > target.y + target.height
    ) {
      return false;
    }
  }
  return true;
};

/** 锚点到「块原点可行窗口」最远角的 ring 上界（超出后不可能有候选完整落在目标内）。 */
const maxRingForTarget = (
  anchor: NodePosition,
  cells: ReadonlyArray<PlacementCell>,
  target: OccupancyRect,
  stepX: number,
  stepY: number,
): number => {
  // 块原点可行窗口：全部格子完整落在目标内的原点取值范围（稀疏格窗口可越出目标边界）
  const minDx = Math.min(...cells.map((cell) => cell.dx));
  const maxRight = Math.max(...cells.map((cell) => cell.dx + cell.width));
  const minDy = Math.min(...cells.map((cell) => cell.dy));
  const maxBottom = Math.max(...cells.map((cell) => cell.dy + cell.height));
  const originMinX = target.x - minDx;
  const originMaxX = target.x + target.width - maxRight;
  const originMinY = target.y - minDy;
  const originMaxY = target.y + target.height - maxBottom;
  if (originMinX > originMaxX || originMinY > originMaxY) return -1;
  const farX = Math.max(
    Math.abs(originMinX - anchor.x),
    Math.abs(originMaxX - anchor.x),
  );
  const farY = Math.max(
    Math.abs(originMinY - anchor.y),
    Math.abs(originMaxY - anchor.y),
  );
  return Math.ceil(Math.max(farX / stepX, farY / stepY));
};

/** 同 ring 内候选偏移按与锚点的曼哈顿距离升序，保证结果确定性。 */
const ringOffsets = (ring: number): Array<{ dx: number; dy: number }> => {
  const offsets: Array<{ dx: number; dy: number }> = [];
  for (let dx = -ring; dx <= ring; dx += 1) {
    for (let dy = -ring; dy <= ring; dy += 1) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
      offsets.push({ dx, dy });
    }
  }
  offsets.sort(
    (a, b) =>
      Math.abs(a.dx) + Math.abs(a.dy) - (Math.abs(b.dx) + Math.abs(b.dy)),
  );
  return offsets;
};

export type SearchFreeBlockParams = {
  /** 既有占位矩形集合（含容器派生包围盒） */
  occupancy: ReadonlyArray<OccupancyRect>;
  /** 搜索锚点（块原点的首选位置） */
  anchor: NodePosition;
  /** 块内格子（相对块原点）；稀疏格（如追加资产）与稠密网格（批量）同一搜索引擎 */
  cells: ReadonlyArray<PlacementCell>;
  stepX: number;
  stepY: number;
  /** 候选格全部完整落在其中的目标区；null = 无界平面（搜索直到命中） */
  target: OccupancyRect | null;
};

/**
 * 从锚点按网格步距向外环形搜索第一个与任何既有占位都不相交的块原点位置。
 *
 * 有界目标：候选必须完整落在目标区内，扫描 ring 上界由目标几何导出；
 * 无界目标：搜索直到命中为止，仅受防御性硬上限约束（超限抛内部断言，见 RING_SEARCH_HARD_CAP）。
 * 返回 null 仅发生在有界目标耗尽（该档放不下）；无界目标不返回 null。
 */
export const searchFreeBlockPosition = (params: SearchFreeBlockParams): NodePosition | null => {
  const { occupancy, anchor, cells, stepX, stepY, target } = params;
  if (cells.length === 0) return { x: anchor.x, y: anchor.y };

  let maxRing = RING_SEARCH_HARD_CAP;
  if (target !== null) {
    maxRing = maxRingForTarget(anchor, cells, target, stepX, stepY);
    if (maxRing < 0) return null; // 整块放不进目标区
  }

  for (let ring = 0; ring <= maxRing; ring += 1) {
    for (const { dx, dy } of ringOffsets(ring)) {
      const candidate: NodePosition = {
        x: anchor.x + dx * stepX,
        y: anchor.y + dy * stepY,
      };
      if (target !== null && !cellsInsideTarget(candidate, cells, target)) continue;
      if (cellsIntersectAnyOccupancy(occupancy, candidate, cells)) continue;
      return candidate;
    }
  }

  if (target === null) {
    console.error(
      '[taskNodePlacement] ring search exceeded hard cap without finding a free position (internal assertion)',
      { cap: RING_SEARCH_HARD_CAP, cells: cells.length, occupancy: occupancy.length, anchor },
    );
    throw new Error(
      `[taskNodePlacement] ring search exceeded hard cap (${RING_SEARCH_HARD_CAP} rings) — internal assertion, placement must never silently overlap`,
    );
  }
  return null;
};

/** 批量网格格子（task_index → 列/行，稠密网格）。 */
const buildBatchCells = (
  count: number,
  perRow: number,
  nodeSize: { width: number; height: number },
): { cells: PlacementCell[]; batchWidth: number; batchHeight: number } => {
  const rows = Math.max(1, Math.ceil(count / Math.max(1, perRow)));
  const cols = Math.min(Math.max(1, perRow), Math.max(1, count));
  const columnWidth = nodeSize.width + TASK_BATCH_GAP_X;
  const rowHeight = nodeSize.height + TASK_BATCH_GAP_Y;
  const cells: PlacementCell[] = [];
  for (let index = 0; index < count; index += 1) {
    cells.push({
      dx: (index % perRow) * columnWidth,
      dy: Math.floor(index / perRow) * rowHeight,
      width: nodeSize.width,
      height: nodeSize.height,
    });
  }
  return {
    cells,
    batchWidth: cols * nodeSize.width + (cols - 1) * TASK_BATCH_GAP_X,
    batchHeight: rows * nodeSize.height + (rows - 1) * TASK_BATCH_GAP_Y,
  };
};

/**
 * 按各节点真实尺寸计算网格格子：列宽 = 该列最大宽、行高 = 该行最大高（间隔固定）。
 *
 * 共享消费者：成功 morph 的追加资产落位与批次收口重排（两者必须产出同一网格口径，
 * 禁止各自复制列/行宽计算）。尺寸由调用方解析（morph 期用媒体期望布局尺寸、
 * 收口期用 resolveEffectiveSize），本函数只负责几何。
 */
export const computeGridCellsForSizes = (
  sizes: ReadonlyArray<{ width: number; height: number }>,
  perRow: number,
  gapX: number,
  gapY: number,
): { cells: PlacementCell[] } => {
  const columnWidths: number[] = [];
  const rowHeights: number[] = [];
  for (let index = 0; index < sizes.length; index += 1) {
    const size = sizes[index];
    if (!size) continue;
    const col = index % perRow;
    const row = Math.floor(index / perRow);
    columnWidths[col] = Math.max(columnWidths[col] ?? 0, size.width);
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, size.height);
  }
  const columnX: number[] = [];
  const rowY: number[] = [];
  for (let col = 0; col < columnWidths.length; col += 1) {
    columnX[col] =
      col === 0 ? 0 : (columnX[col - 1] ?? 0) + (columnWidths[col - 1] ?? 0) + gapX;
  }
  for (let row = 0; row < rowHeights.length; row += 1) {
    rowY[row] =
      row === 0 ? 0 : (rowY[row - 1] ?? 0) + (rowHeights[row - 1] ?? 0) + gapY;
  }
  const cells: PlacementCell[] = [];
  for (let index = 0; index < sizes.length; index += 1) {
    const size = sizes[index];
    if (!size) continue;
    const col = index % perRow;
    const row = Math.floor(index / perRow);
    cells.push({
      dx: columnX[col] ?? 0,
      dy: rowY[row] ?? 0,
      width: size.width,
      height: size.height,
    });
  }
  return { cells };
};

/**
 * 计算一批任务节点的落位基底（批量网格首格左上角）。
 * 收敛层级见 TaskBatchPlacementMode：安全区 → 可见区 → 无界平面，
 * 任何输入下都返回与既有节点零重叠的合法坐标，不存在允许重叠的兜底路径。
 */
export const computeTaskBatchPlacement = (
  input: TaskBatchPlacementInput,
): TaskBatchPlacementResult => {
  const { visible, safe, containerFallback } = computeViewportRects(input.viewport, input.containerSize);

  const { cells, batchWidth, batchHeight } = buildBatchCells(
    input.count,
    input.perRow,
    input.nodeSize,
  );

  // 锚点：显式覆盖（CLI 出生入组）> 参考资产右侧邻近 > 安全区中心
  const primaryReference = input.referencePositions.find((p) => p !== null && p !== undefined);
  const anchor: NodePosition =
    input.anchorOverride !== undefined
      ? input.anchorOverride
      : primaryReference !== undefined
        ? { x: primaryReference.x + input.nodeSize.width + TASK_BATCH_GAP_X, y: primaryReference.y }
        : {
            x: safe.x + (safe.width - batchWidth) / 2,
            y: safe.y + (safe.height - batchHeight) / 2,
          };

  const occupancy = buildNodeOccupancyRects(
    input.nodes,
    input.sizeSources,
    // exactOptionalPropertyTypes：未指定时不携带键，不显式传 undefined
    ...(input.excludeNodeIds !== undefined ? [{ excludeNodeIds: input.excludeNodeIds }] : []),
  );
  const columnWidth = input.nodeSize.width + TASK_BATCH_GAP_X;
  const rowHeight = input.nodeSize.height + TASK_BATCH_GAP_Y;

  const safeHit = searchFreeBlockPosition({
    occupancy,
    anchor,
    cells,
    stepX: columnWidth,
    stepY: rowHeight,
    target: safe,
  });
  if (safeHit !== null) {
    return {
      base: safeHit,
      mode: 'safe',
      containerFallback,
      batchBounds: { x: safeHit.x, y: safeHit.y, width: batchWidth, height: batchHeight },
      visibleBounds: visible,
    };
  }

  const visibleHit = searchFreeBlockPosition({
    occupancy,
    anchor,
    cells,
    stepX: columnWidth,
    stepY: rowHeight,
    target: visible,
  });
  if (visibleHit !== null) {
    return {
      base: visibleHit,
      mode: 'visible',
      containerFallback,
      batchBounds: { x: visibleHit.x, y: visibleHit.y, width: batchWidth, height: batchHeight },
      visibleBounds: visible,
    };
  }

  // 可见区也放不下：无界平面搜索（不重叠仍是硬约束，允许落到可见区外）
  const unboundedHit = searchFreeBlockPosition({
    occupancy,
    anchor,
    cells,
    stepX: columnWidth,
    stepY: rowHeight,
    target: null,
  });
  if (unboundedHit === null) {
    // 防御分支（理论不可达：无界搜索超限已在 search 内抛内部断言）
    throw new Error('[taskNodePlacement] unbounded search returned null — internal assertion');
  }
  return {
    base: unboundedHit,
    mode: 'unbounded',
    containerFallback,
    batchBounds: { x: unboundedHit.x, y: unboundedHit.y, width: batchWidth, height: batchHeight },
    visibleBounds: visible,
  };
};
