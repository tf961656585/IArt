import React, { act, useLayoutEffect } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useDeferredHoverActivation } from '@/features/canvas/components/nodes/shared/useDeferredHoverActivation';
import { useMediaLifecycle } from '@/features/canvas/components/nodes/shared/useMediaLifecycle';
import { mediaLifecycleManager } from '@/features/canvas/services/mediaLifecycleManager';
import { enableReactActEnvironment } from './helpers/runtime-globals';

describe('useDeferredHoverActivation', () => {
  let restoreReactActEnvironment: (() => void) | undefined;

  beforeAll(() => {
    restoreReactActEnvironment = enableReactActEnvironment();
  });

  afterAll(() => {
    restoreReactActEnvironment?.();
  });

  afterEach(() => {
    mediaLifecycleManager.dispose();
    vi.useRealTimers();
  });

  it('replays hover activation when interaction ends and pointer is still hovered', () => {
    vi.useFakeTimers();

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    let triggerPointerEnter: (() => void) | null = null;

    function App({ isInteracting }: { isInteracting: boolean }) {
      const { isActive, onHoverEnter, onHoverLeave } = useMediaLifecycle(
        'test:deferred-hover',
        'file:///tmp/test.mp4',
        'video',
      );
      const { onPointerEnter } = useDeferredHoverActivation({
        isInteracting,
        onHoverEnter,
        onHoverLeave,
      });

      useLayoutEffect(() => {
        triggerPointerEnter = onPointerEnter;
      }, [onPointerEnter]);

      return <div data-testid="surface" data-active={isActive ? '1' : '0'} />;
    }

    act(() => {
      flushSync(() => {
        root.render(<App isInteracting />);
      });
      triggerPointerEnter?.();
    });

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(container.querySelector('[data-testid="surface"]')).toHaveAttribute('data-active', '0');

    act(() => {
      flushSync(() => {
        root.render(<App isInteracting={false} />);
      });
    });

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(container.querySelector('[data-testid="surface"]')).toHaveAttribute('data-active', '1');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('does not replay if pointer leaves before interaction ends', () => {
    vi.useFakeTimers();

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    let triggerPointerEnter: (() => void) | null = null;
    let triggerPointerLeave: (() => void) | null = null;

    function App({ isInteracting }: { isInteracting: boolean }) {
      const { isActive, onHoverEnter, onHoverLeave } = useMediaLifecycle(
        'test:deferred-hover-leave',
        'file:///tmp/test.mp4',
        'video',
      );
      const { onPointerEnter, onPointerLeave } = useDeferredHoverActivation({
        isInteracting,
        onHoverEnter,
        onHoverLeave,
      });

      useLayoutEffect(() => {
        triggerPointerEnter = onPointerEnter;
        triggerPointerLeave = onPointerLeave;
      }, [onPointerEnter, onPointerLeave]);

      return <div data-testid="surface" data-active={isActive ? '1' : '0'} />;
    }

    act(() => {
      flushSync(() => {
        root.render(<App isInteracting />);
      });
      triggerPointerEnter?.();
      triggerPointerLeave?.();
    });

    act(() => {
      flushSync(() => {
        root.render(<App isInteracting={false} />);
      });
    });

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(container.querySelector('[data-testid="surface"]')).toHaveAttribute('data-active', '0');

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
