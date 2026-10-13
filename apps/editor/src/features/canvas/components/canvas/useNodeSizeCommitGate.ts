"use client";

import { useEffect, useRef } from "react";

import { isElectronDev } from "@/client/utils/runtimeFlags";
import { logCanvasDebugEvent } from "../../debug/canvasDebug";
import { useCanvasStore } from "../../store/canvasStore";
import {
  collectDirtyNodeSizeCommitCandidates,
  createNodeSizeCommitObservation,
  EMPTY_NODE_SIZE_COMMIT_OBSERVATION,
  shouldAcceptDesiredSize,
} from "../../application/nodeSizeRuntime";
import {
  isStartupPhaseForDesired,
  selectPreparationPhase,
} from "../../store/selectors";
import type { NodeSize } from "../../types";

type UseNodeSizeCommitGateParams = {
  actualSizeByNodeId: Readonly<Record<string, NodeSize>>;
};

/**
 * desired size 提交闸门。
 *
 * 职责：在交互结束且 actual 收敛到 pending desired 后，将其迁移到 accepted。
 * 不负责清理 preview/proposal（原三态语义已并入 desired 两态）。
 */
export const useNodeSizeCommitGate = ({
  actualSizeByNodeId,
}: UseNodeSizeCommitGateParams): void => {
  const isDragging = useCanvasStore((state) => state.isDragging);
  const isCanvasInteracting = useCanvasStore((state) => state.isCanvasInteracting);
  const isCanvasInteractingDelayed = useCanvasStore(
    (state) => state.isCanvasInteractingDelayed,
  );
  const desiredSizeByNodeId = useCanvasStore((state) => state.ui.desiredSizeByNodeId);
  const acceptDesiredSize = useCanvasStore((state) => state.acceptDesiredSize);
  // 启动期禁用 desired 反馈环（spec：画布启动性能与Layout-Model架构.md 启动期零反馈环）：
  // commit gate 只在 runtime (phase === 'ready') 才允许 observe / flush。
  const preparationPhase = useCanvasStore(selectPreparationPhase);
  const commitObservationRef = useRef(EMPTY_NODE_SIZE_COMMIT_OBSERVATION);
  const commitCandidateNodeIdsRef = useRef(new Set<string>());

  // observe：检测 actual/desired 变化，收集 dirty 候选
  useEffect(() => {
    // 启动期零反馈环：跳过 observe（不会触发任何 desired accept 流程）。
    if (isStartupPhaseForDesired(preparationPhase)) return;
    const nextObservation = createNodeSizeCommitObservation({
      actualSizeByNodeId,
      desiredSizeByNodeId,
    });
    const changedNodeIds = collectDirtyNodeSizeCommitCandidates({
      previous: commitObservationRef.current,
      next: nextObservation,
    });
    if (changedNodeIds.length > 0) {
      for (const nodeId of changedNodeIds) {
        commitCandidateNodeIdsRef.current.add(nodeId);
      }
      if (isElectronDev()) {
        logCanvasDebugEvent("nodeSizeCommitGate:observe", {
          traceScope: "node-size-commit-gate",
          action: "observe-dirty-candidates",
          changeCount: changedNodeIds.length,
          candidateCount: commitCandidateNodeIdsRef.current.size,
          candidateNodeIds: Array.from(commitCandidateNodeIdsRef.current),
          actualCount: Object.keys(actualSizeByNodeId).length,
          desiredCount: Object.keys(desiredSizeByNodeId).length,
        });
      }
    }
    commitObservationRef.current = nextObservation;
  }, [actualSizeByNodeId, desiredSizeByNodeId, preparationPhase]);

  // flush：交互结束后，对 pending desired 检测 actual 收敛 → accept
  useEffect(() => {
    // 启动期零反馈环：跳过 flush（不会推进 desired → accepted 状态迁移）。
    if (isStartupPhaseForDesired(preparationPhase)) return;
    if (isDragging) return;
    if (isCanvasInteracting) return;
    if (isCanvasInteractingDelayed) return;

    const candidateNodeIds = Array.from(commitCandidateNodeIdsRef.current);
    if (candidateNodeIds.length === 0) return;
    const acceptNodeIds: string[] = [];
    for (const nodeId of candidateNodeIds) {
      const desired = desiredSizeByNodeId[nodeId];
      const actualSize = actualSizeByNodeId[nodeId];
      commitCandidateNodeIdsRef.current.delete(nodeId);
      if (shouldAcceptDesiredSize({ desired, actualSize })) {
        acceptNodeIds.push(nodeId);
        acceptDesiredSize(nodeId);
      }
    }
    if (isElectronDev() && acceptNodeIds.length > 0) {
      logCanvasDebugEvent("nodeSizeCommitGate:flush", {
        traceScope: "node-size-commit-gate",
        action: "flush-accept-candidates",
        candidateCount: candidateNodeIds.length,
        candidateNodeIds,
        acceptNodeIds,
        actualCount: Object.keys(actualSizeByNodeId).length,
        desiredCount: Object.keys(desiredSizeByNodeId).length,
      });
    }
  }, [
    actualSizeByNodeId,
    acceptDesiredSize,
    desiredSizeByNodeId,
    isCanvasInteracting,
    isCanvasInteractingDelayed,
    isDragging,
    preparationPhase,
  ]);
};
