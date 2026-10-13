import { useMemo } from 'react';
import { shallow } from 'zustand/shallow';
import type { GraphNode, GraphNodeData, GraphNodeType } from '../types';
import { useCanvasStore } from '../store/canvasStore';
import { selectNodeSnapshot, type NodeSnapshot } from '../store/selectors';
import type { UnknownRecord } from '@/client/utils/typeGuards';

type GraphNodeLikeRaw = {
  position: unknown | undefined;
  id: unknown | undefined;
  type: unknown | undefined;
};

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null;

const isGraphNodeLike = (value: unknown): value is GraphNode<GraphNodeData> => {
  if (!isRecord(value)) return false;

  const raw = value as GraphNodeLikeRaw;
  if (!isRecord(raw.position)) return false;
  const x = (raw.position as { x: unknown | undefined }).x;
  const y = (raw.position as { y: unknown | undefined }).y;

  return (
    typeof raw.id === 'string' &&
    typeof raw.type === 'string' &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Object.prototype.hasOwnProperty.call(value, 'data')
  );
};

export const createFallbackGraphNode = <T extends GraphNodeData>(params: {
  nodeId: string;
  type: GraphNodeType;
  data: Partial<T> | undefined;
}): GraphNode<T> => {
  return {
    id: params.nodeId,
    type: params.type,
    position: { x: 0, y: 0 },
    data: (params.data ?? {}) as T,
    draggable: true,
    size: undefined,
    style: undefined,
    groupId: undefined,
  };
};

export const resolveFallbackGraphNodeFromNodePropsData = <T extends GraphNodeData>(params: {
  nodeId: string;
  type: GraphNodeType;
  nodePropsData: unknown;
}): GraphNode<T> => {
  const base = createFallbackGraphNode<T>({ nodeId: params.nodeId, type: params.type, data: undefined });
  if (!isGraphNodeLike(params.nodePropsData)) return base;

  const candidate = params.nodePropsData as GraphNode<T>;
  if (candidate.id !== params.nodeId) return base;
  if (candidate.type !== params.type) return base;

  const draggable = typeof candidate.draggable === 'boolean' ? candidate.draggable : (base.draggable ?? true);
  return {
    id: params.nodeId,
    type: params.type,
    position: candidate.position ?? base.position,
    data: (candidate.data ?? base.data) as T,
    draggable,
    size: candidate.size ?? undefined,
    style: candidate.style ?? undefined,
    groupId: typeof candidate.groupId === 'string' ? candidate.groupId : undefined,
  };
};

export function useNodeFromStore<T extends GraphNodeData, U = NodeSnapshot<T>>(
  params: {
    nodeId: string;
    fallback: GraphNode<T>;
    select: (snapshot: NodeSnapshot<T>) => U | undefined;
    equalityFn: (prev: U, next: U) => boolean | undefined;
  }
): U {
  const { nodeId, fallback, select, equalityFn } = params;

  const snapshotSelector = useMemo(() => selectNodeSnapshot<T>(nodeId, fallback), [nodeId, fallback]);
  const selector = useMemo(
    () =>
      (state: ReturnType<typeof useCanvasStore.getState>) => {
        const snapshot = snapshotSelector(state);
        const selected = select(snapshot);
        return selected !== undefined ? selected : (snapshot as U);
      },
    [select, snapshotSelector]
  );

  const resolvedEqualityFn = useMemo(
    () => (prev: U, next: U): boolean => (equalityFn(prev, next) ?? shallow(prev, next)),
    [equalityFn],
  );

  return useCanvasStore(selector, resolvedEqualityFn);
}
