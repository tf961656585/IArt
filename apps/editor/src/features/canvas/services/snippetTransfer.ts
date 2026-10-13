import type {
  ClipboardPayload,
  GraphNode,
  NodeGraph,
} from '../types';

import type { DynamicRecord } from '@/client/utils/typeGuards';
import { generateNodeGraphId } from '../types/nodeGraph';
import { computeClipboardCenterPosition } from '../clipboard/selectionPayload';

const EXECUTION_FIELDS = new Set<string>([
  'taskId',
  'clientTaskRef',
  'legacyTaskId',
  'remoteRequestId',
  'taskInfo',
  'errorDetails',
  'lastExecutionId',
  'lastSourceNodeId',
  'lastSourcePortId',
  'lastTaskId',
  'executionId',
]);

const isPlainObject = (value: unknown): value is DynamicRecord => {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
};

const stripExecutionFieldsDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => stripExecutionFieldsDeep(item));
  }

  if (isPlainObject(value)) {
    const next: DynamicRecord = {};
    for (const [key, val] of Object.entries(value)) {
      if (EXECUTION_FIELDS.has(key)) continue;
      next[key] = stripExecutionFieldsDeep(val);
    }
    return next;
  }

  return value;
};

export const sanitizeGraphNodeForSnippetTransfer = (node: GraphNode): GraphNode => {
  const cloned = structuredClone(node) as GraphNode;
  cloned.data = stripExecutionFieldsDeep(cloned.data) as typeof node.data;
  return cloned;
};

export const buildClipboardPayloadFromNodeGraphSnippet = (params: {
  nodeGraph: NodeGraph;
}): ClipboardPayload => {
  const nodes = params.nodeGraph.nodes.map(sanitizeGraphNodeForSnippetTransfer);

  const centerPosition = computeClipboardCenterPosition(nodes);

  return {
    copiedAt: Date.now(),
    sourceNodeGraphId: params.nodeGraph.id,
    nodes,
    centerPosition,
  };
};

export const buildNodeGraphSnippetFromClipboardPayload = (params: {
  name: string;
  payload: ClipboardPayload;
}): NodeGraph => {
  const now = new Date().toISOString();
  const nodes = params.payload.nodes.map(sanitizeGraphNodeForSnippetTransfer);

  return {
    id: generateNodeGraphId(),
    name: params.name,
    description: undefined,
    status: 'draft',
    nodes,
    annotations: undefined,
    variables: undefined,
    settings: undefined,
    viewport: undefined,
    meta: {
      version: '1.0.0',
      schemaVersion: undefined,
      createdAt: now,
      updatedAt: now,
      createdBy: undefined,
      tags: undefined,
      category: undefined,
      selectedCharacterIds: undefined,
    },
  };
};
