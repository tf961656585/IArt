"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  useReactFlow,
  useStore as useReactFlowStore,
  type ReactFlowInstance,
} from "@xyflow/react";
import { shallow } from "zustand/shallow";

import { isElectronDev } from "@/client/utils/runtimeFlags";
import { useCanvasStore } from "../../store/canvasStore";
import {
  logCanvasDebugEvent,
  touchCanvasSelectionTrace,
} from "../../debug/canvasDebug";
import { normalizeSelectionContractFields } from "../../utils/selectionNormalize";

export type CanvasSelectionContract = {
  nodeIds: string[];
  annotationIds: string[];
};

export type CanvasSelectionCommand =
  | {
      kind: "replace-selection";
      selection: CanvasSelectionContract;
    }
  | {
      kind: "select-all";
    };

type PendingSelectionCommand = {
  command: CanvasSelectionCommand;
  reason: string;
};

const EMPTY_SELECTION_CONTRACT: CanvasSelectionContract = {
  nodeIds: [],
  annotationIds: [],
};

const readSelectionDelta = (
  previous: CanvasSelectionContract,
  next: CanvasSelectionContract,
): {
  changedNodeIds: string[];
} => {
  const previousNodeIds = new Set(previous.nodeIds);
  const nextNodeIds = new Set(next.nodeIds);

  const changedNodeIds = [
    ...previous.nodeIds.filter((id) => !nextNodeIds.has(id)),
    ...next.nodeIds.filter((id) => !previousNodeIds.has(id)),
  ];

  return {
    changedNodeIds,
  };
};

const normalizeSelectionContract = (
  selection: CanvasSelectionContract,
): CanvasSelectionContract => {
  const normalized = normalizeSelectionContractFields({
    nodeIds: selection.nodeIds,
    annotationIds: selection.annotationIds,
  });
  return {
    nodeIds: normalized.nodeIds,
    annotationIds: normalized.annotationIds,
  };
};

const resolveSelectionContract = (
  reactFlowInstance: ReactFlowInstance,
  selection: CanvasSelectionContract,
  annotationIdSet: ReadonlySet<string>,
): CanvasSelectionContract => {
  const normalized = normalizeSelectionContract(selection);
  const reactFlowNodes = reactFlowInstance.getNodes();
  const reactFlowNodeIdSet = new Set(reactFlowNodes.map((node) => node.id));
  return {
    nodeIds: normalized.nodeIds.filter((nodeId) => reactFlowNodeIdSet.has(nodeId)),
    annotationIds: normalized.annotationIds.filter((annotationId) =>
      annotationIdSet.has(annotationId),
    ),
  };
};

const resolveSelectionContractForCommand = (
  reactFlowInstance: ReactFlowInstance,
  command: CanvasSelectionCommand,
  annotationIdSet: ReadonlySet<string>,
): CanvasSelectionContract => {
  if (command.kind === "replace-selection") {
    return resolveSelectionContract(
      reactFlowInstance,
      command.selection,
      annotationIdSet,
    );
  }
  if (command.kind === "select-all") {
    return {
      nodeIds: reactFlowInstance.getNodes().map((node) => node.id),
      // 全选覆盖注释（spec：画布注释.md「选中语义」——一旦注释进入选中集合，
      // 删除/历史等命令必须将其与节点同等对待；全选是显式选择全部，注释应一并进入）
      annotationIds: Array.from(annotationIdSet),
    };
  }
  return EMPTY_SELECTION_CONTRACT;
};

const canApplySelectionCommand = (
  command: CanvasSelectionCommand,
  renderNodeIdSet: Set<string>,
): boolean => {
  if (command.kind === "select-all") {
    return true;
  }
  const normalized = normalizeSelectionContract(command.selection);
  return normalized.nodeIds.every((nodeId) => renderNodeIdSet.has(nodeId));
};

export function useCanvasSelectionBridge(): {
  applySelectionCommand: (
    command: CanvasSelectionCommand,
    reason: string,
  ) => void;
  selectAnnotations: (annotationIds: string[], reason: string) => void;
  selectEntireCanvas: (reason: string) => void;
  selectNodes: (nodeIds: string[], reason: string) => void;
} {
  const reactFlowInstance = useReactFlow();
  const reactFlowNodeIds = useReactFlowStore(
    (state) => state.nodes.map((node) => node.id),
    shallow,
  );
  const nodeGraph = useCanvasStore((state) => state.nodeGraph);
  const projectSelectionContract = useCanvasStore(
    (state) => state.projectSelectionContract,
  );
  const pendingSelectionCommandRef = useRef<PendingSelectionCommand | null>(
    null,
  );

  const renderNodeIdSet = useMemo(
    () => new Set(reactFlowNodeIds),
    [reactFlowNodeIds],
  );
  const annotationIdSet = useMemo(() => {
    const ids = new Set<string>();
    for (const annotation of (nodeGraph !== null && nodeGraph !== undefined ? nodeGraph.annotations : undefined) ?? []) {
      ids.add(annotation.id);
    }
    return ids;
  }, [nodeGraph]);

  const logSelectionBridgeEvent = useCallback(
    (
      action: string,
      reason: string,
      selection: CanvasSelectionContract,
    ) => {
      if (!isElectronDev()) return;
      const storeState = useCanvasStore.getState();
      const reactFlowNodes = reactFlowInstance.getNodes();
      const traceMeta = touchCanvasSelectionTrace({
        step: action,
        origin: "selection-bridge",
        reason,
        forceNewTrace: false,
        selectionSource: undefined,
      });
      const reactFlowSelectedNodeIds = reactFlowNodes
        .filter((node) => Boolean(node.selected))
        .map((node) => node.id);
      logCanvasDebugEvent("selectionBridge", {
        ...traceMeta,
        traceScope: "canvas-selection",
        action,
        selectionReason: reason,
        storeSelection: {
          nodeIds: storeState.selectedNodeIds,
          annotationIds: storeState.selectedAnnotationIds,
        },
        reactFlowSelection: {
          nodeIds: reactFlowSelectedNodeIds,
        },
        renderSelection: selection,
        targetSummary: {
          renderNodeCount: reactFlowNodeIds.length,
        },
        throttleKey: `selectionBridge:${action}`,
        disableThrottle: true,
      });
    },
    [reactFlowInstance, reactFlowNodeIds],
  );

  const applyBusinessSelectionProjection = useCallback(
    (selection: CanvasSelectionContract, reason: string) => {
      const normalized = normalizeSelectionContract(selection);
      const storeState = useCanvasStore.getState();
      const previousStoreSelection: CanvasSelectionContract = {
        nodeIds: [...storeState.selectedNodeIds],
        annotationIds: [...storeState.selectedAnnotationIds],
      };
      const delta = readSelectionDelta(previousStoreSelection, normalized);
      const traceMeta = touchCanvasSelectionTrace({
        step: "project-business-selection",
        origin: "selection-bridge",
        reason,
        forceNewTrace: false,
        selectionSource: "business-selection-projection",
      });
      projectSelectionContract({
        selectedNodeIds: normalized.nodeIds,
        selectedAnnotationIds: normalized.annotationIds,
        editingAnnotationId: null,
        pendingAnnotationBinding: null,
      });
      logCanvasDebugEvent("selectionBridge:projectBusinessSelection", {
        ...traceMeta,
        traceScope: "canvas-selection",
        action: "project-business-selection",
        commandKind: "replace-selection",
        selectionReason: reason,
        previousStoreSelection,
        nextStoreSelection: normalized,
        changedNodeIds: delta.changedNodeIds,
        changedNodeCount: delta.changedNodeIds.length,
        disableThrottle: true,
      });
      logSelectionBridgeEvent("project-business-selection", reason, normalized);
    },
    [logSelectionBridgeEvent, projectSelectionContract],
  );

  const applyResolvedSelectionCommand = useCallback(
    (command: CanvasSelectionCommand, reason: string) => {
      const selection = resolveSelectionContractForCommand(
        reactFlowInstance,
        command,
        annotationIdSet,
      );
      applyBusinessSelectionProjection(selection, reason);
    },
    [annotationIdSet, applyBusinessSelectionProjection, reactFlowInstance],
  );

  const applySelectionCommand = useCallback(
    (command: CanvasSelectionCommand, reason: string) => {
      const traceMeta = touchCanvasSelectionTrace({
        step: "apply-selection-command",
        origin: "selection-bridge",
        reason,
        forceNewTrace: false,
        selectionSource: "selection-command",
      });
      if (!canApplySelectionCommand(command, renderNodeIdSet)) {
        pendingSelectionCommandRef.current = { command, reason };
        logCanvasDebugEvent("selectionBridge:applySelectionCommand", {
          ...traceMeta,
          traceScope: "canvas-selection",
          action: "defer-selection-command",
          commandKind: command.kind,
          selectionReason: reason,
          renderSelection:
            command.kind === "replace-selection"
              ? normalizeSelectionContract(command.selection)
              : EMPTY_SELECTION_CONTRACT,
          disableThrottle: true,
        });
        logSelectionBridgeEvent(
          "defer-selection-command",
          reason,
          command.kind === "replace-selection"
            ? normalizeSelectionContract(command.selection)
            : EMPTY_SELECTION_CONTRACT,
        );
        return;
      }
      pendingSelectionCommandRef.current = null;
      logCanvasDebugEvent("selectionBridge:applySelectionCommand", {
        ...traceMeta,
        traceScope: "canvas-selection",
        action: "apply-selection-command",
        commandKind: command.kind,
        selectionReason: reason,
        renderSelection:
          command.kind === "replace-selection"
            ? normalizeSelectionContract(command.selection)
            : EMPTY_SELECTION_CONTRACT,
        disableThrottle: true,
      });
      applyResolvedSelectionCommand(command, reason);
    },
    [
      applyResolvedSelectionCommand,
      logSelectionBridgeEvent,
      renderNodeIdSet,
    ],
  );

  useEffect(() => {
    const pending = pendingSelectionCommandRef.current;
    if (!pending) return;
    if (!canApplySelectionCommand(pending.command, renderNodeIdSet)) {
      return;
    }
    pendingSelectionCommandRef.current = null;
    applyResolvedSelectionCommand(pending.command, pending.reason);
  }, [applyResolvedSelectionCommand, renderNodeIdSet]);

  const clearSelection = useCallback(
    (reason: string) => {
      applySelectionCommand(
        {
          kind: "replace-selection",
          selection: EMPTY_SELECTION_CONTRACT,
        },
        reason,
      );
    },
    [applySelectionCommand],
  );

  const replaceSelection = useCallback(
    (selection: CanvasSelectionContract, reason: string) => {
      const normalized = normalizeSelectionContract(selection);
      if (
        normalized.nodeIds.length === 0 &&
        normalized.annotationIds.length === 0
      ) {
        clearSelection(reason);
        return;
      }
      applySelectionCommand(
        {
          kind: "replace-selection",
          selection: normalized,
        },
        reason,
      );
    },
    [applySelectionCommand, clearSelection],
  );

  const selectNodes = useCallback(
    (nodeIds: string[], reason: string) => {
      replaceSelection(
        {
          nodeIds,
          annotationIds: [],
        },
        reason,
      );
    },
    [replaceSelection],
  );

  const selectAnnotations = useCallback(
    (annotationIds: string[], reason: string) => {
      replaceSelection(
        {
          nodeIds: [],
          annotationIds,
        },
        reason,
      );
    },
    [replaceSelection],
  );

  const selectEntireCanvas = useCallback(
    (reason: string) => {
      applySelectionCommand(
        {
          kind: "select-all",
        },
        reason,
      );
    },
    [applySelectionCommand],
  );

  return useMemo(
    () => ({
      applySelectionCommand,
      selectAnnotations,
      selectEntireCanvas,
      selectNodes,
    }),
    [
      applySelectionCommand,
      selectAnnotations,
      selectEntireCanvas,
      selectNodes,
    ],
  );
}

export default useCanvasSelectionBridge;
