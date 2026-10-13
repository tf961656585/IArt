'use client';

import { memo, useCallback, useRef, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import { formatMediaTime } from '../../services/mediaTime';
import { MediaStagePlaceholder, MediaToolDialogShell } from './MediaToolDialogShell';
import { useVideoTrimDialogState } from './useVideoTrimDialog';
import { FINE_STEP } from './useVideoSpriteSheetDialog';

export type VideoTrimDialogPayload = {
  startTime: number;
  endTime: number;
  withAudio: boolean;
};

export type VideoTrimDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 可渲染的视频地址（预览用）；加工源地址由调用方持有 */
  videoUrl: string | null;
  onConfirm: (payload: VideoTrimDialogPayload) => Promise<void>;
};

/**
 * 视频裁切弹窗（媒体工具：资产上的动作）。
 * 参数与媒体预览同框，双滑块 + 拖动选段 + seek 预览直接操纵；
 * 确认后由调用方执行裁切并产出新视频素材节点，源资产不受影响。
 */
export const VideoTrimDialog = memo(function VideoTrimDialog({
  open,
  onOpenChange,
  videoUrl,
  onConfirm,
}: VideoTrimDialogProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rangeTrackRef = useRef<HTMLDivElement | null>(null);
  const [saving, setSaving] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const state = useVideoTrimDialogState({
    open,
    videoUrl,
    videoRef,
    rangeTrackRef,
  });

  const canConfirm = Boolean(videoUrl) && !saving && state.draftRange[1] > state.draftRange[0];

  const handleConfirm = useCallback(async () => {
    if (!canConfirm) return;
    setSaving(true);
    setExportError(null);
    try {
      await onConfirm({
        startTime: state.draftRange[0],
        endTime: state.draftRange[1],
        withAudio: state.withAudio,
      });
      onOpenChange(false);
    } catch (error) {
      console.error('[VideoTrimDialog] trim failed', error);
      setExportError(error instanceof Error ? error.message : '视频裁切失败');
    } finally {
      setSaving(false);
    }
  }, [canConfirm, onConfirm, onOpenChange, state.draftRange, state.withAudio]);

  if (!open) return null;

  return (
    <MediaToolDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="裁切视频"
      description="选择要保留的时间区间，裁切结果会生成新的视频素材，原视频不受影响。"
      loading={saving}
      confirmLabel="裁切并生成新素材"
      confirmLoadingLabel="裁切中…"
      confirmDisabled={!canConfirm}
      onCancel={() => onOpenChange(false)}
      onConfirm={() => void handleConfirm()}
      notice={exportError ? <div className="text-sm text-destructive">{exportError}</div> : null}
      stage={
        videoUrl ? (
          <div className="relative h-full w-full overflow-hidden rounded">
            <video
              ref={videoRef}
              src={videoUrl}
              crossOrigin="anonymous"
              preload="metadata"
              playsInline
              onLoadedMetadata={state.handleLoadedMetadata}
              className="h-full w-full object-contain"
            >
              <track kind="captions" />
            </video>
          </div>
        ) : (
          <MediaStagePlaceholder state="empty" message="无视频" />
        )
      }
      stageToolbar={
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-sm">截取范围（秒）</Label>
            <span className="text-xs text-muted-foreground">
              {formatMediaTime(state.draftRange[0])} — {formatMediaTime(state.draftRange[1])}
            </span>
          </div>
          <Slider
            value={state.draftRange}
            min={0}
            max={state.sliderMax}
            step={FINE_STEP}
            onValueChange={state.handleSliderChange}
            onValueCommit={state.handleSliderCommit}
            onPointerDownCapture={state.handleSliderPointerDownCapture}
          />
          <div ref={rangeTrackRef} className="relative h-4">
            <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-muted/60" />
            <div
              className={cn(
                'absolute top-1/2 h-3 -translate-y-1/2 rounded-full border border-primary bg-primary/35',
                state.isDraggingRange ? 'cursor-grabbing' : 'cursor-grab',
                'touch-none select-none',
              )}
              style={{
                left: `${state.rangeLeftPercent}%`,
                width: `${state.rangeWidthPercent}%`,
              }}
              title="拖动该范围可整体平移（Shift 精细）"
              onPointerDown={state.handleRangePointerDown}
              onPointerMove={state.handleRangePointerMove}
              onPointerUp={state.handleRangePointerUp}
              onPointerCancel={state.handleRangePointerCancel}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">开始时间</Label>
              <Input
                type="number"
                min={0}
                step={0.01}
                value={state.draftRange[0]}
                onChange={state.handleStartChange}
                onBlur={state.handleRangeBlur}
                className="h-8"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">结束时间</Label>
              <Input
                type="number"
                min={0}
                step={0.01}
                value={state.draftRange[1]}
                onChange={state.handleEndChange}
                onBlur={state.handleRangeBlur}
                className="h-8"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm" htmlFor="video-trim-with-audio">
            <Checkbox
              id="video-trim-with-audio"
              checked={state.withAudio}
              onCheckedChange={(checked) => state.setWithAudio(checked === true)}
            />
            保留音频
          </label>
        </div>
      }
      rail={
        <>
          <div className="rounded-md border p-3 space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>截取起点</span>
              <span className="tabular-nums">{formatMediaTime(state.draftRange[0])}</span>
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>截取终点</span>
              <span className="tabular-nums">{formatMediaTime(state.draftRange[1])}</span>
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>片段时长</span>
              <span className="tabular-nums">
                {formatMediaTime(Math.max(0, state.draftRange[1] - state.draftRange[0]))}
              </span>
            </div>
          </div>
        </>
      }
    />
  );
});

export default VideoTrimDialog;
