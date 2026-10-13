import {
  type FitViewOptions,
  type Node,
} from "@xyflow/react";

import type { CanvasLayoutSnapshotNode } from "../../store/selectors";
import type {
  GraphNode,
  NodeGraphViewport,
} from "../../types";

export const EMPTY_NODEGRAPH_NODES: GraphNode[] = [];
export const EMPTY_LAYOUT_SNAPSHOT_NODES: CanvasLayoutSnapshotNode[] = [];
export const EMPTY_FLOW_NODES: Node[] = [];
export const EMPTY_NODE_ID_SET = new Set<string>();

export const ZOOM_LIMITS = { min: 0.125, max: 4 };
export const CANVAS_INTERACTION_DELAY_MS = 150;

/**
 * fitView 周围留白（ReactFlow Padding，单位 % 相对视口）。
 * 底部多留 35%：底部 PromptDock 浮层卡片常驻（对齐 原型 composer-wrap 语义），
 * 对称留白会把底部节点适配进被卡片遮挡的区域，故底部单侧加厚。
 */
export const FIT_VIEW_PADDING: NonNullable<FitViewOptions["padding"]> = {
  top: "20%",
  right: "20%",
  bottom: "35%",
  left: "20%",
};

const DEFAULT_VIEWPORT: NodeGraphViewport = { x: 0, y: 0, zoom: 1 };

export const normalizeViewport = (
  viewport: NodeGraphViewport | null | undefined,
): NodeGraphViewport => {
  const normalizedViewport =
    viewport !== null && viewport !== undefined ? viewport : DEFAULT_VIEWPORT;
  return {
    x:
      typeof normalizedViewport.x === "number"
        ? normalizedViewport.x
        : DEFAULT_VIEWPORT.x,
    y:
      typeof normalizedViewport.y === "number"
        ? normalizedViewport.y
        : DEFAULT_VIEWPORT.y,
    zoom:
      typeof normalizedViewport.zoom === "number"
        ? normalizedViewport.zoom
        : DEFAULT_VIEWPORT.zoom,
  };
};

export const isDefaultViewport = (viewport: NodeGraphViewport) => {
  const eps = 0.001;
  return (
    Math.abs(viewport.x - DEFAULT_VIEWPORT.x) < eps &&
    Math.abs(viewport.y - DEFAULT_VIEWPORT.y) < eps &&
    Math.abs(viewport.zoom - DEFAULT_VIEWPORT.zoom) < eps
  );
};

export const isSameIdSet = (next: string[], prev: string[]) => {
  if (next.length !== prev.length) return false;
  const prevSet = new Set(prev);
  for (const id of next) {
    if (!prevSet.has(id)) return false;
  }
  return true;
};
