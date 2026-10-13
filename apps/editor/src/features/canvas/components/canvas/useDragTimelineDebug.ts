'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { DynamicRecord } from '@/client/utils/typeGuards';
import type { Node } from '@xyflow/react';
import { isElectronDev } from '@/client/utils/runtimeFlags';
import { logCanvasDebugEvent } from '../../debug/canvasDebug';
import type { CanvasLayoutSnapshotNode } from '../../store/selectors';
import type { GraphNode, NodeSize } from '../../types';
import { FLOW_HIDDEN_CLASS_NAME } from './flowRenderDecision';
import type { DragTimelineStoppedSnapshot } from './useCanvasDragSession';

type DragTimelineObservationState = 'filtered' | 'missing-size' | 'size-ready';

type DragTimelineConclusion =
  | 'entered-hidden-chain'
  | 'excluded-hidden-chain'
  | 'still-observing';

type DragTimelineSessionNodeState = {
  sessionId: string;
  nodeId: string;
  dragStopAt: number;
  lastObservationState: DragTimelineObservationState | null;
  lastConclusion: DragTimelineConclusion | null;
  observationSeq: number;
};

type NodeIdLookup = Pick<ReadonlySet<string>, 'has'>;

type UseDragTimelineDebugParams = {
  nodeGraphId: string | null;
  nodeGraphNodes: GraphNode[];
  dragStopSnapshot: DragTimelineStoppedSnapshot | null;
  layoutSnapshotNodes: CanvasLayoutSnapshotNode[];
  flowVisibleLayoutSnapshotNodes: CanvasLayoutSnapshotNode[];
  flowNodes: Node[];
  flowNodeSizeByNodeId: Record<string, NodeSize>;
  embeddedNodeIdSet: NodeIdLookup;
};

const DRAG_TIMELINE_SETTLE_MS = 360;

const hasRenderableSize = (size: NodeSize | null | undefined): boolean =>
  Boolean(
    size &&
      Number.isFinite(size.width) &&
      Number.isFinite(size.height) &&
      size.width > 0 &&
      size.height > 0
  );

const resolveDragTimelineConclusion = (
  observationState: DragTimelineObservationState,
  dragStopAt: number,
  now: number
): DragTimelineConclusion => {
  if (observationState === 'missing-size') {
    return 'entered-hidden-chain';
  }
  if (now - dragStopAt >= DRAG_TIMELINE_SETTLE_MS) {
    return 'excluded-hidden-chain';
  }
  return 'still-observing';
};

export function useDragTimelineDebug({
  nodeGraphId,
  nodeGraphNodes,
  dragStopSnapshot,
  layoutSnapshotNodes,
  flowVisibleLayoutSnapshotNodes,
  flowNodes,
  flowNodeSizeByNodeId,
  embeddedNodeIdSet,
}: UseDragTimelineDebugParams) {
  const enabled = isElectronDev();
  const sessionByNodeIdRef = useRef<Map<string, DragTimelineSessionNodeState>>(new Map());
  const [observationClock, setObservationClock] = useState(0);

  const logDragTimelineEvent = useCallback(
    (
      session: Pick<
        DragTimelineSessionNodeState,
        | 'sessionId'
        | 'nodeId'
        | 'observationSeq'
      >,
      eventName: string,
      detail: DynamicRecord | undefined,
      reasonSuffix: string | undefined
    ) => {
      if (!enabled) return;

      const suffix = typeof reasonSuffix === 'string' && reasonSuffix.trim() ? `:${reasonSuffix.trim()}` : '';
      logCanvasDebugEvent(`drag-timeline:${session.sessionId}:${session.nodeId}:${eventName}${suffix}`, {
        eventName,
        dragSessionId: session.sessionId,
        nodeId: session.nodeId,
        observationSeq: session.observationSeq,
        ...detail,
      });
    },
    [enabled]
  );

  useEffect(() => {
    sessionByNodeIdRef.current.clear();
  }, [nodeGraphId]);

  useEffect(() => {
    if (!enabled) return;
    if (dragStopSnapshot === null) return;

    const stoppedNodeIds = Object.keys(dragStopSnapshot.positions);
    if (stoppedNodeIds.length === 0) {
      return;
    }

    const sessionId = dragStopSnapshot.sessionId;
    const sessionStartedAt = dragStopSnapshot.stoppedAt;

    for (const nodeId of stoppedNodeIds) {
      const beforeNode = dragStopSnapshot.nodesById.get(nodeId);
      if (!beforeNode) continue;

      const currentSize = flowNodeSizeByNodeId[nodeId] ?? beforeNode.size;
      const session: DragTimelineSessionNodeState = {
        sessionId,
        nodeId,
        dragStopAt: sessionStartedAt,
        lastObservationState: null,
        lastConclusion: null,
        observationSeq: 0,
      };
      sessionByNodeIdRef.current.set(nodeId, session);
      logDragTimelineEvent(session, 'drag-stop', {
        eventTs: sessionStartedAt,
        missingSize: !hasRenderableSize(currentSize),
        timelineConclusion: 'still-observing' as DragTimelineConclusion,
      }, undefined);
    }
  }, [
    dragStopSnapshot,
    enabled,
    flowNodeSizeByNodeId,
    logDragTimelineEvent,
    nodeGraphNodes,
  ]);

  useEffect(() => {
    if (!enabled) return;
    if (sessionByNodeIdRef.current.size === 0) return;

    let nextWakeInMs: number | null = null;
    const now = Date.now();

    for (const session of sessionByNodeIdRef.current.values()) {
      if (session.lastConclusion && session.lastConclusion !== 'still-observing') {
        continue;
      }
      const remaining = DRAG_TIMELINE_SETTLE_MS - (now - session.dragStopAt);
      if (remaining <= 0) {
        nextWakeInMs = 0;
        break;
      }
      if (nextWakeInMs === null || remaining < nextWakeInMs) {
        nextWakeInMs = remaining;
      }
    }

    if (nextWakeInMs === null) return;

    const timer = window.setTimeout(() => {
      setObservationClock((value) => value + 1);
    }, Math.max(0, nextWakeInMs));

    return () => {
      window.clearTimeout(timer);
    };
  }, [enabled, nodeGraphId, observationClock]);

  useEffect(() => {
    if (!enabled) return;
    if (sessionByNodeIdRef.current.size === 0) return;

    const snapshotNodeIds = new Set(layoutSnapshotNodes.map((node) => node.id));
    const visibleLayoutNodeIds = new Set(flowVisibleLayoutSnapshotNodes.map((node) => node.id));
    const flowNodeById = new Map(flowNodes.map((node) => [node.id, node]));
    const graphNodeById = new Map(nodeGraphNodes.map((node) => [node.id, node]));

    for (const [nodeId, session] of sessionByNodeIdRef.current) {
      const currentNode = graphNodeById.get(nodeId);
      if (!currentNode || session.nodeId !== nodeId) {
        sessionByNodeIdRef.current.delete(nodeId);
        continue;
      }

      const flowNode = flowNodeById.get(nodeId);
      const renderSize = flowNodeSizeByNodeId[nodeId] ?? currentNode.size;
      const missingSize = !hasRenderableSize(renderSize);
      const wasInLayoutSnapshot = snapshotNodeIds.has(nodeId);
      const isVisibleInFlowLayout = visibleLayoutNodeIds.has(nodeId);
      const isFiltered = !isVisibleInFlowLayout || !flowNode;

      let observationState: DragTimelineObservationState = 'size-ready';
      let filteredReason: string | null = null;

      if (isFiltered) {
        observationState = 'filtered';
        if (!wasInLayoutSnapshot) {
          filteredReason = 'missing-layout-snapshot';
        } else if (embeddedNodeIdSet.has(nodeId)) {
          filteredReason = 'embedded-companion';
        } else if (!flowNode) {
          filteredReason = 'missing-flow-node';
        } else {
          filteredReason = 'filtered-out';
        }
      } else if (missingSize) {
        observationState = 'missing-size';
      }

      const now = Date.now();
      const timelineConclusion = resolveDragTimelineConclusion(observationState, session.dragStopAt, now);

      if (
        session.lastObservationState === observationState &&
        session.lastConclusion === timelineConclusion
      ) {
        continue;
      }

      session.lastObservationState = observationState;
      session.lastConclusion = timelineConclusion;
      session.observationSeq += 1;
      logDragTimelineEvent(
        session,
        'flow-observation',
        {
          eventTs: now,
          filtered: isFiltered,
          filteredReason,
          missingSize,
          inLayoutSnapshot: wasInLayoutSnapshot,
          inVisibleFlowLayout: isVisibleInFlowLayout,
          inFlowNodes: Boolean(flowNode),
          flowHiddenClassName: FLOW_HIDDEN_CLASS_NAME,
          observationState,
          timelineConclusion,
          dragStopAt: session.dragStopAt,
        },
        `${observationState}:${timelineConclusion}:${session.observationSeq}`
      );

      if (timelineConclusion !== 'still-observing') {
        sessionByNodeIdRef.current.delete(nodeId);
      }
    }
  }, [
    embeddedNodeIdSet,
    enabled,
    flowNodeSizeByNodeId,
    flowNodes,
    flowVisibleLayoutSnapshotNodes,
    layoutSnapshotNodes,
    logDragTimelineEvent,
    nodeGraphNodes,
    observationClock,
  ]);

  return {};
}
