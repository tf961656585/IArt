"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { labelResizeObserverCallback } from "@/client/utils/resizeObserverDebugLabel";
import type { NodeSize } from "../../types/node";

const toStyleSizeKey = (
  value:
    | CSSProperties["width"]
    | CSSProperties["height"]
    | CSSProperties["minWidth"]
    | CSSProperties["minHeight"],
): string => {
  if (value === undefined || value === null) return "";
  return String(value);
};

export function useNodeCardGeometryKey(params: {
  nodeId: string | undefined;
  elementRef: React.RefObject<HTMLElement | null>;
  lastMeasuredRef: React.MutableRefObject<NodeSize | null>;
  width: CSSProperties["width"] | undefined;
  height: CSSProperties["height"] | undefined;
  minWidth: CSSProperties["minWidth"] | undefined;
  minHeight: CSSProperties["minHeight"] | undefined;
  scope: string;
}): string {
  const {
    nodeId,
    elementRef,
    lastMeasuredRef,
    width,
    height,
    minWidth,
    minHeight,
    scope,
  } = params;
  const [measuredGeometryKey, setMeasuredGeometryKey] = useState("");
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    const measure = () => {
      const rect = element.getBoundingClientRect();
      const nextWidth = Math.round(rect.width);
      const nextHeight = Math.round(rect.height);
      if (!Number.isFinite(nextWidth) || !Number.isFinite(nextHeight)) return;
      if (nextWidth <= 0 || nextHeight <= 0) return;
      lastMeasuredRef.current = { width: nextWidth, height: nextHeight };
      const nextKey = `${nextWidth}x${nextHeight}`;
      setMeasuredGeometryKey((prev) => (prev === nextKey ? prev : nextKey));
    };

    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(
      labelResizeObserverCallback(
        () => measure(),
        `${scopeRef.current}.geometry`,
      ),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [elementRef, lastMeasuredRef, nodeId, width, height, minWidth, minHeight]);

  return [
    toStyleSizeKey(width),
    toStyleSizeKey(height),
    toStyleSizeKey(minWidth),
    toStyleSizeKey(minHeight),
    measuredGeometryKey,
  ].join(":");
}
