/**
 * JSON 路径读取工具
 * - 支持以 "/a/b" 或 "a.b" 形式的路径，也支持简单的 [index] 数组下标
 * - 默认在遇到字符串对象时尝试 JSON.parse 以增加容错性
 */

import type { DynamicRecord } from '@/client/utils/typeGuards';

export interface ReadByPathOptions {
  silent: boolean | undefined;
  parseJsonString: boolean | undefined;
}

const toSegments = (rawPath: string): string[] => {
  if (!rawPath) return [];
  const normalized = rawPath
    .replace(/^\/+/, '')
    .replace(/\[(\w+)\]/g, '.$1');

  return normalized
    .split(/[./]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
};

/**
 * 根据路径读取对象中的值。
 * - path 支持以斜杠或点分隔，例如 "/data/0/id" 或 "data.0.id"
 * - 当遇到字符串时可选地尝试 JSON.parse
 */
export const readValueByPath = (
  source: unknown,
  path: string | undefined,
  options: ReadByPathOptions = { silent: undefined, parseJsonString: undefined }
): unknown => {
  if (!path) return undefined;
  const segments = toSegments(path);
  if (segments.length === 0) return undefined;

  const { silent = false, parseJsonString = true } = options;
  let current: unknown = source;

  if (typeof current === 'string' && parseJsonString) {
    try {
      current = JSON.parse(current);
    } catch (error) {
      if (!silent) {
        console.error('readValueByPath: 无法解析字符串为 JSON', { path, error });
      }
      return undefined;
    }
  }

  for (const segment of segments) {
    if (current == null || typeof current !== 'object') {
      if (!silent) {
        console.error('readValueByPath: 在遍历路径时遇到非对象值', { path, segment, currentValue: current });
      }
      return undefined;
    }
    current = (current as DynamicRecord)[segment];
  }

  return current;
};

export default readValueByPath;
