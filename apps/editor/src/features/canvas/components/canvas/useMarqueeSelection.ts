"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Node } from "@xyflow/react";

import { marqueeHitTest } from "../../utils/marqueeHitTest";
import type { MarqueeHitTarget, MarqueeRect } from "../../utils/marqueeHitTest";
import type { CanvasSelectionCommand } from "./useCanvasSelectionBridge";
import { readFlowNodeActualSize } from "./flowNodeActualSize";
import { resolveEffectiveSize } from "../../utils/effectiveSize";
import { useCanvasStore } from "../../store/canvasStore";
import { selectGraphNodeById } from "../../store/selectors.base";
import { resolveAnnotationPosition } from "../../utils/annotationLayout";
import type { EffectiveSizeSources } from "../../utils/effectiveSize";

export interface MarqueeScreenState {
  isActive: boolean;
  startScreenX: number;
  startScreenY: number;
  currentScreenX: number;
  currentScreenY: number;
}

const INITIAL_MARQUEE_STATE: MarqueeScreenState = {
  isActive: false,
  startScreenX: 0,
  startScreenY: 0,
  currentScreenX: 0,
  currentScreenY: 0,
};

export interface MarqueeSessionAPI {
  marqueeState: MarqueeScreenState;
  startMarquee: (startScreenX: number, startScreenY: number) => void;
  cancelMarquee: () => void;
  skipNextPaneClickRef: React.RefObject<boolean>;
}

interface UseMarqueeSelectionParams {
  screenToFlowPosition: (pos: { x: number; y: number }) => { x: number; y: number };
  applySelectionCommand: (command: CanvasSelectionCommand, reason: string) => void;
  getFlowNodes: () => Node[];
  containerRef: React.RefObject<HTMLDivElement | null>;
}

const DRAG_THRESHOLD_PX = 5;

export function useMarqueeSelection({
  screenToFlowPosition,
  applySelectionCommand,
  getFlowNodes,
  containerRef,
}: UseMarqueeSelectionParams): MarqueeSessionAPI {
  const [marqueeState, setMarqueeState] = useState<MarqueeScreenState>(INITIAL_MARQUEE_STATE);
  const skipNextPaneClickRef = useRef<boolean>(false);

  // 存储事件处理器引用，用于清理
  const mousemoveHandlerRef = useRef<((e: MouseEvent) => void) | null>(null);
  const mouseupHandlerRef = useRef<((e: MouseEvent) => void) | null>(null);
  const blurHandlerRef = useRef<(() => void) | null>(null);
  const selectStartHandlerRef = useRef<((e: Event) => void) | null>(null);

  // 在 ref 中存储容器偏移量，避免闭包陈旧值
  const containerOffsetRef = useRef<{ left: number; top: number }>({ left: 0, top: 0 });
  // 存储起始屏幕坐标
  const startCoordRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const cleanupListeners = useCallback(() => {
    if (mousemoveHandlerRef.current !== null) {
      window.removeEventListener("mousemove", mousemoveHandlerRef.current);
      mousemoveHandlerRef.current = null;
    }
    if (mouseupHandlerRef.current !== null) {
      window.removeEventListener("mouseup", mouseupHandlerRef.current);
      mouseupHandlerRef.current = null;
    }
    if (blurHandlerRef.current !== null) {
      window.removeEventListener("blur", blurHandlerRef.current);
      blurHandlerRef.current = null;
    }
    if (selectStartHandlerRef.current !== null) {
      window.removeEventListener("selectstart", selectStartHandlerRef.current, true);
      selectStartHandlerRef.current = null;
    }
  }, []);

  const cancelMarquee = useCallback(() => {
    setMarqueeState(INITIAL_MARQUEE_STATE);
    cleanupListeners();
  }, [cleanupListeners]);

  const startMarquee = useCallback(
    (startScreenX: number, startScreenY: number) => {
      const container = containerRef.current;
      if (container === null || container === undefined) {
        return;
      }

      const rect = container.getBoundingClientRect();
      containerOffsetRef.current = { left: rect.left, top: rect.top };
      startCoordRef.current = { x: startScreenX, y: startScreenY };

      const startX = startScreenX;
      const startY = startScreenY;

      const handleMouseMove = (e: MouseEvent) => {
        const offset = containerOffsetRef.current;
        const relX = e.clientX - offset.left;
        const relY = e.clientY - offset.top;

        setMarqueeState((prev) => {
          if (!prev.isActive) {
            return {
              isActive: true,
              startScreenX: startX - offset.left,
              startScreenY: startY - offset.top,
              currentScreenX: relX,
              currentScreenY: relY,
            };
          }
          return {
            ...prev,
            currentScreenX: relX,
            currentScreenY: relY,
          };
        });
      };

      const handleMouseUp = (e: MouseEvent) => {
        const startCoord = startCoordRef.current;

        const distance = Math.hypot(
          e.clientX - startCoord.x,
          e.clientY - startCoord.y,
        );

        if (distance >= DRAG_THRESHOLD_PX) {
          // 将起始和当前屏幕坐标转换为 flow 坐标
          const flowStart = screenToFlowPosition({ x: startCoord.x, y: startCoord.y });
          const flowEnd = screenToFlowPosition({ x: e.clientX, y: e.clientY });

          // 构建碰撞检测矩形（取两点构成矩形的左上和右下）
          const marqueeRect: MarqueeRect = {
            x1: Math.min(flowStart.x, flowEnd.x),
            y1: Math.min(flowStart.y, flowEnd.y),
            x2: Math.max(flowStart.x, flowEnd.x),
            y2: Math.max(flowStart.y, flowEnd.y),
          };

          // 从节点列表构建碰撞检测目标。
          // 尺寸经统一解析入口 resolveEffectiveSize 解析：layoutModel > measured > default，
          // 确保框选不漏选视口外节点；desired 收窄为 runtime 期漂移校准，不进入主优先级链
          // （spec：画布启动性能与Layout-Model架构.md）。
          const flowNodes = getFlowNodes();
          const storeState = useCanvasStore.getState();
          const desiredByNodeId = storeState.ui.desiredSizeByNodeId;
          const nodeTargets: MarqueeHitTarget[] = flowNodes.map((node) => {
            const measured = readFlowNodeActualSize(node);
            const graphNode = selectGraphNodeById(node.id)(storeState);
            const desiredEntry = desiredByNodeId !== null && desiredByNodeId !== undefined ? desiredByNodeId[node.id] : undefined;
            const resolvedSize = resolveEffectiveSize(graphNode, {
              measuredByNodeId: measured !== null ? { [node.id]: measured } : undefined,
              desiredByNodeId: desiredEntry !== undefined ? { [node.id]: desiredEntry } : undefined,
              derivedByNodeId: undefined,
              defaultByNodeId: undefined,
              layoutModelByNodeId: undefined,
            });
            return {
              id: node.id,
              kind: 'node' as const,
              position: { x: node.position.x, y: node.position.y },
              width: resolvedSize.width,
              height: resolvedSize.height,
            };
          });

          // 注释碰撞检测目标：自由注释用 store 位置，绑定注释用派生位置
          // （派生位置经 resolveAnnotationPosition + 统一尺寸入口解析，与渲染口径一致）。
          const graph = storeState.nodeGraph;
          const annotations = graph !== null && graph !== undefined ? (graph.annotations ?? []) : [];
          const graphNodes = graph !== null && graph !== undefined ? graph.nodes : [];
          const sizeSources: EffectiveSizeSources = {
            measuredByNodeId: storeState.ui.lastMeasuredSizeByNodeId ?? undefined,
            desiredByNodeId: storeState.ui.desiredSizeByNodeId ?? undefined,
            derivedByNodeId: undefined,
            defaultByNodeId: undefined,
            layoutModelByNodeId: storeState.ui.layoutModelByNodeId ?? undefined,
          };
          const annotationTargets: MarqueeHitTarget[] = annotations.map((ann) => {
            const resolved = resolveAnnotationPosition(ann, {
              nodes: graphNodes,
              sizeSources,
            });
            return {
              id: ann.id,
              kind: 'annotation' as const,
              position: resolved,
              width: ann.size.width,
              height: ann.size.height,
            };
          });

          const hitResult = marqueeHitTest(marqueeRect, [...nodeTargets, ...annotationTargets]);

          applySelectionCommand(
            {
              kind: "replace-selection",
              selection: {
                nodeIds: hitResult.nodeIds,
                annotationIds: hitResult.annotationIds,
              },
            },
            "marquee-selection",
          );

          skipNextPaneClickRef.current = true;
        }

        // 清理会话
        setMarqueeState(INITIAL_MARQUEE_STATE);
        cleanupListeners();
      };

      const handleBlur = () => {
        cancelMarquee();
      };

      // 框选是自定义手势：mousedown capture 已 stopPropagation 拦掉 React Flow 平移，
      // 也因此绕过了 React Flow/d3-drag 手势自带的「手势期抑制原生选区」处理。不拦截
      // selectstart 时，mousedown 默认动作发起的原生拖拽选区会扫过 PromptDock 等
      // 画布覆盖层，连带选中其文字。capture 阶段拦截，不影响焦点与点击语义。
      const suppressSelectStart = (e: Event) => {
        e.preventDefault();
      };

      // 保存引用以便后续清理
      mousemoveHandlerRef.current = handleMouseMove;
      mouseupHandlerRef.current = handleMouseUp;
      blurHandlerRef.current = handleBlur;
      selectStartHandlerRef.current = suppressSelectStart;

      // 注册 window 级别监听器（冒泡阶段；selectstart 走 capture，见上）
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
      window.addEventListener("blur", handleBlur);
      window.addEventListener("selectstart", suppressSelectStart, true);

      // 设置初始状态
      const relStartX = startScreenX - rect.left;
      const relStartY = startScreenY - rect.top;
      setMarqueeState({
        isActive: true,
        startScreenX: relStartX,
        startScreenY: relStartY,
        currentScreenX: relStartX,
        currentScreenY: relStartY,
      });
    },
    [containerRef, screenToFlowPosition, applySelectionCommand, getFlowNodes, cleanupListeners, cancelMarquee],
  );

  // 组件卸载时清理监听器
  useEffect(() => {
    return () => {
      cleanupListeners();
    };
  }, [cleanupListeners]);

  return {
    marqueeState,
    startMarquee,
    cancelMarquee,
    skipNextPaneClickRef,
  };
}
