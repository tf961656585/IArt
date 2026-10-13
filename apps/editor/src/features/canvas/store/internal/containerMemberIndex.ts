/**
 * 容器成员计数增量索引（spec：docs/runtime/画布节点组.md「性能约束」、
 * docs/agent/02-Agent节点与画布投影.md「产物计数徽章」）。
 *
 * 口径（AG-CN-014 / AG-CT-007）：
 * - 容器成员计数等派生量由**变更驱动**的索引提供；禁止容器实例（GroupNode / AgentNode）
 *   各自订阅全图节点切片、各自扫描全图计算计数。
 * - 索引在 store 侧按 (graphId, structureRevision, nodesRef) 变更驱动重建：成员关系写入
 *   （建立/迁移/解除/解散/粘贴/undo/redo/加载）都会替换 nodes 数组或推进修订号，
 *   触发一次全图单遍重建；未变更时命中缓存零成本。
 * - 重建产出先与上一份做内容等值比较：内容一致时返回同一引用（selector 等值比较），
 *   订阅整份索引的消费者不会因无关变更重渲染；按 id 取数的选择器返回原始 number，
 *   由 Zustand 默认 Object.is 等值比较天然生效。
 *
 * 消费方式：
 * - 单容器计数：`useCanvasStore((s) => selectContainerMemberCount(s, containerId))` → number
 * - 整份索引：`useCanvasStore(selectContainerMemberCountIndex)` → ReadonlyMap（引用稳定）
 */

import type { GraphNode, NodeGraph } from '../../types';

export type ContainerMemberCountIndex = ReadonlyMap<string, number>;

type MemberCountIndexState = {
  nodeGraph: NodeGraph | null;
  structureRevision: number;
};

type MemberCountIndexCache = {
  graphId: string | null;
  structureRevision: number;
  nodesRef: ReadonlyArray<GraphNode> | null;
  index: ContainerMemberCountIndex;
};

const cache: MemberCountIndexCache = {
  graphId: null,
  structureRevision: -1,
  nodesRef: null,
  index: new Map(),
};

/** 单遍扫描全图构建容器 id → 显式成员数（组节点不得持有 groupId，按资格矩阵排除）。 */
const buildContainerMemberCountIndex = (
  nodes: ReadonlyArray<GraphNode>,
): ContainerMemberCountIndex => {
  const index = new Map<string, number>();
  for (const node of nodes) {
    if (node.type === 'group') continue; // 组不得成为成员
    if (typeof node.groupId !== 'string' || node.groupId.length === 0) continue;
    index.set(node.groupId, (index.get(node.groupId) ?? 0) + 1);
  }
  return index;
};

const isIndexContentEqual = (
  a: ContainerMemberCountIndex,
  b: ContainerMemberCountIndex,
): boolean => {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
};

/**
 * 选择器：容器成员计数索引（containerId → 显式成员数）。
 *
 * 变更驱动 + 引用稳定：同一 (graphId, structureRevision, nodesRef) 下恒返回同一引用；
 * 成员关系内容未变时跨变更也返回同一引用（内容等值比较）。
 */
export const selectContainerMemberCountIndex = (
  state: MemberCountIndexState,
): ContainerMemberCountIndex => {
  const graph = state.nodeGraph;
  const nodes = graph !== null && graph !== undefined ? graph.nodes : null;
  if (!graph || !nodes) {
    if (cache.graphId !== null) {
      cache.graphId = null;
      cache.structureRevision = -1;
      cache.nodesRef = null;
      cache.index = new Map();
    }
    return cache.index;
  }

  if (
    cache.graphId === graph.id &&
    cache.structureRevision === state.structureRevision &&
    cache.nodesRef === nodes
  ) {
    return cache.index;
  }

  const next = buildContainerMemberCountIndex(nodes);
  const stable = isIndexContentEqual(cache.index, next) ? cache.index : next;

  cache.graphId = graph.id;
  cache.structureRevision = state.structureRevision;
  cache.nodesRef = nodes;
  cache.index = stable;
  return stable;
};

/**
 * 选择器：单个容器的成员数。容器不存在或无成员返回 0。
 * 返回原始 number，消费端按默认 Object.is 等值比较生效。
 */
export const selectContainerMemberCount = (
  state: MemberCountIndexState,
  containerId: string,
): number => selectContainerMemberCountIndex(state).get(containerId) ?? 0;
