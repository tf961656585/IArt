"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  useReactFlow,
  useStore as useReactFlowStore,
} from "@xyflow/react";
import { toast } from "sonner";
import "@xyflow/react/dist/style.css";

import { isHubRuntime } from "@/client/utils/hubFetch";
import { cn } from "@/lib/utils";
import { usePromptDockAgentEntryRestore } from "@/features/promptdock/agentEntry";
import { useCanvasStore } from "../../store/canvasStore";
import { useCharacterUIStore } from "../../store/characterUIStore";
import { selectLayoutSnapshotNodes, selectPreparationPhase } from "../../store/selectors";
import { CharacterStore } from "../../services/characterStore";
import type { ContainerGapKind, ContextMenuState, NodePosition, NodeSize } from "../../types";
import { DEFAULT_SNAP_GRID } from "../../types";
import type { ContainerGapGeometry } from "../../utils/containerGapHitTest";
import { CharacterDock } from "../character/CharacterDock";
import { CanvasContextMenu } from "./CanvasContextMenu";
import { AgentDeleteConfirmHost, AgentNodeChrome, AssetNodeChrome } from "../chrome";
import { NodeCanvasBundleProgressOverlays } from "./NodeCanvasBundleProgressOverlays";
import { NodeCanvasFlowLayer } from "./NodeCanvasFlowLayer";
import {
  BundleImportWarningsDialog,
  NodeCanvasEmptyState,
  PendingAnnotationBindingBanner,
  PendingPlacementBanner,
} from "./NodeCanvasOverlays";
import {
  EMPTY_NODEGRAPH_NODES,
} from "./nodeCanvasConstants";
import { useCanvasBundleTransferController } from "./useCanvasBundleTransferController";
import { useCanvasFileDropImportController } from "./useCanvasFileDropImportController";
import { useCanvasInteractionController } from "./useCanvasInteractionController";
import { useDeferredFlowRenderControls } from "./useDeferredFlowRenderControls";
import { useNodeCanvasChangeController } from "./useNodeCanvasChangeController";
import { useNodeCanvasFlowModel } from "./useNodeCanvasFlowModel";
import { useNodeCanvasKeyboardShortcuts } from "./useNodeCanvasKeyboardShortcuts";
import { useCanvasDeleteShortcuts } from "../../hooks/useCanvasDeleteShortcuts";
import { useNodeSizeCommitGate } from "./useNodeSizeCommitGate";
import { useNodeCanvasSelectionController } from "./useNodeCanvasSelectionController";
import { useCanvasSelectionBridge } from "./useCanvasSelectionBridge";
import { useNodeCanvasTransientState } from "./useNodeCanvasTransientState";
import { useNodeCanvasViewportController } from "./useNodeCanvasViewportController";
import { useFlowRenderState } from "./useFlowRenderState";
import { useMarqueeSelection } from "./useMarqueeSelection";
import { MarqueeSelectionOverlay } from "./MarqueeSelectionOverlay";
import { useNodeCanvasReadiness } from "./useNodeCanvasReadiness";

/** 无容器时的稳定空几何列表：保持 controller 回调引用稳定（useCallback 依赖比较）。 */
const EMPTY_CONTAINER_GAP_GEOMETRIES: readonly ContainerGapGeometry[] = [];

type NodeCanvasProps = {  /** measured size 变化时回调，供全局整理等兄弟组件读取真实尺寸 */
  onMeasuredSizeChange: ((measuredSizeByNodeId: Readonly<Record<string, NodeSize>>) => void) | undefined;
  /** 组节点派生尺寸变化时回调，供全局整理读取组节点真实尺寸防重叠 */
  onDerivedSizeChange: ((derivedSizeByNodeId: Readonly<Record<string, NodeSize>>) => void) | undefined;
  /**
   * NodeCanvas 启动自检就绪后回调（spec：layout-model-driven 启动收敛）。
   * 控制器把它接到 useCanvasStartupGate，调用后才会从 waiting-interactive 推进到 ready。
   * 缺省 no-op，方便不关心启动语义的调用方（单测、预览）省略。
   */
  markStartupInteractiveReady: (() => void) | undefined;
};

export function NodeCanvas({
  onMeasuredSizeChange,
  onDerivedSizeChange,
  markStartupInteractiveReady,
}: Partial<NodeCanvasProps> = {}) {
  const nodeGraph = useCanvasStore((state) => state.nodeGraph);
  const nodeGraphId = useCanvasStore((state) => (state.nodeGraph !== null && state.nodeGraph !== undefined ? state.nodeGraph.id : undefined) ?? null);
  // 启动准备阶段镜像（spec：画布启动性能与Layout-Model架构.md「启动期占位壳契约」）。
  // 传给 viewport controller，切到 'ready' 时触发启动期分帧升级，把 loadNodeGraph 灌入的
  // 占位节点从占位壳态批量升级为完整渲染态。
  const preparationPhase = useCanvasStore(selectPreparationPhase);
  // 启动自检：等待 ReactFlow nodeLookup 稳定后通知 preparation controller 放行。
  // 仅在传入 markStartupInteractiveReady 时启用，单测 / 预览可省略。
  useNodeCanvasReadiness({
    graphId: nodeGraphId,
    onReady: () => {
      if (markStartupInteractiveReady) {
        markStartupInteractiveReady();
      }
    },
  });
  const projectMediaAssets = useCanvasStore((state) => state.mediaAssets);
  const nodeGraphNodes = useCanvasStore(
    (state) => (state.nodeGraph !== null && state.nodeGraph !== undefined ? state.nodeGraph.nodes : undefined) ?? EMPTY_NODEGRAPH_NODES,
  );
  const layoutSnapshotNodes = useCanvasStore(selectLayoutSnapshotNodes);
  const structureRevision = useCanvasStore((state) => state.structureRevision);
  const positionRevision = useCanvasStore((state) => state.positionRevision);
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const pendingAnnotationBinding = useCanvasStore(
    (state) => state.pendingAnnotationBinding,
  );

  const cancelAnnotationBinding = useCanvasStore(
    (state) => state.cancelAnnotationBinding,
  );
  const bindAnnotation = useCanvasStore((state) => state.bindAnnotation);
  const updateNodePositionsBatch = useCanvasStore(
    (state) => state.updateNodePositionsBatch,
  );
  const addNode = useCanvasStore((state) => state.addNode);
  const removeNodes = useCanvasStore((state) => state.removeNodes);
  const addNodesToGroup = useCanvasStore((state) => state.addNodesToGroup);
  const removeNodesFromGroup = useCanvasStore(
    (state) => state.removeNodesFromGroup,
  );
  const moveNodesBetweenGroups = useCanvasStore(
    (state) => state.moveNodesBetweenGroups,
  );
  const setViewport = useCanvasStore((state) => state.setViewport);
  const setCanvasInteracting = useCanvasStore(
    (state) => state.setCanvasInteracting,
  );
  const setCanvasInteractingDelayed = useCanvasStore(
    (state) => state.setCanvasInteractingDelayed,
  );
  // 占位壳升级编排 actions（spec：画布交互期渲染降级契约.md「分帧升级契约」）。
  const markNodesAsFull = useCanvasStore((state) => state.markNodesAsFull);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  // measured 会话态缓存写入（spec：画布节点尺寸管理架构.md「measured 的会话态缓存」）。
  // 把当前 actualSizeByNodeId 快照写入 store，让视口外节点保留最近一次 measured。
  const commitMeasuredSizeSnapshot = useCanvasStore((state) => state.commitMeasuredSizeSnapshot);

  const pendingPlacement = useCharacterUIStore(
    (state) => state.pendingPlacement,
  );
  const cancelPlacement = useCharacterUIStore((state) => state.cancelPlacement);
  const completePlacement = useCharacterUIStore(
    (state) => state.completePlacement,
  );

  const reactFlowInstance = useReactFlow();
  const zoom = useReactFlowStore((state) => state.transform[2]);
  // 画布容器实测尺寸同步（会话态，spec：PromptDock生成主链.md「终态画布投影」任务落位）：
  // 供任务节点视口锚定落位把视口 pan/zoom 换算成「可见世界矩形」。
  const rfContainerWidth = useReactFlowStore((state) => state.width);
  const rfContainerHeight = useReactFlowStore((state) => state.height);
  const setCanvasContainerSize = useCanvasStore(
    (state) => state.setCanvasContainerSize,
  );
  useEffect(() => {
    setCanvasContainerSize(
      rfContainerWidth > 0 && rfContainerHeight > 0
        ? { width: rfContainerWidth, height: rfContainerHeight }
        : null,
    );
  }, [rfContainerWidth, rfContainerHeight, setCanvasContainerSize]);
  const { screenToFlowPosition } = reactFlowInstance;
  const canvasRootRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    open: false,
    target: null,
    screenPosition: { x: 0, y: 0 },
  });

  const snapSettings = useCanvasStore((state) => (state.nodeGraph !== null && state.nodeGraph !== undefined ? state.nodeGraph.settings : undefined));
  const snapGrid = snapSettings !== null && snapSettings !== undefined ? snapSettings.snapGrid : undefined;
  const resolvedSnapGrid = useMemo<[number, number]>(() => {
    if (Array.isArray(snapGrid) && snapGrid.length === 2) {
      const [x, y] = snapGrid;
      if (Number.isFinite(x) && Number.isFinite(y) && x > 0 && y > 0) {
        return [x, y];
      }
    }
    return [...DEFAULT_SNAP_GRID];
  }, [snapGrid]);
  const snapToGridEnabled = (snapSettings !== null && snapSettings !== undefined ? snapSettings.snapToGrid : undefined) ?? false;

  const bundleTransfer = useCanvasBundleTransferController({
    projectMediaAssets,
  });
  const {
    bundleExport,
    bundleImport,
    startBundleImport,
    bundleImportWarningsDialog,
    setBundleImportWarningsDialog,
  } = bundleTransfer;

  const closeContextMenu = useCallback(() => {
    setContextMenu({
      open: false,
      target: null,
      screenPosition: { x: 0, y: 0 },
    });
  }, []);

  const transientState = useNodeCanvasTransientState();
  const flowRenderControls = useDeferredFlowRenderControls();

  const flowModel = useNodeCanvasFlowModel({
    nodeGraph,
    nodeGraphId,
    nodeGraphNodes,
    layoutSnapshotNodes,
    structureRevision,
    positionRevision,
    selectedNodeIds,
    transientDimensions: transientState.transientDimensions,
    zoom,
  });

  const flowRenderState = useFlowRenderState({
    stableNodes: flowModel.flowNodes,
    nodeGraphId,
    structureRevision,
    positionRevision,
    flowComputationEnabled: true,
  });
  flowRenderControls.connectFlowRenderState({
    flowRenderState,
  });

  useNodeSizeCommitGate({ actualSizeByNodeId: flowModel.actualSizeByNodeId });

  // measured size 上抛：供全局整理等兄弟组件（CanvasToolbar）读取真实尺寸防重叠
  useEffect(() => {
    if (onMeasuredSizeChange) {
      onMeasuredSizeChange(flowModel.actualSizeByNodeId);
    }
    // 同步写入 store 会话态缓存，让视口外节点保留最近一次 measured（spec：
    // 画布节点尺寸管理架构.md「measured 的会话态缓存」）。不回流为 desired。
    commitMeasuredSizeSnapshot(flowModel.actualSizeByNodeId);
  }, [flowModel.actualSizeByNodeId, onMeasuredSizeChange, commitMeasuredSizeSnapshot]);

  // derived size 上抛：组节点派生尺寸（由成员几何派生）。
  // 全局整理时组节点尺寸只能由 derived 承载（spec：画布节点尺寸管理架构.md），
  // 不回退到 measured/desired/default，故需单独把 derived 透传给调用方。
  // byGroupId 的形状是 Record<groupId, GroupDerivedEntry>，这里投影为 Record<groupId, NodeSize>。
  const derivedSizeByNodeId = useMemo<Readonly<Record<string, NodeSize>>>(
    () => {
      const byGroupId = flowModel.groupDerivedProjection.byGroupId;
      const next: Record<string, NodeSize> = {};
      for (const groupId of Object.keys(byGroupId)) {
        const entry = byGroupId[groupId];
        if (entry) next[groupId] = entry.size;
      }
      return next;
    },
    [flowModel.groupDerivedProjection],
  );

  useEffect(() => {
    if (onDerivedSizeChange) {
      onDerivedSizeChange(derivedSizeByNodeId);
    }
  }, [derivedSizeByNodeId, onDerivedSizeChange]);

  // 容器内空白右键的几何事实源：容器派生尺寸投影（position + size）按节点类型判别载体。
  // 派生投影只存在于投影层（不落盘不回流 store，spec：画布节点尺寸管理架构.md「派生尺寸」），
  // 这里只做只读组装，不新增尺寸事实源。
  const containerGapGeometries = useMemo<readonly ContainerGapGeometry[]>(() => {
    const byGroupId = flowModel.groupDerivedProjection.byGroupId;
    const containerIds = Object.keys(byGroupId);
    if (containerIds.length === 0) return EMPTY_CONTAINER_GAP_GEOMETRIES;
    const kindByNodeId = new Map<string, ContainerGapKind>();
    for (const node of nodeGraphNodes) {
      if (node.type === 'group') {
        kindByNodeId.set(node.id, 'group');
      } else if (node.type === 'agent') {
        kindByNodeId.set(node.id, 'agentContainer');
      }
    }
    const geometries: ContainerGapGeometry[] = [];
    const unmatchedIds: string[] = [];
    for (const id of containerIds) {
      const kind = kindByNodeId.get(id);
      const entry = byGroupId[id];
      if (kind === undefined || entry === undefined) {
        unmatchedIds.push(id);
        continue;
      }
      geometries.push({
        containerNodeId: id,
        containerKind: kind,
        x: entry.position.x,
        y: entry.position.y,
        width: entry.size.width,
        height: entry.size.height,
      });
    }
    // 条件跳过必须留痕（AGENTS.md）：派生投影的容器 id 在节点表中找不到属投影不一致，
    // 该容器不参与空白命中判定，留 debug 痕迹供排查。
    if (unmatchedIds.length > 0) {
      console.debug('[nodeCanvas] container gap geometry skipped: derived id not in node graph', {
        containerIds: unmatchedIds,
      });
    }
    return geometries;
  }, [flowModel.groupDerivedProjection, nodeGraphNodes]);

  const selectionBridge = useCanvasSelectionBridge();

  const getFlowNodes = useCallback(
    () => reactFlowInstance.getNodes(),
    [reactFlowInstance],
  );

  const {
    marqueeState,
    startMarquee,
    cancelMarquee,
    skipNextPaneClickRef,
  } = useMarqueeSelection({
    screenToFlowPosition,
    applySelectionCommand: selectionBridge.applySelectionCommand,
    getFlowNodes,
    containerRef: canvasRootRef,
  });

  const dismissCanvasOverlays = useCallback(() => {
    closeContextMenu();
  }, [closeContextMenu]);

  const viewportController = useNodeCanvasViewportController({
    nodeGraph,
    nodeGraphId,
    reactFlowInstance,
    setViewport,
    setCanvasInteracting,
    setCanvasInteractingDelayed,
    markNodesAsFull,
    // 命令式读取当前占位集合，用于 moveEnd 判断是否启动升级（不订阅，避免无谓重渲染）。
    getPlaceholderNodeIds: () => useCanvasStore.getState().ui.placeholderNodeIds,
    notifyOverviewMoveStart: flowModel.notifyOverviewMoveStart,
    notifyOverviewMoveEnd: flowModel.notifyOverviewMoveEnd,
    dismissCanvasOverlays,
    preparationPhase,
  });

  const changeController = useNodeCanvasChangeController({
    nodeGraphId,
    flowInteractiveRef: flowModel.flowInteractiveRef,
    transientDimensionsRef: transientState.transientDimensionsRef,
    setTransientDimensions: transientState.setTransientDimensions,
    clearTransientDimensionsForNodeIds:
      transientState.clearTransientDimensionsForNodeIds,
    cancelTransientDimensionCleanup:
      transientState.cancelTransientDimensionCleanup,
    scheduleTransientDimensionCleanup:
      transientState.scheduleTransientDimensionCleanup,
    applyRenderPositionUpdates: flowRenderControls.applyRenderPositionUpdates,
    beginRenderDragSession: flowRenderControls.beginRenderDragSession,
    endRenderDragSession: flowRenderControls.endRenderDragSession,
    removeRenderNodes: flowRenderState.removeRenderNodes,
    updateNodePositionsBatch,
    removeNodes,
    addNodesToGroup,
    removeNodesFromGroup,
    moveNodesBetweenGroups,
    nodeGraphNodes,
    zoom,
  });

  useCanvasDeleteShortcuts(flowModel.flowInteractive);

  const { clearCanvasSelection, onSelectionChange } =
    useNodeCanvasSelectionController({
      applySelectionCommand: selectionBridge.applySelectionCommand,
    });

  // 选中驱动进入的还原观察者（spec docs/agent/06「选中驱动的进入—还原—粘滞」）：
  // 选择集离开进入节点时把 PromptDock 形态与绑定还原回进入前。
  usePromptDockAgentEntryRestore();

  useNodeCanvasKeyboardShortcuts({
    pendingPlacement,
    cancelPlacement,
    pendingAnnotationBinding,
    cancelAnnotationBinding,
    cancelMarquee,
    clearCanvasSelection,
    canvasRef: canvasRootRef,
  });

  const createCharacterImageNode = useCallback(
    async (position: NodePosition, characterId: string) => {
      if (!nodeGraph) return;
      const character = await CharacterStore.get(characterId);
      if (!character || !character.imageUrl) {
        toast.error("没能加载角色图片，请重试");
        return;
      }
      const node = addNode("imageInput", position, undefined);
      if (!node) {
        toast.error("没能创建节点，请重试");
        return;
      }
      updateNodeData(node.id, {
        imageUrl: character.imageUrl,
        valueSource: "upload",
        label: character.name,
      }, undefined);
      toast.success(`已创建角色「${character.name}」节点`);
    },
    [addNode, nodeGraph, updateNodeData],
  );

  const {
    onNodeClick,
    onPaneClick,
    onPaneContextMenu,
    onCanvasContextMenu,
    onNodeContextMenu,
    onCanvasKeyDown,
    openAnnotationContextMenu,
    handleCanvasMouseDownCapture,
  } = useCanvasInteractionController({
    contextMenuOpen: contextMenu.open,
    setContextMenu,
    closeContextMenu,
    screenToFlowPosition,
    containerGeometries: containerGapGeometries,
    applySelectionCommand: selectionBridge.applySelectionCommand,
    selectNodes: selectionBridge.selectNodes,
    selectAnnotations: selectionBridge.selectAnnotations,
    clearCanvasSelection,
    pendingPlacement,
    createCharacterImageNode,
    completePlacement,
    pendingAnnotationBinding,
    bindAnnotation,
    cancelAnnotationBinding,
    startMarquee,
    skipNextPaneClickRef,
    cancelMarquee,
  });

  const { onDragOver, onDrop } = useCanvasFileDropImportController({
    screenToFlowPosition,
    addNode,
    selectNodes: selectionBridge.selectNodes,
  });

  // 节点键盘等价（spec docs/agent/02「选中态工具栏」/ docs/agent/06「键盘与焦点」）：
  // Tab 聚焦由 React Flow 的节点容器承担，事件从它冒泡到这里。挂原生监听而不是 JSX
  // onKeyDown：节点容器的 DOM 由 React Flow 渲染（不是本组件的静态子树），画布根这一层
  // 才是能确定拿到其冒泡的位置；同时避免在非交互静态元素上声明键盘交互。
  useEffect(() => {
    const root = canvasRootRef.current;
    if (root === null || !flowModel.flowInteractive) return;
    root.addEventListener('keydown', onCanvasKeyDown);
    return () => {
      root.removeEventListener('keydown', onCanvasKeyDown);
    };
  }, [flowModel.flowInteractive, onCanvasKeyDown]);

  const cancelPlacementFromBanner = useCallback(() => {
    cancelPlacement();
    toast.info("已取消放置角色");
  }, [cancelPlacement]);

  const cancelAnnotationBindingFromBanner = useCallback(() => {
    cancelAnnotationBinding();
    toast.info("已取消注释绑定");
  }, [cancelAnnotationBinding]);

  if (!nodeGraph) {
    const emptyMessage = isHubRuntime()
      ? "请先在项目管理应用中创建或打开项目"
      : "请先创建或打开画布";
    return <NodeCanvasEmptyState message={emptyMessage} />;
  }

  return (
    <div
      ref={canvasRootRef}
      className={cn(
        "relative w-full h-full",
        flowModel.hideFlowLayer && flowModel.flowHiddenClassName,
        (pendingPlacement || pendingAnnotationBinding) && "cursor-crosshair",
      )}
      // tabIndex=-1：Esc 退一层后把焦点交回画布（可编程聚焦，不进 Tab 序列；
      // 节点的 Tab 停靠点由 React Flow 的节点容器承担，见 useCanvasInteractionController）。
      tabIndex={-1}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onContextMenu={
        flowModel.flowInteractive ? onCanvasContextMenu : undefined
      }
      onMouseDownCapture={
        flowModel.flowInteractive ? handleCanvasMouseDownCapture : undefined
      }
    >
      <NodeCanvasFlowLayer
        flowModel={flowModel}
        flowRenderState={flowRenderState}
        changeController={changeController}
        viewportController={viewportController}
        onSelectionChange={onSelectionChange}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onPaneContextMenu={onPaneContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        openAnnotationContextMenu={openAnnotationContextMenu}
        snapToGridEnabled={snapToGridEnabled}
        resolvedSnapGrid={resolvedSnapGrid}
      />
      <MarqueeSelectionOverlay marqueeState={marqueeState} />
      {/* 资产节点选中态双层 chrome（设计层 node-chrome：顶栏加工工具 / 底栏路由动作） */}
      <AssetNodeChrome canvasRef={canvasRootRef} />
      {/* Agent 节点选中态工具栏（使用 agent｜解散｜删除；会话视图随选中驱动进入打开，spec docs/agent/02） */}
      <AgentNodeChrome canvasRef={canvasRootRef} />
      {/* Agent 删除确认框宿主（AG-CT-011：所有删除入口经确认请求通道汇聚于此，禁旁路） */}
      <AgentDeleteConfirmHost />
      <NodeCanvasBundleProgressOverlays
        transferController={bundleTransfer}
      />
      <CharacterDock />
      <PendingPlacementBanner
        pendingPlacement={pendingPlacement}
        onCancel={cancelPlacementFromBanner}
      />
      <PendingAnnotationBindingBanner
        active={Boolean(pendingAnnotationBinding)}
        onCancel={cancelAnnotationBindingFromBanner}
      />
      <CanvasContextMenu
        open={contextMenu.open}
        target={contextMenu.target}
        screenPosition={contextMenu.screenPosition}
        onRequestBundleExport={bundleExport.start}
        onRequestBundleImportInsert={startBundleImport}
        isBundleImportRunning={bundleImport.state.status === "running"}
        measuredSizeByNodeId={flowModel.actualSizeByNodeId}
        derivedSizeByNodeId={derivedSizeByNodeId}
        onClose={closeContextMenu}
      />
      <BundleImportWarningsDialog
        dialog={bundleImportWarningsDialog}
        setDialog={setBundleImportWarningsDialog}
      />
    </div>
  );
}

export default NodeCanvas;
