import { resolveHubFetchTarget } from '@/client/utils/hubFetchTargetResolver';
import { resolveRuntimeUrl } from '@/client/utils/runtimeUrl';

const normalizeUrlForFetch = (url: string): string => {
  if (!url) return url;

  const resolved = resolveHubFetchTarget(url, undefined);
  if (resolved.startsWith('/')) {
    return resolveRuntimeUrl(resolved);
  }
  return resolved;
};

export const fetchFreshJson = async <T = unknown>(url: string, init: RequestInit | undefined = undefined): Promise<T> => {
  if (typeof fetch !== 'function') {
    throw new Error('fetch 不可用，无法读取文档。');
  }

  const response = await fetch(normalizeUrlForFetch(url), { ...init, cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`读取文档失败：${response.status}`);
  }
  return (await response.json()) as T;
};
