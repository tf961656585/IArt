/**
 * 文件作用：统一处理 compat 查询端点的拼装逻辑
 * - 根据 CompatAdapterStatusQuery 构建最终请求 URL
 * - 处理搜索参数追加、绝对/相对路径区分、是否需要 resolveApiEndpoint
 */
import type { CompatAdapterStatusQuery } from '@/client/adapters/types';

const DUMMY_ORIGIN = 'http://status-query.local';

const isAbsoluteUrl = (url: string): boolean => /^https?:\/\//i.test(url);

const appendSearchParams = (
  baseUrl: string,
  searchParams: Record<string, string | number | boolean | null | undefined> | undefined
): string => {
  if (!searchParams || Object.keys(searchParams).length === 0) {
    return baseUrl;
  }
  const url = new URL(baseUrl, isAbsoluteUrl(baseUrl) ? undefined : DUMMY_ORIGIN);
  Object.entries(searchParams).forEach(([key, value]) => {
    if (value === null || value === undefined) return;
    url.searchParams.append(key, String(value));
  });

  if (isAbsoluteUrl(baseUrl)) {
    return url.toString();
  }
  const pathname = url.pathname || '';
  const search = url.search || '';
  return `${pathname}${search}`;
};

export interface ResolvedStatusQueryUrl {
  url: string;
  shouldResolve: boolean;
}

/**
 * 根据 CompatAdapterStatusQuery 生成最终的 URL 及是否需要 resolveApiEndpoint。
 */
export const buildStatusQueryUrl = (query: CompatAdapterStatusQuery): ResolvedStatusQueryUrl => {
  const { endpoint, resolvedEndpoint, searchParams, resolveEndpoint } = query;
  if (!endpoint && !resolvedEndpoint) {
    throw new Error('buildStatusQueryUrl: 缺少 endpoint。');
  }

  const base = resolvedEndpoint ?? endpoint;
  const composed = appendSearchParams(base, searchParams);
  const shouldResolve = resolvedEndpoint ? false : resolveEndpoint !== false;

  return {
    url: composed,
    shouldResolve,
  };
};

export default buildStatusQueryUrl;
