"use client";

import React from "react";
import type { MarqueeScreenState } from "./useMarqueeSelection";

// 框选矩形画在画布容器原生层（ReactFlow 之外），与注释覆盖层同属
// canvas-overlay 海拔（z-canvas-overlay=30，见 elevation.css）。
const MARQUEE_Z_INDEX = 30;

interface MarqueeSelectionOverlayProps {
  marqueeState: MarqueeScreenState;
}

export function MarqueeSelectionOverlay({ marqueeState }: MarqueeSelectionOverlayProps) {
  if (!marqueeState.isActive) {
    return null;
  }

  const left = Math.min(marqueeState.startScreenX, marqueeState.currentScreenX);
  const top = Math.min(marqueeState.startScreenY, marqueeState.currentScreenY);
  const width = Math.abs(marqueeState.currentScreenX - marqueeState.startScreenX);
  const height = Math.abs(marqueeState.currentScreenY - marqueeState.startScreenY);

  return (
    <div
      style={{
        position: "absolute",
        pointerEvents: "none",
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
        background: "rgba(59, 130, 246, 0.1)",
        border: "1px solid rgba(59, 130, 246, 0.5)",
        borderRadius: "2px",
        zIndex: MARQUEE_Z_INDEX,
      }}
    />
  );
}
