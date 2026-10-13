import { useCallback, useEffect, useRef, useState } from "react";

import type { NodeSize } from "../../types";

type TransientDimensionCleanup = { kind: "raf" | "timeout"; id: number };

export function useNodeCanvasTransientState() {
  const [transientDimensions, setTransientDimensions] = useState<
    Record<string, NodeSize>
  >({});
  const transientDimensionsRef =
    useRef<Record<string, NodeSize>>(transientDimensions);
  const transientDimensionsCleanupRef = useRef<
    Map<string, TransientDimensionCleanup>
  >(new Map());

  useEffect(() => {
    transientDimensionsRef.current = transientDimensions;
  }, [transientDimensions]);

  const clearTransientDimensionsForNodeIds = useCallback(
    (nodeIds: string[]) => {
      if (!nodeIds.length) return;
      setTransientDimensions((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const nodeId of nodeIds) {
          if (!next[nodeId]) continue;
          delete next[nodeId];
          changed = true;
        }
        return changed ? next : prev;
      });
    },
    [],
  );

  const cancelTransientDimensionCleanup = useCallback((nodeId: string) => {
    const handle = transientDimensionsCleanupRef.current.get(nodeId);
    if (!handle) return;
    if (handle.kind === "raf") {
      cancelAnimationFrame(handle.id);
    } else {
      window.clearTimeout(handle.id);
    }
    transientDimensionsCleanupRef.current.delete(nodeId);
  }, []);

  const scheduleTransientDimensionCleanup = useCallback(
    (nodeId: string) => {
      cancelTransientDimensionCleanup(nodeId);
      const schedule = (
        cb: FrameRequestCallback,
      ): TransientDimensionCleanup => {
        if (typeof requestAnimationFrame === "function") {
          return { kind: "raf", id: requestAnimationFrame(cb) };
        }
        return {
          kind: "timeout",
          id: window.setTimeout(() => cb(performance.now()), 0),
        };
      };
      const handle = schedule(() => {
        transientDimensionsCleanupRef.current.delete(nodeId);
        setTransientDimensions((prev) => {
          if (!prev[nodeId]) return prev;
          const next = { ...prev };
          delete next[nodeId];
          return next;
        });
      });
      transientDimensionsCleanupRef.current.set(nodeId, handle);
    },
    [cancelTransientDimensionCleanup],
  );

  useEffect(
    () => () => {
      for (const [nodeId] of transientDimensionsCleanupRef.current) {
        cancelTransientDimensionCleanup(nodeId);
      }
    },
    [cancelTransientDimensionCleanup],
  );

  return {
    transientDimensions,
    setTransientDimensions,
    transientDimensionsRef,
    clearTransientDimensionsForNodeIds,
    cancelTransientDimensionCleanup,
    scheduleTransientDimensionCleanup,
  };
}
