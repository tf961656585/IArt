import type {
  CanvasAnnotation,
  GraphNode,
  NodeGraph,
  NodeGraphSettings,
} from '../../types';
import type { UnknownRecord } from '@/client/utils/typeGuards';

interface TaskRefFields {
  taskId: unknown | undefined;
}

/**
 * extractTaskIdsFromNodeData 所需的最小节点 data 结构。
 * 仅声明要读取的字段，避免依赖完整的节点 data 类型。
 */
interface NodeDataTaskIdExtraction {
  runtimeRef: unknown | undefined;
  resultArea: NodeDataResultAreaExtraction | undefined;
  taskId: unknown | undefined;
  sourceTaskId: unknown | undefined;
}

interface NodeDataResultAreaExtraction {
  slots: unknown | undefined;
}

interface NodeDataSlotExtraction {
  runtimeRef: unknown | undefined;
}

/**
 * 从节点 data 中提取 runtimeRef 的 taskId（容错读取）。
 */
const readTaskIdFromRuntimeRef = (runtimeRef: unknown): string | undefined => {
  if (runtimeRef === null || runtimeRef === undefined) return undefined;
  const taskId = (runtimeRef as TaskRefFields).taskId;
  return typeof taskId === 'string' && taskId ? taskId : undefined;
};

/**
 * 从单个 slot 对象中读取 runtimeRef.taskId（容错读取）。
 */
const readTaskIdFromSlot = (slot: unknown): string | undefined => {
  if (!slot || typeof slot !== 'object') return undefined;
  return readTaskIdFromRuntimeRef((slot as NodeDataSlotExtraction).runtimeRef);
};

/**
 * 从节点 data 中提取所有相关的 taskId，用于构建/维护 taskIdIndex。
 *
 * 读取三条路径：
 * 1. data.taskId —— 任务节点直接持有自己的 RuntimeTask id。
 * 2. data.sourceTaskId —— 资产节点保留来源 RuntimeTask id（溯源/复用）。
 * 3. data.runtimeRef.taskId / data.resultArea.slots[].runtimeRef.taskId ——
 *    旧结果区/slot 承载路径（迁移期仅用于识别与拒绝，不再作为运行消费路径）。
 *
 * 这是 taskIdIndex 的单一提取口径。
 */
export const extractTaskIdsFromNodeData = (nodeData: unknown): string[] => {
  if (!nodeData || typeof nodeData !== 'object') return [];
  const data = nodeData as NodeDataTaskIdExtraction;
  const ids: string[] = [];

  if (typeof data.taskId === 'string' && data.taskId && !ids.includes(data.taskId)) {
    ids.push(data.taskId);
  }

  if (
    typeof data.sourceTaskId === 'string' &&
    data.sourceTaskId &&
    !ids.includes(data.sourceTaskId)
  ) {
    ids.push(data.sourceTaskId);
  }

  const runtimeTaskId = readTaskIdFromRuntimeRef(data.runtimeRef);
  if (runtimeTaskId && !ids.includes(runtimeTaskId)) {
    ids.push(runtimeTaskId);
  }

  const resultArea = data.resultArea;
  if (resultArea !== null && resultArea !== undefined && typeof resultArea === 'object') {
    const slots = resultArea.slots;
    if (Array.isArray(slots)) {
      for (const slot of slots) {
        const slotTaskId = readTaskIdFromSlot(slot);
        if (slotTaskId && !ids.includes(slotTaskId)) {
          ids.push(slotTaskId);
        }
      }
    }
  }

  return ids;
};

export type CanvasDirtyFlags = {
  graph: boolean;
  viewport: boolean;
  fullReplace: boolean;
  mediaAssets: boolean;
  nodes: Record<string, true>;
  removedNodes: Record<string, true>;
};

export type CanvasDirtyState = {
  hasUnsavedChanges: boolean;
  dirtyRevision: number;
  dirty: CanvasDirtyFlags;
};

export interface HistorySnapshotEntry {
  kind: 'snapshot';
  nodes: GraphNode[];
  annotations: CanvasAnnotation[];
  settings: NodeGraphSettings;
}

/**
 * 增量历史条目。patches 描述从前一状态到本状态的变更，
 * inversePatches 描述反向变更（用于 undo）。
 *
 * 当前仅用于位置（node.position）与纯数据（node.data 非结构字段）变更。
 * 结构变更（增删节点/边、端口 reconcile）仍使用 snapshot 条目。
 */
export interface HistoryPatchEntry {
  kind: 'patch';
  patches: unknown[];
  inversePatches: unknown[];
  summary: string;
}

export type HistoryEntry = HistorySnapshotEntry | HistoryPatchEntry;

export interface DeferredHistoryBaseline {
  nodeGraph: NodeGraph;
}

export interface LoadRepairDiagnostics {
  path: 'fast' | 'repair';
  stripLegacySelectionSteadyState: 0 | number;
  normalizeNodeData: number;
  normalizeEntities: number;
  sanitizeNodeMedia: number;
  migrateTextNodes: number;
  remapAnnotations: number;
  stripRuntimeLayout: number;
}

export const isPlainObject = (value: unknown): value is UnknownRecord => {
  if (!value || typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

export const areArraysShallowEqual = (a: unknown[], b: unknown[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
};

export const arePlainObjectsShallowEqual = (
  a: UnknownRecord,
  b: UnknownRecord
): boolean => {
  if (a === b) return true;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    const valueA = a[key];
    const valueB = b[key];
    if (Object.is(valueA, valueB)) continue;
    if (isPlainObject(valueA) && isPlainObject(valueB) && arePlainObjectsShallowEqual(valueA, valueB)) continue;
    if (Array.isArray(valueA) && Array.isArray(valueB) && areArraysShallowEqual(valueA, valueB)) continue;
    return false;
  }
  return true;
};

export const isStoreValueEqual = (prev: unknown, next: unknown): boolean => {
  if (Object.is(prev, next)) return true;
  if (Array.isArray(prev) && Array.isArray(next)) {
    return areArraysShallowEqual(prev, next);
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    return arePlainObjectsShallowEqual(prev, next);
  }
  return false;
};

export const updateTaskIdIndex = (
  index: Map<string, string[]>,
  oldTaskIds: string[],
  newTaskIds: string[],
  nodeId: string,
) => {
  for (const tid of oldTaskIds) {
    const arr = index.get(tid);
    if (arr) {
      const filtered = arr.filter(id => id !== nodeId);
      if (filtered.length === 0) index.delete(tid);
      else index.set(tid, filtered);
    }
  }
  for (const tid of newTaskIds) {
    const arr = index.get(tid);
    if (arr) {
      if (!arr.includes(nodeId)) arr.push(nodeId);
    } else {
      index.set(tid, [nodeId]);
    }
  }
};

export const buildTaskIdIndex = (nodes: GraphNode[]): Map<string, string[]> => {
  const index = new Map<string, string[]>();
  for (const node of nodes) {
    const taskIds = extractTaskIdsFromNodeData(node.data);
    for (const tid of taskIds) {
      const arr = index.get(tid);
      if (arr) arr.push(node.id);
      else index.set(tid, [node.id]);
    }
  }
  return index;
};


type GraphNodeLookupCache = {
  graphId: string | null;
  structureRevision: number;
  nodesRef: ReadonlyArray<GraphNode> | null;
  value: Map<string, GraphNode>;
};

const graphNodeLookupCache: GraphNodeLookupCache = {
  graphId: null,
  structureRevision: -1,
  nodesRef: null,
  value: new Map(),
};

export type GraphNodeLookupState = {
  nodeGraph: NodeGraph | null;
  structureRevision: number;
};

export const getCachedGraphNodeLookup = (state: GraphNodeLookupState): Map<string, GraphNode> => {
  const graph = state.nodeGraph;
  const nodes = (graph !== null && graph !== undefined ? graph.nodes : undefined) ?? null;
  if (!graph || !nodes) {
    if (graphNodeLookupCache.graphId !== null) {
      graphNodeLookupCache.graphId = null;
      graphNodeLookupCache.structureRevision = -1;
      graphNodeLookupCache.nodesRef = null;
      graphNodeLookupCache.value = new Map();
    }
    return graphNodeLookupCache.value;
  }

  if (
    graphNodeLookupCache.graphId === graph.id &&
    graphNodeLookupCache.structureRevision === state.structureRevision &&
    graphNodeLookupCache.nodesRef === nodes
  ) {
    return graphNodeLookupCache.value;
  }

  const next = new Map<string, GraphNode>();
  for (const node of nodes) {
    next.set(node.id, node);
  }

  graphNodeLookupCache.graphId = graph.id;
  graphNodeLookupCache.structureRevision = state.structureRevision;
  graphNodeLookupCache.nodesRef = nodes;
  graphNodeLookupCache.value = next;
  return graphNodeLookupCache.value;
};
