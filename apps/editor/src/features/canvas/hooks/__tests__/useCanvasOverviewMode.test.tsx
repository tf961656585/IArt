import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCanvasOverviewMode } from '../useCanvasOverviewMode';

const flushEffects = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('useCanvasOverviewMode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('小图即使低缩放也不进入概览（自动策略）', async () => {
    const { result } = renderHook(() =>
      useCanvasOverviewMode({
        graphId: 'g1',
        zoom: 0.1,
        nodeCount: 50,
        policy: undefined,
      })
    );

    await act(async () => {
      await flushEffects();
    });

    expect(result.current.eligibleBySize).toBe(false);
    expect(result.current.isOverview).toBe(false);
    expect(result.current.preparingExit).toBe(false);
  });

  it('满足规模阈值且 zoom 低于 enterZoom 时进入概览', async () => {
    const { result } = renderHook(() =>
      useCanvasOverviewMode({
        graphId: 'g1',
        zoom: 0.1,
        nodeCount: 5000,
        policy: undefined,
      })
    );

    await act(async () => {
      await flushEffects();
    });

    expect(result.current.eligibleBySize).toBe(true);
    expect(result.current.isOverview).toBe(true);
  });

  it('阈值边界：zoom=0.2 可进入，zoom=0.24 在 moveEnd 后进入延迟退出', async () => {
    const { result, rerender } = renderHook(
      ({ zoom }) =>
        useCanvasOverviewMode({
          graphId: 'g1',
          zoom,
          nodeCount: 5000,
          policy: undefined,
        }),
      { initialProps: { zoom: 0.2 } }
    );

    await act(async () => {
      await flushEffects();
    });
    expect(result.current.isOverview).toBe(true);
    expect(result.current.preparingExit).toBe(false);

    await act(async () => {
      result.current.onMoveStart();
    });
    rerender({ zoom: 0.24 });
    await act(async () => {
      await flushEffects();
    });

    // move 中达到退出阈值，仍保持概览，且不立即进入准备退出。
    expect(result.current.isOverview).toBe(true);
    expect(result.current.preparingExit).toBe(false);

    await act(async () => {
      result.current.onMoveEnd();
    });
    expect(result.current.preparingExit).toBe(true);
  });

  it('退出概览仅在 moveEnd 后延迟触发，并在延迟窗口内暴露 preparingExit', async () => {
    const { result, rerender } = renderHook(
      ({ zoom }) =>
        useCanvasOverviewMode({
          graphId: 'g1',
          zoom,
          nodeCount: 5000,
          policy: undefined,
        }),
      { initialProps: { zoom: 0.1 } }
    );

    await act(async () => {
      await flushEffects();
    });
    expect(result.current.isOverview).toBe(true);

    await act(async () => {
      result.current.onMoveStart();
    });

    rerender({ zoom: 0.5 });
    await act(async () => {
      await flushEffects();
    });

    // move 中达到退出阈值，不应立即退出/准备退出
    expect(result.current.isOverview).toBe(true);
    expect(result.current.preparingExit).toBe(false);

    await act(async () => {
      result.current.onMoveEnd();
    });
    expect(result.current.preparingExit).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(result.current.policy.exitDelayMs);
      await flushEffects();
    });

    expect(result.current.preparingExit).toBe(false);
    expect(result.current.isOverview).toBe(false);
  });

  it('准备退出期间若 zoom 回落到 exitZoom 以下，会取消退出', async () => {
    const { result, rerender } = renderHook(
      ({ zoom }) =>
        useCanvasOverviewMode({
          graphId: 'g1',
          zoom,
          nodeCount: 5000,
          policy: undefined,
        }),
      { initialProps: { zoom: 0.1 } }
    );

    await act(async () => {
      await flushEffects();
    });
    expect(result.current.isOverview).toBe(true);

    rerender({ zoom: 0.5 });
    await act(async () => {
      await flushEffects();
    });

    // 未移动：达到退出阈值会进入 preparingExit
    expect(result.current.preparingExit).toBe(true);

    // 再缩回到 exitZoom 以下：取消退出
    rerender({ zoom: 0.1 });
    await act(async () => {
      await flushEffects();
    });
    expect(result.current.preparingExit).toBe(false);
    expect(result.current.isOverview).toBe(true);

    await act(async () => {
      vi.runOnlyPendingTimers();
      await flushEffects();
    });
    expect(result.current.isOverview).toBe(true);
  });

  it('graphId 变化会重置概览状态，避免跨画板串状态', async () => {
    const { result, rerender } = renderHook(
      ({ graphId, zoom }) =>
        useCanvasOverviewMode({
          graphId,
          zoom,
          nodeCount: 5000,
          policy: undefined,
        }),
      { initialProps: { graphId: 'g1', zoom: 0.1 } }
    );

    await act(async () => {
      await flushEffects();
    });
    expect(result.current.isOverview).toBe(true);

    // 先触发一次“准备退出”（制造待退出计时器），再切换画板验证不会串状态
    rerender({ graphId: 'g1', zoom: 0.5 });
    await act(async () => {
      await flushEffects();
    });
    expect(result.current.preparingExit).toBe(true);

    rerender({ graphId: 'g2', zoom: 0.1 });
    await act(async () => {
      await flushEffects();
    });

    // 新画板仍满足进入条件：允许重新进入概览，但必须清理掉上一张图的退出状态
    expect(result.current.isOverview).toBe(true);
    expect(result.current.preparingExit).toBe(false);

    await act(async () => {
      vi.runOnlyPendingTimers();
      await flushEffects();
    });
    expect(result.current.isOverview).toBe(true);
    expect(result.current.preparingExit).toBe(false);
  });
});
