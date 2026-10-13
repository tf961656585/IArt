'use client';

import { useMemo, useRef, useState } from 'react';
import type { CSSProperties, SyntheticEvent } from 'react';
import { IconPlayerPause, IconPlayerPlay } from '@tabler/icons-react';
import type { MediaAsset } from '@iart/contracts';
import { cn } from '@/lib/utils';
import { formatDuration } from '@/shared/utils/duration';
import { Button } from '@/components/ui/button';
import { addAssetIdsToReferences } from '@/features/promptdock/referenceOps';
import { announceReferenceAddResult } from '@/features/promptdock/referenceFeedback';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import type { GraphNode } from '@/features/canvas/types/node';
import { AssetPreviewDialog } from './AssetPreviewDialog';
// 媒体统一件自有样式（加载淡入、原生 seek 控件形态）：组件级 import，PostCSS/Tailwind 管线处理。
import '../agentSessionMedia.css';

/**
 * 会话视图「媒体统一件」（spec docs/agent/02「会话视图与多轮历史」、06「附件与多模态」）。
 *
 * 用户消息的 media part 与工具结果卡里的资产引用共用同一套呈现：**比例真实、禁裁切**
 * 的媒体格（比例取画布资产注册表的 original.width/height，缺失时用媒体自身
 * naturalWidth/naturalHeight 探针回填，再缺省按类型档），视频海报卡（海报帧只取
 * ready 缩略图，绝不把视频文件塞给 img）、音频条（播放/进度/seek/预览）、
 * 「用作参考」（复用既有 referenceOps 唯一入口，按**素材 ID** 直加——不要求画布上存在持有该
 * 产物的节点，存量会话产物也能接入参考；hover 与 focus-within 都出现，准入不过给 toast 提示）。
 *
 * 承载边界：本文件只做呈现与预览接线，不持有会话状态、不发决裁、不建第二引用入口。
 * 失败与产物未就绪档固定 96px 占位（不放大、不给预览与引用出口），文案「无法加载」/「产物未就绪」。
 */

/** 视觉类型分档（音频无视觉面，走独立音频条）。 */
export type SessionMediaKind = 'image' | 'video' | 'audio';

/** 类型文字（无视觉面时的占位与无障碍名回落）。 */
export const MEDIA_PART_LABEL: Record<SessionMediaKind, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
};

/** 比例未知时的类型缺省档（图 3/2、视频 16/9）。 */
const TYPE_FALLBACK_RATIO: Record<SessionMediaKind, number> = {
  image: 3 / 2,
  video: 16 / 9,
  audio: 1,
};

/** 媒体格高度上限（>1 产物两列网格的 cell 高上限）。 */
const CELL_MAX_HEIGHT_PX = 140;

/** 单产物独占总高度上限（卡宽 = min(100%, 上限 × 比例)）。 */
const SOLO_MAX_HEIGHT_PX = 240;

/** 失败 / 产物未就绪占位固定高（不放大、不与真实比例挂钩）。 */
const PLACEHOLDER_HEIGHT_CLASS = 'h-24';

/** 未知时长占位（音频条按时长口径显示，不猜时长）。 */
const UNKNOWN_DURATION_TEXT = '--:--';

/** 音频波形条：16 根静态装饰竖条（aria-hidden，只表达进度前沿）。 */
const WAVE_BAR_HEIGHTS = [8, 12, 6, 14, 10, 16, 9, 13, 7, 15, 11, 8, 14, 10, 12, 9];

/** seek 精度（原生 range 的 step 粒度：0..1000 → 0.1%）。 */
const SEEK_MAX = 1000;

/** 无视觉面时的类型占位底（令牌消费；梯度值只能走 background 简写，不用 bg-* 工具类）。 */
export const PLACEHOLDER_BACKGROUND: Record<SessionMediaKind, string> = {
  image: 'var(--media-placeholder-image)',
  video: 'var(--media-placeholder-video)',
  audio: 'var(--media-placeholder-audio)',
};

const EMPTY_NODES: GraphNode[] = [];

/**
 * 一条媒体（资产产物或用户消息的 media part）的展示模型。
 * `unsettled`（资产注册表无该条目）与 `faceUrl === null` 都由呈现层收敛成占位，不显示破图。
 */
export type SessionMediaItem = {
  /** 稳定列表键（资产用 assetId，用户消息 part 用类型 + 地址） */
  key: string;
  /** 资产条目 id；null = 用户消息的 media part（无画布资产语义） */
  assetId: string | null;
  kind: SessionMediaKind;
  /** 可视面 URL（图 = ready 缩略图否则原图；视频 = ready 缩略图海报帧） */
  faceUrl: string | null;
  /** 用户消息视频 part 的直出首帧源（preload=metadata 取首帧，不塞给 img） */
  videoFaceUrl: string | null;
  /** 预览 / 播放源（local-media 地址）；null = 不给预览出口 */
  previewUrl: string | null;
  /** 资产名（画布节点标签回落类型文字） */
  name: string;
  /** 真实宽高比（宽 / 高）；null = 未知，呈现层按类型缺省 */
  aspectRatio: number | null;
  durationMs: number | null;
  /** 产物未就绪（画布资产注册表无该条目）：占位呈现，不给预览与引用出口 */
  unsettled: boolean;
  /** 画布上持有该资产的节点（资产名取此处标签；参考加入本身按 assetId，不依赖节点） */
  hostNodes: readonly GraphNode[];
};

/** 画布上持有该资产的节点（referenceOps 参考入口的节点来源；只读画布 store，不建第二入口） */
const findAssetNodes = (nodes: readonly GraphNode[], assetId: string): GraphNode[] =>
  nodes.filter((node) => {
    const data = node.data as { assetId?: unknown };
    return typeof data.assetId === 'string' && data.assetId === assetId;
  });

/** 从节点数据尽力读取显示标签（referenceOps 同口径；无标签退 null）。 */
const nodeLabelOf = (node: GraphNode): string | null => {
  const label = (node.data as { label?: unknown }).label;
  return typeof label === 'string' && label ? label : null;
};

/** 注册表尺寸 → 宽高比（缺失 / 非法退 null，不用 0 或 NaN 撑容器）。 */
const ratioOfAsset = (asset: MediaAsset | null): number | null => {
  const width = asset?.original.width ?? null;
  const height = asset?.original.height ?? null;
  if (width === null || height === null || width <= 0 || height <= 0) return null;
  return Number((width / height).toFixed(4));
};

/** 资产条目 → 展示模型（缩略图优先，未 ready 时图退原图；视频只认 ready 缩略图当海报帧）。 */
const assetToItem = (
  assetId: string,
  asset: MediaAsset | null,
  canvasNodes: readonly GraphNode[],
): SessionMediaItem => {
  const hostNodes = findAssetNodes(canvasNodes, assetId);
  const assetName = (hostNodes[0] ? nodeLabelOf(hostNodes[0]) : null) ?? null;
  if (asset === null) {
    // 注册表查不到该资产：产物未就绪档（占位呈现，不给预览与引用出口）。
    return {
      key: assetId,
      assetId,
      kind: 'image',
      faceUrl: null,
      videoFaceUrl: null,
      previewUrl: null,
      name: assetName ?? MEDIA_PART_LABEL.image,
      aspectRatio: null,
      durationMs: null,
      unsettled: true,
      hostNodes: [],
    };
  }
  const kind = asset.mediaType;
  const thumbnailUrl = asset.thumbnail.status === 'ready' ? asset.thumbnail.url : null;
  const faceUrl = thumbnailUrl ?? (kind === 'image' ? asset.original.url : null);
  return {
    key: assetId,
    assetId,
    kind,
    faceUrl,
    videoFaceUrl: null,
    previewUrl: asset.original.url,
    name: assetName ?? MEDIA_PART_LABEL[kind],
    aspectRatio: ratioOfAsset(asset),
    durationMs: asset.original.durationMs ?? null,
    unsettled: false,
    hostNodes,
  };
};

/** 资产产物（工具结果 / 引用的资产 id 列表）→ 展示模型；列表引用未变时保持引用稳定。 */
export function useSessionMediaItems(assetIds: readonly string[]): SessionMediaItem[] {
  const mediaAssets = useCanvasStore((state) => state.mediaAssets);
  const canvasNodes = useCanvasStore((state) => state.nodeGraph?.nodes ?? EMPTY_NODES);
  return useMemo(
    () => assetIds.map((assetId) => assetToItem(assetId, mediaAssets[assetId] ?? null, canvasNodes)),
    [assetIds, mediaAssets, canvasNodes],
  );
}

/** 真实宽高比（未知时按类型缺省）。 */
export const mediaAspectRatio = (item: SessionMediaItem): number =>
  item.aspectRatio ?? TYPE_FALLBACK_RATIO[item.kind];

/** 单产物判定：恰好一个非音频产物时独占一条满幅媒体带（含失败 / 产物未就绪档）。 */
export const soloVisualItem = (items: readonly SessionMediaItem[]): SessionMediaItem | null => {
  const visual = items.filter((item) => item.kind !== 'audio');
  return visual.length === 1 ? visual[0] ?? null : null;
};

/** 单产物条目卡的收窄样式：卡宽 = min(100%, 240px × 真实比例)，靠左与流对齐。 */
export const soloMediaCardStyle = (
  items: readonly SessionMediaItem[],
): CSSProperties | undefined => {
  const solo = soloVisualItem(items);
  if (solo === null) return undefined;
  return { maxWidth: `min(100%, ${Math.round(SOLO_MAX_HEIGHT_PX * mediaAspectRatio(solo))}px)` };
};

/** 预览热区与「用作参考」按钮：两个独立控件（不嵌套在同一个 role=button 里）。 */
const PreviewHitArea = ({
  item,
  onOpen,
}: {
  item: SessionMediaItem;
  onOpen: () => void;
}) => (
  <button
    type="button"
    onClick={onOpen}
    aria-label={`${item.kind === 'video' ? '播放' : '预览'} ${item.name}`}
    data-testid="agent-asset-preview-trigger"
    className="absolute inset-0 z-10 cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  />
);

/**
 * 「用作参考」：hover 与 focus-within 出现；按**素材 ID** 直加（走既有 referenceOps 入口，
 * 不造第二引用语义）——产物只要还在资产注册表里就可加入参考，不要求画布上存在持有它的节点
 * （存量会话产物不补落节点，spec docs/agent/04 · AG-EX-002）；准入不过时给可见提示。
 */
const UseAsReferenceButton = ({ item }: { item: SessionMediaItem }) => {
  const assetId = item.assetId;
  if (assetId === null) return null;
  return (
    <button
      type="button"
      onClick={() => announceReferenceAddResult(addAssetIdsToReferences([assetId]))}
      aria-label={`将「${item.name}」用作参考`}
      data-testid="agent-asset-use-as-reference"
      className="absolute top-1.5 left-1.5 z-20 inline-flex items-center rounded-md border bg-popover px-1.5 py-px text-[11px] text-popover-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      用作参考
    </button>
  );
};

/** 视频海报卡的播放钮（44px scrim 圆底白图标，装饰层）与时长角标（时长缺失不渲染角标）。 */
const VideoPosterOverlay = ({ durationMs }: { durationMs: number | null }) => {
  const durationText = formatDuration(durationMs);
  return (
    <>
      <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
        <span className="flex size-11 items-center justify-center rounded-full bg-(--scrim-55) text-(--scrim-text)">
          <IconPlayerPlay size={18} />
        </span>
      </span>
      {durationText !== null ? (
        <span
          aria-hidden="true"
          data-testid="agent-media-video-duration"
          className="absolute right-1.5 bottom-1.5 rounded bg-(--scrim-70) px-1.5 text-[11px] tabular-nums text-(--scrim-text)"
        >
          {durationText}
        </span>
      ) : null}
    </>
  );
};

/**
 * 媒体格：比例盒（aspect-ratio 由真实比例驱动，宽随高上限反推，容器变窄按比例整体收小）。
 * 失败 / 产物未就绪档固定 96px 占位；加载完成 140ms 淡入。
 */
const MediaCell = ({ item, solo }: { item: SessionMediaItem; solo: boolean }) => {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  // 比例探针：注册表缺尺寸时用媒体自身 naturalWidth / naturalHeight 回填（不留空白盒）。
  const [probedRatio, setProbedRatio] = useState<number | null>(null);
  const ratio = probedRatio ?? mediaAspectRatio(item);
  const placeholder = item.unsettled || state === 'failed';
  const canPreview = !placeholder && item.previewUrl !== null;

  const handleFaceLoad = (event: SyntheticEvent<HTMLImageElement>): void => {
    const target = event.currentTarget;
    if (target.naturalWidth > 0 && target.naturalHeight > 0) {
      setProbedRatio(Number((target.naturalWidth / target.naturalHeight).toFixed(4)));
    }
    setState('ready');
  };

  const boxStyle: CSSProperties = placeholder
    ? { background: PLACEHOLDER_BACKGROUND[item.kind] }
    : {
        background: PLACEHOLDER_BACKGROUND[item.kind],
        aspectRatio: String(ratio),
        // 网格 cell：宽度上限 = 高度上限 × 比例（窄容器下按比例整体收小，不溢出也不裁切）
        width: solo ? '100%' : `min(100%, ${Math.round(CELL_MAX_HEIGHT_PX * ratio)}px)`,
      };

  return (
    <div
      className={cn(
        'group relative overflow-hidden',
        solo ? 'w-full' : 'rounded-md',
        placeholder && cn(PLACEHOLDER_HEIGHT_CLASS, 'w-full'),
      )}
      style={boxStyle}
      data-testid="agent-media-box"
      data-media-kind={item.kind}
      data-asset-id={item.assetId ?? undefined}
      data-state={item.unsettled ? 'unsettled' : state === 'failed' ? 'failed' : undefined}
    >
      {placeholder ? (
        <span
          className={cn(
            'absolute inset-0 flex items-center justify-center text-[11px]',
            state === 'failed' ? 'text-(--st-failed-text)' : 'text-muted-foreground',
          )}
        >
          {state === 'failed' ? '无法加载' : '产物未就绪'}
        </span>
      ) : item.videoFaceUrl !== null ? (
        // 用户消息的视频 part 只有直出文件地址：用 video 取首帧当海报（不给 img 塞视频文件）
        <video
          src={item.videoFaceUrl}
          className="agent-media-fade absolute inset-0 size-full object-cover"
          preload="metadata"
          muted
          playsInline
          tabIndex={-1}
          onLoadedMetadata={(event) => {
            // 直出视频的真实比例直到元数据到达才知道：同图片探针口径回填（不留固定 16/9 的错比例）。
            const video = event.currentTarget;
            if (video.videoWidth > 0 && video.videoHeight > 0) {
              setProbedRatio(Number((video.videoWidth / video.videoHeight).toFixed(4)));
            }
          }}
        >
          {/* 用户自己的素材没有字幕轨；空 captions 轨满足 media-has-caption（AssetPreviewDialog 同款） */}
          <track kind="captions" />
        </video>
      ) : item.faceUrl !== null ? (
        // eslint-disable-next-line @next/next/no-img-element -- 本地媒体（local-media 作用域地址），无优化管线可接
        <img
          src={item.faceUrl}
          alt=""
          className={cn(
            'absolute inset-0 size-full object-cover',
            state === 'ready' ? 'agent-media-fade' : 'opacity-0',
          )}
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={handleFaceLoad}
          onError={() => setState('failed')}
        />
      ) : null}
      {item.kind === 'video' ? <VideoPosterOverlay durationMs={item.durationMs} /> : null}
      {canPreview ? <PreviewHitArea item={item} onOpen={() => setPreviewOpen(true)} /> : null}
      {/* 产物可用即给参考出口（不要求画布上有持有它的节点）；用户消息的 media part 无资产身份，不给出口 */}
      {canPreview ? <UseAsReferenceButton item={item} /> : null}
      <AssetPreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        mediaType={item.kind}
        previewUrl={item.previewUrl}
        name={item.name}
      />
    </div>
  );
};

/**
 * 音频条：全宽 slim 卡（32px 播放钮 + 16 根静态波形 + 原生 seek + 时长 + 预览）。
 * 播放走隐藏 audio 元素接 original.url；时长未知显示「--:--」；seek 用原生 range（键盘可达）。
 */
const AudioBar = ({ item, inBand = false }: { item: SessionMediaItem; inBand?: boolean }) => {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [reportedDurationMs, setReportedDurationMs] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playable = item.previewUrl !== null;
  const durationText = formatDuration(item.durationMs ?? reportedDurationMs) ?? UNKNOWN_DURATION_TEXT;
  const filledBars = Math.round(progress * WAVE_BAR_HEIGHTS.length);

  const togglePlay = (): void => {
    const audio = audioRef.current;
    if (audio === null || !playable) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
      return;
    }
    const started: Promise<void> | undefined = audio.play();
    // 浏览器拒绝播放时回落到暂停态；测试环境（jsdom 不返回 Promise）不额外处理。
    void started?.catch(() => setPlaying(false));
    setPlaying(true);
  };

  const seekTo = (rawValue: number): void => {
    const audio = audioRef.current;
    const ratio = Math.min(1, Math.max(0, rawValue / SEEK_MAX));
    setProgress(ratio);
    if (audio !== null && Number.isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = ratio * audio.duration;
    }
  };

  return (
    <div
      className={cn(
        'flex h-12 items-center gap-2 px-2.5',
        // 满幅贴卡时去掉自带边框与圆角（卡 overflow-hidden 裁出轮廓），露出的卡底为 --secondary/30
        inBand ? 'rounded-none border-0 bg-card' : 'rounded-lg border bg-card',
      )}
      data-testid="agent-media-audio"
      data-state={playable ? 'ready' : 'unsettled'}
      aria-label={`音频：${item.name}`}
    >
      <button
        type="button"
        onClick={togglePlay}
        disabled={!playable}
        aria-pressed={playing}
        aria-label={`${playing ? '暂停' : '播放'} ${item.name}`}
        data-testid="agent-media-audio-play"
        className="flex size-8 flex-none items-center justify-center rounded-full bg-primary text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {playing ? <IconPlayerPause size={14} /> : <IconPlayerPlay size={14} />}
      </button>

      <span className="relative h-6 min-w-0 flex-1">
        <span aria-hidden="true" className="absolute inset-x-0 top-0 flex h-4 items-center gap-0.5">
          {WAVE_BAR_HEIGHTS.map((height, index) => (
            <i
              key={index}
              className={cn(
                'min-w-0.5 flex-1 rounded-[1px]',
                index < filledBars ? 'bg-primary' : 'bg-muted-foreground/35',
              )}
              style={{ height: `${height}px` }}
            />
          ))}
        </span>
        <input
          type="range"
          min={0}
          max={SEEK_MAX}
          step={1}
          value={Math.round(progress * SEEK_MAX)}
          disabled={!playable}
          onChange={(event) => seekTo(Number(event.target.value))}
          aria-label={`播放进度：${item.name}`}
          data-testid="agent-media-audio-seek"
          // 轨道与滑钮取 currentColor（形态在 agentSessionMedia.css），颜色仍走令牌
          className="agent-media-seek absolute inset-x-0 bottom-0 rounded-full text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
        />
      </span>

      <span className="flex-none text-[11px] tabular-nums text-muted-foreground" data-testid="agent-media-audio-duration">
        {durationText}
      </span>
      {playable ? (
        <Button
          type="button"
          variant="link"
          size="2xs"
          onClick={() => setPreviewOpen(true)}
          aria-label={`预览 ${item.name}`}
          data-testid="agent-media-audio-preview"
          className="flex-none"
        >
          预览
        </Button>
      ) : null}

      {playable ? (
        <>
          {/* 用户自有音频的播放面：无字幕轨可挂（AssetPreviewDialog 同款豁免） */}
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio
            ref={audioRef}
            src={item.previewUrl ?? undefined}
            preload="metadata"
            className="hidden"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => {
              setPlaying(false);
              setProgress(0);
            }}
            onTimeUpdate={(event) => {
              const audio = event.currentTarget;
              if (Number.isFinite(audio.duration) && audio.duration > 0) {
                setProgress(Math.min(1, audio.currentTime / audio.duration));
              }
            }}
            onLoadedMetadata={(event) => {
              const audio = event.currentTarget;
              if (Number.isFinite(audio.duration) && audio.duration > 0) {
                setReportedDurationMs(audio.duration * 1000);
              }
            }}
          />
          <AssetPreviewDialog
            open={previewOpen}
            onOpenChange={setPreviewOpen}
            mediaType="audio"
            previewUrl={item.previewUrl}
            name={item.name}
          />
        </>
      ) : null}
    </div>
  );
};

/**
 * 媒体带：工具条目卡的媒体面（满幅贴卡下半部，露出的卡底为 --secondary/30）。
 * 单产物独占一条；>1 产物两列 flex-wrap（cell 高上限 140）；音频条恒为整行 slim 卡。
 */
export const MediaBand = ({ items }: { items: readonly SessionMediaItem[] }) => {
  if (items.length === 0) return null;
  const solo = soloVisualItem(items);
  const gridItems = solo === null ? items.filter((item) => item.kind !== 'audio') : [];
  const audioItems = items.filter((item) => item.kind === 'audio');
  return (
    <div className="flex flex-col gap-1.5 bg-secondary/30" data-testid="agent-media-band">
      {solo !== null ? <MediaCell item={solo} solo /> : null}
      {gridItems.length > 1 ? (
        <div className="flex flex-wrap items-start gap-1.5">
          {gridItems.map((item) => (
            <MediaCell key={item.key} item={item} solo={false} />
          ))}
        </div>
      ) : null}
      {audioItems.length > 0 ? (
        <div className="flex flex-col">
          {audioItems.map((item) => (
            <AudioBar key={item.key} item={item} inBand />
          ))}
        </div>
      ) : null}
    </div>
  );
};

/** 用户消息内多模态 part：与产物媒体同一套呈现（图 / 视频海报 / 音频条 + 预览）。 */
export const UserMediaPart = ({
  type,
  url,
}: {
  type: SessionMediaKind;
  url: string;
}) => {
  const item: SessionMediaItem = useMemo(
    () => ({
      key: `${type}:${url}`,
      assetId: null,
      kind: type,
      faceUrl: type === 'audio' ? null : url,
      videoFaceUrl: type === 'video' ? url : null,
      previewUrl: url,
      name: MEDIA_PART_LABEL[type],
      aspectRatio: null,
      durationMs: null,
      unsettled: false,
      hostNodes: [],
    }),
    [type, url],
  );
  return type === 'audio' ? <AudioBar item={item} /> : <MediaCell item={item} solo={false} />;
};

/** 审批面板条目里的引用缩略（34×26 预览钮；引用本身不是产物，不占媒体带）。 */
const ReferenceChip = ({ item }: { item: SessionMediaItem }) => {
  const [previewOpen, setPreviewOpen] = useState(false);
  const placeholder = item.unsettled || item.faceUrl === null;
  const face = (
    <span
      className="block size-full"
      style={{ background: PLACEHOLDER_BACKGROUND[item.kind] }}
    >
      {item.faceUrl !== null && !item.unsettled ? (
        // eslint-disable-next-line @next/next/no-img-element -- 本地媒体（local-media 作用域地址），无优化管线可接
        <img src={item.faceUrl} alt="" className="size-full object-cover" loading="lazy" draggable={false} />
      ) : null}
    </span>
  );
  if (placeholder || item.previewUrl === null) {
    return (
      <span
        className="block h-[26px] w-[34px] overflow-hidden rounded-sm border"
        data-testid="agent-media-reference"
        data-asset-id={item.assetId ?? undefined}
      >
        {face}
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setPreviewOpen(true)}
        aria-label={`查看参考：${item.name}`}
        title={item.name}
        data-testid="agent-media-reference"
        data-asset-id={item.assetId ?? undefined}
        className="block h-[26px] w-[34px] overflow-hidden rounded-sm border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {face}
      </button>
      <AssetPreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        mediaType={item.kind}
        previewUrl={item.previewUrl}
        name={item.name}
      />
    </>
  );
};

/** 审批面板条目的引用缩略图组（提案的输入引用；预览走同一预览浮层）。 */
export const ReferenceAssetChips = ({ assetIds }: { assetIds: readonly string[] }) => {
  const items = useSessionMediaItems(assetIds);
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="agent-media-references">
      {items.map((item) => (
        <ReferenceChip key={item.key} item={item} />
      ))}
    </div>
  );
};
