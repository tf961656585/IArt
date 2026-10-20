/**
 * 批次收口整块重排（spec：docs/runtime/固定任务数批次提交与投影语义.md「批次收口整块重排」）。
 *
 * 触发与幂等：
 * - 受理回执创建投影时登记批次台账（task_id + task_index，内存态，不落盘）；
 * - task:state-changed 终态通知（succeeded / failed / cancelled）逐个记账；某批次全部任务
 *   到达终态时执行一次整块重排，每批次至多一次（finalized 标志在触发判定时同步置位）；
 * - 只挂接实时终态通知链路，不做轮询；task:state-snapshot（恢复/补全）不触发——
 *   Editor 关闭期间收口的批次不补重排。
 *
 * 排布口径：
 * - 只重排该批已成功产物资产节点（按 task_index 升序、同任务内按产物序 = 投影创建序）；
 *   失败任务节点原地保留；整批无成功产物不重排；
 * - 归属分桶：产物归属同一容器（groupId 指向的现存展开容器）为同容器桶，按容器内整理
 *   语义排布（复用 layout/containerArrangement.ts 共享计算：容器内网格、组框随成员派生、
 *   无容器间冲突时锚点保持）；随后经 layout/containerOverlap 做容器级防重叠——增长容器与
 *   相邻顶层容器相交时整组让位，锚点保持让位于容器间不重叠；自由桶整块按网格排布并经
 *   防重叠搜索落位（避开全部既有占位，含让位后的容器派生包围盒），锚点为重排前整块包围盒左上角；
 * - 全部移动经单次 updateNodePositionsBatch 落库 = 单条原子历史记录，undo 一步整体还原。
 */

import type { GraphNode, NodePosition } from '@/features/canvas/types/node';
import type { AssetNodeData } from '@/features/canvas/types/node';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import {
  getGroupMembers,
  isContainerCollapsed,
  isContainerNode,
} from '@/features/canvas/services/groupMembership';
import { computeContainerArrangedPositions } from '@/features/canvas/layout/containerArrangement';
import { resolveContainerOverlaps } from '@/features/canvas/layout/containerOverlap';
import { normalizeNodeGraphSettings } from '@/features/canvas/types/nodeGraph';
import { resolveEffectiveSize } from '@/features/canvas/utils/effectiveSize';
import { ASSET_NODE_DEFAULT_SIZE } from '@/features/canvas/nodes/asset/assetNodeFactory';
import {
  buildCanvasSizeSources,
  buildNodeOccupancyRects,
} from '@/features/canvas/utils/nodeOccupancy';
import {
  computeGridCellsForSizes,
  searchFreeBlockPosition,
  TASK_BATCH_GAP_X,
  TASK_BATCH_GAP_Y,
} from '@/features/canvas/utils/taskNodePlacement';
import { logCanvasDebugEvent } from '@/features/canvas/debug/canvasDebug';

/** 收口重排网格每行个数（与提交受理期 / morph 网格同口径）。 */
const REARRANGE_PER_ROW = 3;

/** 台账内存上限：超限淘汰最早登记的批次（收口检测只服务在途批次，历史批次无需常驻）。 */
const MAX_TRACKED_BATCHES = 50;

type BatchLedgerEntry = {
  batchId: string;
  /** 按 task_index 升序的任务身份 */
  tasks: ReadonlyArray<{ taskId: string; taskIndex: number }>;
  terminalTaskIds: Set<string>;
  finalized: boolean;
};

const ledgerByBatchId = new Map<string, BatchLedgerEntry>();

/**
 * 受理回执 → 登记批次台账（投影创建的唯一触发点调用；幂等重放回执不会走到这里）。
 */
export const registerBatchAcceptance = (
  batchId: string,
  tasks: ReadonlyArray<{ taskId: string; taskIndex: number }>,
): void => {
  if (tasks.length === 0) return;
  if (ledgerByBatchId.has(batchId)) {
    console.debug('[batchCompletion] ledger already registered, skip re-register', { batchId });
    return;
  }
  const sorted = [...tasks].sort((a, b) => a.taskIndex - b.taskIndex);
  ledgerByBatchId.set(batchId, {
    batchId,
    tasks: sorted,
    terminalTaskIds: new Set(),
    finalized: false,
  });
  while (ledgerByBatchId.size > MAX_TRACKED_BATCHES) {
    const oldest = ledgerByBatchId.keys().next().value;
    if (oldest === undefined) break;
    ledgerByBatchId.delete(oldest);
  }
};

/**
 * 终态通知 → 记账；批次全部任务终态时触发一次收口重排（同步置位 finalized，异步执行重排）。
 * 非台账批次（agent 派生任务、扩图加工任务等）无条件跳过。
 */
export const noteBatchTaskTerminal = (params: {
  graphId: string;
  batchId: string | null | undefined;
  taskId: string;
}): void => {
  if (typeof params.batchId !== 'string' || params.batchId.length === 0) return;
  const ledger = ledgerByBatchId.get(params.batchId);
  if (!ledger) return;
  if (!ledger.tasks.some((task) => task.taskId === params.taskId)) return;
  ledger.terminalTaskIds.add(params.taskId);
  if (ledger.finalized) return;
  if (ledger.terminalTaskIds.size < ledger.tasks.length) return;
  // 触发判定同步置位：重复终态通知（快照补投等）不再二次收口
  ledger.finalized = true;
  void finalizeBatch(params.graphId, ledger);
};

/** 该批已成功产物节点，按 task_index 升序、同任务内按产物序（投影创建序 = nodes 数组序）。 */
const collectOrderedProducts = (
  graph: NonNullable<ReturnType<typeof useCanvasStore.getState>['nodeGraph']>,
  ledger: BatchLedgerEntry,
): GraphNode[] => {
  const assetsByTaskId = new Map<string, GraphNode[]>();
  for (const node of graph.nodes) {
    if (node.type !== 'asset') continue;
    const data = node.data as AssetNodeData;
    if (data.sourceBatchId !== ledger.batchId) continue;
    const taskId = data.sourceTaskId;
    if (typeof taskId !== 'string' || taskId.length === 0) continue;
    const list = assetsByTaskId.get(taskId);
    if (list) {
      list.push(node);
    } else {
      assetsByTaskId.set(taskId, [node]);
    }
  }
  const ordered: GraphNode[] = [];
  for (const task of ledger.tasks) {
    const list = assetsByTaskId.get(task.taskId);
    if (list) ordered.push(...list);
  }
  return ordered;
};

/** 自由桶网格：格子尺寸 = 各节点真实有效尺寸（列最大宽/行最大高，与 morph 网格同一共享实现）。 */
const buildFreeBucketCells = (
  freeNodes: ReadonlyArray<GraphNode>,
  sizeSources: Parameters<typeof resolveEffectiveSize>[1],
): { cells: ReturnType<typeof computeGridCellsForSizes>['cells'] } => {
  const sizes = freeNodes.map((node) => resolveEffectiveSize(node, sizeSources));
  return computeGridCellsForSizes(sizes, REARRANGE_PER_ROW, TASK_BATCH_GAP_X, TASK_BATCH_GAP_Y);
};

const finalizeBatch = async (graphId: string, ledger: BatchLedgerEntry): Promise<void> => {
  try {
    const state = useCanvasStore.getState();
    const graph = state.nodeGraph;
    if (!graph || graph.id !== graphId) {
      console.debug('[batchCompletion] graph not ready, skip rearrange', {
        batchId: ledger.batchId,
      });
      return;
    }

    const products = collectOrderedProducts(graph, ledger);
    if (products.length === 0) {
      console.debug('[batchCompletion] batch completed without products, skip rearrange', {
        batchId: ledger.batchId,
      });
      return;
    }

    const sizeSources = buildCanvasSizeSources(state);

    // 归属分桶：同容器桶（按容器 id 分桶）与自由桶；各自保持 task_index 升序
    const bucketByContainerId = new Map<string, GraphNode[]>();
    const freeNodes: GraphNode[] = [];
    for (const product of products) {
      const groupId =
        typeof product.groupId === 'string' && product.groupId.length > 0 ? product.groupId : null;
      if (groupId === null) {
        freeNodes.push(product);
        continue;
      }
      const list = bucketByContainerId.get(groupId);
      if (list) {
        list.push(product);
      } else {
        bucketByContainerId.set(groupId, [product]);
      }
    }

    const moves: Array<{ id: string; position: NodePosition }> = [];
    const movedPositionById = new Map<string, NodePosition>();
    // 实际发生重排的容器：折叠/缺失/空成员的桶跳过重排，也不作为让位候选（未增长不移动）。
    const grownContainerIds: string[] = [];
    // 同一 id 只保留一条最终 move：后写覆盖先写（容器让位会再次移动桶内成员）。
    const applyMove = (id: string, position: NodePosition): void => {
      const existingIndex = moves.findIndex((move) => move.id === id);
      if (existingIndex >= 0) moves.splice(existingIndex, 1);
      moves.push({ id, position });
      movedPositionById.set(id, position);
    };

    // 同容器桶先行：容器内整理语义（全体成员参与，容器锚点保持）；折叠容器不可整理，跳过
    for (const [containerId] of bucketByContainerId) {
      const container = graph.nodes.find((node) => node.id === containerId && isContainerNode(node));
      if (!container) {
        console.debug('[batchCompletion] container missing, bucket kept in place', { containerId });
        continue;
      }
      if (isContainerCollapsed(container)) {
        console.debug('[batchCompletion] container collapsed, rearrange skipped', { containerId });
        continue;
      }
      const members = getGroupMembers(graph, containerId);
      if (members.length === 0) continue;
      const positions = await computeContainerArrangedPositions({
        members,
        sizeSources,
        columns: REARRANGE_PER_ROW,
        snapGrid: normalizeNodeGraphSettings(graph.settings).snapGrid,
      });
      if (positions === null) continue;
      grownContainerIds.push(containerId);
      for (const [id, position] of Object.entries(positions)) {
        applyMove(id, position);
      }
    }

    // 容器级防重叠（容器桶收口后、自由桶之前）：整理让容器派生矩形长大，可能与相邻容器相交；
    // 相交时整组让位（只做容器 × 容器判定，自由节点只作为让位搜索的障碍参与避让）。
    // 让位结果写回 map，自由桶据此看到最终位置；全部位置仍只经末尾一次 updateNodePositionsBatch 落库。
    if (grownContainerIds.length > 0) {
      const syntheticForOverlap =
        movedPositionById.size > 0
          ? graph.nodes.map((node) => {
              const moved = movedPositionById.get(node.id);
              return moved ? { ...node, position: moved } : node;
            })
          : graph.nodes;
      const relocations = resolveContainerOverlaps({
        nodes: syntheticForOverlap,
        sizeSources,
        snapGrid: normalizeNodeGraphSettings(graph.settings).snapGrid,
        containerIds: grownContainerIds,
      });
      for (const relocation of relocations) {
        for (const id of relocation.memberIds) {
          const base =
            movedPositionById.get(id) ??
            graph.nodes.find((node) => node.id === id)?.position;
          if (base === undefined) continue;
          applyMove(id, {
            x: base.x + relocation.delta.x,
            y: base.y + relocation.delta.y,
          });
        }
        // 容器自身存储 position 目标值（供合成图与自由桶使用；updateNodePositionsBatch 按
        // 目标位置与存储 position 之差展开到未显式给出的成员）。
        applyMove(relocation.containerId, relocation.containerTargetPosition);
      }
    }

    // 自由桶：整块网格 + 防重叠搜索（障碍含容器桶成员落位后的合成占位，单份派生实现产出）
    if (freeNodes.length > 0) {
      const movedIds = new Set(movedPositionById.keys());
      const syntheticNodes =
        movedIds.size > 0
          ? graph.nodes.map((node) => {
              const moved = movedPositionById.get(node.id);
              return moved ? { ...node, position: moved } : node;
            })
          : graph.nodes;
      const occupancy = buildNodeOccupancyRects(syntheticNodes, sizeSources, {
        excludeNodeIds: new Set(freeNodes.map((node) => node.id)),
      });
      const { cells } = buildFreeBucketCells(freeNodes, sizeSources);
      // 锚点 = 重排前整块包围盒左上角（min x / min y 独立取值）
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      for (const node of freeNodes) {
        if (node.position.x < minX) minX = node.position.x;
        if (node.position.y < minY) minY = node.position.y;
      }
      const anchor: NodePosition = {
        x: Number.isFinite(minX) ? minX : 0,
        y: Number.isFinite(minY) ? minY : 0,
      };
      const found = searchFreeBlockPosition({
        occupancy,
        anchor,
        cells,
        stepX: ASSET_NODE_DEFAULT_SIZE.width + TASK_BATCH_GAP_X,
        stepY: ASSET_NODE_DEFAULT_SIZE.height + TASK_BATCH_GAP_Y,
        target: null,
      });
      if (found !== null) {
        const blockOrigin = { x: found.x, y: found.y };
        for (let index = 0; index < freeNodes.length; index += 1) {
          const node = freeNodes[index];
          const cell = cells[index];
          if (!node || !cell) continue;
          const position = { x: blockOrigin.x + cell.dx, y: blockOrigin.y + cell.dy };
          applyMove(node.id, position);
        }
      }
    }

    if (moves.length === 0) {
      console.debug('[batchCompletion] rearrange produced no position changes', {
        batchId: ledger.batchId,
      });
      return;
    }
    // 单次批量位置写入 = 单条原子历史记录（undo 一步整体还原）
    useCanvasStore.getState().updateNodePositionsBatch(moves);
    logCanvasDebugEvent('batchCompletion:rearranged', {
      batchId: ledger.batchId,
      movedCount: moves.length,
      containerBucketCount: bucketByContainerId.size,
      freeBucketCount: freeNodes.length,
    });
  } catch (error) {
    console.error('[batchCompletion] batch finalize rearrange failed', {
      batchId: ledger.batchId,
      error,
    });
  }
};
