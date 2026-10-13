import { useEffect, useRef } from 'react';
import type { Node } from '@xyflow/react';
import type { UnknownRecord } from '@/client/utils/typeGuards';

interface GraphNodeLikeFields {
  id: unknown | undefined;
  type: unknown | undefined;
}

export type FlowNodeReconcileStats = {
  total: number;
  reused: number;
  updated: number;
  created: number;
  removed: number;
};

export type FlowNodeEquivalenceFn = (prev: Node, next: Node) => boolean;

const EMPTY_NODE_MAP: ReadonlyMap<string, Node> = new Map();

type ComparableSize = Node['measured'] | { width: number | undefined; height: number | undefined } | null | undefined;
type ComparablePosition = Node['position'] | { x: number | undefined; y: number | undefined } | null | undefined;
type ReconciledFlowNodeOptions = {
  enabled: boolean | undefined;
  resetKey: string | number | null | undefined;
  areEquivalent: FlowNodeEquivalenceFn | undefined;
};

const DEFAULT_RECONCILED_FLOW_NODE_OPTIONS: ReconciledFlowNodeOptions = {
  enabled: undefined,
  resetKey: undefined,
  areEquivalent: undefined,
};

const areSizesEqual = (
  prev: ComparableSize,
  next: ComparableSize
): boolean => {
  if (!prev && !next) return true;
  if (!prev || !next) return false;
  return prev.width === next.width && prev.height === next.height;
};

const arePositionsEqual = (
  prev: ComparablePosition,
  next: ComparablePosition
): boolean => {
  if (!prev && !next) return true;
  if (!prev || !next) return false;
  return prev.x === next.x && prev.y === next.y;
};

const hasMeasuredSize = (value: ComparableSize): boolean =>
  Boolean(value && (value.width != null || value.height != null));

const getNodeDimensions = (node: Node): { width: number | undefined; height: number | undefined } => ({
  width: typeof node.width === 'number' ? node.width : undefined,
  height: typeof node.height === 'number' ? node.height : undefined,
});

const BOOLEAN_KEYS = new Set(['selected', 'draggable', 'connectable', 'selectable', 'focusable', 'deletable']);

type GraphNodeLike = {
  id: string;
  type: string;
  data: unknown;
  inputs: unknown | undefined;
  outputs: unknown | undefined;
};

const isGraphNodeLike = (value: unknown): value is GraphNodeLike => {
  if (!value || typeof value !== 'object') return false;
  const anyValue = value as GraphNodeLikeFields;
  return (
    typeof anyValue.id === 'string' &&
    typeof anyValue.type === 'string' &&
    Object.prototype.hasOwnProperty.call(value, 'data')
  );
};

const areGraphNodeLikeEquivalentIgnoringMeasuredSize = (prev: unknown, next: unknown): boolean => {
  if (prev === next) return true;
  if (!isGraphNodeLike(prev) || !isGraphNodeLike(next)) return false;
  if (prev.id !== next.id) return false;
  if (prev.type !== next.type) return false;
  if (prev.data !== next.data) return false;
  if (prev.inputs !== next.inputs) return false;
  if (prev.outputs !== next.outputs) return false;
  return true;
};

export const areFlowNodesEquivalent: FlowNodeEquivalenceFn = (prev, next) => {
  if (prev === next) return true;
  if (prev.id !== next.id) return false;

  if (!arePositionsEqual(prev.position, next.position)) return false;
  if (!areSizesEqual(prev.measured, next.measured)) return false;

  const prevAny = prev as UnknownRecord;
  const nextAny = next as UnknownRecord;
  const prevKeys = Object.keys(prevAny).filter((key) => key !== 'position' && key !== 'measured');
  const nextKeys = Object.keys(nextAny).filter((key) => key !== 'position' && key !== 'measured');
  const keys = new Set([...prevKeys, ...nextKeys]);

  for (const key of keys) {
    if (key === 'selected' && !(key in nextAny)) {
      continue;
    }

    if (!BOOLEAN_KEYS.has(key) && (!(key in prevAny) || !(key in nextAny))) {
      return false;
    }

    const prevValue = prevAny[key];
    const nextValue = nextAny[key];

    if (BOOLEAN_KEYS.has(key)) {
      if (Boolean(prevValue) !== Boolean(nextValue)) return false;
      continue;
    }

    if (key === 'data' && areGraphNodeLikeEquivalentIgnoringMeasuredSize(prevValue, nextValue)) {
      continue;
    }

    if (prevValue !== nextValue) return false;
  }

  return true;
};

const preserveNodeRuntimeContinuity = (prev: Node, next: Node): Node => {
  const shouldPreserveMeasured = !hasMeasuredSize(next.measured) && areSizesEqual(getNodeDimensions(prev), getNodeDimensions(next));

  if (!shouldPreserveMeasured && !('selected' in prev && !('selected' in next))) {
    return next;
  }

  let patched: Node | null = null;

  if (shouldPreserveMeasured && hasMeasuredSize(prev.measured)) {
    patched = {
      ...next,
      ...(prev.measured != null ? { measured: prev.measured } : {}),
    };
  }

  if ('selected' in prev && !('selected' in next)) {
    patched = patched ?? { ...next };
    patched.selected = prev.selected;
  }

  return patched ?? next;
};

export function reconcileFlowNodesById(
  prevById: ReadonlyMap<string, Node>,
  nextNodes: Node[],
  areEquivalent: FlowNodeEquivalenceFn = areFlowNodesEquivalent
): {
  nodes: Node[];
  nextById: Map<string, Node>;
  stats: FlowNodeReconcileStats;
} {
  let reused = 0;
  let updated = 0;
  let created = 0;
  let removed = prevById.size;

  const reconciled: Node[] = [];
  const nextById = new Map<string, Node>();

  for (const next of nextNodes) {
    const prev = prevById.get(next.id);
    if (prev) {
      removed -= 1;
    }

    if (prev && areEquivalent(prev, next)) {
      reused += 1;
      reconciled.push(prev);
      nextById.set(next.id, prev);
      continue;
    }

    if (prev) {
      updated += 1;
    } else {
      created += 1;
    }

    const patchedNext = prev ? preserveNodeRuntimeContinuity(prev, next) : next;

    reconciled.push(patchedNext);
    nextById.set(next.id, patchedNext);
  }

  return {
    nodes: reconciled,
    nextById,
    stats: {
      total: nextNodes.length,
      reused,
      updated,
      created,
      removed,
    },
  };
}

export function useReconciledFlowNodes(
  nextNodes: Node[],
  options: ReconciledFlowNodeOptions = DEFAULT_RECONCILED_FLOW_NODE_OPTIONS
): {
  nodes: Node[];
  stats: FlowNodeReconcileStats;
} {
  const { enabled = true, resetKey = null, areEquivalent = areFlowNodesEquivalent } = options;

  const lastResetKeyRef = useRef<string | number | null>(resetKey);
  const prevByIdRef = useRef<Map<string, Node>>(new Map());

  const prevById = enabled && lastResetKeyRef.current === resetKey ? prevByIdRef.current : EMPTY_NODE_MAP;
  const reconciled = enabled
    ? reconcileFlowNodesById(prevById, nextNodes, areEquivalent)
    : {
        nodes: nextNodes,
        nextById: new Map<string, Node>(),
        stats: {
          total: nextNodes.length,
          reused: 0,
          updated: 0,
          created: nextNodes.length,
          removed: prevByIdRef.current.size,
        },
      };

  useEffect(() => {
    if (!enabled) return;
    lastResetKeyRef.current = resetKey;
    prevByIdRef.current = reconciled.nextById;
  }, [enabled, resetKey, reconciled.nextById]);

  return { nodes: reconciled.nodes, stats: reconciled.stats };
}
