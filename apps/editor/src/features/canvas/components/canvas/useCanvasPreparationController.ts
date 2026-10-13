"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { isHubRuntime } from "@/client/utils/hubFetch";
import { useRuntimeStore } from "@/client/store/runtimeStore";
import { useCanvasStore } from "../../store/canvasStore";
import { getCurrentProjectPath } from "../../storage";
import { useCanvasTaskIndexSync } from "../../hooks/useCanvasTaskIndexSync";
import type { CanvasTaskSyncStatus } from "../../hooks/taskIndex/types";
import { useCanvasStartupGate } from "../../hooks/useCanvasStartupGate";
import type { CanvasPreparationScreenProps } from "../CanvasPreparationScreen";
import type { PendingNodeChangesSnapshot } from "../../storage";
import {
  INITIAL_PREPARATION,
  type PreparationState,
  type RetryPhase,
} from "./canvasPreparationModel";
import { useCanvasPreparationScreenProps } from "./useCanvasPreparationScreenProps";
import { useDeferredHistoryBaselineCommit } from "./useDeferredHistoryBaselineCommit";
import { useProjectLoadFlow } from "./useProjectLoadFlow";
import { useProjectRecoveryFlow } from "./useProjectRecoveryFlow";

export type CanvasPreparationController = {
  hubRuntime: boolean;
  released: boolean;
  startupSessionToken: string | null;
  phase: PreparationState["phase"];
  /**
   * 当 NodeCanvas 自检就绪（节点稳定 / 超时）后调用，把 waiting-interactive 推进到 ready。
   * 内部复用 useCanvasStartupGate，graphId / sessionToken 由控制器从 store / runtime
   * 镜像里读取，调用方不需要传任何参数（spec：layout-model-driven 启动收敛）。
   */
  markStartupInteractiveReady: () => void;
  screenProps: CanvasPreparationScreenProps;
};

export function useCanvasPreparationController(): CanvasPreparationController {
  const hubRuntime = isHubRuntime();
  const [preparation, setPreparation] =
    useState<PreparationState>(INITIAL_PREPARATION);
  // 启动阶段镜像同步：把本地 phase 写进 canvas store，供 desired producers /
  // commit gate / useFlowNodeActualSize 等组件用 useCanvasStore(selectPreparationPhase)
  // 订阅，进而判断是否在启动期。直接 setState 不需要走 action（仅镜像，不写业务态）。
  useEffect(() => {
    useCanvasStore.setState({ preparationPhase: preparation.phase });
  }, [preparation.phase]);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [recoverySnapshot, setRecoverySnapshot] =
    useState<PendingNodeChangesSnapshot | null>(null);
  const [emptyProjectPath, setEmptyProjectPath] = useState<string | null>(null);
  const [localBackendError] = useState<string | null>(null);
  const recoveryHandledRef = useRef(false);
  const retryFailedActionRef = useRef<(() => Promise<unknown>) | null>(null);
  const loadNodeGraph = useCanvasStore((state) => state.loadNodeGraph);
  const setProjectMediaAssets = useCanvasStore(
    (state) => state.setProjectMediaAssets,
  );
  const syncPersistenceState = useCanvasStore(
    (state) => state.syncPersistenceState,
  );
  const commitDeferredHistoryBaseline = useCanvasStore(
    (state) => state.commitDeferredHistoryBaseline,
  );
  const pendingMediaMigrationNotice = useCanvasStore(
    (state) => state.pendingMediaMigrationNotice,
  );
  const clearPendingMediaMigrationNotice = useCanvasStore(
    (state) => state.clearPendingMediaMigrationNotice,
  );
  const nodeGraphId = useCanvasStore((state) => (state.nodeGraph !== null && state.nodeGraph !== undefined ? state.nodeGraph.id : undefined)) ?? null;
  const startupSessionToken =
    useRuntimeStore((state) => (state.desktopBootstrap !== null && state.desktopBootstrap !== undefined ? state.desktopBootstrap.sessionToken : undefined) ?? null);
  const {
    startupReady,
    reportStartupInteractiveReady,
    resetStartupInteractiveReady,
  } = useCanvasStartupGate(nodeGraphId, startupSessionToken);
  const shouldEnableTaskSync = Boolean(
    nodeGraphId &&
      (preparation.phase === "connecting-sync" ||
        preparation.phase === "waiting-interactive" ||
        preparation.phase === "ready"),
  );
  const handleTaskSyncStatusChange = useCallback(
    (_status: CanvasTaskSyncStatus) => undefined,
    [],
  );
  const taskSyncStatus = useCanvasTaskIndexSync(nodeGraphId, {
    enabled: shouldEnableTaskSync,
    connectTimeoutMs: undefined,
    onStatusChange: handleTaskSyncStatusChange,
  });

  const failPreparation = useCallback(
    (
      retryPhase: RetryPhase,
      code: string,
      message: string,
      diagnostics: CanvasPreparationScreenProps["diagnostics"] | undefined,
    ) => {
      setPreparation({
        phase: "failed",
        failure: {
          retryPhase,
          code,
          message,
          diagnostics: diagnostics ?? null,
        },
      });
    },
    [],
  );

  const advanceToConnectingSync = useCallback(() => {
    console.info("[canvas:prep] advancing to connecting-sync");
    setPreparation({ phase: "connecting-sync", failure: null });
  }, []);

  const closeWindow = useCallback(() => {
    if (typeof window === "undefined") return;
    const electronApi = window as Window & {
      electron: { closeWindow: () => Promise<void> | void | undefined } | undefined;
    };
    const electron = electronApi.electron;
    if (electron !== null && electron !== undefined && typeof electron.closeWindow === "function") {
      void electron.closeWindow();
      return;
    }
    window.close();
  }, []);

  const { executeLoadingProjectStep, runPrimaryProjectLoad } =
    useProjectLoadFlow({
      failPreparation,
      loadNodeGraph,
      recoveryHandledRef,
      retryFailedActionRef,
      setEmptyProjectPath,
      setPreparation,
      setProjectMediaAssets,
      setRecoverySnapshot,
      syncPersistenceState,
    });

  const { handleRecover, runDiscardRecovery } = useProjectRecoveryFlow({
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
  });

  useEffect(() => {
    if (!pendingMediaMigrationNotice) return;
    toast.warning(pendingMediaMigrationNotice, { duration: 8000 });
    clearPendingMediaMigrationNotice();
  }, [clearPendingMediaMigrationNotice, pendingMediaMigrationNotice]);

  useDeferredHistoryBaselineCommit(nodeGraphId, commitDeferredHistoryBaseline);

  useEffect(() => {
    if (!hubRuntime || preparation.phase !== "resolving-project") return;
    let cancelled = false;
    const resolveProject = async () => {
      console.info("[canvas:prep] resolving-project start");
      const currentPath = await getCurrentProjectPath().catch(() => null);
      if (cancelled) return;
      if (!currentPath) {
        failPreparation(
          "resolving-project",
          "missing-project-path",
          "找不到这个项目的位置，无法打开画布。请从项目管理应用中重新打开。",
          undefined,
        );
        return;
      }
      setProjectPath(currentPath);
      retryFailedActionRef.current = null;
      setPreparation({ phase: "loading-project", failure: null });
    };
    void resolveProject();
    return () => {
      cancelled = true;
    };
  }, [failPreparation, hubRuntime, preparation.phase]);

  useEffect(() => {
    if (!hubRuntime || preparation.phase !== "loading-project" || !projectPath) {
      return;
    }
    let cancelled = false;
    const loadProject = async () => {
      try {
        const result = await runPrimaryProjectLoad(projectPath, null, {
          allowEmpty: undefined,
          onLoaded: advanceToConnectingSync,
        });
        if (cancelled || result.status !== "loaded") return;
      } catch {
        if (cancelled) return;
      }
    };
    void loadProject();
    return () => {
      cancelled = true;
    };
  }, [
    advanceToConnectingSync,
    hubRuntime,
    preparation.phase,
    projectPath,
    runPrimaryProjectLoad,
  ]);

  useEffect(() => {
    if (preparation.phase !== "connecting-sync") return;
    if (taskSyncStatus.level === "error") {
      const code = taskSyncStatus.code ?? "connect-failed";
      const message =
        taskSyncStatus.message ??
        "没能同步到任务状态，请重试或关闭窗口。";
      failPreparation("connecting-sync", code, message, {
        phase: "connecting-sync",
        retryPhase: "connecting-sync",
        source: "task_sync",
        subsource: null,
        failure: { code, message },
        errorName: null,
        errorCode: null,
        httpStatus: null,
        remoteCode: null,
        remoteMessage: null,
        causeName: null,
        causeMessage: null,
        projectOpenStage: null,
        projectOpenSource: null,
        projectOpenAction: null,
        configKey: null,
        configEndpoint: null,
        timeoutMs: null,
        hint: null,
        syncStatusCode: code,
        syncStatusMessage: message,
        wsEventType: taskSyncStatus.wsEventType ?? null,
      });
      return;
    }
    if (taskSyncStatus.level === "connected") {
      setPreparation({ phase: "waiting-interactive", failure: null });
    }
  }, [
    failPreparation,
    preparation.phase,
    taskSyncStatus.code,
    taskSyncStatus.level,
    taskSyncStatus.message,
    taskSyncStatus.wsEventType,
  ]);

  useEffect(() => {
    if (preparation.phase !== "waiting-interactive" || !nodeGraphId) {
      resetStartupInteractiveReady();
      return;
    }
    resetStartupInteractiveReady();
  }, [nodeGraphId, preparation.phase, resetStartupInteractiveReady]);

  // NodeCanvas 自检就绪后回调（spec：layout-model-driven 启动收敛）。
  // 控制器在内部把 graphId / sessionToken 注入 useCanvasStartupGate，调用方不传参。
  const markStartupInteractiveReady = useCallback(() => {
    if (preparation.phase !== "waiting-interactive") return;
    reportStartupInteractiveReady(nodeGraphId, startupSessionToken);
  }, [
    nodeGraphId,
    preparation.phase,
    reportStartupInteractiveReady,
    startupSessionToken,
  ]);

  const handleOpenEmptyProject = useCallback(async () => {
    if (!emptyProjectPath) {
      closeWindow();
      return;
    }
    try {
      await runPrimaryProjectLoad(emptyProjectPath, null, {
        allowEmpty: true,
        onLoaded: advanceToConnectingSync,
      });
    } catch (error) {
      console.error("[CanvasEditor] 打开空项目失败", error);
    }
  }, [
    advanceToConnectingSync,
    closeWindow,
    emptyProjectPath,
    runPrimaryProjectLoad,
  ]);

  const handleRetryFailedStep = useCallback(() => {
    if (!preparation.failure) return;
    const retryAction = retryFailedActionRef.current;
    if (retryAction) {
      void retryAction();
      return;
    }
    setPreparation({ phase: preparation.failure.retryPhase, failure: null });
  }, [preparation.failure]);

  useEffect(() => {
    if (preparation.phase !== "waiting-interactive" || !startupReady) return;
    setPreparation({ phase: "ready", failure: null });
  }, [preparation.phase, startupReady]);

  const screenProps = useCanvasPreparationScreenProps({
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
  });

  return {
    hubRuntime,
    released: preparation.phase === "ready",
    startupSessionToken,
    phase: preparation.phase,
    markStartupInteractiveReady,
    screenProps,
  };
}
