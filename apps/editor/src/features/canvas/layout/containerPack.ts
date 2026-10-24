/**
 * 顶层容器「看板式」排布（CLI `canvas layout --scope containers --pack`）—— 纯函数。
 *
 * 语义（spec docs/integrations/CLI与本地Agent集成.md §5.3 / CLI-055）：
 * - 输入顺序由调用方先排好（显式 order 优先，其余按当前渲染框阅读序跟排），本文件不再排序；
 * - 列数 = 显式值，缺省取 `max(1, ceil(sqrt(N)))`（大致方形看板）；
 * - 原点 = 所有容器渲染框左上角的 min(x) / min(y)，让看板留在原有内容附近，不整体跳走；
 *   整块左上角（锚点）吸附到最近网格点（`snapGrid <= 1` 时原样），格子内不再逐点取整；
 * - 逐行排：每行最多 columns 个，行高取该行容器高度最大值，x 依次累加「上一个宽 + gap」，
 *   y 按「行高 + gap」下移；相邻渲染框间距**精确等于** gap，不因网格吸附而变化；
 * - 纯函数：无 IO、无 DOM、无随机；相同输入必然产出相同结果。
 *
 * 与旧路径的关系：旧 `scope=containers`（只消除相交）只调整相交容器，不使用本文件的
 * 看板排布；`scope=all|group` 的网格摆放同样采用「锚点吸附一次 + 格子内精确间距」口径
 *（spec：docs/runtime/画布自动布局算法.md AL-GC-004/AL-GC-006）。
 */

import type { NodePosition, NodeSize } from '../types';
import { alignToGrid } from './layoutPrimitives';
import { orderByReadingPosition, READING_ORDER_ROW_TOLERANCE_PX } from './readingOrder';

export type ContainerPackBox = {
  /** 容器渲染框左上角（派生框；空容器/折叠容器为其存储 position）。 */
  position: NodePosition;
  /** 容器渲染框尺寸（派生尺寸；无派生框时为静态有效尺寸）。 */
  size: NodeSize;
};

export type ContainerPackInput = {
  id: string;
  box: ContainerPackBox;
};

export type ContainerPackPlacement = {
  id: string;
  /** 渲染框左上角目标坐标（整块锚点吸附后；格子内间距精确等于 gap）。 */
  position: NodePosition;
};

export type ContainerPackResult = {
  /** 实际使用的列数（显式值或缺省推导值）。 */
  columns: number;
  /** 输入容器渲染框左上角的 min(x)/min(y)（未对齐的原始原点，供调试与人读对照）。 */
  origin: NodePosition;
  /** 按输入序逐个容器的目标渲染框左上角。 */
  placements: ContainerPackPlacement[];
};

export type ComputeContainerPackParams = {
  /** 输入顺序必须由调用方先排好（显式 order 优先，其余阅读序）。 */
  containers: readonly ContainerPackInput[];
  /** 显式列数（正整数）；null 时按 sqrt(N) 推导。 */
  columns: number | null;
  /** 容器间距（非负整数；0 合法）。 */
  gap: number;
  /** 网格步距标量；<= 1 时不做对齐。 */
  snapGrid: number;
};

/** 缺省列数：大致方形看板（1 个容器时为 1 列）。 */
export const deriveContainerPackColumns = (containerCount: number): number => {
  if (containerCount <= 0) return 1;
  return Math.max(1, Math.ceil(Math.sqrt(containerCount)));
};

/** 整块锚点吸附到最近网格点；`snapGrid <= 1`（含非法值）时原样返回。 */
const snapToGrid = (value: number, grid: number): number =>
  Number.isFinite(grid) && grid > 1 ? alignToGrid(value, grid) : value;

/**
 * 计算看板排布目标位置。
 *
 * `placements` 与输入 `containers` 一一对应且同序。
 */
export const computeContainerPack = (
  params: ComputeContainerPackParams,
): ContainerPackResult => {
  const { containers, gap, snapGrid } = params;
  const columns =
    params.columns !== null && Number.isFinite(params.columns) && params.columns >= 1
      ? Math.floor(params.columns)
      : deriveContainerPackColumns(containers.length);

  if (containers.length === 0) {
    return { columns, origin: { x: 0, y: 0 }, placements: [] };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const container of containers) {
    minX = Math.min(minX, container.box.position.x);
    minY = Math.min(minY, container.box.position.y);
  }
  const origin: NodePosition = { x: minX, y: minY };
  // 锚点只吸附一次：整块左上角落到最近网格点；格子内坐标保持精确间距。
  const boardOrigin: NodePosition = {
    x: snapToGrid(minX, snapGrid),
    y: snapToGrid(minY, snapGrid),
  };

  const placements: ContainerPackPlacement[] = [];
  let cursorY = boardOrigin.y;
  for (let rowStart = 0; rowStart < containers.length; rowStart += columns) {
    const row = containers.slice(rowStart, rowStart + columns);
    let rowHeight = 0;
    for (const container of row) {
      rowHeight = Math.max(rowHeight, container.box.size.height);
    }
    let cursorX = boardOrigin.x;
    for (const container of row) {
      placements.push({ id: container.id, position: { x: cursorX, y: cursorY } });
      cursorX += container.box.size.width + gap;
    }
    cursorY += rowHeight + gap;
  }

  return { columns, origin, placements };
};

/**
 * 阅读序容差（像素）：y 差在 1px 内视为同一行，按 x 从小到大排。
 *
 * 保留导出以兼容既有调用方/测试；值直接取视觉阅读序共享原语的同一常量
 *（`readingOrder.ts` 是唯一实现，本文件不再自带第二份排序口径）。
 */
export const CONTAINER_PACK_READING_ROW_TOLERANCE = READING_ORDER_ROW_TOLERANCE_PX;

/** 容器渲染框在视觉阅读序里的输入投影（只暴露 id + 渲染框左上角）。 */
type PackReadingOrderEntry = {
  readonly id: string;
  readonly position: NodePosition;
};

/**
 * pack 输入排序：显式 order 优先（重复 id 按首次出现去重），未指定的容器按
 * 「当前渲染框的阅读序」跟排——排序由共享原语 `orderByReadingPosition` 承担
 *（先按 y 分行、y 差 ≤1px 同一行、行内按 x、完全同坐标按插入序兜底）。
 *
 * 纯重排语义：order 中的未知 / 越界 id 在此只被忽略，有效性由调用方前置校验拒绝
 *（与 `applyLayoutInputOrder` 的分层一致）。
 */
export const orderContainersForPack = <TInput extends ContainerPackInput>(
  containers: readonly TInput[],
  explicitOrder: readonly string[],
): TInput[] => {
  const byId = new Map<string, TInput>();
  const entries: PackReadingOrderEntry[] = [];
  for (const container of containers) {
    byId.set(container.id, container);
    entries.push({ id: container.id, position: container.box.position });
  }
  const readingOrder: TInput[] = [];
  for (const entry of orderByReadingPosition(entries)) {
    const container = byId.get(entry.id);
    if (container !== undefined) readingOrder.push(container);
  }
  if (explicitOrder.length === 0) return readingOrder;

  const rankById = new Map<string, number>();
  for (const id of explicitOrder) {
    if (rankById.has(id)) continue;
    rankById.set(id, rankById.size);
  }
  if (rankById.size === 0) return readingOrder;

  const specified: TInput[] = [];
  const rest: TInput[] = [];
  for (const container of readingOrder) {
    if (rankById.has(container.id)) specified.push(container);
    else rest.push(container);
  }
  specified.sort(
    (left, right) => (rankById.get(left.id) ?? 0) - (rankById.get(right.id) ?? 0),
  );
  return [...specified, ...rest];
};
