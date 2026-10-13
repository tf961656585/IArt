import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useCanvasStartupGate } from '../useCanvasStartupGate';

describe('useCanvasStartupGate', () => {
  it('只有当前 editor 会话自己接到匹配的 ready 回报时才放行', () => {
    type HookProps = { graphId: string | null; sessionToken: string | null };
    const { result, rerender } = renderHook<ReturnType<typeof useCanvasStartupGate>, HookProps>(
      ({ graphId, sessionToken }: HookProps) => useCanvasStartupGate(graphId, sessionToken),
      {
        initialProps: {
          graphId: 'graph-a',
          sessionToken: 'session-a',
        },
      }
    );

    expect(result.current.startupReady).toBe(false);

    act(() => {
      expect(result.current.reportStartupInteractiveReady('graph-b', 'session-a')).toBe(false);
    });
    expect(result.current.startupReady).toBe(false);

    act(() => {
      expect(result.current.reportStartupInteractiveReady('graph-a', 'session-b')).toBe(false);
    });
    expect(result.current.startupReady).toBe(false);

    act(() => {
      expect(result.current.reportStartupInteractiveReady('graph-a', 'session-a')).toBe(true);
    });
    expect(result.current.startupReady).toBe(true);

    rerender({ graphId: 'graph-b', sessionToken: 'session-a' });
    expect(result.current.startupReady).toBe(false);
  });

  it('clearNodeGraph、缺 token、旧 token 都会把当前放行打回阻塞态', () => {
    type HookProps = { graphId: string | null; sessionToken: string | null };
    const { result, rerender } = renderHook<ReturnType<typeof useCanvasStartupGate>, HookProps>(
      ({ graphId, sessionToken }: HookProps) => useCanvasStartupGate(graphId, sessionToken),
      {
        initialProps: {
          graphId: 'graph-clear',
          sessionToken: 'session-current',
        },
      }
    );

    act(() => {
      expect(result.current.reportStartupInteractiveReady('graph-clear', 'session-current')).toBe(true);
    });
    expect(result.current.startupReady).toBe(true);

    rerender({ graphId: null, sessionToken: 'session-current' });
    expect(result.current.startupReady).toBe(false);

    rerender({ graphId: 'graph-clear', sessionToken: null });
    expect(result.current.startupReady).toBe(false);

    rerender({ graphId: 'graph-clear', sessionToken: 'session-next' });
    expect(result.current.startupReady).toBe(false);

    act(() => {
      expect(result.current.reportStartupInteractiveReady('graph-clear', 'session-current')).toBe(false);
    });
    expect(result.current.startupReady).toBe(false);

    act(() => {
      expect(result.current.reportStartupInteractiveReady('graph-clear', 'session-next')).toBe(true);
    });
    expect(result.current.startupReady).toBe(true);
  });
});
