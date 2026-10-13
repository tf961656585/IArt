/**
 * Project Scope Coordinator
 *
 * Desktop Shell 侧 local-media:// scope 的唯一权威注册中心。
 *
 * 取代历史双注册架构：
 * - 旧：desktop-shell-runtime 的 registeredProjectScopes Set + editor-storage-local-media 的 mediaDirRegistry Map
 * - 新：本 coordinator 作为单一事实源，backend 影子表通过 IPC 同步
 *
 * 三索引设计：
 * - scopesByStableId: stableProjectId → ScopeEntry（主索引，V2 URL 解析）
 * - scopesByPath: projectPath → stableProjectId（路径反查，registerScope 幂等）
 * - refToStableId: projectRef → stableProjectId（旧 V1 URL 兼容反查）
 *
 * Session 引用计数：
 * - 多窗口可打开同一项目，每窗口 attach 一个 session
 * - 只有所有 session detach 后，scope 才可注销（detachedScopeEntry 保留供协议处理器解析已持久化的媒体）
 */

import * as path from 'node:path';
import projectRefUtils = require('@iart/utils/project-ref');
const stableProjectIdUtils = require('@iart/utils/stable-project-id') as {
  isStableProjectId: (value: unknown) => boolean;
};
import { ensureStableProjectId } from './storage/stable-project-id-resolver.cjs';

const { buildProjectRef, isProjectRef } = projectRefUtils;

export type ScopeEntry = {
  stableProjectId: string;
  projectPath: string;
  projectRef: string;
  mediaDir: string;
};

export type ScopeSnapshot = {
  stableProjectId: string;
  projectPath: string;
  projectRef: string;
};

export type CoordinatorEvents = {
  /** scope 首次注册（新 stableProjectId 进入索引），需通知 backend 影子表增量同步 */
  onScopeRegistered: (entry: ScopeEntry) => void;
  /** scope 所有 session detach 后注销，需通知 backend 影子表清除 */
  onScopeUnregistered: (entry: ScopeEntry) => void;
};

const noopEvents: CoordinatorEvents = {
  onScopeRegistered: () => {},
  onScopeUnregistered: () => {},
};

const normalizeStr = (v: unknown): string =>
  typeof v === 'string' ? v.trim() : '';

export const createProjectScopeCoordinator = (
  initialEvents: CoordinatorEvents | undefined = undefined,
) => {
  let events: CoordinatorEvents = initialEvents ?? noopEvents;
  const scopesByStableId = new Map<string, ScopeEntry>();
  const scopesByPath = new Map<string, string>();
  const refToStableId = new Map<string, string>();
  const sessionsByStableId = new Map<string, Set<string>>();

  /**
   * 后绑定 events（用于打破与 runtime 的循环依赖：
   * coordinator 先于 runtime 创建，events 在 runtime 创建后绑定）。
   */
  const bindEvents = (nextEvents: CoordinatorEvents): void => {
    events = nextEvents;
  };

  const buildEntry = (
    projectPath: string,
  ): ScopeEntry | null => {
    const stableProjectId = ensureStableProjectId(projectPath);
    if (stableProjectId === null) {
      console.warn('[scope-coordinator] register skipped: ensureStableProjectId returned null', {
        projectPath: projectPath.slice(-60),
      });
      return null;
    }
    const projectRef = buildProjectRef(projectPath);
    if (projectRef === null) {
      console.warn('[scope-coordinator] register skipped: buildProjectRef returned null', {
        projectPath: projectPath.slice(-60),
      });
      return null;
    }
    return {
      stableProjectId,
      projectPath,
      projectRef,
      mediaDir: path.join(projectPath, 'media'),
    };
  };

  /**
   * 注册项目 scope。
   *
   * 幂等：同一 projectPath 重复注册返回已有 entry，不触发 onScopeRegistered。
   * 旧项目首次打开时通过 ensureStableProjectId 自动补写 stableProjectId 到 manifest。
   *
   * 返回 entry 或 null（projectPath 无效或 stableProjectId 无法补写）。
   */
  const registerScope = (
    projectPathInput: string | null | undefined,
  ): ScopeEntry | null => {
    const projectPath = normalizeStr(projectPathInput);
    if (!projectPath) {
      console.warn('[scope-coordinator] registerScope skipped: empty projectPath');
      return null;
    }
    const existingStableId = scopesByPath.get(projectPath);
    if (existingStableId !== undefined) {
      const existing = scopesByStableId.get(existingStableId);
      if (existing !== undefined) {
        return existing;
      }
    }
    const entry = buildEntry(projectPath);
    if (entry === null) return null;

    scopesByStableId.set(entry.stableProjectId, entry);
    scopesByPath.set(projectPath, entry.stableProjectId);
    refToStableId.set(entry.projectRef, entry.stableProjectId);
    console.log('[scope-coordinator] register', {
      stableProjectId: entry.stableProjectId,
      projectRef: entry.projectRef,
      projectPath: projectPath.slice(-60),
    });
    events.onScopeRegistered(entry);
    return entry;
  };

  /** 按 V2 stableProjectId 查询 mediaDir */
  const getMediaDir = (
    stableProjectIdInput: unknown,
  ): string | null => {
    if (!stableProjectIdUtils.isStableProjectId(stableProjectIdInput)) {
      return null;
    }
    const entry = scopesByStableId.get(stableProjectIdInput as string);
    if (entry === undefined) {
      console.debug('[scope-coordinator] resolve miss', {
        kind: 'spid_not_registered',
        hostname: String(stableProjectIdInput).slice(0, 40),
      });
      return null;
    }
    return entry.mediaDir;
  };

  /** 按旧 V1 projectRef 兼容查询 mediaDir */
  const getMediaDirByRef = (
    projectRefInput: unknown,
  ): string | null => {
    const projectRef = normalizeStr(projectRefInput);
    if (!projectRef || !isProjectRef(projectRef)) return null;
    const stableId = refToStableId.get(projectRef);
    if (stableId === undefined) {
      console.debug('[scope-coordinator] resolve miss', {
        kind: 'prj_ref_to_stable_missing',
        hostname: projectRef.slice(0, 40),
      });
      return null;
    }
    const entry = scopesByStableId.get(stableId);
    if (entry === undefined) {
      console.debug('[scope-coordinator] resolve miss', {
        kind: 'prj_stable_entry_missing',
        hostname: projectRef.slice(0, 40),
        stableId: stableId.slice(0, 40),
      });
      return null;
    }
    return entry.mediaDir;
  };

  /** 判断 hostname 是否为已注册的 stableProjectId 或兼容的 projectRef */
  const resolveMediaDirByHostname = (
    hostname: string,
  ): string | null => {
    if (stableProjectIdUtils.isStableProjectId(hostname)) {
      return getMediaDir(hostname);
    }
    return getMediaDirByRef(hostname);
  };

  const getAllScopes = (): ScopeSnapshot[] =>
    Array.from(scopesByStableId.values()).map((entry) => ({
      stableProjectId: entry.stableProjectId,
      projectPath: entry.projectPath,
      projectRef: entry.projectRef,
    }));

  const getScopeByPath = (
    projectPathInput: string | null | undefined,
  ): ScopeEntry | null => {
    const projectPath = normalizeStr(projectPathInput);
    if (!projectPath) return null;
    const stableId = scopesByPath.get(projectPath);
    if (stableId === undefined) return null;
    const entry = scopesByStableId.get(stableId);
    return entry ?? null;
  };

  const attachSession = (
    stableProjectIdInput: unknown,
    sessionId: string,
  ): boolean => {
    if (!stableProjectIdUtils.isStableProjectId(stableProjectIdInput)) {
      return false;
    }
    const stableProjectId = stableProjectIdInput as string;
    if (!scopesByStableId.has(stableProjectId)) return false;
    let sessions = sessionsByStableId.get(stableProjectId);
    if (sessions === undefined) {
      sessions = new Set();
      sessionsByStableId.set(stableProjectId, sessions);
    }
    sessions.add(sessionId);
    return true;
  };

  const detachSession = (
    stableProjectIdInput: unknown,
    sessionId: string,
  ): { entry: ScopeEntry | null; hasActiveSessions: boolean } => {
    if (!stableProjectIdUtils.isStableProjectId(stableProjectIdInput)) {
      return { entry: null, hasActiveSessions: false };
    }
    const stableProjectId = stableProjectIdInput as string;
    const entry = scopesByStableId.get(stableProjectId) ?? null;
    const sessions = sessionsByStableId.get(stableProjectId);
    if (sessions !== undefined) {
      sessions.delete(sessionId);
      if (sessions.size === 0) {
        sessionsByStableId.delete(stableProjectId);
      }
    }
    const stillActive = sessionsByStableId.has(stableProjectId);
    return { entry, hasActiveSessions: stillActive };
  };

  const hasActiveSessions = (
    stableProjectIdInput: unknown,
  ): boolean => {
    if (!stableProjectIdUtils.isStableProjectId(stableProjectIdInput)) {
      return false;
    }
    const sessions = sessionsByStableId.get(stableProjectIdInput as string);
    return sessions !== undefined && sessions.size > 0;
  };

  /**
   * 注销 scope（仅当无活跃 session 时执行）。
   * 用于窗口全部关闭后清理。返回被注销的 entry 或 null（仍有 session 或不存在）。
   */
  const unregisterScopeIfIdle = (
    stableProjectIdInput: unknown,
  ): ScopeEntry | null => {
    if (!stableProjectIdUtils.isStableProjectId(stableProjectIdInput)) {
      return null;
    }
    const stableProjectId = stableProjectIdInput as string;
    if (hasActiveSessions(stableProjectId)) return null;
    const entry = scopesByStableId.get(stableProjectId);
    if (entry === undefined) return null;
    scopesByStableId.delete(stableProjectId);
    scopesByPath.delete(entry.projectPath);
    refToStableId.delete(entry.projectRef);
    sessionsByStableId.delete(stableProjectId);
    console.log('[scope-coordinator] unregister', {
      stableProjectId: entry.stableProjectId,
      projectRef: entry.projectRef,
      projectPath: entry.projectPath.slice(-60),
    });
    events.onScopeUnregistered(entry);
    return entry;
  };

  /** 清空所有索引（仅测试用） */
  const clearAllForTest = (): void => {
    scopesByStableId.clear();
    scopesByPath.clear();
    refToStableId.clear();
    sessionsByStableId.clear();
  };

  /**
   * 直接注入预构建 entry（仅测试用）。
   * 绕过 ensureStableProjectId/buildProjectRef 的真实 db 依赖，
   * 用于验证三索引、session 引用计数、双格式解析的纯逻辑。
   */
  const registerScopeEntryForTest = (entry: ScopeEntry): ScopeEntry => {
    scopesByStableId.set(entry.stableProjectId, entry);
    scopesByPath.set(entry.projectPath, entry.stableProjectId);
    refToStableId.set(entry.projectRef, entry.stableProjectId);
    events.onScopeRegistered(entry);
    return entry;
  };

  return {
    bindEvents,
    registerScope,
    getMediaDir,
    getMediaDirByRef,
    resolveMediaDirByHostname,
    getAllScopes,
    getScopeByPath,
    attachSession,
    detachSession,
    hasActiveSessions,
    unregisterScopeIfIdle,
    clearAllForTest,
    registerScopeEntryForTest,
  };
};

export type ProjectScopeCoordinator = ReturnType<
  typeof createProjectScopeCoordinator
>;
