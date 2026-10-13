'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { formatMediaTime } from '../../services/mediaTime';
import { MediaStagePlaceholder, MediaToolDialogShell } from './MediaToolDialogShell';

export type VideoFrameCaptureDialogPayload = {
  timeSec: number;
};

export type VideoFrameCaptureDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 可渲染的视频地址（预览用）；加工源地址由调用方持有 */
  videoUrl: string | null;
  onConfirm: (payload: VideoFrameCaptureDialogPayload) => Promise<void>;
};

/**
 * 视频截帧弹窗（媒体工具：资产上的动作）。
 * 参数与媒体预览同框，滑杆/时间点输入 + seek 预览直接操纵；
 * 确认后由调用方执行截帧并产出新图片素材节点，源视频不受影响。
 */
export const VideoFrameCaptureDialog = memo(function VideoFrameCaptureDialog({
  open,
  onOpenChange,
  videoUrl,
  onConfirm,
}: VideoFrameCaptureDialogProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [duration, setDuration] = useState(0);
  const [captureTime, setCaptureTime] = useState(0);
  const [saving, setSaving] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setDuration(0);
      setCaptureTime(0);
      setSaving(false);
      setExportError(null);
      return;
    }
    setExportError(null);
  }, [open]);

  // 切换视频源时重置时长，避免滑杆上限沿用旧值
  useEffect(() => {
    setDuration(0);
  }, [videoUrl]);

  const seekPreviewVideo = useCallback((next: number) => {
    const video = videoRef.current;
    if (!video) return;
    try {
      video.currentTime = Math.max(0, next);
      video.pause();
    } catch {
      // ignore
    }
  }, []);

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const nextDuration = Number.isFinite(video.duration) ? video.duration : 0;
    setDuration(nextDuration);
    setCaptureTime((prev) => (nextDuration > 0 && prev > nextDuration ? nextDuration : prev));
  }, []);

  const handleSliderChange = useCallback(
    (values: number[]) => {
      const next = Number(values[0] ?? 0);
      if (!Number.isFinite(next)) return;
      setCaptureTime(next);
      seekPreviewVideo(next);
    },
    [seekPreviewVideo],
  );

  const handleSliderCommit = useCallback((values: number[]) => {
    const next = Number(values[0] ?? 0);
    if (!Number.isFinite(next)) return;
    setCaptureTime(Math.max(0, next));
  }, []);

  const handleTimeChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const raw = Number(event.target.value);
      if (!Number.isFinite(raw)) return;
      const clamped = Math.max(0, duration > 0 ? Math.min(raw, duration) : raw);
      setCaptureTime(clamped);
      seekPreviewVideo(clamped);
    },
    [duration, seekPreviewVideo],
  );

  const canConfirm = Boolean(videoUrl) && !saving;

  const handleConfirm = useCallback(async () => {
    if (!canConfirm) return;
    setSaving(true);
    setExportError(null);
    try {
      await onConfirm({ timeSec: captureTime });
      onOpenChange(false);
    } catch (error) {
      console.error('[VideoFrameCaptureDialog] capture failed', error);
      setExportError(error instanceof Error ? error.message : '视频截帧失败');
    } finally {
      setSaving(false);
    }
  }, [canConfirm, captureTime, onConfirm, onOpenChange]);

  if (!open) return null;

  return (
    <MediaToolDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="截取帧"
      description="选择要截取的时间点，截取结果会生成新的图片素材，原视频不受影响。"
      loading={saving}
      confirmLabel="截取并生成新素材"
      confirmLoadingLabel="截取中…"
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
              onLoadedMetadata={handleLoadedMetadata}
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
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{formatMediaTime(captureTime)}</span>
            <span>{duration > 0 ? formatMediaTime(duration) : '--:--'}</span>
          </div>
          <Slider
            value={[captureTime]}
            min={0}
            max={duration || Math.max(captureTime, 1)}
            step={0.1}
            onValueChange={handleSliderChange}
            onValueCommit={handleSliderCommit}
          />
        </div>
      }
      rail={
        <>
          <div className="rounded-md border p-3 space-y-3">
            <Label className="text-xs text-muted-foreground" htmlFor="video-frame-capture-time">
              截取时间（秒）
            </Label>
            <Input
              id="video-frame-capture-time"
              type="number"
              min={0}
              step={0.1}
              value={captureTime}
              onChange={handleTimeChange}
              className="h-8"
            />
            <p className="text-xs text-muted-foreground">调整滑杆或输入时间点，预览画面会同步跳转。</p>
          </div>
        </>
      }
    />
  );
});

export default VideoFrameCaptureDialog;
