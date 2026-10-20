/**
 * 容器级防重叠（长大容器整体让位）——纯函数，无 store 依赖。
 *
 * 语义（spec：docs/runtime/画布节点组.md「空间边界与移动」、docs/runtime/画布自动布局算法.md）：
 * - 容器（组 | Agent 容器）的矩形由 buildGroupDerivedSize 派生（展开态 = 成员包围盒 + padding
 *   + 标题高度；折叠态 = 折叠卡片；空组 = 存储 position + 最小可见尺寸），position 是派生量、
 *   不独立可写；
 * - 只做「容器 × 容器」相交判定：组框内允许存在自由节点（自由节点不触发容器让位），
 *   仅当两个最外层容器的派生矩形相交时，才把其中一个容器整块当作一个搜索单元让位；
 * - 让位是整体平移：delta 同时施加到容器存储 position 与全部后代（含嵌套 Agent 容器及其成员），
 *   容器内相对布局保持不变；
 * - 搜索复用 taskNodePlacement.searchFreeBlockPosition（cells 单块、anchor = 派生 position、
 *   target = null 无界、step = snapGrid 或 20 兜底），占用集合复用 nodeOccupancy 的派生占位；
 *   搜索失败（无界超限抛内部断言）只记录 error 并跳过该容器，不阻断调用方。
 *
 * 候选归并：传入的容器 id 若是组内 Agent 容器，则归并到最外层宿主组（容器嵌套至多两层：
 * 组 > Agent 容器 > 叶，组不得入组）；独立 Agent 容器保持自身。多容器按首次出现序去重后
 * 依次处理，前一个容器的位移写入合成节点集合，供后一个容器继续消解，保证连续消解不重叠。
 */

import type { GraphNode, NodePosition } from '../types';
import type { EffectiveSizeSources } from '../utils/effectiveSize';
import { resolveEffectiveSize } from '../utils/effectiveSize';
import { isContainerNode } from '../services/groupMembership';
import { buildGroupDerivedSize, type GroupDerivedEntry } from '../components/canvas/groupDerivedSize';
import { rectsIntersect, searchFreeBlockPosition } from '../utils/taskNodePlacement';
import { buildNodeOccupancyRects } from '../utils/nodeOccupancy';

/** 容器整体让位结果（一个最外层容器一条）。 */
export type ContainerOverlapRelocation = {
  /** 最外层容器 id（组；独立 Agent 容器；若传入的是组内 Agent 容器，归并到宿主组） */
  containerId: string;
  /** 整组统一位移 */
  delta: NodePosition;
  /** 需要同 delta 位移的全部后代节点 id（不含容器自身；含嵌套 Agent 容器及其成员） */
  memberIds: ReadonlyArray<string>;
  /** 容器节点自身存储 position 的目标值（= 当前存储 position + delta） */
  containerTargetPosition: NodePosition;
};

export type ResolveContainerOverlapsParams = {
  /** 全图节点（合成快照：调用方可将已确定的移动先套用到 position 上再传入） */
  nodes: ReadonlyArray<GraphNode>;
  /** 容器/成员尺寸来源（经 resolveEffectiveSize 统一解析） */
  sizeSources: EffectiveSizeSources;
  /** 画板 snapGrid；非法维度的正有限值校验在内部完成（兜底 20） */
  snapGrid: ReadonlyArray<number> | undefined;
  /** 需要检查的容器 id；内部归并到最外层容器并按首次出现序去重 */
  containerIds: ReadonlyArray<string>;
};

/** 无 snapGrid（或取值非法）时的搜索步距兜底。 */
const DEFAULT_OVERLAP_STEP = 20;

const readPositiveStep = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_OVERLAP_STEP;

const resolveSearchSteps = (
  snapGrid: ReadonlyArray<number> | undefined,
): { stepX: number; stepY: number } => ({
  stepX: readPositiveStep(snapGrid !== undefined ? snapGrid[0] : undefined),
  stepY: readPositiveStep(snapGrid !== undefined ? snapGrid[1] : undefined),
});

const asEntryRect = (entry: GroupDerivedEntry): {
  x: number;
  y: number;
  width: number;
  height: number;
} => ({
  x: entry.position.x,
  y: entry.position.y,
  width: entry.size.width,
  height: entry.size.height,
});

/** 候选容器向上归并到最外层容器（组不得入组、容器嵌套至多两层；环路防御）。 */
const resolveOutermostContainerId = (
  nodeById: ReadonlyMap<string, GraphNode>,
  startId: string,
): string | undefined => {
  const start = nodeById.get(startId);
  if (!start || !isContainerNode(start)) return undefined;
  let current = start;
  const visited = new Set<string>([start.id]);
  while (typeof current.groupId === 'string' && current.groupId.length > 0) {
    const parent = nodeById.get(current.groupId);
    // 悬空 / 非容器宿主：按独立容器处理
    if (!parent || !isContainerNode(parent)) break;
    if (visited.has(parent.id)) break;
    visited.add(parent.id);
    current = parent;
  }
  return current.id;
};

/** 最外层容器（无宿主容器的组 / 独立 Agent 容器），按 nodes 数组序。 */
const collectOutermostContainerIds = (nodes: ReadonlyArray<GraphNode>): string[] => {
  const nodeById = new Map<string, GraphNode>();
  for (const node of nodes) nodeById.set(node.id, node);
  const ids: string[] = [];
  for (const node of nodes) {
    if (!isContainerNode(node)) continue;
    if (resolveOutermostContainerId(nodeById, node.id) !== node.id) continue;
    ids.push(node.id);
  }
  return ids;
};

/**
 * 容器全部后代 id（容器自身除外）：直接成员 + 成员中嵌套 Agent 容器的成员（至多两层）。
 *
 * 结果按 nodes 数组序输出（确定性，不依赖 Map 遍历序）。成员关系只按 `groupId` 显式指针
 * 扩展，不自动收编边界内非成员。
 */
const collectDescendantIds = (
  nodes: ReadonlyArray<GraphNode>,
  containerId: string,
): string[] => {
  const descendantIds = new Set<string>();
  const containerIds = new Set<string>([containerId]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const node of nodes) {
      if (node.type === 'group') continue; // 组不得成为成员
      if (typeof node.groupId !== 'string' || node.groupId.length === 0) continue;
      if (!containerIds.has(node.groupId)) continue;
      if (descendantIds.has(node.id)) continue;
      descendantIds.add(node.id);
      if (isContainerNode(node)) {
        containerIds.add(node.id);
        expanded = true;
      }
    }
  }
  const ordered: string[] = [];
  for (const node of nodes) {
    if (descendantIds.has(node.id)) ordered.push(node.id);
  }
  return ordered;
};

/** 该容器派生矩形是否与任一其他最外层容器的派生矩形相交。 */
const intersectsOtherContainer = (
  containerId: string,
  entry: GroupDerivedEntry,
  rectById: ReadonlyMap<string, GroupDerivedEntry>,
): boolean => {
  const rect = asEntryRect(entry);
  for (const [otherId, other] of rectById) {
    if (otherId === containerId) continue;
    if (rectsIntersect(rect, asEntryRect(other))) return true;
  }
  return false;
};

const shiftPosition = (position: NodePosition, delta: NodePosition): NodePosition => ({
  x: position.x + delta.x,
  y: position.y + delta.y,
});

/**
 * 最外层容器占位矩形表：派生 entry 优先；无成员 Agent 容器（单节点形态）没有 derived entry，
 * 回落 resolveEffectiveSize + 存储 position 的静态尺寸（与 nodeOccupancy 的容器兜底同口径）。
 */
const buildOutermostRectMap = (
  nodes: ReadonlyArray<GraphNode>,
  sizeSources: EffectiveSizeSources,
  outermostIds: ReadonlyArray<string>,
  projection: ReturnType<typeof buildGroupDerivedSize>,
): Map<string, GroupDerivedEntry> => {
  const nodeById = new Map<string, GraphNode>();
  for (const node of nodes) nodeById.set(node.id, node);
  const rectById = new Map<string, GroupDerivedEntry>();
  for (const id of outermostIds) {
    const entry = projection.byGroupId[id];
    if (entry !== undefined) {
      rectById.set(id, entry);
      continue;
    }
    const node = nodeById.get(id);
    if (node === undefined) continue;
    rectById.set(id, {
      position: node.position,
      size: resolveEffectiveSize(node, sizeSources),
    });
  }
  return rectById;
};

/**
 * 消解容器级重叠：对每个候选最外层容器，若其派生矩形与其他最外层容器相交，则整块让位。
 *
 * 纯函数；相同输入必然产出相同结果（候选按首现序、成员按 nodes 数组序、搜索确定性）。
 */
export const resolveContainerOverlaps = (
  params: ResolveContainerOverlapsParams,
): ContainerOverlapRelocation[] => {
  const { nodes, sizeSources, snapGrid, containerIds } = params;
  if (containerIds.length === 0 || nodes.length === 0) return [];

  const nodeById = new Map<string, GraphNode>();
  for (const node of nodes) nodeById.set(node.id, node);
  const outermostIds = collectOutermostContainerIds(nodes);
  const { stepX, stepY } = resolveSearchSteps(snapGrid);

  // 候选去重：归并到最外层容器，按首次出现序
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const id of containerIds) {
    const outermostId = resolveOutermostContainerId(nodeById, id);
    if (outermostId === undefined) {
      console.debug('[containerOverlap] candidate is not a container, skipped', { containerId: id });
      continue;
    }
    if (seen.has(outermostId)) continue;
    seen.add(outermostId);
    candidates.push(outermostId);
  }
  if (candidates.length === 0) return [];

  let syntheticNodes: GraphNode[] = [...nodes];
  let projection = buildGroupDerivedSize({ nodes: syntheticNodes, sizeSources });
  let rectById = buildOutermostRectMap(syntheticNodes, sizeSources, outermostIds, projection);
  const relocations: ContainerOverlapRelocation[] = [];

  for (const containerId of candidates) {
    const container = syntheticNodes.find((node) => node.id === containerId);
    if (!container) continue;
    const entry = rectById.get(containerId);
    if (!entry) {
      console.debug('[containerOverlap] container rect missing, skipped', { containerId });
      continue;
    }
    if (!intersectsOtherContainer(containerId, entry, rectById)) {
      continue;
    }

    const memberIds = collectDescendantIds(syntheticNodes, containerId);
    const excludeNodeIds = new Set<string>([containerId, ...memberIds]);
    const occupancy = buildNodeOccupancyRects(syntheticNodes, sizeSources, { excludeNodeIds });

    let found: NodePosition | null = null;
    try {
      found = searchFreeBlockPosition({
        occupancy,
        anchor: entry.position,
        cells: [{ dx: 0, dy: 0, width: entry.size.width, height: entry.size.height }],
        stepX,
        stepY,
        target: null,
      });
    } catch (error) {
      console.error('[containerOverlap] container relocation search failed, container left in place', {
        containerId,
        error,
      });
      continue;
    }
    if (found === null) continue;

    const delta: NodePosition = {
      x: found.x - entry.position.x,
      y: found.y - entry.position.y,
    };
    if (delta.x === 0 && delta.y === 0) continue;

    const shiftedIds = new Set<string>([containerId, ...memberIds]);
    syntheticNodes = syntheticNodes.map((node) =>
      shiftedIds.has(node.id) ? { ...node, position: shiftPosition(node.position, delta) } : node,
    );
    // 让后续候选看到前一容器让位后的最终几何（派生矩形随成员/存储 position 更新）
    projection = buildGroupDerivedSize({ nodes: syntheticNodes, sizeSources });
    rectById = buildOutermostRectMap(syntheticNodes, sizeSources, outermostIds, projection);

    relocations.push({
      containerId,
      delta,
      memberIds,
      containerTargetPosition: shiftPosition(container.position, delta),
    });
  }

  return relocations;
};
