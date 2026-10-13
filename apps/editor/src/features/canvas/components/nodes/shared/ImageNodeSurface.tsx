'use client';

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { cn } from '@/lib/utils';
import type { ImageMeta } from '../../../types';
import { useCanvasStore } from '../../../store/canvasStore';
import { useMediaLifecycle } from './useMediaLifecycle';
import { useImageThumbnail } from './useImageThumbnail';
import { resolveRenderableMediaUrl } from '../../../utils/mediaUrl';
import type { MediaPresentation } from '../../../services/mediaPresentation';
import { reportThumbnailRenderFailure } from '../../../services/thumbnailHealthReporter';

export const DEFAULT_IMAGE_ASPECT_RATIO = 3 / 2;

/**
 * ImageNodeSurface Props
 *
 * 架构约定：Surface 组件是纯展示层，不负责 URL 生命周期管理
 * - imageUrl: 由容器层（如 ImageInputNode）提供已解析 URL（旧路径，向后兼容）
 * - presentation: 由容器层通过 resolveMediaPresentation 提供（新路径）
 * - isLoading: 由容器层控制，用于显示加载状态
 */
export interface ImageNodeSurfaceProps {
  /** 生命周期 key（建议使用 nodeId 或 nodeId:slot），避免不同节点共享同一 URL 的休眠状态 */
  lifecycleKey: string | undefined;
  /** 已解析的图片 URL（object URL 或 http URL），由容器层负责管理生命周期 */
  imageUrl: string | null;
  /**
   * 预解析的媒体展示信息（新路径）。
   * 传入时，dormant/active URL 由 presentation 决定，不再使用内部 thumbnail 逻辑。
   * 为 null 时退回旧路径（向后兼容）。
   */
  presentation: MediaPresentation | null | undefined;
  /** 背景填充图（用于 cover 铺底），为空则不渲染背景层 */
  backgroundImageUrl: string | null | undefined;
  alt: string;
  aspectRatio: number | null | undefined;
  defaultAspectRatio: number | undefined;
  allowDrop: boolean | undefined;
  disabled: boolean | undefined;
  /** 禁用浏览器原生 img 拖拽（用于自定义 drag payload，避免把当前显示图当作拖拽内容） */
  disableNativeDrag: boolean | undefined;
  /** 加载状态，由容器层控制 */
  isLoading: boolean | undefined;
  /** 图片加载策略（默认 lazy） */
  loading: 'eager' | 'lazy' | undefined;
  /** 图片解码策略（默认 async） */
  decoding: 'async' | 'sync' | 'auto' | undefined;
  placeholder: ReactNode;
  overlay: ReactNode | undefined;
  objectFit: 'contain' | 'cover' | undefined;
  /** 背景层的额外样式（仅在 backgroundImageUrl 存在时生效） */
  backgroundClassName: string | undefined;
  /** 背景层上方的遮罩层样式（例如渐变/暗角），为空则不渲染遮罩层 */
  backgroundOverlayClassName: string | undefined;
  className: string | undefined;
  /**
   * fill 模式（媒体输入节点专用）。
   *
   * - 默认（缺省/false）：根 div 用 `aspect-ratio + contain:size` 自推导高度，适配
   *   resultArea 等容器无确定高度的消费者（spec：画布节点尺寸管理架构.md「禁止事项」
   *   渲染层不得私造口径；resultArea 路径依赖此行为）。
   * - fill=true：根 div 改 `h-full w-full`、去 aspectRatio、contain 去 size，由父级
   *   （ContentNodeCard fill 模式 = Layout Model 投影尺寸）决定盒子大小。媒体输入节点
   *   的尺寸由 Layout Model 媒体尺寸层全权派生，Surface 只填充不推导。
   */
  fill?: boolean | undefined;
  onDropFile: (file: File) => void | undefined;
  onImageLoad: (meta: ImageMeta) => void | undefined;
}

/**
 * 统一的图片节点展示容器
 * - 负责保持宽高比、自带拖拽高亮与浮层占位
 * - 上传节点与预览节点可复用，避免重复实现展示层
 */
export const ImageNodeSurface = memo(function ImageNodeSurface({
  lifecycleKey,
  imageUrl,
  presentation,
  backgroundImageUrl = null,
  alt,
  aspectRatio,
  defaultAspectRatio = DEFAULT_IMAGE_ASPECT_RATIO,
  allowDrop = false,
  disabled = false,
  disableNativeDrag = false,
  isLoading = false,
  loading = 'lazy',
  decoding = 'async',
  placeholder,
  overlay,
  objectFit = 'contain',
  backgroundClassName,
  backgroundOverlayClassName,
  className,
  fill = false,
  onDropFile,
  onImageLoad,
}: ImageNodeSurfaceProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [measuredAspect, setMeasuredAspect] = useState<number | null>(null);
  const [preferOriginalAfterError, setPreferOriginalAfterError] = useState(false);
  // 预挂载测量期间临时关闭 content-visibility（防线 A）：让图片容器真实撑开 DOM，
  // 使全局整理的 measured 收敛到真实尺寸，而非占位值。其他场景 preLayoutMeasuring 恒 false，无副作用。
  const preLayoutMeasuring = useCanvasStore((s) => s.ui.preLayoutMeasuring);

  const usePresentationPath = presentation != null;

  // --- hover/leave 激活状态 ---
  const lifecycleUrl = usePresentationPath
    ? (presentation.activeDisplayUrl ?? imageUrl ?? presentation.dormantDisplayUrl)
    : imageUrl;
  const { isActive, onHoverEnter, onHoverLeave } = useMediaLifecycle(
    lifecycleKey,
    lifecycleUrl,
    'image',
  );

  // --- 展示 URL 决策 ---
  // 旧路径：内部 thumbnail 逻辑
  const shouldUseOriginalLegacy = isActive;
  const desiredMaxEdge = isActive ? 1024 : 512;
  const thumbnail = useImageThumbnail(
    usePresentationPath ? null : imageUrl,
    { maxEdge: desiredMaxEdge, quality: 0.8 },
    !usePresentationPath,
  );
  const thumbnailUrl = (thumbnail !== null && thumbnail !== undefined ? thumbnail.url : undefined) ?? null;
  const thumbnailSourceMeta = (thumbnail !== null && thumbnail !== undefined ? thumbnail.sourceMeta : undefined) ?? null;
  const thumbnailKind = (thumbnail !== null && thumbnail !== undefined ? thumbnail.kind : undefined) ?? null;

  const legacyDisplayUrl =
    shouldUseOriginalLegacy || preferOriginalAfterError
      ? imageUrl
      : (thumbnailUrl ?? imageUrl);
  const usingThumbnail = !shouldUseOriginalLegacy && !preferOriginalAfterError && thumbnailKind === 'thumbnail';

  // 新路径：presentation 驱动
  const presentationDisplayUrl = isActive
    ? (presentation !== null && presentation !== undefined ? presentation.activeDisplayUrl : undefined)
    : (presentation !== null && presentation !== undefined ? presentation.dormantDisplayUrl : undefined);
  const displayUrl = usePresentationPath ? presentationDisplayUrl : legacyDisplayUrl;

  const renderableDisplayUrl = useMemo(
    () => resolveRenderableMediaUrl(displayUrl),
    [displayUrl],
  );
  const renderableBackgroundImageUrl = useMemo(
    () => resolveRenderableMediaUrl(backgroundImageUrl),
    [backgroundImageUrl],
  );

  useEffect(() => {
    setPreferOriginalAfterError(false);
  }, [imageUrl, thumbnailUrl]);

  const resolvedAspectRatio = useMemo(
    () => aspectRatio ?? measuredAspect ?? defaultAspectRatio,
    [aspectRatio, defaultAspectRatio, measuredAspect],
  );

  // --- hover 元数据 ---
  const presentationHoverMeta = usePresentationPath ? (presentation !== null && presentation !== undefined ? presentation.hoverMeta : undefined) : null;
  // 从 presentation.hoverMeta 构建 ImageMeta（需要 width + height + aspectRatio 三项都存在）
  const hoverMetaImageMeta = useMemo<ImageMeta | null>(() => {
    const meta = presentationHoverMeta;
    if (!meta || !meta.width || !meta.height) return null;
    return { width: meta.width, height: meta.height, aspectRatio: Number((meta.width / meta.height).toFixed(4)) };
  }, [presentationHoverMeta]);

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

  const handleImageLoad = useCallback(
    (event: SyntheticEvent<HTMLImageElement>) => {
      const target = event.currentTarget;
      if (target.naturalWidth && target.naturalHeight) {
        const nextAspect = Number((target.naturalWidth / target.naturalHeight).toFixed(4));
        // DOM 尺寸只用于布局兜底
        setMeasuredAspect(nextAspect);

        if (usePresentationPath) {
          // presentation 路径：hoverMeta 优先，DOM 尺寸不反向覆盖
          if (hoverMetaImageMeta) {
            if (onImageLoad !== null && onImageLoad !== undefined) {
              onImageLoad(hoverMetaImageMeta);
            }
          }
          return;
        }

        // 旧路径：缩略图场景不覆盖原图尺寸信息
        if (usingThumbnail) {
          if (thumbnailSourceMeta) {
            if (onImageLoad !== null && onImageLoad !== undefined) {
              onImageLoad(thumbnailSourceMeta);
            }
          }
          return;
        }
        if (onImageLoad !== null && onImageLoad !== undefined) {
          onImageLoad({ width: target.naturalWidth, height: target.naturalHeight, aspectRatio: nextAspect });
        }
      }
    },
    [onImageLoad, usePresentationPath, hoverMetaImageMeta, usingThumbnail, thumbnailSourceMeta],
  );

  const handleImageError = useCallback(() => {
    const dormant = presentation !== null && presentation !== undefined ? presentation.dormant : null;
    if (usePresentationPath && presentation !== null && dormant !== null && dormant.kind === 'thumbnail' && renderableDisplayUrl === dormant.url) {
      void reportThumbnailRenderFailure({
        assetId: presentation.assetId,
        mediaType: 'image',
        failedUrl: presentation.thumbnailFormalUrl ?? dormant.url,
      });
      return;
    }
    if (!usePresentationPath && thumbnailUrl && !shouldUseOriginalLegacy && !preferOriginalAfterError) {
      setPreferOriginalAfterError(true);
    }
  }, [usePresentationPath, presentation, renderableDisplayUrl, thumbnailUrl, shouldUseOriginalLegacy, preferOriginalAfterError]);

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
        contentVisibility: preLayoutMeasuring ? undefined : 'auto',
      }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onPointerEnter={() => {
        if (disabled) return;
        if (useCanvasStore.getState().isCanvasInteracting) return;
        onHoverEnter();
      }}
      onPointerLeave={() => {
        onHoverLeave();
      }}
    >
      {renderableBackgroundImageUrl ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={renderableBackgroundImageUrl}
            alt=""
            aria-hidden="true"
            loading={loading}
            decoding={decoding}
            className={cn('pointer-events-none absolute inset-0 h-full w-full select-none object-cover', backgroundClassName)}
          />
          {backgroundOverlayClassName ? (
            <div aria-hidden="true" className={cn('pointer-events-none absolute inset-0', backgroundOverlayClassName)} />
          ) : null}
        </>
      ) : null}

      {renderableDisplayUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={renderableDisplayUrl}
          alt={alt}
          loading={loading}
          decoding={decoding}
          draggable={disableNativeDrag ? false : undefined}
          onDragStart={(event) => {
            if (disableNativeDrag) event.preventDefault();
          }}
          className={cn(
            'relative h-full w-full',
            objectFit === 'contain' ? 'object-contain' : 'object-cover',
          )}
          onLoad={handleImageLoad}
          onError={handleImageError}
        />
      ) : (
        <div className="relative flex h-full w-full items-center justify-center">{placeholder}</div>
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

export default ImageNodeSurface;
