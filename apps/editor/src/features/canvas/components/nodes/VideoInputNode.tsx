'use client';

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type { NodeProps } from '@xyflow/react';
import { IconUpload, IconVideo, IconX } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { getRuntimeProjectPath } from '@/client/store/runtimeStore';
import { ContentNodeCard } from './ContentNodeCard';
import { VideoNodeSurface, DEFAULT_VIDEO_ASPECT_RATIO } from './shared/VideoNodeSurface';
import { TaskStatusBadge } from './shared/TaskStatusBadge';
import { useCanvasStore } from '../../store/canvasStore';
import { useExecutionStore } from '../../store/executionStore';
import { ContentCacheManager } from '../../services/contentCacheManager';
import { importLocalFile } from '../../services/localMediaImport';
import type { VideoInputNodeData, VideoMeta } from '../../types';
import { getTaskStatusOverlayText } from '../../utils/taskStatusMeta';
import { resolveTaskFailurePresentation } from "../../utils/taskFailurePresentation";
import { revealTaskArchive } from '@iart/backend-sdk/electron-bridge';
import { formatBytesCompact } from '../../utils/mediaSize';
import { normalizeLocalFileUrlWithQuery, resolveLocalRenderableMediaSource } from '../../utils/mediaUrl';
import { classifyMediaUrl } from '@/features/models/shared/mediaResolutionTypes';
import { createFallbackGraphNode, useNodeFromStore } from '../../hooks/useNodeFromStore';
import { resolveMediaPresentation } from '../../services/mediaPresentation';

export const VideoInputNode = memo(function VideoInputNode({ id, data: _data, selected }: NodeProps) {
  const fallback = useMemo(
    () => createFallbackGraphNode<VideoInputNodeData>({ nodeId: id, type: 'videoInput', data: undefined }),
    [id]
  );
  const { data: nodeData } = useNodeFromStore<VideoInputNodeData>({ nodeId: id, fallback, select: (snapshot) => snapshot, equalityFn: () => undefined });
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const nodeGraphId = useCanvasStore((state) => (state.nodeGraph !== null && state.nodeGraph !== undefined ? state.nodeGraph.id : undefined) ?? '');

  const { videoUrl, videoMeta, valueSource, taskInfo, mediaError, assetId } = useMemo(() => {
    const dataSource = (nodeData ?? null) as VideoInputNodeData | null;
    return {
      videoUrl: (dataSource !== null && dataSource !== undefined ? dataSource.videoUrl : undefined) ?? null,
      videoMeta: (dataSource !== null && dataSource !== undefined ? dataSource.videoMeta : undefined) ?? null,
      valueSource: (dataSource !== null && dataSource !== undefined ? dataSource.valueSource : undefined),
      taskInfo: (dataSource !== null && dataSource !== undefined ? dataSource.taskInfo : undefined) ?? null,
      mediaError: (dataSource !== null && dataSource !== undefined ? dataSource.mediaError : undefined) ?? null,
      assetId: (dataSource !== null && dataSource !== undefined ? dataSource.assetId : undefined) ?? null,
    };
  }, [nodeData]);

  const mediaAssets = useCanvasStore((state) => state.mediaAssets);

  // 视频上传状态
  const [isUploading, setIsUploading] = useState(false);

  const presentation = useMemo(() => {
    if (!assetId) return null;
    return resolveMediaPresentation({
      mediaAssets,
      assetId,
      mediaType: 'video',
      sourceUrl: videoUrl,
      projectRef: undefined,
      fileKey: undefined,
    });
  }, [assetId, mediaAssets, videoUrl]);

  const nodeDiagnosticInfo = useExecutionStore((state) => state.getNodeDiagnosticInfo(id, undefined));
  const backendMessageText = (nodeDiagnosticInfo !== null && nodeDiagnosticInfo !== undefined ? nodeDiagnosticInfo.backendMessage : undefined);
  const failurePresentation = resolveTaskFailurePresentation({ taskInfo, backendMessage: backendMessageText, fallback: undefined });
  const taskArchiveTaskId = (taskInfo !== null && taskInfo !== undefined ? taskInfo.taskId : undefined);

  const handleOpenTaskArchive = useCallback(
    async (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (!taskArchiveTaskId) {
        toast.warning('这次任务还没有日志，暂时打不开');
        return;
      }
      const result = await revealTaskArchive(taskArchiveTaskId, getRuntimeProjectPath());
      if (result.ok) {
        toast.success('已打开任务文件夹');
        return;
      }
      if (result.reason === 'not-found') {
        toast.error('这次任务的日志文件找不到了');
        return;
      }
      if (result.reason === 'missing-project-path') {
        toast.error('无法定位项目里的日志文件夹');
        return;
      }
      toast.error('打开任务文件夹失败，请稍后重试');
    },
    [taskArchiveTaskId]
  );

  const handleRetryMedia = useCallback(async () => {
    const cacheTask = ContentCacheManager.getTask(id);
    const cacheTaskUrl = cacheTask !== null && cacheTask !== undefined ? cacheTask.url : undefined;
    if (cacheTaskUrl && nodeGraphId) {
      ContentCacheManager.enqueue({
        nodeId: id,
        nodeGraphId,
        url: cacheTaskUrl,
        mediaType: 'video',
      });
      toast.info('正在重新取回结果');
      return;
    }
    toast.info('暂时取不到结果，请稍后重试');
  }, [id, nodeGraphId]);

  // 媒体展示尺寸由 Layout Model 媒体尺寸层全权派生（spec：画布节点尺寸管理架构.md
  // 「分类裁定表」videoInput 为 layoutModel 模式），不再经 desired producer。

  const handleFile = useCallback(
    async (file: File) => {
      if (!file || !file.type.startsWith('video/') || !nodeGraphId) return;
      setIsUploading(true);
      try {
        const { persistentUrl, assetId } = await importLocalFile(file);
        const normalizedUrl = normalizeLocalFileUrlWithQuery(persistentUrl) ?? persistentUrl;
        updateNodeData(id, {
          assetId,
          videoUrl: normalizedUrl,
          videoMeta: null,
          valueSource: 'upload',
          mediaError: undefined,
          taskInfo: undefined,
          lastExecutionId: undefined,
          lastSourceNodeId: undefined,
          lastSourcePortId: undefined,
        }, undefined);
      } catch (error) {
        console.error('视频上传失败', error);
      } finally {
        setIsUploading(false);
      }
    },
    [id, nodeGraphId, updateNodeData],
  );

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = (event.target.files !== null && event.target.files !== undefined ? event.target.files[0] : undefined);
      if (file) {
        void handleFile(file);
      }
      event.target.value = '';
    },
    [handleFile],
  );

  const triggerFileDialog = useCallback(() => {
    if (fileInputRef.current !== null && fileInputRef.current !== undefined) {
      fileInputRef.current.click();
    }
  }, []);

  const handleVideoMeta = useCallback(
    (meta: VideoMeta) => {
      if (!meta) return;
      let fps = meta.fps;
      if (fps === undefined && assetId) {
        const asset = mediaAssets[assetId];
        if (asset !== null && asset !== undefined && asset.original !== null && asset.original !== undefined && asset.original.fps != null) {
          fps = asset.original.fps;
        }
      }
      const enrichedMeta: VideoMeta = { ...meta, fps };
      const prev = videoMeta;
      const unchanged =
        prev &&
        prev.width === enrichedMeta.width &&
        prev.height === enrichedMeta.height &&
        prev.aspectRatio === enrichedMeta.aspectRatio &&
        prev.fps === enrichedMeta.fps;
      if (!unchanged) {
        updateNodeData(id, { videoMeta: enrichedMeta }, undefined);
      }
    },
    [id, updateNodeData, videoMeta, assetId, mediaAssets],
  );

  useEffect(() => {
    if (videoMeta === null || videoMeta === undefined) return;
    if (videoMeta.fps !== undefined) return;
    if (assetId === null || assetId === undefined) return;
    const asset = mediaAssets[assetId];
    const assetFps = (asset !== null && asset !== undefined && asset.original !== null && asset.original !== undefined) ? asset.original.fps : undefined;
    if (assetFps === null || assetFps === undefined) return;
    updateNodeData(id, { videoMeta: { ...videoMeta, fps: assetFps } }, undefined);
  }, [videoMeta, assetId, mediaAssets, id, updateNodeData]);

  const placeholderText = '拖拽视频到此处，或使用上传按钮';
  const rawVideoUrl = typeof videoUrl === 'string' ? videoUrl.trim() : '';
  const isLocalMedia = classifyMediaUrl(rawVideoUrl).kind === 'local-media';
  const localRuntimePath = rawVideoUrl ? normalizeLocalFileUrlWithQuery(rawVideoUrl) : null;
  const resolvedVideoSource = resolveLocalRenderableMediaSource(rawVideoUrl);
  const resolvedVideoUrl = isLocalMedia ? rawVideoUrl : (resolvedVideoSource.renderUrl ?? undefined);

  const mediaErrorText = mediaError || (rawVideoUrl && !isLocalMedia && !localRuntimePath ? '结果还没取回本地，暂时无法预览' : '');
  const surfacePlaceholder = mediaErrorText ? (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center">
      <IconX size={22} className="text-destructive" />
      <span className="text-xs font-medium text-destructive">{mediaErrorText}</span>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="pointer-events-auto"
        onClick={(event) => {
          event.stopPropagation();
          void handleRetryMedia();
        }}
      >
        重新取回结果
      </Button>
    </div>
  ) : (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center">
      <IconVideo size={24} />
      <span className="text-xs font-medium">{placeholderText}</span>
      <Button
        variant="secondary"
        size="sm"
        type="button"
        className="pointer-events-auto"
        onClick={(event) => {
          event.stopPropagation();
          triggerFileDialog();
        }}
      >
        <IconUpload size={14} className="mr-1" /> 上传视频
      </Button>
    </div>
  );

  const sourceBadgeLabel =
    valueSource === 'upload'
      ? '本地上传'
      : valueSource === 'upstream'
        ? '上游节点'
        : null;

  const presentationHoverMeta =
    presentation !== null && presentation !== undefined
      ? presentation.hoverMeta
      : undefined;
  const videoMetaWidth =
    videoMeta !== null && videoMeta !== undefined ? videoMeta.width : undefined;
  const videoMetaHeight =
    videoMeta !== null && videoMeta !== undefined ? videoMeta.height : undefined;
  const hoverInfoText = useMemo(() => {
    const hoverMeta = presentationHoverMeta;
    const width = (hoverMeta !== null && hoverMeta !== undefined ? hoverMeta.width : undefined) ?? videoMetaWidth;
    const height = (hoverMeta !== null && hoverMeta !== undefined ? hoverMeta.height : undefined) ?? videoMetaHeight;
    const resolution = width && height ? `${width}×${height}` : '未知分辨率';
    const sizeBytes = (hoverMeta !== null && hoverMeta !== undefined ? hoverMeta.sizeBytes : undefined);
    const size = sizeBytes != null ? formatBytesCompact(sizeBytes) : '未知大小';
    return `${resolution} · ${size}`;
  }, [presentationHoverMeta, videoMetaHeight, videoMetaWidth]);

  const taskStatus = taskInfo !== null && taskInfo !== undefined ? taskInfo.status : undefined;
  const overlayBadges =
    taskInfo || sourceBadgeLabel ? (
      <div className="pointer-events-none absolute left-2 top-2 flex flex-col gap-1">
        {taskStatus ? (
          <TaskStatusBadge
            status={taskStatus}
            className={undefined}
            compact={undefined}
            labelOverride={undefined}
            onActivate={() => undefined}
            ariaLabel={undefined}
          />
        ) : null}
        {sourceBadgeLabel ? (
          <div className="inline-flex items-center rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium uppercase text-white">
            {sourceBadgeLabel}
          </div>
        ) : null}
      </div>
    ) : null;

  const overlayStatusText = getTaskStatusOverlayText((taskInfo !== null && taskInfo !== undefined ? taskInfo.status : undefined), (taskInfo !== null && taskInfo !== undefined && taskInfo.progress !== null && taskInfo.progress !== undefined ? taskInfo.progress.phase : undefined) as string | undefined);

  const statusOverlay =
    overlayStatusText ? (
      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
        <div className="flex items-center gap-2 rounded-md bg-black/55 px-3 py-1.5 text-xs text-white">
          <span className="h-3 w-3 animate-spin rounded-full border border-white/40 border-t-transparent" />
          <span>{overlayStatusText}</span>
        </div>
      </div>
    ) : (taskInfo !== null && taskInfo !== undefined ? taskInfo.status : undefined) === 'failed' ? (
      <div className="pointer-events-none absolute inset-x-2 bottom-2 z-10 rounded-md bg-black/70 px-3 py-2 text-xs text-white">
        <div className="pointer-events-auto select-text break-words whitespace-pre-wrap">
          {(failurePresentation !== null && failurePresentation !== undefined ? failurePresentation.summary : undefined) ?? '生成失败'}
        </div>
        {(failurePresentation !== null && failurePresentation !== undefined ? failurePresentation.backendMessage : undefined) || (failurePresentation !== null && failurePresentation !== undefined ? failurePresentation.rawDetailText : undefined) ? (
          <details className="pointer-events-auto mt-1">
            <summary className="cursor-pointer select-none text-[10px] text-white/80">详情</summary>
            <pre className="mt-1 whitespace-pre-wrap break-words text-[10px] text-white/90">
              {(failurePresentation !== null && failurePresentation !== undefined ? failurePresentation.backendMessage : undefined) ?? (failurePresentation !== null && failurePresentation !== undefined ? failurePresentation.rawDetailText : undefined)}
            </pre>
          </details>
        ) : null}
        {taskArchiveTaskId ? (
          <Button
            type="button"
            size="2xs"
            variant="secondary"
            className="pointer-events-auto mt-2"
            onClick={handleOpenTaskArchive}
          >
            打开任务文件夹
          </Button>
        ) : null}
      </div>
    ) : null;

  return (
    <ContentNodeCard
      nodeId={id}
      selected={selected}
      overlay={undefined}
      contentRenderPolicy={undefined}
      identityHint={undefined}
      identityPlaceholder={undefined}
      fill
      width={undefined}
      minWidth={undefined}
      minHeight={undefined}
      noPadding
      className={undefined}
    >
      <div className="relative focus-visible:outline-none group h-full">
          <VideoNodeSurface
            lifecycleKey={id}
            presentation={presentation}
            videoUrl={resolvedVideoUrl ?? undefined}
            aspectRatio={(videoMeta !== null && videoMeta !== undefined ? videoMeta.aspectRatio : undefined) ?? null}
            defaultAspectRatio={DEFAULT_VIDEO_ASPECT_RATIO}
            allowDrop
            disabled={false}
          isLoading={isUploading}
          preload={undefined}
          objectFit="contain"
          controlsVisibility="hover"
          controlsActive={selected}
          showControls={undefined}
          className={undefined}
          fill
          placeholder={surfacePlaceholder}
          overlay={
            <>
              {overlayBadges}
              {statusOverlay}

              {resolvedVideoUrl ? (
                <div className="pointer-events-none absolute inset-x-2 bottom-2 z-10 flex justify-start opacity-0 transition-opacity group-hover:opacity-100">
                  <div className="inline-flex items-center rounded-md bg-black/55 px-2 py-1 text-[10px] font-medium text-white">
                    {hoverInfoText}
                  </div>
                </div>
              ) : null}

              {videoUrl && (
                <div className="pointer-events-none absolute inset-0 flex items-start justify-end gap-1 p-2 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    type="button"
                    className="pointer-events-auto inline-flex h-6 w-6 items-center justify-center rounded-full bg-white/90 text-foreground shadow hover:bg-white"
                    aria-label="替换视频"
                    onClick={(event) => {
                      event.stopPropagation();
                      triggerFileDialog();
                    }}
                  >
                    <IconUpload size={14} />
                  </button>
                </div>
              )}
            </>
          }
          onDropFile={(file) => {
            void handleFile(file);
          }}
          onLoadedMeta={handleVideoMeta}
        />
      </div>

      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        accept="video/*"
        onChange={handleFileChange}
        tabIndex={-1}
      />
    </ContentNodeCard>
  );
});

export default VideoInputNode;
