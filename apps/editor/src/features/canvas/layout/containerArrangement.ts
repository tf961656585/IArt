/**
 * 容器内整理的共享计算（纯函数，无 store 依赖）。
 *
 * 两个消费方共用同一实现，禁止各自复制锚点补偿逻辑：
 * - 画布「容器内整理」动作（canvasStore.groupActions.autoLayoutContainer）；
 * - 批次收口整块重排的同容器桶（promptdock/projection/batchCompletion.ts）。
 *
 * 语义（spec：docs/runtime/画布自动布局算法.md「网格摆放」、docs/runtime/画布节点组.md
 * 「自动布局协作」）：对成员集合执行布局引擎排布（列数/间距由调用方给出），并把算法输出
 * 平移补偿到「整理前成员包围盒左上角吸附到最近网格点」后的锚点。本文件只负责锚点补偿；
 * 整理后容器与相邻容器相交时的整组让位由调用方经 layout/containerOverlap 追加
 *（锚点保持让位于容器间不重叠）。
 */

import type { GraphNode, NodePosition } from '../types';
import type { EffectiveSizeSources } from '../utils/effectiveSize';
import { computeAutoLayout } from './autoLayout';
import type { LayoutOrderMode } from './autoLayoutTypes';
import { logCanvasDebugEvent } from '../debug/canvasDebug';
import { alignToGrid } from './layoutPrimitives';
import { orderByReadingPosition } from './readingOrder';

export type ContainerArrangementParams = {
  /** 参与整理的成员集合（布局输入序决定占格顺序；不应含组节点） */
  members: ReadonlyArray<GraphNode>;
  /** 成员尺寸来源（经 resolveEffectiveSize 统一解析） */
  sizeSources: EffectiveSizeSources;
  /** 网格列数；缺省单列垂直摆放 */
  columns: number | undefined;
  /** 对齐网格（画板 snapGrid）；非法/缺失时不吸附（锚点精确保持） */
  snapGrid: [number, number] | undefined;
  /** 本次格子间距（缺省 `NODE_GAP`） */
  gap?: number | undefined;
};

/**
 * 节点集合位置包围盒左上角（锚点计算共享几何源）。
 *
 * 共享消费者：容器内整理（本文件）与全局整理锚点补偿（canvasStore.layoutActions），
 * 两者必须用同一包围盒口径计算锚点，禁止各自复制实现。
 */
export const bboxTopLeft = (nodes: ReadonlyArray<GraphNode>): NodePosition => {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    if (node.position.x < minX) minX = node.position.x;
    if (node.position.y < minY) minY = node.position.y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return { x: 0, y: 0 };
  return { x: minX, y: minY };
};

/**
 * 锚点吸附：把整块包围盒左上角移动到最近网格点（spec AL-GC-006 / AL-GC-002）。
 *
 * `snapGrid` 非法或缺失时**精确保持**原位，不做任何取整。网格吸附只作用于锚点，
 * 块内相对位置与间距不受影响。
 */
export const snapAnchorToGrid = (
  anchor: NodePosition,
  snapGrid: [number, number] | undefined,
): NodePosition => {
  if (snapGrid === undefined) return anchor;
  const [gridX, gridY] = snapGrid;
  const validX = Number.isFinite(gridX) && gridX > 0;
  const validY = Number.isFinite(gridY) && gridY > 0;
  if (!validX && !validY) return anchor;
  return {
    x: validX ? alignToGrid(anchor.x, gridX) : anchor.x,
    y: validY ? alignToGrid(anchor.y, gridY) : anchor.y,
  };
};

/**
 * 本次整理的占格基准序（调用层排序口径的唯一实现）。
 *
 * - `position`（缺省）：视觉阅读序（`orderByReadingPosition`，共享纯函数）
 * - `insertion` / `created`：调用层传入的数组序。`created` 由主进程解析为显式 order 后
 *   传入，画布侧收到时落 debug 日志并按 `insertion` 处理（spec：画布自动布局算法.md
 *   「排序口径」）。
 *
 * 本函数不做显式 `order` 重排——那一步由调用方在基准序之上用 `applyLayoutInputOrder`
 * 落实（显式 order 优先于排序口径）。
 */
export const orderNodesForLayoutMode = <
  TNode extends { readonly id: string; readonly position: NodePosition },
>(
  nodes: readonly TNode[],
  orderMode: LayoutOrderMode | undefined,
): TNode[] => {
  if (orderMode === 'insertion') return [...nodes];
  if (orderMode === 'created') {
    logCanvasDebugEvent('auto-layout:order-mode-created-fallback', {
      traceScope: 'autoLayout',
      phase: 'order-mode',
      summary: 'created order mode received on canvas side; falling back to insertion order',
      nodeIds: nodes.map((node) => node.id),
    });
    return [...nodes];
  }
  return orderByReadingPosition(nodes);
};

/**
 * 计算容器成员整理后的目标位置（锚点吸附后）。
 * 返回 null = 布局引擎未产出任何位置（空成员或成员几何非法），调用方按无操作处理。
 */
export const computeContainerArrangedPositions = async (
  params: ContainerArrangementParams,
): Promise<Record<string, NodePosition> | null> => {
  const { members, sizeSources, columns, snapGrid, gap } = params;
  if (members.length === 0) return null;

  const targetAnchor = snapAnchorToGrid(bboxTopLeft(members), snapGrid);

  const layoutResult = await computeAutoLayout([...members], {
    defaultNodeSize: undefined,
    sizeSources,
    columns,
    nodeGap: gap,
  });
  if (Object.keys(layoutResult.positions).length === 0) return null;

  // 锚点吸附：算出算法输出后的包围盒左上角，补偿平移使整理后锚点 = 吸附后的锚点
  const afterAnchor = bboxTopLeft(
    members.map((member) => {
      const nextPosition = layoutResult.positions[member.id];
      return nextPosition ? { ...member, position: nextPosition } : member;
    }),
  );
  const dx = targetAnchor.x - afterAnchor.x;
  const dy = targetAnchor.y - afterAnchor.y;
  const positions: Record<string, NodePosition> = {};
  for (const [id, position] of Object.entries(layoutResult.positions)) {
    positions[id] = { x: position.x + dx, y: position.y + dy };
  }
  return positions;
};
