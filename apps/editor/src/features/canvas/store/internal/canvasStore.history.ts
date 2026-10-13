import { applyPatches, current, isDraft } from 'immer';

import type {
  DesiredSize,
  GraphNode,
  GraphNodeData,
  NodeContentCache,
  NodeGraph,
} from '../../types';
import { normalizeNodeGraphSettings } from '../../types/nodeGraph';

import type { DynamicRecord } from '@/client/utils/typeGuards';
import { cast } from '@/lib/utils';
import { stripNodeRuntimeLayoutFromNode } from '../../utils/nodeSize';
import type {
  CanvasDirtyState,
  DeferredHistoryBaseline,
  HistoryEntry,
  HistoryPatchEntry,
  HistorySnapshotEntry,
} from './canvasStore.shared';
import { markFullGraphDirty } from './canvasStore.persistence';

const MEDIA_URL_FIELDS = ['imageUrl', 'videoUrl', 'audioUrl'] as const;
type MediaUrlField = (typeof MEDIA_URL_FIELDS)[number];
type NodeMediaUrlCache = Partial<Record<MediaUrlField, string | null>>;
const HISTORY_SNAPSHOT_PLACEHOLDER = '[history-snapshot]';

type HistoryPlainValue =
  | null
  | undefined
  | string
  | number
  | boolean
  | bigint
  | HistoryPlainValue[]
  | HistoryPlainValueMap;

interface HistoryPlainValueMap {
  [key: string]: HistoryPlainValue;
}

type HistoryPlainObjectMap = DynamicRecord;

const isPlainObject = (value: unknown): value is HistoryPlainObjectMap => {
  if (!value || typeof value !== 'object') return false;
  const proto = Reflect.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const isReactElementLike = (value: HistoryPlainObjectMap): boolean => {
  return typeof value['$$typeof'] === 'symbol' && 'props' in value;
};

const toHistoryPlainValue = (
  input: unknown,
  seen: WeakSet<object> = new WeakSet()
): HistoryPlainValue => {
  const value = isDraft(input) ? current(input) : input;
  if (value === null || value === undefined) return value;
  const valueType = typeof value;
  if (
    valueType === 'string' ||
    valueType === 'number' ||
    valueType === 'boolean' ||
    valueType === 'bigint'
  ) {
    return value as HistoryPlainValue;
  }
  if (valueType === 'function' || valueType === 'symbol') return undefined;
  if (valueType !== 'object') return undefined;

  const objectValue = value as object;
  if (seen.has(objectValue)) return undefined;
  seen.add(objectValue);

  if (Array.isArray(value)) {
    const output = value.map((item) => {
      const plainItem = toHistoryPlainValue(item, seen);
      return plainItem === undefined ? null : plainItem;
    });
    seen.delete(objectValue);
    return output;
  }

  if (!isPlainObject(value) || isReactElementLike(value)) {
    seen.delete(objectValue);
    return undefined;
  }

  const output: DynamicRecord<HistoryPlainValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const plainItem = toHistoryPlainValue(item, seen);
    if (plainItem !== undefined) output[key] = plainItem;
  }
  seen.delete(objectValue);
  return output;
};

const cloneHistoryPlainValue = <T>(value: T): T => {
  return structuredClone(toHistoryPlainValue(value)) as T;
};

const isBase64DataUrl = (url: unknown): boolean => {
  return typeof url === 'string' && url.startsWith('data:') && url.includes('base64,');
};

const isHistorySnapshotPlaceholder = (url: unknown): boolean => {
  return typeof url === 'string' && url.includes(HISTORY_SNAPSHOT_PLACEHOLDER);
};

const truncateBase64ForHistory = (url: string): string => {
  if (!isBase64DataUrl(url)) return url;
  const mimeMatch = /^data:([^;,]+)/.exec(url);
  const mimeType = (mimeMatch !== null && mimeMatch !== undefined ? mimeMatch[1] : undefined) || 'unknown';
  return `data:${mimeType};base64,${HISTORY_SNAPSHOT_PLACEHOLDER}`;
};

const extractMediaUrls = (node: GraphNode): NodeMediaUrlCache | null => {
  const data = cast<DynamicRecord>(node.data);
  const cache: NodeMediaUrlCache = {};
  let hasValidUrl = false;
  for (const field of MEDIA_URL_FIELDS) {
    const value = data[field];
    if (typeof value === 'string' && !isHistorySnapshotPlaceholder(value)) {
      cache[field] = value;
      hasValidUrl = true;
    }
  }
  return hasValidUrl ? cache : null;
};

const restoreMediaUrls = (node: GraphNode, mediaCache: NodeMediaUrlCache | undefined): void => {
  if (!mediaCache) return;
  const data = cast<DynamicRecord>(node.data);
  for (const field of MEDIA_URL_FIELDS) {
    const currentValue = data[field];
    const cachedValue = mediaCache[field];
    if (isHistorySnapshotPlaceholder(currentValue) && cachedValue !== undefined) {
      data[field] = cachedValue;
    }
  }
};

const stripMediaCacheFromNode = (node: GraphNode): GraphNode => {
  const baseNode = stripNodeRuntimeLayoutFromNode(node);
  const { cachedContent: _cachedContent, ...restData } = cast<DynamicRecord & {
    cachedContent: NodeContentCache | null | undefined;
  }>(baseNode.data);
  const cleanedData = { ...restData };
  for (const field of MEDIA_URL_FIELDS) {
    const value = cleanedData[field];
    if (typeof value === 'string' && isBase64DataUrl(value)) {
      cleanedData[field] = truncateBase64ForHistory(value);
    }
  }
  return {
    ...baseNode,
    data: cast<GraphNodeData>(cleanedData),
  };
};

export const createHistoryEntryFromGraph = (
  nodeGraph: NodeGraph
): HistorySnapshotEntry => {
  const nodesWithoutCache = nodeGraph.nodes.map(stripMediaCacheFromNode);
  return {
    kind: 'snapshot',
    nodes: cloneHistoryPlainValue(nodesWithoutCache),
    annotations: cloneHistoryPlainValue(nodeGraph.annotations ?? []),
    settings: cloneHistoryPlainValue(normalizeNodeGraphSettings(nodeGraph.settings)),
  };
};

type HistoryState = CanvasDirtyState & {
  nodeGraph: NodeGraph | null;
  history: HistoryEntry[];
  historyIndex: number;
  deferredHistoryBaseline: DeferredHistoryBaseline | null;
  maxHistorySize: number;
  selectedNodeIds: string[];
  ui: {
    desiredSizeByNodeId: Record<string, DesiredSize>;
  };
  structureRevision: number;
  taskRevision: number;
};

export const saveToHistoryState = (
  state: HistoryState,
  entry: HistoryEntry,
  deferredBaselineEntry: HistoryEntry | null
) => {
  const newHistory = state.history.slice(0, state.historyIndex + 1);
  const deferredBaseline = state.deferredHistoryBaseline;
  const shouldCommitDeferredBaseline =
    newHistory.length === 0 &&
    deferredBaseline &&
    deferredBaseline.nodeGraph.id === (state.nodeGraph !== null && state.nodeGraph !== undefined ? state.nodeGraph.id : undefined) &&
    deferredBaselineEntry;

  if (shouldCommitDeferredBaseline) {
    newHistory.push(deferredBaselineEntry);
  }

  newHistory.push(entry);
  if (newHistory.length > state.maxHistorySize) {
    const overflow = newHistory.length - state.maxHistorySize;
    newHistory.splice(0, overflow);
  }

  state.history = newHistory;
  state.historyIndex = newHistory.length - 1;
  state.deferredHistoryBaseline = null;
};

export const commitDeferredHistoryBaselineState = (state: HistoryState, entry: HistoryEntry) => {
  if (!state.deferredHistoryBaseline || state.history.length > 0) return;
  state.history = [entry];
  state.historyIndex = 0;
  state.deferredHistoryBaseline = null;
};

/**
 * 将一个增量 patch 条目追加到历史栈。
 *
 * 用于位置变更与纯数据变更。patch 条目不携带完整图快照，
 * 只记录 patches（正向）与 inversePatches（反向）。
 *
 * 为防止 patch 链过长，当连续 patch 条目达到 CHECKPOINT_INTERVAL 时，
 * 下一次 saveToHistory 会落一个 snapshot checkpoint。
 */
const PATCH_CHECKPOINT_INTERVAL = 20;

export const savePatchToHistoryState = (
  state: HistoryState,
  patches: unknown[],
  inversePatches: unknown[],
  summary: string
) => {
  const newHistory = state.history.slice(0, state.historyIndex + 1);
  newHistory.push({ kind: 'patch', patches, inversePatches, summary });
  if (newHistory.length > state.maxHistorySize) {
    const overflow = newHistory.length - state.maxHistorySize;
    newHistory.splice(0, overflow);
  }
  state.history = newHistory;
  state.historyIndex = newHistory.length - 1;
  state.deferredHistoryBaseline = null;
};

/**
 * 判断当前是否需要落一个 snapshot checkpoint（patch 链过长时）。
 * 调用方在决定走 patch 还是 snapshot 前检查此函数。
 */
export const shouldCreateSnapshotCheckpoint = (state: HistoryState): boolean => {
  if (state.historyIndex < 0) return true;
  let consecutivePatches = 0;
  for (let i = state.historyIndex; i >= 0; i--) {
    const entry = state.history[i];
    if (!entry) continue;
    if (entry.kind === 'patch') {
      consecutivePatches += 1;
      if (consecutivePatches >= PATCH_CHECKPOINT_INTERVAL) return true;
    } else {
      return false;
    }
  }
  return false;
};

export const createNodeRestorationCaches = (nodes: GraphNode[]) => {
  const cachedContentMap = new Map<string, NodeContentCache | null | undefined>();
  const mediaUrlCacheMap = new Map<string, NodeMediaUrlCache | null>();
  for (const node of nodes) {
    const dataWithCache = node.data as { cachedContent: NodeContentCache | null | undefined };
    if ('cachedContent' in dataWithCache) {
      cachedContentMap.set(node.id, dataWithCache.cachedContent);
    }
    const mediaCache = extractMediaUrls(node);
    if (mediaCache) {
      mediaUrlCacheMap.set(node.id, mediaCache);
    }
  }
  return { cachedContentMap, mediaUrlCacheMap };
};

const restoreHistoryEntryNode = (
  restoredNode: GraphNode,
  cachedContentMap: Map<string, NodeContentCache | null | undefined>,
  mediaUrlCacheMap: Map<string, NodeMediaUrlCache | null>
) => {
  const cachedContent = cachedContentMap.get(restoredNode.id);
  if (cachedContent !== undefined) {
    (restoredNode.data as { cachedContent: NodeContentCache | null | undefined }).cachedContent = cachedContent;
  }
  const mediaCache = mediaUrlCacheMap.get(restoredNode.id);
  if (mediaCache) {
    restoreMediaUrls(restoredNode, mediaCache);
  }
};

export const restoreHistoryEntryState = (
  state: HistoryState,
  entry: HistoryEntry,
  nextHistoryIndex: number,
  caches: ReturnType<typeof createNodeRestorationCaches>
) => {
  if (!state.nodeGraph) return;

  if (entry.kind === 'patch') {
    restoreHistoryPatchEntryState(state, entry, nextHistoryIndex);
    return;
  }

  const restoredNodes = structuredClone(entry.nodes);
  for (const restoredNode of restoredNodes) {
    restoreHistoryEntryNode(restoredNode, caches.cachedContentMap, caches.mediaUrlCacheMap);
  }
  state.nodeGraph.nodes = restoredNodes;
  state.nodeGraph.annotations = structuredClone(entry.annotations ?? []);
  state.nodeGraph.settings = normalizeNodeGraphSettings(entry.settings);
  state.historyIndex = nextHistoryIndex;
  state.selectedNodeIds = [];
  markFullGraphDirty(state);
  state.structureRevision += 1;
  state.taskRevision += 1;
};

/**
 * 增量 patch 条目的恢复。
 *
 * patch 条目由 undo（应用 inversePatches）或 redo（应用 patches）驱动。
 * patch 只涉及 node.position 或 node.data 非结构字段，因此：
 * - 不需要重建 edges/annotations/settings（它们未变）；
 * - 倒排索引不受影响（taskId/sourceNodeId 不变）；
 * - 不需要 mediaUrl 还原（patch 不含媒体字段变更）。
 *
 * 注意：此函数在 immer set() 回调内被调用，state 是 draft。
 * applyPatches 直接作用于 draft，按 patch 路径就地修改。
 */
const restoreHistoryPatchEntryState = (
  state: HistoryState,
  entry: HistoryPatchEntry,
  nextHistoryIndex: number
) => {
  if (!state.nodeGraph) return;
  const patches = nextHistoryIndex < state.historyIndex ? entry.inversePatches : entry.patches;
  if (patches.length > 0) {
    // patch 由 produceWithPatches 基于 nodeGraph.nodes（数组）生成，
    // 路径形如 [index, "position"]。apply 的基准必须与生成基准一致，
    // 因此作用于 state.nodeGraph.nodes，而不是整个 nodeGraph。
    applyPatches(state.nodeGraph.nodes, patches as Parameters<typeof applyPatches>[1]);
  }
  state.historyIndex = nextHistoryIndex;
  state.selectedNodeIds = [];
  markFullGraphDirty(state);
  state.structureRevision += 1;
  state.taskRevision += 1;
};
