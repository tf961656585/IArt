import type {
  ClipboardPayload,
  GraphNode,
  NodeGraph,
  NodePosition,
} from '../types';
import { nodeRegistry } from '../nodes/registry';
import { resolveEffectiveSize, DEFAULT_NODE_SIZE } from '../utils/effectiveSize';

/**
 * 内部复制候选判定（spec docs/editor/节点内容复制到系统剪贴板.md「内部复制候选表」）。
 *
 * 任务节点与 Agent 节点都是运行域/会话域对象的唯一 Editor 投影，不是可克隆的内容容器：
 * 定义里已声明 `copyable=false`，这里按注册表声明统一过滤——任务节点不得经粘贴产生第二个
 * 任务投影，Agent 节点不得复制 `agentSessionId`（节点 ↔ 会话 1:1）。
 * 未注册类型（含已退役的 model 节点）不在此处裁决，保持既有行为，由打开阶段归一化处理。
 */
export const isCopyableNodeForClipboard = (node: GraphNode): boolean => {
  const definition = nodeRegistry.get(node.type);
  if (definition === null || definition === undefined) return true;
  return definition.copyable !== false;
};

export const computeClipboardCenterPosition = (nodes: GraphNode[]): NodePosition => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of nodes) {
    // 剪贴板场景：节点已 structuredClone 脱离 ReactFlow 实例，measured 无意义。
    // 传全空 sources，由 resolveEffectiveSize 回退到注册表 default → DEFAULT_NODE_SIZE。
    const size = resolveEffectiveSize(node, {
      measuredByNodeId: undefined,
      desiredByNodeId: undefined,
      derivedByNodeId: undefined,
      defaultByNodeId: { [node.id]: DEFAULT_NODE_SIZE },
      layoutModelByNodeId: undefined,
    });
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + size.width);
    maxY = Math.max(maxY, node.position.y + size.height);
  }

  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
  };
};

export const buildClipboardPayloadFromSelection = (params: {
  nodeGraph: NodeGraph;
  selectedNodeIds: readonly string[];
}): ClipboardPayload | null => {
  const { nodeGraph, selectedNodeIds } = params;
  if (selectedNodeIds.length === 0) return null;

  const nodeIdSet = new Set(selectedNodeIds);
  // 合法候选过滤：任务/Agent 节点等不可复制对象不进 payload（多选时一并选中也要排除）。
  const selectedNodes = nodeGraph.nodes.filter(
    (n) => nodeIdSet.has(n.id) && isCopyableNodeForClipboard(n),
  );
  if (selectedNodes.length === 0) return null;

  const clonedNodes = selectedNodes.map((node) => structuredClone(node));

  const centerPosition = computeClipboardCenterPosition(clonedNodes);

  const payload: ClipboardPayload = {
    copiedAt: Date.now(),
    sourceNodeGraphId: nodeGraph.id,
    nodes: clonedNodes,
    centerPosition,
  };

  return payload;
};
