"use client";

import { useLayoutEffect } from "react";

import type { NodeSize } from "../../types/node";
import { useCanvasStore } from "../../store/canvasStore";
import { selectIsPlaceholderNode } from "../../store/selectors.base";
import { selectEffectiveSizeForPlaceholder } from "../../store/selectors.nodeSizeRuntime";

/**
 * 占位壳降级策略（spec：画布交互期渲染降级契约.md「占位壳契约」）。
 *
 * 返回值在两种身份下使用：
 * - isPlaceholder=true：渲染层用该尺寸作为 stableSize（minWidth/minHeight 占位），
 *   policy 强制 identity，children 子树不挂载。
 * - isPlaceholder=false：完整态，调用方走原 lastMeasuredRef 路径，policy 走原 selection 逻辑。
 *
 * 实现要点：
 * 1. isPlaceholder 走组件订阅 store，不写入 Flow node data，避免破坏 flowNodeMemoizer 引用稳定性。
 * 2. 占位壳尺寸来源是 resolveEffectiveSize 主优先级链（layoutModel > measured > default），
 *    不是组件的 lastMeasuredRef（那是 DOM 实测，新节点首次挂载为 null 会塌缩，违反 spec 禁止事项第 2 条）。
 *    measured 档数据源是 store 的会话态缓存 lastMeasuredSizeByNodeId。
 * 3. mount 时 useLayoutEffect 在 paint 前注册占位（若交互期），首帧即占位态，无"先完整后占位"闪烁。
 *    cleanup：节点卸载不主动移除占位标记（store 占位集合移除由升级调度器或 clearPlaceholderUpgrade 负责；
 *    卸载节点 id 残留无害——下次 moveEnd 时 scheduler 对已卸载 id 调 markNodesAsFull 是幂等的）。
 */
export type PlaceholderShellDegrade = {
  /** 当前是否处于占位壳形态。 */
  isPlaceholder: boolean;
  /**
   * 占位壳的 stableSize（resolveEffectiveSize 主优先级链）。仅在 isPlaceholder=true 时为非 null。
   * 调用方在占位态优先使用此值作为 stableSize；若为 null（极端情况 selector 返回 null）则回退 lastMeasuredRef。
   */
  placeholderStableSize: NodeSize | null;
};

/**
 * 占位壳降级 hook。封装：
 * - 订阅 isPlaceholder（单节点作用域）
 * - 订阅 placeholderStableSize（仅占位态，resolveEffectiveSize 主优先级链）
 * - mount 时 useLayoutEffect 注册占位（若交互期）
 *
 * 两个 Card 组件（BaseNodeCard / ContentNodeCard）共享此 hook，保证降级行为对称。
 */
export const usePlaceholderShellDegrade = (nodeId: string | undefined): PlaceholderShellDegrade => {
  const isPlaceholder = useCanvasStore((state) => (nodeId ? selectIsPlaceholderNode(nodeId)(state) : false));
  const placeholderStableSize = useCanvasStore((state) =>
    nodeId && isPlaceholder ? selectEffectiveSizeForPlaceholder(nodeId)(state) : null,
  );

  const markNodeAsPlaceholder = useCanvasStore((state) => state.markNodeAsPlaceholder);
  useLayoutEffect(() => {
    if (!nodeId) return;
    // 只读 isCanvasInteracting 当前值（getState 命令式，不订阅）：mount 只发生一次，
    // 交互态变化后已在视口内的节点不会重新 mount，无需响应式订阅。
    if (useCanvasStore.getState().isCanvasInteracting) {
      markNodeAsPlaceholder(nodeId);
    }
  }, [nodeId, markNodeAsPlaceholder]);

  return { isPlaceholder, placeholderStableSize };
};

/**
 * 把占位 stableSize（resolveEffectiveSize 主优先级链）与既有 lastMeasuredRef 合成最终 stableSize。
 *
 * 占位态优先用 placeholderStableSize（含 default 兜底），null 时回退 lastMeasured（防御）。
 * 非占位态（既有 selection identity）保持 lastMeasured 路径不变。
 */
export const resolveStableSizeWithPlaceholder = (params: {
  isPlaceholder: boolean;
  placeholderStableSize: NodeSize | null;
  lastMeasured: NodeSize | null;
  keepIdentitySize: boolean;
}): NodeSize | null => {
  if (!params.keepIdentitySize) return null;
  if (params.isPlaceholder) {
    return params.placeholderStableSize ?? params.lastMeasured;
  }
  return params.lastMeasured;
};

