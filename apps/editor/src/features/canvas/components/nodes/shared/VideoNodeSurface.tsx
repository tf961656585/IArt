'use client';

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
  type DragEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { RawImage } from "./RawImage";
import { cn } from '@/lib/utils';
import { useCanvasStore } from '../../../store/canvasStore';
import type { VideoMeta } from '../../../types';
import { VideoPlaceholder } from './VideoPlaceholder';
import { useDeferredHoverActivation } from './useDeferredHoverActivation';
import { useMediaLifecycle } from './useMediaLifecycle';
import { useVideoThumbnail } from './useVideoThumbnail';
import { resolveRenderableMediaUrl } from '../../../utils/mediaUrl';
import type { MediaPresentation } from '../../../services/mediaPresentation';
import { reportThumbnailRenderFailure } from '../../../services/thumbnailHealthReporter';

export const DEFAULT_VIDEO_ASPECT_RATIO = 16 / 9;

/**
 * VideoNodeSurface Props
 *
 * 架构约定：Surface 组件是纯展示层，不负责 URL 生命周期管理
 * - videoUrl: 由容器层（如 VideoInputNode）提供已解析 URL
 * - isLoading: 由容器层控制，用于显示加载状态
 */
export interface VideoNodeSurfaceProps {
  /** 生命周期 key（建议使用 nodeId 或 nodeId:slot），避免不同节点共享同一 URL 的休眠状态 */
  lifecycleKey: string | undefined;
  /** 已解析的视频 URL（object URL 或 http URL），由容器层负责管理生命周期 */
  videoUrl: string | undefined;
  aspectRatio: number | null | undefined;
  defaultAspectRatio: number | undefined;
  allowDrop: boolean | undefined;
  disabled: boolean | undefined;
  /** 加载状态，由容器层控制 */
  isLoading: boolean | undefined;
  /** 视频预加载策略（默认 metadata） */
  preload: 'none' | 'metadata' | 'auto' | undefined;
  placeholder: ReactNode;
  overlay: ReactNode | undefined;
  objectFit: 'contain' | 'cover' | undefined;
  /** 控制条显示策略 */
  controlsVisibility: 'always' | 'hover' | undefined;
  /** 选中态或激活态强制显示控制条 */
  controlsActive: boolean | undefined;
  showControls: boolean | undefined;
  className: string | undefined;
  /**
   * fill 模式（媒体输入节点专用）。
   *
   * - 默认（缺省/false）：根 div 用 `aspect-ratio + contain:size` 自推导高度，适配
   *   resultArea 等容器无确定高度的消费者。
   * - fill=true：根 div 改 `h-full w-full`、去 aspectRatio、contain 去 size，由父级
   *   （ContentNodeCard fill 模式 = Layout Model 投影尺寸）决定盒子大小。媒体输入节点
   *   的尺寸由 Layout Model 媒体尺寸层全权派生，Surface 只填充不推导。
   */
  fill?: boolean | undefined;
  onDropFile: (file: File) => void | undefined;
  onLoadedMeta: (meta: VideoMeta) => void | undefined;
  /** 预解析的媒体展示信息，提供时优先使用其中的 URL 决策 */
  presentation: MediaPresentation | null | undefined;
}

/**
 * 统一的视频节点展示容器
 * - 使用 CSS aspect-ratio 维持宽高比，避免纵向视频被裁剪
 * - 支持拖拽上传、浮层操作
 */
export const VideoNodeSurface = memo(function VideoNodeSurface({
  lifecycleKey,
  videoUrl,
  aspectRatio,
  defaultAspectRatio = DEFAULT_VIDEO_ASPECT_RATIO,
  allowDrop = false,
  disabled = false,
  isLoading = false,
  preload = 'metadata',
  placeholder,
  overlay,
  objectFit = 'contain',
  controlsVisibility = 'always',
  controlsActive = false,
  showControls = true,
  className,
  fill = false,
  onDropFile,
  onLoadedMeta,
  presentation,
}: VideoNodeSurfaceProps) {
  const isCanvasInteracting = useCanvasStore((state) => state.isCanvasInteracting);
  const [isDragOver, setIsDragOver] = useState(false);
  const [measuredAspect, setMeasuredAspect] = useState<number | null>(null);
  const [videoLoadFailed, setVideoLoadFailed] = useState(false);
  const [thumbnailLoadFailed, setThumbnailLoadFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const resolvedVideoUrl =
    typeof videoUrl === 'string' && videoUrl.trim().length > 0 ? videoUrl : undefined;

  // presentation 模式：URL 由外部预解析
  const presentationDormantUrl = (presentation !== null && presentation !== undefined ? presentation.dormantDisplayUrl : undefined) ?? null;
  const presentationActiveUrl = (presentation !== null && presentation !== undefined ? presentation.activeDisplayUrl : undefined) ?? null;
  const presentationThumbnailReady = (presentation !== null && presentation !== undefined ? presentation.thumbnailStatus : undefined) === 'ready';

  // legacy 模式：内部通过 hook 解析
  const thumbnail = useVideoThumbnail(presentation ? undefined : resolvedVideoUrl, !presentation);
  const thumbnailUrl =
    thumbnail !== null && thumbnail !== undefined && thumbnail.kind === 'thumbnail'
      ? thumbnail.url
      : null;
  const effectiveThumbnailUrl = thumbnailLoadFailed ? null : thumbnailUrl;
  const legacyRenderableVideoUrl = useMemo(
    () => resolveRenderableMediaUrl(resolvedVideoUrl),
    [resolvedVideoUrl],
  );
  const legacyRenderableThumbnailUrl = useMemo(
    () => resolveRenderableMediaUrl(effectiveThumbnailUrl),
    [effectiveThumbnailUrl],
  );

  // 统一的展示 URL 决策
  const renderableVideoUrl = presentation
    ? (presentationActiveUrl ?? presentationDormantUrl ?? null)
    : legacyRenderableVideoUrl;
  const renderableThumbnailUrl = presentation
    ? (presentationThumbnailReady ? presentationDormantUrl : null)
    : legacyRenderableThumbnailUrl;
  const { isActive, isDormant, onHoverEnter, onHoverLeave, setPlaying } = useMediaLifecycle(
    lifecycleKey,
    presentation ? (renderableVideoUrl ?? resolvedVideoUrl) : resolvedVideoUrl,
    'video',
  );
  const { isHovered, onPointerEnter, onPointerLeave } = useDeferredHoverActivation({
    isInteracting: isCanvasInteracting,
    onHoverEnter,
    onHoverLeave,
  });

  const resolvedAspectRatio = useMemo(
    () => aspectRatio ?? measuredAspect ?? defaultAspectRatio,
    [aspectRatio, defaultAspectRatio, measuredAspect],
  );

  const shouldShowControls =
    showControls &&
    (controlsVisibility === 'always' || (controlsVisibility === 'hover' && (isHovered || controlsActive)));

  const dormantFallbackToVideo = !renderableThumbnailUrl;
  const shouldRenderVideo = Boolean(renderableVideoUrl) && !videoLoadFailed && (isActive || dormantFallbackToVideo);
  const shouldShowThumbnail = Boolean(renderableVideoUrl) && isDormant && Boolean(renderableThumbnailUrl);
  const shouldShowPlaceholder = Boolean(renderableVideoUrl) && !shouldRenderVideo && !shouldShowThumbnail;

  useEffect(() => {
    setVideoLoadFailed(false);
  }, [renderableVideoUrl]);

  useEffect(() => {
    setThumbnailLoadFailed(false);
  }, [thumbnailUrl]);

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!allowDrop || disabled) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setIsDragOver(true);
    },
    [allowDrop, disabled],
  );

  const handleDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!allowDrop || disabled) return;
      event.preventDefault();
      const relatedTarget = event.relatedTarget as Node | null;
      if (!relatedTarget || !event.currentTarget.contains(relatedTarget)) {
        setIsDragOver(false);
      }
    },
    [allowDrop, disabled],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!allowDrop || disabled) return;
      event.preventDefault();
      setIsDragOver(false);
      const file = (event.dataTransfer.files !== null && event.dataTransfer.files !== undefined ? event.dataTransfer.files[0] : undefined);
      if (file) {
        if (onDropFile !== null && onDropFile !== undefined) {
          onDropFile(file);
        }
      }
    },
    [allowDrop, disabled, onDropFile],
  );

  const handleLoadedMeta = useCallback(
    (event: SyntheticEvent<HTMLVideoElement>) => {
      const target = event.currentTarget;
      if (target.videoWidth && target.videoHeight) {
        const nextAspect = Number((target.videoWidth / target.videoHeight).toFixed(4));
        setMeasuredAspect(nextAspect);
        if (onLoadedMeta !== null && onLoadedMeta !== undefined) {
          onLoadedMeta({
            width: target.videoWidth,
            height: target.videoHeight,
            aspectRatio: nextAspect,
            fps: undefined,
          });
        }
      }
    },
    [onLoadedMeta],
  );

  const handleThumbnailError = useCallback(() => {
    setThumbnailLoadFailed(true);
    if (!presentation || !renderableThumbnailUrl) return;
    void reportThumbnailRenderFailure({
      assetId: presentation.assetId,
      mediaType: 'video',
      failedUrl: presentation.thumbnailFormalUrl ?? renderableThumbnailUrl,
    });
  }, [presentation, renderableThumbnailUrl]);

  return (
    <div
      className={cn(
        'group relative w-full overflow-hidden rounded-md bg-muted/40 text-muted-foreground transition-colors',
        // fill 模式：根 div 由父级（ContentNodeCard fill = Layout Model 投影尺寸）决定高度，
        // 去掉 aspect-ratio 自推导；默认模式保留 aspect-ratio 撑开容器（resultArea 消费方依赖）。
        fill ? 'h-full' : '',
        disabled ? 'cursor-not-allowed opacity-90' : allowDrop ? 'cursor-pointer' : 'cursor-default',
        className,
      )}
      aria-busy={isLoading}
      style={{
        aspectRatio: fill ? undefined : resolvedAspectRatio,
        // fill 模式去掉 contain 的 size 分量：盒子由父级钉死，不再需要 contain:size 防塌缩。
        contain: fill ? 'layout paint' : 'layout paint size',
        contentVisibility: 'auto',
      }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {renderableVideoUrl ? (
        <>
          {shouldRenderVideo ? (
            <video
              ref={videoRef}
              src={renderableVideoUrl}
              controls={shouldShowControls && !isCanvasInteracting}
              muted
              playsInline
              preload={preload}
              className={cn(
                'h-full w-full',
                objectFit === 'contain' ? 'object-contain' : 'object-cover',
                shouldShowThumbnail && 'opacity-0 pointer-events-none',
              )}
              onLoadedMetadata={handleLoadedMeta}
              onError={(event) => {
                setVideoLoadFailed(true);
                // 条件跳过必须留痕：video 加载失败后静默回退到缩略图，无日志时排查不可见。
                // MediaError.code: 1=ABORTED 2=NETWORK 3=DECODE 4=SRC_NOT_SUPPORTED
                const target = event.currentTarget;
                const error = target?.error;
                console.warn('[VideoNodeSurface] video load failed', {
                  url: renderableVideoUrl,
                  code: error?.code,
                  message: error?.message,
                  networkState: target?.networkState,
                  readyState: target?.readyState,
                });
              }}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
            />
          ) : null}
          {shouldShowThumbnail ? (
            <RawImage
              src={renderableThumbnailUrl ?? undefined}
              alt=""
              className={cn(
                'absolute inset-0 h-full w-full',
                objectFit === 'contain' ? 'object-contain' : 'object-cover',
              )}
              draggable={false}
              onError={handleThumbnailError}
            />
          ) : null}
          {shouldShowPlaceholder ? (
            <div className="absolute inset-0 flex h-full w-full items-center justify-center">
              <VideoPlaceholder className="h-full w-full" label={undefined} />
            </div>
          ) : null}
        </>
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          {videoUrl ? <VideoPlaceholder className="h-full w-full" label={undefined} /> : placeholder}
        </div>
      )}

      {overlay}

      {isDragOver && allowDrop && !disabled && (
        <div className="pointer-events-none absolute inset-0 border-2 border-primary/50 bg-primary/10" />
      )}

      {isLoading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/40">
          <span className="h-3 w-3 animate-spin rounded-full border border-muted-foreground/40 border-t-transparent" />
        </div>
      )}
    </div>
  );
});

export default VideoNodeSurface;
