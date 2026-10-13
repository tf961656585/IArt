'use client';

import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import type { BundleExportProgressEvent } from '../export/bundleTypes';

type OverlayStatus = 'idle' | 'running' | 'success' | 'error' | 'cancelled';

export type BundleExportProgressOverlayProps = {
  visible: boolean;
  status: OverlayStatus;
  progressEvent: BundleExportProgressEvent | null;
  elapsedMs: number;
  errorMessage: string | null | undefined;
  onHide: () => void;
  onCancel: () => void;
};

const MESSAGE_LABELS: Record<string, string> = {
  'bundle.export.media': '正在导出媒体',
  'bundle.export.files': '正在打包文件',
  'bundle.export.zip': '正在生成压缩包',
};

const STATUS_LABELS: Record<Exclude<OverlayStatus, 'idle'>, string> = {
  running: '导出进行中',
  success: '导出完成',
  error: '导出失败',
  cancelled: '已取消导出',
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

export function BundleExportProgressOverlay({
  visible,
  status,
  progressEvent,
  elapsedMs,
  errorMessage,
  onHide,
  onCancel,
}: BundleExportProgressOverlayProps) {
  const progressPercent = useMemo(() => {
    if (status === 'success') return 100;
    const percent = progressEvent !== null && progressEvent !== undefined ? progressEvent.percent : undefined;
    const processed = progressEvent !== null && progressEvent !== undefined ? progressEvent.processed : undefined;
    const total = progressEvent !== null && progressEvent !== undefined ? progressEvent.total : undefined;
    if (typeof percent === 'number') {
      return clampPercent(percent);
    }
    if (
      typeof processed === 'number' &&
      typeof total === 'number' &&
      total > 0
    ) {
      return clampPercent((processed / total) * 100);
    }
    return 0;
  }, [progressEvent, status]);

  const detailText = useMemo(() => {
    const parts: string[] = [];
    const processed = progressEvent !== null && progressEvent !== undefined ? progressEvent.processed : undefined;
    const total = progressEvent !== null && progressEvent !== undefined ? progressEvent.total : undefined;
    const percent = progressEvent !== null && progressEvent !== undefined ? progressEvent.percent : undefined;
    if (
      typeof processed === 'number' &&
      typeof total === 'number' &&
      total > 0
    ) {
      parts.push(`${processed}/${total}`);
    }
    if (progressPercent > 0 || typeof percent === 'number') {
      parts.push(`${Math.round(progressPercent)}%`);
    }
    return parts.join(' · ');
  }, [progressEvent, progressPercent]);

  const stageLabel = useMemo(() => {
    if (status !== 'idle' && status !== 'running') {
      return STATUS_LABELS[status];
    }
    const messageKey = progressEvent !== null && progressEvent !== undefined ? progressEvent.messageKey : undefined;
    const stage = progressEvent !== null && progressEvent !== undefined ? progressEvent.stage : undefined;
    if (messageKey !== undefined && MESSAGE_LABELS[messageKey]) {
      return MESSAGE_LABELS[messageKey];
    }
    if (stage) {
      return stage;
    }
    return STATUS_LABELS.running;
  }, [progressEvent, status]);

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
            <div className="text-sm font-semibold text-foreground">{stageLabel}</div>
            {detailText && (
              <div className="mt-1 text-xs text-muted-foreground">{detailText}</div>
            )}
          </div>
          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={onHide}>
            隐藏
          </Button>
        </div>
        <div className="px-3 pb-3">
          <Progress value={progressPercent} className="mt-2" />
          <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>耗时 {formatElapsed(elapsedMs)}</span>
            {status === 'running' && (
              <Button
                variant="destructive"
                size="sm"
                className="h-7 px-2"
                onClick={onCancel}
              >
                取消导出
              </Button>
            )}
          </div>
          {status === 'error' && errorMessage && (
            <div className="mt-2 text-xs text-destructive">{errorMessage}</div>
          )}
        </div>
      </div>
    </div>
  );
}
