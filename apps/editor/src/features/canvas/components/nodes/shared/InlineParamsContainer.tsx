'use client';

import { memo, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useObservedElementMetrics } from '../../../hooks/useObservedElementMetrics';

export type InlineParamsSize = { width: number; height: number };

export const INLINE_PARAMS_MAX_WIDTH_PX = 448;

export const InlineParamsContainer = memo(function InlineParamsContainer({
  children,
  className,
  maxWidthPx = INLINE_PARAMS_MAX_WIDTH_PX,
  onSizeChange,
  readabilityMinWidthPx,
}: {
  children: ReactNode;
  className: string | undefined;
  maxWidthPx: number | undefined;
  onSizeChange: (size: InlineParamsSize) => void | undefined;
  readabilityMinWidthPx: number | undefined;
}) {
  const { ref, metrics } = useObservedElementMetrics<HTMLDivElement>({
    observeMutations: true,
    rafDebounce: true,
    // InlineParamsContainer 不在启动期 scope 内做漂移监控，默认始终启用观测。
    enabled: true,
  });
  const lastSizeRef = useRef<InlineParamsSize | null>(null);

  const resolvedMaxWidth = useMemo(() => {
    const n = Math.round(Number(maxWidthPx));
    return Number.isFinite(n) && n > 0 ? n : INLINE_PARAMS_MAX_WIDTH_PX;
  }, [maxWidthPx]);

  const resolvedReadabilityMinWidth = useMemo(() => {
    const n = Math.round(Number(readabilityMinWidthPx));
    if (!Number.isFinite(n) || n <= 0) {
      return null;
    }
    return Math.min(resolvedMaxWidth, n);
  }, [readabilityMinWidthPx, resolvedMaxWidth]);

  useEffect(() => {
    if (!onSizeChange) return;
    const measuredWidth = Math.max(
      metrics.width,
      metrics.scrollWidth,
      resolvedReadabilityMinWidth ?? 0,
    );
    const measuredHeight = Math.max(metrics.height, metrics.scrollHeight);
    const next: InlineParamsSize = {
      width: Math.max(0, Math.min(resolvedMaxWidth, Math.round(measuredWidth))),
      height: Math.max(0, Math.round(measuredHeight)),
    };
    const prev = lastSizeRef.current;
    if (prev && prev.width === next.width && prev.height === next.height) return;
    lastSizeRef.current = next;
    onSizeChange(next);
  }, [
    metrics.height,
    metrics.scrollHeight,
    metrics.scrollWidth,
    metrics.width,
    onSizeChange,
    resolvedMaxWidth,
    resolvedReadabilityMinWidth,
  ]);

  const style = useMemo(
    () => ({
      width: '100%',
      minWidth: 0,
      maxWidth: '100%',
    }),
    [],
  );

  return (
    <div
      ref={ref}
      data-iart-inline-params="true"
      className={cn('block w-full min-w-0 max-w-full overflow-hidden align-top', className)}
      style={style}
    >
      {children}
    </div>
  );
});

export default InlineParamsContainer;
