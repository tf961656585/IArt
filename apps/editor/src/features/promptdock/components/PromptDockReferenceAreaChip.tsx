'use client';

import { memo } from 'react';
import { IconMusic, IconPhoto, IconVideo, IconX } from '@tabler/icons-react';
import type { MediaAsset } from '@iart/contracts';

import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';
import { cn } from '@/lib/utils';
import { formatDuration } from '@/shared/utils/duration';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import type { PromptDockReference } from '../PromptDock.types';

/**
 * 参考引用 chip（原型 prototypes/shared/promptdock-refs.js buildRefChip 同口径）：
 * 20px 真实媒体缩略图（image 直出 / video 取首帧 preload=metadata；audio 无视觉面，
 * 退类型图标 + 占位底）+ 资产标签 + 时长 + 移除；hover 200ms 弹出放大预览
 * （contain 完整可见 + 标签/尺寸说明行，video 静音循环播放），内容不抢交互。
 * 资产不可访问时退化为类型图标，不显示破图。
 */

type PromptDockReferenceAreaChipProps = {
  reference: PromptDockReference;
  onRemove: (refId: string) => void;
};

/** hover 预览打开延迟（200ms：避开快速扫过 chip 列时的预览轰炸） */
const PREVIEW_OPEN_DELAY_MS = 200;

/** 预览媒体面最大边（原型 .media-preview .mp-frame：320px contain） */
const PREVIEW_MAX_EDGE_PX = 320;

const TYPE_FALLBACK_ICON: Record<PromptDockReference['mediaType'], typeof IconPhoto> = {
  image: IconPhoto,
  video: IconVideo,
  audio: IconMusic,
};

/** 无视觉面时的占位底（原型 .ref-thumb.t-*：按类型取渐变 token，不显示破图） */
const TYPE_PLACEHOLDER_VAR: Record<PromptDockReference['mediaType'], string> = {
  image: 'var(--media-placeholder-image)',
  video: 'var(--media-placeholder-video)',
  audio: 'var(--media-placeholder-audio)',
};

/** 预览说明行右侧元信息（原型 mp-dims：尺寸优先，缺失退时长；audio 无预览不消费） */
const formatPreviewMeta = (
  mediaType: PromptDockReference['mediaType'],
  asset: MediaAsset | null,
): string | null => {
  const width = asset?.original.width ?? null;
  const height = asset?.original.height ?? null;
  if (mediaType !== 'audio' && width !== null && height !== null) {
    return `${width}×${height}`;
  }
  return formatDuration(asset?.original.durationMs);
};

/** 20px 缩略图（rounded-[4px]）：真实源 cover 铺满，无源退类型图标 + 占位底 */
const ReferenceChipThumb = ({
  mediaType,
  url,
}: {
  mediaType: PromptDockReference['mediaType'];
  url: string | null;
}) => {
  const hasFace = url !== null && (mediaType === 'image' || mediaType === 'video');
  if (!hasFace) {
    const Icon = TYPE_FALLBACK_ICON[mediaType];
    return (
      <span
        aria-hidden="true"
        className="flex size-5 shrink-0 items-center justify-center rounded-[4px] text-muted-foreground"
        style={{ background: TYPE_PLACEHOLDER_VAR[mediaType] }}
      >
        <Icon size={12} />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="relative block size-5 shrink-0 overflow-hidden rounded-[4px]"
    >
      {mediaType === 'video' ? (
        <video
          src={url}
          className="absolute inset-0 size-full object-cover"
          preload="metadata"
          muted
          playsInline
          tabIndex={-1}
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt=""
          loading="lazy"
          draggable={false}
          className="absolute inset-0 size-full object-cover"
        />
      )}
    </span>
  );
};

export const PromptDockReferenceAreaChip = memo(function PromptDockReferenceAreaChip({
  reference,
  onRemove,
}: PromptDockReferenceAreaChipProps) {
  const mediaAsset = useCanvasStore(
    (s) => s.mediaAssets[reference.assetId] ?? null,
  );

  const previewUrl = mediaAsset?.original.url ?? null;
  // audio 无视觉预览面（原型：bindMediaPreview 仅对有真实源且可视觉呈现的资产生效）
  const hasHoverPreview =
    previewUrl !== null && (reference.mediaType === 'image' || reference.mediaType === 'video');
  const durationText =
    reference.mediaType === 'image' ? null : formatDuration(mediaAsset?.original.durationMs);
  const previewMeta = hasHoverPreview
    ? formatPreviewMeta(reference.mediaType, mediaAsset)
    : null;

  const chip = (
    <span
      className="inline-flex h-6 items-center gap-1.5 rounded-lg border border-border bg-accent px-2 text-[11px] whitespace-nowrap text-accent-foreground"
      data-testid={`promptdock-reference-${reference.refId}`}
    >
      <ReferenceChipThumb mediaType={reference.mediaType} url={previewUrl} />
      <span className="max-w-[96px] truncate">{reference.label}</span>
      {durationText !== null ? (
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {durationText}
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => onRemove(reference.refId)}
        aria-label="移除参考"
        className="-mr-1 -my-1.5 p-1.5 text-muted-foreground hover:text-(--st-failed-text)"
      >
        <IconX size={12} />
      </button>
    </span>
  );

  if (!hasHoverPreview) return chip;

  return (
    <HoverCard openDelay={PREVIEW_OPEN_DELAY_MS} closeDelay={0}>
      <HoverCardTrigger asChild>{chip}</HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="center"
        sideOffset={8}
        className={cn(
          'pointer-events-none w-auto rounded-lg p-1.5 shadow-lg',
        )}
      >
        <div className="flex max-h-[320px] max-w-[320px] items-center justify-center">
          {reference.mediaType === 'video' ? (
            <video
              src={previewUrl}
              className="max-h-full max-w-full rounded-md object-contain"
              style={{ maxHeight: PREVIEW_MAX_EDGE_PX - 12, maxWidth: PREVIEW_MAX_EDGE_PX - 12 }}
              autoPlay
              muted
              loop
              playsInline
              tabIndex={-1}
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewUrl}
              alt={reference.label}
              draggable={false}
              className="max-h-full max-w-full rounded-md object-contain"
              style={{ maxHeight: PREVIEW_MAX_EDGE_PX - 12, maxWidth: PREVIEW_MAX_EDGE_PX - 12 }}
            />
          )}
        </div>
        <div className="mt-1 flex items-center justify-between gap-2.5 px-0.5 text-[11px] text-muted-foreground">
          <span className="truncate font-medium text-foreground">{reference.label}</span>
          {previewMeta !== null ? (
            <span className="shrink-0 font-mono tabular-nums">{previewMeta}</span>
          ) : null}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
});
