"use client";

import { useCallback } from "react";

import type { CanvasPreparationScreenProps } from "../CanvasPreparationScreen";
import type { CanvasStore } from "../../store/canvasStore";
import {
  getProject,
  getPendingNodeChangesSnapshot,
  type PendingNodeChangesSnapshot,
  type ProjectRecord,
} from "../../storage";
import {
  buildProjectLoadFailure,
  buildCanvasPreparationDiagnostics,
  getFailureMessage,
  isProjectDataEmptyError,
  LOADING_PROJECT_TIMEOUT_MS,
  readWhitelistedErrorDetails,
  withTimeout,
  type PreparationState,
  type RetryPhase,
} from "./canvasPreparationModel";
import {
  ensureAgentNodeRemovalPreflightRegistered,
  loadAgentSessions,
} from "@/features/agent/agentSessionStore";

export type LoadStatus =
  | { status: "awaiting-recovery" }
  | { status: "awaiting-empty-project" }
  | { status: "loaded" };

export type ProjectLoadOptions = {
  allowEmpty: boolean | undefined;
  onLoaded: () => void | Promise<void> | undefined;
};

type MutableRef<T> = { current: T };

type FailPreparation = (
  retryPhase: RetryPhase,
  code: string,
  message: string,
  diagnostics: CanvasPreparationScreenProps["diagnostics"] | undefined,
) => void;

type UseProjectLoadFlowParams = {
  failPreparation: FailPreparation;
  loadNodeGraph: CanvasStore["loadNodeGraph"];
  recoveryHandledRef: MutableRef<boolean>;
  retryFailedActionRef: MutableRef<(() => Promise<unknown>) | null>;
  setEmptyProjectPath: (value: string | null) => void;
  setPreparation: (value: PreparationState) => void;
  setProjectMediaAssets: CanvasStore["setProjectMediaAssets"];
  setRecoverySnapshot: (value: PendingNodeChangesSnapshot | null) => void;
  syncPersistenceState: CanvasStore["syncPersistenceState"];
};

export const useProjectLoadFlow = ({
  failPreparation,
  loadNodeGraph,
  recoveryHandledRef,
  retryFailedActionRef,
  setEmptyProjectPath,
  setPreparation,
  setProjectMediaAssets,
  setRecoverySnapshot,
  syncPersistenceState,
}: UseProjectLoadFlowParams) => {
  const isStructuredProjectLoadError = (error: unknown): boolean => {
    const body =
      typeof error === "object" && error && "body" in error
        ? (error as { body: unknown | undefined }).body
        : null;
    const code =
      body && typeof body === "object" && "code" in body
        ? (body as { code: unknown | undefined }).code
        : null;
    return (
      code === "invalid-project-folder" ||
      code === "project-manifest-missing" ||
      code === "missing-node-graph"
    );
  };

  const executeLoadingProjectStep = useCallback(
    async (options: {
      action: () => Promise<unknown>;
      buildFailure: (error: unknown) => {
        code: string;
        message: string;
        diagnostics: CanvasPreparationScreenProps["diagnostics"] | undefined;
      };
      retryAction: () => Promise<unknown>;
    }) => {
      retryFailedActionRef.current = options.retryAction;
      setPreparation({ phase: "loading-project", failure: null });
      console.info("[canvas:prep] executeLoadingProjectStep start");
      try {
        await withTimeout(
          options.action(),
          LOADING_PROJECT_TIMEOUT_MS,
          "打开项目超时，请重试或关闭窗口。",
        );
      } catch (error) {
        const failure = options.buildFailure(error);
        failPreparation(
          "loading-project",
          failure.code,
          failure.message,
          failure.diagnostics ?? null,
        );
        throw error;
      }
    },
    [failPreparation, retryFailedActionRef, setPreparation],
  );

  const loadResolvedProject = useCallback(
    async (
      currentPath: string,
      startupProject: ProjectRecord | null | undefined,
      options: { allowEmpty: boolean | undefined } | undefined,
    ): Promise<LoadStatus> => {
      let sourceGraph:
        | ProjectRecord["nodeGraph"]
        | PendingNodeChangesSnapshot["nodeGraph"]
        | null = null;
      let sourceMediaAssets: ProjectRecord["mediaAssets"] | null = null;

      if (startupProject) {
        sourceGraph = startupProject.nodeGraph ?? null;
        sourceMediaAssets = startupProject.mediaAssets ?? {};
        if (
          !(options !== null && options !== undefined ? options.allowEmpty : undefined) &&
          startupProject.nodeGraph &&
          !recoveryHandledRef.current
        ) {
          setProjectMediaAssets(startupProject.mediaAssets ?? {}, { source: 'project-load' });
          setRecoverySnapshot({
            key: "current",
            nodeGraph: startupProject.nodeGraph,
            savedAt: startupProject.savedAt,
            hasUnsavedChanges: startupProject.hasUnsavedChanges,
          });
          setPreparation({ phase: "awaiting-recovery", failure: null });
          return { status: "awaiting-recovery" };
        }
      }

      if (!sourceGraph) {
        let project: Awaited<ReturnType<typeof getProject>> | null = null;
        try {
          console.info("[canvas:prep] storage:get-project ipc start", {
            projectPath: currentPath,
          });
          project = await getProject(
            currentPath,
            (options !== null && options !== undefined ? options.allowEmpty : undefined) ? { allowEmpty: true } : undefined,
          );
          console.info("[canvas:prep] storage:get-project ipc done", {
            hasProject: Boolean(project),
            hasNodeGraph: Boolean((project !== null && project !== undefined ? project.nodeGraph : undefined)),
          });
        } catch (error) {
          if (isProjectDataEmptyError(error)) {
            setEmptyProjectPath(currentPath);
            setPreparation({ phase: "awaiting-empty-project", failure: null });
            return { status: "awaiting-empty-project" };
          }
          if (isStructuredProjectLoadError(error)) {
            throw error;
          }
          console.error("[CanvasEditor] 读取正式项目内容失败", error);
          const message = getFailureMessage(
            "项目内容读取失败，请重试或关闭窗口。",
            error,
          );
          throw Object.assign(new Error(message), {
            diagnostics: buildCanvasPreparationDiagnostics({
              phase: "loading-project",
              retryPhase: "loading-project",
              source: "project_load",
              subsource: null,
              failure: {
                code: "project-load-failed",
                message,
              },
              details: readWhitelistedErrorDetails(error),
              embedded: null,
            }),
          });
        }
        sourceGraph = (project !== null && project !== undefined ? project.nodeGraph : undefined) ?? null;
        sourceMediaAssets = (project !== null && project !== undefined ? project.mediaAssets : undefined) ?? {};

        if (
          project !== null &&
          project !== undefined &&
          project.hasUnsavedChanges &&
          project.nodeGraph &&
          !recoveryHandledRef.current
        ) {
          const pendingSnapshot = await getPendingNodeChangesSnapshot();
          if ((pendingSnapshot !== null && pendingSnapshot !== undefined ? pendingSnapshot.nodeGraph : undefined)) {
            setProjectMediaAssets(project.mediaAssets ?? {}, { source: 'project-load' });
            setRecoverySnapshot(pendingSnapshot);
            setPreparation({ phase: "awaiting-recovery", failure: null });
            return { status: "awaiting-recovery" };
          }
        }
      }

      if (!sourceGraph) {
        throw new Error("项目里还没有画布内容，无法继续打开。");
      }

      setProjectMediaAssets(sourceMediaAssets ?? {}, { source: 'project-load' });
      await loadNodeGraph(sourceGraph);
      // Agent 节点加载后装载会话元数据（只元数据；消息按需在会话视图打开时读取，spec 03）。
      // 同时把 agent 侧「删除前在途终止」注册进画布删除咽喉前置钩子（幂等，不依赖模块 import 时机）。
      ensureAgentNodeRemovalPreflightRegistered();
      await loadAgentSessions(currentPath);
      syncPersistenceState(null);
      setRecoverySnapshot(null);
      setEmptyProjectPath(null);
      return { status: "loaded" };
    },
    [
      loadNodeGraph,
      recoveryHandledRef,
      setEmptyProjectPath,
      setPreparation,
      setProjectMediaAssets,
      setRecoverySnapshot,
      syncPersistenceState,
    ],
  );

  const runPrimaryProjectLoad = useCallback(
    async (
      currentPath: string,
      startupProject: ProjectRecord | null | undefined,
      options: ProjectLoadOptions | undefined,
    ): Promise<LoadStatus> => {
      let loadStatus: LoadStatus = { status: "loaded" };
      await executeLoadingProjectStep({
        retryAction: () =>
          runPrimaryProjectLoad(currentPath, startupProject, options),
        buildFailure: (error) => {
          const failure = buildProjectLoadFailure(error);
          return {
            code: failure.code,
            message: failure.message,
            diagnostics: failure.diagnostics,
          };
        },
        action: async () => {
          const result = await loadResolvedProject(
            currentPath,
            startupProject,
            options,
          );
          loadStatus = result;
          if (result.status !== "loaded") {
            retryFailedActionRef.current = null;
            return;
          }
          retryFailedActionRef.current = null;
        },
      });
      if (loadStatus.status === "loaded") {
        await (options !== null && options !== undefined && options.onLoaded !== null && options.onLoaded !== undefined ? options.onLoaded() : undefined);
      }
      return loadStatus;
    },
    [executeLoadingProjectStep, loadResolvedProject, retryFailedActionRef],
  );

  return {
    executeLoadingProjectStep,
    runPrimaryProjectLoad,
  };
};
