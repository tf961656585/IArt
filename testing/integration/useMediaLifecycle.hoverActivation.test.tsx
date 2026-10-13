import React, { act, useLayoutEffect } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useMediaLifecycle } from '@/features/canvas/components/nodes/shared/useMediaLifecycle';
import { mediaLifecycleManager } from '@/features/canvas/services/mediaLifecycleManager';
import { enableReactActEnvironment } from './helpers/runtime-globals';

describe('useMediaLifecycle', () => {
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

  it('hover 触发早于 passive effects 时也能激活（避免 register 时序 race）', () => {
    vi.useFakeTimers();

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    let triggerHoverEnter: (() => void) | null = null;

    function App() {
      const { isActive, onHoverEnter } = useMediaLifecycle(
        'test:media-lifecycle',
        'file:///tmp/test.mp4',
        'video',
      );

      useLayoutEffect(() => {
        triggerHoverEnter = onHoverEnter;
      }, [onHoverEnter]);

      return <div data-testid="surface" data-active={isActive ? '1' : '0'} />;
    }

    act(() => {
      flushSync(() => {
        root.render(<App />);
      });
      triggerHoverEnter?.();
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
});
