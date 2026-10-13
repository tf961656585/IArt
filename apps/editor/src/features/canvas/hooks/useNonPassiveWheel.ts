import { useEffect, useRef, type RefObject } from 'react';

export type NonPassiveWheelHandler = (event: WheelEvent) => void;

export type UseNonPassiveWheelOptions = {
  enabled: boolean | undefined;
  capture: boolean | undefined;
  onWheel: NonPassiveWheelHandler;
};

export function useNonPassiveWheel<T extends HTMLElement>(
  ref: RefObject<T | null>,
  { enabled = true, capture = true, onWheel }: UseNonPassiveWheelOptions,
) {
  const onWheelRef = useRef(onWheel);

  useEffect(() => {
    onWheelRef.current = onWheel;
  }, [onWheel]);

  useEffect(() => {
    if (!enabled) return;

    // Some overlays (e.g. Radix Dialog via Portal/Presence) can mount the target element
    // asynchronously without re-rendering the component that owns this hook. Poll via rAF
    // until `ref.current` is available.
    let rafId: number | null = null;
    let attachedTarget: T | null = null;
    let handler: ((event: WheelEvent) => void) | null = null;

    const cleanup = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }

      if (attachedTarget && handler) {
        attachedTarget.removeEventListener('wheel', handler, { capture });
      }

      attachedTarget = null;
      handler = null;
    };

    const tryAttach = () => {
      const target = ref.current;
      if (!target) {
        rafId = requestAnimationFrame(tryAttach);
        return;
      }

      attachedTarget = target;
      handler = (event: WheelEvent) => {
        onWheelRef.current(event);
      };
      target.addEventListener('wheel', handler, { passive: false, capture });
    };

    tryAttach();
    return cleanup;
  }, [capture, enabled, ref]);
}
