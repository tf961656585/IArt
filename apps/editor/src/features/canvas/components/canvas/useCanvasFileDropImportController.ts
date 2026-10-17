'use client';

import { useCallback, type DragEvent } from 'react';

import type { DynamicRecord } from '@/client/utils/typeGuards';
import { toast } from 'sonner';
import { importLocalFile } from '../../services/localMediaImport';
import { resolveMediaKindFromFile } from '../../utils/mediaFileKind';
import { useCanvasStore } from '../../store/canvasStore';
import type { NodePosition } from '../../types';

async function getAudioDurationFromFile(file: File): Promise<number> {
  if (!file || typeof document === 'undefined') return 0;

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

type UseCanvasFileDropImportControllerArgs = {
  screenToFlowPosition: (position: { x: number; y: number }) => NodePosition;
  addNode: (key: string, position: NodePosition, customData: DynamicRecord | undefined) => { id: string } | null;
} & (
  | {
      selectNodes: (nodeIds: string[], reason: string) => void;
    }
	  | {
	      selectNodes: undefined;
	    }
	  | Record<never, never>
	);

export const useCanvasFileDropImportController = (
  args: UseCanvasFileDropImportControllerArgs,
) => {
  const { screenToFlowPosition, addNode } = args;
  const selectNodes =
    "selectNodes" in args ? args.selectNodes : undefined;
  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();

      const droppedFiles = Array.from(event.dataTransfer.files ?? []).filter(
        (file) => file && typeof file === 'object',
      );

      if (droppedFiles.length > 0) {
        const target = event.target as HTMLElement | null;
        const targetNodeElement = target !== null && target !== undefined
          ? target.closest('.react-flow__node') as HTMLElement | null
          : null;
        if (targetNodeElement) {
          const targetNodeId = (
            targetNodeElement.getAttribute('data-id') ||
            targetNodeElement.getAttribute('data-nodeid') ||
            (targetNodeElement.dataset !== null && targetNodeElement.dataset !== undefined ? targetNodeElement.dataset['id'] : undefined) ||
            (targetNodeElement.dataset !== null && targetNodeElement.dataset !== undefined ? targetNodeElement.dataset['nodeid'] : undefined) ||
            ''
          ).trim();

          const graph = useCanvasStore.getState().nodeGraph;
          const graphNodes = graph !== null && graph !== undefined ? graph.nodes : [];
          const targetNode = targetNodeId ? graphNodes.find((node) => node.id === targetNodeId) : undefined;
          const targetNodeType = targetNode !== null && targetNode !== undefined ? targetNode.type : null;
          if (targetNodeType === 'imageInput' || targetNodeType === 'audioInput' || targetNodeType === 'videoInput') {
            console.debug('[NodeCanvas] skip file drop on media input node', { targetNodeId, targetNodeType });
            return;
          }
        }

        const basePosition = screenToFlowPosition({ x: event.clientX, y: event.clientY });
        basePosition.x -= 90;
        basePosition.y -= 25;

        toast.info(`正在导入 ${droppedFiles.length} 个文件...`);

        void (async () => {
          const createdNodeIds: string[] = [];
          const dropOffset = 40;

          for (const [index, file] of droppedFiles.entries()) {
            const kind = resolveMediaKindFromFile(file);
            if (!kind) {
              toast.error(`${file.name || '这个文件'} 放不到画布上，请换成图片、视频或音频`);
              continue;
            }

            const position = {
              x: basePosition.x + index * dropOffset,
              y: basePosition.y + index * dropOffset,
            };

            if (kind === 'image') {
              try {
                const { persistentUrl, assetId } = await importLocalFile(file);
                const node = addNode('imageInput', position, {
                  assetId,
                  imageUrl: persistentUrl,
                  imageMeta: null,
                  originalImageMeta: null,
                  resizePercent: 100,
                  valueSource: 'upload',
                  lastExecutionId: undefined,
                  lastSourceNodeId: undefined,
                  lastSourcePortId: undefined,
                });
                if (!node) {
                  toast.error('没能创建图片节点，请重试');
                  continue;
                }
                createdNodeIds.push(node.id);
              } catch (error) {
                console.error('[NodeCanvas] 导入图片失败', error);
                toast.error(`${file.name || '这张图片'} 没能导入，请重试`);
              }
              continue;
            }

            if (kind === 'audio') {
              try {
                const { persistentUrl, assetId } = await importLocalFile(file);
                const duration = await getAudioDurationFromFile(file);
                const node = addNode('audioInput', position, {
                  assetId,
                  audioUrl: persistentUrl,
                  duration,
                  valueSource: 'upload',
                  taskInfo: undefined,
                  lastExecutionId: undefined,
                  lastSourceNodeId: undefined,
                  lastSourcePortId: undefined,
                  segments: [],
                  segmentModeEnabled: false,
                });
                if (!node) {
                  toast.error('没能创建音频素材，请重试');
                  continue;
                }
                createdNodeIds.push(node.id);
              } catch (error) {
                console.error('[NodeCanvas] 导入音频失败', error);
                toast.error(`${file.name || '这段音频'} 没能导入，请重试`);
              }
              continue;
            }

            try {
              const { persistentUrl, assetId } = await importLocalFile(file);
              const node = addNode('videoInput', position, {
                assetId,
                videoUrl: persistentUrl,
                videoMeta: null,
                valueSource: 'upload',
                taskInfo: undefined,
                lastExecutionId: undefined,
                lastSourceNodeId: undefined,
                lastSourcePortId: undefined,
              });
              if (!node) {
                toast.error('没能创建视频节点，请重试');
                continue;
              }
              createdNodeIds.push(node.id);
            } catch (error) {
              console.error('[NodeCanvas] 导入视频失败', error);
              toast.error(`${file.name || '这个视频'} 没能导入，请重试`);
            }
          }

          if (createdNodeIds.length > 0) {
            if (selectNodes) {
              selectNodes(createdNodeIds, "file-drop-import");
            }
            toast.success(`已导入 ${createdNodeIds.length} 个节点`);
          }
        })();
        return;
      }

      const rawNodePayload = event.dataTransfer.getData('application/nodeGraph-node');
      if (!rawNodePayload) return;

      try {
        const parsed = JSON.parse(rawNodePayload) as { key: unknown | undefined; data: unknown | undefined };
        const rawKey = parsed.key;
        const key = typeof rawKey === 'string' ? rawKey.trim() : '';
        if (!key) return;

        const payloadData = (parsed !== null && parsed !== undefined ? parsed.data : undefined);
        const customData =
          payloadData && typeof payloadData === 'object' && !Array.isArray(payloadData)
            ? (payloadData as DynamicRecord)
            : undefined;

        if (customData) {
          const target = event.target as HTMLElement | null;
          const targetNodeElement = target !== null && target !== undefined
            ? target.closest('.react-flow__node') as HTMLElement | null
            : null;
          if (targetNodeElement) {
            console.debug('[NodeCanvas] skip custom node drop on existing flow node');
            return;
          }
        }

        const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
        position.x -= 90;
        position.y -= 25;

        if (customData) {
          addNode(key, position, customData);
        } else {
          addNode(key, position, undefined);
        }
      } catch (error) {
        console.error('Failed to parse dropped node data:', error);
      }
    },
    [addNode, screenToFlowPosition, selectNodes],
  );

  return {
    onDragOver,
    onDrop,
  };
};
