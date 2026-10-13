import type {
  CanvasContainerSize,
  GraphNode,
  NodeGraphViewport,
  NodePosition,
} from '../types';
import type { FitViewOptions } from '@xyflow/react';
import { FIT_VIEW_PADDING } from '../components/canvas/nodeCanvasConstants';
import {
  DERIVED_NODE_HEIGHT_ESTIMATE,
  DERIVED_NODE_WIDTH_ESTIMATE,
} from './derivedNodePlacement';

/**
 * 任务节点批量落位（spec：PromptDock生成主链.md「终态画布投影」）。
 *
 * 提交受理后创建的任务节点必须由构造保证落在用户眼前：
 * - 目标区优先级：视口安全区（与 fitView padding 同语义，避开 PromptDock 底部遮挡）
 *   → 全可见区 → 钳制到可见区左上（极端 zoom 下批量大于视口，允许部分可见）；
 * - 锚点优先级：参考资产节点右侧邻近（生成从输入旁边长出来）→ 安全区中心；
 * - 防重叠：从锚点按批量网格步距向外环形搜索第一个无重叠位置；
 *   可见性优先级高于防重叠——找不到空闲位时允许与既有节点重叠，但不许出可见区。
 *
 * 纯函数，不读 store、不产生日志；调用方根据返回的 mode/containerFallback 留痕。
 * 成功任务首个资产原地 morph（spec 既有语义），因此本落位同时决定成功资产的出现位置。
 */

/** containerSize 缺失（store 未注册完成等边缘时序）时的名义画布尺寸。 */
const NOMINAL_CONTAINER_SIZE = { width: 1440, height: 900 };

/** 批量网格列间距 / 行间距（与旧 (120,120) 网格的 280/200 步距同源）。 */
export const TASK_BATCH_GAP_X = 40;
export const TASK_BATCH_GAP_Y = 40;

/** 防重叠环形搜索最大半径（ring 数），覆盖 17×17 候选位，足够画布日常密度。 */
const MAX_SEARCH_RING = 8;

/** 既有节点的占位估计尺寸（与派生节点落位共用同一估计口径）。 */
const OCCUPANCY_ESTIMATE = {
  width: DERIVED_NODE_WIDTH_ESTIMATE,
  height: DERIVED_NODE_HEIGHT_ESTIMATE,
};

export type TaskBatchPlacementMode =
  | 'safe' // 安全区内命中空闲位
  | 'visible' // 安全区放不下（极端 zoom），退化到全可见区命中
  | 'clamped'; // 可见区也放不下，钳制到可见区左上（允许部分可见/重叠）

export type TaskBatchPlacementInput = {
  /** React Flow 视口（pan 偏移 + zoom），store nodeGraph.viewport 语义 */
  viewport: NodeGraphViewport;
  /** 画布容器屏幕像素尺寸；null 时用名义尺寸兜底 */
  containerSize: CanvasContainerSize | null;
  /** 既有节点（防重叠 + 参考锚定），含组节点（按 store position 估计占位） */
  nodes: ReadonlyArray<GraphNode>;
  /** 批量任务数 N（1..10） */
  count: number;
  /** 单个任务节点尺寸 */
  nodeSize: { width: number; height: number };
  /** 批量网格每行个数 */
  perRow: number;
  /** 草稿引用的资产节点 position（画布坐标，按引用顺序）；空表示无可见参考锚定 */
  referencePositions: ReadonlyArray<NodePosition | null | undefined>;
};

export type TaskBatchPlacementResult = {
  /** 批量网格首格（task_index 0）左上角画布坐标 */
  base: NodePosition;
  mode: TaskBatchPlacementMode;
  /** containerSize 缺失，使用了名义尺寸兜底（调用方据此留痕） */
  containerFallback: boolean;
};

type Rect = { x: number; y: number; width: number; height: number };

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

const rectsIntersect = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

/** 既有节点按统一估计尺寸展开为占位矩形，与候选批量矩形求交。 */
const intersectsAnyNode = (
  nodes: ReadonlyArray<GraphNode>,
  rect: Rect,
): boolean =>
  nodes.some((node) => {
    const nx = node.position?.x ?? 0;
    const ny = node.position?.y ?? 0;
    return rectsIntersect(
      { x: nx, y: ny, width: OCCUPANCY_ESTIMATE.width, height: OCCUPANCY_ESTIMATE.height },
      rect,
    );
  });

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/** 候选位是否可用：完整落在 target 内且不与既有节点重叠。 */
const isCandidateFree = (
  nodes: ReadonlyArray<GraphNode>,
  batchRect: Rect,
  target: Rect,
): boolean => {
  if (
    batchRect.x < target.x ||
    batchRect.y < target.y ||
    batchRect.x + batchRect.width > target.x + target.width ||
    batchRect.y + batchRect.height > target.y + target.height
  ) {
    return false;
  }
  return !intersectsAnyNode(nodes, batchRect);
};

/**
 * 从锚点按网格步距向外环形搜索第一个空闲位。
 * ring 0 即锚点本身；同 ring 内按与锚点的曼哈顿距离升序，保证结果确定性。
 */
const searchFreeBase = (
  nodes: ReadonlyArray<GraphNode>,
  anchor: NodePosition,
  batchRect: Rect,
  target: Rect,
  stepX: number,
  stepY: number,
): NodePosition | null => {
  for (let ring = 0; ring <= MAX_SEARCH_RING; ring += 1) {
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
    for (const { dx, dy } of offsets) {
      const candidate: Rect = {
        x: anchor.x + dx * stepX,
        y: anchor.y + dy * stepY,
        width: batchRect.width,
        height: batchRect.height,
      };
      if (isCandidateFree(nodes, candidate, target)) {
        return { x: candidate.x, y: candidate.y };
      }
    }
  }
  return null;
};

/**
 * 计算一批任务节点的落位基底（批量网格首格左上角）。
 * 收敛层级见 TaskBatchPlacementMode；任何输入下都返回可见区内的合法坐标。
 */
export const computeTaskBatchPlacement = (
  input: TaskBatchPlacementInput,
): TaskBatchPlacementResult => {
  const containerFallback = input.containerSize === null;
  const container = input.containerSize ?? NOMINAL_CONTAINER_SIZE;
  // React Flow 语义：screen = world * zoom + pan → 可见世界矩形 = 反变换（屏幕 0,0 与容器右下角）
  const zoom = Number.isFinite(input.viewport.zoom) && input.viewport.zoom > 0 ? input.viewport.zoom : 1;
  const visible: Rect = {
    x: -input.viewport.x / zoom,
    y: -input.viewport.y / zoom,
    width: container.width / zoom,
    height: container.height / zoom,
  };

  // 安全区与 fitView padding 同语义：同一区域内的节点，未来 fitView 后依然可见
  const insets = fitViewPaddingRatios(FIT_VIEW_PADDING);
  const safe: Rect = {
    x: visible.x + insets.left * visible.width,
    y: visible.y + insets.top * visible.height,
    width: visible.width * (1 - insets.left - insets.right),
    height: visible.height * (1 - insets.top - insets.bottom),
  };

  const rows = Math.max(1, Math.ceil(input.count / Math.max(1, input.perRow)));
  const cols = Math.min(Math.max(1, input.perRow), Math.max(1, input.count));
  const batchWidth = cols * input.nodeSize.width + (cols - 1) * TASK_BATCH_GAP_X;
  const batchHeight = rows * input.nodeSize.height + (rows - 1) * TASK_BATCH_GAP_Y;
  const batchRect: Rect = { x: 0, y: 0, width: batchWidth, height: batchHeight };

  // 锚点：参考资产右侧邻近 > 安全区中心
  const primaryReference = input.referencePositions.find((p) => p !== null && p !== undefined);
  const anchor: NodePosition =
    primaryReference !== undefined
      ? { x: primaryReference.x + input.nodeSize.width + TASK_BATCH_GAP_X, y: primaryReference.y }
      : {
          x: safe.x + (safe.width - batchWidth) / 2,
          y: safe.y + (safe.height - batchHeight) / 2,
        };
  batchRect.x = anchor.x;
  batchRect.y = anchor.y;

  const safeHit = searchFreeBase(
    input.nodes,
    anchor,
    batchRect,
    safe,
    input.nodeSize.width + TASK_BATCH_GAP_X,
    input.nodeSize.height + TASK_BATCH_GAP_Y,
  );
  if (safeHit !== null) {
    return { base: safeHit, mode: 'safe', containerFallback };
  }

  const visibleHit = searchFreeBase(
    input.nodes,
    anchor,
    batchRect,
    visible,
    input.nodeSize.width + TASK_BATCH_GAP_X,
    input.nodeSize.height + TASK_BATCH_GAP_Y,
  );
  if (visibleHit !== null) {
    return { base: visibleHit, mode: 'visible', containerFallback };
  }

  // 可见性优先于防重叠：钳制到可见区左上（批量大于可见区时左上对齐，保住最大可见部分）
  return {
    base: {
      x: clamp(anchor.x, visible.x, Math.max(visible.x, visible.x + visible.width - batchWidth)),
      y: clamp(anchor.y, visible.y, Math.max(visible.y, visible.y + visible.height - batchHeight)),
    },
    mode: 'clamped',
    containerFallback,
  };
};
