import * as networkModule from "./network.cts";
import * as utilsModule from "./utils.cts";
import * as loggingModule from "./logging.cts";
import { resolveSnapshotAuth } from "./provider-connection/snapshot-protocol.cts";
import {
  acquireLease,
  getLease,
  readCredentialValue,
  releaseLease,
} from "./provider-connection/credential-store.cts";
import {
  buildAdapterAuthInjection,
  ExecutionSnapshotSchema,
  type AdapterAuthInjection,
  type ExecutionSnapshot,
  type TaskFailureStage,
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
  readRequestBodyEncodingOptions,
} from "./task-engine-request.cts";
import { redactSecrets, setQueryParamValue } from "./request-wire-utils.cts";
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
import { readResultRule } from "./task-failure-mapping.cts";
import {
  collectRecipeConditionPaths,
  evaluateRecipeCondition,
  isRecipeConditionPathObservable,
  type MatchedConditionPath,
} from "./result-condition-evaluator.cts";
import { hasResultOutputMapping } from "./task-result-output-mapping.cts";
import { maybeRunResultAcquisition } from "./task-result-acquisition.cts";
import { resolveHttpStatusUserMessage } from "./http-status-fallback-messages.cts";
import {
  normalizeString,
  normalizeTaskPolling,
  normalizeTaskRequest,
} from "./task-normalizer.cts";

const { isAllowedTaskUrlForModel } = networkModule;
const { normalizePositiveInt } = utilsModule;

type ResultRuleConditions = {
  failureCondition: unknown;
  successCondition: unknown;
  /** 配方声明的失败原因（用户可读文本）；缺省为 null。 */
  failureReason: string | null;
  hasFailureCondition: boolean;
  hasSuccessCondition: boolean;
};

/**
 * 执行计划里的声明式条件树（`result_rule`）。缺省时轮询完全走既有扁平策略。
 * 注意：读取口径与 HTTP 提交失败路径共用 `readResultRule`，不另建事实源。
 * 返回类型显式声明为 unknown，避免 `Reflect.get` 的 any 顺流到解构处。
 */
const readResultRuleConditions = (record: unknown): ResultRuleConditions => {
  const resultRule = toRecord(readResultRule(record));
  // PlainObject 是显式字段类型，读取动态键走 Reflect.get（与 task-failure-mapping 同口径）。
  const failureCondition: unknown = Reflect.get(resultRule, "failure_condition");
  const successCondition: unknown = Reflect.get(resultRule, "success_condition");
  const failureReason = normalizeString(Reflect.get(resultRule, "failure_reason")) || null;
  return {
    failureCondition,
    successCondition,
    failureReason,
    hasFailureCondition:
      failureCondition !== undefined && failureCondition !== null,
    hasSuccessCondition:
      successCondition !== undefined && successCondition !== null,
  };
};

const CONDITION_VALUE_SUMMARY_MAX_LENGTH = 120;
/** 连续多少轮「条件树引用路径全部不可观测」后告警并落档（诊断用，不改变判定）。 */
const CONDITION_UNSEEN_ATTEMPTS_WARNING_THRESHOLD = 5;
/** 跨过阈值后，每隔多少轮刷新一次用户可见提示（避免每轮都 patch）。 */
const CONDITION_UNSEEN_MESSAGE_REFRESH_INTERVAL = 20;
/** 用户可见提示（文案定稿，逐字使用；由 progress.message 流到任务监视器）。 */
const CONDITION_UNSEEN_USER_MESSAGE =
  "长时间没有匹配到成功判定，请检查这个模型引用的接口配方。";

/**
 * 用户可见提示的写入时机：首次跨过阈值写一次，之后每跨过
 * CONDITION_UNSEEN_MESSAGE_REFRESH_INTERVAL 轮刷新一次。
 * 只决定是否 patch progress.message，不参与任务终态判定。
 */
const shouldRefreshUnseenConditionMessage = (
  consecutiveAttempts: number,
): boolean => {
  if (consecutiveAttempts < CONDITION_UNSEEN_ATTEMPTS_WARNING_THRESHOLD) {
    return false;
  }
  if (consecutiveAttempts === CONDITION_UNSEEN_ATTEMPTS_WARNING_THRESHOLD) {
    return true;
  }
  return (
    (consecutiveAttempts - CONDITION_UNSEEN_ATTEMPTS_WARNING_THRESHOLD) %
      CONDITION_UNSEEN_MESSAGE_REFRESH_INTERVAL ===
    0
  );
};

const summarizeConditionValue = (value: unknown): string => {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      const encoded = JSON.stringify(value);
      text = encoded === undefined ? String(value) : encoded;
    } catch {
      text = String(value);
    }
  }
  return text.length > CONDITION_VALUE_SUMMARY_MAX_LENGTH
    ? `${text.slice(0, CONDITION_VALUE_SUMMARY_MAX_LENGTH - 3)}...`
    : text;
};

const summarizeMatchedPaths = (
  matchedPaths: MatchedConditionPath[],
): Array<{ path: string; value: string }> =>
  matchedPaths.slice(0, 5).map((item) => ({
    path: item.path,
    value: summarizeConditionValue(item.value),
  }));

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
  const failPollingTask = async (
    currentRecord: unknown,
    error: unknown,
    stage: TaskFailureStage | null = null,
  ) => {
    const errorPayload = toRecord(error);
    // 失败阶段只加字段（不重构）：null 表示该失败点不属于已拍板的阶段集合。
    if (stage) errorPayload.stage = stage;
    return await patchTaskRecord(currentRecord, {
      status: TASK_STATUS.FAILED,
      finishedAt: Date.now(),
      error: errorPayload,
      progress: mergeTaskProgressPatch(toRecord(currentRecord).progress, {
        phase: null,
      } as TaskProgressPatch),
    } as PlainObject);
  };
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
    }, "recovery");
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
    }, "recovery");
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
      }, "recovery");
    }
  } catch {
    return failPollingTask(record, {
      code: ERROR_CODES.INVALID_URL,
      message: "Invalid task URL",
    }, "recovery");
  }
  if (!isAllowedTaskUrlForModel(targetUrl, gateModelId)) {
    return failPollingTask(record, {
      code: ERROR_CODES.REMOTE_HOST_NOT_ALLOWED,
      message: "Remote host not allowed",
    }, "recovery");
  }
  // 入口状态写入（failed → polling 的唯一一次写入）。
  // 缺省路径行为不变；重新查询经 `overrides.initialPatch` 一次性带上状态复位
  // （finishedAt / error / response / progress）与新的执行计划，避免「先 patch 再 poll」
  // 产生第二次状态通知。
  const initialPatchRaw = Object.getOwnPropertyDescriptor(overridesValue, "initialPatch");
  const initialPatch = initialPatchRaw !== undefined && isRecord(initialPatchRaw.value)
    ? initialPatchRaw.value
    : null;
  let next = toRecord(
    await patchTaskRecord(record, {
      status: TASK_STATUS.POLLING,
      startedAt: recordValue.startedAt ?? Date.now(),
      error: null,
      ...(initialPatch ?? {}),
    } as PlainObject),
  );
  // 声明式条件树（result_rule）在任务生命周期内不变，进入循环前读一次。
  // 存在任一条件树时，轮询终态判定只由条件树决定，扁平策略不参与（避免两套口径同时生效）。
  const {
    failureCondition,
    successCondition,
    failureReason,
    hasFailureCondition,
    hasSuccessCondition,
  } = readResultRuleConditions(next);
  const hasConditionTree = hasFailureCondition || hasSuccessCondition;
  const conditionReferencedPaths = hasConditionTree
    ? Array.from(
        new Set([
          ...collectRecipeConditionPaths(
            hasFailureCondition ? failureCondition : null,
          ),
          ...collectRecipeConditionPaths(
            hasSuccessCondition ? successCondition : null,
          ),
        ]),
      )
    : [];
  let consecutiveUnseenConditionAttempts = 0;
  let pollingRuleUnmatchedWarningEmitted = false;
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
          }, "recovery");
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
        }, "recovery");
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
  /**
   * 成功证据命中后的收口入口：先执行结果获取（`needs_fetch` 配方），再交既有 finalize。
   *
   * 获取阶段必须在租约释放前运行（json 二次请求需要复用与提交同源的凭证）；它自己决定
   * 是否真的发请求（`binary` 只构造地址）。失败按 spec 收口为正式 failed，不回退轮询。
   */
  const finalizeWithAcquisition = async (currentRecord: PlainObject) => {
    const acquisition = await maybeRunResultAcquisition(currentRecord);
    releasePollingLease();
    if (acquisition.kind === "failed") {
      const failedRecord = toRecord(acquisition.record);
      return await patchTaskRecord(failedRecord, {
        status: TASK_STATUS.FAILED,
        finishedAt: Date.now(),
        error: {
          code: acquisition.code,
          message: acquisition.message,
          stage: "result_acquisition",
        },
        progress: mergeTaskProgressPatch(failedRecord.progress, {
          phase: null,
        } as TaskProgressPatch),
      } as PlainObject);
    }
    return finalizePollingSuccess(
      toRecord(acquisition.kind === "acquired" ? acquisition.record : currentRecord),
    );
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
    // 鉴权注入形态由快照冻结的协议声明（生成 = 接口格式、对话 = 适配器），与提交链路同源，
    // 不得硬编码 Bearer / header 名 / query 名。
    const pollingAuth = snapshotForPolling ? resolveSnapshotAuth(snapshotForPolling) : null;
    let authInjection: AdapterAuthInjection | null = null;
    if (snapshotForPolling && pollingLeaseValue) {
      if (!pollingAuth) {
        loggingModule.logDebug("[task-engine-polling] snapshot protocol unresolved, skip auth injection", {
          snapshotId: snapshotForPolling.snapshot_id,
          taskId: normalizeString(next.id),
        });
      } else {
        authInjection = buildAdapterAuthInjection(pollingAuth, pollingLeaseValue);
        if (authInjection.kind === "header" && !headers.has(authInjection.name)) {
          headers.set(authInjection.name, authInjection.value);
        }
      }
    }
    const body = buildRequestBody(
      activeRequestBody,
      headers,
      readRequestBodyEncodingOptions(activeRequest),
    );
    // 查询参数形态的凭证只拼到本次 fetch 的地址副本上：`targetUrl` 保持无凭证，
    // 供失败日志与后续记录使用（凭证不得落盘/落日志）。
    let attemptUrl = targetUrl;
    if (authInjection?.kind === "query") {
      attemptUrl = new URL(
        setQueryParamValue(targetUrl.toString(), authInjection.name, authInjection.value),
      );
    }
    const redactAttemptSecrets = (text: string): string =>
      redactSecrets(text, [authInjection?.kind === "query" ? authInjection.value : null]);
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
    const attemptStartedAt = Date.now();
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
      const response = await fetch(attemptUrl.toString(), requestInit);
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
      const errorCauseText = getErrorCause(error);
      writePollingErrorLog(
        next,
        attempt,
        targetUrl,
        activeRequestMethod,
        redactAttemptSecrets(String(error)),
        errorCauseText === undefined || errorCauseText === null
          ? null
          : redactAttemptSecrets(String(errorCauseText)),
        false,
      );
      lastFailureMessage = redactAttemptSecrets(String(error));
      lastNetworkClass = classifyNetworkError(error, {
        phase: "polling",
        elapsedMs: Date.now() - attemptStartedAt,
      });
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
              retryable: lastNetworkClass.retryable,
            }
          : {
              code: ERROR_CODES.TASK_EXECUTION_FAILED,
              message: lastFailureMessage,
            }, "polling_request");
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
    const conditionFailureEvaluation =
      hasConditionTree && hasFailureCondition
        ? evaluateRecipeCondition(failureCondition, evaluationBody, responseHeaders)
        : null;
    const conditionSuccessEvaluation =
      hasConditionTree && hasSuccessCondition
        ? evaluateRecipeCondition(successCondition, evaluationBody, responseHeaders)
        : null;
    // 判定顺序（spec docs/model-assets/06-结果判定规则.md）：先失败、再成功、都不命中继续轮询。
    // 存在条件树时扁平失败策略不参与；不存在任何条件树时行为与改造前完全一致。
    const failedByFlatStrategy = !hasConditionTree && failureDetection.failed;
    if (conditionFailureEvaluation?.matched === true || failedByFlatStrategy) {
      // 提示优先级（spec docs/model-assets/06-结果判定规则.md「失败原因来源与回落顺序」）：
      // 配方声明的失败原因 → 既有扁平策略 message → 现存通用文案。
      // 配方原因只在条件树命中时生效：扁平策略判失败时它解释不了那次失败。
      const matchedRecipeReason =
        conditionFailureEvaluation?.matched === true ? failureReason : null;
      lastFailureMessage =
        matchedRecipeReason ?? (failureDetection.message || "Task failed");
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
          // 用户可见摘要优先展示配方原因（界面消费 userMessage 先于 message）；
          // 没有原因时保持既有 HTTP 状态兜底。
          userMessage: matchedRecipeReason ?? resolveHttpStatusUserMessage(responseStatus),
          stage: "remote_failure",
        },
        progress: mergeTaskProgressPatch(next.progress, { phase: null } as TaskProgressPatch),
      } as PlainObject);
    }
    if (!hasConditionTree) {
      const successValue = resolvePollingSuccessValue(polling as PlainObject, evaluationBody, responseHeaders);
      if (
        successValue !== undefined &&
        successValue !== null &&
        successValue !== ""
      ) {
        return finalizeWithAcquisition(next);
      }
    } else if (conditionSuccessEvaluation?.matched === true) {
      // 条件树命中即成功。存在 success_condition 但未命中时**不回落到扁平策略**：
      // 两套口径同时生效会让「配方说还在跑、扁平字段说完成」互相打架。
      return finalizeWithAcquisition(next);
    }
    if (hasConditionTree) {
      // 判定未命中继续轮询：debug 留痕（AGENTS.md 条件跳过必须留痕）。
      const unseenPaths = conditionReferencedPaths.filter(
        (pathText) =>
          !isRecipeConditionPathObservable(evaluationBody, pathText, responseHeaders),
      );
      const allReferencedPathsUnseen =
        conditionReferencedPaths.length > 0 &&
        unseenPaths.length === conditionReferencedPaths.length;
      loggingModule.logDebug(
        "[task-engine] polling condition tree not matched, continue polling",
        {
          taskId: next.id,
          attempt,
          maxAttempts,
          httpStatus: responseStatus,
          hasFailureCondition,
          hasSuccessCondition,
          matchedPaths: summarizeMatchedPaths([
            ...(conditionFailureEvaluation?.matchedPaths ?? []),
            ...(conditionSuccessEvaluation?.matchedPaths ?? []),
          ]),
          unseenPaths: unseenPaths.slice(0, 10),
          allReferencedPathsUnseen,
        },
      );
      if (allReferencedPathsUnseen) {
        consecutiveUnseenConditionAttempts += 1;
        if (
          consecutiveUnseenConditionAttempts >=
            CONDITION_UNSEEN_ATTEMPTS_WARNING_THRESHOLD &&
          !pollingRuleUnmatchedWarningEmitted
        ) {
          pollingRuleUnmatchedWarningEmitted = true;
          loggingModule.logWarn(
            "[task-engine] polling condition tree references paths never observed in body or headers",
            {
              taskId: next.id,
              attempt,
              consecutiveAttempts: consecutiveUnseenConditionAttempts,
              referencedPaths: conditionReferencedPaths.slice(0, 20),
            },
          );
          appendTaskArchiveEventSafely(
            next,
            "task.polling_rule_unmatched",
            {
              phase: "polling",
              attempt,
              consecutiveAttempts: consecutiveUnseenConditionAttempts,
              referencedPaths: conditionReferencedPaths.slice(0, 20),
              hasFailureCondition,
              hasSuccessCondition,
              response: summarizeArchiveResponse(next.response),
            },
            "[task-engine] Failed to write polling_rule_unmatched archive event:",
          );
        }
        // 用户可见半边（2026-10-24 决定：长时间未命中只提示、继续等）：
        // 走 progress.message 流到任务监视器；不清空（成功由状态/阶段覆盖注意力，
        // 失败由 error 优先展示），也不占用 progress.phase 的状态机语义。
        if (shouldRefreshUnseenConditionMessage(consecutiveUnseenConditionAttempts)) {
          next = toRecord(
            await patchTaskRecord(next, {
              progress: mergeTaskProgressPatch(next.progress, {
                message: CONDITION_UNSEEN_USER_MESSAGE,
              } as TaskProgressPatch),
            } as PlainObject),
          );
        }
      } else {
        consecutiveUnseenConditionAttempts = 0;
        pollingRuleUnmatchedWarningEmitted = false;
      }
    } else {
      // 判定未命中继续轮询：debug 留痕（AGENTS.md 条件跳过必须留痕），否则链路断裂不可见。
      loggingModule.logDebug("[task-engine] polling attempt evaluated without terminal judgement", {
        taskId: next.id,
        attempt,
        maxAttempts,
        httpStatus: responseStatus,
        resolvedStatus: failureDetection.status ?? null,
        successEvidencePresent: isSuccessEvidencePresent(polling as PlainObject, evaluationBody),
      });
    }
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
        }, "polling_request");
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
      }, "polling_timeout");
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
      stage: "polling_timeout",
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

/**
 * 解析命中的成功状态值（body 优先、响应头兜底）。
 *
 * 返回实际命中的状态文本而不是 boolean：扁平策略在未声明产物路径时，
 * 用它作为「成功证据」（如 `/v1/videos` 完成态响应本就没有产物地址）。
 */
const resolveMatchingSuccessStatus = (
  polling: PlainObject,
  body: unknown,
  responseHeaders: Headers | null,
): string | undefined => {
  const successStatuses = Array.isArray(polling.successStatuses)
    ? (polling.successStatuses as string[])
    : [];
  if (successStatuses.length === 0) return undefined;
  const statusPaths = Array.isArray(polling.statusFieldPaths)
    ? (polling.statusFieldPaths as string[])
    : [];
  if (statusPaths.length === 0) return undefined;
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
      return valueStr;
    }
  }
  return undefined;
};

const isStatusMatchingSuccess = (
  polling: PlainObject,
  body: unknown,
  responseHeaders: Headers | null,
): boolean => {
  const successStatuses = Array.isArray(polling.successStatuses)
    ? (polling.successStatuses as string[])
    : [];
  // 未声明状态枚举 = 无状态约束（保持既有语义）。
  if (successStatuses.length === 0) return true;
  return resolveMatchingSuccessStatus(polling, body, responseHeaders) !== undefined;
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
  if (successPaths.length === 0) {
    // 扁平策略未声明任何产物路径（无产物约束），证据与状态已命中即成功。
    // 返回命中的状态值本身作为成功证据，语义清晰且不引入 sentinel / 布尔值与既有返回值类型混用。
    return resolveMatchingSuccessStatus(polling, body, responseHeaders);
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

export {
  executePollingTask,
  resolvePollingSuccessValue,
  shouldRefreshUnseenConditionMessage,
};
