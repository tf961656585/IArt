import { fetchLocalBackendConfig } from '@/client/api/localConfig';
import { isHubRuntime } from '@/client/utils/hubFetch';

export const DEFAULT_MAX_BATCH_TASKS = 30;
const DEFAULT_FETCH_TIMEOUT_MS = 300;

let cachedMaxBatchTasks: number = DEFAULT_MAX_BATCH_TASKS;
let cachedAt = 0;
const CACHE_TTL_MS = 10_000;
let inflight: Promise<number> | null = null;

const normalizePositiveInt = (value: unknown, fallback: number): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

const normalizeTimeoutMs = (value: unknown, fallback: number): number => {
  if (value === 0) return 0;
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

const refreshMaxBatchTasks = async (timeoutMs: number): Promise<number> => {
  try {
    const payload = await withTimeout(fetchLocalBackendConfig(), timeoutMs);
    cachedMaxBatchTasks = normalizePositiveInt(
      (payload !== null && payload !== undefined && payload.resolved !== null && payload.resolved !== undefined ? payload.resolved.maxBatchTasks : undefined),
      DEFAULT_MAX_BATCH_TASKS,
    );
  } catch {
    // ignore
  } finally {
    cachedAt = Date.now();
  }
  return cachedMaxBatchTasks;
};

const ensureRefresh = (timeoutMs: number): Promise<number> => {
  if (inflight) return inflight;
  inflight = refreshMaxBatchTasks(timeoutMs).finally(() => {
    inflight = null;
  });
  return inflight;
};

export const getResolvedMaxBatchTasks = async (options: {
  force: boolean | undefined;
  timeoutMs: number | undefined;
  nonBlocking: boolean | undefined;
} | undefined = undefined): Promise<number> => {
  if (!isHubRuntime()) {
    return DEFAULT_MAX_BATCH_TASKS;
  }
  const now = Date.now();
  const force = Boolean((options !== null && options !== undefined ? options.force : undefined));
  if (!force && now - cachedAt < CACHE_TTL_MS) {
    return cachedMaxBatchTasks;
  }
  const timeoutMs = normalizeTimeoutMs((options !== null && options !== undefined ? options.timeoutMs : undefined), DEFAULT_FETCH_TIMEOUT_MS);

  if ((options !== null && options !== undefined ? options.nonBlocking : undefined)) {
    void ensureRefresh(timeoutMs);
    return cachedMaxBatchTasks;
  }

  return ensureRefresh(timeoutMs);
};
