/**
 * 通用 HTTP 辅助工具
 * - 处理 header 归一化（将 DynamicRecord 转换为 string）
 * - 判断值是否为 FormData 实例
 * - 提供 sleep 函数用于重试等场景
 */

import type { DynamicRecord } from '@/client/utils/typeGuards';

export const normalizeHeaders = (headers: DynamicRecord | undefined): Record<string, string> => {
  if (!headers) return {};
  return Object.entries(headers).reduce<Record<string, string>>((acc, [key, value]) => {
    if (typeof value === 'string') {
      acc[key] = value;
    } else if (value != null) {
      acc[key] = String(value);
    }
    return acc;
  }, {});
};

export const isFormDataLike = (value: unknown): value is FormData => {
  try {
    return typeof FormData !== 'undefined' && value instanceof FormData;
  } catch {
    return false;
  }
};

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

