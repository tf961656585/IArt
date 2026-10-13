import { act, renderHook } from '@testing-library/react';
import type { RefObject } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { cast } from '@/lib/utils';
import { useNonPassiveWheel } from '../useNonPassiveWheel';

describe('useNonPassiveWheel', () => {
  it('attaches when ref becomes available later (without rerender)', () => {
    type RafCallback = (time: number) => void;
    let rafCallback: RafCallback | null = null;
    let rafId = 0;

    const requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallback = cb as RafCallback;
      rafId += 1;
      return rafId;
    });
    const cancelAnimationFrameSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
      // noop
    });

    const element = document.createElement('div');
    const addSpy = vi.spyOn(element, 'addEventListener');

    const onWheel = vi.fn();
    const ref = cast<RefObject<HTMLDivElement | null>>({ current: null });
    renderHook(() =>
      useNonPassiveWheel(ref, {
        enabled: true,
        capture: true,
        onWheel,
      }),
    );

    // Simulate Radix Presence mounting later without triggering rerender in the owner component.
    ref.current = element;

    expect(requestAnimationFrameSpy).toHaveBeenCalled();
    expect(rafCallback).toBeTypeOf('function');
    const cb = rafCallback as never;
    if (typeof cb === 'function') {
      (cb as (time: number) => void)(0);
    }
    expect(addSpy).toHaveBeenCalledWith(
      'wheel',
      expect.any(Function),
      expect.objectContaining({ passive: false }),
    );

    requestAnimationFrameSpy.mockRestore();
    cancelAnimationFrameSpy.mockRestore();
  });

  it('registers a non-passive wheel listener and cleans up', () => {
    const element = document.createElement('div');
    const addSpy = vi.spyOn(element, 'addEventListener');
    const removeSpy = vi.spyOn(element, 'removeEventListener');

    const onWheel = vi.fn();
    const ref = cast<RefObject<HTMLDivElement | null>>({ current: element });

    const { unmount } = renderHook(() =>
      useNonPassiveWheel(ref, {
        enabled: true,
        capture: true,
        onWheel,
      }),
    );

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(addSpy).toHaveBeenCalledWith(
      'wheel',
      expect.any(Function),
      expect.objectContaining({ passive: false }),
    );

    const handler = cast<EventListener>(addSpy.mock.calls[0]?.[1]);
    const options = addSpy.mock.calls[0]?.[2] as AddEventListenerOptions;
    expect(typeof handler).toBe('function');
    expect(options).toEqual(expect.objectContaining({ capture: true, passive: false }));

    const event = new WheelEvent('wheel', { deltaY: 1, cancelable: true });
    element.dispatchEvent(event);
    expect(onWheel).toHaveBeenCalledTimes(1);
    expect(onWheel).toHaveBeenCalledWith(event);

    unmount();

    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith(
      'wheel',
      handler,
      expect.objectContaining({ capture: true }),
    );
  });

  it('does not register when disabled', () => {
    const element = document.createElement('div');
    const addSpy = vi.spyOn(element, 'addEventListener');

    const onWheel = vi.fn();
    const ref = cast<RefObject<HTMLDivElement | null>>({ current: element });

    renderHook(() =>
      useNonPassiveWheel(ref, {
        enabled: false,
        capture: true,
        onWheel,
      }),
    );
    expect(addSpy).not.toHaveBeenCalled();
  });

  it('removes listener when disabled', async () => {
    const element = document.createElement('div');
    const addSpy = vi.spyOn(element, 'addEventListener');
    const removeSpy = vi.spyOn(element, 'removeEventListener');

    const onWheel = vi.fn();
    const ref = cast<RefObject<HTMLDivElement | null>>({ current: element });

    const { rerender } = renderHook(
      ({ enabled }) =>
        useNonPassiveWheel(ref, {
          enabled,
          capture: true,
          onWheel,
        }),
      { initialProps: { enabled: true } },
    );

    const handler = cast<EventListener>(addSpy.mock.calls[0]?.[1]);

    await act(async () => {
      rerender({ enabled: false });
    });

    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith(
      'wheel',
      handler,
      expect.objectContaining({ capture: true }),
    );
  });
});
