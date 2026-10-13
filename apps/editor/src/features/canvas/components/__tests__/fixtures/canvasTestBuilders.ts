import type { MediaAsset, MediaAssetThumbnail, ProjectMediaType } from '@iart/contracts';
import type {
  GraphNode,
  GraphNodeData,
  ModelNodeData,
  NodeTaskInfo,
  ResultAreaNodeData,
  ResultAreaSlotView,
  TextInputNodeData,
} from '../../../types/node';
import type { CreateNodeGraphParams, NodeGraph } from '../../../types/nodeGraph';
import { createDefaultResultAreaEmbeddedData } from '../../../services/resultAreaEmbeddedFactory';

/**
 * resultArea 已退化为 model 的 data.resultArea 子结构，不再是独立 GraphNode。
 * LegacyResultAreaNode 是迁移期遗留测试 fixture 的类型别名，仅供仍依赖旧
 * resultArea 节点语义的测试使用（这类测试应逐步重写或跳过）。
 */
type LegacyResultAreaNode = Omit<GraphNode, 'data' | 'type'> & {
  type: 'resultArea';
  data: ResultAreaNodeData;
};

export const createTestNodeGraphParams = (name: string): CreateNodeGraphParams => ({
  name,
  description: undefined,
  tags: undefined,
  category: undefined,
});

export const createTestNodeGraph = (
  overrides: Partial<NodeGraph> = {},
): NodeGraph => ({
  id: 'graph-1',
  name: '测试画板',
  description: undefined,
  status: 'draft',
  nodes: [],
  annotations: [],
  variables: [],
  settings: undefined,
  viewport: undefined,
  meta: {
    version: '1.0.0',
    schemaVersion: undefined,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: undefined,
    tags: undefined,
    category: undefined,
    selectedCharacterIds: undefined,
  },
  ...overrides,
});

export const createNodeTaskInfoFixture = (
  overrides: Partial<NodeTaskInfo> = {},
): NodeTaskInfo => ({
  taskId: undefined,
  remoteRequestId: undefined,
  taskIndex: undefined,
  modelId: 'test-model',
  status: undefined,
  progress: undefined,
  createdAt: 1,
  updatedAt: 1,
  error: undefined,
  failure: undefined,
  batchId: undefined,
  ...overrides,
});

export const createTextInputDataFixture = (
  overrides: Partial<TextInputNodeData> = {},
): TextInputNodeData => ({
  label: 'Text',
  description: undefined,
  runtimeRef: undefined,
  segments: [],
  lastExecutionId: undefined,
  lastSourceNodeId: undefined,
  lastSourcePortId: undefined,
  separator: undefined,
  customSeparator: undefined,
  promptPresetSnapshots: undefined,
  taskInfo: undefined,
  promptInterview: undefined,
  ...overrides,
});

export const createResultAreaDataFixture = (
  overrides: Partial<ResultAreaNodeData> = {},
): ResultAreaNodeData => ({
  label: 'ResultArea',
  description: undefined,
  runtimeRef: undefined,
  slots: [],
  outputSlotIds: undefined,
  collapsed: false,
  sourceNodeId: undefined,
  ...overrides,
});

export const createModelDataFixture = (
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

export const createGraphNodeFixture = <T extends GraphNodeData>(
  overrides: Partial<GraphNode<T>> & {
    id: string;
    type: GraphNode<T>['type'];
    data: T;
  },
): GraphNode<T> => {
  const { id, type, data, ...rest } = overrides;
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data,
    draggable: true,
    size: undefined,
    style: undefined,
    groupId: undefined,
    ...rest,
  };
};

export const createTextInputNodeFixture = (
  overrides: Partial<GraphNode<TextInputNodeData>> & { id: string } = { id: 'text-1' },
): GraphNode<TextInputNodeData> => {
  const { id, data: overrideData, ...rest } = overrides;
  const data = overrideData !== undefined
    ? createTextInputDataFixture(overrideData)
    : createTextInputDataFixture();
  return createGraphNodeFixture({
    id,
    type: 'textInput',
    data,
    ...rest,
  });
};

export const createResultAreaNodeFixture = (
  overrides: Partial<LegacyResultAreaNode> & { id: string } = { id: 'resultArea-1' },
): LegacyResultAreaNode => {
  const { id, data: overrideData, ...rest } = overrides;
  const data = overrideData !== undefined
    ? createResultAreaDataFixture(overrideData)
    : createResultAreaDataFixture();
  return {
    id,
    type: 'resultArea',
    position: { x: 0, y: 0 },
    data,
    draggable: true,
    size: undefined,
    style: undefined,
    groupId: undefined,
    ...rest,
  };
};

export const createModelNodeFixture = (
  overrides: Partial<GraphNode<ModelNodeData>> & { id: string } = { id: 'model-1' },
): GraphNode<ModelNodeData> => {
  const { id, data: overrideData, ...rest } = overrides;
  const data = overrideData !== undefined
    ? createModelDataFixture(overrideData)
    : createModelDataFixture();
  return createGraphNodeFixture({
    id,
    type: 'model',
    data,
    ...rest,
  });
};

export const createResultAreaMediaSlotFixture = (
  overrides: Partial<ResultAreaSlotView> & { id: string },
): ResultAreaSlotView => {
  const { id, ...rest } = overrides;
  const mediaType = overrides.mediaType !== undefined ? overrides.mediaType : 'image';
  return {
    id,
    targetKey: overrides.targetKey !== undefined ? overrides.targetKey : `resultArea_${id}`,
    itemType: mediaType === 'text' ? 'text' : 'media',
    assetId: mediaType === 'text' ? null : null,
    textValue: mediaType === 'text' ? '' : null,
    mediaType,
    value: undefined,
    displayAspectRatio: undefined,
    expectedAspectRatio: undefined,
    createdAt: 1,
    updatedAt: 1,
    runtimeRef: undefined,
    origin: undefined,
    taskInfo: undefined,
    errorDetails: undefined,
    ...rest,
  };
};

export const createResultAreaTaskSlotFixture = (
  overrides: Partial<ResultAreaSlotView> & { id: string },
): ResultAreaSlotView => {
  const { id, ...rest } = overrides;
  return {
    id,
    targetKey: overrides.targetKey !== undefined ? overrides.targetKey : `resultArea_${id}`,
    expectedAspectRatio: undefined,
    createdAt: 1,
    updatedAt: 1,
    taskInfo: undefined,
    errorDetails: undefined,
    itemType: undefined,
    mediaType: undefined,
    value: undefined,
    assetId: undefined,
    textValue: undefined,
    displayAspectRatio: undefined,
    runtimeRef: undefined,
    origin: undefined,
    ...rest,
  };
};

export const createResultAreaSlotFixture = (
  overrides: Partial<ResultAreaSlotView> & { id: string },
): ResultAreaSlotView => createResultAreaMediaSlotFixture(overrides);export const createMediaAssetThumbnailFixture = (
  overrides: Partial<MediaAssetThumbnail> = {},
): MediaAssetThumbnail => ({
  url: null,
  mimeType: null,
  width: null,
  height: null,
  status: 'missing',
  generatedAt: null,
  error: null,
  ...overrides,
});

export const createMediaAssetFixture = (
  overrides: Partial<MediaAsset> & { id: string },
): MediaAsset => {
  const { id, mediaType: overrideMediaType, ...rest } = overrides;
  const mediaType: ProjectMediaType = overrideMediaType !== undefined ? overrideMediaType : 'image';
  return {
    id,
    mediaType,
    original: {
      url: `/project-media/project-a/${id}`,
      projectRef: 'project-a',
      fileKey: `${mediaType}s/${id}`,
      sourceUrl: `/files/${id}`,
      sourceFileName: null,
      mimeType: mediaType === 'image' ? 'image/png' : mediaType === 'video' ? 'video/mp4' : 'audio/mpeg',
      sizeBytes: 1024,
      width: mediaType === 'audio' ? null : 800,
      height: mediaType === 'audio' ? null : 600,
      durationMs: mediaType === 'image' ? null : 5000,
      fps: null,
    },
    thumbnail: createMediaAssetThumbnailFixture(),
    lifecycle: { createdAt: 1, updatedAt: 1 },
    ...rest,
  };
};

export const createMediaAssetMapFixture = (
  assets: MediaAsset[],
): Record<string, MediaAsset> => {
  const result: Record<string, MediaAsset> = {};
  for (const asset of assets) {
    result[asset.id] = asset;
  }
  return result;
};
