'use client';

import { memo, useCallback, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { NodeProps } from '@xyflow/react';
import { IconAlertTriangle, IconDownload, IconFolder, IconMaximize } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { ZoomableImagePreview } from '@/components/ui/zoomable-image-preview';
import { VideoNodeSurface } from './shared/VideoNodeSurface';
import { AudioAssetSurface } from './shared/AudioAssetSurface';
import { revealFilesUrlWithToast } from '@/client/utils/revealFilesUrlWithToast';
import { downloadMedia } from '@/client/utils/download';
import { useCanvasStore } from '../../store/canvasStore';
import { useExecutionStore } from '../../store/executionStore';
import { useNodeFromStore } from '../../hooks/useNodeFromStore';
import { EMPTY_PREFLIGHT_ISSUES } from '../../types/executionPreflight';
import type { AssetNodeData, GraphNode } from '../../types/node';

/**
 * 资产节点渲染组件（媒体满幅面，docs/editor/visual-design.md §5.6 媒体表面三态）。
 *
 * 正式资产呈现：媒体满幅（image/video 无头栏无卡片内嵌边框），左上来源徽章
 * （黑底白字，媒体标注惯例，两主题一致），hover 显示媒体元信息条。
 * header 不再显示 model_id 头栏——来源模型身份经「复用」入口与溯源链路承载。
 * 选中态走 --select-ring + --select-glow（设计层 D28：Apple 式 accent 细环 + 柔光晕）。
 *
 * hover 个体动作（设计层 D22/H1）：节点右上暗 scrim 圆钮组 = 放大预览 / 下载
 * （不需选中即可用；生成资产不可变，无「替换」；删除归选中底栏 chrome）。
 * 选中态双层 chrome（顶栏加工工具 / 底栏路由动作）由 MediaNodeChrome 承载。
 */

type AssetNodeSelection = {
  node: GraphNode<AssetNodeData> | null;
  data: AssetNodeData;
};

const createFallbackAssetNode = (id: string): GraphNode<AssetNodeData> => ({
  id,
  type: 'asset' as const,
  position: { x: 0, y: 0 },
  data: {
    label: '资产',
    sourceBatchId: '',
    sourceTaskId: '',
    sourceModelId: '',
    mediaType: 'image',
    assetId: '',
  },
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

const MEDIA_TYPE_LABEL: Record<AssetNodeData['mediaType'], string> = {
  image: '图片资产',
  video: '视频资产',
  audio: '音频资产',
};

type AssetProblemKind = 'failed' | 'blocked';

/** 资产卡片上的加工问题摘要（失败 / 待处理，展开后显示原因与下一步） */
type AssetProblem = {
  kind: AssetProblemKind;
  headline: string;
  reasons: string[];
  hint: string;
};

const PROBLEM_HEADLINE: Record<AssetProblemKind, string> = {
  failed: '加工失败，点开看原因',
  blocked: '有参数要先处理，点开看原因',
};

const DEFAULT_BLOCKED_HINT = '按提示调整后可以再试一次。';

export const AssetNode = memo(function AssetNode({ id, selected }: NodeProps) {
  const { data: nodeData } = useNodeFromStore<AssetNodeData, AssetNodeSelection>({
    nodeId: id,
    fallback: createFallbackAssetNode(id),
    select: (snapshot) => ({ node: snapshot.node, data: snapshot.data }),
    equalityFn: (prev, next) => prev.node === next.node && prev.data === next.data,
  });

  const mediaAsset = useCanvasStore((state) =>
    state.mediaAssets[String((nodeData as AssetNodeData).assetId)] ?? null,
  );

  // 节点级加工问题（失败 / 待处理）：常驻在卡片上，重试开始或成功后由执行器清除。
  const processingIssue = useExecutionStore(
    (state) => state.processingIssueByNodeId[id] ?? null,
  );
  const preflightIssues = useExecutionStore(
    (state) => state.preflightIssuesByNodeId[id] ?? EMPTY_PREFLIGHT_ISSUES,
  );

  const [previewOpen, setPreviewOpen] = useState(false);
  const [problemOpen, setProblemOpen] = useState(false);
  const [previewStartTime, setPreviewStartTime] = useState(0);
  const inlineVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);

  const problem = useMemo<AssetProblem | null>(() => {
    const reasons: string[] = [];
    if (processingIssue !== null) reasons.push(processingIssue.message);
    for (const issue of preflightIssues) reasons.push(issue.message);
    if (processingIssue?.detail !== undefined) reasons.push(processingIssue.detail);
    const uniqueReasons = [...new Set(reasons.filter((reason) => reason.trim().length > 0))];
    if (processingIssue === null && uniqueReasons.length === 0) return null;
    const kind: AssetProblemKind =
      processingIssue?.kind === 'processing-failed' ? 'failed' : 'blocked';
    return {
      kind,
      headline: PROBLEM_HEADLINE[kind],
      reasons: uniqueReasons,
      hint: processingIssue?.hint ?? DEFAULT_BLOCKED_HINT,
    };
  }, [processingIssue, preflightIssues]);

  const typed = nodeData as AssetNodeData;
  const original = mediaAsset?.original ?? null;
  const previewUrl = original?.url ?? null;
  const videoAspectRatio =
    typeof original?.width === 'number' && typeof original?.height === 'number' && original.height > 0
      ? original.width / original.height
      : null;
  const hoverMetaText = useMemo(() => {
    const width = original?.width;
    const height = original?.height;
    const durationMs = original?.durationMs;
    const parts: string[] = [];
    if (width && height) parts.push(`${width}×${height}`);
    if (typed.mediaType === 'video' && typeof durationMs === 'number' && durationMs > 0) {
      const totalSeconds = Math.round(durationMs / 1000);
      parts.push(`${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`);
    }
    parts.push(MEDIA_TYPE_LABEL[typed.mediaType]);
    return parts.join(' · ');
  }, [original, typed.mediaType]);

  const handleDownload = () => {
    if (!previewUrl) return;
    void downloadMedia(previewUrl, {
      filename: typed.label || 'canvas-asset',
      fallbackExtension:
        typed.mediaType === 'video' ? 'mp4' : typed.mediaType === 'audio' ? 'm4a' : 'png',
      mimeType: undefined,
    }).catch((error) => {
      console.error('[AssetNode] 下载失败', error);
    });
  };

  /**
   * 打开放大预览（docs/editor/画布资产节点媒体播放-design.md §3.4/§3.5）：
   * 内联播放先暂停；视频记录当前进度，预览加载完成后从该进度继续。
   */
  const openPreview = useCallback(() => {
    if (typed.mediaType !== 'image' && typed.mediaType !== 'video') return;
    const startTime =
      typed.mediaType === 'video' ? (inlineVideoRef.current?.currentTime ?? 0) : 0;
    if (inlineVideoRef.current && !inlineVideoRef.current.paused) {
      inlineVideoRef.current.pause();
    }
    setPreviewStartTime(startTime);
    setPreviewOpen(true);
  }, [typed.mediaType]);

  /** 关闭预览时把预览进度写回内联视频，避免「关掉放大后跳回开头」。 */
  const handlePreviewOpenChange = useCallback(
    (open: boolean) => {
      setPreviewOpen(open);
      if (open || typed.mediaType !== 'video') return;
      const previewTime = previewVideoRef.current?.currentTime ?? 0;
      const inlineVideo = inlineVideoRef.current;
      if (inlineVideo && previewTime > 0) inlineVideo.currentTime = previewTime;
      setPreviewStartTime(0);
    },
    [typed.mediaType],
  );

  /** 图片节点双击打开预览（视频由 VideoNodeSurface 承担，音频双击切换播放/暂停）。 */
  const handleSurfaceDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (typed.mediaType !== 'image') return;
      if (event.target instanceof Element && event.target.closest('button')) return;
      event.stopPropagation();
      event.preventDefault();
      openPreview();
    },
    [typed.mediaType, openPreview],
  );

  // 预览工具栏（image / video 两态同形，docs/editor/本地文件快捷跳转.md LFJ-005）：
  // 下载 / 打开文件所在位置 / 关闭预览，三颗按钮与两态共用同一份 JSX，保证形态一致。
  const previewToolbar = (
    <>
      <Button
        type="button"
        variant="secondary"
        size="icon"
        aria-label="下载"
        onClick={(event) => {
          event.stopPropagation();
          handleDownload();
        }}
      >
        <IconDownload size={18} />
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="icon"
        aria-label="打开文件所在位置"
        title="打开文件所在位置"
        onClick={(event) => {
          event.stopPropagation();
          void revealFilesUrlWithToast(previewUrl ?? "", undefined);
        }}
      >
        <IconFolder size={18} />
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="icon"
        aria-label="关闭预览"
        onClick={() => {
          // 走统一的关闭通道：视频预览需要把进度写回内联播放器（§3.5）。
          handlePreviewOpenChange(false);
        }}
      >
        ×
      </Button>
    </>
  );

  return (
    <div
      data-asset-node={id}
      className={
        'asset-node pointer-events-auto relative h-full w-full' + (selected ? ' is-selected' : '')
      }
    >
      <div className="asset-surface" onDoubleClick={handleSurfaceDoubleClick}>
        {previewUrl ? (
          typed.mediaType === 'video' ? (
            <VideoNodeSurface
              lifecycleKey={`asset:${id}`}
              videoUrl={previewUrl}
              aspectRatio={videoAspectRatio}
              defaultAspectRatio={undefined}
              allowDrop={false}
              disabled={false}
              isLoading={false}
              preload="metadata"
              placeholder={null}
              overlay={undefined}
              objectFit="contain"
              controlsVisibility="always"
              controlsActive={false}
              showControls
              className={undefined}
              fill
              onDropFile={undefined}
              onLoadedMeta={undefined}
              presentation={null}
              clickToPlay
              playLabel={typed.label}
              onOpenPreview={openPreview}
              mediaElementRef={inlineVideoRef}
            />
          ) : typed.mediaType === 'audio' ? (
            <AudioAssetSurface
              audioUrl={previewUrl}
              label={typed.label}
              durationMs={original?.durationMs ?? undefined}
            />
          ) : (
            // 本地媒体（local-media://）直出，无远端优化诉求，与 ImageNodeSurface 同口径。
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewUrl}
              alt={typed.label}
              className="asset-media"
              draggable={false}
            />
          )
        ) : (
          <div className="asset-empty">
            <span className="text-xs text-muted-foreground">
              {MEDIA_TYPE_LABEL[typed.mediaType] ?? typed.label}
            </span>
          </div>
        )}

        {/* 左上来源徽章：黑底白字（媒体标注惯例，两主题一致） */}
        {typed.sourceModelId ? (
          <span className="asset-src-badge font-mono">{typed.sourceModelId}</span>
        ) : null}

        {/* hover 元信息条（有加工问题时让位给底部问题标记，避免同一位置叠字；音频卡片自带时长） */}
        {previewUrl && hoverMetaText && !problem && typed.mediaType !== 'audio' ? (
          <div className="asset-hover-meta">{hoverMetaText}</div>
        ) : null}

        {/* D22/H1 · hover 个体动作（暗 scrim 圆钮）：放大预览（视频/图片）+ 下载（全媒体）。
            音频没有可视放大语义，只给下载（2026-10-28 拍板）。 */}
        {previewUrl ? (
          <div className="asset-media-quick">
            {typed.mediaType !== 'audio' ? (
              <button
                type="button"
                className="nodrag"
                aria-label="放大预览"
                title="放大预览"
                onClick={(event) => {
                  event.stopPropagation();
                  openPreview();
                }}
              >
                <IconMaximize size={14} />
              </button>
            ) : null}
            <button
              type="button"
              className="nodrag"
              aria-label="下载"
              title="下载"
              onClick={(event) => {
                event.stopPropagation();
                handleDownload();
              }}
            >
              <IconDownload size={14} />
            </button>
          </div>
        ) : null}
      </div>

      {/*
        加工问题标记（失败 / 待处理）：常驻卡片左下角，点开展开原因与下一步。
        pointer-events-auto + nodrag 让标记本身可点，又不把整个节点变成拖拽区；
        标记只占底部一行，不遮挡右上角的 hover 快捷钮。
      */}
      {problem ? (
        <div className="nodrag pointer-events-auto absolute bottom-1 left-1 z-10 flex flex-col items-start gap-1">
          <button
            type="button"
            className="pointer-events-auto inline-flex max-w-[220px] items-center gap-1 rounded-sm bg-[var(--st-failed-fill)] px-1.5 py-0.5 text-[10px] font-medium leading-4 text-[var(--scrim-text)] shadow-sm"
            aria-expanded={problemOpen}
            aria-label={problem.headline}
            title={problem.headline}
            onClick={(event) => {
              event.stopPropagation();
              setProblemOpen((open) => !open);
            }}
          >
            <IconAlertTriangle size={12} className="shrink-0" />
            <span className="truncate">{problem.headline}</span>
          </button>
          {problemOpen ? (
            <div className="pointer-events-auto max-h-40 w-56 shrink-0 overflow-auto rounded border border-border bg-card/95 p-2 text-[11px] leading-4 text-foreground shadow-md">
              <ul className="list-disc space-y-1 pl-3.5">
                {problem.reasons.map((reason, index) => (
                  <li key={`${index}-${reason}`}>{reason}</li>
                ))}
              </ul>
              <p className="mt-1 text-muted-foreground">{problem.hint}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 放大预览（image 走 ZoomableImagePreview；video 走原生控件模态；两态共用同一份工具栏） */}
      <Dialog open={previewOpen} onOpenChange={handlePreviewOpenChange}>
        <DialogContent
          showCloseButton={false}
          form="canvas"
          // 图片预览容器必须撑满可用视口（docs/runtime/媒体放大预览交互契约.md「初始尺寸契约」）：
          // 高度只有 max-h 时百分比链退化为 auto，图片按自身比例撑开后被 overflow-hidden 裁切。
          // 视频分支沿用自身高度（h-[80vh]），不进 fill。
          fill={typed.mediaType !== "video"}
          className="bg-transparent p-0 shadow-none border-none"
        >
          <DialogTitle className="sr-only">资产预览</DialogTitle>
          {typed.mediaType === 'video' ? (
            <div className="relative flex h-[80vh] w-full items-center justify-center bg-black/80">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video
                ref={previewVideoRef}
                src={previewUrl ?? ''}
                controls
                autoPlay
                playsInline
                className="max-h-full max-w-full"
                onLoadedMetadata={(event) => {
                  const video = event.currentTarget;
                  if (previewStartTime > 0 && previewStartTime < video.duration) {
                    try {
                      video.currentTime = previewStartTime;
                    } catch (error) {
                      // 进度接力失败必须留痕，不静默降级（docs/editor/画布资产节点媒体播放-design.md §3.5）。
                      console.debug('[AssetNode] 预览进度接力失败，从头播放', error);
                    }
                  }
                }}
              />
              {/* 视频预览与图片预览同一形态的工具栏（右上角；视频原生控件在底部，不争位） */}
              <div className="absolute right-3 top-3 flex items-center gap-2">{previewToolbar}</div>
            </div>
          ) : (
            <ZoomableImagePreview
              src={previewUrl ?? ""}
              alt={typed.label}
              zoomable={Boolean(previewUrl)}
              emptyText="图片还没准备好，请稍后再试"
              surfaceClassName="bg-black/80"
              toolbar={previewToolbar}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
});

export default AssetNode;
