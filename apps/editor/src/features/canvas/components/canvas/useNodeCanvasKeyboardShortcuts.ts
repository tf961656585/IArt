import { useEffect } from "react";
import { isEscapeEvent } from "@iart/ui";
import { toast } from "sonner";

import { restoreAgentEntryOnEscape } from "@/features/promptdock/agentEntry";
import type { CanvasStore } from "../../store/canvasStore";

type UseNodeCanvasKeyboardShortcutsArgs = {
  pendingPlacement: { characterId: string } | null;
  cancelPlacement: () => void;
  pendingAnnotationBinding: CanvasStore["pendingAnnotationBinding"];
  cancelAnnotationBinding: CanvasStore["cancelAnnotationBinding"];
  cancelMarquee: (() => void) | null;
  /** 清除画布选择（Esc 退一层的落点之一：无待还原快照时清除选择、焦点回画布） */
  clearCanvasSelection: () => void;
  /** 画布根容器（Esc 后把焦点交回画布） */
  canvasRef: { current: HTMLElement | null };
};

/**
 * 画布基底的 Esc 语义（spec docs/editor/浮层堆栈管理.md 核心规则 4「栈空透传」）。
 *
 * 本处理器是**栈空基底层**：任何浮层（弹窗、右栏、右键菜单、编辑态……）打开时都已
 * 经 `useOverlayLayer` 入栈，Esc 在分发器处就被消费（`preventDefault` +
 * `stopImmediatePropagation`），事件不会冒泡到这里；只有栈空时它才收到原始按键。
 * 因此这里既不注册入栈、也不再需要任何跨面让位约定（退役清单：`defaultPrevented`
 * 让位、「右栏打开即 return」均已删除）。Escape 键判定统一经 `isEscapeEvent`
 *（唯一判定 owner，含 IME 组合期让位）。
 */
export function useNodeCanvasKeyboardShortcuts({
  pendingPlacement,
  cancelPlacement,
  pendingAnnotationBinding,
  cancelAnnotationBinding,
  cancelMarquee,
  clearCanvasSelection,
  canvasRef,
}: UseNodeCanvasKeyboardShortcutsArgs) {
  useEffect(() => {
    if (!pendingPlacement) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEscapeEvent(event)) {
        cancelPlacement();
        toast.info("已取消放置角色");
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [cancelPlacement, pendingPlacement]);

  useEffect(() => {
    if (!pendingAnnotationBinding) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEscapeEvent(event)) {
        cancelAnnotationBinding();
        toast.info("已取消注释绑定");
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [cancelAnnotationBinding, pendingAnnotationBinding]);

  useEffect(() => {
    if (cancelMarquee === null || cancelMarquee === undefined) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEscapeEvent(event)) {
        cancelMarquee();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [cancelMarquee]);

  /**
   * Esc 退一层（spec docs/agent/06「键盘与焦点」、docs/agent/02「选中态工具栏」）：
   * 存在待还原快照（选中驱动进入且该会话尚未粘滞）→ 还原进入前的形态与绑定；
   * 否则清除画布选择并把焦点交回画布。
   *
   * 让位规则（一次按键只退一层）：
   * - 焦点在输入控件内 → 让给控件（与右栏、工具条同一键盘链口径）；
   * - 浮层让位交由分发器承担：栈非空时事件已被消费，本处理器收不到（核心规则 4）。
   */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isEscapeEvent(event)) return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
      }
      if (restoreAgentEntryOnEscape()) {
        event.preventDefault();
        return;
      }
      clearCanvasSelection();
      canvasRef.current?.focus();
    };
    // window：栈空时保留原有的最后一道冒泡位（画布基底的既有形态），
    // 栈非空时事件已在 document 捕获阶段被分发器截断，此处不会触发。
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [canvasRef, clearCanvasSelection]);
}
