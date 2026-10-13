import { describe, expect, it } from 'vitest';
import { createNodeGraph } from '@/features/canvas/types/nodeGraph';
import {
  selectStoreRenderFallbackSizeByNodeId,
} from '@/features/canvas/store/selectors';
import { useCanvasStore } from '../canvasStore';
import type { VideoInputNodeData, DesiredSize } from '../../types/node';

/** 构造 accepted 态 desired size，避免字面量 state 被推断为 string。 */
const accepted = (width: number, height: number): DesiredSize => ({
  size: { width, height },
  state: 'accepted',
  semanticKey: 'test',
});
import {
  createGraphNodeFixture,
  createModelDataFixture,
  createModelNodeFixture,
  createResultAreaMediaSlotFixture,
  createTextInputDataFixture,
  createTextInputNodeFixture,
} from '../../components/__tests__/fixtures/canvasTestBuilders';
import { createResultAreaEmbeddedData } from '../../services/resultAreaEmbeddedFactory';

describe('render size selectors', () => {
  const createState = () => {
    const graph = createNodeGraph({ name: 'selectors', description: undefined, tags: undefined, category: undefined });
    graph.nodes = [
      createGraphNodeFixture<VideoInputNodeData>({
        id: 'n1',
        type: 'videoInput',
        position: { x: 10, y: 20 },
        data: {
          label: undefined,
          description: undefined,
          runtimeRef: undefined,
          assetId: null,
          videoUrl: null,
          videoMeta: undefined,
          valueSource: undefined,
          mediaError: undefined,
          derivedFromNodeId: undefined,
          derivedOp: undefined,
          lastExecutionId: undefined,
          lastSourceNodeId: undefined,
          lastSourcePortId: undefined,
          taskInfo: undefined,
          cachedContent: undefined,
        },
      }),
      createTextInputNodeFixture({
        id: 'n2',
        position: { x: 30, y: 40 },
        size: { width: 400, height: 210 },
        data: createTextInputDataFixture({ segments: [] }),
      }),
      createModelNodeFixture({
        id: 'm-embedded',
        position: { x: 50, y: 60 },
        data: {
          ...createModelNodeFixture({ id: 'model-template' }).data,
          modelId: 'gemini',
          formValues: {},
        },
      }),
      createModelNodeFixture({
        id: 'g-embedded',
        position: { x: 70, y: 80 },
        data: createModelDataFixture({
          resultArea: createResultAreaEmbeddedData({
            outputSlotIds: undefined,
            targetKeyId: 'g-embedded',
            slots: [
              createResultAreaMediaSlotFixture({
                id: 'item-1',
                targetKey: 't1',
                mediaType: 'image',
                value: 'https://example.com/1.png',
                createdAt: 1,
                updatedAt: 1,
              }),
            ],
            collapsed: false,
          }),
        }),
      }),
    ];

    return {
      ...useCanvasStore.getState(),
      nodeGraph: graph,
      ui: {
        ...useCanvasStore.getState().ui,
        desiredSizeByNodeId: {
          n1: accepted(280, 150),
          n2: accepted(400, 210),
          'm-embedded': accepted(448, 388),
        },
        layoutModelByNodeId: {
          n1: { width: 280, height: 150 },
          n2: { width: 400, height: 210 },
          'm-embedded': { width: 448, height: 388 },
        },
      },
    };
  };

  it('selectStoreRenderFallbackSizeByNodeId follows layoutModel > default', () => {
    const state = createState();
    const sizes = selectStoreRenderFallbackSizeByNodeId(state);

    expect(sizes['n1']).toEqual({ width: 280, height: 150 });
    expect(sizes['n2']).toEqual({ width: 400, height: 210 });
    expect(sizes['m-embedded']).toEqual({ width: 448, height: 388 });
  });

  it('selectStoreRenderFallbackSizeByNodeId 无关节点尺寸变化时复用未受影响节点的引用', () => {
    const state = createState();

    const firstSizes = selectStoreRenderFallbackSizeByNodeId(state);

    state.ui.layoutModelByNodeId = {
      ...state.ui.layoutModelByNodeId,
      n2: { width: 460, height: 240 },
    };

    const secondSizes = selectStoreRenderFallbackSizeByNodeId(state);

    expect(secondSizes).not.toBe(firstSizes);
    expect(secondSizes['n1']).toBe(firstSizes['n1']);
    expect(secondSizes['m-embedded']).toBe(firstSizes['m-embedded']);
    expect(secondSizes['n2']).toEqual({ width: 460, height: 240 });
  });

  it('selectStoreRenderFallbackSizeByNodeId 在 layoutModelByNodeId 引用不变时复用整图缓存', () => {
    const state = createState();

    const firstSizes = selectStoreRenderFallbackSizeByNodeId(state);

    // 仅改 desired（runtime 漂移校准输入，不进入主优先级链），layoutModelByNodeId 引用不变
    state.ui.desiredSizeByNodeId = {
      ...state.ui.desiredSizeByNodeId,
      n2: accepted(460, 240),
    };

    const secondSizes = selectStoreRenderFallbackSizeByNodeId(state);

    // 主链取自 layoutModel，所以 desired 变化不改变投影值
    expect(secondSizes).toBe(firstSizes);
  });
});
