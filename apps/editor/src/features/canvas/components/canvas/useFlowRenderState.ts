import { useCallback, useEffect, useRef, useState } from "react";
import type { Node } from "@xyflow/react";

import type { NodePosition } from "../../types";
import { reconcileFlowNodesById } from "./flowNodeMemoizer";

export type RenderPositionUpdate = {
  id: string;
  position: NodePosition;
};

type ApplyRenderPositionUpdatesParams = {
  nodes: Node[];
  updates: readonly RenderPositionUpdate[];
};

type UseFlowRenderStateParams = {
  stableNodes: Node[];
  nodeGraphId: string | null;
  structureRevision: number;
  positionRevision: number;
  flowComputationEnabled: boolean;
};

const samePosition = (a: NodePosition, b: NodePosition): boolean =>
  a.x === b.x && a.y === b.y;

const sameNodeReferences = (
  prev: readonly Node[],
  next: readonly Node[],
): boolean => {
  if (prev.length !== next.length) return false;
  for (let index = 0; index < prev.length; index += 1) {
    if (prev[index] !== next[index]) return false;
  }
  return true;
};

export const applyRenderPositionUpdatesToNodes = ({
  nodes,
  updates,
}: ApplyRenderPositionUpdatesParams): Node[] => {
  if (updates.length === 0) return nodes;
  const updateById = new Map<string, NodePosition>();
  for (const update of updates) {
    updateById.set(update.id, update.position);
  }

  let changed = false;
  const nextNodes = nodes.map((node) => {
    const absPosition = updateById.get(node.id);
    if (!absPosition) return node;
    if (samePosition(node.position, absPosition)) return node;
    changed = true;
    return {
      ...node,
      position: absPosition,
    };
  });

  return changed ? nextNodes : nodes;
};

export function useFlowRenderState({
  stableNodes,
  nodeGraphId,
  structureRevision,
  positionRevision,
  flowComputationEnabled,
}: UseFlowRenderStateParams) {
  const dragActiveRef = useRef(false);
  const lastGraphIdRef = useRef<string | null>(nodeGraphId);
  const [renderNodes, setRenderNodes] = useState<Node[]>(stableNodes);

  useEffect(() => {
    const graphChanged = lastGraphIdRef.current !== nodeGraphId;
    if (graphChanged) {
      dragActiveRef.current = false;
      lastGraphIdRef.current = nodeGraphId;
    }
    if (dragActiveRef.current && !graphChanged) return;
    void structureRevision;
    void positionRevision;
    void flowComputationEnabled;
    setRenderNodes((prev) => {
      const prevById = new Map(prev.map((node) => [node.id, node]));
      const next = reconcileFlowNodesById(prevById, stableNodes).nodes;
      return sameNodeReferences(prev, next) ? prev : next;
    });
  }, [
    flowComputationEnabled,
    nodeGraphId,
    positionRevision,
    stableNodes,
    structureRevision,
  ]);

  const beginRenderDragSession = useCallback(() => {
    dragActiveRef.current = true;
  }, []);

  const endRenderDragSession = useCallback(() => {
    dragActiveRef.current = false;
  }, []);

  const applyRenderPositionUpdates = useCallback(
    (updates: readonly RenderPositionUpdate[]) => {
      if (updates.length === 0) return;
      dragActiveRef.current = true;
      setRenderNodes((prev) =>
        applyRenderPositionUpdatesToNodes({
          nodes: prev,
          updates,
        }),
      );
    },
    [],
  );

  const removeRenderNodes = useCallback((nodeIds: readonly string[]) => {
    if (nodeIds.length === 0) return;
    const nodeIdSet = new Set(nodeIds);
    setRenderNodes((prev) => prev.filter((node) => !nodeIdSet.has(node.id)));
  }, []);

  return {
    renderNodes,
    beginRenderDragSession,
    endRenderDragSession,
    applyRenderPositionUpdates,
    removeRenderNodes,
  };
}
