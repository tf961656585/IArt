import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { PromptTextSurface, SelectionRange } from '../components/nodes/shared/promptTextSurface';

export type UsePromptTextEditorAutoFocusOnOpenParams = {
  open: boolean;
  editorRef: RefObject<PromptTextSurface | null>;
  initialSelection: SelectionRange | null | undefined;
  /**
   * 等待 editorRef 绑定的最大 rAF 次数。
   * 默认 6 帧：足够覆盖 Dialog/Portal 首次挂载的异步时序。
   */
  maxRafAttempts: number | undefined;
};

const clampIndex = (value: number, max: number) => Math.max(0, Math.min(max, value));

/**
 * Dialog 打开时自动 focus + 应用初始选区：
 * - 只在 open 周期内成功执行一次；不会因 value 变化反复重置光标。
 * - 若拿不到初始选区：fallback 到文本末尾。
 */
export const usePromptTextEditorAutoFocusOnOpen = ({
  open,
  editorRef,
  initialSelection,
  maxRafAttempts = 6,
}: UsePromptTextEditorAutoFocusOnOpenParams): { onOpenAutoFocus: (event: Event) => void } => {
  const latestRef = useRef({ initialSelection, maxRafAttempts });
  latestRef.current = { initialSelection, maxRafAttempts };

  const sessionRef = useRef(0);
  const appliedRef = useRef(false);
  const rafRef = useRef<number | null>(null);

  const cancelRaf = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const applyFocusAndSelection = useCallback((): boolean => {
    const surface = editorRef.current;
    if (!surface) return false;

    surface.focus();
    const currentValue = surface.getValue() ?? '';
    const length = currentValue.length;
    const selection = latestRef.current.initialSelection;
    const start = selection ? clampIndex(selection.start, length) : length;
    const end = selection ? clampIndex(selection.end, length) : length;
    surface.setSelectionRange(start, end);
    return true;
  }, [editorRef]);

  const scheduleOnce = useCallback(() => {
    if (appliedRef.current) return;
    if (typeof window === 'undefined') return;

    const session = sessionRef.current;
    let attempts = 0;

    const tick = () => {
      if (session !== sessionRef.current) return;
      if (appliedRef.current) return;

      attempts += 1;
      if (applyFocusAndSelection()) {
        appliedRef.current = true;
        cancelRaf();
        return;
      }

      if (attempts < latestRef.current.maxRafAttempts) {
        rafRef.current = window.requestAnimationFrame(tick);
      }
    };

    rafRef.current = window.requestAnimationFrame(tick);
  }, [applyFocusAndSelection, cancelRaf]);

  useEffect(() => {
    // open 变化视为一次新 session：只允许在本周期内执行一次。
    sessionRef.current += 1;
    appliedRef.current = false;
    cancelRaf();

    if (!open) return;
    scheduleOnce();
    return cancelRaf;
  }, [open, cancelRaf, scheduleOnce]);

  const onOpenAutoFocus = useCallback(
    (event: Event) => {
      event.preventDefault();
      scheduleOnce();
    },
    [scheduleOnce],
  );

  return { onOpenAutoFocus };
};
