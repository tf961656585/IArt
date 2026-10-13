'use client';

import { useMemo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

export type TaskProgressOverlayStatus = 'idle' | 'running' | 'success' | 'error' | 'cancelled';

export type TaskProgressOverlayProps = {
  visible: boolean;
  status: TaskProgressOverlayStatus;
  title: string;
  detailText: string | null | undefined;
  progressPercent: number | null | undefined;
  elapsedMs: number;
  errorMessage: string | null | undefined;
  hideLabel: string | undefined;
  cancelLabel: string | undefined;
  canCancel: boolean | undefined;
  onHide: () => void;
  onCancel: () => void;
  extra: ReactNode | undefined;
};

const formatElapsed = (elapsedMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) {
    return `${seconds} 秒`;
  }
  return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`;
};

const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

export function TaskProgressOverlay({
  visible,
  status,
  title,
  detailText,
  progressPercent,
  elapsedMs,
  errorMessage,
  hideLabel,
  cancelLabel,
  canCancel,
  onHide,
  onCancel,
  extra,
}: TaskProgressOverlayProps) {
  const clamped = useMemo(() => {
    if (status === 'success') return 100;
    if (typeof progressPercent === 'number') return clampPercent(progressPercent);
    return 0;
  }, [progressPercent, status]);

  if (!visible) return null;

  return (
    <div className="absolute right-4 top-4 z-feedback pointer-events-none">
      <div
        className={cn(
          'pointer-events-auto w-[280px] rounded-lg border border-border/60 bg-background/95 shadow-lg backdrop-blur',
          'animate-in fade-in-0 zoom-in-95'
        )}
      >
        <div className="flex items-start justify-between gap-3 px-3 pt-3">
          <div>
            <div className="text-sm font-semibold text-foreground">{title}</div>
            {detailText && <div className="mt-1 text-xs text-muted-foreground">{detailText}</div>}
          </div>
          <Button variant="ghost" size="2xs" onClick={onHide}>
            {hideLabel ?? '隐藏'}
          </Button>
        </div>
        <div className="px-3 pb-3">
          <Progress value={clamped} className="mt-2" />
          <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>耗时 {formatElapsed(elapsedMs)}</span>
            {canCancel && status === 'running' && (
              <Button
                variant="destructive"
                size="2xs"
                onClick={onCancel}
              >
                {cancelLabel ?? '取消'}
              </Button>
            )}
          </div>
          {status === 'error' && errorMessage && (
            <div className="mt-2 text-xs text-destructive">{errorMessage}</div>
          )}
          {extra ? <div className="mt-2">{extra}</div> : null}
        </div>
      </div>
    </div>
  );
}

