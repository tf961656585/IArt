/**
 * local-media:// URL 的解析与 fileKey 提取 — 单一事实源。
 *
 * 本模块是所有从 `local-media://` URL 反向提取 scope/fileKey 的唯一合法入口。
 * 禁止在其他位置内联 slice/split/indexOf 解析 local-media URL，
 * 禁止内联 `isProjectRef(...) || ... === __global__` 重建 scope 识别谓词。
 *
 * 守卫：tooling/scripts/guard-local-media-url-resolution.mjs。
 */

const projectRefModule = require('./project-ref.cjs') as { isProjectRef: (value: unknown) => boolean };
const { isProjectRef } = projectRefModule;

const stableProjectIdModule = require('./stable-project-id.cjs') as { isStableProjectId: (value: unknown) => boolean };
const { isStableProjectId } = stableProjectIdModule;

const mediaConstantsModule = require('./media-constants.cjs') as { LOCAL_MEDIA_GLOBAL_REF: string };
const { LOCAL_MEDIA_GLOBAL_REF } = mediaConstantsModule;

const LOCAL_MEDIA_SCHEME = 'local-media://';

const tryDecode = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

/**
 * isLocalMediaScope — scope 识别单一事实源。
 *
 * 识别 local-media:// URL 中的 scope 段（hostname）是否合法。
 * 合法 scope = stableProjectId（V2, spid_）/ projectRef（V1, prj_）/ __global__。
 *
 * 所有解析点必须复用本谓词，禁止内联组合 isProjectRef/isStableProjectId/__global__。
 */
const isLocalMediaScope = (value: string): boolean =>
  isProjectRef(value) || isStableProjectId(value) || value === LOCAL_MEDIA_GLOBAL_REF;

/**
 * parseLocalMediaUrl — local-media:// URL 解析单一入口。
 *
 * 解析 `local-media://{scope}/{fileKey}` 或 `local-media://{fileKey}`（无 scope）。
 * 所有从 local-media:// URL 反向提取 scope/fileKey 的代码必须复用本函数。
 *
 * 返回 `{ scope, fileKey }`：
 * - scope: 合法 scope 字符串，或 null（URL 形如 `local-media://{fileKey}` 无 scope 段，
 *   或第一段不是合法 scope 视为整个 raw 是 fileKey）。
 * - fileKey: 永远是去掉 scheme 与 scope 段后的 fileKey（已 decodeURIComponent）。
 *
 * 覆盖所有历史 URL 形态：V1（prj_）、V2（spid_）、global（__global__）、无 scope 纯 fileKey。
 */
const parseLocalMediaUrl = (sourceUrl: string): { scope: string | null; fileKey: string } | null => {
  if (typeof sourceUrl !== 'string') return null;
  const trimmed = sourceUrl.trim();
  if (!trimmed || !trimmed.startsWith(LOCAL_MEDIA_SCHEME)) return null;

  const raw = trimmed.slice(LOCAL_MEDIA_SCHEME.length);
  if (!raw) return null;
  const slashIndex = raw.indexOf('/');
  if (slashIndex < 0) {
    // 无 scope 段：local-media://{fileKey}
    return { scope: null, fileKey: tryDecode(raw) };
  }
  const firstSegment = raw.slice(0, slashIndex);
  const rest = raw.slice(slashIndex + 1);
  if (!rest) return null;
  if (isLocalMediaScope(firstSegment)) {
    return { scope: firstSegment, fileKey: tryDecode(rest) };
  }
  // 第一段不是合法 scope，视为整个 raw 是 fileKey（兼容 local-media://{fileKey/with/slash}）
  return { scope: null, fileKey: tryDecode(raw) };
};

/**
 * extractMediaFileKey — 从 local-media:// URL 中提取 fileKey（thin wrapper）。
 *
 * 保持外部签名不变，下游零改动即可获得 V2 支持。
 * 内部统一委托 parseLocalMediaUrl。
 */
const extractMediaFileKey = (sourceUrl: string): string | null => {
  const parsed = parseLocalMediaUrl(sourceUrl);
  if (parsed === null) return null;
  return parsed.fileKey;
};

/**
 * extractContentHashFromFileKey — fileKey（`<contentHash>.<ext>`）剥扩展名取内容 sha256。
 *
 * 导入写盘与运行域媒体下载均以内容 sha256 命名 fileKey（扩展名来自 MIME/原始名），
 * fileKey 的去扩展名部分即内容指纹——它是「同内容等价类」判据的解析入口
 * （唯一文档事实源：storage-schema.md「资产 id 派生规则」）。
 * 无扩展名段（非内容指纹命名形态）返回 null，由调用方按不可解析处理。
 */
const extractContentHashFromFileKey = (fileKey: string): string | null => {
  if (typeof fileKey !== 'string') return null;
  const dotIndex = fileKey.lastIndexOf('.');
  if (dotIndex <= 0) return null;
  const hash = fileKey.slice(0, dotIndex);
  return hash.length > 0 ? hash : null;
};

export = { extractMediaFileKey, extractContentHashFromFileKey, isLocalMediaScope, parseLocalMediaUrl };
