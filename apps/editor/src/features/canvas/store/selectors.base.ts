import type {
  GraphNode,
  GraphNodeData,
  GraphNodeType,
  NodePosition,
} from "../types";
import type { useCanvasStore } from "./canvasStore";

export type NodeSnapshot<T extends GraphNodeData = GraphNodeData> = {
  nodeGraphId: string;
  node: GraphNode<T> | null;
  data: T;
};

export type CanvasLayoutSnapshotNode = {
  id: string;
  type: GraphNodeType;
  position: NodePosition;
  draggable: boolean;
};

export type LayoutSnapshotSignatureContributor = (node: GraphNode) => string;

type LayoutSnapshotCacheEntry = {
  sig: string;
  node: CanvasLayoutSnapshotNode;
};

type LayoutSnapshotCache = {
  graphId: string | null;
  order: string[];
  nodes: CanvasLayoutSnapshotNode[];
  byId: Map<string, LayoutSnapshotCacheEntry>;
};

type GraphNodeByIdCache = {
  graphId: string | null;
  structureRevision: number;
  nodesRef: ReadonlyArray<GraphNode> | null;
  value: Map<string, GraphNode>;
};

const layoutSignatureContributorByType = new Map<
  GraphNodeType,
  LayoutSnapshotSignatureContributor
>();

const layoutSnapshotCache: LayoutSnapshotCache = {
  graphId: null,
  order: [],
  nodes: [],
  byId: new Map(),
};

const graphNodeByIdCache: GraphNodeByIdCache = {
  graphId: null,
  structureRevision: -1,
  nodesRef: null,
  value: new Map(),
};

export const registerLayoutSnapshotSignatureContributor = (
  type: GraphNodeType,
  contributor: LayoutSnapshotSignatureContributor,
): void => {
  layoutSignatureContributorByType.set(type, contributor);
};

export const selectGraphNodeByIdMap = (
  state: ReturnType<typeof useCanvasStore.getState>,
): Map<string, GraphNode> => {
  const graph = state.nodeGraph;
  const nodes = (graph !== null && graph !== undefined ? graph.nodes : undefined) ?? null;
  if (!graph || !nodes) {
    if (graphNodeByIdCache.graphId !== null) {
      graphNodeByIdCache.graphId = null;
      graphNodeByIdCache.structureRevision = -1;
      graphNodeByIdCache.nodesRef = null;
      graphNodeByIdCache.value = new Map();
    }
    return graphNodeByIdCache.value;
  }

  if (
    graphNodeByIdCache.graphId === graph.id &&
    graphNodeByIdCache.structureRevision === state.structureRevision &&
    graphNodeByIdCache.nodesRef === nodes
  ) {
    return graphNodeByIdCache.value;
  }

  const next = new Map<string, GraphNode>();
  for (const node of nodes) {
    next.set(node.id, node);
  }
  graphNodeByIdCache.graphId = graph.id;
  graphNodeByIdCache.structureRevision = state.structureRevision;
  graphNodeByIdCache.nodesRef = nodes;
  graphNodeByIdCache.value = next;
  return graphNodeByIdCache.value;
};

export const selectGraphNodeById =
  <T extends GraphNodeData = GraphNodeData>(nodeId: string) =>
  (state: ReturnType<typeof useCanvasStore.getState>): GraphNode<T> | null => {
    if (!nodeId) return null;
    return (selectGraphNodeByIdMap(state).get(nodeId) as GraphNode<T> | undefined) ?? null;
  };

/**
 * 判断指定节点当前是否处于占位壳形态（spec：画布交互期渲染降级契约.md「占位壳契约」）。
 *
 * 返回 selector 工厂（与 selectStoreRenderFallbackSizeForNode 同模式），供节点组件用
 * `useCanvasStore(selectIsPlaceholderNode(nodeId))` 单节点作用域订阅，不订阅整个 Set，
 * 避免其他节点占位态变化触发本节点重渲染。
 */
export const selectIsPlaceholderNode =
  (nodeId: string) =>
  (state: ReturnType<typeof useCanvasStore.getState>): boolean => {
    if (!nodeId) return false;
    return state.ui.placeholderNodeIds.has(nodeId);
  };

export const selectNodeSnapshot =
  <T extends GraphNodeData>(nodeId: string, fallback: GraphNode<T>) =>
  (state: ReturnType<typeof useCanvasStore.getState>): NodeSnapshot<T> => {
    const node = selectGraphNodeById<T>(nodeId)(state);

    return {
      nodeGraphId:
        (state.nodeGraph !== null && state.nodeGraph !== undefined
          ? state.nodeGraph.id
          : undefined) ?? "",
      node,
      data: ((node !== null && node !== undefined ? node.data : undefined) as T | undefined) ?? fallback.data,
    };
  };

export const selectLayoutSnapshotNodes = (
  state: ReturnType<typeof useCanvasStore.getState>,
): CanvasLayoutSnapshotNode[] => {
  const graph = state.nodeGraph;
  if (!graph) {
    if (layoutSnapshotCache.graphId !== null) {
      layoutSnapshotCache.graphId = null;
      layoutSnapshotCache.order = [];
      layoutSnapshotCache.nodes = [];
      layoutSnapshotCache.byId = new Map();
    }
    return layoutSnapshotCache.nodes;
  }

  if (layoutSnapshotCache.graphId !== graph.id) {
    layoutSnapshotCache.graphId = graph.id;
    layoutSnapshotCache.order = [];
    layoutSnapshotCache.nodes = [];
    layoutSnapshotCache.byId = new Map();
  }

  const prevOrder = layoutSnapshotCache.order;
  const prevNodes = layoutSnapshotCache.nodes;
  const prevById = layoutSnapshotCache.byId;

  const nextOrder: string[] = [];
  const nextNodes: CanvasLayoutSnapshotNode[] = [];
  const nextById = new Map<string, LayoutSnapshotCacheEntry>();

  let changed = false;
  for (let i = 0; i < graph.nodes.length; i += 1) {
    const node = graph.nodes[i];
    if (!node) continue;
    nextOrder.push(node.id);
    if (!changed && prevOrder[i] !== node.id) {
      changed = true;
    }

    const draggable = node.draggable ?? true;
    const position = node.position;
    const baseSig = `${node.type}|${position.x}|${position.y}|${draggable ? 1 : 0}`;
    const layoutSignatureContributor = layoutSignatureContributorByType.get(node.type);
    const extraSig =
      layoutSignatureContributor !== undefined
        ? layoutSignatureContributor(node)
        : undefined;
    const sig = extraSig ? `${baseSig}|${extraSig}` : baseSig;

    const prev = prevById.get(node.id);
    if (prev && prev.sig === sig) {
      nextNodes.push(prev.node);
      nextById.set(node.id, prev);
      continue;
    }

    changed = true;
    const snapshot: CanvasLayoutSnapshotNode = {
      id: node.id,
      type: node.type,
      position,
      draggable,
    };
    const entry: LayoutSnapshotCacheEntry = { sig, node: snapshot };
    nextNodes.push(snapshot);
    nextById.set(node.id, entry);
  }

  if (!changed && prevNodes.length === nextNodes.length) {
    return prevNodes;
  }

  layoutSnapshotCache.order = nextOrder;
  layoutSnapshotCache.nodes = nextNodes;
  layoutSnapshotCache.byId = nextById;
  return nextNodes;
};
