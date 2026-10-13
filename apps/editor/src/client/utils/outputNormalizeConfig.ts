import type { ModelResultExtractor } from '@/features/workspace/modelFormTypes';

import {
  extractMediaUrls,
  extractStringCandidates,
  getDynamicProperty,
  isRawObject,
} from './outputNormalizeExtractors';

type PathToken = string | number;

const tokenizePath = (path: string): PathToken[] => {
  const normalized = path
    .trim()
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  return normalized.map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
};

const hasDynamicProperty = (source: object, key: string): boolean => {
  return Object.prototype.hasOwnProperty.call(source, key);
};

const cloneObjectWithoutKey = (source: object, omittedKey: string): object => {
  const clone = {};
  for (const key of Object.keys(source)) {
    if (key !== omittedKey) {
      Object.defineProperty(clone, key, Object.getOwnPropertyDescriptor(source, key) ?? { value: undefined, enumerable: true });
    }
  }
  return clone;
};

const cloneObjectWithValue = (source: object, changedKey: string, changedValue: unknown): object => {
  const clone = {};
  for (const key of Object.keys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) continue;
    Object.defineProperty(clone, key, key === changedKey ? { ...descriptor, value: changedValue } : descriptor);
  }
  return clone;
};

const removePathImmutable = (
  value: unknown,
  tokens: PathToken[],
  depth = 0
): { nextValue: unknown; changed: boolean } => {
  if (depth >= tokens.length) {
    return { nextValue: value, changed: false };
  }

  if (Array.isArray(value)) {
    const indexToken = tokens[depth];
    if (typeof indexToken !== 'number' || indexToken < 0 || indexToken >= value.length) {
      return { nextValue: value, changed: false };
    }

    if (depth === tokens.length - 1) {
      const clone = value.slice();
      clone.splice(indexToken, 1);
      return { nextValue: clone, changed: true };
    }

    const { nextValue: childValue, changed } = removePathImmutable(value[indexToken], tokens, depth + 1);
    if (!changed) return { nextValue: value, changed: false };

    const clone = value.slice();
    clone[indexToken] = childValue;
    return { nextValue: clone, changed: true };
  }

  if (isRawObject(value)) {
    const token = tokens[depth];
    const key = typeof token === 'string' ? token : typeof token === 'number' ? String(token) : undefined;
    if (!key || !hasDynamicProperty(value, key)) {
      return { nextValue: value, changed: false };
    }

    if (depth === tokens.length - 1) {
      return { nextValue: cloneObjectWithoutKey(value, key), changed: true };
    }

    const currentChild = getDynamicProperty(value, key);
    const { nextValue: childValue, changed } = removePathImmutable(currentChild, tokens, depth + 1);
    if (!changed) return { nextValue: value, changed: false };

    return { nextValue: cloneObjectWithValue(value, key, childValue), changed: true };
  }

  return { nextValue: value, changed: false };
};

const applyExcludePaths = (source: unknown, excludePaths: string[] | undefined): unknown => {
  if (!excludePaths || excludePaths.length === 0) {
    return source;
  }

  let sanitized = source;
  for (const path of excludePaths) {
    if (!path) continue;
    const tokens = tokenizePath(path);
    if (tokens.length === 0) continue;
    const { nextValue } = removePathImmutable(sanitized, tokens);
    sanitized = nextValue;
  }

  return sanitized;
};

export const getValueByPath = (obj: unknown, path: string): unknown | undefined => {
  if (obj == null || typeof path !== 'string' || path.trim().length === 0) {
    return undefined;
  }

  const tokens = tokenizePath(path);
  if (tokens.length === 0) {
    return undefined;
  }

  let current: unknown = obj;

  for (const token of tokens) {
    if (current == null) {
      return undefined;
    }

    if (typeof token === 'number') {
      if (Array.isArray(current)) {
        current = current[token];
      } else if (isRawObject(current)) {
        current = getDynamicProperty(current, String(token));
      } else {
        return undefined;
      }
      continue;
    }

    if (isRawObject(current)) {
      current = getDynamicProperty(current, token);
    } else if (Array.isArray(current)) {
      current = getDynamicProperty(current, token);
    } else {
      return undefined;
    }
  }

  return current ?? undefined;
};

export const extractWithConfig = (
  result: unknown,
  config: ModelResultExtractor | undefined
): { images: string[]; videos: string[] } => {
  if (!config) {
    return extractMediaUrls(result);
  }

  const sanitizedResult = applyExcludePaths(result, config.excludePaths);
  let fallbackMedia: { images: string[]; videos: string[] } | undefined;
  const ensureFallbackMedia = () => {
    if (!fallbackMedia) {
      fallbackMedia = extractMediaUrls(sanitizedResult);
    }
    return fallbackMedia;
  };

  const videos: string[] = [];
  if (Array.isArray(config.videoPaths) && config.videoPaths.length > 0) {
    for (const path of config.videoPaths) {
      const values = extractStringCandidates(getValueByPath(sanitizedResult, path));
      const firstValue = values[0];
      if (firstValue !== undefined) {
        videos.push(firstValue);
        break;
      }
    }
  } else {
    videos.push(...ensureFallbackMedia().videos);
  }

  const images: string[] = [];
  if (Array.isArray(config.imagePaths) && config.imagePaths.length > 0) {
    for (const path of config.imagePaths) {
      const values = extractStringCandidates(getValueByPath(sanitizedResult, path));
      if (values.length > 0) {
        images.push(...values);
      }
    }
  } else {
    images.push(...ensureFallbackMedia().images);
  }

  return {
    images: Array.from(new Set(images)),
    videos: Array.from(new Set(videos)),
  };
};
