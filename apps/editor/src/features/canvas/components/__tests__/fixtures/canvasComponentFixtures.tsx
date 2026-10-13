import type {
  GraphNode,
  GraphNodeData,
  ModelNodeData,
  NodeGraph,
  ResultAreaSlotView,
} from '@/features/canvas/types';
import { createDefaultResultAreaEmbeddedData } from '@/features/canvas/services/resultAreaEmbeddedFactory';

export const createModelData = (overrides: Partial<ModelNodeData> = {}): ModelNodeData => ({
  label: 'Test Model',
  description: undefined,
  runtimeRef: undefined,
  shellModelId: undefined,
  modelId: 'gemini-3-pro-image',
  currentOverrideId: undefined,
  formValues: {},
  portMapping: {},
  inlineControlsCollapsed: false,
  inlineAdvancedGroupsExpanded: undefined,
  lastExecutionId: undefined,
  taskInfo: undefined,
  executionPreferences: undefined,
  promptPresetSnapshots: undefined,
  resultArea: createDefaultResultAreaEmbeddedData(),
  ...overrides,
});

export const createModelNode = (
  overrides: Partial<Omit<GraphNode<ModelNodeData>, 'data'>> & { data?: Partial<ModelNodeData> } = {}
): GraphNode<ModelNodeData> => {
  const { data, ...nodeOverrides } = overrides;
  return {
    id: 'node-model',
    type: 'model',
    position: { x: 0, y: 0 },
    data: createModelData(data),
    draggable: true,
    size: undefined,
    style: undefined,
    groupId: undefined,
    ...nodeOverrides,
  };
};

export const createResultAreaMediaSlot = (
  overrides: Partial<ResultAreaSlotView> & Pick<ResultAreaSlotView, 'id'>
): ResultAreaSlotView => {
  const mediaType = overrides.mediaType ?? 'text';
  return {
    targetKey: 'target-key',
    itemType: mediaType === 'text' ? 'text' : 'media',
    assetId: mediaType === 'text' ? null : null,
    textValue: mediaType === 'text' ? '' : null,
    value: '',
    mediaType,
    displayAspectRatio: undefined,
    expectedAspectRatio: undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    runtimeRef: undefined,
    origin: undefined,
    taskInfo: undefined,
    errorDetails: undefined,
    ...overrides,
  };
};

export const createResultAreaTaskSlot = (
  overrides: Partial<ResultAreaSlotView> & Pick<ResultAreaSlotView, 'id'>
): ResultAreaSlotView => ({
  targetKey: 'target-key',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  taskInfo: undefined,
  errorDetails: undefined,
  itemType: undefined,
  mediaType: undefined,
  value: undefined,
  assetId: undefined,
  textValue: undefined,
  displayAspectRatio: undefined,
  expectedAspectRatio: undefined,
  runtimeRef: undefined,
  origin: undefined,
  ...overrides,
});

export const createNodeGraph = (nodes: GraphNode[] = []): NodeGraph => ({
  id: 'graph-1',
  name: 'Test Graph',
  description: undefined,
  status: 'draft',
  nodes,
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
});

export const modelFlowNodeProps = {
  type: 'model',
  draggable: true,
  dragging: false,
  zIndex: 0,
  selectable: true,
  deletable: true,
  isConnectable: true,
  positionAbsoluteX: 0,
  positionAbsoluteY: 0,
} as const;

export const toNodePropsData = <TData extends GraphNodeData>(node: GraphNode<TData>): Record<string, unknown> => ({
  id: node.id,
  type: node.type,
  position: node.position,
  data: node.data,
  draggable: node.draggable,
  size: node.size,
  style: node.style,
});

