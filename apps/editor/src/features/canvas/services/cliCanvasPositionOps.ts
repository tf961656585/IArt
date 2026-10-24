/**
 * CLI 画布写命令共享的位置快照与逆操作辅助（纯函数，无 IO）。
 *
 * 从 `cliCanvasWriteCommands.ts` 抽出（行数预算 + 按操作撤销的单一口径）：
 * - 位置写原语与 `canvas.layout --scope containers --pack` 都按「写前快照 × 写后快照 diff」
 *   生成逆操作，两处必须用同一份 diff 口径，否则撤销粒度会分裂成两套；
 * - 本文件只做 Map 快照 / 值比较 / diff 与逆位移构造，不读写 store、不登记操作。
 */

import { buildGroupDerivedSize } from '../components/canvas/groupDerivedSize';
import type { NodeGraph, NodePosition } from '../types';
import type { EffectiveSizeSources } from '../utils/effectiveSize';
import { isContainerNode } from './groupMembership';

export type PositionMap = Map<string, NodePosition>;

/** 全图位置快照（node_id → { x, y }；空图返回空 Map）。 */
export const snapshotPositions = (nodeGraph: NodeGraph | null): PositionMap => {
  const map: PositionMap = new Map();
  if (nodeGraph === null) return map;
  for (const node of nodeGraph.nodes) {
    map.set(node.id, { x: node.position.x, y: node.position.y });
  }
  return map;
};

export const isSamePosition = (
  left: NodePosition | undefined,
  right: NodePosition | undefined,
): boolean => {
  if (left === undefined || right === undefined) return left === right;
  return left.x === right.x && left.y === right.y;
};

/** 前后快照的实际位移集合（保序：按 after 的节点序）。 */
export const collectMovedIds = (before: PositionMap, after: PositionMap): string[] => {
  const moved: string[] = [];
  for (const [nodeId, position] of after) {
    if (!isSamePosition(before.get(nodeId), position)) moved.push(nodeId);
  }
  return moved;
};

/**
 * 按「写前快照 × 写后快照」构造逆位移（只含位置发生变化的节点）。
 * 调用方在写 action 完成后调用，再把结果登记为一次按操作撤销。
 */
export const buildInversePositions = (before: PositionMap, after: PositionMap): PositionUpdateList =>
  collectMovedIds(before, after).flatMap((nodeId) => {
    const position = before.get(nodeId);
    return position === undefined ? [] : [{ id: nodeId, position }];
  });

export type PositionUpdateList = Array<{ id: string; position: NodePosition }>;

/** 读取指定节点集合的当前位置（缺失节点不出现在结果里，不伪造）。 */
export const readPositionsOf = (
  nodeGraph: NodeGraph | null,
  nodeIds: Iterable<string>,
): Record<string, NodePosition> => {
  const positions: Record<string, NodePosition> = {};
  if (nodeGraph === null) return positions;
  const nodeById = new Map(nodeGraph.nodes.map((node) => [node.id, node] as const));
  for (const nodeId of nodeIds) {
    const node = nodeById.get(nodeId);
    if (node !== undefined) positions[nodeId] = { x: node.position.x, y: node.position.y };
  }
  return positions;
};

/**
 * 读取指定节点集合的**渲染口径**坐标（CLI-061）：
 * - 容器节点 → 派生渲染框左上角（`buildGroupDerivedSize`，与画布投影同一 owner）；
 * - 空容器 / 折叠容器无派生 entry → 回落存储 position（不伪造）；
 * - 叶子节点 → 存储 position。
 *
 * 所有 CLI 写命令响应与 pack 计划中的容器坐标统一走本函数，禁止各处再按
 * `node.position + delta` 自行推算存储值当作展示坐标。
 */
export const readRenderPositionsOf = (params: {
  nodeGraph: NodeGraph | null;
  sizeSources: EffectiveSizeSources;
  nodeIds: Iterable<string>;
}): Record<string, NodePosition> => {
  const { nodeGraph, sizeSources } = params;
  const positions: Record<string, NodePosition> = {};
  if (nodeGraph === null) return positions;

  const nodeById = new Map(nodeGraph.nodes.map((node) => [node.id, node] as const));
  let projection: ReturnType<typeof buildGroupDerivedSize> | undefined;
  for (const nodeId of new Set(params.nodeIds)) {
    const node = nodeById.get(nodeId);
    if (node === undefined) continue;
    if (!isContainerNode(node)) {
      positions[nodeId] = { x: node.position.x, y: node.position.y };
      continue;
    }
    projection ??= buildGroupDerivedSize({ nodes: nodeGraph.nodes, sizeSources });
    const entry = projection.byGroupId[nodeId];
    if (entry === undefined) {
      console.debug('[cliCanvasPositionOps] container has no derived frame, fallback to stored position', {
        nodeId,
        type: node.type,
      });
      positions[nodeId] = { x: node.position.x, y: node.position.y };
      continue;
    }
    positions[nodeId] = { x: entry.position.x, y: entry.position.y };
  }
  return positions;
};

/**
 * 把计划位置套到图上，得到「若写入完成」的只读合成图（纯函数，不改输入节点）。
 * dry-run 的渲染口径坐标必须基于合成图派生，不得读写入后状态（dry-run 根本没有）。
 */
export const withPlannedPositions = (
  nodeGraph: NodeGraph,
  planned: PositionMap,
): NodeGraph => ({
  ...nodeGraph,
  nodes: nodeGraph.nodes.map((node) => {
    const position = planned.get(node.id);
    return position === undefined ? node : { ...node, position: { ...position } };
  }),
});
