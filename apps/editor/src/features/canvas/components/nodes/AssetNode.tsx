'use client';

import { memo, useMemo, useState } from 'react';
import type { NodeProps } from '@xyflow/react';
import { IconDownload, IconFolder, IconMaximize } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { ZoomableImagePreview } from '@/components/ui/zoomable-image-preview';
import { revealFilesUrlWithToast } from '@/client/utils/revealFilesUrlWithToast';
import { downloadMedia } from '@/client/utils/download';
import { useCanvasStore } from '../../store/canvasStore';
import { useNodeFromStore } from '../../hooks/useNodeFromStore';
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
 * 选中态双层 chrome（顶栏加工工具 / 底栏路由动作）由 AssetNodeChrome 承载。
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

  const [previewOpen, setPreviewOpen] = useState(false);

  const typed = nodeData as AssetNodeData;
  const original = mediaAsset?.original ?? null;
  const previewUrl = original?.url ?? null;
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
      fallbackExtension: typed.mediaType === 'video' ? 'mp4' : 'png',
      mimeType: undefined,
    }).catch((error) => {
      console.error('[AssetNode] 下载失败', error);
    });
  };

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
          setPreviewOpen(false);
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
        'asset-node pointer-events-auto h-full w-full' + (selected ? ' is-selected' : '')
      }
    >
      <div className="asset-surface">
        {previewUrl ? (
          typed.mediaType === 'video' ? (
            <video
              src={previewUrl}
              className="asset-media"
              muted
              playsInline
              preload="metadata"
              draggable={false}
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

        {/* hover 元信息条 */}
        {previewUrl && hoverMetaText ? (
          <div className="asset-hover-meta">{hoverMetaText}</div>
        ) : null}

        {/* D22/H1 · hover 个体动作（暗 scrim 圆钮）：放大预览 / 下载（生成资产不可变，无替换） */}
        {previewUrl && (typed.mediaType === 'image' || typed.mediaType === 'video') ? (
          <div className="asset-media-quick">
            <button
              type="button"
              className="nodrag"
              aria-label="放大预览"
              title="放大预览"
              onClick={(event) => {
                event.stopPropagation();
                setPreviewOpen(true);
              }}
            >
              <IconMaximize size={14} />
            </button>
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

      {/* 放大预览（image 走 ZoomableImagePreview；video 走原生控件模态；两态共用同一份工具栏） */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
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
                src={previewUrl ?? ''}
                controls
                autoPlay
                className="max-h-full max-w-full"
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
