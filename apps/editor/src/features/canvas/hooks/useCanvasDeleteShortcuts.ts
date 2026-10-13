import { useEffect } from "react";

import { useCanvasStore } from "../store/canvasStore";
import { isCanvasDeleteKey } from "../shortcuts/deleteKeys";
import { isEditableTarget } from "../shortcuts/isEditableTarget";

/**
 * 统一键盘 Delete/Backspace 处理 hook。
 * 替代 ReactFlow 内置 deleteKeyCode 和注释专用 Delete 监听。
 * 从 store 的 selectedXxxIds 读取选中状态并调用 deleteSelectedElements。
 */
export function useCanvasDeleteShortcuts(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isCanvasDeleteKey(event.key)) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      useCanvasStore.getState().deleteSelectedElements();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [enabled]);
}
