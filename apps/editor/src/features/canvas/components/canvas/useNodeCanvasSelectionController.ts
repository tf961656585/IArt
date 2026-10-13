"use client";

import { useCallback } from "react";
import type { OnSelectionChangeFunc } from "@xyflow/react";

import {
  logCanvasDebugEvent,
  touchCanvasSelectionTrace,
} from "../../debug/canvasDebug";
import { useCanvasStore } from "../../store/canvasStore";
import { isSameIdSet } from "./nodeCanvasConstants";
import type { CanvasSelectionCommand } from "./useCanvasSelectionBridge";

type UseNodeCanvasSelectionControllerArgs = {
  applySelectionCommand: (
    command: CanvasSelectionCommand,
    reason: string,
  ) => void;
};

export function useNodeCanvasSelectionController({
  applySelectionCommand,
}: UseNodeCanvasSelectionControllerArgs): {
  clearCanvasSelection: () => void;
  onSelectionChange: OnSelectionChangeFunc;
} {
  const clearCanvasSelection = useCallback(() => {
    applySelectionCommand(
      {
        kind: "replace-selection",
        selection: { nodeIds: [], annotationIds: [] },
      },
      "pane-click",
    );
  }, [applySelectionCommand]);

  const onSelectionChange: OnSelectionChangeFunc = useCallback(
    ({ nodes }) => {
      const nextNodeIds = nodes.map((node) => node.id);
      const { selectedNodeIds: prevNodeIds, selectedAnnotationIds: prevAnnotationIds } =
        useCanvasStore.getState();
      const traceMeta = touchCanvasSelectionTrace({
        step: "on-selection-change",
        origin: "react-flow-onSelectionChange",
        reason:
          nodes.length > 0
            ? "react-flow-selection-change"
            : "react-flow-selection-clear",
        forceNewTrace: false,
        selectionSource: undefined,
      });
      logCanvasDebugEvent("nodeCanvas:onSelectionChange", {
        ...traceMeta,
        traceScope: "canvas-selection",
        action: "on-selection-change",
        previousStoreSelection: {
          nodeIds: prevNodeIds,
          annotationIds: prevAnnotationIds,
        },
        nextReactFlowSelection: {
          nodeIds: nextNodeIds,
          annotationIds: [],
        },
        storeSelection: {
          nodeIds: prevNodeIds,
          annotationIds: prevAnnotationIds,
        },
        reactFlowSelection: {
          nodeIds: nextNodeIds,
          annotationIds: [],
        },
        disableThrottle: true,
      });

      if (isSameIdSet(nextNodeIds, prevNodeIds)) {
        return;
      }

      logCanvasDebugEvent("nodeCanvas:onSelectionChange:inconsistency-detected", {
        traceScope: "canvas-selection",
        action: "selection-inconsistency-warning",
        previousStoreSelection: {
          nodeIds: prevNodeIds,
          annotationIds: prevAnnotationIds,
        },
        nextReactFlowSelection: {
          nodeIds: nextNodeIds,
        },
        warning: "ReactFlow selection differs from store but onSelectionChange is observer-only, no store write performed",
        disableThrottle: true,
      });
    },
    [],
  );

  return {
    clearCanvasSelection,
    onSelectionChange,
  };
}
