/**
 * 同步任务缓存里的媒体兼容层。
 * 当前版本不再维护旧前端任务缓存的媒体预取，只保留 sync-cache 仍会触达的兼容接口。
 */

type DynamicObj = Record<string, unknown>;

type LegacyMediaCacheRefView = {
  cacheId: unknown | undefined;
};

type LegacyMediaMarkerView = DynamicObj & {
  __mediaCacheRef__: unknown | undefined;
  __mediaCacheRefs__: unknown | undefined;
};

const isRecord = (value: unknown): value is DynamicObj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isLegacyMediaCacheRefView = (value: unknown): value is LegacyMediaCacheRefView => isRecord(value);

const stripMediaCacheMarkers = (value: unknown, depth = 0): unknown => {
  if (depth > 20) return value;

  if (Array.isArray(value)) {
    return value.map((item) => stripMediaCacheMarkers(item, depth + 1));
  }

  if (!isRecord(value)) {
    return value;
  }

  const next: DynamicObj = {};
  for (const [key, val] of Object.entries(value)) {
    if (key === '__mediaCacheRefs__' || key === '__mediaCacheRef__') {
      continue;
    }
    next[key] = stripMediaCacheMarkers(val, depth + 1);
  }
  return next;
};

const hasMediaCacheMarkers = (value: unknown, depth = 0): boolean => {
  if (depth > 20) return false;
  if (Array.isArray(value)) {
    return value.some((item) => hasMediaCacheMarkers(item, depth + 1));
  }
  if (!isRecord(value)) return false;
  const markerView = value as LegacyMediaMarkerView;
  if (Array.isArray(markerView.__mediaCacheRefs__) && markerView.__mediaCacheRefs__.length > 0) {
    return true;
  }
  const cacheRef = markerView.__mediaCacheRef__;
  if (isLegacyMediaCacheRefView(cacheRef) && typeof cacheRef.cacheId === 'string') {
    return true;
  }
  return Object.values(value).some((child) => hasMediaCacheMarkers(child, depth + 1));
};

export const extractAndCacheInlineMedia = async (
  _taskId: string,
  result: unknown
): Promise<unknown> => {
  // 不做提取与缓存，交由上层 sanitizeForCache 裁剪 base64
  return result;
};

export const restoreInlineMedia = async (result: unknown): Promise<unknown> => {
  // 兼容旧缓存：移除历史 __mediaCacheRef__/__mediaCacheRefs__ 标记
  if (!hasMediaCacheMarkers(result)) {
    return result;
  }
  return stripMediaCacheMarkers(result);
};

export const hasMediaCacheRefs = (result: unknown): boolean => hasMediaCacheMarkers(result);
