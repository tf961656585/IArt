'use client';

import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type { NodeProps } from '@xyflow/react';
import { IconUpload, IconX, IconScissors } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { getRuntimeProjectPath } from '@/client/store/runtimeStore';
import { ContentNodeCard } from './ContentNodeCard';
import { TaskStatusBadge } from './shared/TaskStatusBadge';
import { useCanvasStore } from '../../store/canvasStore';
import { useExecutionStore } from '../../store/executionStore';
import { ContentCacheManager } from '../../services/contentCacheManager';
import { importLocalFile } from '../../services/localMediaImport';
import { clearNodeOutput } from '../../storage';
import type { AudioInputNodeData } from '../../types';
import type { AudioSegment } from '../../types/audioSegment';
import { SegmentList } from './audio/SegmentList';
import { AudioSegmentDialog } from '../dialogs/AudioSegmentDialog';
import { getTaskStatusOverlayText } from '../../utils/taskStatusMeta';
import { resolveTaskFailurePresentation } from "../../utils/taskFailurePresentation";
import { normalizeLocalFileUrlWithQuery } from '../../utils/mediaUrl';
import { classifyMediaUrl } from '@/features/models/shared/mediaResolutionTypes';
import { revealTaskArchive } from '@iart/backend-sdk/electron-bridge';
import { createFallbackGraphNode, useNodeFromStore } from '../../hooks/useNodeFromStore';

const AUDIO_AREA_HEIGHT = 64;
const MIN_WIDTH = 200;

async function getAudioDurationFromFile(file: File): Promise<number> {
  if (!file) return 0;
  if (typeof document === 'undefined') return 0;

  return await new Promise<number>((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';

    const cleanup = () => {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        // ignore
      }
    };

    const handleLoadedMetadata = () => {
      const value = Number.isFinite(audio.duration) ? audio.duration : 0;
      cleanup();
      resolve(value);
    };

    const handleError = () => {
      cleanup();
      resolve(0);
    };

    audio.addEventListener('loadedmetadata', handleLoadedMetadata, { once: true });
    audio.addEventListener('error', handleError, { once: true });
    audio.src = objectUrl;
    audio.load();
  });
}

export const AudioInputNode = memo(function AudioInputNode({ id, data: _data, selected }: NodeProps) {
  const fallback = useMemo(
    () => createFallbackGraphNode<AudioInputNodeData>({ nodeId: id, type: 'audioInput', data: undefined }),
    [id]
  );
  const { data: nodeData } = useNodeFromStore<AudioInputNodeData>({ nodeId: id, fallback, select: (snapshot) => snapshot, equalityFn: () => undefined });
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const nodeGraphId = useCanvasStore((state) => (state.nodeGraph !== null && state.nodeGraph !== undefined ? state.nodeGraph.id : undefined) ?? '');
  const [isDragOver, setIsDragOver] = useState(false);
  const [isSegmentDialogOpen, setIsSegmentDialogOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  // 从 store 获取节点数据
  const { audioUrl, segments, segmentModeEnabled, duration, valueSource, taskInfo, mediaError } = useMemo(() => {
    const dataSource = (nodeData ?? null) as AudioInputNodeData | null;
    return {
      audioUrl: (dataSource !== null && dataSource !== undefined ? dataSource.audioUrl : undefined) ?? null,
      segments: (dataSource !== null && dataSource !== undefined ? dataSource.segments : undefined) ?? [],
      segmentModeEnabled: (dataSource !== null && dataSource !== undefined ? dataSource.segmentModeEnabled : undefined) ?? false,
      duration: (dataSource !== null && dataSource !== undefined ? dataSource.duration : undefined) ?? 0,
      valueSource: (dataSource !== null && dataSource !== undefined ? dataSource.valueSource : undefined),
      taskInfo: (dataSource !== null && dataSource !== undefined ? dataSource.taskInfo : undefined) ?? null,
      mediaError: (dataSource !== null && dataSource !== undefined ? dataSource.mediaError : undefined) ?? null,
    };
  }, [nodeData]);

  const rawAudioUrl = typeof audioUrl === 'string' ? audioUrl.trim() : '';
  const isLocalMedia = classifyMediaUrl(rawAudioUrl).kind === 'local-media';
  const localRuntimePath = rawAudioUrl ? normalizeLocalFileUrlWithQuery(rawAudioUrl) : null;
  const resolvedAudioUrl = isLocalMedia ? rawAudioUrl : (localRuntimePath ? localRuntimePath : null);
  const mediaErrorText = mediaError || (rawAudioUrl && !isLocalMedia && !localRuntimePath ? '结果还没取回本地，暂时无法预览' : '');
  const showMediaError = Boolean(mediaErrorText) && !resolvedAudioUrl;

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
        mediaType: 'audio',
      });
      toast.info('正在重新取回结果');
      return;
    }
    toast.info('暂时取不到结果，请稍后重试');
  }, [id, nodeGraphId]);

  const sourceBadgeLabel =
    valueSource === 'upload'
      ? '本地上传'
      : valueSource === 'upstream'
        ? '上游节点'
        : null;

  const taskStatus = taskInfo !== null && taskInfo !== undefined ? taskInfo.status : undefined;
  const overlayBadges =
    taskInfo || sourceBadgeLabel ? (
      <div className="pointer-events-none absolute left-2 top-2 z-10 flex flex-col gap-1">
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
    ) : null;

  const failurePanel =
    (taskInfo !== null && taskInfo !== undefined ? taskInfo.status : undefined) === 'failed' ? (
      <div className="mt-2 rounded-md bg-black/70 px-3 py-2 text-xs text-white">
        <div className="select-text break-words whitespace-pre-wrap">
          {(failurePresentation !== null && failurePresentation !== undefined ? failurePresentation.summary : undefined) ?? '生成失败'}
        </div>
        {(failurePresentation !== null && failurePresentation !== undefined ? failurePresentation.backendMessage : undefined) || (failurePresentation !== null && failurePresentation !== undefined ? failurePresentation.rawDetailText : undefined) ? (
          <details className="mt-1">
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
            className="mt-2"
            onClick={handleOpenTaskArchive}
          >
            打开任务文件夹
          </Button>
        ) : null}
      </div>
    ) : null;

  const handleFile = useCallback(
    async (file: File) => {
      if (!file || !file.type.startsWith('audio/') || !nodeGraphId) return;
      try {
        setIsUploading(true);
        const { persistentUrl, assetId } = await importLocalFile(file);

        // 获取音频时长（使用 metadata，避免完整解码造成卡顿）
        const audioDuration = await getAudioDurationFromFile(file);

          updateNodeData(id, {
            assetId,
            audioUrl: persistentUrl,
            duration: audioDuration,
            valueSource: 'upload',
            mediaError: undefined,
            taskInfo: undefined,
            lastExecutionId: undefined,
            lastSourceNodeId: undefined,
            lastSourcePortId: undefined,
            // 重置分段状态
            segments: [],
            segmentModeEnabled: false,
          }, undefined);
      } catch (error) {
        console.error('音频存储失败', error);
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

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragOver(true);
      event.dataTransfer.dropEffect = 'copy';
    },
    [],
  );

  const handleDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const relatedTarget = event.relatedTarget as Node | null;
      if (!relatedTarget || !event.currentTarget.contains(relatedTarget)) {
        setIsDragOver(false);
      }
    },
    [],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragOver(false);
      const file = (event.dataTransfer.files !== null && event.dataTransfer.files !== undefined ? event.dataTransfer.files[0] : undefined);
      if (file) {
        void handleFile(file);
      }
    },
    [handleFile],
  );

    const handleRemoveAudio = useCallback(() => {
      // 同时清除前端状态和后端索引，防止轮询同步恢复已删除的音频
      updateNodeData(id, {
        audioUrl: null,
        valueSource: undefined,
        mediaError: undefined,
        taskInfo: undefined,
        lastExecutionId: undefined,
        lastSourceNodeId: undefined,
        lastSourcePortId: undefined,
        duration: 0,
        segments: [],
        segmentModeEnabled: false,
      }, undefined);
      // 异步清除后端索引（不阻塞 UI）
      void clearNodeOutput(id);
    }, [id, updateNodeData]);

  // 处理分段保存
  const handleSegmentsSave = useCallback(
    (newSegments: AudioSegment[]) => {
      // 标记所有分段为未切分状态
      const resetSegments = newSegments.map((seg) => ({
        ...seg,
        sliced: false,
        segmentUrl: undefined,
      }));

      updateNodeData(id, {
        segments: resetSegments,
        segmentModeEnabled: resetSegments.length > 0,
      }, undefined);
    },
    [id, updateNodeData],
  );

  // 打开分段编辑弹窗
  const handleOpenSegmentDialog = useCallback(() => {
    setIsSegmentDialogOpen(true);
  }, []);

  return (
    <ContentNodeCard
      nodeId={id}
      selected={selected}
      overlay={undefined}
      contentRenderPolicy={undefined}
      identityHint={undefined}
      identityPlaceholder={undefined}
      minWidth={MIN_WIDTH}
      minHeight={undefined}
      width={undefined}
      fill={undefined}
      noPadding={undefined}
      className={undefined}
    >
      {/* 音频播放区域 */}
      <div className="relative group">
        <div
          className="relative overflow-hidden rounded-md border transition-colors focus-visible:outline-none"
          style={{ minHeight: AUDIO_AREA_HEIGHT }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {resolvedAudioUrl ? (
            <div className="flex h-full w-full items-center p-2">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <audio
                key={resolvedAudioUrl}
                src={resolvedAudioUrl}
                controls
                className="w-full h-8"
                onClick={(event) => event.stopPropagation()}
              />
            </div>
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              {isUploading ? (
                <span className="h-3 w-3 animate-spin rounded-full border border-muted-foreground/40 border-t-transparent" />
              ) : showMediaError ? (
                <div className="flex flex-col items-center gap-2 text-center">
                  <IconX size={20} className="text-destructive" />
                  <span className="text-xs font-medium text-destructive">{mediaErrorText}</span>
                  <Button
                    type="button"
                    size="2xs"
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
                <Button
                  type="button"
                  size="icon"
                  variant="secondary"
                  aria-label="上传音频"
                  onClick={(event) => {
                    event.stopPropagation();
                    triggerFileDialog();
                  }}
                >
                  <IconUpload size={18} />
                </Button>
              )}
            </div>
          )}

          {isDragOver && (
            <div className="pointer-events-none absolute inset-0 rounded-md border-2 border-primary/50 bg-primary/10" />
          )}

          {overlayBadges}
          {statusOverlay}
        </div>

        {resolvedAudioUrl && (
          <div className="pointer-events-none absolute inset-0 flex items-start justify-end gap-1 p-2 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              className="pointer-events-auto inline-flex h-6 w-6 items-center justify-center rounded-full bg-white/90 text-foreground shadow hover:bg-white"
              aria-label="替换音频"
              onClick={(event) => {
                event.stopPropagation();
                triggerFileDialog();
              }}
            >
              <IconUpload size={14} />
            </button>
            <button
              type="button"
              className="pointer-events-auto inline-flex h-6 w-6 items-center justify-center rounded-full bg-white/90 text-destructive shadow hover:bg-white"
              aria-label="删除音频"
              onClick={(event) => {
                event.stopPropagation();
                handleRemoveAudio();
              }}
            >
              <IconX size={14} />
            </button>
          </div>
        )}
      </div>

      {failurePanel}

      {/* 分段列表 */}
      {segmentModeEnabled && segments.length > 0 && (
        <SegmentList segments={segments} onEditClick={handleOpenSegmentDialog} />
      )}

      {/* 分段编辑按钮 */}
      {resolvedAudioUrl && (
        <Button
          type="button"
          size="2xs"
          variant="outline"
          className="w-full mt-2"
          onClick={(e) => {
            e.stopPropagation();
            handleOpenSegmentDialog();
          }}
        >
          <IconScissors size={14} className="mr-1" />
          {segments.length > 0 ? `编辑分段 (${segments.length})` : '添加分段'}
        </Button>
      )}

      {/* 分段编辑弹窗 */}
      <AudioSegmentDialog
        open={isSegmentDialogOpen}
        onOpenChange={setIsSegmentDialogOpen}
        audioUrl={resolvedAudioUrl}
        duration={duration}
        segments={segments}
        onSave={handleSegmentsSave}
      />

      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        accept="audio/*"
        onChange={handleFileChange}
        tabIndex={-1}
      />
    </ContentNodeCard>
  );
});

export default AudioInputNode;
