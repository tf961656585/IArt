import * as fs from 'node:fs';

import projectRefUtils = require('@iart/utils/project-ref');
const mediaConstants = require('@iart/utils/media-constants') as {
  buildLocalMediaUrl: (projectRef: string | null | undefined, fileKey: string | null | undefined) => string | null;
  buildLocalMediaUrlV2: (stableProjectId: string | null | undefined, fileKey: string | null | undefined) => string | null;
  LOCAL_MEDIA_GLOBAL_REF: string;
};
const stableProjectIdUtils = require('@iart/utils/stable-project-id') as {
  isStableProjectId: (value: unknown) => boolean;
};
import { getProjectFolderPaths, isValidProjectFolder } from './storage.cts';
import { safeJoin } from './safe-path.cts';

type ProjectMediaResolveErrorCode =
  | 'invalid_project_ref'
  | 'project_scope_not_registered'
  | 'invalid_project'
  | 'invalid_file_key'
  | 'media_dir_unavailable'
  | 'file_not_found';

type ProjectMediaResolveFailure = {
  ok: false;
  code: ProjectMediaResolveErrorCode;
  projectRef: string | null;
  fileKey: string | null;
  projectRegistered: boolean;
  mediaDir: string | null;
};

type ProjectMediaResolveSuccess = {
  ok: true;
  projectRef: string;
  projectPath: string;
  fileKey: string;
  mediaDir: string;
  filePath: string;
};

type ProjectMediaResolveResult =
  | ProjectMediaResolveSuccess
  | ProjectMediaResolveFailure;

const { buildProjectRef, isProjectRef, normalizeProjectRef } = projectRefUtils;
const { buildLocalMediaUrl, buildLocalMediaUrlV2, LOCAL_MEDIA_GLOBAL_REF } = mediaConstants;

/**
 * Scope 影子表条目。
 *
 * 由 Desktop Shell ProjectScopeCoordinator 通过 IPC 同步而来，
 * backend 不再自行计算 projectRef/stableProjectId。
 */
type ScopeShadowEntry = {
  stableProjectId: string;
  projectPath: string;
  projectRef: string;
};

/**
 * Scope 影子表（IPC 同步）。
 *
 * 主索引：stableProjectId → ScopeShadowEntry（V2 URL 解析）
 * 反查索引：projectRef → stableProjectId（V1 URL 兼容）
 * 旧索引：projectRef → projectPath（保留，供 resolveRuntimeProjectPathByRef 向后兼容）
 */
const scopeShadowTable = new Map<string, ScopeShadowEntry>();
const refToStableId = new Map<string, string>();
const projectPathByRef = new Map<string, string>();
let globalMediaDir: string | null = null;

const normalizeString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

const normalizeFileKey = (value: unknown) =>
  typeof value === 'string' ? value.trim().replace(/\\/g, '/') : '';

const decodeUrlSegment = (value: unknown) => {
  const normalized = normalizeString(value);
  if (!normalized) return '';
  try {
    return decodeURIComponent(normalized);
  } catch {
    return normalized;
  }
};

const SAFE_FILE_KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

const isSafeProjectMediaFileKey = (value: unknown) => {
  const key = normalizeFileKey(value);
  if (!key || key.includes('\0')) return false;
  if (key.includes('\\')) return false;
  if (key === '.' || key === '..') return false;
  const segments = key.split('/');
  if (segments.length === 0) return false;
  return segments.every((segment) => SAFE_FILE_KEY_SEGMENT.test(segment));
};

/**
 * 接收完整 scope 数据并写入影子表（增量同步，由 ProjectScopeRegisterMessage 触发）。
 *
 * 幂等：重复写入相同 stableProjectId 会更新 projectPath/projectRef 并重建反查索引。
 */
const syncProjectScope = (entry: {
  stableProjectId: string;
  projectPath: string;
  projectRef: string;
}): ScopeShadowEntry | null => {
  const stableProjectId = normalizeString(entry.stableProjectId);
  const projectPath = normalizeString(entry.projectPath);
  const projectRef = normalizeString(entry.projectRef);
  if (!stableProjectId || !projectPath || !projectRef) {
    console.warn("[backend-media-scope] syncProjectScope skipped: invalid entry", { stableProjectId, projectPath: projectPath.slice(-60), projectRef });
    return null;
  }
  const shadow: ScopeShadowEntry = { stableProjectId, projectPath, projectRef };
  scopeShadowTable.set(stableProjectId, shadow);
  refToStableId.set(projectRef, stableProjectId);
  projectPathByRef.set(projectRef, projectPath);
  console.log("[backend-media-scope] syncProjectScope", { stableProjectId, projectRef, projectPath: projectPath.slice(-60) });
  return shadow;
};

/**
 * 全量同步 scope 影子表（由 ProjectScopeSyncMessage 触发，backend 重启后恢复）。
 *
 * 替换式同步：先清空再写入，保证与 coordinator 单一事实源一致。
 */
const syncAllProjectScopes = (
  entries: Array<{ stableProjectId: string; projectPath: string; projectRef: string }>,
): void => {
  scopeShadowTable.clear();
  refToStableId.clear();
  projectPathByRef.clear();
  for (const entry of entries) {
    syncProjectScope(entry);
  }
  console.log("[backend-media-scope] syncAllProjectScopes", { count: scopeShadowTable.size });
};

/**
 * 移除 scope 影子表条目（由 ProjectScopeUnregisterMessage 触发）。
 */
const removeProjectScope = (stableProjectIdInput: unknown): ScopeShadowEntry | null => {
  const stableProjectId = normalizeString(stableProjectIdInput);
  if (!stableProjectIdUtils.isStableProjectId(stableProjectId)) return null;
  const shadow = scopeShadowTable.get(stableProjectId);
  if (shadow === undefined) return null;
  scopeShadowTable.delete(stableProjectId);
  refToStableId.delete(shadow.projectRef);
  projectPathByRef.delete(shadow.projectRef);
  console.log("[backend-media-scope] removeProjectScope", { stableProjectId: shadow.stableProjectId, projectRef: shadow.projectRef });
  return shadow;
};

/**
 * 按 projectRef 查询 stableProjectId（影子表反查）。
 * 旧项目尚未同步到 V2 时返回 null。
 */
const getStableProjectIdByRef = (projectRefInput: unknown): string | null => {
  const projectRef = normalizeString(projectRefInput);
  if (!projectRef || !isProjectRef(projectRef)) return null;
  const stableId = refToStableId.get(projectRef);
  return stableId ?? null;
};

/**
 * 按 projectPath 查询已同步的 scope 影子条目。
 */
const getScopeShadowByPath = (projectPathInput: unknown): ScopeShadowEntry | null => {
  const projectPath = normalizeString(projectPathInput);
  if (!projectPath) return null;
  for (const shadow of scopeShadowTable.values()) {
    if (shadow.projectPath === projectPath) return shadow;
  }
  return null;
};

/**
 * 生成 local-media:// URL，优先 V2（stableProjectId），fallback V1（projectRef）。
 *
 * 优先级：
 * 1. 显式传入的 stableProjectId → buildLocalMediaUrlV2
 * 2. 影子表按 projectRef 反查 stableProjectId → buildLocalMediaUrlV2
 * 3. fallback projectRef → buildLocalMediaUrl（V1，兼容未同步的旧 scope）
 * 4. 两者都无 → null
 *
 * 这是所有 backend URL 生成点的统一入口，消除各处独立判断 stableProjectId 来源的重复。
 */
const resolveLocalMediaUrl = (
  stableProjectIdOrProjectRef: string | null | undefined,
  fileKey: string | null | undefined,
): string | null => {
  const id = normalizeString(stableProjectIdOrProjectRef);
  if (!id) return null;
  // 若传入的就是 stableProjectId，直接 V2
  if (stableProjectIdUtils.isStableProjectId(id)) {
    return buildLocalMediaUrlV2(id, fileKey);
  }
  // 若是 projectRef，先反查 stableProjectId 用 V2，无则 fallback V1
  if (isProjectRef(id)) {
    const stableId = refToStableId.get(id);
    if (stableId !== undefined) {
      return buildLocalMediaUrlV2(stableId, fileKey);
    }
    // fallback V1：影子表未同步该 projectRef 的 stableProjectId。
    // 留痕：正常时序下 refToStableId 应在 scope 注册时同步，若出现 fallback
    // 说明 scope 同步滞后或缺失，可在日志中立即发现（不依赖"碰巧 OK"）。
    console.debug("[backend-media-scope] shadow table miss, fallback to V1 url", {
      projectRef: id.slice(0, 20),
      reason: "stableProjectId not synced for projectRef",
    });
    return buildLocalMediaUrl(id, fileKey);
  }
  // __global__ 等：直接用原值
  return buildLocalMediaUrl(id, fileKey);
};

/**
 * @deprecated 由 syncProjectScope / syncAllProjectScopes 替代。
 * 保留以兼容 task-result-materializer 的 registerRuntimeProjectScope 调用（事务流程内补注册）。
 * 内部从 projectPath 计算 projectRef 后写入影子表（无 stableProjectId，仅 V1 索引）。
 */
const registerRuntimeProjectScope = (projectPath: unknown) => {
  const normalizedProjectPath = normalizeString(projectPath);
  if (!normalizedProjectPath || !isValidProjectFolder(normalizedProjectPath)) {
    console.warn("[backend-media-scope] register skipped: invalid projectPath", { projectPath: typeof projectPath === 'string' ? projectPath.slice(0, 80) : typeof projectPath });
    return null;
  }
  const projectRef = buildProjectRef(normalizedProjectPath);
  if (!projectRef) {
    console.warn("[backend-media-scope] register skipped: buildProjectRef returned null", { projectPath: normalizedProjectPath.slice(0, 80) });
    return null;
  }
  // 若影子表已有该 path 的 V2 条目，直接返回（避免覆盖 stableProjectId）
  const existing = getScopeShadowByPath(normalizedProjectPath);
  if (existing !== null) {
    return { projectRef: existing.projectRef, projectPath: existing.projectPath };
  }
  // 否则写入 V1-only 条目（stableProjectId 待 IPC 同步补全）
  const shadow = syncProjectScope({
    stableProjectId: projectRef, // V1-only 条目用 projectRef 占位 stableProjectId（不合规 V2，但仅作 V1 反查）
    projectPath: normalizedProjectPath,
    projectRef,
  });
  if (shadow === null) return null;
  return { projectRef: shadow.projectRef, projectPath: shadow.projectPath };
};

/**
 * 按 projectPath 解析 projectRef，优先影子表（IPC 同步），fallback buildProjectRef。
 *
 * 用于那些需要 projectRef 作为中间值传递（而非直接生成 URL）的调用点。
 * 影子表有数据时返回同步值（保证与 coordinator 一致），否则 fallback 计算（兼容未同步场景）。
 * 最终 URL 格式由 resolveLocalMediaUrl 统一裁定（反查 stableProjectId 用 V2）。
 */
const resolveProjectRefByPath = (projectPathInput: unknown): string | null => {
  const projectPath = normalizeString(projectPathInput);
  if (!projectPath) return null;
  const shadow = getScopeShadowByPath(projectPath);
  if (shadow !== null) {
    return shadow.projectRef;
  }
  return buildProjectRef(projectPath);
};

const registerGlobalMediaScope = (mediaDirPath: unknown) => {
  const normalizedMediaDir = normalizeString(mediaDirPath);
  if (!normalizedMediaDir) return null;
  globalMediaDir = normalizedMediaDir;
  return { projectRef: LOCAL_MEDIA_GLOBAL_REF, mediaDir: normalizedMediaDir };
};

/**
 * 按 V2 stableProjectId 或 V1 projectRef 解析 projectPath。
 *
 * 解析顺序（索引对称化，闭合「V2 索引建了但读取绕过」矛盾）：
 * 1. 若传入 stableProjectId（spid_），按 scopeShadowTable 主索引查（V2 主路径）。
 * 2. 若传入 projectRef（prj_），先经 refToStableId 反查到 stableProjectId 走 V2 索引，
 *    再 fallback 直接查 projectPathByRef（兼容影子表未同步的旧 scope）。
 */
const resolveRuntimeProjectPathByRef = (projectRefInput: unknown) => {
  const normalizedProjectRef = normalizeProjectRef(projectRefInput);
  if (!normalizedProjectRef) return null;

  // V2 优先：若传入的是 stableProjectId（spid_），按 scopeShadowTable 主索引查
  if (stableProjectIdUtils.isStableProjectId(normalizedProjectRef)) {
    const shadow = resolveRuntimeProjectScopeByStableId(normalizedProjectRef);
    if (shadow !== null) return shadow.projectPath;
    console.debug('[backend-media-scope] resolve miss', {
      kind: 'spid_shadow_missing',
      scope: normalizedProjectRef.slice(0, 40),
    });
    return null;
  }

  // V1：若传入的是 projectRef（prj_），先经 refToStableId 反查走 V2 索引
  if (isProjectRef(normalizedProjectRef)) {
    const stableId = refToStableId.get(normalizedProjectRef);
    if (stableId !== undefined) {
      const shadow = scopeShadowTable.get(stableId) ?? null;
      if (shadow !== null) return shadow.projectPath;
      console.debug('[backend-media-scope] resolve miss', {
        kind: 'prj_stable_shadow_missing',
        projectRef: normalizedProjectRef.slice(0, 40),
        stableId: stableId.slice(0, 40),
      });
    }
    // fallback：直接查 V1 索引（影子表未同步时）
    const fallbackPath = projectPathByRef.get(normalizedProjectRef) ?? null;
    if (fallbackPath === null) {
      console.debug('[backend-media-scope] resolve miss', {
        kind: 'prj_ref_to_stable_missing',
        projectRef: normalizedProjectRef.slice(0, 40),
      });
    }
    return fallbackPath;
  }

  console.debug('[backend-media-scope] resolve miss', {
    kind: 'unknown_scope_format',
    scope: String(normalizedProjectRef).slice(0, 40),
  });
  return null;
};

/**
 * 已注册项目作用域的 projectPath 列表（去重）。
 *
 * 「已打开项目」在 backend 侧的事实源：Desktop Main 在 editor 窗口打开项目时
 * 经 runtime:project-scope-register 同步注册，最后一个窗口关闭时 unregister，
 * backend 重启后经 runtime:project-scope-sync 全量重放。事务流程补注册
 * （registerRuntimeProjectScope）也会进入本表，指向真实用户项目。
 * 消费方：agent 提交作用域裁定（agent-execution）、files-key 首选解析（files-key-resolver）。
 */
const getRegisteredProjectScopePaths = (): string[] =>
  Array.from(
    new Set(
      Array.from(scopeShadowTable.values(), (shadow) => shadow.projectPath),
    ),
  );

/**
 * 按 V2 stableProjectId 解析 scope 影子条目。
 */
const resolveRuntimeProjectScopeByStableId = (
  stableProjectIdInput: unknown,
): ScopeShadowEntry | null => {
  if (!stableProjectIdUtils.isStableProjectId(stableProjectIdInput)) return null;
  return scopeShadowTable.get(stableProjectIdInput as string) ?? null;
};

const resolveProjectMediaFilePath = (
  projectRefInput: unknown,
  fileKeyInput: unknown,
): ProjectMediaResolveResult => {
  const projectRef = normalizeProjectRef(projectRefInput);
  const fileKey = normalizeFileKey(fileKeyInput);

  // __global__ scope: 直接从 globalMediaDir 解析
  if (projectRef === LOCAL_MEDIA_GLOBAL_REF) {
    if (!globalMediaDir) {
      return { ok: false, code: 'project_scope_not_registered', projectRef: LOCAL_MEDIA_GLOBAL_REF, fileKey: fileKey || null, projectRegistered: false, mediaDir: null };
    }
    if (!isSafeProjectMediaFileKey(fileKey)) {
      return { ok: false, code: 'invalid_file_key', projectRef: LOCAL_MEDIA_GLOBAL_REF, fileKey: fileKey || null, projectRegistered: true, mediaDir: globalMediaDir };
    }
    const candidate = safeJoin(globalMediaDir, fileKey);
    if (!candidate || !fs.existsSync(candidate)) {
      return { ok: false, code: 'file_not_found', projectRef: LOCAL_MEDIA_GLOBAL_REF, fileKey, projectRegistered: true, mediaDir: globalMediaDir };
    }
    try {
      if (!fs.statSync(candidate).isFile()) {
        return { ok: false, code: 'file_not_found', projectRef: LOCAL_MEDIA_GLOBAL_REF, fileKey, projectRegistered: true, mediaDir: globalMediaDir };
      }
    } catch {
      return { ok: false, code: 'file_not_found', projectRef: LOCAL_MEDIA_GLOBAL_REF, fileKey, projectRegistered: true, mediaDir: globalMediaDir };
    }
    return { ok: true, projectRef: LOCAL_MEDIA_GLOBAL_REF, projectPath: globalMediaDir, fileKey, mediaDir: globalMediaDir, filePath: candidate };
  }

  if (!projectRef || !isProjectRef(projectRef)) {
    return { ok: false, code: 'invalid_project_ref', projectRef: projectRef || null, fileKey: fileKey || null, projectRegistered: false, mediaDir: null };
  }

  const projectPath = projectPathByRef.get(projectRef) ?? null;
  if (!projectPath) {
    return { ok: false, code: 'project_scope_not_registered', projectRef, fileKey: fileKey || null, projectRegistered: false, mediaDir: null };
  }

  if (!isValidProjectFolder(projectPath)) {
    return { ok: false, code: 'invalid_project', projectRef, fileKey: fileKey || null, projectRegistered: true, mediaDir: null };
  }

  if (!isSafeProjectMediaFileKey(fileKey)) {
    const folderPaths = getProjectFolderPaths(projectPath);
    return { ok: false, code: 'invalid_file_key', projectRef, fileKey: fileKey || null, projectRegistered: true, mediaDir: (folderPaths !== null && folderPaths !== undefined ? folderPaths.media : undefined) ?? null };
  }

  const folderPaths = getProjectFolderPaths(projectPath);
  const mediaDir = (folderPaths !== null && folderPaths !== undefined ? folderPaths.media : undefined) ?? null;
  if (!mediaDir) {
    return { ok: false, code: 'media_dir_unavailable', projectRef, fileKey, projectRegistered: true, mediaDir: null };
  }

  const candidate = safeJoin(mediaDir, fileKey);
  if (!candidate || !fs.existsSync(candidate)) {
    return { ok: false, code: 'file_not_found', projectRef, fileKey, projectRegistered: true, mediaDir };
  }

  try {
    if (!fs.statSync(candidate).isFile()) {
      return { ok: false, code: 'file_not_found', projectRef, fileKey, projectRegistered: true, mediaDir };
    }
  } catch {
    return { ok: false, code: 'file_not_found', projectRef, fileKey, projectRegistered: true, mediaDir };
  }

  return { ok: true, projectRef, projectPath, fileKey, mediaDir, filePath: candidate };
};

const getGlobalMediaDir = () => globalMediaDir;

const clearRuntimeProjectScopesForTest = () => {
  scopeShadowTable.clear();
  refToStableId.clear();
  projectPathByRef.clear();
  globalMediaDir = null;
};

export {
  type ProjectMediaResolveResult,
  type ScopeShadowEntry,
  buildProjectRef,
  clearRuntimeProjectScopesForTest,
  decodeUrlSegment,
  getGlobalMediaDir,
  getRegisteredProjectScopePaths,
  getScopeShadowByPath,
  getStableProjectIdByRef,
  isSafeProjectMediaFileKey,
  registerGlobalMediaScope,
  registerRuntimeProjectScope,
  removeProjectScope,
  resolveLocalMediaUrl,
  resolveProjectMediaFilePath,
  resolveProjectRefByPath,
  resolveRuntimeProjectPathByRef,
  resolveRuntimeProjectScopeByStableId,
  syncAllProjectScopes,
  syncProjectScope,
};
