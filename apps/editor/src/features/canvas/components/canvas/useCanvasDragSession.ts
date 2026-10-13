import { useCallback, useRef, useState } from "react";

import type { GraphNode, NodePosition } from "../../types";

export type CanvasDragPositionUpdate = {
  id: string;
  position: NodePosition;
};

export type DragTimelineStoppedSnapshot = {
  sessionId: string;
  stoppedAt: number;
  positions: Record<string, NodePosition>;
  nodesById: Map<string, GraphNode>;
};

type CanvasDragSessionState = {
  active: boolean;
  graphId: string | null;
  positions: Record<string, NodePosition>;
};

const EMPTY_POSITIONS: Record<string, NodePosition> = {};

const copyPositions = (
  positions: Readonly<Record<string, NodePosition>>,
): Record<string, NodePosition> => {
  const next: Record<string, NodePosition> = {};
  for (const [id, position] of Object.entries(positions)) {
    next[id] = { x: position.x, y: position.y };
  }
  return next;
};

export function useCanvasDragSession(nodeGraphId: string | null) {
  const sessionRef = useRef<CanvasDragSessionState>({
    active: false,
    graphId: nodeGraphId,
    positions: EMPTY_POSITIONS,
  });
  const sequenceRef = useRef(0);
  const [dragTimelineSnapshot, setDragTimelineSnapshot] =
    useState<DragTimelineStoppedSnapshot | null>(null);

  const beginDragSession = useCallback(() => {
    const session = sessionRef.current;
    if (session.active && session.graphId === nodeGraphId) return;
    sessionRef.current = {
      active: true,
      graphId: nodeGraphId,
      positions: {},
    };
  }, [nodeGraphId]);

  const recordDragPositions = useCallback(
    (updates: readonly CanvasDragPositionUpdate[]) => {
      if (updates.length === 0) return;
      beginDragSession();
      const current = sessionRef.current.positions;
      const next = { ...current };
      for (const update of updates) {
        next[update.id] = { x: update.position.x, y: update.position.y };
      }
      sessionRef.current = {
        ...sessionRef.current,
        positions: next,
      };
    },
    [beginDragSession],
  );

  const hasActiveDragSession = useCallback(() => {
    return sessionRef.current.active;
  }, []);

  const consumeFinalPositions = useCallback(() => {
    const positions = copyPositions(sessionRef.current.positions);
    sessionRef.current = {
      active: false,
      graphId: nodeGraphId,
      positions: EMPTY_POSITIONS,
    };
    return positions;
  }, [nodeGraphId]);

  const clearDragSession = useCallback(() => {
    sessionRef.current = {
      active: false,
      graphId: nodeGraphId,
      positions: EMPTY_POSITIONS,
    };
  }, [nodeGraphId]);

  const publishDragStopSnapshot = useCallback(
    (params: {
      positions: Readonly<Record<string, NodePosition>>;
      nodes: readonly GraphNode[];
    }) => {
      const positions = copyPositions(params.positions);
      if (Object.keys(positions).length === 0) return;
      const nodesById = new Map<string, GraphNode>();
      for (const nodeId of Object.keys(positions)) {
        const node = params.nodes.find((item) => item.id === nodeId);
        if (node) {
          nodesById.set(nodeId, node);
        }
      }
      sequenceRef.current += 1;
      setDragTimelineSnapshot({
        sessionId: `drag-${Date.now().toString(36)}-${sequenceRef.current.toString(36)}`,
        stoppedAt: Date.now(),
        positions,
        nodesById,
      });
    },
    [],
  );

  return {
    beginDragSession,
    recordDragPositions,
    hasActiveDragSession,
    consumeFinalPositions,
    clearDragSession,
    publishDragStopSnapshot,
    dragTimelineSnapshot,
  };
}
