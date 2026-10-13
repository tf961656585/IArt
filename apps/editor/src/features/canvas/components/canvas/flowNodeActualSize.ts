"use client";

import { useInternalNode, type InternalNode, type Node } from "@xyflow/react";
import type { NodeSize } from "../../types";
import { useCanvasStore } from "../../store/canvasStore";
import {
  isStartupPhaseForDesired,
  selectPreparationPhase,
} from "../../store/selectors";

type FlowNodeSizeLike = Pick<Node, "width" | "height" | "measured"> | Pick<InternalNode, "width" | "height" | "measured">;

const normalizeSize = (
  width: number | undefined,
  height: number | undefined,
): NodeSize | null => {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  const nextWidth = Math.round(Number(width));
  const nextHeight = Math.round(Number(height));
  if (nextWidth <= 0 || nextHeight <= 0) return null;
  return { width: nextWidth, height: nextHeight };
};

export const readFlowNodeActualSize = (
  node: FlowNodeSizeLike | null | undefined,
): NodeSize | null => {
  if (!node) return null;
  const measured = node.measured;
  const measuredSize = normalizeSize(
    measured !== null && measured !== undefined ? measured.width : undefined,
    measured !== null && measured !== undefined ? measured.height : undefined,
  );
  if (measuredSize) return measuredSize;
  return normalizeSize(node.width, node.height);
};

/**
 * ReactFlow 实测尺寸指纹（字符串）。
 *
 * 用途：作为实测投影的**显式失效信号**。
 *
 * xyflow v12 的 `nodeLookup` 是同一 Map 实例被原地更新——`updateNodeInternals` 只做
 * `set({})` 触发订阅，既不替换 `nodeLookup` 引用，条目也是原地改写。因此把 `nodeLookup`
 * 直接当作 `useMemo` 依赖时，节点实测收敛不会让 memo 失效，实测投影会冻结在首帧结果
 *（可能是空映射），布局消费方（全局整理 / 容器内整理）便拿不到任何真实尺寸。
 *
 * 指纹按 `readFlowNodeActualSize` 的口径读取每点尺寸：任一点读数变化即换值，
 * 仅位置/选中态等无关变化不换值。字符串按值比较，未变化时不会触发重渲染。
 */
export const buildFlowMeasuredFingerprint = (
  nodeLookup: ReadonlyMap<string, FlowNodeSizeLike> | null | undefined,
): string => {
  if (nodeLookup === null || nodeLookup === undefined) return '';
  let fingerprint = '';
  for (const [nodeId, node] of nodeLookup) {
    const size = readFlowNodeActualSize(node);
    if (size === null) continue;
    fingerprint += `${nodeId}:${size.width}x${size.height};`;
  }
  return fingerprint;
};

/**
 * ReactFlow store 选择器：取 `nodeLookup` 后产出实测指纹。
 *
 * 必须保留这一层取值——直接把 `buildFlowMeasuredFingerprint` 交给 store 选择器位置时，
 * 收到的是整个 store state 而不是 `nodeLookup`。
 */
export const selectFlowMeasuredFingerprint = (state: {
  nodeLookup: ReadonlyMap<string, FlowNodeSizeLike> | null | undefined;
}): string => buildFlowMeasuredFingerprint(state.nodeLookup);

/**
 * 读取单个节点的 ReactFlow DOM 实测尺寸。
 *
 * 启动期零反馈环（spec：画布启动性能与Layout-Model架构.md 禁止事项第 1 条）：
 * 当 preparationPhase 处于 loading-project / connecting-sync / waiting-interactive
 * 时，本 hook 返回稳定的 null，避免订阅 useInternalNode（防止启动期 ReactFlow
 * 频繁触发的 measured 变更重渲染节点）。runtime (ready) 后才真正订阅。
 *
 * useCanvasStore 在顶层无条件调用（Hook 顺序契约）。
 * useInternalNode 在 try/catch 内调用：测试 @xyflow/react 部分 mock 缺失时调用
 * undefined 会抛错，由 catch 兜底返回 null（保持原行为）。
 */
export const useFlowNodeActualSize = (nodeId: string): NodeSize | null => {
  const preparationPhase = useCanvasStore(selectPreparationPhase);
  try {
    const internalNode = useInternalNode(nodeId);
    if (isStartupPhaseForDesired(preparationPhase)) {
      return null;
    }
    return readFlowNodeActualSize(internalNode);
  } catch {
    return null;
  }
};
