import {
  buildAdapterAuthInjection,
  ExecutionSnapshotSchema,
  type AdapterAuthInjection,
  type ExecutionSnapshot,
} from '@iart/contracts';
import * as loggingModule from './logging.cts';
import * as networkModule from './network.cts';
import { resolveSnapshotAuth } from './provider-connection/snapshot-protocol.cts';
import {
  acquireLease,
  getLease,
  readCredentialValue,
  releaseLease,
} from './provider-connection/credential-store.cts';
import { getFetchDispatcher } from './fetch-dispatcher.cts';
import { appendTaskArchiveEventSafely } from './task-engine-archive.cts';
import { readValueByPath } from './task-engine-polling-utils.cts';
import { patchTaskRecord } from './task-engine-state.cts';
import { normalizeFixedHeaders, redactSecrets, replaceUrlTemplatePlaceholders, setQueryParamValue } from './request-wire-utils.cts';
import {
  ERROR_CODES,
  isRecord,
  toRecord,
  type PlainObject,
} from './task-engine-shared.cts';
import type { JsonObject, JsonValue } from './model-package-catalog.types.cts';
import { resolveHttpStatusUserMessage } from './http-status-fallback-messages.cts';

const { isAllowedTaskUrlForModel } = networkModule;

/**
 * 结果获取（Result Acquisition）执行段（`docs/model-assets/08-异步最终结果获取策略.md`）。
 *
 * 触发条件：任务执行计划声明了 `result_acquisition_strategy`（接口配方的 `needs_fetch`）。
 * 轮询命中成功证据后、`finalizePollingSuccess` 之前调用；一旦进入本阶段不得回退轮询。
 *
 * 两种 `accept` 的落点（与配方合入侧 `interface-recipe-apply.cts` 对齐）：
 * - `json`：真的发起第二次 GET，把取回的结构化响应覆盖写入 `taskRecord.response.body`，
 *   随后沿用既有 `result_output_mapping`（配方 `after` 已生成规则）；
 * - `binary`：**不在本阶段下载字节**，只把内容地址写到保留路径
 *   `__acquired_media_url`，由既有 `downloadRemoteMediaToFiles` 完成字节获取、鉴权、落盘与
 *   资产绑定（复用已验证主链）。配方合入侧把输出映射指向同一保留路径。
 *
 * 远端请求口径：GET、不设超时、不自动重试（AGENTS.md「远端请求与项目内接口不设超时」/
 * `docs/runtime/远端请求执行治理原则.md`）。
 */

/**
 * `accept = binary` 时写入响应体的保留路径。
 * 与 `interface-recipe-apply.cts` 的 `ACQUIRED_MEDIA_URL_PATH` 必须一致（输出映射指向它）。
 */
const ACQUIRED_MEDIA_URL_PATH = '__acquired_media_url';

const ACQUISITION_MODE = 'fetch_final_result';

type AcquisitionFailure = {
  code: string;
  message: string;
};

type AcquisitionAuthResult =
  | { ok: true; injection: AdapterAuthInjection | null }
  | { ok: false; failure: AcquisitionFailure };

const normalizeString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

const readReflectField = (value: unknown, key: string): unknown => {
  if (value === null || typeof value !== 'object') return undefined;
  return Reflect.get(value, key);
};

const MAX_JSON_DEPTH = 64;

/**
 * 结构化响应体的 JSON 值守卫（binary 路径合并原响应体时使用）。
 *
 * 上游响应体来自 `JSON.parse`，正常必然是 JSON 值；这里做一次结构收窄，避免把不可序列化
 * 的值带进任务记录。
 */
const isJsonValue = (value: unknown, depth = 0): value is JsonValue => {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.every((item) => item !== undefined && isJsonValue(item, depth + 1));
  if (typeof value === 'object') {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value).every((item) => item === undefined || isJsonValue(item, depth + 1));
  }
  return false;
};

/** 从任务 metadata 读取冻结的 ExecutionSnapshot（与轮询引擎同一读取口径）。 */
const readExecutionSnapshot = (metadata: PlainObject): ExecutionSnapshot | null => {
  const candidate = readReflectField(metadata, 'executionSnapshot') ?? readReflectField(metadata, 'execution_snapshot');
  if (candidate === undefined || candidate === null || typeof candidate !== 'object') return null;
  const parsed = ExecutionSnapshotSchema.safeParse(candidate);
  if (!parsed.success) {
    loggingModule.logDebug('[task-result-acquisition] invalid executionSnapshot in metadata, ignore', {
      error: parsed.error.message,
    });
    return null;
  }
  return parsed.data;
};

const readIdentityPathCandidates = (identityPath: unknown): string[] => {
  if (typeof identityPath === 'string') {
    const trimmed = identityPath.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(identityPath)) {
    return identityPath
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0);
  }
  return [];
};

/**
 * 提交响应的可用存放点。
 *
 * 轮询开始后 `taskRecord.response` 已被轮询响应覆盖，提交响应不在其中；当前正式链路没有把
 * 提交响应持久化到 metadata（白名单也没有该键），因此这里只探测既有实现可能留下的载体。
 * 取不到时按 spec「identity 未命中即收口失败」处理，不回落轮询。
 */
const readSubmitResponseBody = (record: PlainObject, metadata: PlainObject): unknown => {
  const fromMetadata = readReflectField(metadata, 'submitResponse') ?? readReflectField(metadata, 'submitResponseBody');
  if (fromMetadata !== undefined && fromMetadata !== null) {
    const asRecord = toRecord(fromMetadata);
    return readReflectField(asRecord, 'body') ?? fromMetadata;
  }
  const fromRecord = readReflectField(record, 'submitResponse');
  if (fromRecord !== undefined && fromRecord !== null) {
    const asRecord = toRecord(fromRecord);
    return readReflectField(asRecord, 'body') ?? fromRecord;
  }
  return undefined;
};

const resolveIdentity = (params: {
  identitySource: string;
  identityPath: unknown;
  record: PlainObject;
  metadata: PlainObject;
}): string | null => {
  const { identitySource, identityPath, record, metadata } = params;
  if (identitySource === 'remote_request_id') {
    const value = normalizeString(
      readReflectField(metadata, 'remoteRequestId') ?? readReflectField(metadata, 'remote_request_id'),
    );
    return value || null;
  }
  const paths = readIdentityPathCandidates(identityPath);
  if (paths.length === 0) return null;

  if (identitySource === 'query_response_path') {
    const body = readReflectField(toRecord(record.response), 'body');
    for (const path of paths) {
      const value = normalizeString(readValueByPath(body, path, { silent: true, parseJsonString: undefined } as Parameters<typeof readValueByPath>[2]));
      if (value) return value;
    }
    return null;
  }

  if (identitySource === 'submit_response_path') {
    const body = readSubmitResponseBody(record, metadata);
    for (const path of paths) {
      const value = normalizeString(readValueByPath(body, path, { silent: true, parseJsonString: undefined } as Parameters<typeof readValueByPath>[2]));
      if (value) return value;
    }
    return null;
  }

  return null;
};

/**
 * 地址模板 → 最终 URL。
 *
 * `{id}` 在路径段原样替换（不 encode）：标识可能是路径形态（如 `models/x/operations/y`），
 * 整体编码会破坏上游要求的层级；在查询串里则完整 `encodeURIComponent`（结构字符不得生效）。
 * 相对模板以快照 base_url 补齐，最后兜底任务请求的 origin。
 */
const buildContentUrl = (params: {
  template: string;
  identity: string;
  snapshot: ExecutionSnapshot | null;
  record: PlainObject;
}): { ok: true; url: URL } | { ok: false; message: string } => {
  const replaced = replaceUrlTemplatePlaceholders(params.template, { id: params.identity });
  try {
    if (/^https?:\/\//i.test(replaced)) {
      return { ok: true, url: new URL(replaced) };
    }
    if (params.snapshot) {
      const base = params.snapshot.base_url.replace(/\/+$/, '');
      return { ok: true, url: new URL(`${base}${replaced.startsWith('/') ? replaced : `/${replaced}`}`) };
    }
    const requestUrl = normalizeString(readReflectField(toRecord(params.record.request), 'url'));
    if (requestUrl) {
      return { ok: true, url: new URL(replaced, requestUrl) };
    }
  } catch {
    return { ok: false, message: '结果获取地址无效，请检查内容地址模板' };
  }
  return { ok: false, message: '结果获取地址无效，请检查内容地址模板' };
};

const resolveModelId = (metadata: PlainObject): string =>
  normalizeString(readReflectField(metadata, 'modelId') ?? readReflectField(metadata, 'model_id'));

/**
 * 解析与提交同源的鉴权头。
 *
 * 凭证读取只走 credential-store：优先复用轮询仍持有的租约（metadata.credentialLeaseId），
 * 否则按快照参数 acquire 一个新租约并在请求结束后释放。明文只在本函数栈内参与请求头构造，
 * 不写任务记录、不进日志。
 */
const resolveAuthHeader = async (params: {
  requiresAuth: boolean;
  snapshot: ExecutionSnapshot | null;
  metadata: PlainObject;
  modelId: string;
}): Promise<AcquisitionAuthResult> => {
  if (!params.requiresAuth) return { ok: true, injection: null };
  const snapshot = params.snapshot;
  if (!snapshot) {
    loggingModule.logDebug('[task-result-acquisition] requires_auth but execution snapshot missing', {
      modelId: params.modelId,
    });
    return {
      ok: false,
      failure: {
        code: 'credential_missing',
        message: '结果地址需要鉴权，但任务缺少可用的接入信息，请重新提交任务',
      },
    };
  }
  if (!snapshot.credential_ref) {
    loggingModule.logDebug('[task-result-acquisition] requires_auth but credential_ref missing', {
      modelId: params.modelId,
      connectionId: snapshot.connection_id,
    });
    return {
      ok: false,
      failure: {
        code: 'credential_missing',
        message: '结果地址需要鉴权，但这条连接没有可用凭证，请先在设置里补充 API Key 后重新提交任务',
      },
    };
  }
  const auth = resolveSnapshotAuth(snapshot);
  if (!auth) {
    loggingModule.logDebug('[task-result-acquisition] requires_auth but protocol unresolved', {
      snapshotId: snapshot.snapshot_id,
      modelId: params.modelId,
    });
    return {
      ok: false,
      failure: {
        code: 'credential_missing',
        message: '结果地址需要鉴权，但认不出这个模型使用的接口格式，请重新提交任务',
      },
    };
  }

  const existingLeaseId = normalizeString(readReflectField(params.metadata, 'credentialLeaseId'));
  let credentialValue: string | null = null;
  let ownedLeaseId: string | null = null;
  try {
    if (existingLeaseId && getLease(existingLeaseId)) {
      credentialValue = await readCredentialValue(snapshot.credential_ref);
    } else {
      const lease = await acquireLease({
        connectionId: snapshot.connection_id,
        credentialRef: snapshot.credential_ref,
        credentialVersion: snapshot.credential_version ?? 0,
        connectionRevision: snapshot.connection_revision,
      });
      if (lease) {
        credentialValue = lease.value;
        ownedLeaseId = lease.lease.leaseId;
      }
    }
    if (!credentialValue) {
      loggingModule.logDebug('[task-result-acquisition] requires_auth but credential unreadable', {
        connectionId: snapshot.connection_id,
        hasLease: Boolean(existingLeaseId),
      });
      return {
        ok: false,
        failure: {
          code: 'credential_missing',
          message: '结果地址需要鉴权，但没能读取到这条连接的凭证，请检查设置后重新提交任务',
        },
      };
    }
    return { ok: true, injection: buildAdapterAuthInjection(auth, credentialValue) };
  } finally {
    if (ownedLeaseId) {
      try {
        releaseLease(ownedLeaseId);
      } catch { void 0; }
    }
  }
};

type ResultAcquisitionOutcome =
  | { kind: 'not_applicable' }
  | { kind: 'acquired'; record: unknown }
  | { kind: 'failed'; record: unknown; code: string; message: string };

const failAcquisition = (
  record: unknown,
  code: string,
  message: string,
): ResultAcquisitionOutcome => ({
  kind: 'failed',
  record,
  code,
  message,
});

/**
 * 执行结果获取阶段。
 *
 * - 无获取声明 → `not_applicable`（调用方按原行为 finalize）；
 * - 取到结果 → `acquired`（返回已写回响应体的记录）；
 * - 任一环节失败 → `failed`（返回原记录与错误码，由调用方收口为正式 failed）。
 */
const maybeRunResultAcquisition = async (
  taskRecord: unknown,
): Promise<ResultAcquisitionOutcome> => {
  const record = toRecord(taskRecord);
  const metadata = toRecord(record.metadata);
  const plan = toRecord(readReflectField(metadata, 'taskExecutionPlan'));
  const strategy = toRecord(readReflectField(plan, 'result_acquisition_strategy'));
  if (Object.keys(strategy).length === 0) {
    return { kind: 'not_applicable' };
  }

  const acquisitionMode = normalizeString(readReflectField(strategy, 'acquisition_mode'));
  if (acquisitionMode !== ACQUISITION_MODE) {
    loggingModule.logDebug('[task-result-acquisition] unsupported acquisition_mode, skip', {
      taskId: normalizeString(readReflectField(record, 'id') ?? readReflectField(record, 'taskId')),
      acquisitionMode,
    });
    return { kind: 'not_applicable' };
  }

  const taskId = normalizeString(readReflectField(record, 'id') ?? readReflectField(record, 'taskId'));
  const requestStrategy = toRecord(readReflectField(strategy, 'request_strategy'));
  const template = normalizeString(readReflectField(requestStrategy, 'endpoint'));
  const method = normalizeString(readReflectField(requestStrategy, 'method')).toUpperCase();
  if (!template) {
    loggingModule.logDebug('[task-result-acquisition] acquisition request template missing', { taskId });
    return failAcquisition(record, ERROR_CODES.TASK_EXECUTION_FAILED, '结果获取缺少内容地址，无法继续');
  }
  if (method !== 'GET') {
    loggingModule.logDebug('[task-result-acquisition] acquisition request method not GET', { taskId, method });
    return failAcquisition(record, ERROR_CODES.TASK_EXECUTION_FAILED, '结果获取只支持 GET 请求，请检查接口配方');
  }

  const identitySource = normalizeString(readReflectField(strategy, 'identity_source'));
  const identityPath = readReflectField(strategy, 'identity_path');
  const identity = resolveIdentity({
    identitySource,
    identityPath,
    record,
    metadata,
  });
  if (!identity) {
    loggingModule.logDebug('[task-result-acquisition] identity not found', {
      taskId,
      identitySource,
      identityPath,
    });
    return failAcquisition(
      record,
      ERROR_CODES.TASK_EXECUTION_FAILED,
      '结果获取失败：没能从任务信息里取到内容标识',
    );
  }

  const snapshot = readExecutionSnapshot(metadata);
  const modelId = resolveModelId(metadata);
  const built = buildContentUrl({ template, identity, snapshot, record });
  if (!built.ok) {
    loggingModule.logDebug('[task-result-acquisition] invalid content url', { taskId, template });
    return failAcquisition(record, ERROR_CODES.INVALID_URL, built.message);
  }
  const contentUrl = built.url;
  if (!isAllowedTaskUrlForModel(contentUrl, modelId)) {
    loggingModule.logDebug('[task-result-acquisition] content url host not allowed', {
      taskId,
      url: contentUrl.toString(),
    });
    return failAcquisition(record, ERROR_CODES.REMOTE_HOST_NOT_ALLOWED, '结果地址不在已配置的服务商地址内，请检查连接配置');
  }

  const acceptMode = normalizeString(readReflectField(strategy, 'accept')) || 'json';

  if (acceptMode === 'binary') {
    const mediaType = normalizeString(readReflectField(strategy, 'media_type'));
    const existingResponse = toRecord(record.response);
    const existingBody = readReflectField(existingResponse, 'body');
    const nextBody: JsonObject = {};
    if (isRecord(existingBody)) {
      for (const [key, value] of Object.entries(existingBody)) {
        if (isJsonValue(value)) nextBody[key] = value;
      }
    }
    nextBody[ACQUIRED_MEDIA_URL_PATH] = contentUrl.toString();
    const nextRecord = await patchTaskRecord(record, {
      response: { ...existingResponse, body: nextBody },
    } as PlainObject);
    appendTaskArchiveEventSafely(
      nextRecord,
      'task.result_acquired',
      {
        phase: 'result_acquired',
        accept: 'binary',
        mediaType: mediaType || null,
        contentUrl: contentUrl.toString(),
      },
      '[task-result-acquisition] Failed to write result_acquired archive event:',
    );
    return { kind: 'acquired', record: nextRecord };
  }

  const requiresAuth = readReflectField(strategy, 'requires_auth') === true;
  const auth = await resolveAuthHeader({ requiresAuth, snapshot, metadata, modelId });
  if (!auth.ok) {
    return failAcquisition(record, auth.failure.code, auth.failure.message);
  }

  const headers = new Headers();
  try {
    // 结果获取请求的固定请求头（由格式的 `api.headers.*` 字面量随策略冻结）。
    const fixedHeaders = normalizeFixedHeaders(
      readReflectField(strategy, 'request_headers'),
      'result acquisition request',
    );
    for (const [name, value] of Object.entries(fixedHeaders)) {
      headers.set(name, value);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    loggingModule.logDebug('[task-result-acquisition] invalid request_headers declaration', { taskId, message });
    return failAcquisition(record, ERROR_CODES.TASK_EXECUTION_FAILED, '结果获取请求头无效，请检查接口配方的固定请求头');
  }
  // 鉴权头优先于固定头（写入侧已禁止固定头声明 authorization，这里是防御性顺序）。
  if (auth.injection?.kind === 'header') {
    headers.set(auth.injection.name, auth.injection.value);
  }
  // 查询参数凭证只拼到本次 fetch 的地址副本上：contentUrl 保持无凭证（会写入
  // `__acquired_media_url` 与归档事件，下载链路在 fetch 时另行注入）。
  let fetchUrl = contentUrl;
  if (auth.injection?.kind === 'query') {
    fetchUrl = new URL(
      setQueryParamValue(contentUrl.toString(), auth.injection.name, auth.injection.value),
    );
  }
  const authSecret = auth.injection?.kind === 'query' ? auth.injection.value : null;

  let responseStatus = 0;
  let buffer: Buffer;
  try {
    const requestInit: RequestInit = { method: 'GET', headers };
    Object.assign(requestInit as PlainObject, { dispatcher: getFetchDispatcher() });
    const response = await fetch(fetchUrl.toString(), requestInit);
    responseStatus = response.status;
    buffer = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      loggingModule.logWarn('[task-result-acquisition] final result request failed', {
        taskId,
        url: contentUrl.toString(),
        status: response.status,
      });
      return failAcquisition(
        record,
        ERROR_CODES.TASK_EXECUTION_FAILED,
        `结果获取请求失败（HTTP ${response.status || 0}）${resolveHttpStatusUserMessage(response.status) ? `：${resolveHttpStatusUserMessage(response.status)}` : ''}`,
      );
    }
  } catch (error) {
    loggingModule.logWarn('[task-result-acquisition] final result request error', {
      taskId,
      url: contentUrl.toString(),
      error: redactSecrets(error instanceof Error ? error.message : String(error), [authSecret]),
    });
    return failAcquisition(record, ERROR_CODES.TASK_EXECUTION_FAILED, '结果获取请求没有完成，请检查网络后重新提交任务');
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(buffer.toString('utf-8'));
  } catch {
    loggingModule.logDebug('[task-result-acquisition] final result body is not valid JSON', {
      taskId,
      url: contentUrl.toString(),
    });
    return failAcquisition(record, ERROR_CODES.INVALID_JSON, '结果获取失败：返回内容不是有效的结构化数据');
  }

  const existingResponse = toRecord(record.response);
  const nextRecord = await patchTaskRecord(record, {
    response: { ...existingResponse, body: parsedBody, bodyType: 'json' },
  } as PlainObject);
  appendTaskArchiveEventSafely(
    nextRecord,
    'task.result_acquired',
    {
      phase: 'result_acquired',
      accept: 'json',
      httpStatus: responseStatus,
    },
    '[task-result-acquisition] Failed to write result_acquired archive event:',
  );
  return { kind: 'acquired', record: nextRecord };
};

export {
  ACQUIRED_MEDIA_URL_PATH,
  maybeRunResultAcquisition,
  type ResultAcquisitionOutcome,
};
