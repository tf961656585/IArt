"use client";

/**
 * 画布定位请求事件监听（canvasLocateRequest.ts 事件桥的 React 侧端点）。
 *
 * 挂载在 ReactFlowProvider 内（CanvasRuntimeEffects），把模块侧的定位请求转调
 * 统一定位抽象 useLocateToNode——不绕过定位抽象、不直接操作 viewport。
 * 非法形状（缺 nodeId）静默忽略并留 debug；ReactFlow 实例不可用时 useLocateToNode
 * 自身按 no-op 处理（不抛错）。
 */

import { useEffect } from "react";

import { useLocateToNode } from "./useLocateToNode";
import {
  CANVAS_LOCATE_NODE_REQUEST_EVENT,
  type CanvasLocateNodeRequestDetail,
} from "../services/canvasLocateRequest";
import { logCanvasDebugEvent } from "../debug/canvasDebug";

export function useCanvasLocateRequestListener(): void {
  const locate = useLocateToNode();

  useEffect(() => {
    const handler = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as Partial<CanvasLocateNodeRequestDetail> | undefined;
      if (typeof detail?.nodeId !== "string" || detail.nodeId.length === 0) {
        logCanvasDebugEvent("locate-request:invalid-detail", { detail });
        return;
      }
      locate(detail.nodeId, detail.reason ?? "canvas-locate-request");
    };
    window.addEventListener(CANVAS_LOCATE_NODE_REQUEST_EVENT, handler);
    return () => {
      window.removeEventListener(CANVAS_LOCATE_NODE_REQUEST_EVENT, handler);
    };
  }, [locate]);
}