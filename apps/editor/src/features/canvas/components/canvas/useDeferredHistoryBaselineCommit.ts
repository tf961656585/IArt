"use client";

import { useEffect } from "react";

export function useDeferredHistoryBaselineCommit(
  nodeGraphId: string | null,
  commitDeferredHistoryBaseline: () => void,
) {
  useEffect(() => {
    if (!nodeGraphId) return undefined;
    let cancelled = false;
    let timeoutId: number | null = null;
    const commit = () => {
      if (cancelled) return;
      commitDeferredHistoryBaseline();
    };
    if (
      typeof window !== "undefined" &&
      typeof window.requestIdleCallback === "function"
    ) {
      const idleId = window.requestIdleCallback(commit, { timeout: 1200 });
      return () => {
        cancelled = true;
        if (window.cancelIdleCallback !== null && window.cancelIdleCallback !== undefined) {
          window.cancelIdleCallback(idleId);
        }
      };
    }
    timeoutId = window.setTimeout(commit, 200);
    return () => {
      cancelled = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [commitDeferredHistoryBaseline, nodeGraphId]);
}
