import { hasLocalHubBaseHint, resolveApiEndpoint } from './apiConfig';
import {
  createHubFetchTargetRuntime,
  type HubFetchFormat,
  type HubFetchTargetResolver,
} from '@iart/backend-sdk/hub-fetch-target-resolver';

const isBrowser = (): boolean => typeof window !== 'undefined';

const isHubRuntimeLocal = (): boolean => {
  if (!isBrowser()) return false;
  const win = window as Window & { electron: unknown | undefined };
  return Boolean(win.electron) || hasLocalHubBaseHint();
};

const runtime = createHubFetchTargetRuntime({
  isBrowser,
  isLocalRuntime: isHubRuntimeLocal,
  resolveApiEndpoint,
  internalPathPrefixes: undefined,
});

const isRemoteHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

const isMediaProxyTarget = (value: string): boolean => {
  if (!value) return false;
  if (value.startsWith('/api/media-proxy?')) return true;
  try {
    const parsed = new URL(value);
    return parsed.pathname === '/api/media-proxy';
  } catch {
    return false;
  }
};

export type { HubFetchFormat, HubFetchTargetResolver };

export const registerHubFetchTargetResolver = runtime.registerHubFetchTargetResolver;
export const resolveHubFetchTarget = runtime.resolveHubFetchTarget;

export const resolveStrictHubFetchTarget = (
  url: string,
  resolverOptions: { format: HubFetchFormat | undefined } | undefined
): string | null => {
  const raw = typeof url === 'string' ? url : String(url ?? '');
  const resolved = runtime.resolveHubFetchTarget(raw, resolverOptions);

  if (isRemoteHttpUrl(raw) && !isMediaProxyTarget(resolved)) {
    return null;
  }

  return resolved;
};
