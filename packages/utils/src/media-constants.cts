const LOCAL_MEDIA_SCHEME = 'local-media://';
const LOCAL_MEDIA_GLOBAL_REF = '__global__';

/**
 * 构建 V1 local-media URL：local-media://<projectRef>/<fileKey>。
 *
 * @deprecated 新代码应使用 buildLocalMediaUrlV2（基于 stableProjectId）。
 * V1 格式仅保留用于：
 * - 兼容历史已存储的 prj_ URL（协议处理器双格式解析）
 * - __global__ scope（不属于项目 scope）
 * - backend 影子表未同步时的 fallback
 */
const buildLocalMediaUrl = (
  projectRef: string | null | undefined,
  fileKey: string | null | undefined,
): string | null => {
  const ref = typeof projectRef === 'string' && projectRef.trim() ? projectRef.trim() : '';
  const key = typeof fileKey === 'string' && fileKey.trim() ? fileKey.trim() : '';
  if (!ref || !key) return null;
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `${LOCAL_MEDIA_SCHEME}${encodeURIComponent(ref)}/${encodedKey}`;
};

const buildLocalMediaUrlV2 = (
  stableProjectId: string | null | undefined,
  fileKey: string | null | undefined,
): string | null => {
  const id = typeof stableProjectId === 'string' && stableProjectId.trim() ? stableProjectId.trim() : '';
  const key = typeof fileKey === 'string' && fileKey.trim() ? fileKey.trim() : '';
  if (!id || !key) return null;
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `${LOCAL_MEDIA_SCHEME}${encodeURIComponent(id)}/${encodedKey}`;
};

const isLocalMediaUrlV2 = (url: unknown): boolean => {
  if (typeof url !== 'string') return false;
  if (!url.startsWith(LOCAL_MEDIA_SCHEME)) return false;
  const rest = url.slice(LOCAL_MEDIA_SCHEME.length);
  const segments = rest.split('/');
  const firstSegment = segments[0];
  if (firstSegment === undefined) return false;
  const hostname = decodeURIComponent(firstSegment);
  return hostname.startsWith('spid_');
};

export = { LOCAL_MEDIA_SCHEME, LOCAL_MEDIA_GLOBAL_REF, buildLocalMediaUrl, buildLocalMediaUrlV2, isLocalMediaUrlV2 };
