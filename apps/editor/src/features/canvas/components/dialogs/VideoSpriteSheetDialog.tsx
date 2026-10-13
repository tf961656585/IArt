'use client';

import { memo, useCallback, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatMediaTime } from '../../services/mediaTime';
import type { VideoSpriteSheetDialogProps } from './videoSpriteSheetDialogTypes';
import { useVideoSpriteSheetDialogState } from './useVideoSpriteSheetDialog';
import { MediaStagePlaceholder, MediaToolDialogShell } from './MediaToolDialogShell';

export type { SpriteSheetDialogPayload } from './videoSpriteSheetDialogTypes';

export const VideoSpriteSheetDialog = memo(function VideoSpriteSheetDialog({
  open,
  onOpenChange,
  videoUrl,
  videoMeta,
  fps,
  onConfirm,
}: VideoSpriteSheetDialogProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rangeTrackRef = useRef<HTMLDivElement | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const state = useVideoSpriteSheetDialogState({
    open,
    videoUrl,
    videoMeta,
    fps,
    videoRef,
    rangeTrackRef,
  });

  const canGenerate =
    fps !== undefined &&
    Number.isFinite(fps) &&
    fps > 0 &&
    state.layout !== null &&
    Boolean(videoUrl);

  const handleGenerate = useCallback(() => {
    if (!canGenerate) return;
    onConfirm({
      startTime: state.draftRange[0],
      endTime: state.draftRange[1],
      fpsMultiplier: state.fpsMultiplier,
      stepSize: state.stepSize,
    });
    onOpenChange(false);
  }, [
    canGenerate,
    onConfirm,
    onOpenChange,
    state.draftRange,
    state.fpsMultiplier,
    state.stepSize,
  ]);

  if (!open) return null;

  return (
    <MediaToolDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="序列帧图集"
      description="从视频中提取帧生成序列帧图集，可调整时间区间和帧率倍率。"
      loading={false}
      confirmLabel="生成图集"
      confirmDisabled={!canGenerate}
      onCancel={() => onOpenChange(false)}
      onConfirm={handleGenerate}
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
            <Label className="text-sm">时间区间（秒）</Label>
            <span className="text-xs text-muted-foreground">
              {formatMediaTime(state.draftRange[0])} —{' '}
              {formatMediaTime(state.draftRange[1])}
            </span>
          </div>
          <Slider
            value={state.draftRange}
            min={0}
            max={state.sliderMax}
            step={0.01}
            onValueChange={state.handleSliderChange}
            onValueCommit={state.handleSliderCommit}
            onPointerDownCapture={state.handleSliderPointerDownCapture}
          />
          {/* 范围拖动条 */}
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
          {/* 精确输入 */}
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
        </div>
      }
      rail={
        <>
          {/* 帧率倍率 */}
          <div className="rounded-md border p-3 space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-sm">帧率倍率</Label>
              <span className="text-sm font-medium tabular-nums">
                {state.fpsMultiplier.toFixed(2)}x
              </span>
            </div>
            <Slider
              value={[state.fpsMultiplier]}
              min={0}
              max={1}
              step={state.stepSize}
              onValueChange={state.handleMultiplierChange}
            />
            <p className="text-xs text-muted-foreground">
              实际输出帧率：{fps !== undefined ? (fps * state.fpsMultiplier).toFixed(1) : '未知'} fps
            </p>
          </div>

          {/* 高级设置 */}
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="w-full justify-between">
                高级设置
                <span className="text-xs">{advancedOpen ? '收起' : '展开'}</span>
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="rounded-md border p-3 space-y-3 mt-2">
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">每次调整幅度（0.01 ~ 1）</Label>
                  <Input
                    type="number"
                    min={0.01}
                    max={1}
                    step={0.01}
                    value={state.stepSize}
                    onChange={state.handleStepSizeChange}
                    className="h-8"
                  />
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* 输出信息面板 */}
          <div className="rounded-md border p-3 space-y-2">
            <Label className="text-sm font-medium">输出信息</Label>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <span className="text-muted-foreground">视频帧率</span>
              <span className="tabular-nums">{fps !== undefined ? `${fps} fps` : '未知'}</span>
              <span className="text-muted-foreground">实际输出帧率</span>
              <span className="tabular-nums">
                {fps !== undefined ? `${(fps * state.fpsMultiplier).toFixed(1)} fps` : '未知'}
              </span>
              <span className="text-muted-foreground">总帧数</span>
              <span className="tabular-nums">{state.layout !== null ? state.layout.frameCount : '—'}</span>
              <span className="text-muted-foreground">布局</span>
              <span className="tabular-nums">
                {state.layout !== null ? `${state.layout.rows} x ${state.layout.cols}` : '—'}
              </span>
              <span className="text-muted-foreground">单帧尺寸</span>
              <span className="tabular-nums">
                {state.layout !== null ? `${state.layout.frameWidth} x ${state.layout.frameHeight}` : '—'}
              </span>
              <span className="text-muted-foreground">图集尺寸</span>
              <span className="tabular-nums">
                {state.layout !== null ? `${state.layout.atlasWidth} x ${state.layout.atlasHeight}` : '—'}
              </span>
            </div>
          </div>
        </>
      }
    />
  );
});

export default VideoSpriteSheetDialog;
