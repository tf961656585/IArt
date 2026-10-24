"use client";

/**
 * 画布视口读取入口（组件级，供容器节点消费）。
 *
 * 拆成两个独立 hook，避免平移（transform.y 变化）导致所有容器节点逐帧重渲染：
 * - `useCanvasZoom`：只订阅 zoom（primitive selector），用于屏幕空间尺寸判定
 *   （LOD 降级、hairline 1/zoom、屏幕恒定握把尺寸反算）；
 * - `useContainerGripPlacement`：把「视口 y + 节点绝对 y × zoom < 握把命中高」压成
 *   `'inside' | 'above'` 的 primitive selector，只在翻转时触发重渲染。
 *
 * 回落语义（沿用 useOptionalReactFlow / 原 useCanvasZoom 先例）：React Flow 内部 store
 * 只在 ReactFlowProvider 祖先内可用；组件级测试裸渲染时按 try/catch 回落到画布 store 的
 * viewport（等值读取，非响应式——测试环境视口静止）。catch 内不调用 Hook
 * （rules-of-hooks），回落经 getState 读取。
 */

import { useStore as useReactFlowStore } from "@xyflow/react";
import {
  CONTAINER_GRIP_HIT_SCREEN_SIZE,
  type ContainerGripPlacement,
} from "../services/groupGeometry";
import { useCanvasStore } from "../store/canvasStore";

/** 画布 zoom（primitive selector：只在缩放时重渲染）。 */
export const useCanvasZoom = (): number => {
  try {
    return useReactFlowStore((state) => state.transform[2]);
  } catch {
    return useCanvasStore.getState().nodeGraph?.viewport?.zoom ?? 1;
  }
};

/**
 * 握把放置：节点顶边（视口 y + 绝对 y × zoom）进入握把命中高时翻转为框内首行。
 * primitive selector 只在 'above' ↔ 'inside' 变化时重渲染，平移不触发。
 */
export const useContainerGripPlacement = (
  positionAbsoluteY: number,
): ContainerGripPlacement => {
  try {
    return useReactFlowStore((state) =>
      state.transform[1] + positionAbsoluteY * state.transform[2] <
      CONTAINER_GRIP_HIT_SCREEN_SIZE
        ? "inside"
        : "above",
    );
  } catch {
    const viewport = useCanvasStore.getState().nodeGraph?.viewport;
    const zoom = viewport?.zoom ?? 1;
    const viewportY = viewport?.y ?? 0;
    return viewportY + positionAbsoluteY * zoom < CONTAINER_GRIP_HIT_SCREEN_SIZE
      ? "inside"
      : "above";
  }
};
