import { hasLocalHubBaseHint } from './apiConfig';
import { resolveHubFetchTarget } from './hubFetchTargetResolver';

const isBrowser = (): boolean => typeof window !== 'undefined';

export const isHubRuntime = (): boolean => {
  if (!isBrowser()) return false;
  const win = window as Window & { electron: unknown | undefined };
  return Boolean(win.electron) || hasLocalHubBaseHint();
};

export const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

const createAbortSignal = (
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined
): { signal: AbortSignal | undefined; cleanup: (() => void) | undefined } => {
  if (!timeoutMs && !signal) {
    return { signal: undefined, cleanup: undefined };
  }

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let aborted = false;

  const abort = () => {
    if (aborted) return;
    aborted = true;
    controller.abort();
  };

  if (signal) {
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener('abort', abort, { once: true });
    }
  }

  if (timeoutMs && timeoutMs > 0) {
    timeoutId = setTimeout(abort, timeoutMs);
  }

  const cleanup = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (signal) {
      signal.removeEventListener('abort', abort);
    }
  };

  return { signal: controller.signal, cleanup };
};

export interface FetchBlobOptions {
  signal: AbortSignal | undefined;
  timeoutMs: number | undefined;
  cache: RequestCache | undefined;
}

export const fetchBlobWithHub = async (
  url: string,
  options: FetchBlobOptions | undefined = undefined
): Promise<{ blob: Blob; mimeType: string | undefined; response: Response }> => {
  const target = isHubRuntime() ? resolveHubFetchTarget(url, { format: 'blob' }) : url;
  const signalOption = options !== null && options !== undefined ? options.signal : undefined;
  const timeoutMsOption = options !== null && options !== undefined ? options.timeoutMs : undefined;
  const cacheOption = options !== null && options !== undefined ? options.cache : undefined;
  const { signal, cleanup } = createAbortSignal(signalOption, timeoutMsOption);
  try {
    const response = await fetch(target, {
      ...(signal ? { signal } : {}),
      ...(cacheOption ? { cache: cacheOption } : {}),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const mimeType = response.headers.get('content-type') ?? blob.type ?? undefined;
    return { blob, mimeType, response };
  } finally {
    if (cleanup !== undefined) {
      cleanup();
    }
  }
};
