import type { ProjectMediaAssets } from '@iart/contracts';
import type { GraphNode, NodeGraph } from '../../types';
import type { ProjectSaveDelta } from '../../storage/types';
import { sanitizeModelNodeForPersistence } from '../../services/modelMediaPersistence';
import { sanitizeNodeGraphResultAreaItemsForPersistence } from '../../services/projectMediaAssets';
import { stripNodeRuntimeLayoutFromNode } from '../../utils/nodeSize';
import { stripNodeRuntimeProjectionForPersistence } from '../../utils/nodeRuntimeProjectionStrip';
import type { CanvasDirtyFlags, CanvasDirtyState } from './canvasStore.shared';

export type CanvasDeltaStateSnapshot = {
  nodeGraph: NodeGraph | null;
  mediaAssets: ProjectMediaAssets;
  dirty: CanvasDirtyFlags;
  dirtyRevision: number;
};

export type BuildProjectDeltaOptions = {
  forceFullReplace: boolean | undefined;
};

export type BuildProjectDeltaResult = {
  delta: ProjectSaveDelta | null;
  expectedDirtyRevision: number;
};

export const createDirtyState = (): CanvasDirtyFlags => ({
  graph: false,
  viewport: false,
  fullReplace: false,
  mediaAssets: false,
  nodes: {},
  removedNodes: {},
});

const bumpDirtyRevision = (state: CanvasDirtyState) => {
  state.dirtyRevision += 1;
};

export const markGraphDirty = (state: CanvasDirtyState) => {
  state.dirty.graph = true;
  state.hasUnsavedChanges = true;
  bumpDirtyRevision(state);
};

export const markViewportDirty = (state: CanvasDirtyState) => {
  state.dirty.viewport = true;
  bumpDirtyRevision(state);
};

export const markMediaAssetsDirty = (state: CanvasDirtyState) => {
  state.dirty.mediaAssets = true;
  state.hasUnsavedChanges = true;
  bumpDirtyRevision(state);
};

export const markNodeDirty = (state: CanvasDirtyState, nodeId: string) => {
  if (!nodeId) return;
  state.dirty.nodes[nodeId] = true;
  delete state.dirty.removedNodes[nodeId];
  markGraphDirty(state);
};

export const markNodeRemoved = (state: CanvasDirtyState, nodeId: string) => {
  if (!nodeId) return;
  state.dirty.removedNodes[nodeId] = true;
  delete state.dirty.nodes[nodeId];
  markGraphDirty(state);
};

export const markFullGraphDirty = (state: CanvasDirtyState) => {
  state.dirty.fullReplace = true;
  markGraphDirty(state);
};

export const markNodesDirty = (state: CanvasDirtyState, nodeIds: string[]) => {
  if (!nodeIds.length) return;
  for (const nodeId of nodeIds) {
    if (!nodeId) continue;
    state.dirty.nodes[nodeId] = true;
    delete state.dirty.removedNodes[nodeId];
  }
  markGraphDirty(state);
};

export const resetDirtyState = (state: CanvasDirtyState) => {
  state.dirty = createDirtyState();
  state.dirtyRevision = 0;
};

const sanitizeNodeForDelta = (node: GraphNode): GraphNode =>
  sanitizeModelNodeForPersistence(
    stripNodeRuntimeProjectionForPersistence(stripNodeRuntimeLayoutFromNode(node))
  ).node;

export const buildProjectDelta = (
  state: CanvasDeltaStateSnapshot,
  options: BuildProjectDeltaOptions | undefined
): BuildProjectDeltaResult => {
  const expectedDirtyRevision = state.dirtyRevision;
  const nodeGraph = state.nodeGraph;
  if (!nodeGraph) {
    return { delta: null, expectedDirtyRevision };
  }

  const dirty = state.dirty;
  const forceFullReplace = (options !== null && options !== undefined ? options.forceFullReplace : undefined) === true;
  const hasDirtyNodes =
    Object.keys(dirty.nodes).length > 0 || Object.keys(dirty.removedNodes).length > 0;
  const hasDirtyGraph = dirty.graph || dirty.viewport || dirty.fullReplace;
  const hasDirty = forceFullReplace || hasDirtyGraph || hasDirtyNodes;

  if (!hasDirty) {
    return { delta: null, expectedDirtyRevision };
  }

  const sanitizedNodeGraph = sanitizeNodeGraphResultAreaItemsForPersistence(nodeGraph);
  const { nodes: sanitizedNodes, ...sanitizedGraphPayload } = sanitizedNodeGraph;
  const delta: ProjectSaveDelta = {
    nodeGraphId: nodeGraph.id,
    fullReplace: undefined,
    graph: undefined,
    nodes: undefined,
  };

  if (forceFullReplace || dirty.fullReplace) {
    delta.fullReplace = true;
    delta.graph = sanitizedGraphPayload;
    if (sanitizedNodes.length > 0) {
      delta.nodes = {
        upsert: sanitizedNodes.map(sanitizeNodeForDelta),
        remove: undefined,
      };
    }
    return { delta, expectedDirtyRevision };
  }

  if (hasDirtyGraph || hasDirtyNodes) {
    delta.graph = sanitizedGraphPayload;
  }

  const nodesUpsert = hasDirtyNodes
    ? sanitizedNodes.filter((node) => dirty.nodes[node.id]).map(sanitizeNodeForDelta)
    : [];
  const nodesRemove = Object.keys(dirty.removedNodes);
  if (nodesUpsert.length > 0 || nodesRemove.length > 0) {
    delta.nodes = { upsert: undefined, remove: undefined };
    if (nodesUpsert.length > 0) {
      delta.nodes.upsert = nodesUpsert;
    }
    if (nodesRemove.length > 0) {
      delta.nodes.remove = nodesRemove;
    }
  }

  return { delta, expectedDirtyRevision };
};

export type { CanvasDirtyFlags, CanvasDirtyState } from './canvasStore.shared';
