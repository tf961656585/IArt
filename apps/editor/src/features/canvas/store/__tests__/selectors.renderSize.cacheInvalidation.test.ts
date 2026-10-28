import { describe, expect, it } from 'vitest';
import { createNodeGraph } from '@/features/canvas/types/nodeGraph';
import type {
  AudioInputNodeData,
  DesiredSize,
  ModelNodeData,
  VideoInputNodeData,
} from '@/features/canvas/types/node';
import {
  selectGraphNodeById,
  selectStoreRenderFallbackSizeByNodeId,
  selectStoreRenderFallbackSizeForNode,
} from '../selectors';
import { useCanvasStore } from '../canvasStore';
import { createDefaultResultAreaEmbeddedData } from '../../services/resultAreaEmbeddedFactory';

/** 构造 accepted 态 desired size，避免字面量 state 被推断为 string。 */
const accepted = (width: number, height: number): DesiredSize => ({
  size: { width, height },
  state: 'accepted',
  semanticKey: 'test',
});

const buildVideoInputData = (
  overrides: Partial<VideoInputNodeData> = {},
): VideoInputNodeData => ({
  label: undefined,
  description: undefined,
  runtimeRef: undefined,
  assetId: undefined,
  videoUrl: null,
  videoMeta: undefined,
  valueSource: undefined,
  mediaError: undefined,
  lastExecutionId: undefined,
  lastSourceNodeId: undefined,
  lastSourcePortId: undefined,
  taskInfo: undefined,
  cachedContent: undefined,
  ...overrides,
});

const buildAudioInputData = (
  overrides: Partial<AudioInputNodeData> = {},
): AudioInputNodeData => ({
  label: undefined,
  description: undefined,
  runtimeRef: undefined,
  assetId: undefined,
  audioUrl: null,
  valueSource: undefined,
  mediaError: undefined,
  lastExecutionId: undefined,
  lastSourceNodeId: undefined,
  lastSourcePortId: undefined,
  taskInfo: undefined,
  cachedContent: undefined,
  duration: undefined,
  segments: [],
  segmentModeEnabled: undefined,
  ...overrides,
});

/**
 * 构造承载内嵌结果区的 model 节点 data。
 * resultArea 已退化为 ModelNodeData.resultArea 子结构，不再是独立 GraphNode。
 */
const buildModelData = (
  overrides: Partial<ModelNodeData> = {},
): ModelNodeData => ({
  label: 'Model',
  description: undefined,
  runtimeRef: undefined,
  shellModelId: undefined,
  modelId: 'test-model',
  currentOverrideId: undefined,
  formValues: {},
  portMapping: {},
  inlineControlsCollapsed: undefined,
  inlineAdvancedGroupsExpanded: undefined,
  lastExecutionId: undefined,
  taskInfo: undefined,
  executionPreferences: undefined,
  promptPresetSnapshots: undefined,
  resultArea: createDefaultResultAreaEmbeddedData(),
  ...overrides,
});

const createState = () => {
  const graph = createNodeGraph({
    name: 'cache',
    description: undefined,
    tags: undefined,
    category: undefined,
  });
  graph.nodes = [
    {
      id: 'n1',
      type: 'videoInput',
      position: { x: 0, y: 0 },
      data: buildVideoInputData(),
      draggable: true,
      size: undefined,
      style: undefined,
      groupId: undefined,
    },
    {
      id: 'n2',
      type: 'audioInput',
      position: { x: 40, y: 20 },
      data: buildAudioInputData(),
      draggable: true,
      size: undefined,
      style: undefined,
      groupId: undefined,
    },
  ];

  return {
    ...useCanvasStore.getState(),
    nodeGraph: graph,
    structureRevision: 1,
    layoutRevision: 1,
    ui: {
      ...useCanvasStore.getState().ui,
      desiredSizeByNodeId: {
        n1: accepted(220, 120),
        n2: accepted(180, 90),
      },
      layoutModelByNodeId: {
        n1: { width: 220, height: 120 },
        n2: { width: 180, height: 90 },
      },
    },
  };
};

describe('selectors.renderSize cache invalidation', () => {
  it('仅在节点实际尺寸输入变化时刷新对应节点缓存，不再依赖历史整图广播', () => {
    const state = createState();

    const first = selectStoreRenderFallbackSizeByNodeId(state);
    const second = selectStoreRenderFallbackSizeByNodeId(state);
    expect(second).toBe(first);

    state.ui.layoutModelByNodeId = {
      ...state.ui.layoutModelByNodeId,
      n1: { width: 320, height: 180 },
    };

    const third = selectStoreRenderFallbackSizeByNodeId(state);
    expect(third).not.toBe(first);
    expect(third['n1']).toEqual({ width: 320, height: 180 });
    expect(third['n2']).toBe(first['n2']);
  });

  it('selectStoreRenderFallbackSizeForNode 在无关节点尺寸变化时复用当前节点尺寸引用', () => {
    const state = createState();
    const selectN1 = selectStoreRenderFallbackSizeForNode('n1');

    const first = selectN1(state);
    expect(first).toEqual({ width: 220, height: 120 });

    state.ui.layoutModelByNodeId = {
      ...state.ui.layoutModelByNodeId,
      n2: { width: 260, height: 140 },
    };

    const second = selectN1(state);
    expect(second).toBe(first);

    state.ui.layoutModelByNodeId = {
      ...state.ui.layoutModelByNodeId,
      n1: { width: 300, height: 160 },
    };

    const third = selectN1(state);
    expect(third).not.toBe(second);
    expect(third).toEqual({ width: 300, height: 160 });
  });

  it('selectGraphNodeById 直接按节点读取，不受无关节点变化影响', () => {
    const state = createState();
    const selectN1 = selectGraphNodeById('n1');

    const first = selectN1(state);
    expect(first?.id).toBe('n1');

    state.ui.layoutModelByNodeId = {
      ...state.ui.layoutModelByNodeId,
      n2: { width: 260, height: 140 },
    };

    const second = selectN1(state);
    expect(second).toBe(first);
  });

  it('缓存建立后即使在原 nodes 数组上 push 新节点，只要 structureRevision 变化也能读到新节点', () => {
    const state = createState();
    const selectN3 = selectGraphNodeById('n3');

    expect(selectN3(state)).toBeNull();

    state.nodeGraph.nodes.push({
      id: 'n3',
      type: 'model',
      position: { x: 80, y: 40 },
      data: buildModelData(),
      draggable: true,
      size: undefined,
      style: undefined,
      groupId: undefined,
    });
    state.structureRevision += 1;

    const next = selectN3(state);
    expect(next?.id).toBe('n3');
  });
});
