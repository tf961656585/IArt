import { fetchLocalBackendConfig } from '@/client/api/localConfig';
import { isHubRuntime } from '@/client/utils/hubFetch';

type ExternalPayload = Record<string, unknown>;
type HubErrorBody = ExternalPayload & {
  code: unknown | undefined;
  message: unknown | undefined;
};

export const DEFAULT_EXPAND_INLINE_PARAMS_ON_STARTUP = false;
export const HUB_CANVAS_STARTUP_CONFIG_UNAVAILABLE_ERROR_NAME = 'HubCanvasStartupConfigUnavailableError';
export const HUB_CANVAS_STARTUP_CONFIG_UNAVAILABLE_ERROR_CODE = 'hub_canvas_startup_config_unavailable';
export const HUB_CANVAS_STARTUP_CONFIG_TIMEOUT_MS = 1500;
export const HUB_CANVAS_STARTUP_CONFIG_KEY = 'expandInlineParamsOnStartup';
export const HUB_CANVAS_STARTUP_CONFIG_ENDPOINT = '/api/config';
const DEFAULT_FETCH_TIMEOUT_MS = HUB_CANVAS_STARTUP_CONFIG_TIMEOUT_MS;
const CACHE_TTL_MS = 10_000;

let cachedExpandInlineParamsOnStartup = DEFAULT_EXPAND_INLINE_PARAMS_ON_STARTUP;
let cachedAt = 0;
let hasTrustedCachedExpandInlineParamsOnStartup = false;
let inflight: Promise<boolean> | null = null;
let inflightTimeoutMs: number | null = null;

const normalizeTimeoutMs = (value: unknown, fallback: number): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  if (!ms || ms <= 0) return promise;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new Error('Request timeout')), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timerId) {
      clearTimeout(timerId);
    }
  }
};

const normalizeExpandInlineParamsOnStartup = (value: unknown): boolean => value === true;

const pickNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
};

const resolveExpandInlineParamsOnStartup = (
  payload: Awaited<ReturnType<typeof fetchLocalBackendConfig>> | null | undefined
): boolean | null => {
  const resolved = (payload !== null && payload !== undefined && payload.resolved !== null && payload.resolved !== undefined ? payload.resolved.expandInlineParamsOnStartup : undefined);
  const config = (payload !== null && payload !== undefined && payload.config !== null && payload.config !== undefined ? payload.config.expandInlineParamsOnStartup : undefined);
  const candidate = typeof resolved === 'boolean' ? resolved : config;
  if (typeof candidate !== 'boolean') return null;
  return normalizeExpandInlineParamsOnStartup(candidate);
};

const createHubCanvasStartupConfigUnavailableError = (
  cause: unknown | undefined,
  options: { timeoutMs: number | undefined } | undefined
): Error => {
  const error = new Error('没能读取画布的启动设置，请重新打开项目后重试。');
  error.name = HUB_CANVAS_STARTUP_CONFIG_UNAVAILABLE_ERROR_NAME;
  const causeRecord =
    cause && typeof cause === 'object' && !Array.isArray(cause)
      ? (cause as {
          name: unknown | undefined;
          message: unknown | undefined;
          status: unknown | undefined;
          body: unknown | undefined;
        })
      : null;
  const causeRecordBody = causeRecord === null ? undefined : causeRecord.body;
  const causeRecordStatus = causeRecord === null ? undefined : causeRecord.status;
  const causeRecordName = causeRecord === null ? undefined : causeRecord.name;
  const causeRecordMessage = causeRecord === null ? undefined : causeRecord.message;
  const causeBody =
    causeRecordBody !== undefined &&
    causeRecordBody !== null &&
    typeof causeRecordBody === 'object' &&
    !Array.isArray(causeRecordBody)
      ? (causeRecordBody as HubErrorBody)
      : null;
  const timeoutMsOption = options === undefined ? undefined : options.timeoutMs;
  const status =
    typeof causeRecordStatus === 'number' && Number.isFinite(causeRecordStatus)
      ? causeRecordStatus
      : null;
  const diagnostics = {
    subsource: 'hub_canvas_startup_config',
    errorName: HUB_CANVAS_STARTUP_CONFIG_UNAVAILABLE_ERROR_NAME,
    errorCode: HUB_CANVAS_STARTUP_CONFIG_UNAVAILABLE_ERROR_CODE,
    configKey: HUB_CANVAS_STARTUP_CONFIG_KEY,
    configEndpoint: HUB_CANVAS_STARTUP_CONFIG_ENDPOINT,
    timeoutMs:
      typeof timeoutMsOption === 'number' && Number.isFinite(timeoutMsOption)
        ? timeoutMsOption
        : null,
    causeName: pickNonEmptyString(causeRecordName),
    causeMessage: pickNonEmptyString((causeBody !== null && causeBody !== undefined ? causeBody.message : undefined)) ?? pickNonEmptyString(causeRecordMessage),
    httpStatus: status,
    remoteCode: pickNonEmptyString((causeBody !== null && causeBody !== undefined ? causeBody.code : undefined)),
    remoteMessage: pickNonEmptyString((causeBody !== null && causeBody !== undefined ? causeBody.message : undefined)),
    hint:
      '请确认 Hub 基座的 /api/config 可访问，且 resolved.expandInlineParamsOnStartup 能返回布尔值。',
  };
  Object.assign(error as Error & { code: string | undefined; status: number | undefined; diagnostics: unknown | undefined }, {
    code: HUB_CANVAS_STARTUP_CONFIG_UNAVAILABLE_ERROR_CODE,
    ...(status != null ? { status } : {}),
    diagnostics,
  });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', {
      value: cause,
      configurable: true,
      enumerable: false,
      writable: true,
    });
  }
  return error;
};

const refreshExpandInlineParamsOnStartup = async (timeoutMs: number): Promise<boolean> => {
  try {
    const payload = await withTimeout(fetchLocalBackendConfig(), timeoutMs);
    const nextValue = resolveExpandInlineParamsOnStartup(payload);
    if (typeof nextValue !== 'boolean') {
      throw new Error('expandInlineParamsOnStartup missing');
    }
    cachedExpandInlineParamsOnStartup = nextValue;
    hasTrustedCachedExpandInlineParamsOnStartup = true;
    cachedAt = Date.now();
    return cachedExpandInlineParamsOnStartup;
  } catch (error) {
    if (hasTrustedCachedExpandInlineParamsOnStartup) {
      cachedAt = Date.now();
      return cachedExpandInlineParamsOnStartup;
    }
    throw createHubCanvasStartupConfigUnavailableError(error, { timeoutMs });
  }
};

const ensureRefresh = (timeoutMs: number): Promise<boolean> => {
  if (inflight && (hasTrustedCachedExpandInlineParamsOnStartup || inflightTimeoutMs === timeoutMs)) {
    return inflight;
  }
  const currentPromise = refreshExpandInlineParamsOnStartup(timeoutMs);
  inflight = currentPromise;
  inflightTimeoutMs = timeoutMs;
  void currentPromise
    .finally(() => {
      if (inflight === currentPromise) {
        inflight = null;
        inflightTimeoutMs = null;
      }
    })
    .catch(() => {});
  return currentPromise;
};

export const peekResolvedExpandInlineParamsOnStartup = (): boolean => cachedExpandInlineParamsOnStartup;

export const requireTrustedResolvedExpandInlineParamsOnStartup = (): boolean => {
  if (!isHubRuntime()) {
    return DEFAULT_EXPAND_INLINE_PARAMS_ON_STARTUP;
  }
  if (!hasTrustedCachedExpandInlineParamsOnStartup) {
    throw createHubCanvasStartupConfigUnavailableError(undefined, {
      timeoutMs: HUB_CANVAS_STARTUP_CONFIG_TIMEOUT_MS,
    });
  }
  return cachedExpandInlineParamsOnStartup;
};

export const getResolvedExpandInlineParamsOnStartup = async (options: {
  force: boolean | undefined;
  timeoutMs: number | undefined;
  nonBlocking: boolean | undefined;
} | undefined): Promise<boolean> => {
  if (!isHubRuntime()) {
    return DEFAULT_EXPAND_INLINE_PARAMS_ON_STARTUP;
  }
  const now = Date.now();
  const force = Boolean((options !== null && options !== undefined ? options.force : undefined));
  if (
    hasTrustedCachedExpandInlineParamsOnStartup &&
    !force &&
    now - cachedAt < CACHE_TTL_MS
  ) {
    return cachedExpandInlineParamsOnStartup;
  }
  const requestedTimeoutMs = normalizeTimeoutMs((options !== null && options !== undefined ? options.timeoutMs : undefined), DEFAULT_FETCH_TIMEOUT_MS);
  const timeoutMs = requestedTimeoutMs;

  if ((options !== null && options !== undefined ? options.nonBlocking : undefined)) {
    void ensureRefresh(timeoutMs);
    return cachedExpandInlineParamsOnStartup;
  }

  return ensureRefresh(timeoutMs);
};
