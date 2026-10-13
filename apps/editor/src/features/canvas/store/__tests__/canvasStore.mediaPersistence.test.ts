import { beforeEach, describe, expect, it } from 'vitest';

import { buildProjectDelta, useCanvasStore } from '../canvasStore';
import { createNodeGraph } from '../../types/nodeGraph';
import type { GraphNode, ImageInputNodeData, ModelNodeData, ResultAreaFormalSlot } from '../../types/node';
import {
  createGraphNodeFixture,
  createMediaAssetFixture,
  createModelDataFixture,
  createModelNodeFixture,
  createNodeTaskInfoFixture,
  createResultAreaMediaSlotFixture,
} from '../../components/__tests__/fixtures/canvasTestBuilders';
import { createResultAreaEmbeddedData } from '../../services/resultAreaEmbeddedFactory';

const resetStore = () => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.mediaAssets = {};
    state.selectedNodeIds = [];
    state.selectedAnnotationIds = [];
    state.hasUnsavedChanges = false;
    state.dirtyRevision = 0;
    state.dirty = {
      graph: false,
      viewport: false,
      fullReplace: false,
      mediaAssets: false,
      nodes: {},
      removedNodes: {},
    };
  });
};

describe('canvasStore media persistence contract', () => {
  beforeEach(() => {
    resetStore();
  });

  it('buildProjectDelta(forceFullReplace) 保留 ResultArea 正式内容并剥离运行时投影', () => {
    const graph = createNodeGraph({ name: 'runtime-ref-only', description: undefined, tags: undefined, category: undefined });
    graph.id = 'graph-runtime-ref-only';
    graph.nodes = [
      createModelNodeFixture({
        id: 'resultArea-1',
        position: { x: 0, y: 0 },
        data: createModelDataFixture({
          resultArea: createResultAreaEmbeddedData({
            outputSlotIds: undefined,
            targetKeyId: 'resultArea-1',
            slots: [
              createResultAreaMediaSlotFixture({
                id: 'item-1',
                targetKey: 'resultArea_resultArea-1_item-1',
                itemType: 'media',
                assetId: 'asset-runtime-1',
                value: '/files/generated.png',
                mediaType: 'image',
                displayAspectRatio: 1.5,
                expectedAspectRatio: 1.5,
                errorDetails: {
                  backendMessage: 'runtime detail',
                  userMessage: 'runtime detail',
                  retryable: false,
                },
                createdAt: 1,
                updatedAt: 1,
                origin: {
                  sourceNodeId: 'model-1',
                  executionId: 'exec-1',
                  batchId: 'batch-1',
                  taskId: 'resultArea-task-1',
                },
                taskInfo: {
                  ...createNodeTaskInfoFixture(),
                  taskId: 'resultArea-task-1',
                  taskIndex: 0,
                  modelId: 'model-1',
                  status: 'succeeded',
                  createdAt: 1,
                  updatedAt: 1,
                },
              }),
              createResultAreaMediaSlotFixture({
                id: 'item-2',
                targetKey: 'resultArea_resultArea-1_item-2',
                itemType: 'text',
                assetId: null,
                textValue: 'formal text',
                value: 'runtime text preview',
                mediaType: 'text',
                displayAspectRatio: 1,
                createdAt: 2,
                updatedAt: 2,
                origin: {
                  sourceNodeId: 'model-1',
                  executionId: 'exec-1',
                  batchId: 'batch-1',
                  taskId: 'resultArea-task-2',
                },
                taskInfo: {
                  ...createNodeTaskInfoFixture(),
                  taskId: 'resultArea-task-2',
                  taskIndex: 1,
                  modelId: 'model-1',
                  status: 'succeeded',
                  createdAt: 2,
                  updatedAt: 2,
                },
              }),
            ],
            collapsed: false,
          }),
        }),
      }),
      createGraphNodeFixture<ImageInputNodeData>({
        id: 'image-1',
        type: 'imageInput',
        position: { x: 0, y: 0 },
        data: {
          label: undefined,
          description: undefined,
          runtimeRef: undefined,
          assetId: null,
          imageUrl: '/files/generated.png',
          imageMeta: undefined,
          lastExecutionId: undefined,
          lastSourceNodeId: undefined,
          lastSourcePortId: undefined,
          valueSource: 'upstream',
          mediaError: undefined,
          derivedFromNodeId: undefined,
          derivedOp: undefined,
          taskInfo: {
            ...createNodeTaskInfoFixture(),
            taskId: 'image-task-1',
            taskIndex: 0,
            modelId: 'model-1',
            status: 'succeeded',
            createdAt: 1,
            updatedAt: 1,
          },
          cachedContent: undefined,
          originalImageMeta: undefined,
          resizePercent: undefined,
          outpaintModelId: undefined,
        },
      }),
    ];

    const { delta } = buildProjectDelta(
      {
        nodeGraph: graph,
        mediaAssets: {
          'asset-runtime-1': createMediaAssetFixture({
            id: 'asset-runtime-1',
            mediaType: 'image',
            original: {
              url: '/files/generated.png',
              projectRef: 'project-a',
              fileKey: 'images/asset-runtime-1',
              sourceUrl: '/files/generated.png',
              sourceFileName: null,
              mimeType: 'image/png',
              sizeBytes: 12,
              width: null,
              height: null,
              durationMs: null,
              fps: null,
            },
          }),
        },
        dirtyRevision: 1,
        dirty: {
          graph: false,
          viewport: false,
          fullReplace: false,
          mediaAssets: false,
          nodes: {},
          removedNodes: {},
        },
      },
      { forceFullReplace: true },
    );

    const deltaRecord = (delta ?? null) as Record<string, unknown> | null;
    expect(deltaRecord?.['mediaAssets']).toBeUndefined();

    const resultAreaNode = delta?.nodes?.upsert?.[0] as GraphNode<ModelNodeData> | undefined;
    const resultAreaItem: ResultAreaFormalSlot | undefined = resultAreaNode?.data.resultArea.slots[0];
    expect(resultAreaItem).toBeDefined();
    if (!resultAreaItem) return;
    expect(resultAreaItem.assetId).toBe('asset-runtime-1');
    expect(resultAreaItem.origin).toEqual({
      sourceNodeId: 'model-1',
      executionId: 'exec-1',
      batchId: 'batch-1',
      taskId: 'resultArea-task-1',
    });
    expect(resultAreaItem.runtimeRef).toEqual({
      taskId: null,
      resultId: null,
      assetId: 'asset-runtime-1',
    });

    const textResultAreaItem: ResultAreaFormalSlot | undefined = resultAreaNode?.data.resultArea.slots[1];
    expect(textResultAreaItem).toBeDefined();
    if (!textResultAreaItem) return;
    expect(textResultAreaItem.assetId).toBeNull();
    expect(textResultAreaItem.textValue).toBe('formal text');
    expect(textResultAreaItem.origin).toEqual({
      sourceNodeId: 'model-1',
      executionId: 'exec-1',
      batchId: 'batch-1',
      taskId: 'resultArea-task-2',
    });
    expect(textResultAreaItem.runtimeRef).toBeUndefined();

    const imageNode = delta?.nodes?.upsert?.[1] as GraphNode<ImageInputNodeData> | undefined;
    const imageNodeData = imageNode?.data;
    expect(imageNodeData).toBeDefined();
    if (!imageNodeData) return;
    expect(imageNodeData.taskInfo).toBeUndefined();
    expect(imageNodeData.runtimeRef).toBeUndefined();
  });

  it('setProjectMediaAssets 不再触发项目保存主链（source=user-action）', () => {
    const graph = createNodeGraph({ name: 'runtime-media-projection-only', description: undefined, tags: undefined, category: undefined });
    graph.id = 'graph-runtime-media-projection-only';
    graph.nodes = [];

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
    });

    useCanvasStore.getState().setProjectMediaAssets(
      {
        'asset-image-1': {
        ...createMediaAssetFixture({
          id: 'asset-image-1',
          mediaType: 'image',
          original: {
            url: '/files/formal.png',
            projectRef: 'project-a',
            fileKey: 'images/asset-image-1',
            sourceUrl: '/files/formal.png',
            sourceFileName: null,
            mimeType: 'image/png',
            sizeBytes: 12,
            width: null,
            height: null,
            durationMs: null,
            fps: null,
          },
        }),
        },
      },
      { source: 'user-action' },
    );

    const snapshot = useCanvasStore.getState();
    const { delta } = buildProjectDelta(snapshot, undefined);

    expect(snapshot.hasUnsavedChanges).toBe(false);
    expect(snapshot.dirty.mediaAssets).toBe(false);
    expect(snapshot.mediaAssets['asset-image-1']?.original?.url).toBe('/files/formal.png');
    expect(delta).toBeNull();
  });
});
