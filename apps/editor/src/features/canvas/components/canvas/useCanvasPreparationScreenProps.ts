"use client";

import { useMemo } from "react";
import { formatBeijingTime } from "@/shared/utils/time";

import type { CanvasPreparationScreenProps } from "../CanvasPreparationScreen";
import type { PendingNodeChangesSnapshot } from "../../storage";
import { PHASE_COPY, type PreparationState } from "./canvasPreparationModel";

type CanvasPreparationActionItem = Exclude<
  NonNullable<CanvasPreparationScreenProps["actions"]>[number],
  null
>;

type TaskSyncDisplay = {
  message: string | null | undefined;
};

type UseCanvasPreparationScreenPropsParams = {
  preparation: PreparationState;
  projectPath: string | null;
  recoverySnapshot: PendingNodeChangesSnapshot | null;
  emptyProjectPath: string | null;
  taskSyncStatus: TaskSyncDisplay;
  localBackendError: string | null;
  closeWindow: () => void;
  handleOpenEmptyProject: () => void | Promise<void>;
  handleRecover: () => void | Promise<void>;
  handleRetryFailedStep: () => void;
  runDiscardRecovery: () => void | Promise<void>;
};

export function useCanvasPreparationScreenProps({
  preparation,
  projectPath,
  recoverySnapshot,
  emptyProjectPath,
  taskSyncStatus,
  localBackendError,
  closeWindow,
  handleOpenEmptyProject,
  handleRecover,
  handleRetryFailedStep,
  runDiscardRecovery,
}: UseCanvasPreparationScreenPropsParams): CanvasPreparationScreenProps {
  const preparationFailure = preparation.failure;
  const preparationFailureMessage =
    (preparationFailure !== null && preparationFailure !== undefined
      ? preparationFailure.message
      : undefined) ?? null;
  const recoverySavedAt =
    recoverySnapshot !== null && recoverySnapshot !== undefined
      ? recoverySnapshot.savedAt
      : undefined;
  const phaseCopy =
    preparation.phase === "failed"
      ? {
          progress: 78,
          stageLabel: "准备失败",
          title: "画布没能打开",
          description:
            preparationFailureMessage ?? "现在没能打开画布，请重试或关闭窗口。",
        }
      : preparation.phase === "ready"
        ? {
            progress: 100,
            stageLabel: "准备完成",
            title: "画布已经准备好了",
            description: "项目已准备好，正在进入编辑界面。",
          }
        : PHASE_COPY[preparation.phase];

  const detail = useMemo((): string | null => {
    if (preparation.phase === "awaiting-recovery") {
      return recoverySavedAt
        ? `发现上次未保存完成的节点改动，最近一次自动保存时间：${formatBeijingTime(recoverySavedAt)}。`
        : "发现上次未保存完成的节点改动，请先决定是否恢复。";
    }
    if (preparation.phase === "awaiting-empty-project") {
      return emptyProjectPath ?? null;
    }
    if (preparation.phase === "connecting-sync") {
      return taskSyncStatus.message ?? null;
    }
    if (preparation.phase === "failed") {
      return null;
    }
    return projectPath ?? null;
  }, [
    emptyProjectPath,
    preparation.phase,
    projectPath,
    recoverySavedAt,
    taskSyncStatus.message,
  ]);

  const actions = useMemo<CanvasPreparationActionItem[]>(() => {
    if (preparation.phase === "awaiting-recovery") {
      return [
        {
          key: "recover",
          label: "恢复上次内容",
          variant: undefined,
          disabled: undefined,
          onClick: () => void handleRecover(),
        },
        {
          key: "discard",
          label: "放弃恢复",
          variant: "outline",
          disabled: undefined,
          onClick: () => void runDiscardRecovery(),
        },
        {
          key: "close",
          label: "关闭窗口",
          variant: "outline",
          disabled: undefined,
          onClick: closeWindow,
        },
      ];
    }
    if (preparation.phase === "awaiting-empty-project") {
      return [
        {
          key: "open-empty",
          label: "作为空项目打开",
          variant: undefined,
          disabled: undefined,
          onClick: () => void handleOpenEmptyProject(),
        },
        {
          key: "close",
          label: "关闭窗口",
          variant: "outline",
          disabled: undefined,
          onClick: closeWindow,
        },
      ];
    }
    if (preparation.phase === "failed") {
      return [
        {
          key: "retry",
          label: "重试当前步骤",
          variant: undefined,
          disabled: undefined,
          onClick: handleRetryFailedStep,
        },
        {
          key: "close",
          label: "关闭窗口",
          variant: "outline",
          disabled: undefined,
          onClick: closeWindow,
        },
      ];
    }
    return [
      {
        key: "close",
        label: "关闭窗口",
        variant: "outline",
        disabled: undefined,
        onClick: closeWindow,
      },
    ];
  }, [
    closeWindow,
    handleOpenEmptyProject,
    handleRecover,
    handleRetryFailedStep,
    preparation.phase,
    runDiscardRecovery,
  ]);

  return {
    progress: phaseCopy.progress,
    stageLabel: phaseCopy.stageLabel,
    title: phaseCopy.title,
    description: phaseCopy.description,
    detail,
    diagnostics:
      (preparationFailure !== null && preparationFailure !== undefined
        ? preparationFailure.diagnostics
        : undefined) ?? null,
    warning: preparation.phase === "ready" ? localBackendError : null,
    failed: preparation.phase === "failed",
    ready: preparation.phase === "ready",
    actions,
  };
}
