"use client";

import { useCallback } from "react";

import type { CanvasPreparationDiagnostics } from "../CanvasPreparationScreen";
import type { CanvasStore } from "../../store/canvasStore";
import {
  discardPendingNodeChanges,
  flushPendingNodeChanges,
  getProject,
  type PendingNodeChangesSnapshot,
  type ProjectRecord,
} from "../../storage";
import {
  buildCanvasPreparationDiagnostics,
  getFailureMessage,
  readEmbeddedDiagnostics,
  readWhitelistedErrorDetails,
  type PreparationState,
  type RetryPhase,
} from "./canvasPreparationModel";
import type {
  LoadStatus,
  ProjectLoadOptions,
} from "./useProjectLoadFlow";
import {
  ensureAgentNodeRemovalPreflightRegistered,
  loadAgentSessions,
} from "@/features/agent/agentSessionStore";

type MutableRef<T> = { current: T };

const buildRecoveryDiagnostics = (
  params: {
    phase: RetryPhase;
    retryPhase: RetryPhase;
    source: string;
    code: string;
    message: string;
  },
  error: unknown,
): CanvasPreparationDiagnostics =>
  buildCanvasPreparationDiagnostics({
    phase: params.phase,
    retryPhase: params.retryPhase,
    source: params.source,
    subsource: null,
    failure: { code: params.code, message: params.message },
    details: readWhitelistedErrorDetails(error),
    embedded: readEmbeddedDiagnostics(error),
  });
type FailPreparation = (
  retryPhase: RetryPhase,
  code: string,
  message: string,
  diagnostics: NonNullable<PreparationState["failure"]>["diagnostics"] | undefined,
) => void;

type UseProjectRecoveryFlowParams = {
  advanceToConnectingSync: () => void;
  closeWindow: () => void;
  executeLoadingProjectStep: (options: {
    action: () => Promise<unknown>;
    buildFailure: (error: unknown) => {
      code: string;
      message: string;
      diagnostics: NonNullable<PreparationState["failure"]>["diagnostics"] | undefined;
    };
    retryAction: () => Promise<unknown>;
  }) => Promise<void>;
  failPreparation: FailPreparation;
  loadNodeGraph: CanvasStore["loadNodeGraph"];
  projectPath: string | null;
  recoveryHandledRef: MutableRef<boolean>;
  recoverySnapshot: PendingNodeChangesSnapshot | null;
  retryFailedActionRef: MutableRef<(() => Promise<unknown>) | null>;
  runPrimaryProjectLoad: (
    currentPath: string,
    startupProject: ProjectRecord | null | undefined,
    options: ProjectLoadOptions | undefined,
  ) => Promise<LoadStatus>;
  setPreparation: (value: PreparationState) => void;
  setProjectMediaAssets: CanvasStore["setProjectMediaAssets"];
  setRecoverySnapshot: (value: PendingNodeChangesSnapshot | null) => void;
  syncPersistenceState: CanvasStore["syncPersistenceState"];
};

export const useProjectRecoveryFlow = ({
  advanceToConnectingSync,
  closeWindow,
  executeLoadingProjectStep,
  failPreparation,
  loadNodeGraph,
  projectPath,
  recoveryHandledRef,
  recoverySnapshot,
  retryFailedActionRef,
  runPrimaryProjectLoad,
  setPreparation,
  setProjectMediaAssets,
  setRecoverySnapshot,
  syncPersistenceState,
}: UseProjectRecoveryFlowParams) => {
  const runRecoveryProjectLoad = useCallback(
    async (pendingSnapshot: PendingNodeChangesSnapshot) => {
      await executeLoadingProjectStep({
        retryAction: () => runRecoveryProjectLoad(pendingSnapshot),
        buildFailure: (error) => {
          const isTimeout =
            error instanceof Error &&
            error.message === "项目装载超时，请重试或关闭窗口。";
          const message = getFailureMessage(
            "恢复项目失败，请重试或关闭窗口。",
            error,
          );
          return {
            code: isTimeout ? "recovery-load-timeout" : "recovery-load-failed",
            message,
            diagnostics: buildRecoveryDiagnostics(
              {
                phase: "loading-project",
                retryPhase: "loading-project",
                source: "recovery",
                code: isTimeout
                  ? "recovery-load-timeout"
                  : "recovery-load-failed",
                message,
              },
              error,
            ),
          };
        },
        action: async () => {
          recoveryHandledRef.current = true;
          try {
            const flushResult = await flushPendingNodeChanges();
            if (
              flushResult &&
              "persistenceState" in flushResult &&
              flushResult.persistenceState
            ) {
              syncPersistenceState(flushResult.persistenceState);
            }
          } catch {
            // flush 失败不阻塞加载
          }
          if (!projectPath) {
            throw new Error("项目路径丢失，无法恢复项目。");
          }
          const flushedProject = await getProject(projectPath, { allowEmpty: undefined });
          if (flushedProject !== null && flushedProject !== undefined && flushedProject.nodeGraph) {
            await loadNodeGraph(flushedProject.nodeGraph);
            setProjectMediaAssets(flushedProject.mediaAssets ?? {}, { source: 'project-load' });
            // 恢复分支同样要装载会话元数据（节点恢复后才谈得上会话引用可用）。
            // 同时注册画布删除咽喉的「删除前在途终止」前置钩子（幂等）。
            ensureAgentNodeRemovalPreflightRegistered();
            await loadAgentSessions(projectPath);
          }
          syncPersistenceState(null);
          retryFailedActionRef.current = null;
          setRecoverySnapshot(null);
          setPreparation({ phase: "connecting-sync", failure: null });
        },
      });
    },
    [
      executeLoadingProjectStep,
      loadNodeGraph,
      projectPath,
      recoveryHandledRef,
      retryFailedActionRef,
      setPreparation,
      setProjectMediaAssets,
      setRecoverySnapshot,
      syncPersistenceState,
    ],
  );

  const handleRecover = useCallback(async () => {
    const snapshot = recoverySnapshot;
    if (snapshot === null || !snapshot.nodeGraph) {
      closeWindow();
      return;
    }
    try {
      await runRecoveryProjectLoad(snapshot);
    } catch (error) {
      console.error("[CanvasEditor] 恢复项目失败", error);
    }
  }, [closeWindow, recoverySnapshot, runRecoveryProjectLoad]);

  const runDiscardRecovery = useCallback(async () => {
    try {
      recoveryHandledRef.current = true;
      const discardedProject = await discardPendingNodeChanges();
      syncPersistenceState(null);
      retryFailedActionRef.current = null;
      setRecoverySnapshot(null);
      if (!projectPath) {
        failPreparation(
          "awaiting-recovery",
          "missing-project-path",
          "找不到项目位置，没能恢复上次的改动。",
          undefined,
        );
        return;
      }
      await runPrimaryProjectLoad(projectPath, discardedProject ?? null, {
        allowEmpty: undefined,
        onLoaded: advanceToConnectingSync,
      });
    } catch (error) {
      console.error("[CanvasEditor] 放弃恢复失败", error);
      retryFailedActionRef.current = () => runDiscardRecovery();
      const message = getFailureMessage(
        "放弃恢复失败，请重试或关闭窗口。",
        error,
      );
      failPreparation(
        "awaiting-recovery",
        "discard-recovery-failed",
        message,
        buildRecoveryDiagnostics(
          {
            phase: "awaiting-recovery",
            retryPhase: "awaiting-recovery",
            source: "recovery",
            code: "discard-recovery-failed",
            message,
          },
          error,
        ),
      );
    }
  }, [
    advanceToConnectingSync,
    failPreparation,
    projectPath,
    recoveryHandledRef,
    retryFailedActionRef,
    runPrimaryProjectLoad,
    setRecoverySnapshot,
    syncPersistenceState,
  ]);

  return {
    handleRecover,
    runDiscardRecovery,
    runRecoveryProjectLoad,
  };
};
