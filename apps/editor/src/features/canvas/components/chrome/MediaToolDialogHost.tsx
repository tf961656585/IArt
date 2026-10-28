'use client';

import { useEffect, useMemo } from 'react';

import { listRuntimeProjectedImageToImageModels } from '@/client/config/runtimeModelSelection';
import { useCanvasStore } from '../../store/canvasStore';
import type { ImageMeta, VideoMeta } from '../../types/node';
import { useCanvasSelectionBridge } from '../canvas/useCanvasSelectionBridge';
import { ImageAnnotateDialog } from '../dialogs/ImageAnnotateDialog';
import { ImageChromaKeyDialog } from '../dialogs/ImageChromaKeyDialog';
import { ImageCropDialog, type ImageCropRect } from '../dialogs/ImageCropDialog';
import { ImageDifferenceKeyDialog } from '../dialogs/ImageDifferenceKeyDialog';
import { ImageEdgeDetectDialog } from '../dialogs/ImageEdgeDetectDialog';
import { ImageOutpaintDialog } from '../dialogs/ImageOutpaintDialog';
import { ImageResizeDialog } from '../dialogs/ImageResizeDialog';
import { ImageSmartSplitDialog, type ImageSmartSplitDialogPayload } from '../dialogs/ImageSmartSplitDialog';
import { ImageSplitDialog, type ImageSplitDialogPayload } from '../dialogs/ImageSplitDialog';
import { VideoFrameCaptureDialog, type VideoFrameCaptureDialogPayload } from '../dialogs/VideoFrameCaptureDialog';
import { VideoSpriteSheetDialog, type SpriteSheetDialogPayload } from '../dialogs/VideoSpriteSheetDialog';
import { VideoTrimDialog, type VideoTrimDialogPayload } from '../dialogs/VideoTrimDialog';
import { topToolGroupsFor, type MediaChromeToolId } from './chromeModel';
import { closeMediaToolDialog, useMediaToolDialogStore } from './mediaToolDialogStore';
import { resolveChromeSubject } from './mediaNodeModel';
import {
  runAnnotate,
  runChromaKey,
  runCrop,
  runDiffKey,
  runEdgeDetect,
  runFrameCapture,
  runOutpaint,
  runResize,
  runSmartSplit,
  runSplit,
  runSpriteSheet,
  runTrim,
  type ToolCtx,
} from './mediaToolExecutors';

/**
 * 媒体加工弹窗宿主（两处加工入口共用的唯一弹窗渲染点）。
 *
 * 入口（媒体节点选中态工具栏、画布右键菜单）只调用 `openMediaToolDialog(nodeId, toolId)`，
 * 谁打开弹窗、作用于哪份资产、产出什么一律由本宿主按 `chrome` 的同一套主体投影与
 * 同一批执行器裁定：宿主自行从画布 store 读节点与资产注册表，用 `resolveChromeSubject`
 * 还原媒体主体，经 `useCanvasSelectionBridge` 注入派生节点的选中动作。
 *
 * 状态机（`open` 是唯一输入）：
 * - 无请求 → 不渲染任何弹窗；
 * - 有请求且主体可用、工具属于该媒体类型 → 打开对应弹窗；
 * - 有请求但节点已消失 / 资产不可访问（`available=false`）/ 工具不属于该媒体类型 /
 *   节点不再处于选中集合 → 自动关闭并清理请求（条件跳过留痕）。
 *
 * 本组件只渲染弹窗，不渲染工具栏（工具栏归 MediaNodeChrome）。
 */
export function MediaToolDialogHost() {
  const request = useMediaToolDialogStore((s) => s.open);
  const nodeGraph = useCanvasStore((s) => s.nodeGraph);
  const mediaAssets = useCanvasStore((s) => s.mediaAssets);
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds);
  const { selectNodes } = useCanvasSelectionBridge();

  const node = useMemo(
    () =>
      request === null
        ? undefined
        : nodeGraph?.nodes.find((candidate) => candidate.id === request.nodeId),
    [request, nodeGraph],
  );

  const subject = useMemo(
    () => (node === undefined ? null : resolveChromeSubject(node, mediaAssets)),
    [node, mediaAssets],
  );

  const toolId: MediaChromeToolId | null = request?.toolId ?? null;

  // 工具属于该媒体类型、主体可加工（源地址存在）才允许打开；否则按不可用处理。
  const toolAvailable = useMemo(() => {
    if (toolId === null || subject === null) return false;
    if (!subject.available || subject.sourceUrl.trim() === '') return false;
    return topToolGroupsFor(subject.mediaType).some((group) =>
      group.some((tool) => tool.id === toolId),
    );
  }, [toolId, subject]);

  const ctx = useMemo<ToolCtx | null>(
    () => (toolAvailable && subject !== null ? { subject, selectNodes } : null),
    [toolAvailable, subject, selectNodes],
  );

  // 主体不可用（节点已删 / 资产不可访问 / 工具与媒体类型不匹配）：自动关闭，不留死弹窗。
  useEffect(() => {
    if (request === null || ctx !== null) return;
    console.debug('[canvas:mediaToolDialog] close: subject unavailable', {
      nodeId: request.nodeId,
      toolId: request.toolId,
    });
    closeMediaToolDialog();
  }, [request, ctx]);

  // 选中节点变化：弹窗只服务被打开时的那一个节点，节点脱离选中集合即关闭。
  useEffect(() => {
    if (request === null) return;
    if (selectedNodeIds.includes(request.nodeId)) return;
    console.debug('[canvas:mediaToolDialog] close: node no longer selected', {
      nodeId: request.nodeId,
    });
    closeMediaToolDialog();
  }, [request, selectedNodeIds]);

  const sourceUrl = subject?.sourceUrl ?? '';

  const originalMeta = useMemo<ImageMeta | null>(() => {
    const width = subject?.mediaAsset?.original?.width;
    const height = subject?.mediaAsset?.original?.height;
    if (!width || !height) return null;
    return { width, height, aspectRatio: width / height };
  }, [subject]);

  const videoMeta = useMemo<VideoMeta | null>(() => {
    const original = subject?.mediaAsset?.original;
    if (!original?.width || !original?.height) return null;
    return {
      width: original.width,
      height: original.height,
      aspectRatio: original.width / original.height,
      fps: original.fps ?? undefined,
    };
  }, [subject]);

  if (ctx === null || subject === null || toolId === null) return null;

  const closeDialog = () => closeMediaToolDialog();
  const handleOpenChange = (next: boolean) => {
    if (!next) closeMediaToolDialog();
  };

  return (
    <>
      {subject.mediaType === 'image' ? (
        <>
          <ImageCropDialog
            open={toolId === 'crop'}
            onOpenChange={handleOpenChange}
            imageUrl={sourceUrl}
            onConfirm={async (rect: ImageCropRect) => {
              closeDialog();
              await runCrop(ctx, rect);
            }}
          />
          <ImageResizeDialog
            open={toolId === 'resize'}
            onOpenChange={handleOpenChange}
            originalMeta={originalMeta}
            currentPercent={100}
            defaultKernel="lanczos3"
            onConfirm={async (percent, kernel) => {
              closeDialog();
              await runResize(ctx, percent, kernel);
            }}
          />
          <ImageSplitDialog
            open={toolId === 'split'}
            onOpenChange={handleOpenChange}
            imageUrl={sourceUrl}
            onConfirm={async (payload: ImageSplitDialogPayload) => {
              closeDialog();
              await runSplit(ctx, payload);
            }}
          />
          <ImageSmartSplitDialog
            open={toolId === 'smartSplit'}
            onOpenChange={handleOpenChange}
            imageUrl={sourceUrl}
            onConfirm={async (payload: ImageSmartSplitDialogPayload) => {
              closeDialog();
              await runSmartSplit(ctx, payload);
            }}
          />
          <ImageOutpaintDialog
            open={toolId === 'outpaint'}
            onOpenChange={handleOpenChange}
            imageUrl={sourceUrl}
            initialModelId={undefined}
            modelOptions={outpaintModelOptions()}
            onConfirm={async (payload) => {
              closeDialog();
              await runOutpaint(ctx, payload);
            }}
          />
          <ImageEdgeDetectDialog
            open={toolId === 'edgeDetect'}
            onOpenChange={handleOpenChange}
            defaultThreshold={128}
            onConfirm={async (threshold) => {
              closeDialog();
              await runEdgeDetect(ctx, threshold);
            }}
          />
          <ImageChromaKeyDialog
            open={toolId === 'chromaKey'}
            onOpenChange={handleOpenChange}
            imageUrl={sourceUrl}
            onConfirm={async (params) => {
              closeDialog();
              await runChromaKey(ctx, params);
            }}
          />
          <ImageDifferenceKeyDialog
            open={toolId === 'diffKey'}
            onOpenChange={handleOpenChange}
            imageUrl={sourceUrl}
            onConfirm={async (params) => {
              closeDialog();
              await runDiffKey(ctx, params);
            }}
          />
          <ImageAnnotateDialog
            open={toolId === 'annotate'}
            onOpenChange={handleOpenChange}
            imageUrl={sourceUrl}
            onConfirm={async (blob) => {
              closeDialog();
              await runAnnotate(ctx, blob);
            }}
          />
        </>
      ) : null}
      {subject.mediaType === 'video' ? (
        <>
          <VideoTrimDialog
            open={toolId === 'trim'}
            onOpenChange={handleOpenChange}
            videoUrl={sourceUrl}
            onConfirm={async (payload: VideoTrimDialogPayload) => {
              closeDialog();
              await runTrim(ctx, payload);
            }}
          />
          <VideoFrameCaptureDialog
            open={toolId === 'frameCapture'}
            onOpenChange={handleOpenChange}
            videoUrl={sourceUrl}
            onConfirm={async (payload: VideoFrameCaptureDialogPayload) => {
              closeDialog();
              await runFrameCapture(ctx, payload.timeSec);
            }}
          />
          <VideoSpriteSheetDialog
            open={toolId === 'spriteSheet'}
            onOpenChange={handleOpenChange}
            videoUrl={sourceUrl}
            videoMeta={videoMeta}
            fps={videoMeta?.fps}
            onConfirm={(payload: SpriteSheetDialogPayload) => {
              closeDialog();
              void runSpriteSheet(ctx, payload);
            }}
          />
        </>
      ) : null}
    </>
  );
}

const outpaintModelOptions = () =>
  listRuntimeProjectedImageToImageModels().map((config) => ({
    modelId: config.modelId,
    label: config.label,
  }));

export default MediaToolDialogHost;
