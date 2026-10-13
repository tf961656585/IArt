import { useEffect, useMemo, useRef, useState } from "react";
import { type Node } from "@xyflow/react";
import { useStore as useReactFlowStore } from "@xyflow/react";

import { useCanvasOverviewMode } from "../../hooks/useCanvasOverviewMode";
import {
  buildEmbeddedCompanionIndex,
  type EmbeddedCompanionIndex,
} from "../../services/nodeCompanion/companionDrawerProxy";
import { useCanvasStore } from "../../store/canvasStore";
import {
  selectDesiredSizeByNodeId,
  selectLayoutModelByNodeId,
  selectStoreRenderFallbackSizeByNodeId,
  type CanvasLayoutSnapshotNode,
} from "../../store/selectors";
import type {
  GraphNode,
  NodeGraph,
  NodeSize,
} from "../../types";
import type { OverviewMiniCardNode } from "../../utils/overviewMiniCards";
import {
  FLOW_HIDDEN_CLASS_NAME,
  isFlowLayerInteractive,
  resolveFlowRenderDecision,
  type FlowCacheState,
} from "./flowRenderDecision";
import {
  resolveFlowCacheState,
  settleFlowCacheStateAfterWrite,
  shouldUseFlowCacheSnapshot,
} from "./flowRenderStatePolicy";
import { useReconciledFlowNodes } from "./flowNodeMemoizer";
import { selectFlowMeasuredFingerprint } from "./flowNodeActualSize";
import {
  EMPTY_NODE_ID_SET,
  EMPTY_FLOW_NODES,
} from "./nodeCanvasConstants";
import {
  toFlowNodes,
} from "./nodeCanvasFlowProjection";
import { useFlowProjectionSizing } from "./useFlowProjectionSizing";
import {
  isContainerCollapsed,
  isContainerNode,
} from "../../services/groupMembership";

/** 合并需要从渲染层隐藏的节点 id：embedded companion + 折叠容器成员 */
const collectHiddenNodeIds = (
  embeddedCompanionIndex: EmbeddedCompanionIndex,
  collapsedContainerMemberIdSet: Set<string>,
): Set<string> => {
  const embeddedMap = embeddedCompanionIndex.embeddedByCompanionId;
  if (embeddedMap.size === 0 && collapsedContainerMemberIdSet.size === 0) {
    return EMPTY_NODE_ID_SET;
  }
  const merged = new Set<string>();
  for (const id of embeddedMap.keys()) merged.add(id);
  for (const id of collapsedContainerMemberIdSet) merged.add(id);
  return merged;
};

/**
 * 计算折叠容器成员 id 集合：遍历所有折叠的容器节点（组 | Agent 容器），
 * 收集其显式成员 id——成员不挂载是折叠机制的一部分（AG-CN-008 / AG-CN-014），
 * 组与 Agent 容器同一机制，无特例分支。
 */
const computeCollapsedContainerMemberIdSet = (nodes: GraphNode[]): Set<string> => {
  const collapsedContainerIds: string[] = [];
  for (const node of nodes) {
    if (!isContainerNode(node)) continue;
    if (isContainerCollapsed(node)) {
      collapsedContainerIds.push(node.id);
    }
  }
  if (collapsedContainerIds.length === 0) return EMPTY_NODE_ID_SET;
  const collapsedSet = new Set(collapsedContainerIds);
  const memberIds = new Set<string>();
  for (const node of nodes) {
    // 组节点不得成为成员；Agent 容器成员（组 > Agent 容器）同样随容器折叠隐藏
    if (node.type === "group") continue;
    if (typeof node.groupId === "string" && collapsedSet.has(node.groupId)) {
      memberIds.add(node.id);
    }
  }
  return memberIds;
};

type UseNodeCanvasFlowModelArgs = {
  nodeGraph: NodeGraph | null;
  nodeGraphId: string | null;
  nodeGraphNodes: GraphNode[];
  layoutSnapshotNodes: CanvasLayoutSnapshotNode[];
  structureRevision: number;
  positionRevision: number;
  selectedNodeIds: string[];
  transientDimensions: Record<string, NodeSize>;
  zoom: number;
};

export function useNodeCanvasFlowModel({
  nodeGraphId,
  nodeGraphNodes,
  layoutSnapshotNodes,
  structureRevision,
  selectedNodeIds,
  transientDimensions,
  zoom,
}: UseNodeCanvasFlowModelArgs) {
  const selectedNodeIdSet = useMemo(
    () => new Set(selectedNodeIds),
    [selectedNodeIds],
  );

  const overviewNodes = useMemo<OverviewMiniCardNode[]>(() => {
    return nodeGraphNodes.map((node) => {
      const modelId =
        node.type === "model" &&
        typeof (node.data !== null && node.data !== undefined ? (node.data as { modelId: unknown | undefined }).modelId : undefined) ===
          "string"
          ? (
              (node.data !== null && node.data !== undefined ? (node.data as { modelId: string | undefined }).modelId : undefined) ?? ""
            ).trim()
          : "";
      return {
        id: node.id,
        type: node.type,
        position: node.position,
        selected: selectedNodeIdSet.has(node.id),
        registryKey: modelId ? modelId : undefined,
      };
    });
  }, [selectedNodeIdSet, nodeGraphNodes]);

  const embeddedCompanionIndex = useMemo<EmbeddedCompanionIndex>(() => {
    return buildEmbeddedCompanionIndex(nodeGraphNodes);
  }, [nodeGraphNodes]);

  const collapsedGroupMemberIdSet = useMemo(
    () => computeCollapsedContainerMemberIdSet(nodeGraphNodes),
    [nodeGraphNodes],
  );

  const flowVisibleGraphNodes = useMemo(() => {
    const hiddenIds = collectHiddenNodeIds(embeddedCompanionIndex, collapsedGroupMemberIdSet);
    if (hiddenIds.size === 0) return nodeGraphNodes;
    return nodeGraphNodes.filter((node) => !hiddenIds.has(node.id));
  }, [embeddedCompanionIndex, nodeGraphNodes, collapsedGroupMemberIdSet]);

  const flowVisibleLayoutSnapshotNodes = useMemo(() => {
    const hiddenIds = collectHiddenNodeIds(embeddedCompanionIndex, collapsedGroupMemberIdSet);
    if (hiddenIds.size === 0) return layoutSnapshotNodes;
    return layoutSnapshotNodes.filter(
      (node) => !hiddenIds.has(node.id),
    );
  }, [embeddedCompanionIndex, layoutSnapshotNodes, collapsedGroupMemberIdSet]);

  const {
    isOverview,
    preparingExit: preparingOverviewExit,
    onMoveStart: notifyOverviewMoveStart,
    onMoveEnd: notifyOverviewMoveEnd,
  } = useCanvasOverviewMode({
    graphId: nodeGraphId,
    zoom,
    nodeCount: flowVisibleGraphNodes.length,
    policy: undefined,
  });

  const flowCacheRef = useRef<{
    graphId: string | null;
    structureRevision: number | null;
    nodes: Node[];
  }>({
    graphId: null,
    structureRevision: null,
    nodes: EMPTY_FLOW_NODES,
  });
  const [flowCacheState, setFlowCacheState] = useState<FlowCacheState>("cold");
  const [previousGraphId, setPreviousGraphId] = useState<string | null>(
    nodeGraphId,
  );
  const graphIdChanged = previousGraphId !== nodeGraphId;
  const cachedFlow = flowCacheRef.current;
  const hasCacheForGraph = cachedFlow.graphId === nodeGraphId;
  const structureChangedSinceCache =
    hasCacheForGraph && cachedFlow.structureRevision !== structureRevision;
  const flowComputationRequested = !isOverview || preparingOverviewExit;
  const resolvedCacheState = resolveFlowCacheState({
    previousCacheState: flowCacheState,
    graphIdChanged,
    flowComputationRequested,
    hasCacheForGraph,
    structureChangedSinceCache,
  });
  const flowRenderDecision = resolveFlowRenderDecision({
    isOverview,
    preparingOverviewExit,
    cacheState: resolvedCacheState,
    graphIdChanged,
  });
  const {
    flowComputationEnabled,
    hideFlowLayer,
    overviewLayerEnabled,
    flowCacheStrategy,
  } = flowRenderDecision;
  const flowInteractive = isFlowLayerInteractive(flowRenderDecision);
  const flowInteractiveRef = useRef(flowInteractive);

  useEffect(() => {
    flowInteractiveRef.current = flowInteractive;
  }, [flowInteractive]);

  const desiredSizeByNodeId = useCanvasStore(selectDesiredSizeByNodeId);
  const layoutModelByNodeId = useCanvasStore(selectLayoutModelByNodeId);
  const renderFallbackSizeByNodeId = useCanvasStore(
    selectStoreRenderFallbackSizeByNodeId,
  );
  const flowNodeLookup = useReactFlowStore((state) => state.nodeLookup);
  // 实测失效信号：nodeLookup 引用不随实测变化，必须由指纹提供失效关系，否则实测投影永不刷新。
  const flowMeasuredFingerprint = useReactFlowStore(selectFlowMeasuredFingerprint);

  const {
    actualSizeByNodeId,
    flowNodeSizeByNodeId,
    projectionSizeByNodeId,
    groupDerivedProjection,
  } = useFlowProjectionSizing({
    nodeGraphId,
    graphIdChanged,
    flowNodeLookup,
    flowMeasuredFingerprint,
    flowVisibleLayoutSnapshotNodes,
    flowVisibleGraphNodes,
    desiredSizeByNodeId,
    renderFallbackSizeByNodeId,
    layoutModelByNodeId,
    transientDimensions,
  });

  const baseFlowNodes = useMemo(() => {
    if (!flowComputationEnabled) return EMPTY_FLOW_NODES;
    return toFlowNodes(flowVisibleLayoutSnapshotNodes, {
      renderSizeByNodeId: projectionSizeByNodeId,
      selectedNodeIdSet,
      groupDerivedByNodeId: groupDerivedProjection.byGroupId,
      realMeasuredByNodeId: actualSizeByNodeId,
    });
  }, [
    flowComputationEnabled,
    flowVisibleLayoutSnapshotNodes,
    projectionSizeByNodeId,
    groupDerivedProjection,
    selectedNodeIdSet,
    actualSizeByNodeId,
  ]);

  const { nodes: reconciledBaseFlowNodes } = useReconciledFlowNodes(
    baseFlowNodes,
    { enabled: flowComputationEnabled, resetKey: nodeGraphId, areEquivalent: undefined },
  );

  const computedFlowNodes = useMemo(() => {
    if (!flowComputationEnabled) return EMPTY_FLOW_NODES;
    return reconciledBaseFlowNodes;
  }, [flowComputationEnabled, reconciledBaseFlowNodes]);

  useEffect(() => {
    if (!graphIdChanged) return;
    flowCacheRef.current = {
      graphId: null,
      structureRevision: null,
      nodes: EMPTY_FLOW_NODES,
    };
    setPreviousGraphId((prev) => (prev === nodeGraphId ? prev : nodeGraphId));
  }, [graphIdChanged, nodeGraphId]);

  useEffect(() => {
    setFlowCacheState((prev) =>
      prev === resolvedCacheState ? prev : resolvedCacheState,
    );
  }, [resolvedCacheState]);

  useEffect(() => {
    if (!flowComputationEnabled) return;
    flowCacheRef.current = {
      graphId: nodeGraphId,
      structureRevision,
      nodes: computedFlowNodes,
    };
    const nextCacheState = settleFlowCacheStateAfterWrite({
      currentCacheState: resolvedCacheState,
      writeSucceeded: true,
    });
    setFlowCacheState((prev) =>
      prev === nextCacheState ? prev : nextCacheState,
    );
  }, [
    computedFlowNodes,
    flowComputationEnabled,
    nodeGraphId,
    resolvedCacheState,
    structureRevision,
  ]);

  const useCacheSnapshot = shouldUseFlowCacheSnapshot({
    strategy: flowCacheStrategy,
    cacheGraphId: cachedFlow.graphId,
    graphId: nodeGraphId,
  });
  const flowNodes = useCacheSnapshot ? cachedFlow.nodes : computedFlowNodes;

  const fitViewNodes = useMemo(
    () => flowNodes,
    [flowNodes],
  );

  return {
    overviewNodes,
    embeddedCompanionIndex,
    flowVisibleLayoutSnapshotNodes,
    actualSizeByNodeId,
    flowNodeSizeByNodeId,
    // 组节点派生尺寸投影（来自 buildGroupDerivedSize）。暴露给上层用于全局整理的
    // derivedSizeByNodeId 入参——全局整理时组节点尺寸只能由派生尺寸承载（spec：
    // 画布节点尺寸管理架构.md「派生尺寸」），不回退到 measured/desired/default。
    groupDerivedProjection,
    flowNodes,
    fitViewNodes,
    flowInteractive,
    flowInteractiveRef,
    hideFlowLayer,
    overviewLayerEnabled,
    notifyOverviewMoveStart,
    notifyOverviewMoveEnd,
    flowHiddenClassName: FLOW_HIDDEN_CLASS_NAME,
  };
}
