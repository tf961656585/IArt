import * as networkModule from "./network.cts";
import * as modelInputPreparationModule from "./model-input-preparation/model-input-preparation.cts";
import { buildExecutionSnapshot } from "./provider-connection/execution-snapshot.cts";
import { applyRemoteModelInjection } from "./provider-connection/remote-model-injection.cts";
import {
  acquireLease,
  releaseLease,
  type CredentialLease,
} from "./provider-connection/credential-store.cts";

import { getAdapter } from "./protocol-adapter/adapter-registry.cts";
import { getFetchDispatcher } from "./fetch-dispatcher.cts";
import * as loggingModule from "./logging.cts";
import { buildAdapterAuthHeader, type ExecutionSnapshot } from "@iart/contracts";
import {
  classifyNetworkError,
  ERROR_CODES,
  getErrorMessage,
  isAbortError,
  TASK_STATUS,
  toRecord,
  type PlainObject,
} from "./task-engine-shared.cts";
import {
  appendTaskArchiveEventSafely,
  appendTaskInputUploadArchiveEvent,
  resolveProjectPathFromMetadata,
  summarizeArchiveResponse,
} from "./task-engine-archive.cts";
import {
  buildRequestBody,
  flattenHeaders,
  projectTaskRequest,
} from "./task-engine-request.cts";
import {
  patchTaskRecord,
  projectPollingMetadataPatch,
} from "./task-engine-state.cts";
import { buildPollingRequestFromPlan } from "./task-engine-polling-utils.cts";
import { executePollingTask } from "./task-engine-polling.cts";
import {
  buildAsyncPollingStartFailureArchiveDetail,
  buildAsyncPollingStartFailureError,
} from "./task-engine-polling-start-failure.cts";
import { hasResultOutputMapping } from "./task-result-output-mapping.cts";
import { buildRemoteHttpFailurePayload } from "./task-failure-mapping.cts";
import { normalizeString } from "./task-normalizer.cts";
import {
  buildResponsePayload,
  buildIntegrityErrorIfNeeded,
} from "./task-engine-http-response.cts";

const { isAllowedTaskUrlForModel } = networkModule;
const { prepareModelInputForRequest } = modelInputPreparationModule;

const prepareModelInputForTask = async (record: unknown) => {
  const recordValue = toRecord(record);
  const requestValue = toRecord(recordValue.request);
  let next = await patchTaskRecord(record, {
    status: TASK_STATUS.SUBMITTING,
    startedAt: recordValue.startedAt ?? Date.now(),
    error: null,
    request: projectTaskRequest(requestValue, requestValue.body),
    progress: { phase: "uploading_input" },
  } as PlainObject);
  const nextValue = toRecord(next);
  const metadata = toRecord(nextValue.metadata);
  const modelId = normalizeString(metadata.modelId || metadata.model_id);
  const projectPath = resolveProjectPathFromMetadata(metadata);
  const prepared = await prepareModelInputForRequest({
    modelId,
    projectPath,
    body: requestValue.body,
    projection: undefined,
    taskId: normalizeString(recordValue.id),
  });
  const preparedValue = toRecord(prepared);
  const events = prepared.events;
  for (const event of events) {
    const eventValue = toRecord(event);
    appendTaskInputUploadArchiveEvent(
      next,
      normalizeString(eventValue.type),
      eventValue.detail ?? null,
    );
  }
  if (preparedValue.ok !== true) {
    const errorValue = toRecord(preparedValue.error);
    return {
      ok: false,
      record: await patchTaskRecord(next, {
        status: TASK_STATUS.FAILED,
        finishedAt: Date.now(),
        request: projectTaskRequest(
          requestValue,
          preparedValue.body ?? requestValue.body,
        ),
        error: {
          code:
            normalizeString(errorValue.code) ||
            "model_input_preparation_failed",
          message:
            normalizeString(errorValue.message) ||
            "Model input preparation failed",
        },
      } as PlainObject),
    };
  }
  next = await patchTaskRecord(next, {
    request: projectTaskRequest(requestValue, preparedValue.body),
    progress: { phase: "requesting" },
  } as PlainObject);
  return { ok: true, record: next };
};

const executeHttpTask = async (
  record: unknown,
  controller: AbortController,
) => {
  const recordValue = toRecord(record);
  const requestValue = toRecord(recordValue.request);
  if (!requestValue.url) {
    return await patchTaskRecord(record, {
      status: TASK_STATUS.FAILED,
      finishedAt: Date.now(),
      error: {
        code: ERROR_CODES.INVALID_TASK,
        message: "Missing task request",
      },
    } as PlainObject);
  }
  const requestUrlString = String(requestValue.url);
  let originalTargetUrl: URL | null = null;
  try {
    originalTargetUrl = new URL(requestUrlString);
  } catch {
    originalTargetUrl = null;
  }
  const gateModelId = normalizeString(
    toRecord(recordValue.metadata).modelId || toRecord(recordValue.metadata).model_id,
  );

  // ---- Provider 连接快照与租约（spec 03 §5/§8）----
  // 通用 Provider 必须经 active deployment 解析并冻结 ExecutionSnapshot；无 active 时阻断。
  let snapshot: ExecutionSnapshot | null = null;
  let lease: CredentialLease | null = null;
  let leaseValue: string | null = null;
  let finalTargetUrl: URL | null = null;
  {
    const snapRes = buildExecutionSnapshot({ modelId: gateModelId });
    if (!snapRes.ok) {
      loggingModule.logDebug("[task-engine-http] snapshot build failed, blocking task", {
        modelId: gateModelId,
        code: snapRes.code,
        message: snapRes.message,
      });
      // 映射快照错误到统一错误码
      const mappedCode =
        snapRes.code === "no_active_deployment"
          ? "no_active_deployment"
          : snapRes.code === "credential_missing"
            ? "credential_missing"
            : snapRes.code === "connection_not_enabled"
              ? "connection_not_enabled"
              : snapRes.code;
      return await patchTaskRecord(record, {
        status: TASK_STATUS.FAILED,
        finishedAt: Date.now(),
        error: { code: mappedCode, message: snapRes.message },
        progress: { phase: null },
      } as PlainObject);
    }
    snapshot = snapRes.snapshot;
    const credRef: string | undefined = snapshot.credential_ref;
    const credVer: number | undefined = snapshot.credential_version;
    const connRev: number | undefined = snapshot.connection_revision;
    const connId: string | undefined = snapshot.connection_id;
    if (!credRef) {
      return await patchTaskRecord(record, {
        status: TASK_STATUS.FAILED,
        finishedAt: Date.now(),
        error: { code: "credential_missing", message: "connection credential missing" },
        progress: { phase: null },
      } as PlainObject);
    }
    const leaseRes = await acquireLease({
      connectionId: connId ?? "",
      credentialRef: credRef,
      credentialVersion: typeof credVer === "number" ? credVer : 0,
      connectionRevision: typeof connRev === "number" ? connRev : 0,
    });
    if (!leaseRes) {
      loggingModule.logDebug("[task-engine-http] acquireLease failed", { credentialRef: credRef, connectionId: connId });
      return await patchTaskRecord(record, {
        status: TASK_STATUS.FAILED,
        finishedAt: Date.now(),
        error: { code: "credential_missing", message: "failed to acquire credential lease" },
        progress: { phase: null },
      } as PlainObject);
    }
    lease = leaseRes.lease;
    leaseValue = leaseRes.value;
    // 连接地址由快照固定，具体路径仍由模型能力包的正式任务计划决定。
    // remote_model_id 注入（spec 45 §5.2）：URL 模板 `{model}` 替换必须发生在 URL 解析前，
    // 否则 new URL 会把 `{}` 转义成 %7B/%7D，破坏上游协议路径。
    try {
      const injectedUrl = applyRemoteModelInjection({
        snapshot,
        url: requestUrlString,
        body: requestValue.body,
      }).url;
      const baseTrim = snapshot.base_url.replace(/\/+$/, "");
      const asAbsolute = /^https?:\/\//i.test(injectedUrl);
      const pathSource = asAbsolute
        ? new URL(injectedUrl)
        : new URL(`${baseTrim}${injectedUrl.startsWith("/") ? injectedUrl : `/${injectedUrl}`}`);
      finalTargetUrl = new URL(`${baseTrim}${pathSource.pathname}${pathSource.search}${pathSource.hash}`);
    } catch {
      try {
        finalTargetUrl = new URL(snapshot.resolved_endpoint);
      } catch {
        finalTargetUrl = originalTargetUrl;
      }
    }
    if (!finalTargetUrl) {
      if (lease) {
        try {
          releaseLease(lease.leaseId);
        } catch {
          void 0;
        }
      }
      return await patchTaskRecord(record, {
        status: TASK_STATUS.FAILED,
        finishedAt: Date.now(),
        error: { code: ERROR_CODES.INVALID_URL, message: "Invalid task URL" },
      } as PlainObject);
    }
    if (!isAllowedTaskUrlForModel(finalTargetUrl, gateModelId)) {
      if (lease) {
        try {
          releaseLease(lease.leaseId);
        } catch {
          void 0;
        }
      }
      return await patchTaskRecord(record, {
        status: TASK_STATUS.FAILED,
        finishedAt: Date.now(),
        error: {
          code: ERROR_CODES.REMOTE_HOST_NOT_ALLOWED,
          message: "Remote host not allowed",
        },
      } as PlainObject);
    }
  }

  let prepared: unknown;
  try {
    prepared = await prepareModelInputForTask(record);
  } catch (error) {
    if (lease) {
      try {
        releaseLease(lease.leaseId);
      } catch {
        void 0;
      }
    }
    return await patchTaskRecord(record, {
      status: TASK_STATUS.FAILED,
      finishedAt: Date.now(),
      error: {
        code: ERROR_CODES.TASK_EXECUTION_FAILED,
        message: `Input preparation failed: ${getErrorMessage(error)}`,
      },
    } as PlainObject);
  }
  const preparedValue = toRecord(prepared);
  if (!preparedValue.ok || !preparedValue.record) {
    if (lease) {
      try {
        releaseLease(lease.leaseId);
      } catch {
        void 0;
      }
    }
    return preparedValue.record ?? record;
  }
  let next = toRecord(preparedValue.record);
  // 持久化快照与租约（若存在），供轮询/恢复/取消复用同一快照（spec 45 §5.2）
  if (snapshot && lease) {
    try {
      const patchedWithSnapshot = await patchTaskRecord(next, {
        metadata: {
          executionSnapshot: snapshot,
          execution_snapshot: snapshot,
          credentialLeaseId: lease.leaseId,
        },
      } as PlainObject);
      next = toRecord(patchedWithSnapshot);
    } catch {
      void 0;
    }
  }
  const attempt = 1;
  if (controller.signal.aborted) {
    if (lease) {
      try {
        releaseLease(lease.leaseId);
      } catch {
        void 0;
      }
    }
    return await patchTaskRecord(next, {
      status: TASK_STATUS.FAILED,
      finishedAt: Date.now(),
      error: { code: ERROR_CODES.TASK_CANCELED, message: "Task canceled" },
    } as PlainObject);
  }
  const nextRequest = toRecord(next.request);
  const headers = flattenHeaders(nextRequest.headers);
  // 鉴权注入：Provider 快照优先走租约明文（spec 03 §5.3）。
  // 注入形态与位置完全由适配器声明（spec 03 §3.1），此处不得硬编码 Bearer 前缀或 header 名：
  // OpenAI Images / 火山 Ark 用 Authorization: Bearer，Google 用 x-goog-api-key，同一段代码不得猜测。
  const snapshotAuthAdapter = snapshot ? getAdapter(snapshot.adapter_id) : null;
  if (snapshot && leaseValue) {
    if (!snapshotAuthAdapter) {
      loggingModule.logDebug("[task-engine-http] snapshot adapter missing, skip auth injection", {
        adapterId: snapshot.adapter_id,
        taskId: normalizeString(next.id),
      });
    } else {
      const authHeader = buildAdapterAuthHeader(snapshotAuthAdapter.auth, leaseValue);
      if (!headers.has(authHeader.name)) {
        headers.set(authHeader.name, authHeader.value);
      }
    }
  }
  // remote_model_id 协议注入（spec 45 §5.2）：body 顶层 `model` 只按快照冻结的
  // remote_model_id 注入，不读当前 active route、不回退能力包字面量。
  const requestBody = snapshot
    ? applyRemoteModelInjection({
        snapshot,
        url: String(nextRequest.url ?? ""),
        body: nextRequest.body,
      }).body
    : nextRequest.body;
  const body = buildRequestBody(requestBody, headers);
  // 响应体统一以 inline 方式累积到 inlineChunks，再交给 buildResponsePayload 解析。
  // 历史「大响应落盘到 resultFile」分支已移除（writeFd/resultPath/resultFile 全为死代码，
  // resultPath 恒为 null、writeFd 从未赋非 null 值，落盘函数 ensureResultFileOpen 恒返回 false）。
  // 若未来需要为大响应恢复落盘能力，应作为独立功能项重新实现，而非沿用此处的死分支骨架。
  let receivedBytes = 0;
  const inlineChunks: Buffer[] = [];
  let responseBody: unknown = null;
  let responseBodyType: string | null = null;
  const releaseLeaseSafe = () => {
    if (lease) {
      try {
        releaseLease(lease.leaseId);
      } catch {
        void 0;
      }
    }
  };
  try {
    const requestInit: RequestInit = {
      method: normalizeString(nextRequest.method) || "GET",
      headers,
      signal: controller.signal,
    };
    if (body !== undefined) requestInit.body = body;
    Object.assign(requestInit as PlainObject, {
      dispatcher: getFetchDispatcher(),
    });
    const response = await fetch(finalTargetUrl.toString(), requestInit);
    const contentType = response.headers.get("content-type") || "";
    const contentLengthHeader = response.headers.get("content-length");
    const parsedLength = contentLengthHeader
      ? parseInt(contentLengthHeader, 10)
      : NaN;
    const expectedSize =
      Number.isFinite(parsedLength) && parsedLength > 0 ? parsedLength : null;
    const responseHeaders = flattenHeaders(response.headers);
    next = toRecord(
      await patchTaskRecord(next, {
        progress: {
          phase: "downloading",
          receivedBytes: 0,
          totalBytes: expectedSize,
          percent: 0,
          attempt,
        },
      } as PlainObject),
    );
    if (!response.body || typeof response.body.getReader !== "function") {
      throw new Error("Missing response body");
    }
    const reader = response.body.getReader();
    const PROGRESS_UPDATE_INTERVAL = 100 * 1024;
    let lastProgressUpdate = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const bufValue = Buffer.from(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      );
      receivedBytes += bufValue.length;
      inlineChunks.push(bufValue);
      if (
        expectedSize &&
        receivedBytes - lastProgressUpdate >= PROGRESS_UPDATE_INTERVAL
      ) {
        lastProgressUpdate = receivedBytes;
        const percent = Math.min(
          99,
          Math.floor((receivedBytes / expectedSize) * 100),
        );
        next = toRecord(
          await patchTaskRecord(next, {
            progress: {
              phase: "downloading",
              receivedBytes,
              totalBytes: expectedSize,
              percent,
              attempt,
            },
          } as PlainObject),
        );
      }
    }
    const responsePayload = buildResponsePayload({
      response,
      contentType,
      receivedBytes,
      responseHeaders,
      attempt,
      inlineChunks,
    });
    responseBody = responsePayload.body;
    responseBodyType = normalizeString(responsePayload.bodyType) || null;
    const integrityError = buildIntegrityErrorIfNeeded({
      contentType,
      expectedSize,
      receivedBytes,
      responseBodyType,
      responseOk: response.ok,
    });
    const errorPayload =
      integrityError ??
      buildRemoteHttpFailurePayload({
        taskRecord: next,
        httpStatus: response.status,
        responseOk: response.ok,
        responseBody,
        responseBodyType,
        contentType,
        defaultCode: ERROR_CODES.TASK_EXECUTION_FAILED,
      });
    if (errorPayload) {
      // 非重试性错误落终态后释放租约（spec 03 §5.3：租约保留到任务终态）
      const willTerminal = true;
      if (willTerminal) releaseLeaseSafe();
      return await patchTaskRecord(next, {
        status: TASK_STATUS.FAILED,
        finishedAt: Date.now(),
        response: responsePayload,
        progress: { phase: null },
        error: errorPayload,
      } as PlainObject);
    }
    const pollingSpec = buildPollingRequestFromPlan(next, responseBody);
    if (pollingSpec.status === "ready") {
      const patched = await patchTaskRecord(next, {
        response: responsePayload,
        error: null,
        metadata: projectPollingMetadataPatch(
          next.metadata,
          pollingSpec.remoteRequestId,
        ),
      } as PlainObject);
      // 进入轮询：租约由 polling 终态释放，不在此释放
      return await executePollingTask(patched, controller, {
        request: pollingSpec.request,
        polling: pollingSpec.polling,
      });
    }
    if (pollingSpec.status === "blocked") {
      appendTaskArchiveEventSafely(
        next,
        "task.polling_start_failed",
        buildAsyncPollingStartFailureArchiveDetail({
          reason: pollingSpec.reason,
          submitResponseIdPath: pollingSpec.submitResponseIdPath,
          responsePayload,
        }),
        "[task-engine] Failed to write polling_start_failed archive event:",
      );
      releaseLeaseSafe();
      return await patchTaskRecord(next, {
        status: TASK_STATUS.FAILED,
        finishedAt: Date.now(),
        response: responsePayload,
        progress: { phase: null },
        error: buildAsyncPollingStartFailureError({
          reason: pollingSpec.reason,
          submitResponseIdPath: pollingSpec.submitResponseIdPath,
          responsePayload,
        }),
      } as PlainObject);
    }
    if (hasResultOutputMapping(next)) {
      const materializationReady = await patchTaskRecord(next, {
        response: responsePayload,
        progress: { phase: "result_received", percent: 100 },
        error: null,
      } as PlainObject);
      appendTaskArchiveEventSafely(
        materializationReady,
        "task.result_received",
        {
          phase: "result_received",
          response: summarizeArchiveResponse(responsePayload),
        },
        "[task-engine] Failed to write result_received archive event:",
      );
      // 同步结果已收齐，视为终态前置，释放租约（下载/归一化在 result-materializer 链，已持有 snapshot）
      releaseLeaseSafe();
      return materializationReady;
    }
    const persisted = await patchTaskRecord(next, {
      status: TASK_STATUS.SUCCEEDED,
      finishedAt: Date.now(),
      response: responsePayload,
      progress: { phase: "completed", percent: 100 },
      error: null,
    } as PlainObject);
    appendTaskArchiveEventSafely(
      persisted,
      "task.result_received",
      {
        phase: "result_received",
        response: summarizeArchiveResponse(responsePayload),
      },
      "[task-engine] Failed to write result_received archive event:",
    );
    releaseLeaseSafe();
    return persisted;
  } catch (error) {
    const isCanceled = controller.signal.aborted || isAbortError(error);
    if (isCanceled) {
      releaseLeaseSafe();
      return await patchTaskRecord(next, {
        status: TASK_STATUS.FAILED,
        finishedAt: Date.now(),
        error: { code: ERROR_CODES.TASK_CANCELED, message: "Task canceled" },
      } as PlainObject);
    }
    const networkClass = classifyNetworkError(error);
    releaseLeaseSafe();
    return await patchTaskRecord(next, {
      status: TASK_STATUS.FAILED,
      finishedAt: Date.now(),
      error: networkClass
        ? {
            code: ERROR_CODES.TASK_EXECUTION_FAILED,
            message: String(error),
            userMessage: networkClass.userMessage,
            retryable: true,
          }
        : {
            code: ERROR_CODES.TASK_EXECUTION_FAILED,
            message: String(error),
          },
    } as PlainObject);
  }
};

export { executeHttpTask };
