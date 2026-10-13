import type { DynamicRecord } from "@/client/utils/typeGuards";
import { cast } from "@/lib/utils";
import type {
  GraphNode,
  GraphNodeData,
  NodeGraphMeta,
  NodeGraphViewport,
  NodePosition,
} from "../../types";
import { CURRENT_NODE_GRAPH_SCHEMA_VERSION } from "../../types";
import { generateNodeId } from "../../types/node";
import { nodeRegistry } from "../../nodes/registry";
import { createLegacyModelNodeRejection } from "./legacyModelNodeRejection";
export {
  sanitizeRuntimeLayoutData,
  type RuntimeLayoutNodeData,
} from "./loadEmbeddedLayoutState";

const DEFAULT_VIEWPORT: NodeGraphViewport = { x: 0, y: 0, zoom: 1 };
const DEFAULT_NODE_POSITION: NodePosition = { x: 0, y: 0 };

type CanvasDynamicObject = DynamicRecord;
export type LegacyGraphNodeRaw = GraphNode & { modelId: unknown | undefined };

type LegacyGraphNodeWithSelection = GraphNode & {
  selected: boolean | undefined;
  data: GraphNodeData & {
    selectedSlotIds: string[] | undefined;
  };
};

export const stripLegacySelectionSteadyState = (
  nodes: GraphNode[],
): { nodes: GraphNode[]; touchedNodeCount: number } => {
  let touchedNodeCount = 0;

  const nextNodes = nodes.map((node) => {
    const legacyNode = node as LegacyGraphNodeWithSelection;
    const hasNodeSelected = "selected" in legacyNode;
    const data = legacyNode.data;
    const hasSelectedSlotIds =
      data !== null &&
      data !== undefined &&
      typeof data === "object" &&
      "selectedSlotIds" in data;

    if (!hasNodeSelected && !hasSelectedSlotIds) {
      return node;
    }

    touchedNodeCount += 1;
    const { selected: _selected, ...restNode } = legacyNode;
    const nextData =
      hasSelectedSlotIds
        ? (() => {
            const { selectedSlotIds: _selectedSlotIds, ...restData } =
              data as LegacyGraphNodeWithSelection["data"];
            return restData as GraphNodeData;
          })()
        : legacyNode.data;

    return {
      ...restNode,
      data: nextData,
    } as GraphNode;
  });

  return { nodes: nextNodes, touchedNodeCount };
};

export const normalizeNodeGraphMeta = (
  meta: Partial<NodeGraphMeta> | null | undefined,
): NodeGraphMeta => {
  const now = new Date().toISOString();
  const safeMeta = meta ?? {};
  const tags = Array.isArray(safeMeta.tags) ? [...safeMeta.tags] : [];
  const selectedCharacterIds = Array.isArray(safeMeta.selectedCharacterIds)
    ? [...safeMeta.selectedCharacterIds]
    : [];
  const createdBy =
    typeof safeMeta.createdBy === "string" ? safeMeta.createdBy : undefined;
  const category =
    typeof safeMeta.category === "string" ? safeMeta.category : undefined;
  return {
    version:
      typeof safeMeta.version === "string" && safeMeta.version.trim()
        ? safeMeta.version
        : "1.0.0",
    schemaVersion: CURRENT_NODE_GRAPH_SCHEMA_VERSION,
    createdAt:
      typeof safeMeta.createdAt === "string" && safeMeta.createdAt.trim()
        ? safeMeta.createdAt
        : now,
    updatedAt:
      typeof safeMeta.updatedAt === "string" && safeMeta.updatedAt.trim()
        ? safeMeta.updatedAt
        : now,
    createdBy: createdBy ?? undefined,
    tags: tags.length > 0 ? tags : undefined,
    category: category ?? undefined,
    selectedCharacterIds: selectedCharacterIds.length > 0 ? selectedCharacterIds : undefined,
  };
};

export const normalizeViewport = (
  viewport: NodeGraphViewport | null | undefined,
): NodeGraphViewport => {
  const safe = viewport ?? DEFAULT_VIEWPORT;
  return {
    x: typeof safe.x === "number" ? safe.x : DEFAULT_VIEWPORT.x,
    y: typeof safe.y === "number" ? safe.y : DEFAULT_VIEWPORT.y,
    zoom: typeof safe.zoom === "number" ? safe.zoom : DEFAULT_VIEWPORT.zoom,
  };
};

export const normalizeNodePosition = (
  position: NodePosition | null | undefined,
): NodePosition => {
  const safe = position ?? DEFAULT_NODE_POSITION;
  return {
    x: typeof safe.x === "number" ? safe.x : DEFAULT_NODE_POSITION.x,
    y: typeof safe.y === "number" ? safe.y : DEFAULT_NODE_POSITION.y,
  };
};

export const normalizeNodeDataShape = (
  node: GraphNode,
  options: { modelInlineControlsCollapsedDefault: boolean | undefined } | undefined,
): GraphNode => {
  if (node.type === "model") {
    // 旧模型节点数据按 spec 拒绝：不归一、不迁移、不静默转换。
    throw createLegacyModelNodeRejection(node.id, "normalize");
  }
  void options;
  const definitionKey = node.type;
  const definition = definitionKey ? nodeRegistry.get(definitionKey) : undefined;
  const rawData = node.data && typeof node.data === "object" ? node.data : {};
  const mergedData = {
    ...((definition !== null && definition !== undefined ? definition.defaultData : undefined) ?? {}),
    ...rawData,
  } as CanvasDynamicObject & {
    label: string | undefined;
  };
  if (typeof mergedData.label !== "string")
    mergedData.label = (definition !== null && definition !== undefined ? definition.label : undefined) ?? node.type;
  return {
    ...node,
    data: cast<GraphNodeData>(mergedData),
  };
};

export const applyModelInlineControlsCollapsedStartupPreference = (
  node: GraphNode,
  _collapsed: boolean,
): GraphNode => {
  // 模型节点退出画布，inline 参数折叠启动偏好随模型节点废止（no-op）。
  return node;
};

export interface NormalizedGraphEntities {
  nodes: GraphNode[];
  regeneratedNodeCount: number;
  nodeIdMap: Map<string, string>;
}

export const normalizeNodeGraphEntities = (
  nodes: GraphNode[],
): NormalizedGraphEntities => {
  const usedNodeIds = new Set<string>();
  const nodeIdMap = new Map<string, string>();
  const normalizedNodes: GraphNode[] = [];
  let regeneratedNodeCount = 0;
  for (const node of nodes) {
    const rawId = typeof node.id === "string" ? node.id.trim() : "";
    let nextId = rawId || generateNodeId();
    if (!rawId || usedNodeIds.has(nextId)) {
      nextId = generateNodeId();
      regeneratedNodeCount += 1;
    }
    if (!nodeIdMap.has(rawId)) nodeIdMap.set(rawId, nextId);
    usedNodeIds.add(nextId);
    normalizedNodes.push({
      ...node,
      id: nextId,
      position: normalizeNodePosition(node.position),
    });
  }
  return {
    nodes: normalizedNodes,
    regeneratedNodeCount,
    nodeIdMap,
  };
};
