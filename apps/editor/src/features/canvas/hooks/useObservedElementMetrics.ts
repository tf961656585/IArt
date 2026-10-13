'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { labelResizeObserverCallback } from '@/client/utils/resizeObserverDebugLabel';

export type ObservedElementMetrics = {
  width: number;
  height: number;
  scrollWidth: number;
  scrollHeight: number;
};

export type ObservedElementMetricsOptions = {
  /**
   * 观测 DOM 变更以捕获“内容高度变化但 border-box 不变”的场景（如 absolute slot + 固定高度容器）。
   * - 默认 true：用于表单显隐/展开收起、错误提示等变化。
   */
  observeMutations: boolean | undefined;
  /**
   * 是否用 requestAnimationFrame 合并多次触发（默认 true）。
   * - 降噪，避免 ResizeObserver/MutationObserver 高频回调导致 setState 震荡。
   */
  rafDebounce: boolean | undefined;
  /**
   * 是否启用观测（默认 true）。
   * - false：不挂 ResizeObserver / MutationObserver，返回稳定 empty metrics。
   *   用于启动期禁用 form MO（spec：画布启动性能与Layout-Model架构.md 启动期禁用 form MO）。
   * - true：现有行为（含 RO + MO）。
   */
  enabled: boolean | undefined;
};

export type ObservedElementMetricsState = {
  metrics: ObservedElementMetrics;
  revision: number;
};

const EMPTY_METRICS: ObservedElementMetrics = { width: 0, height: 0, scrollWidth: 0, scrollHeight: 0 };

const isSameMetrics = (a: ObservedElementMetrics, b: ObservedElementMetrics): boolean => {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.scrollWidth === b.scrollWidth &&
    a.scrollHeight === b.scrollHeight
  );
};

const scheduleWithRaf = (cb: () => void): number => {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(() => cb());
  return window.setTimeout(cb, 0) as number;
};

const cancelScheduled = (id: number | null) => {
  if (id === null) return;
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(id);
  }
  window.clearTimeout(id);
};

const isResizeObserverSize = (value: unknown): value is ResizeObserverSize => {
  if (!value || typeof value !== 'object') return false;
  const size = value as { inlineSize: unknown | undefined; blockSize: unknown | undefined };
  return typeof size.inlineSize === 'number' && typeof size.blockSize === 'number';
};

const getFirstResizeObserverSize = (
  borderBoxSize: ResizeObserverEntry['borderBoxSize'] | undefined,
): ResizeObserverSize | undefined => {
  if (Array.isArray(borderBoxSize)) {
    const sizes = borderBoxSize as readonly unknown[];
    const first = sizes[0];
    return isResizeObserverSize(first) ? first : undefined;
  }
  return isResizeObserverSize(borderBoxSize) ? borderBoxSize : undefined;
};

/**
 * 观测某个 HTMLElement 的尺寸与内容滚动尺寸（scrollHeight/scrollWidth）。
 *
 * 关键特性：
 * - callback ref：当元素在 React 树中“移动/重挂载”（例如 0→1 results 切换导致 slot 重渲染）时自动解绑/重绑 observer
 * - MutationObserver：捕获“内容变化但 box 不变”的场景（否则 RO 不会触发）
 */
export function useObservedElementMetrics<T extends HTMLElement>(
  options: ObservedElementMetricsOptions | undefined,
): {
  ref: (el: T | null) => void;
  metrics: ObservedElementMetrics;
  revision: number;
} {
  const observeMutations = (options !== null && options !== undefined ? options.observeMutations : undefined) !== false;
  const rafDebounce = (options !== null && options !== undefined ? options.rafDebounce : undefined) !== false;
  // enabled 默认 true；显式 false 时跳过 RO/MO 挂载（启动期禁用 form MO）。
  const enabled = (options !== null && options !== undefined ? options.enabled : undefined) !== false;

  const elementRef = useRef<T | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const moRef = useRef<MutationObserver | null>(null);
  const pendingMeasureRef = useRef<number | null>(null);
  const lastBorderBoxRef = useRef<{ width: number; height: number } | null>(null);

  const [state, setState] = useState<ObservedElementMetricsState>({
    metrics: EMPTY_METRICS,
    revision: 0,
  });

  const cleanupObservers = useCallback(() => {
    if (roRef.current) {
      roRef.current.disconnect();
      roRef.current = null;
    }
    if (moRef.current) {
      moRef.current.disconnect();
      moRef.current = null;
    }
  }, []);

  const cancelPendingMeasure = useCallback(() => {
    if (pendingMeasureRef.current !== null) {
      cancelScheduled(pendingMeasureRef.current);
      pendingMeasureRef.current = null;
    }
  }, []);

  const measureNow = useCallback(() => {
    const el = elementRef.current;
    if (!el) return;

    const fallbackRect = el.getBoundingClientRect();
    const borderBox = lastBorderBoxRef.current;
    const width = Math.max(0, Math.round(Number((borderBox !== null && borderBox !== undefined ? borderBox.width : undefined) ?? fallbackRect.width) || 0));
    const height = Math.max(0, Math.round(Number((borderBox !== null && borderBox !== undefined ? borderBox.height : undefined) ?? fallbackRect.height) || 0));
    const scrollWidth = Math.max(0, Math.round(Number(el.scrollWidth) || 0));
    const scrollHeight = Math.max(0, Math.round(Number(el.scrollHeight) || 0));

    const next: ObservedElementMetrics = { width, height, scrollWidth, scrollHeight };

    setState((prev) => {
      if (isSameMetrics(prev.metrics, next)) return prev;
      return { metrics: next, revision: prev.revision + 1 };
    });
  }, []);

  const scheduleMeasure = useCallback(() => {
    cancelPendingMeasure();
    if (!rafDebounce) {
      measureNow();
      return;
    }
    pendingMeasureRef.current = scheduleWithRaf(() => {
      pendingMeasureRef.current = null;
      measureNow();
    });
  }, [cancelPendingMeasure, measureNow, rafDebounce]);

  useEffect(() => {
    return () => {
      cancelPendingMeasure();
      cleanupObservers();
      elementRef.current = null;
    };
  }, [cancelPendingMeasure, cleanupObservers]);

  const ref = useCallback(
    (el: T | null) => {
      if (elementRef.current === el) return;

      cancelPendingMeasure();
      cleanupObservers();
      elementRef.current = el;
      lastBorderBoxRef.current = null;

      if (!el) return;

      // enabled === false：跳过 RO/MO 挂载，保持稳定 empty metrics
      // （spec：画布启动性能与Layout-Model架构.md 启动期禁用 form MO）。
      if (!enabled) return;

      // 初次测量 + 下一帧再测一次：覆盖“属性刚挂上/scrollHeight 稍后可读”的场景。
      measureNow();
      scheduleMeasure();

      if (typeof ResizeObserver !== 'undefined') {
        roRef.current = new ResizeObserver(
          labelResizeObserverCallback((entries) => {
            const entry = (entries !== null && entries !== undefined ? entries[0] : undefined);
            const box = getFirstResizeObserverSize((entry !== null && entry !== undefined ? entry.borderBoxSize : undefined));
            const nextWidth = Number((box !== null && box !== undefined ? box.inlineSize : undefined));
            const nextHeight = Number((box !== null && box !== undefined ? box.blockSize : undefined));
            if (Number.isFinite(nextWidth) && Number.isFinite(nextHeight)) {
              lastBorderBoxRef.current = { width: nextWidth, height: nextHeight };
            } else {
              lastBorderBoxRef.current = null;
            }
            scheduleMeasure();
          }, 'useObservedElementMetrics.element'),
        );
        roRef.current.observe(el);
        // observe() 之后立即测一次：覆盖“测试环境/某些实现不触发初始回调”的场景。
        measureNow();
      }

      if (observeMutations && typeof MutationObserver !== 'undefined') {
        moRef.current = new MutationObserver(() => scheduleMeasure());
        // spec：MutationObserver scope tightened —— 仅监听直接子节点增删，
        // 不再 attributes/characterData/subtree，避免启动期/运行期高频回调。
        moRef.current.observe(el, {
          subtree: false,
          childList: true,
          attributes: false,
          characterData: false,
        });
      }
    },
    [cancelPendingMeasure, cleanupObservers, enabled, measureNow, observeMutations, scheduleMeasure],
  );

  return { ref, metrics: state.metrics, revision: state.revision };
}
