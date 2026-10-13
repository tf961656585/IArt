'use client';

import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { type OnNodesChange, type Node } from "@xyflow/react";

import { expandPositionUpdatesWithCompanions } from "../../services/nodeCompanion/nodeCompanionManager";
import {
  canBeMemberOfType,
  hitTestGroupAt,
  isContainerCollapsed,
  isContainerNode,
  type GroupBoundsEntry,
} from "../../services/groupMembership";
import { buildGroupDerivedSize } from "./groupDerivedSize";
import { selectStoreRenderFallbackSizeByNodeId } from "../../store/selectors";
import { useCanvasStore, type CanvasStore } from "../../store/canvasStore";
import type {
  DesiredSize,
  GraphNode,
  GraphNodeType,
  NodePosition,
  NodeSize,
} from "../../types";
import { useCanvasDragSession } from "./useCanvasDragSession";
import type { RenderPositionUpdate } from "./useFlowRenderState";

/**
 * 落点判定快照中容器的绘制层基数（zIndex 分层，AG-CN-004 最高绘制层命中）：
 * Agent 容器背板（-1）高于组背板（-2），两者都低于叶节点（0）。
 * 快照 zIndex = 层基数 + 节点在图中的数组序（同层重叠时后绘制者更上层，确定性命中）。
 */
const CONTAINER_DROP_Z_BASE = {
  group: 0,
  agent: 1_000_000,
} as const;

type PendingMutations = {
  positions: Map<string, NodePosition>;
  removals: Set<string>;
};

type UseNodeCanvasChangeControllerArgs = {
  nodeGraphId: string | null;
  flowInteractiveRef: MutableRefObject<boolean>;
  transientDimensionsRef: MutableRefObject<Record<string, NodeSize>>;
  setTransientDimensions: Dispatch<SetStateAction<Record<string, NodeSize>>>;
  clearTransientDimensionsForNodeIds: (nodeIds: string[]) => void;
  cancelTransientDimensionCleanup: (nodeId: string) => void;
  scheduleTransientDimensionCleanup: (nodeId: string) => void;
  applyRenderPositionUpdates: (
    updates: readonly RenderPositionUpdate[],
  ) => void;
  beginRenderDragSession: () => void;
  endRenderDragSession: () => void;
  removeRenderNodes: (nodeIds: readonly string[]) => void;
  updateNodePositionsBatch: CanvasStore["updateNodePositionsBatch"];
  removeNodes: CanvasStore["removeNodes"];
  addNodesToGroup: CanvasStore["addNodesToGroup"];
  removeNodesFromGroup: CanvasStore["removeNodesFromGroup"];
  moveNodesBetweenGroups: CanvasStore["moveNodesBetweenGroups"];
  nodeGraphNodes: GraphNode[];
  zoom: number;
};

export function useNodeCanvasChangeController({
  nodeGraphId,
  flowInteractiveRef,
  transientDimensionsRef,
  setTransientDimensions,
  clearTransientDimensionsForNodeIds,
  cancelTransientDimensionCleanup,
  scheduleTransientDimensionCleanup,
  applyRenderPositionUpdates,
  beginRenderDragSession,
  endRenderDragSession,
  removeRenderNodes,
  updateNodePositionsBatch,
  removeNodes,
  addNodesToGroup,
  removeNodesFromGroup,
  moveNodesBetweenGroups,
  nodeGraphNodes,
  zoom,
}: UseNodeCanvasChangeControllerArgs) {
  const pendingMutationsRef = useRef<PendingMutations>({
    positions: new Map(),
    removals: new Set(),
  });
  const mutationFlushScheduledRef = useRef(false);
  // 容器边界框快照：onNodeDragStart 时构建，onNodeDragStop 后清空。
  // 用于拖拽落点判定，规避派生边界反馈循环（AG-CN-004：只使用拖拽开始时的展开边界快照）。
  const groupBoundsSnapshotRef = useRef<GroupBoundsEntry[]>([]);
  // 快照内容器节点的类型索引（id → 'group' | 'agent'）：
  // 落点判定前按被拖节点的成员资格过滤快照（组不得入任何容器、Agent 容器不得入 Agent 容器）。
  const containerTypeByIdRef = useRef<Map<string, GraphNodeType>>(new Map());
  // 被拖节点拖拽开始时的原组归属（拖入目标高亮判据：只高亮「松手会改变归属」的目标组）。
  const draggedOriginGroupRef = useRef<Map<string, string | undefined>>(new Map());
  const {
    beginDragSession,
    recordDragPositions,
    hasActiveDragSession,
    consumeFinalPositions,
    clearDragSession,
    publishDragStopSnapshot,
    dragTimelineSnapshot,
  } = useCanvasDragSession(nodeGraphId);

  /**
   * 按被拖节点的成员资格过滤落点快照。
   *
   * 与组完全同构、零特例：Agent 容器参与落点命中，但资格矩阵不合法的目标
   *（组被拖时无任何目标、Agent 被拖时无 Agent 目标）在命中前就被过滤，
   * 不存在「禁止拖入 Agent 容器」这类特例分支。
   */
  const filterEligibleBounds = useCallback(
    (
      bounds: readonly GroupBoundsEntry[],
      memberType: GraphNodeType | undefined,
    ): GroupBoundsEntry[] => {
      if (memberType === undefined) return [];
      const containerTypeById = containerTypeByIdRef.current;
      return bounds.filter((entry) => {
        const containerType = containerTypeById.get(entry.groupId);
        if (containerType === undefined) return false;
        return canBeMemberOfType(memberType, containerType);
      });
    },
    [],
  );

  const flushPendingMutations = useCallback(() => {
    const pending = pendingMutationsRef.current;
    for (const id of pending.removals) {
      pending.positions.delete(id);
    }
    const positionPayload = Array.from(
      pending.positions.entries(),
      ([id, position]): { id: string; position: NodePosition } => ({
        id,
        position,
      }),
    );
    const removalIds = Array.from(pending.removals);
    pending.positions.clear();
    pending.removals.clear();
    if (positionPayload.length) {
      updateNodePositionsBatch(positionPayload);
    }
    if (removalIds.length) {
      removeNodes(removalIds, undefined);
      clearTransientDimensionsForNodeIds(removalIds);
    }
  }, [
    clearTransientDimensionsForNodeIds,
    removeNodes,
    updateNodePositionsBatch,
  ]);

  const scheduleFlushPendingMutations = useCallback(() => {
    if (mutationFlushScheduledRef.current) return;
    mutationFlushScheduledRef.current = true;
    const schedule = (cb: FrameRequestCallback) => {
      if (typeof requestAnimationFrame === "function") {
        return requestAnimationFrame(cb);
      }
      return window.setTimeout(() => cb(performance.now()), 0);
    };
    schedule(() => {
      mutationFlushScheduledRef.current = false;
      flushPendingMutations();
    });
  }, [flushPendingMutations]);

  useEffect(() => {
    pendingMutationsRef.current.positions.clear();
    pendingMutationsRef.current.removals.clear();
    clearDragSession();
    endRenderDragSession();
  }, [clearDragSession, endRenderDragSession, nodeGraphId]);

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      if (!flowInteractiveRef.current) return;
      const nextTransientDimensions = { ...transientDimensionsRef.current };
      let transientDimensionsChanged = false;
      let hasQueuedMutation = false;

      for (const change of changes) {
        if (change.type === "select") {
          continue;
        }
        if (change.type === "position" && change.position) {
          const snapshot = useCanvasStore.getState().nodeGraph;
          const expanded = snapshot
            ? expandPositionUpdatesWithCompanions(snapshot, [
                { id: change.id, position: change.position },
              ])
            : [{ id: change.id, position: change.position }];

          if (change.dragging || hasActiveDragSession()) {
            beginRenderDragSession();
            recordDragPositions(expanded);
            applyRenderPositionUpdates(expanded);
          } else {
            pendingMutationsRef.current.positions.set(
              change.id,
              change.position,
            );
            hasQueuedMutation = true;
          }
          continue;
        }

        if (change.type === "dimensions" && change.dimensions) {
          const nextSize = {
            width: Math.round(Number(change.dimensions.width)),
            height: Math.round(Number(change.dimensions.height)),
          };
          if (
            !Number.isFinite(nextSize.width) ||
            !Number.isFinite(nextSize.height) ||
            nextSize.width <= 0 ||
            nextSize.height <= 0
          ) {
            continue;
          }
          if (change.resizing === true) {
            cancelTransientDimensionCleanup(change.id);
            const prevSize = nextTransientDimensions[change.id];
            if (
              !prevSize ||
              prevSize.width !== nextSize.width ||
              prevSize.height !== nextSize.height
            ) {
              nextTransientDimensions[change.id] = nextSize;
              transientDimensionsChanged = true;
            }
          } else if (nextTransientDimensions[change.id]) {
            scheduleTransientDimensionCleanup(change.id);
          }
          continue;
        }

        if (change.type === "remove") {
          pendingMutationsRef.current.removals.add(change.id);
          removeRenderNodes([change.id]);
          hasQueuedMutation = true;
          if (nextTransientDimensions[change.id]) {
            delete nextTransientDimensions[change.id];
            transientDimensionsChanged = true;
          }
          cancelTransientDimensionCleanup(change.id);
        }
      }

      if (transientDimensionsChanged) {
        setTransientDimensions(nextTransientDimensions);
      }
      if (hasQueuedMutation) {
        scheduleFlushPendingMutations();
      }
    },
    [
      applyRenderPositionUpdates,
      beginRenderDragSession,
      cancelTransientDimensionCleanup,
      flowInteractiveRef,
      hasActiveDragSession,
      recordDragPositions,
      removeRenderNodes,
      scheduleFlushPendingMutations,
      scheduleTransientDimensionCleanup,
      setTransientDimensions,
      transientDimensionsRef,
    ],
  );

  const onNodeDragStart = useCallback((_event: unknown, node: Node, nodes: Node[]) => {
    if (!flowInteractiveRef.current) return;
    beginDragSession();
    beginRenderDragSession();
    // 重置拖拽 UI 瞬态：拖容器反馈只在本容器节点（组 | Agent 容器）被拖时点亮。
    const draggedType = node.type;
    useCanvasStore.setState((s) => {
      s.ui.groupDropTargetGroupId = null;
      s.ui.groupDraggingId = draggedType === 'group' || draggedType === 'agent' ? node.id : null;
    });
    // 被拖节点拖拽开始时的原组归属（drop-target 高亮判据：只高亮「松手会改变归属」的目标组）。
    // 原组从 store 节点图读取（拖拽期间成员关系不变）。组节点不得持有 groupId，跳过。
    const originGroups = new Map<string, string | undefined>();
    draggedOriginGroupRef.current = originGroups;
    // 构建容器边界框快照：只取展开态容器（组 | Agent 容器；折叠容器不参与拖拽判定）。
    // 使用拖拽开始时刻的派生边界，规避实时派生边界的反馈循环（AG-CN-004）。
    const storeState = useCanvasStore.getState();
    const graph = storeState.nodeGraph;
    if (graph) {
      const groupIdByNodeId = new Map<string, string | undefined>();
      for (const graphNode of graph.nodes) {
        if (graphNode.type === 'group') continue;
        groupIdByNodeId.set(
          graphNode.id,
          typeof graphNode.groupId === 'string' && graphNode.groupId.length > 0
            ? graphNode.groupId
            : undefined,
        );
      }
      for (const dragged of nodes ?? []) {
        if (dragged.type === 'group') continue;
        originGroups.set(dragged.id, groupIdByNodeId.get(dragged.id));
      }
      const measuredByNodeId = storeState.ui.lastMeasuredSizeByNodeId;
      const fallbackByNodeId = selectStoreRenderFallbackSizeByNodeId(storeState);
      // desired 保留完整 entry（含 state）：成员尺寸经 resolveEffectiveSize 按 layoutModel > measured > default 解析，
      // desired 作为 runtime 期漂移校准源（不进入主优先级链），用于在 measured 不可信时矫正容器快照边界，
      // 让快照边界提前扩张，包住即将变大的成员（与派生尺寸 selector 同口径）。
      const desiredRaw = storeState.ui.desiredSizeByNodeId;
      const desiredByNodeId: Record<string, DesiredSize | undefined> = {};
      for (const key of Object.keys(desiredRaw)) {
        desiredByNodeId[key] = desiredRaw[key];
      }
      const projection = buildGroupDerivedSize({
        nodes: graph.nodes,
        sizeSources: {
          measuredByNodeId,
          desiredByNodeId,
          derivedByNodeId: undefined,
          defaultByNodeId: fallbackByNodeId,
          layoutModelByNodeId: undefined,
        },
      });
      // 转成 GroupBoundsEntry[]，过滤折叠容器（buildGroupDerivedSize 对折叠容器返回卡片尺寸而非展开包围盒，
      // 不适用于落点判定）。zIndex = 绘制层基数（Agent 容器 -1 > 组 -2）+ 节点数组序（同层后绘制更上层）。
      const nodeIndex = new Map<string, number>();
      graph.nodes.forEach((n, i) => nodeIndex.set(n.id, i));
      const entries: GroupBoundsEntry[] = [];
      const containerTypeById = new Map<string, GraphNodeType>();
      for (const node of graph.nodes) {
        if (!isContainerNode(node)) continue;
        containerTypeById.set(node.id, node.type);
        if (isContainerCollapsed(node)) continue; // 折叠容器不参与拖拽判定
        const entry = projection.byGroupId[node.id];
        if (!entry) continue;
        const zBase = node.type === 'agent' ? CONTAINER_DROP_Z_BASE.agent : CONTAINER_DROP_Z_BASE.group;
        entries.push({
          groupId: node.id,
          minX: entry.position.x,
          minY: entry.position.y,
          width: entry.size.width,
          height: entry.size.height,
          zIndex: zBase + (nodeIndex.get(node.id) ?? 0),
        });
      }
      groupBoundsSnapshotRef.current = entries;
      containerTypeByIdRef.current = containerTypeById;
    }
  }, [beginDragSession, beginRenderDragSession, flowInteractiveRef]);

  // 拖拽悬停命中（drop-target 高亮）：拖成员节点时按开始时刻快照边界连续判定，
  // 只高亮「松手会改变归属」的目标容器；命中结果变化才写 store，不产生逐帧渲染。
  // 拖组本身不做落点判定：组不得成为任何容器的成员，反馈由 .is-dragging 承载。
  const onNodeDrag = useCallback((_event: unknown, node: Node) => {
    if (!flowInteractiveRef.current) return;
    if (node.type === 'group') return;
    const snapshot = groupBoundsSnapshotRef.current;
    if (snapshot.length === 0) return;
    const storeState = useCanvasStore.getState();
    const draggedGraphNode = storeState.nodeGraph?.nodes.find((n) => n.id === node.id);
    if (draggedGraphNode === undefined) return;
    const eligibleBounds = filterEligibleBounds(snapshot, draggedGraphNode.type);
    if (eligibleBounds.length === 0) return;
    const measured = storeState.ui.lastMeasuredSizeByNodeId[node.id];
    const fallback = selectStoreRenderFallbackSizeByNodeId(storeState)[node.id];
    const size = measured ?? fallback;
    const halfW = size ? size.width / 2 : 0;
    const halfH = size ? size.height / 2 : 0;
    const dropPoint = {
      x: node.position.x + halfW,
      y: node.position.y + halfH,
    };
    const hitGroupId = hitTestGroupAt(dropPoint, eligibleBounds);
    const originGroupId = draggedOriginGroupRef.current.get(node.id);
    const nextTarget =
      hitGroupId !== undefined && hitGroupId !== originGroupId ? hitGroupId : null;
    if (storeState.ui.groupDropTargetGroupId !== nextTarget) {
      useCanvasStore.setState((s) => {
        s.ui.groupDropTargetGroupId = nextTarget;
      });
    }
  }, [filterEligibleBounds, flowInteractiveRef]);

  const onNodeDragStop = useCallback(() => {
    if (!flowInteractiveRef.current) return;
    // 清理拖拽 UI 瞬态（拖容器反馈 + drop-target 高亮），不依赖后续分支提前返回
    useCanvasStore.setState((s) => {
      s.ui.groupDropTargetGroupId = null;
      s.ui.groupDraggingId = null;
    });
    const pending = consumeFinalPositions();
    const ids = Object.keys(pending);
    endRenderDragSession();
    if (!ids.length) {
      groupBoundsSnapshotRef.current = [];
      return;
    }
    const payload = ids.flatMap((id) => {
      const position = pending[id];
      return position ? [{ id, position }] : [];
    });
    if (!payload.length) {
      groupBoundsSnapshotRef.current = [];
      return;
    }
    publishDragStopSnapshot({
      positions: pending,
      nodes: nodeGraphNodes,
    });
    updateNodePositionsBatch(payload);

    // 落点判定：位置已落盘后，根据拖拽前快照边界判定每个被拖节点的目标容器归属。
    // 必须使用快照（groupBoundsSnapshotRef），禁止用实时派生边界（AG-CN-004）。
    // 快照为空（所有容器折叠/无容器）同样进入判定：任何成员都未命中容器 → 移出；
    // 自由节点未命中 → 保持自由（无操作分支自会吸收）。
    const snapshot = groupBoundsSnapshotRef.current;
    groupBoundsSnapshotRef.current = [];

    // 拖拽前的节点图（用于查节点的原 groupId，判断加入/移出/迁移）。
    // nodeGraphNodes 是 hook 入参，是当前渲染周期的图；拖拽过程中未改写 store 节点关系，仍有效。
    const nodeById = new Map<string, GraphNode>();
    for (const node of nodeGraphNodes) {
      nodeById.set(node.id, node);
    }

    // 按目标容器分类被拖节点：加入新容器、移出当前容器、跨容器迁移。
    // 为减少历史条目，按操作类型合并：同一批加入/移出/迁移各自合并为单次 action
    //（AG-CN-011：多选拖拽的成员变化合并为一个原子操作、一条历史）。
    const addToGroupBuckets = new Map<string, string[]>(); // targetContainerId -> nodeIds
    const removeFromGroupIds: string[] = [];
    const moveToGroupBuckets = new Map<string, string[]>(); // targetContainerId -> nodeIds（跨容器迁移）

    for (const update of payload) {
      const node = nodeById.get(update.id);
      if (!node) continue;
      // 落点中心 = 节点 position（节点左上角）+ 节点尺寸/2。
      // 节点尺寸取拖拽前快照 measured/fallback，与容器边界快照同源。
      const storeState = useCanvasStore.getState();
      const measured = storeState.ui.lastMeasuredSizeByNodeId[update.id];
      const fallback = selectStoreRenderFallbackSizeByNodeId(storeState)[update.id];
      const size = measured ?? fallback;
      const halfW = size ? size.width / 2 : 0;
      const halfH = size ? size.height / 2 : 0;
      const dropPoint = {
        x: update.position.x + halfW,
        y: update.position.y + halfH,
      };
      // 资格过滤（AG-CN-001）：组节点无任何合法目标（恒不命中）；
      // Agent 容器只能命中组。过滤后的命中才是合法落点。
      const eligibleBounds = filterEligibleBounds(snapshot, node.type);
      const hitGroupId = hitTestGroupAt(dropPoint, eligibleBounds);
      const currentGroupId =
        typeof node.groupId === 'string' && node.groupId.length > 0
          ? node.groupId
          : undefined;

      if (hitGroupId === undefined) {
        // 落出所有合法容器：原是成员→移出；原是自由节点→无操作（保持自由）
        if (currentGroupId !== undefined) {
          removeFromGroupIds.push(update.id);
        }
        continue;
      }

      if (currentGroupId === undefined) {
        // 自由节点落入容器：加入
        const bucket = addToGroupBuckets.get(hitGroupId);
        if (bucket) {
          bucket.push(update.id);
        } else {
          addToGroupBuckets.set(hitGroupId, [update.id]);
        }
      } else if (currentGroupId === hitGroupId) {
        // 落入当前容器：无操作
        continue;
      } else {
        // 跨容器迁移：从 currentGroupId 迁到 hitGroupId（覆盖即迁移，AG-CN-002）
        const bucket = moveToGroupBuckets.get(hitGroupId);
        if (bucket) {
          bucket.push(update.id);
        } else {
          moveToGroupBuckets.set(hitGroupId, [update.id]);
        }
      }
    }

    // 执行变更：按操作类型合并，减少历史条目。
    // 用 historyBatchActive 把多个 action 包成单次历史（AG-CN-011：拖拽归属变更合为一条）。
    const hasChanges =
      addToGroupBuckets.size > 0 ||
      removeFromGroupIds.length > 0 ||
      moveToGroupBuckets.size > 0;
    if (!hasChanges) return;

    useCanvasStore.setState((s) => {
      s.historyBatchActive = true;
    });
    for (const [targetGroupId, nodeIds] of addToGroupBuckets) {
      addNodesToGroup(nodeIds, targetGroupId);
    }
    if (removeFromGroupIds.length > 0) {
      removeNodesFromGroup(removeFromGroupIds);
    }
    for (const [targetGroupId, nodeIds] of moveToGroupBuckets) {
      moveNodesBetweenGroups(nodeIds, targetGroupId);
    }
    useCanvasStore.setState((s) => {
      s.historyBatchActive = false;
    });
    useCanvasStore.getState().saveToHistory();
  }, [
    addNodesToGroup,
    consumeFinalPositions,
    endRenderDragSession,
    filterEligibleBounds,
    flowInteractiveRef,
    moveNodesBetweenGroups,
    nodeGraphNodes,
    publishDragStopSnapshot,
    removeNodesFromGroup,
    updateNodePositionsBatch,
  ]);

  void zoom;

  return {
    onNodesChange,
    onNodeDragStart,
    onNodeDrag,
    onNodeDragStop,
    dragTimelineSnapshot,
  };
}
