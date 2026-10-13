import { useCallback, useEffect, useMemo, useRef } from "react";
import { type ReactFlowInstance } from "@xyflow/react";

import type { CanvasStore } from "../../store/canvasStore";
import {
  createPlaceholderUpgradeScheduler,
  DEFAULT_UPGRADE_BATCH_SIZE,
  type PlaceholderUpgradeScheduler,
} from "../../application/placeholderUpgradeScheduler";
import type { NodeGraph, NodeGraphViewport } from "../../types";
import {
  CANVAS_INTERACTION_DELAY_MS,
  FIT_VIEW_PADDING,
  isDefaultViewport,
  normalizeViewport,
  ZOOM_LIMITS,
} from "./nodeCanvasConstants";

type UseNodeCanvasViewportControllerArgs = {
  nodeGraph: NodeGraph | null;
  nodeGraphId: string | null;
  reactFlowInstance: ReactFlowInstance;
  setViewport: CanvasStore["setViewport"];
  setCanvasInteracting: CanvasStore["setCanvasInteracting"];
  setCanvasInteractingDelayed: CanvasStore["setCanvasInteractingDelayed"];
  /**
   * 占位壳升级编排（spec：画布交互期渲染降级契约.md「moveEnd 后分帧升级契约」）。
   * moveEnd 时读取 store 的 placeholderNodeIds，非空则启动分帧升级；
   * moveStart 时 cancel 正在运行的升级（收敛期被新交互中断）。
   */
  markNodesAsFull: CanvasStore["markNodesAsFull"];
  /** 读取当前占位节点集合（命令式，用于 moveEnd 时判断是否启动升级）。 */
  getPlaceholderNodeIds: () => Set<string>;
  notifyOverviewMoveStart: () => void;
  notifyOverviewMoveEnd: () => void;
  dismissCanvasOverlays: () => void;
  /**
   * 启动准备阶段镜像（spec：画布启动性能与Layout-Model架构.md「ReactFlow 双挂载的消除」
   * 「启动期占位壳契约」）。当 phase 从 waiting-interactive 切到 ready 时，触发一次启动期
   * 分帧升级，把 loadNodeGraph 灌入的占位节点批量升为完整形态。复用同一 upgradeSchedulerRef
   * 单例，与交互期升级天然互斥（onMoveStart 会 cancel）。
   */
  preparationPhase: string;
};

export function useNodeCanvasViewportController({
  nodeGraph,
  nodeGraphId,
  reactFlowInstance,
  setViewport,
  setCanvasInteracting,
  setCanvasInteractingDelayed,
  markNodesAsFull,
  getPlaceholderNodeIds,
  notifyOverviewMoveStart,
  notifyOverviewMoveEnd,
  dismissCanvasOverlays,
  preparationPhase,
}: UseNodeCanvasViewportControllerArgs) {
  const fitViewTimeoutRef = useRef<number | undefined>(undefined);
  const pendingViewportRef = useRef<NodeGraphViewport | null>(null);
  const viewportSyncTimerRef = useRef<number | undefined>(undefined);
  const reactFlowInitializedRef = useRef(false);
  const interactionDelayRef = useRef<number | null>(null);
  const initialFitStateRef = useRef<{
    graphId: string | null;
    enabled: boolean;
    applied: boolean;
  }>({ graphId: null, enabled: false, applied: false });
  // 占位壳升级调度器（组件生命周期内单例，spec：画布交互期渲染降级契约.md「分帧升级契约」）。
  // adapters 用默认（真实 rAF），moveEnd 启动、moveStart cancel，不在这里注入 mock。
  const upgradeSchedulerRef = useRef<PlaceholderUpgradeScheduler | null>(null);
  if (upgradeSchedulerRef.current === null) {
    upgradeSchedulerRef.current = createPlaceholderUpgradeScheduler(undefined);
  }

  const nodeGraphViewport =
    nodeGraph !== null && nodeGraph !== undefined ? nodeGraph.viewport : undefined;
  const safeViewport = useMemo(
    () => normalizeViewport(nodeGraphViewport),
    [nodeGraphViewport],
  );

  const scheduleFitView = useCallback(
    (_reason: string) => {
      if (fitViewTimeoutRef.current) {
        window.clearTimeout(fitViewTimeoutRef.current);
      }
      fitViewTimeoutRef.current = window.setTimeout(() => {
        const nodes = reactFlowInstance.getNodes();
        void reactFlowInstance.fitView({
          maxZoom: ZOOM_LIMITS.max,
          padding: FIT_VIEW_PADDING,
          nodes,
        });
        fitViewTimeoutRef.current = undefined;
      }, 50);
    },
    [reactFlowInstance],
  );

  const requestInitialFitView = useCallback(
    (reason: string) => {
      if (!reactFlowInitializedRef.current) return;
      if (!nodeGraphId) return;
      const state = initialFitStateRef.current;
      if (!state.enabled) return;
      if (state.applied) return;
      if (state.graphId !== nodeGraphId) return;
      state.applied = true;
      scheduleFitView(reason);
    },
    [nodeGraphId, scheduleFitView],
  );

  useEffect(() => {
    if (!nodeGraph) {
      reactFlowInitializedRef.current = false;
      initialFitStateRef.current = {
        graphId: null,
        enabled: false,
        applied: false,
      };
      return;
    }
    const state = initialFitStateRef.current;
    if (state.graphId === nodeGraph.id) return;
    initialFitStateRef.current = {
      graphId: nodeGraph.id,
      enabled: isDefaultViewport(normalizeViewport(nodeGraph.viewport)),
      applied: false,
    };
  }, [nodeGraph]);

  useEffect(() => {
    if (!nodeGraphId) return;
    requestInitialFitView("画板加载");
  }, [nodeGraphId, requestInitialFitView]);

  const scheduleViewportUpdate = useCallback(
    (viewport: NodeGraphViewport) => {
      pendingViewportRef.current = viewport;
      if (viewportSyncTimerRef.current) return;
      viewportSyncTimerRef.current = window.setTimeout(() => {
        const nextViewport = pendingViewportRef.current;
        pendingViewportRef.current = null;
        viewportSyncTimerRef.current = undefined;
        if (nextViewport) {
          setViewport(nextViewport);
        }
      }, 120);
    },
    [setViewport],
  );

  useEffect(
    () => () => {
      if (fitViewTimeoutRef.current) {
        window.clearTimeout(fitViewTimeoutRef.current);
      }
      if (viewportSyncTimerRef.current) {
        window.clearTimeout(viewportSyncTimerRef.current);
      }
    },
    [],
  );

  const onInit = useCallback(() => {
    reactFlowInitializedRef.current = true;
    requestInitialFitView("初始化完成");
  }, [requestInitialFitView]);

  const onMoveEnd = useCallback(
    (_event: unknown, viewport: { x: number; y: number; zoom: number }) => {
      if (interactionDelayRef.current !== null) {
        window.clearTimeout(interactionDelayRef.current);
        interactionDelayRef.current = null;
      }
      setCanvasInteracting(false);
      setCanvasInteractingDelayed(false);
      // 收敛期开始：读取当前占位节点集合，非空则启动分帧升级（spec「moveEnd 后分帧升级契约」）。
      // 空集合不启动调度器，直接回稳态（spec「交互结束时无占位壳待升级」）。
      const placeholderIds = getPlaceholderNodeIds();
      if (placeholderIds.size > 0) {
        const scheduler = upgradeSchedulerRef.current;
        if (scheduler !== null) {
          // upgradeFn 调 markNodesAsFull(batch) 移除占位标记，对应组件重渲染为完整态。
          // 已卸载节点 id 残留在集合中无害：markNodesAsFull 对不存在的 id 是幂等的（Set.delete），
          // 且该节点已无组件订阅 selector，状态变化不触发渲染。
          scheduler.start(
            Array.from(placeholderIds),
            (batch) => markNodesAsFull(batch),
            { batchSize: DEFAULT_UPGRADE_BATCH_SIZE },
          );
        }
      }
      const current = (nodeGraph !== null && nodeGraph !== undefined ? nodeGraph.viewport : undefined);
      if (
        current &&
        current.x === viewport.x &&
        current.y === viewport.y &&
        current.zoom === viewport.zoom
      ) {
        notifyOverviewMoveEnd();
        return;
      }
      scheduleViewportUpdate(viewport);
      notifyOverviewMoveEnd();
    },
    [
      nodeGraph,
      getPlaceholderNodeIds,
      markNodesAsFull,
      notifyOverviewMoveEnd,
      scheduleViewportUpdate,
      setCanvasInteracting,
      setCanvasInteractingDelayed,
    ],
  );

  const onMoveStart = useCallback(() => {
    // 收敛期被新交互中断：cancel 正在运行的升级（spec「收敛期被新交互中断，未升级占位壳保持占位态」）。
    // cancel 只停止后续升级，不回退已完成升级（已升级的是完整态，无需回退）。
    // 新交互期新进入视口节点继续挂载占位（由节点 mount 时的 useLayoutEffect 注册）。
    const scheduler = upgradeSchedulerRef.current;
    if (scheduler !== null) {
      scheduler.cancel();
    }
    dismissCanvasOverlays();
    notifyOverviewMoveStart();
    setCanvasInteracting(true);
    setCanvasInteractingDelayed(false);
    if (interactionDelayRef.current !== null) {
      window.clearTimeout(interactionDelayRef.current);
    }
    interactionDelayRef.current = window.setTimeout(() => {
      setCanvasInteractingDelayed(true);
    }, CANVAS_INTERACTION_DELAY_MS);
  }, [
    dismissCanvasOverlays,
    notifyOverviewMoveStart,
    setCanvasInteracting,
    setCanvasInteractingDelayed,
  ]);

  useEffect(() => {
    return () => {
      setCanvasInteracting(false);
      setCanvasInteractingDelayed(false);
      if (interactionDelayRef.current !== null) {
        window.clearTimeout(interactionDelayRef.current);
        interactionDelayRef.current = null;
      }
    };
  }, [setCanvasInteracting, setCanvasInteractingDelayed]);

  // 启动期占位壳契约（spec：画布启动性能与Layout-Model架构.md「ReactFlow 双挂载的消除」）。
  // preparationPhase 切到 'ready' 表示 NodeCanvas 已完成 readiness 自检、画布进入可交互态。
  // 此时把 loadNodeGraph 灌入的全部占位节点批量启动分帧升级，让节点从占位壳态过渡到完整渲染态。
  // 复用与交互期升级相同的 upgradeSchedulerRef 单例：若用户在升级过程中开始拖拽视口，onMoveStart
  // 会 cancel 当前升级，剩余占位节点保持占位态，由 moveEnd 后的交互期升级路径接管，语义一致。
  // 用 ref 防止同一 graphId 下重复触发（preparationPhase 可能在 graph reload 时多次切到 ready）；
  // graphId 变化时重置 ref，让新 graph 也能触发一次启动期升级。
  const startupUpgradeDoneForGraphIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (preparationPhase !== "ready") return;
    if (nodeGraphId === null || nodeGraphId === undefined) return;
    if (startupUpgradeDoneForGraphIdRef.current === nodeGraphId) return;
    startupUpgradeDoneForGraphIdRef.current = nodeGraphId;

    const placeholderIds = getPlaceholderNodeIds();
    if (placeholderIds.size === 0) return;
    const scheduler = upgradeSchedulerRef.current;
    if (scheduler === null) return;
    // 与 onMoveEnd 路径一致的升级调用：markNodesAsFull(batch) 移除占位标记，
    // 对应组件重渲染为完整态。已卸载节点 id 残留无害（markNodesAsFull 对不存在 id 幂等）。
    scheduler.start(
      Array.from(placeholderIds),
      (batch) => markNodesAsFull(batch),
      { batchSize: DEFAULT_UPGRADE_BATCH_SIZE },
    );
  }, [preparationPhase, nodeGraphId, getPlaceholderNodeIds, markNodesAsFull]);

  return { safeViewport, onInit, onMoveStart, onMoveEnd };
}
