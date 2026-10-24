"use client";

import type { ComponentProps } from "react";
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  type NodeTypes,
  type OnSelectionChangeFunc,
} from "@xyflow/react";

import { nodeTypes } from "../nodes";
import { AnnotationOverlay } from "./AnnotationOverlay";
import { CanvasOverviewLayer } from "./CanvasOverviewLayer";
import {
  CANVAS_NODE_CLICK_DISTANCE,
  CANVAS_NODE_DRAG_THRESHOLD,
  FIT_VIEW_PADDING,
  ZOOM_LIMITS,
} from "./nodeCanvasConstants";
import type { useFlowRenderState } from "./useFlowRenderState";
import type { useNodeCanvasChangeController } from "./useNodeCanvasChangeController";
import type { useNodeCanvasFlowModel } from "./useNodeCanvasFlowModel";
import type { useNodeCanvasViewportController } from "./useNodeCanvasViewportController";
import { useCanvasStore } from "../../store/canvasStore";

type ReactFlowProps = ComponentProps<typeof ReactFlow>;

type NodeCanvasFlowLayerProps = {
  flowModel: ReturnType<typeof useNodeCanvasFlowModel>;
  flowRenderState: ReturnType<typeof useFlowRenderState>;
  changeController: ReturnType<typeof useNodeCanvasChangeController>;
  viewportController: ReturnType<typeof useNodeCanvasViewportController>;
  onSelectionChange: OnSelectionChangeFunc;
  onNodeClick: NonNullable<ReactFlowProps["onNodeClick"]>;
  onPaneClick: NonNullable<ReactFlowProps["onPaneClick"]>;
  onPaneContextMenu: NonNullable<ReactFlowProps["onPaneContextMenu"]>;
  onNodeContextMenu: NonNullable<ReactFlowProps["onNodeContextMenu"]>;
  openAnnotationContextMenu: ComponentProps<
    typeof AnnotationOverlay
  >["onOpenContextMenu"];
  resolvedSnapGrid: [number, number];
  snapToGridEnabled: boolean;
};

export function NodeCanvasFlowLayer({
  flowModel,
  flowRenderState,
  changeController,
  viewportController,
  onSelectionChange,
  onNodeClick,
  onPaneClick,
  onPaneContextMenu,
  onNodeContextMenu,
  openAnnotationContextMenu,
  resolvedSnapGrid,
  snapToGridEnabled,
}: NodeCanvasFlowLayerProps) {
  // 全局整理预挂载测量态（spec：画布自动布局算法.md「全局整理的预挂载测量」）。
  // 为 true 时临时关闭节点虚拟化，让视口外从未挂载的节点产出 measured，供全局整理消费可信 sizeMap。
  const preLayoutMeasuring = useCanvasStore((state) => state.ui.preLayoutMeasuring);

  return (
    <>
      <CanvasOverviewLayer
        enabled={flowModel.overviewLayerEnabled}
        nodes={flowModel.overviewNodes}
      />
      <ReactFlow
        nodes={flowRenderState.renderNodes}
        {...(flowModel.flowInteractive
          ? {
              onNodesChange: changeController.onNodesChange,
            }
          : {})}
        onSelectionChange={onSelectionChange}
        {...(flowModel.flowInteractive
          ? {
              onNodeClick,
              onPaneClick,
              onPaneContextMenu,
              onNodeContextMenu,
              onNodeDragStart: changeController.onNodeDragStart,
              onNodeDrag: changeController.onNodeDrag,
              onNodeDragStop: changeController.onNodeDragStop,
            }
          : {})}
        onMoveStart={viewportController.onMoveStart}
        onMoveEnd={viewportController.onMoveEnd}
        onInit={viewportController.onInit}
        nodeTypes={nodeTypes as NodeTypes}
        defaultViewport={viewportController.safeViewport}
        fitViewOptions={{
          maxZoom: ZOOM_LIMITS.max,
          padding: FIT_VIEW_PADDING,
          nodes: flowModel.fitViewNodes,
        }}
        nodesDraggable={flowModel.flowInteractive}
        nodesConnectable={false}
        elementsSelectable={false}
        snapToGrid={snapToGridEnabled}
        snapGrid={resolvedSnapGrid}
        minZoom={ZOOM_LIMITS.min}
        maxZoom={ZOOM_LIMITS.max}
        deleteKeyCode={null}
        zoomOnScroll
        panOnDrag
        selectNodesOnDrag={false}
        nodeDragThreshold={CANVAS_NODE_DRAG_THRESHOLD}
        nodeClickDistance={CANVAS_NODE_CLICK_DISTANCE}
        onlyRenderVisibleElements={!preLayoutMeasuring}
        className="bg-background"
      >
        {!flowModel.hideFlowLayer && (
          <>
            {flowModel.flowInteractive && (
              <AnnotationOverlay
                onOpenContextMenu={openAnnotationContextMenu}
              />
            )}
            <Background
              variant={BackgroundVariant.Dots}
              gap={resolvedSnapGrid[0]}
              size={1}
              color="#ddd"
            />
            {/* 小地图底色/遮罩随应用主题（globals.css .react-flow__minimap 令牌绑定）；
                字符串型 maskColor 会以内联 -props 变量压过 CSS 绑定，故不在 JSX 传 */}
            <MiniMap
              position="bottom-right"
              style={{ width: 150, height: 100 }}
              nodeColor={(node) => {
                switch (node.type) {
                  case "start":
                    return "#10b981";
                  case "end":
                    return "#ef4444";
                  case "model":
                    return "#3b82f6";
                  default:
                    return "#6b7280";
                }
              }}
              nodeStrokeColor={(_node) => "#555"}
            />
          </>
        )}
      </ReactFlow>
    </>
  );
}
