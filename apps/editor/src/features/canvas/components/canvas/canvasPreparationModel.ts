"use client";

import type { DynamicRecord } from "@/client/utils/typeGuards";
import type { CanvasPreparationDiagnostics } from "../CanvasPreparationScreen";

type ErrorBodyRecord = DynamicRecord & {
  code: unknown | undefined;
  message: unknown | undefined;
};

export const LOADING_PROJECT_TIMEOUT_MS = 1500;

export type PreparationPhase =
  | "resolving-project"
  | "awaiting-recovery"
  | "awaiting-empty-project"
  | "loading-project"
  | "connecting-sync"
  | "waiting-interactive"
  | "failed"
  | "ready";

export type RetryPhase = Exclude<PreparationPhase, "failed" | "ready">;

export type PreparationFailure = {
  code: string;
  message: string;
  retryPhase: RetryPhase;
  diagnostics: CanvasPreparationDiagnostics | null | undefined;
};

export type PreparationState = {
  phase: PreparationPhase;
  failure: PreparationFailure | null;
};

export const INITIAL_PREPARATION: PreparationState = {
  phase: "resolving-project",
  failure: null,
};

export const PHASE_COPY: Record<
  Exclude<PreparationPhase, "failed" | "ready">,
  { progress: number; stageLabel: string; title: string; description: string }
> = {
  "resolving-project": {
    progress: 12,
    stageLabel: "正在准备",
    title: "正在确认项目",
    description: "正在读取项目内容，确认是否需要恢复上次的改动。",
  },
  "awaiting-recovery": {
    progress: 18,
    stageLabel: "需要你确认",
    title: "等待你决定是否恢复上次内容",
    description: "上次还有没保存完成的画布改动，请选择恢复或放弃。",
  },
  "awaiting-empty-project": {
    progress: 18,
    stageLabel: "需要你确认",
    title: "等待你初始化空项目",
    description: "这个项目还没有内容，请确认是否作为空项目打开。",
  },
  "loading-project": {
    progress: 58,
    stageLabel: "正在打开",
    title: "正在打开项目",
    description: "正在读取项目内容，恢复上次的画布。",
  },
  "connecting-sync": {
    progress: 78,
    stageLabel: "正在同步",
    title: "正在同步任务状态",
    description: "正在获取生成任务的最新进度。",
  },
  "waiting-interactive": {
    progress: 92,
    stageLabel: "即将完成",
    title: "正在完成最后检查",
    description: "正在确认画布可以编辑，马上进入。",
  },
};

export const getFailureMessage = (fallback: string, error: unknown) => {
  if (error instanceof Error && error.message.trim()) {
    return fallback;
  }
  return fallback;
};

const EMPTY_PREPARATION_FAILURE_DIAGNOSTIC: NonNullable<
  CanvasPreparationDiagnostics["failure"]
> = {
  code: null,
  message: null,
};

export const CANVAS_PREPARATION_DIAGNOSTIC_DEFAULTS: CanvasPreparationDiagnostics =
  {
    phase: null,
    retryPhase: null,
    source: null,
    subsource: null,
    failure: EMPTY_PREPARATION_FAILURE_DIAGNOSTIC,
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
    syncStatusCode: null,
    syncStatusMessage: null,
    wsEventType: null,
  };

const pickNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

export const readWhitelistedErrorDetails = (error: unknown) => {
  if (!error || typeof error !== "object") {
    return {
      errorName: null,
      errorCode: null,
      httpStatus: null,
      remoteCode: null,
      remoteMessage: null,
      causeName: null,
      causeMessage: null,
    };
  }
  const record = error as {
    name: unknown | undefined;
    code: unknown | undefined;
    message: unknown | undefined;
    status: unknown | undefined;
    body: unknown | undefined;
    cause: unknown | undefined;
  };
  const body =
    record.body &&
    typeof record.body === "object" &&
    !Array.isArray(record.body)
      ? (record.body as ErrorBodyRecord)
      : null;
  const cause =
    record.cause && typeof record.cause === "object"
      ? (record.cause as {
          name: unknown | undefined;
          message: unknown | undefined;
        })
      : null;
  return {
    errorName: pickNonEmptyString(record.name),
    errorCode: pickNonEmptyString(record.code),
    httpStatus:
      typeof record.status === "number" && Number.isFinite(record.status)
        ? record.status
        : null,
    remoteCode: pickNonEmptyString((body !== null && body !== undefined ? body.code : undefined)),
    remoteMessage:
      pickNonEmptyString((body !== null && body !== undefined ? body.message : undefined)) ?? pickNonEmptyString(record.message),
    causeName: pickNonEmptyString((cause !== null && cause !== undefined ? cause.name : undefined)),
    causeMessage: pickNonEmptyString((cause !== null && cause !== undefined ? cause.message : undefined)),
  };
};

const normalizePreparationFailureDiagnostic = (
  failure: CanvasPreparationDiagnostics["failure"] | null | undefined,
): CanvasPreparationDiagnostics["failure"] => {
  if (failure === null || failure === undefined) {
    return EMPTY_PREPARATION_FAILURE_DIAGNOSTIC;
  }
  return {
    code: failure.code ?? null,
    message: failure.message ?? null,
  };
};

export const normalizeCanvasPreparationDiagnostics = (
  diagnostics: CanvasPreparationDiagnostics | null | undefined,
): CanvasPreparationDiagnostics | null => {
  if (diagnostics === null || diagnostics === undefined) {
    return null;
  }
  return {
    phase: diagnostics.phase ?? null,
    retryPhase: diagnostics.retryPhase ?? null,
    source: diagnostics.source ?? null,
    subsource: diagnostics.subsource ?? null,
    failure: normalizePreparationFailureDiagnostic(diagnostics.failure),
    errorName: diagnostics.errorName ?? null,
    errorCode: diagnostics.errorCode ?? null,
    httpStatus: diagnostics.httpStatus ?? null,
    remoteCode: diagnostics.remoteCode ?? null,
    remoteMessage: diagnostics.remoteMessage ?? null,
    causeName: diagnostics.causeName ?? null,
    causeMessage: diagnostics.causeMessage ?? null,
    projectOpenStage: diagnostics.projectOpenStage ?? null,
    projectOpenSource: diagnostics.projectOpenSource ?? null,
    projectOpenAction: diagnostics.projectOpenAction ?? null,
    configKey: diagnostics.configKey ?? null,
    configEndpoint: diagnostics.configEndpoint ?? null,
    timeoutMs: diagnostics.timeoutMs ?? null,
    hint: diagnostics.hint ?? null,
    syncStatusCode: diagnostics.syncStatusCode ?? null,
    syncStatusMessage: diagnostics.syncStatusMessage ?? null,
    wsEventType: diagnostics.wsEventType ?? null,
  };
};

export const buildCanvasPreparationDiagnostics = (params: {
  phase: PreparationPhase | null | undefined;
  retryPhase: RetryPhase | null | undefined;
  source: string | null | undefined;
  failure:
    | {
        code: string | null | undefined;
        message: string | null | undefined;
      }
    | null
    | undefined;
  subsource: string | null | undefined;
  embedded: CanvasPreparationDiagnostics | null | undefined;
  details:
    | ReturnType<typeof readWhitelistedErrorDetails>
    | null
    | undefined;
}): CanvasPreparationDiagnostics => {
  const normalizedEmbedded = normalizeCanvasPreparationDiagnostics(
    params.embedded,
  );
  const normalizedFailure = normalizePreparationFailureDiagnostic(
    params.failure,
  );
  const embeddedPhase =
    normalizedEmbedded !== null && normalizedEmbedded !== undefined
      ? normalizedEmbedded.phase
      : null;
  const embeddedRetryPhase =
    normalizedEmbedded !== null && normalizedEmbedded !== undefined
      ? normalizedEmbedded.retryPhase
      : null;
  const embeddedSource =
    normalizedEmbedded !== null && normalizedEmbedded !== undefined
      ? normalizedEmbedded.source
      : null;
  const embeddedSubsource =
    normalizedEmbedded !== null && normalizedEmbedded !== undefined
      ? normalizedEmbedded.subsource
      : null;
  return {
    ...CANVAS_PREPARATION_DIAGNOSTIC_DEFAULTS,
    ...(normalizedEmbedded ?? {}),
    ...(params.details ?? {}),
    phase: params.phase ?? embeddedPhase ?? null,
    retryPhase: params.retryPhase ?? embeddedRetryPhase ?? null,
    source: params.source ?? embeddedSource ?? null,
    subsource: params.subsource ?? embeddedSubsource ?? null,
    failure: normalizedFailure,
  };
};

export const readEmbeddedDiagnostics = (
  error: unknown,
): CanvasPreparationDiagnostics | null => {
  if (!error || typeof error !== "object" || !("diagnostics" in error)) {
    return null;
  }
  const diagnostics = (error as { diagnostics: unknown | undefined }).diagnostics;
  if (
    !diagnostics ||
    typeof diagnostics !== "object" ||
    Array.isArray(diagnostics)
  ) {
    return null;
  }
  return normalizeCanvasPreparationDiagnostics(
    diagnostics as CanvasPreparationDiagnostics,
  );
};

export const isProjectDataEmptyError = (error: unknown): boolean => {
  const body =
    typeof error === "object" && error && "body" in error
      ? (error as { body: unknown | undefined }).body
      : null;
  const code =
    body && typeof body === "object" && "code" in body
      ? (body as { code: unknown | undefined }).code
      : null;
  return code === "project_data_empty" || code === "project-data-empty";
};

const readProjectLoadFailureCode = (error: unknown): string | null => {
  const body =
    typeof error === "object" && error && "body" in error
      ? (error as { body: unknown | undefined }).body
      : null;
  const code =
    body && typeof body === "object" && "code" in body
      ? (body as { code: unknown | undefined }).code
      : null;
  return typeof code === "string" && code.trim() ? code : null;
};

export const withTimeout = async <T,>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

export const buildProjectLoadFailure = (error: unknown) => {
  const embeddedDiagnostics = readEmbeddedDiagnostics(error);
  const failureCode = readProjectLoadFailureCode(error);
  if (
    failureCode === "invalid-project-folder" ||
    failureCode === "project-manifest-missing" ||
    failureCode === "missing-node-graph"
  ) {
    const message =
      error instanceof Error && error.message.trim()
        ? error.message
        : "项目打开失败，请检查项目目录与数据完整性。";
    return {
      code: failureCode,
      message,
      diagnostics: buildCanvasPreparationDiagnostics({
        phase: "loading-project",
        retryPhase: "loading-project",
        source: "project_load",
        subsource: null,
        failure: { code: failureCode, message },
        details: readWhitelistedErrorDetails(error),
        embedded: embeddedDiagnostics,
      }),
    };
  }
  if (
    error instanceof Error &&
    error.message === "项目里还没有画布内容，无法继续打开。"
  ) {
    return {
      code: "missing-node-graph",
      message: error.message,
      diagnostics: buildCanvasPreparationDiagnostics({
        phase: "loading-project",
        retryPhase: "loading-project",
        source: "project_load",
        subsource: null,
        failure: { code: "missing-node-graph", message: error.message },
        details: null,
        embedded: embeddedDiagnostics,
      }),
    };
  }
  if (
    error instanceof Error &&
    error.message === "打开项目超时，请重试或关闭窗口。"
  ) {
    return {
      code: "project-load-timeout",
      message: error.message,
      diagnostics: buildCanvasPreparationDiagnostics({
        phase: "loading-project",
        retryPhase: "loading-project",
        source: "project_load",
        subsource: null,
        failure: { code: "project-load-timeout", message: error.message },
        details: null,
        embedded: embeddedDiagnostics,
      }),
    };
  }
  const message =
    error instanceof Error
      ? error.message
      : "项目内容读取失败，请重试或关闭窗口。";
  return {
    code: "project-load-failed",
    message,
    diagnostics: buildCanvasPreparationDiagnostics({
      phase: "loading-project",
      retryPhase: "loading-project",
      source: "project_load",
      subsource: null,
      failure: { code: "project-load-failed", message },
      details: readWhitelistedErrorDetails(error),
      embedded: embeddedDiagnostics,
    }),
  };
};
