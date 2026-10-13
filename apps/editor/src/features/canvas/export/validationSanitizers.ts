import type { UnknownRecord } from '@/client/utils/typeGuards';
import { isUnknownRecord } from '@/client/utils/typeGuards';
import { cast } from '@/lib/utils';
import type { CanvasAnnotation, GraphNode, GraphNodeData, GraphNodeType, ModelNodeData, NodeGraph, NodeGraphSettings, NodeGraphVariable, NodeGraphViewport } from '../types';
import { DEFAULT_ANNOTATION_SIZE, DEFAULT_ANNOTATION_STYLE, generateAnnotationId } from '../types/annotation';
import { normalizeNodeGraphSettings } from '../types/nodeGraph';
import { nodeRegistry } from '../nodes';

type RawAnnotationBinding = {
  type: unknown | undefined;
  nodeId: unknown | undefined;
  groupId: unknown | undefined;
};

type RawAnnotation = {
  id: unknown | undefined;
  content: unknown | undefined;
  position: unknown | undefined;
  size: unknown | undefined;
  binding: unknown | undefined;
  style: unknown | undefined;
};

type RawNode = {
  id: unknown | undefined;
  type: unknown | undefined;
  modelId: unknown | undefined;
  position: unknown | undefined;
  data: unknown | undefined;
  size: unknown | undefined;
  groupId: unknown | undefined;
};

type RawNodeGraphVariable = {
  name: unknown | undefined;
  type: unknown | undefined;
  defaultValue: unknown | undefined;
  description: unknown | undefined;
  required: unknown | undefined;
};

type RawNodeGraphSettings = {
  autoSave: unknown | undefined;
  executionTimeout: unknown | undefined;
  maxConcurrentNodes: unknown | undefined;
  continueOnFailure: unknown | undefined;
  enableLogging: unknown | undefined;
  snapToGrid: unknown | undefined;
  snapGrid: unknown | undefined;
};

type RawPosition = {
  x: unknown | undefined;
  y: unknown | undefined;
};

type RawSize = {
  width: unknown | undefined;
  height: unknown | undefined;
};

type RawViewport = RawPosition & {
  zoom: unknown | undefined;
};

type RawImportData = UnknownRecord & {
  modelId: unknown | undefined;
  inlineControlsCollapsed: unknown | undefined;
};

export const NODEGRAPH_STATUSES: NodeGraph['status'][] = ['draft', 'published', 'archived'];
const NODEGRAPH_VARIABLE_TYPES: NodeGraphVariable['type'][] = ['string', 'number', 'boolean', 'object', 'array'];

export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export const isUnknownArray = (value: unknown): value is unknown[] => Array.isArray(value);

export const coerceString = (value: unknown, fallback: string): string =>
  isNonEmptyString(value) ? value.trim() : fallback;

export const isModelGraphNode = (node: GraphNode): node is GraphNode<ModelNodeData> => node.type === 'model';

const emptyRecord = <T extends object>(): T => ({} as T);

const readUnknownRecord = <T extends object>(value: unknown): T | undefined => {
  return isUnknownRecord(value) ? (value as T) : undefined;
};

const asRawPosition = (value: unknown): RawPosition | undefined => {
  return readUnknownRecord<RawPosition>(value);
};

const asRawSize = (value: unknown): RawSize | undefined => {
  return readUnknownRecord<RawSize>(value);
};

export const coerceViewport = (value: unknown): NodeGraphViewport => {
  if (!isUnknownRecord(value)) {
    return { zoom: 1, x: 0, y: 0 };
  }
  const viewport = value as RawViewport;
  const zoom = isFiniteNumber(viewport.zoom) ? Number(viewport.zoom) : 1;
  const x = isFiniteNumber(viewport.x) ? Number(viewport.x) : 0;
  const y = isFiniteNumber(viewport.y) ? Number(viewport.y) : 0;
  return { zoom, x, y };
};

export const sanitizeNodeGraphVariable = (raw: unknown): NodeGraphVariable | null => {
  const variable = readUnknownRecord<RawNodeGraphVariable>(raw) ?? emptyRecord<RawNodeGraphVariable>();
  const name = coerceString(variable.name, '');
  if (!name) return null;

  const type = NODEGRAPH_VARIABLE_TYPES.includes(variable.type as NodeGraphVariable['type'])
    ? (variable.type as NodeGraphVariable['type'])
    : 'string';
  const result: NodeGraphVariable = { name, type, defaultValue: undefined, description: undefined, required: undefined };
  if ('defaultValue' in variable) result.defaultValue = variable.defaultValue;
  if (isNonEmptyString(variable.description)) result.description = variable.description.trim();
  if (typeof variable.required === 'boolean') result.required = variable.required;
  return result;
};

export const sanitizeNodeGraphSettings = (raw: unknown): Required<NodeGraphSettings> => {
  const settings = readUnknownRecord<RawNodeGraphSettings>(raw) ?? emptyRecord<RawNodeGraphSettings>();
  const normalized: NodeGraphSettings = {} as NodeGraphSettings;
  if (typeof settings.autoSave === 'boolean') normalized.autoSave = settings.autoSave;
  if (isFiniteNumber(settings.executionTimeout)) normalized.executionTimeout = settings.executionTimeout;
  if (isFiniteNumber(settings.maxConcurrentNodes)) normalized.maxConcurrentNodes = settings.maxConcurrentNodes;
  if (typeof settings.continueOnFailure === 'boolean') normalized.continueOnFailure = settings.continueOnFailure;
  if (typeof settings.enableLogging === 'boolean') normalized.enableLogging = settings.enableLogging;
  if (typeof settings.snapToGrid === 'boolean') normalized.snapToGrid = settings.snapToGrid;
  if (isUnknownArray(settings.snapGrid) && settings.snapGrid.length === 2) {
    const x = settings.snapGrid[0];
    const y = settings.snapGrid[1];
    if (isFiniteNumber(x) && isFiniteNumber(y)) normalized.snapGrid = [x, y];
  }
  return normalizeNodeGraphSettings(normalized);
};

export const sanitizeAnnotationBinding = (raw: unknown): CanvasAnnotation['binding'] => {
  const record = readUnknownRecord<RawAnnotationBinding>(raw) ?? emptyRecord<RawAnnotationBinding>();
  const type = isNonEmptyString(record.type) ? record.type.trim() : 'free';
  switch (type) {
    case 'node': {
      const nodeId = coerceString(record.nodeId, '');
      return nodeId ? ({ type: 'node', nodeId } as const) : { type: 'free' };
    }
    case 'group': {
      // groups 已移除，group 绑定注释降级为自由注释
      return { type: 'free' };
    }
    case 'free':
    default:
      return { type: 'free' };
  }
};

export const sanitizeAnnotation = (raw: unknown, index: number): CanvasAnnotation => {
  const record = readUnknownRecord<RawAnnotation>(raw) ?? emptyRecord<RawAnnotation>();
  const id = isNonEmptyString(record.id) ? record.id.trim() : generateAnnotationId();
  const content = isNonEmptyString(record.content) ? record.content : '';

  const positionRaw = asRawPosition(record.position);
  const position = positionRaw
    ? {
        x: isFiniteNumber(positionRaw.x) ? Number(positionRaw.x) : index * 40,
        y: isFiniteNumber(positionRaw.y) ? Number(positionRaw.y) : index * 40,
      }
    : { x: index * 40, y: index * 40 };

  const sizeRaw = asRawSize(record.size);
  const size = sizeRaw
    ? {
        width: isFiniteNumber(sizeRaw.width) ? Number(sizeRaw.width) : DEFAULT_ANNOTATION_SIZE.width,
        height: isFiniteNumber(sizeRaw.height) ? Number(sizeRaw.height) : DEFAULT_ANNOTATION_SIZE.height,
      }
    : { ...DEFAULT_ANNOTATION_SIZE };

  const styleRecord =
    readUnknownRecord<{ color: unknown | undefined; fontSize: unknown | undefined }>(record.style) ??
    emptyRecord<{ color: unknown | undefined; fontSize: unknown | undefined }>();
  const style = {
    color: isNonEmptyString(styleRecord.color) ? styleRecord.color.trim() : DEFAULT_ANNOTATION_STYLE.color,
    fontSize: isFiniteNumber(styleRecord.fontSize) ? Number(styleRecord.fontSize) : DEFAULT_ANNOTATION_STYLE.fontSize,
  };

  return {
    id,
    content,
    position,
    size,
    binding: sanitizeAnnotationBinding(record.binding),
    style,
  };
};

export type SanitizedNodeResult =
  | { kind: 'node'; node: GraphNode }
  | { kind: 'annotation'; annotation: CanvasAnnotation; originalNodeId: string };

/**
 * 当节点无法成为合法画布节点时，降级为自由注释。
 * 取原节点位置作为注释位置；内容取 data.content / data.label / data.modelId 顺序兜底；
 * 尺寸/样式走注释默认值。
 */
const downgradeToFreeAnnotation = (
  record: RawNode,
  index: number,
): CanvasAnnotation => {
  const positionRaw = asRawPosition(record.position);
  const position = positionRaw
    ? {
        x: isFiniteNumber(positionRaw.x) ? Number(positionRaw.x) : index * 40,
        y: isFiniteNumber(positionRaw.y) ? Number(positionRaw.y) : index * 40,
      }
    : { x: index * 40, y: index * 40 };

  const rawData = readUnknownRecord<{ content: unknown; label: unknown; modelId: unknown }>(record.data) ?? emptyRecord<{ content: unknown; label: unknown; modelId: unknown }>();
  const contentSource =
    (isNonEmptyString(rawData.content) ? rawData.content : undefined) ??
    (isNonEmptyString(rawData.label) ? rawData.label : undefined) ??
    (isNonEmptyString(rawData.modelId) ? rawData.modelId : undefined) ??
    (isNonEmptyString(record.modelId) ? record.modelId : undefined);
  const content = isNonEmptyString(contentSource) ? contentSource.trim() : '';

  return {
    id: generateAnnotationId(),
    content,
    position,
    size: { ...DEFAULT_ANNOTATION_SIZE },
    binding: { type: 'free' },
    style: { ...DEFAULT_ANNOTATION_STYLE },
  };
};

export const sanitizeNode = (
  raw: unknown,
  index: number,
  options: SanitizeNodeOptions
): SanitizedNodeResult => {
  const record = readUnknownRecord<RawNode>(raw) ?? emptyRecord<RawNode>();
  const typeCandidate = coerceString(record.type, 'model');
  const positionRaw = asRawPosition(record.position);
  const position = positionRaw
    ? {
        x: isFiniteNumber(positionRaw.x) ? Number(positionRaw.x) : index * 120,
        y: isFiniteNumber(positionRaw.y) ? Number(positionRaw.y) : index * 40,
      }
    : { x: index * 120, y: index * 40 };

  const nodeId = coerceString(record.id, `node-${index + 1}`);
  const rawData = readUnknownRecord<RawImportData>(record.data) ?? emptyRecord<RawImportData>();

  const resolveImportDefinition = (): {
    type: GraphNodeType | undefined;
    definition: ReturnType<typeof nodeRegistry.get> | undefined;
  } => {
    // 旧 note 类型与未知类型：降级为自由注释
    if (typeCandidate === 'note') return { type: undefined, definition: undefined };

    if (typeCandidate === 'model') {
      const modelIdCandidate = rawData.modelId ?? record.modelId;
      const modelId = isNonEmptyString(modelIdCandidate) ? modelIdCandidate.trim() : '';
      const definition = modelId ? nodeRegistry.getModelNode(modelId) : undefined;
      if (!definition) return { type: undefined, definition: undefined };
      if ((definition.bundle !== null && definition.bundle !== undefined ? definition.bundle.importable : undefined) === false) return { type: undefined, definition: undefined };
      return { type: 'model', definition };
    }

    const definition = nodeRegistry.get(typeCandidate);
    if (!definition) return { type: undefined, definition: undefined };
    if ((definition.bundle !== null && definition.bundle !== undefined ? definition.bundle.importable : undefined) === false) return { type: undefined, definition: undefined };
    return { type: typeCandidate as GraphNodeType, definition };
  };

  const { type, definition } = resolveImportDefinition();

  // 无法解析为合法节点类型：降级为自由注释（保留原节点文本）
  if (type === undefined) {
    const annotation = downgradeToFreeAnnotation(record, index);
    return { kind: 'annotation', annotation, originalNodeId: nodeId };
  }

  const baseDefaults: UnknownRecord =
    (definition !== null && definition !== undefined ? definition.defaultData : undefined) ?? {};
  const sanitizedBaseDefaults = (() => {
    if (type !== 'model') return baseDefaults;
    const { inlineControlsCollapsed: _legacyInlineDefault, ...rest } = baseDefaults;
    return rest;
  })();
  const merged: RawImportData = {
    ...sanitizedBaseDefaults,
    ...rawData,
  };
  if (type === 'model') {
    merged.inlineControlsCollapsed = options.modelInlineControlsCollapsedDefault;
  }
  const sanitizeFn = (definition !== null && definition !== undefined && definition.bundle !== null && definition.bundle !== undefined) ? definition.bundle.sanitizeData : undefined;
  const sanitizedData = sanitizeFn
    ? sanitizeFn(merged, { node: record as UnknownRecord }) as UnknownRecord
    : merged;

  const result: GraphNode<GraphNodeData> = {
    id: nodeId,
    type,
    position,
    data: cast<GraphNodeData>(sanitizedData),
    draggable: undefined,
    size: undefined,
    style: undefined,
    groupId: isNonEmptyString(record.groupId) ? record.groupId : undefined,
  };
  const sizeRaw = asRawSize(record.size);
  if (sizeRaw && isFiniteNumber(sizeRaw.width) && isFiniteNumber(sizeRaw.height)) {
    result.size = { width: sizeRaw.width, height: sizeRaw.height };
  }
  return { kind: 'node', node: result };
};

export type SanitizeNodeOptions = {
  modelInlineControlsCollapsedDefault: boolean;
};
