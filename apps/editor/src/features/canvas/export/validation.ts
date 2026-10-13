import { isUnknownRecord, type UnknownRecord } from '@/client/utils/typeGuards';
import type {
  NodeGraph,
  NodeGraphVariable,
} from '../types';
import { generateNodeGraphId } from '../types/nodeGraph';
import type { NodeGraphMeta } from '../types/nodeGraph';
import type { ImportValidationResult } from './types';
import { EXPORT_FORMAT_VERSION } from './types';
import {
  coerceString,
  coerceViewport,
  isModelGraphNode,
  isNonEmptyString,
  NODEGRAPH_STATUSES,
  sanitizeAnnotation,
  sanitizeNode,
  sanitizeNodeGraphSettings,
  sanitizeNodeGraphVariable,
  type SanitizeNodeOptions,
} from './validationSanitizers';
import type { CanvasAnnotation, GraphNode } from '../types';

/** 内部类型：用于检测包装的导出格式 */
interface WrappedPayload {
  version: number | undefined;
  exportedAt: string | undefined;
  nodeGraph: unknown | undefined;
}

type RawNodeGraphMeta = {
  version: unknown | undefined;
  createdAt: unknown | undefined;
  updatedAt: unknown | undefined;
  createdBy: unknown | undefined;
  tags: unknown | undefined;
  category: unknown | undefined;
};

type RawNodeGraph = {
  id: unknown | undefined;
  name: unknown | undefined;
  description: unknown | undefined;
  status: unknown | undefined;
  nodes: unknown | undefined;
  annotations: unknown | undefined;
  meta: unknown | undefined;
  variables: unknown | undefined;
  settings: unknown | undefined;
  viewport: unknown | undefined;
};

type RawWrappedPayload = WrappedPayload & RawNodeGraph;

const readUnknownField = (record: UnknownRecord, key: string): unknown | undefined => {
  return key in record ? record[key] : undefined;
};

const readWrappedPayload = (raw: unknown): RawWrappedPayload => {
  if (!isUnknownRecord(raw)) {
    return {
      version: undefined,
      exportedAt: undefined,
      nodeGraph: undefined,
      id: undefined,
      name: undefined,
      description: undefined,
      status: undefined,
      nodes: undefined,
      annotations: undefined,
      meta: undefined,
      variables: undefined,
      settings: undefined,
      viewport: undefined,
    };
  }
  return {
    version: typeof readUnknownField(raw, 'version') === 'number' ? (readUnknownField(raw, 'version') as number) : undefined,
    exportedAt: typeof readUnknownField(raw, 'exportedAt') === 'string' ? (readUnknownField(raw, 'exportedAt') as string) : undefined,
    nodeGraph: readUnknownField(raw, 'nodeGraph'),
    id: readUnknownField(raw, 'id'),
    name: readUnknownField(raw, 'name'),
    description: readUnknownField(raw, 'description'),
    status: readUnknownField(raw, 'status'),
    nodes: readUnknownField(raw, 'nodes'),
    annotations: readUnknownField(raw, 'annotations'),
    meta: readUnknownField(raw, 'meta'),
    variables: readUnknownField(raw, 'variables'),
    settings: readUnknownField(raw, 'settings'),
    viewport: readUnknownField(raw, 'viewport'),
  };
};

const sanitizeNodeGraph = (
  raw: unknown,
  errors: string[],
  warnings: string[],
  options: SanitizeNodeOptions
): NodeGraph | null => {
  if (!isUnknownRecord(raw)) {
    errors.push('这个文件不是有效的画布文件');
    return null;
  }
  const graph = raw as RawNodeGraph;

  const nodesRaw = Array.isArray(graph.nodes) ? graph.nodes : [];
  if (!nodesRaw.length) {
    warnings.push('文件里没有节点，导入后会得到一张空画布');
  }
  const deprecatedNodeIds = new Set<string>();
  const downgradedNodeIds = new Set<string>();
  const downgradedAnnotations: CanvasAnnotation[] = [];
  const nodes: GraphNode[] = [];
  nodesRaw.forEach((nodeRaw, index) => {
    const result = sanitizeNode(nodeRaw, index, options);
    if (result.kind === 'annotation') {
      downgradedNodeIds.add(result.originalNodeId);
      downgradedAnnotations.push(result.annotation);
      // 节点 id 只进日志：界面只写用户能懂的结果，排查材料不丢。
      console.warn(
        `[bundle.import] 节点类型无法导入，已降级为自由注释 nodeId=${result.originalNodeId}`,
      );
      warnings.push('有节点类型读不出来，已改为自由注释。');
      return;
    }
    const sanitizedNode = result.node;
    if (isModelGraphNode(sanitizedNode)) {
      const modelId = isNonEmptyString(sanitizedNode.data.modelId) ? sanitizedNode.data.modelId.trim() : '';
      if (modelId === 'json-extract') {
        deprecatedNodeIds.add(sanitizedNode.id);
        console.warn(
          `[bundle.import] 已跳过无法解析的旧节点 nodeId=${sanitizedNode.id} modelId=${modelId}`,
        );
        warnings.push('有旧节点读不出来，已跳过。');
        return;
      }
    }
    nodes.push(sanitizedNode);
  });
  const annotationsRaw = Array.isArray(graph.annotations) ? graph.annotations : [];
  const sanitizedAnnotations = annotationsRaw.map((annotation, index) => sanitizeAnnotation(annotation, index));
  // 降级产出的注释与显式 annotations 合并（降级注释先于显式注释，保持稳定顺序）
  const annotations = [...downgradedAnnotations, ...sanitizedAnnotations];

  const status = NODEGRAPH_STATUSES.includes(graph.status as NodeGraph['status'])
    ? (graph.status as NodeGraph['status'])
    : 'draft';
  if (graph.status && graph.status !== status) {
    console.warn(
      `[bundle.import] 画布状态无法识别，已按空白画布处理 rawStatus=${String(graph.status)}`,
    );
    warnings.push('文件里的画布状态读不出来，已按空白画布处理。');
  }

  const metaRaw: RawNodeGraphMeta = isUnknownRecord(graph.meta)
    ? graph.meta as RawNodeGraphMeta
    : {
        version: undefined,
        createdAt: undefined,
        updatedAt: undefined,
        createdBy: undefined,
        tags: undefined,
        category: undefined,
      };
  const now = new Date().toISOString();
  const meta: NodeGraphMeta = {
    version: coerceString(metaRaw.version, '1.0.0'),
    schemaVersion: undefined,
    createdAt: isNonEmptyString(metaRaw.createdAt) ? metaRaw.createdAt : now,
    updatedAt: isNonEmptyString(metaRaw.updatedAt) ? metaRaw.updatedAt : now,
    createdBy: isNonEmptyString(metaRaw.createdBy) ? metaRaw.createdBy.trim() : undefined,
    tags: Array.isArray(metaRaw.tags) ? metaRaw.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
    category: isNonEmptyString(metaRaw.category) ? metaRaw.category.trim() : undefined,
    selectedCharacterIds: undefined,
  };

  const result: NodeGraph = {
    id: coerceString(graph.id, generateNodeGraphId()),
    name: coerceString(graph.name, '未命名画布'),
    description: isNonEmptyString(graph.description) ? graph.description.trim() : undefined,
    status,
    nodes,
    annotations,
    variables: Array.isArray(graph.variables)
      ? graph.variables
          .map((variable) => sanitizeNodeGraphVariable(variable))
          .filter((variable): variable is NodeGraphVariable => variable !== null)
      : undefined,
    settings: sanitizeNodeGraphSettings(graph.settings),
    viewport: coerceViewport(graph.viewport),
    meta,
  };
  return result;
};

export function validateImportPayload(
  raw: unknown,
  options: { modelInlineControlsCollapsedDefault: boolean }
): ImportValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const modelInlineControlsCollapsedDefault = options.modelInlineControlsCollapsedDefault;

  if (!isUnknownRecord(raw)) {
    return { valid: false, errors: ['文件格式无效'], warnings, nodeGraph: undefined, mediaAssets: undefined };
  }

  const payload = readWrappedPayload(raw);
  const nodeGraphCandidate = payload.nodeGraph ?? raw;

  if ('version' in payload && payload.version !== EXPORT_FORMAT_VERSION) {
    // 版本号只进日志：界面只说明结果。EXPORT_FORMAT_VERSION 为 1，不一致只可能是
    // 无版本号的旧文件或更高版本的新文件，按方向给不同说法，避免自相矛盾。
    console.warn(
      `[bundle.import] 导出格式版本不一致 fileVersion=${String(payload.version)} supportedVersion=${EXPORT_FORMAT_VERSION}`,
    );
    warnings.push(
      typeof payload.version === 'number' && payload.version > EXPORT_FORMAT_VERSION
        ? '这个文件是新版本导出的，可能有内容没能导入。'
        : '这个文件是旧版本导出的，有内容没能导入。',
    );
  }
  if ('exportedAt' in payload && !isNonEmptyString(payload.exportedAt)) {
    warnings.push('文件里没有导出时间');
  }

  const nodeGraph = sanitizeNodeGraph(nodeGraphCandidate, errors, warnings, {
    modelInlineControlsCollapsedDefault,
  });

  const result: ImportValidationResult = {
    valid: errors.length === 0,
    errors,
    warnings,
    nodeGraph: errors.length === 0 && nodeGraph !== null ? nodeGraph : undefined,
    mediaAssets: undefined,
  };
  return result;
}
