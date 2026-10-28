'use client';

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { IconPlayerPause, IconPlayerPlay } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { useCanvasStore } from '../../../store/canvasStore';
import { claimInlinePlayback, releaseInlinePlayback, type InlinePlaybackHandle } from './inlinePlaybackCoordinator';

/**
 * 音频资产节点表面（docs/editor/画布资产节点媒体播放-design.md §3.6）。
 *
 * 卡片形态：播放钮 + 静态波形 + 时长；点击播放钮原地出声，波形按进度填充。
 * 双击卡片切换播放 / 暂停；同屏唯一播放与画布交互期暂停由共享协调器承担。
 */

export interface AudioAssetSurfaceProps {
  audioUrl: string | undefined;
  label: string;
  durationMs: number | undefined;
  className?: string | undefined;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--';
  const total = Math.round(seconds);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export const AudioAssetSurface = memo(function AudioAssetSurface({
  audioUrl,
  label,
  durationMs,
  className,
}: AudioAssetSurfaceProps) {
  const isCanvasInteracting = useCanvasStore((state) => state.isCanvasInteracting);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(() =>
    typeof durationMs === 'number' && durationMs > 0 ? durationMs / 1000 : 0,
  );

  const playbackHandle = useMemo<InlinePlaybackHandle>(
    () => ({ pause: () => audioRef.current?.pause() }),
    [],
  );

  useEffect(() => {
    return () => {
      releaseInlinePlayback(playbackHandle);
    };
  }, [playbackHandle]);

  /* 画布平移 / 缩放 / 拖拽期间暂停播放（§3.3）。 */
  useEffect(() => {
    if (isCanvasInteracting && playing) audioRef.current?.pause();
  }, [isCanvasInteracting, playing]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio && !audio.paused) audio.pause();
    setPlaying(false);
    setProgress(0);
    setDuration(typeof durationMs === 'number' && durationMs > 0 ? durationMs / 1000 : 0);
  }, [audioUrl, durationMs]);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    claimInlinePlayback(playbackHandle);
    if (audio.ended) audio.currentTime = 0;
    // jsdom 的 HTMLMediaElement.play 返回 undefined（not implemented）；仅真机返回 Promise。
    const attempt = audio.play() as Promise<void> | undefined;
    if (attempt && typeof attempt.catch === 'function') {
      attempt.catch((error: unknown) => {
        console.warn('[AudioAssetSurface] play failed', error);
      });
    }
  }, [playbackHandle]);

  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.target instanceof Element && event.target.closest('button')) return;
      event.stopPropagation();
      event.preventDefault();
      toggle();
    },
    [toggle],
  );

  return (
    <div
      data-asset-audio-player="true"
      className={cn('flex h-full w-full items-center gap-2 pb-2 pl-3 pr-3 pt-5', className)}
      onDoubleClick={handleDoubleClick}
    >
      <button
        type="button"
        className="nodrag inline-flex h-[30px] w-[30px] shrink-0 cursor-pointer items-center justify-center rounded-full border border-border bg-secondary p-0 text-secondary-foreground hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--chrome-ring)]"
        aria-label={playing ? `暂停 ${label}` : `播放 ${label}`}
        title={playing ? '暂停' : '播放'}
        onClick={(event) => {
          event.stopPropagation();
          toggle();
        }}
      >
        {playing ? <IconPlayerPause size={13} /> : <IconPlayerPlay size={13} />}
      </button>
      <span
        className="relative h-[26px] flex-1 overflow-hidden rounded-sm opacity-45"
        style={{
          background:
            'repeating-linear-gradient(90deg, var(--muted-foreground) 0 2px, transparent 2px 7px)',
        }}
        aria-hidden="true"
      >
        <span
          className="absolute bottom-0 left-0 top-0 bg-foreground opacity-55"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </span>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
        {formatDuration(duration)}
      </span>
      {/* 音频资产没有字幕轨；播放由独立按钮控制，元素本身不可见。 */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        ref={audioRef}
        className="hidden"
        src={audioUrl}
        preload="metadata"
        onLoadedMetadata={(event) => {
          const next = event.currentTarget.duration;
          if (Number.isFinite(next) && next > 0) setDuration(next);
        }}
        onTimeUpdate={(event) => {
          const audio = event.currentTarget;
          setProgress(audio.duration > 0 ? audio.currentTime / audio.duration : 0);
        }}
        onPlay={() => {
          setPlaying(true);
          claimInlinePlayback(playbackHandle);
        }}
        onPause={() => {
          setPlaying(false);
          releaseInlinePlayback(playbackHandle);
        }}
        onEnded={() => {
          setPlaying(false);
          setProgress(0);
          releaseInlinePlayback(playbackHandle);
        }}
        onError={() => {
          console.warn('[AudioAssetSurface] audio load failed', { url: audioUrl });
        }}
      />
    </div>
  );
});

export default AudioAssetSurface;
