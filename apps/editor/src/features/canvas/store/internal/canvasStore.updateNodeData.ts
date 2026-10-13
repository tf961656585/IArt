import type { ProjectMediaAssets } from "@iart/contracts";

import type { DynamicRecord } from "@/client/utils/typeGuards";
import { cast } from "@/lib/utils";
import type {
  GraphNodeData,
  AudioInputNodeData,
  NodeGraph,
} from "../../types";
import { hasSegmentsChanged } from "../../nodes/audio/AudioNodeFactory";
import {
  recordCanvasGraphInfo,
  recordUpdateNodeData,
} from "../../debug/canvasDebug";
import { TaskRevisionKeyRegistry } from "../taskRevisionKeyRegistry";
import {
  extractTaskIdsFromNodeData,
  isStoreValueEqual,
  updateTaskIdIndex,
  getCachedGraphNodeLookup,
  type CanvasDirtyState,
} from "./canvasStore.shared";
import { markNodeDirty } from "./canvasStore.persistence";
import type { UnknownRecord } from "@/client/utils/typeGuards";

export type UpdateNodeDataDebugContext = {
  debugEnabled: boolean;
  debugTrace: Error | undefined;
  viaTag: string | undefined;
};

type UpdateNodeDataState = CanvasDirtyState & {
  nodeGraph: NodeGraph | null;
  mediaAssets: ProjectMediaAssets;
  selectedNodeIds: string[];
  structureRevision: number;
  dataRevision: number;
  positionRevision: number;
  historyIndex: number;
  taskRevision: number;
  taskIdIndex: Map<string, string[]>;
};

export const applyUpdateNodeDataToState = (
  state: UpdateNodeDataState,
  nodeId: string,
  data: DynamicRecord,
  context: UpdateNodeDataDebugContext,
): void => {
  const { debugEnabled, debugTrace, viaTag } = context;
  let shouldBumpStructureRevision = false;
  let shouldBumpDataRevision = false;

  const nodeGraph = state.nodeGraph;
  if (!nodeGraph) return;
  const node = getCachedGraphNodeLookup(state).get(nodeId);
  if (!node) return;

  const patchRecord = (data ?? {}) as UnknownRecord;

  const keys = Object.keys(patchRecord);
  if (debugEnabled) {
    recordCanvasGraphInfo({
      nodeGraphId: nodeGraph.id,
      nodeCount: nodeGraph.nodes.length,
      structureRevision: state.structureRevision,
      positionRevision: state.positionRevision,
      historyIndex: state.historyIndex,
      selectedNodeCount: (state.selectedNodeIds !== null && state.selectedNodeIds !== undefined ? state.selectedNodeIds.length : undefined) ?? 0,
    });
  }

  const prevData = (
    node.data && typeof node.data === "object" ? node.data : {}
  ) as GraphNodeData;
  const prevDataRecord = cast<UnknownRecord>(prevData);
  const oldTaskIds = extractTaskIdsFromNodeData(prevData);
  const changedKeys: string[] = [];
  for (const key of keys) {
    if (!isStoreValueEqual(prevDataRecord[key], patchRecord[key])) {
      changedKeys.push(key);
    }
  }

  const shouldBumpTaskRevision =
    TaskRevisionKeyRegistry.shouldBumpTaskRevision(changedKeys);
  if (keys.length === 0 || changedKeys.length === 0) {
    if (debugEnabled) {
      recordUpdateNodeData({
        nodeId,
        nodeType: node.type,
        keys,
        changedKeys: changedKeys.length ? changedKeys : undefined,
        noOp: true,
        via: viaTag,
        stack: undefined,
        trace: debugTrace,
      });
    }
    return;
  }

  const nextData = cast<GraphNodeData>({ ...prevDataRecord, ...patchRecord });

  if (node.type === "audioInput") {
    const prevSegments =
      (node.data !== null && node.data !== undefined ? (node.data as AudioInputNodeData).segments : undefined) ?? [];
    const nextSegments =
      (nextData !== null && nextData !== undefined ? (nextData as AudioInputNodeData).segments : undefined) ?? [];
    const prevSegmentModeEnabled =
      (node.data !== null && node.data !== undefined ? (node.data as AudioInputNodeData).segmentModeEnabled : undefined) ??
      false;
    const nextSegmentModeEnabled =
      (nextData !== null && nextData !== undefined ? (nextData as AudioInputNodeData).segmentModeEnabled : undefined) ?? false;
    const segmentsChanged =
      prevSegmentModeEnabled !== nextSegmentModeEnabled ||
      hasSegmentsChanged(prevSegments, nextSegments);

    if (segmentsChanged) {
      shouldBumpStructureRevision = true;
    }
  }

  shouldBumpDataRevision = true;
  node.data = nextData;
  updateTaskIdIndex(
    state.taskIdIndex,
    oldTaskIds,
    extractTaskIdsFromNodeData(nextData),
    nodeId,
  );
  nodeGraph.meta.updatedAt = new Date().toISOString();
  markNodeDirty(state, nodeId);
  if (shouldBumpStructureRevision) state.structureRevision += 1;
  if (shouldBumpDataRevision) state.dataRevision += 1;
  if (shouldBumpTaskRevision) state.taskRevision += 1;
  if (debugEnabled) {
    recordUpdateNodeData({
      nodeId,
      nodeType: node.type,
      keys,
      changedKeys,
      noOp: false,
      via: viaTag,
      stack: undefined,
      trace: debugTrace,
    });
  }
};
