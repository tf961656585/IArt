'use client';

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from 'react';
import { IconPlayerPlay } from '@tabler/icons-react';
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
import { claimInlinePlayback, releaseInlinePlayback, type InlinePlaybackHandle } from './inlinePlaybackCoordinator';

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
  onDropFile?: ((file: File) => void) | undefined;
  onLoadedMeta?: ((meta: VideoMeta) => void) | undefined;
  /** 预解析的媒体展示信息，提供时优先使用其中的 URL 决策 */
  presentation: MediaPresentation | null | undefined;
  /**
   * 点击播放模式（资产节点，docs/editor/画布资产节点媒体播放-design.md §3.1）：
   * 常驻播放钮、点击原地播放（原生控件、有声）；播放态显示控件、暂停后回到播放钮。
   * 缺省 false = 素材节点现有的 hover 激活形态，行为不变。
   */
  clickToPlay?: boolean | undefined;
  /** 播放钮无障碍名称（缺省「播放」） */
  playLabel?: string | undefined;
  /** 双击激活（点击播放模式下由资产节点传入「打开放大预览」） */
  onOpenPreview?: (() => void) | undefined;
  /** 暴露视频元素（进度接力：预览打开时读取 / 关闭时写回 currentTime） */
  mediaElementRef?: RefObject<HTMLVideoElement | null> | undefined;
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
  clickToPlay = false,
  playLabel,
  onOpenPreview,
  mediaElementRef,
}: VideoNodeSurfaceProps) {
  const isCanvasInteracting = useCanvasStore((state) => state.isCanvasInteracting);
  const [isDragOver, setIsDragOver] = useState(false);
  const [measuredAspect, setMeasuredAspect] = useState<number | null>(null);
  const [videoLoadFailed, setVideoLoadFailed] = useState(false);
  const [thumbnailLoadFailed, setThumbnailLoadFailed] = useState(false);
  const [inlinePlaying, setInlinePlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const inlineMode = clickToPlay;
  const playbackHandle = useMemo<InlinePlaybackHandle>(
    () => ({ pause: () => videoRef.current?.pause() }),
    [],
  );
  const setVideoElement = useCallback(
    (element: HTMLVideoElement | null) => {
      videoRef.current = element;
      if (mediaElementRef) mediaElementRef.current = element;
    },
    [mediaElementRef],
  );
  const resolvedVideoUrl =
    typeof videoUrl === 'string' && videoUrl.trim().length > 0 ? videoUrl : undefined;

  // presentation 模式：URL 由外部预解析
  const presentationDormantUrl = (presentation !== null && presentation !== undefined ? presentation.dormantDisplayUrl : undefined) ?? null;
  const presentationActiveUrl = (presentation !== null && presentation !== undefined ? presentation.activeDisplayUrl : undefined) ?? null;
  const presentationThumbnailReady = (presentation !== null && presentation !== undefined ? presentation.thumbnailStatus : undefined) === 'ready';

  // legacy 模式：内部通过 hook 解析
  // inline 模式（资产节点）不生成缩略图：直接以视频首帧呈现，播放钮由本组件承担。
  const thumbnail = useVideoThumbnail(
    presentation || inlineMode ? undefined : resolvedVideoUrl,
    !presentation && !inlineMode,
  );
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
  const shouldRenderVideo =
    Boolean(renderableVideoUrl) && !videoLoadFailed && (inlineMode || isActive || dormantFallbackToVideo);
  const shouldShowThumbnail =
    !inlineMode && Boolean(renderableVideoUrl) && isDormant && Boolean(renderableThumbnailUrl);
  const shouldShowPlaceholder = Boolean(renderableVideoUrl) && !shouldRenderVideo && !shouldShowThumbnail;
  /* inline 模式：播放中显示原生控件；暂停后控件隐藏、中央播放钮恢复。
     非 inline 模式维持既有 hover / active 口径。 */
  const resolvedControls = inlineMode
    ? inlinePlaying && !isCanvasInteracting
    : shouldShowControls && !isCanvasInteracting;

  useEffect(() => {
    return () => {
      releaseInlinePlayback(playbackHandle);
    };
  }, [playbackHandle]);

  /* 画布平移 / 缩放 / 拖拽期间暂停播放（§3.3）：交互期画面不可辨且声音干扰构图。 */
  useEffect(() => {
    if (inlineMode && isCanvasInteracting && inlinePlaying) {
      videoRef.current?.pause();
    }
  }, [inlineMode, isCanvasInteracting, inlinePlaying]);

  const handleInlinePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    claimInlinePlayback(playbackHandle);
    video.muted = false;
    if (video.ended) video.currentTime = 0;
    // jsdom 的 HTMLMediaElement.play 返回 undefined（not implemented）；仅真机返回 Promise。
    const attempt = video.play() as Promise<void> | undefined;
    if (attempt && typeof attempt.catch === 'function') {
      attempt.catch((error: unknown) => {
        console.warn('[VideoNodeSurface] inline play failed', error);
      });
    }
  }, [playbackHandle]);

  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!inlineMode || !onOpenPreview) return;
      if (event.target instanceof Element && event.target.closest('button')) return;
      event.stopPropagation();
      event.preventDefault();
      onOpenPreview();
    },
    [inlineMode, onOpenPreview],
  );

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
      onDoubleClick={inlineMode && onOpenPreview ? handleDoubleClick : undefined}
    >
      {renderableVideoUrl ? (
        <>
          {shouldRenderVideo ? (
            // 生成/导入的媒体没有字幕轨，与 AssetNode 预览视频同一口径。
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video
              ref={setVideoElement}
              src={renderableVideoUrl}
              controls={resolvedControls}
              muted={inlineMode ? !inlinePlaying : true}
              playsInline
              preload={preload}
              className={cn(
                'h-full w-full',
                objectFit === 'contain' ? 'object-contain' : 'object-cover',
                shouldShowThumbnail && 'opacity-0 pointer-events-none',
                // 播放态让原生控件优先：原生控件在 closed shadow DOM 内，无法只排除
                // 底部控件条，整块挂 nodrag，暂停后再恢复节点可拖（§3.3）。
                inlineMode && inlinePlaying && 'nodrag',
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
              onPlay={() => {
                setPlaying(true);
                if (inlineMode) setInlinePlaying(true);
              }}
              onPause={() => {
                setPlaying(false);
                if (inlineMode) {
                  setInlinePlaying(false);
                  releaseInlinePlayback(playbackHandle);
                }
              }}
              onEnded={() => {
                setPlaying(false);
                if (inlineMode) {
                  setInlinePlaying(false);
                  releaseInlinePlayback(playbackHandle);
                }
              }}
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

      {/* 点击播放模式：播放钮常驻（不依赖 hover），点击原地播放。 */}
      {inlineMode && renderableVideoUrl && !videoLoadFailed && !inlinePlaying && !disabled && !isLoading ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <button
            type="button"
            className="nodrag pointer-events-auto inline-flex h-[34px] w-[34px] cursor-pointer items-center justify-center rounded-full border border-white/35 bg-[var(--scrim-55)] p-0 text-[var(--scrim-text)] transition-[background-color,transform] hover:scale-105 hover:bg-[var(--scrim-70)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--select-ring)]"
            aria-label={playLabel ? `播放 ${playLabel}` : '播放'}
            title="播放"
            onClick={(event) => {
              event.stopPropagation();
              handleInlinePlay();
            }}
          >
            <IconPlayerPlay size={14} />
          </button>
        </div>
      ) : null}

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
