"use client";

import type { InternalNode } from "@xyflow/react";
import type { CanvasLayoutSnapshotNode } from "../../store/selectors";
import type { DesiredSize, NodeSize } from "../../types";
import { mergeFlowNodeSizeByNodeId } from "./nodeCanvasFlowProjection";
import { readFlowNodeActualSize } from "./flowNodeActualSize";

type FlowNodeLookupLike = {
  get: (nodeId: string) => InternalNode | undefined;
};

const isFlowNodeLookupLike = (
  value: FlowNodeLookupLike | ReadonlyMap<string, InternalNode> | null | undefined,
): value is FlowNodeLookupLike => {
  if (!value || typeof value !== "object") return false;
  return typeof value.get === "function";
};

export const buildActualSizeByNodeId = (
  nodeLookup: ReadonlyMap<string, InternalNode> | FlowNodeLookupLike | null | undefined,
  nodes: ReadonlyArray<CanvasLayoutSnapshotNode>,
): Record<string, NodeSize> => {
  const next: Record<string, NodeSize> = {};
  if (!isFlowNodeLookupLike(nodeLookup)) return next;
  for (const snapshot of nodes) {
    const internalNode = nodeLookup.get(snapshot.id);
    const actualSize = readFlowNodeActualSize(internalNode);
    if (actualSize) {
      next[snapshot.id] = actualSize;
    }
  }
  return next;
};

/**
 * 构建投影尺寸 map（spec：画布启动性能与Layout-Model架构.md Layout-Model-Driven 投影链）。
 *
 * Layout-Model-Driven 范式下，节点尺寸的优先级链：
 *   layoutModel > measured > desired(accepted only, runtime drift fallback) > default
 *
 * - layoutModelByNodeId[nodeId] 存在 → 主路径直接采用（启动期与 runtime 期单一事实源）。
 * - measured（actualSize）可用 → 采用 measured（ReactFlow DOM 实测，runtime 期主路径）。
 * - desired 处于 accepted 态 → runtime 期漂移校准的兜底回退；
 *   pending 态 desired 不再驱动投影（启动期零反馈环，spec 禁止事项第 1 条）。
 * - 以上均无 → fallback（注册表 defaultSize）。
 *
 * 拖拽/resize 临时尺寸（transientDimensions）最终覆盖。
 */
export const buildProjectionSizeByNodeId = (params: {
  actualSizeByNodeId: Readonly<Record<string, NodeSize>>;
  desiredSizeByNodeId: Readonly<Record<string, DesiredSize>>;
  fallbackSizeByNodeId: Readonly<Record<string, NodeSize>>;
  layoutModelByNodeId: Readonly<Record<string, NodeSize>>;
  nodes: ReadonlyArray<CanvasLayoutSnapshotNode>;
  transientDimensions: Readonly<Record<string, NodeSize>>;
}): Record<string, NodeSize> => {
  const {
    actualSizeByNodeId,
    desiredSizeByNodeId,
    fallbackSizeByNodeId,
    layoutModelByNodeId,
    nodes,
    transientDimensions,
  } = params;
  const next: Record<string, NodeSize> = {};

  for (const snapshot of nodes) {
    const nodeId = snapshot.id;
    const layoutModelSize = layoutModelByNodeId[nodeId];
    const desired = desiredSizeByNodeId[nodeId];
    const actualSize = actualSizeByNodeId[nodeId];
    const fallbackSize = fallbackSizeByNodeId[nodeId];

    // 主路径：Layout Model 是节点尺寸的唯一业务事实源（启动期与 runtime 期同源）。
    if (layoutModelSize) {
      next[nodeId] = layoutModelSize;
      continue;
    }

    // measured（actualSize）可用 → 让位 measured（DOM 实测，避免与实际渲染漂移）。
    if (actualSize) {
      next[nodeId] = actualSize;
      continue;
    }

    // runtime 漂移兜底：accepted desired 提供 desired.size 作为 size-of-record；
    // pending 态 desired 不再驱动投影（启动期零反馈环，spec 禁止事项第 1 条）。
    if (desired && desired.state === "accepted") {
      next[nodeId] = desired.size;
    } else if (fallbackSize) {
      next[nodeId] = fallbackSize;
    }
  }

  return mergeFlowNodeSizeByNodeId(next, transientDimensions);
};
