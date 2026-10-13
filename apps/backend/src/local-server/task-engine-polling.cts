import * as networkModule from "./network.cts";
import * as utilsModule from "./utils.cts";
import * as loggingModule from "./logging.cts";
import { getAdapter } from "./protocol-adapter/adapter-registry.cts";
import {
  acquireLease,
  getLease,
  readCredentialValue,
  releaseLease,
} from "./provider-connection/credential-store.cts";
import {
  buildAdapterAuthHeader,
  ExecutionSnapshotSchema,
  type ExecutionSnapshot,
} from "@iart/contracts";
import { getFetchDispatcher } from "./fetch-dispatcher.cts";
import {
  classifyNetworkError,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_MAX_ATTEMPTS,
  DEFAULT_POLL_MAX_CONSECUTIVE_FAILURES,
  ERROR_CODES,
  getErrorCause,
  isRecord,
  TASK_STATUS,
  toRecord,
  type PlainObject,
} from "./task-engine-shared.cts";
import {
  appendTaskArchiveEventSafely,
  summarizeArchiveResponse,
} from "./task-engine-archive.cts";
import {
  buildRequestBody,
  flattenHeaders,
} from "./task-engine-request.cts";
import { parsePollingResponseBody } from "./task-engine-http-response.cts";
import {
  mergeTaskProgressPatch,
  patchTaskRecord,
  type TaskProgressPatch,
} from "./task-engine-state.cts";
import {
  detectTaskFailure,
  parseTaskProgress,
  readValueByPath,
} from "./task-engine-polling-utils.cts";
import { hasResultOutputMapping } from "./task-result-output-mapping.cts";
import { resolveHttpStatusUserMessage } from "./http-status-fallback-messages.cts";
import {
  normalizeString,
  normalizeTaskPolling,
  normalizeTaskRequest,
} from "./task-normalizer.cts";

const { isAllowedTaskUrlForModel } = networkModule;
const { normalizePositiveInt } = utilsModule;

const resolveExecutionSnapshotFromMetadata = (metadata: PlainObject): ExecutionSnapshot | null => {
  const candidate =
    (metadata as PlainObject).executionSnapshot ??
    (metadata as PlainObject).execution_snapshot;
  if (!candidate || typeof candidate !== "object") return null;
  const parsed = ExecutionSnapshotSchema.safeParse(candidate);
  if (!parsed.success) {
    loggingModule.logDebug("[task-engine-polling] invalid executionSnapshot in metadata, ignore", {
      error: parsed.error.message,
    });
    return null;
  }
  return parsed.data;
};

const rewriteUrlWithSnapshotBase = (originalUrl: URL, baseUrl: string): URL => {
  const trimmed = baseUrl.replace(/\/+$/, "");
  try {
    return new URL(`${trimmed}${originalUrl.pathname}${originalUrl.search}${originalUrl.hash}`);
  } catch {
    return originalUrl;
  }
};

const executePollingTask = async (
  record: unknown,
  controller: AbortController,
  overrides: unknown = {},
) => {
  const failPollingTask = async (currentRecord: unknown, error: unknown) =>
    await patchTaskRecord(currentRecord, {
      status: TASK_STATUS.FAILED,
      finishedAt: Date.now(),
      error,
      progress: mergeTaskProgressPatch(toRecord(currentRecord).progress, {
        phase: null,
      } as TaskProgressPatch),
    } as PlainObject);
  const recordValue = toRecord(record);
  const overridesValue = toRecord(overrides);
  const activeRequest = normalizeTaskRequest(
    isRecord(overridesValue.request)
      ? overridesValue.request
      : recordValue.request,
  );
  if (!activeRequest || !activeRequest.url) {
    return failPollingTask(record, {
      code: ERROR_CODES.INVALID_TASK,
      message: "Missing polling request",
    });
  }
  const activeRequestValue = toRecord(activeRequest);
  const activeRequestMethod =
    normalizeString(activeRequestValue.method) || "GET";
  const activeRequestHeaders = flattenHeaders(activeRequestValue.headers);
  const activeRequestBody = activeRequestValue.body;
  const polling = normalizeTaskPolling(
    isRecord(overridesValue.polling)
      ? overridesValue.polling
      : recordValue.polling,
  );
  if (!polling) {
    return failPollingTask(record, {
      code: ERROR_CODES.INVALID_TASK,
      message: "Missing polling config",
    });
  }
  const gateModelId = normalizeString(
    toRecord(recordValue.metadata).modelId || toRecord(recordValue.metadata).model_id,
  );
  let snapshotForPolling: ExecutionSnapshot | null = null;
  // 若任务已冻结 ExecutionSnapshot（spec 03 §8），优先以快照中的 base_url 重写轮询 host
  const preSnapshot = resolveExecutionSnapshotFromMetadata(toRecord(recordValue.metadata) as PlainObject);
  if (preSnapshot) {
    snapshotForPolling = preSnapshot;
  }
  let targetUrl: URL;
  // 能力包只声明相对轮询路径（spec 03 §8：origin 由派发时冻结的 base_url 决定），
  // 因此以快照 base_url 补齐 origin；已是绝对 URL 时改用快照 host 重写。
  const snapshotBaseTrimmed = snapshotForPolling
    ? snapshotForPolling.base_url.replace(/\/+$/, "")
    : "";
  try {
    if (/^https?:\/\//i.test(activeRequest.url)) {
      targetUrl = new URL(activeRequest.url);
      if (snapshotForPolling) {
        targetUrl = rewriteUrlWithSnapshotBase(targetUrl, snapshotForPolling.base_url);
      }
    } else if (snapshotForPolling && activeRequest.url.startsWith("/")) {
      targetUrl = new URL(`${snapshotBaseTrimmed}${activeRequest.url}`);
    } else {
      loggingModule.logDebug("[task-engine-polling] polling url unresolvable", {
        taskId: normalizeString(recordValue.id),
        hasSnapshot: Boolean(snapshotForPolling),
        url: activeRequest.url,
      });
      return failPollingTask(record, {
        code: ERROR_CODES.INVALID_URL,
        message: "Invalid task URL",
      });
    }
  } catch {
    return failPollingTask(record, {
      code: ERROR_CODES.INVALID_URL,
      message: "Invalid task URL",
    });
  }
  if (!isAllowedTaskUrlForModel(targetUrl, gateModelId)) {
    return failPollingTask(record, {
      code: ERROR_CODES.REMOTE_HOST_NOT_ALLOWED,
      message: "Remote host not allowed",
    });
  }
  let next = toRecord(
    await patchTaskRecord(record, {
      status: TASK_STATUS.POLLING,
      startedAt: recordValue.startedAt ?? Date.now(),
      error: null,
    } as PlainObject),
  );
  const intervalMs = normalizePositiveInt(
    polling.intervalMs,
    DEFAULT_POLL_INTERVAL_MS,
  );
  const maxAttempts = normalizePositiveInt(
    polling.maxAttempts,
    DEFAULT_POLL_MAX_ATTEMPTS,
  );
  const maxConsecutiveFailures = normalizePositiveInt(
    polling.maxConsecutiveFailures,
    DEFAULT_POLL_MAX_CONSECUTIVE_FAILURES,
  );
  const wait = (ms: unknown) =>
    new Promise<void>((resolve) =>
      setTimeout(resolve, normalizePositiveInt(ms, 0)),
    );
  // 租约生命周期（spec 03 §5.3）：submit 租约保留到任务终态，polling 复用同一租约，避免 http->polling 双租约泄漏。
  // - metadata.credentialLeaseId 为 http 阶段 acquire 的 leaseId，polling 复用其租约明文；
  // - 若租约丢失或历史任务无 leaseId，则按快照重建；
  // - 异步任务的租约由 polling 终态释放（http 侧在进入 polling 时不释放），同步/失败任务由 http 释放。
  let pollingLeaseId: string | null = null;
  let pollingLeaseValue: string | null = null;
  const existingLeaseId = typeof (toRecord(next.metadata) as PlainObject).credentialLeaseId === 'string'
    ? String((toRecord(next.metadata) as PlainObject).credentialLeaseId).trim()
    : '';
  if (snapshotForPolling && snapshotForPolling.credential_ref) {
    const refreshed = resolveExecutionSnapshotFromMetadata(toRecord(next.metadata) as PlainObject);
    if (refreshed) snapshotForPolling = refreshed;
    const currentCredRef: string | undefined = snapshotForPolling.credential_ref;
    if (!currentCredRef) {
      loggingModule.logDebug('[task-engine-polling] polling: snapshot credential_ref missing after refresh', {
        snapshotId: snapshotForPolling.snapshot_id,
      });
    } else if (existingLeaseId) {
      const existingLease = getLease(existingLeaseId);
      const value = await readCredentialValue(currentCredRef);
      if (existingLease && value !== null) {
        pollingLeaseId = existingLease.leaseId;
        pollingLeaseValue = value;
        loggingModule.logDebug('[task-engine-polling] polling reuses submit lease', {
          leaseId: existingLeaseId,
          connectionId: snapshotForPolling.connection_id,
        });
      } else {
        loggingModule.logDebug('[task-engine-polling] polling reuses submit lease: missing lease or credential, reacquiring', {
          existingLeaseId,
          credentialRef: currentCredRef,
          hasExistingLease: Boolean(existingLease),
          hasCredentialValue: value !== null,
        });
        const leaseRes = await acquireLease({
          connectionId: snapshotForPolling.connection_id,
          credentialRef: currentCredRef,
          credentialVersion: snapshotForPolling.credential_version ?? 0,
          connectionRevision: snapshotForPolling.connection_revision,
        });
        if (!leaseRes) {
          loggingModule.logDebug("[task-engine-polling] acquireLease for polling failed", {
            credentialRef: currentCredRef,
            connectionId: snapshotForPolling.connection_id,
          });
          return failPollingTask(next, {
            code: "credential_missing",
            message: "failed to acquire credential lease for polling",
          });
        }
        pollingLeaseId = leaseRes.lease.leaseId;
        pollingLeaseValue = leaseRes.value;
      }
    } else {
      const leaseRes = await acquireLease({
        connectionId: snapshotForPolling.connection_id,
        credentialRef: currentCredRef,
        credentialVersion: snapshotForPolling.credential_version ?? 0,
        connectionRevision: snapshotForPolling.connection_revision,
      });
      if (!leaseRes) {
        loggingModule.logDebug("[task-engine-polling] acquireLease for polling failed", {
          credentialRef: currentCredRef,
          connectionId: snapshotForPolling.connection_id,
        });
        return failPollingTask(next, {
          code: "credential_missing",
          message: "failed to acquire credential lease for polling",
        });
      }
      pollingLeaseId = leaseRes.lease.leaseId;
      pollingLeaseValue = leaseRes.value;
    }
  } else {
    const refreshed = resolveExecutionSnapshotFromMetadata(toRecord(next.metadata) as PlainObject);
    const refreshedCredRef: string | undefined = refreshed?.credential_ref;
    if (refreshed && refreshedCredRef) {
      snapshotForPolling = refreshed;
      const leaseRes = await acquireLease({
        connectionId: refreshed.connection_id,
        credentialRef: refreshedCredRef,
        credentialVersion: refreshed.credential_version ?? 0,
        connectionRevision: refreshed.connection_revision,
      });
      if (leaseRes) {
        pollingLeaseId = leaseRes.lease.leaseId;
        pollingLeaseValue = leaseRes.value;
      }
    }
  }
  const releasePollingLease = () => {
    if (pollingLeaseId) {
      try {
        releaseLease(pollingLeaseId);
      } catch { void 0; }
    }
    pollingLeaseId = null;
  };
  // 若为 snapshot 轮询，targetUrl 已重写；否则保持原 polling URL
  if (snapshotForPolling) {
    try {
      const tmp = new URL(activeRequest.url);
      targetUrl = rewriteUrlWithSnapshotBase(tmp, snapshotForPolling.base_url);
    } catch { void 0; }
  }
  let consecutiveFailures = 0;
  let lastFailureMessage = null;
  let lastNetworkClass: ReturnType<typeof classifyNetworkError> = null;
  // 声明在循环外：轮询失败构造点（含循环后的兜底 patch）需要按最近一次响应状态
  // 查询内置 HTTP 状态码 → userMessage 兜底文案。
  let responseStatus = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (controller.signal.aborted) {
      releasePollingLease();
      return failPollingTask(next, {
        code: ERROR_CODES.TASK_CANCELED,
        message: "Task canceled",
      });
    }
    const headers = new Headers(activeRequestHeaders);
    // 鉴权注入形态由适配器声明（spec 03 §3.1），与提交链路同源，不得硬编码 Bearer。
    const pollingAuthAdapter = snapshotForPolling ? getAdapter(snapshotForPolling.adapter_id) : null;
    if (snapshotForPolling && pollingLeaseValue) {
      if (!pollingAuthAdapter) {
        loggingModule.logDebug("[task-engine-polling] snapshot adapter missing, skip auth injection", {
          adapterId: snapshotForPolling.adapter_id,
          taskId: normalizeString(next.id),
        });
      } else {
        const authHeader = buildAdapterAuthHeader(pollingAuthAdapter.auth, pollingLeaseValue);
        if (!headers.has(authHeader.name)) {
          headers.set(authHeader.name, authHeader.value);
        }
      }
    }
    const body = buildRequestBody(activeRequestBody, headers);
    const requestController = new AbortController();
    const handleAbort = () => requestController.abort();
    controller.signal.addEventListener("abort", handleAbort, { once: true });
    let responseBody: unknown = null;
    let responseBodyType: string | null = null;
    const responseFile: PlainObject | null = null;
    let evaluationBody = null;
    let responseContentType = "";
    let responseOk = false;
    let responseHeaders: Headers | null = null;
    try {
      const requestInit: RequestInit = {
        method: activeRequestMethod,
        headers,
        signal: requestController.signal,
      };
      if (body !== undefined) requestInit.body = body;
      Object.assign(requestInit as PlainObject, {
        dispatcher: getFetchDispatcher(),
      });
      const response = await fetch(targetUrl.toString(), requestInit);
      controller.signal.removeEventListener("abort", handleAbort);
      responseStatus = response.status;
      responseOk = response.ok;
      responseHeaders = response.headers;
      responseContentType = response.headers.get("content-type") || "";
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > 0) {
        // 与 http sync 路径同一兜底口径：是否 JSON.parse 由文本内容决定，不由 Content-Type 决定。
        // 中转网关把 JSON 标成 text/plain 时，若只按 Content-Type 判定，body 会存为字符串：
        // 轮询判定（readValueByPath 可解析 JSON 字符串）能成功，但下游 output_mapping_rules
        // 物化（readValuesByPath 不解析字符串）会在字符串 body 上映射未命中，
        // 报 result_output_mapping_missed。两条路径必须共享同一解析结果。
        const parsed = parsePollingResponseBody({
          buffer,
          contentType: responseContentType,
        });
        responseBody = parsed.body;
        responseBodyType = parsed.bodyType;
        evaluationBody = parsed.evaluationBody;
      }
    } catch (error) {
      controller.signal.removeEventListener("abort", handleAbort);
      if (controller.signal.aborted) {
        writePollingErrorLog(
          next,
          attempt,
          targetUrl,
          activeRequestMethod,
          "Task canceled",
          getErrorCause(error),
          true,
        );
        releasePollingLease();
        return failPollingTask(next, {
          code: ERROR_CODES.TASK_CANCELED,
          message: "Task canceled",
        });
      }
      writePollingErrorLog(
        next,
        attempt,
        targetUrl,
        activeRequestMethod,
        String(error),
        getErrorCause(error),
        false,
      );
      lastFailureMessage = String(error);
      lastNetworkClass = classifyNetworkError(error);
      consecutiveFailures += 1;
      next = toRecord(
        await patchTaskRecord(next, {
          progress: mergeTaskProgressPatch(next.progress, {
            attempt,
            maxAttempts,
            consecutiveFailures,
          } as TaskProgressPatch),
        } as PlainObject),
      );
      if (consecutiveFailures >= maxConsecutiveFailures) {
        releasePollingLease();
        return failPollingTask(next, lastNetworkClass
          ? {
              code: ERROR_CODES.TASK_EXECUTION_FAILED,
              message: lastFailureMessage,
              userMessage: lastNetworkClass.userMessage,
              retryable: true,
            }
          : {
              code: ERROR_CODES.TASK_EXECUTION_FAILED,
              message: lastFailureMessage,
            });
      }
      await wait(intervalMs);
      continue;
    }
    const responsePayload = {
      status: responseStatus,
      ok: responseOk,
      contentType: responseContentType,
      body: responseBody,
      bodyType: responseBodyType,
      file: responseFile,
      receivedAt: new Date().toISOString(),
      attempt,
    };
    next = toRecord(
      await patchTaskRecord(next, {
        response: responsePayload,
        progress: mergeTaskProgressPatch(next.progress, {
          phase: "polling",
          percent: parseTaskProgress(
            polling.progressFieldPath
              ? readValueByPath(evaluationBody, polling.progressFieldPath, {
                  silent: true,
                  parseJsonString: undefined,
                } as Parameters<typeof readValueByPath>[2])
              : toRecord(evaluationBody).progress,
          ),
          attempt,
          maxAttempts,
          consecutiveFailures,
        } as TaskProgressPatch),
      } as PlainObject),
    );
    const failureDetection = detectTaskFailure(evaluationBody, {
      statusFieldPaths: polling.statusFieldPaths,
      failureStatuses: polling.failureStatuses,
      failureCodePaths: polling.failureCodePaths,
      failureMessagePaths: polling.failureMessagePaths,
    } as PlainObject, responseHeaders);
    if (failureDetection.failed) {
      lastFailureMessage = failureDetection.message || "Task failed";
      lastNetworkClass = null;
      const detectedFailureCode =
        failureDetection.code !== undefined && failureDetection.code !== null
          ? String(failureDetection.code).trim()
          : "";
      releasePollingLease();
      return await patchTaskRecord(next, {
        status: TASK_STATUS.FAILED,
        finishedAt: Date.now(),
        error: {
          code: detectedFailureCode || ERROR_CODES.TASK_EXECUTION_FAILED,
          message: lastFailureMessage,
          userMessage: resolveHttpStatusUserMessage(responseStatus),
        },
        progress: mergeTaskProgressPatch(next.progress, { phase: null } as TaskProgressPatch),
      } as PlainObject);
    }
    const successValue = resolvePollingSuccessValue(polling as PlainObject, evaluationBody, responseHeaders);
    if (
      successValue !== undefined &&
      successValue !== null &&
      successValue !== ""
    ) {
      releasePollingLease();
      return finalizePollingSuccess(next);
    }
    // 判定未命中继续轮询：debug 留痕（AGENTS.md 条件跳过必须留痕），否则链路断裂不可见。
    loggingModule.logDebug("[task-engine] polling attempt evaluated without terminal judgement", {
      taskId: next.id,
      attempt,
      maxAttempts,
      httpStatus: responseStatus,
      resolvedStatus: failureDetection.status ?? null,
      successEvidencePresent: isSuccessEvidencePresent(polling as PlainObject, evaluationBody),
    });
    if (!responseOk) {
      lastFailureMessage = `Polling request failed (HTTP ${responseStatus || 0})`;
      lastNetworkClass = null;
      consecutiveFailures += 1;
      next = toRecord(
        await patchTaskRecord(next, {
          progress: mergeTaskProgressPatch(next.progress, {
            attempt,
            maxAttempts,
            consecutiveFailures,
          } as TaskProgressPatch),
        } as PlainObject),
      );
      if (consecutiveFailures >= maxConsecutiveFailures) {
        releasePollingLease();
        return failPollingTask(next, {
          code: ERROR_CODES.TASK_EXECUTION_FAILED,
          message: lastFailureMessage,
          userMessage: resolveHttpStatusUserMessage(responseStatus),
        });
      }
      await wait(intervalMs);
      continue;
    }
    consecutiveFailures = 0;
    if (attempt >= maxAttempts) {
      releasePollingLease();
      return failPollingTask(next, {
        code: ERROR_CODES.TASK_EXECUTION_FAILED,
        message: "任务轮询失败（超过最大尝试次数）",
      });
    }
    await wait(intervalMs);
  }
  releasePollingLease();
  return await patchTaskRecord(next, {
    status: TASK_STATUS.FAILED,
    finishedAt: Date.now(),
    error: {
      code: ERROR_CODES.TASK_EXECUTION_FAILED,
      message: "任务轮询失败（超过最大尝试次数）",
      userMessage: resolveHttpStatusUserMessage(responseStatus),
    },
  } as PlainObject);
};

const writePollingErrorLog = (
  record: PlainObject,
  attempt: number,
  targetUrl: URL,
  method: string,
  message: string,
  cause: unknown,
  canceled: boolean,
) => {
  // 轮询请求错误会在循环中静默重试，必须在日志留痕，否则链路断裂不可见
  // （AGENTS.md 条件跳过必须留痕）。
  if (!canceled) {
    loggingModule.logWarn("[task-engine] polling request error", {
      taskId: record.id,
      attempt,
      url: targetUrl.toString(),
      method,
      message,
      cause: cause === undefined || cause === null ? null : String(cause),
    });
  }
};

const isSuccessEvidencePresent = (
  polling: PlainObject,
  body: unknown,
): boolean => {
  const successPaths: string[] = [];
  if (polling.successPath) successPaths.push(polling.successPath as string);
  if (Array.isArray(polling.successFieldPaths)) {
    successPaths.push(...(polling.successFieldPaths as string[]));
  }
  if (successPaths.length === 0) return true;
  for (const pathValue of successPaths) {
    const value = readValueByPath(body, pathValue, { silent: true, parseJsonString: undefined } as Parameters<typeof readValueByPath>[2]);
    if (value !== undefined && value !== null && value !== "") {
      return true;
    }
  }
  return false;
};

const isStatusMatchingSuccess = (
  polling: PlainObject,
  body: unknown,
  responseHeaders: Headers | null,
): boolean => {
  const successStatuses = Array.isArray(polling.successStatuses)
    ? (polling.successStatuses as string[])
    : [];
  if (successStatuses.length === 0) return true;
  const statusPaths = Array.isArray(polling.statusFieldPaths)
    ? (polling.statusFieldPaths as string[])
    : [];
  if (statusPaths.length === 0) return false;
  const normalizedSuccessStatuses = new Set(
    successStatuses.map((item) => item.toLowerCase()),
  );
  for (const pathValue of statusPaths) {
    let value = readValueByPath(body, pathValue, { silent: true, parseJsonString: undefined } as Parameters<typeof readValueByPath>[2]);
    // body 未命中时回落响应头（部分上游只在响应头携带任务状态）。
    if ((value === undefined || value === null || value === "") && responseHeaders) {
      const headerValue = responseHeaders.get(pathValue);
      if (headerValue !== null && headerValue.trim() !== "") {
        value = headerValue;
      }
    }
    if (value === undefined || value === null || value === "") continue;
    const valueStr = typeof value === "string" ? value : String(value);
    if (normalizedSuccessStatuses.has(valueStr.toLowerCase())) {
      return true;
    }
  }
  return false;
};

const resolvePollingSuccessValue = (polling: PlainObject, body: unknown, responseHeaders: Headers | null = null) => {
  if (!isSuccessEvidencePresent(polling, body)) return undefined;
  if (!isStatusMatchingSuccess(polling, body, responseHeaders)) return undefined;
  const successPaths: string[] = [];
  if (polling.successPath) successPaths.push(polling.successPath as string);
  if (Array.isArray(polling.successFieldPaths)) {
    successPaths.push(...(polling.successFieldPaths as string[]));
  }
  for (const pathValue of successPaths) {
    const value = readValueByPath(body, pathValue, { silent: true, parseJsonString: undefined } as Parameters<typeof readValueByPath>[2]);
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return undefined;
};

const finalizePollingSuccess = async (next: PlainObject) => {
  if (hasResultOutputMapping(next)) {
    const ready = toRecord(
      await patchTaskRecord(next, {
        progress: mergeTaskProgressPatch(next.progress, {
          phase: "result_received",
          percent: 100,
        } as TaskProgressPatch),
        error: null,
      } as PlainObject),
    );
    appendTaskArchiveEventSafely(
      ready,
      "task.result_received",
      {
        phase: "result_received",
        response: summarizeArchiveResponse(ready.response),
      },
      "[task-engine] Failed to write result_received archive event:",
    );
    return ready;
  }
  const finalized = toRecord(
    await patchTaskRecord(next, {
      status: TASK_STATUS.SUCCEEDED,
      finishedAt: Date.now(),
      progress: mergeTaskProgressPatch(next.progress, { phase: null } as TaskProgressPatch),
    } as PlainObject),
  );
  appendTaskArchiveEventSafely(
    finalized,
    "task.result_received",
    {
      phase: "result_received",
      response: summarizeArchiveResponse(finalized.response),
    },
    "[task-engine] Failed to write result_received archive event:",
  );
  return finalized;
};

export { executePollingTask, resolvePollingSuccessValue };
