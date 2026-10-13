// @vitest-environment node
/**
 * Project Scope 一致性测试
 *
 * 验证 Desktop Shell ProjectScopeCoordinator 与 Backend 影子表之间通过 IPC 同步的状态一致性。
 * 测试策略：通过 mock IPC channel 捕获 coordinator 发出的消息，并喂给 backend scope module 的
 * sync/syncAll/remove 接口，验证两端状态对齐。不真正 fork 子进程。
 *
 * 覆盖场景：
 * 1. scope 注册 → coordinator 发 register 消息 → backend syncProjectScope 写入影子表
 * 2. scope 注销（session 全部 detach）→ coordinator 发 unregister 消息 → backend removeProjectScope 清除
 * 3. backend 重启全量恢复 → coordinator 发 sync 消息（多 scope）→ backend syncAllProjectScopes 重建
 * 4. 新旧 URL 双格式解析在两端一致
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const requireBackend = createRequire(import.meta.url);

const coordinatorEntry = `${workspaceRoot}/apps/desktop-shell/dist/project-scope-coordinator.cjs`;
const backendScopeEntry = `${workspaceRoot}/apps/backend/dist/local-server/project-media-scope.cjs`;

const ensureBuilds = () => {
  const need: Array<{ entry: string; pkg: string }> = [];
  if (!existsSync(coordinatorEntry)) need.push({ entry: coordinatorEntry, pkg: "@iart/desktop-shell" });
  if (!existsSync(backendScopeEntry)) need.push({ entry: backendScopeEntry, pkg: "@iart/backend" });
  if (need.length === 0) return;
  for (const { pkg } of need) {
    execFileSync("pnpm", ["--filter", pkg, "build"], {
      cwd: workspaceRoot,
      stdio: "pipe",
    });
  }
};

type ScopeEntry = {
  stableProjectId: string;
  projectPath: string;
  projectRef: string;
  mediaDir: string;
};

type CoordinatorModule = {
  createProjectScopeCoordinator: (events?: {
    onScopeRegistered: (entry: ScopeEntry) => void;
    onScopeUnregistered: (entry: ScopeEntry) => void;
  }) => {
    registerScopeEntryForTest: (entry: ScopeEntry) => ScopeEntry;
    attachSession: (stableProjectId: unknown, sessionId: string) => boolean;
    detachSession: (
      stableProjectId: unknown,
      sessionId: string,
    ) => { entry: ScopeEntry | null; hasActiveSessions: boolean };
    unregisterScopeIfIdle: (stableProjectId: unknown) => ScopeEntry | null;
    resolveMediaDirByHostname: (hostname: string) => string | null;
    getMediaDir: (stableProjectId: unknown) => string | null;
    getMediaDirByRef: (projectRef: unknown) => string | null;
    getAllScopes: () => Array<{
      stableProjectId: string;
      projectPath: string;
      projectRef: string;
    }>;
    clearAllForTest: () => void;
  };
};

type BackendScopeModule = {
  syncProjectScope: (entry: {
    stableProjectId: string;
    projectPath: string;
    projectRef: string;
  }) => { stableProjectId: string; projectPath: string; projectRef: string } | null;
  syncAllProjectScopes: (
    entries: Array<{
      stableProjectId: string;
      projectPath: string;
      projectRef: string;
    }>,
  ) => void;
  removeProjectScope: (stableProjectId: unknown) => {
    stableProjectId: string;
    projectPath: string;
    projectRef: string;
  } | null;
  resolveLocalMediaUrl: (
    stableProjectIdOrProjectRef: string | null | undefined,
    fileKey: string | null | undefined,
  ) => string | null;
  getStableProjectIdByRef: (projectRef: unknown) => string | null;
  clearRuntimeProjectScopesForTest: () => void;
};

const loadCoordinator = () => requireDesktop(coordinatorEntry) as CoordinatorModule;
const loadBackendScope = () => requireBackend(backendScopeEntry) as BackendScopeModule;

const STABLE_A = "spid_aaaaaaaaaaaaaaaaaaaaaaaa";
const STABLE_B = "spid_bbbbbbbbbbbbbbbbbbbbbbbb";
const REF_A = "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REF_B = "prj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PATH_A = "/tmp/consistency-project-a";
const PATH_B = "/tmp/consistency-project-b";
const MEDIA_A = "/tmp/consistency-project-a/media";
const MEDIA_B = "/tmp/consistency-project-b/media";
const FILE_KEY = "abc123.png";

describe("project scope consistency: Desktop Shell coordinator ↔ Backend shadow table", () => {
  beforeAll(() => {
    ensureBuilds();
  });

  it("register flow: coordinator register → IPC register message → backend syncProjectScope writes shadow table", () => {
    const { createProjectScopeCoordinator } = loadCoordinator();
    const backend = loadBackendScope();
    backend.clearRuntimeProjectScopesForTest();

    // coordinator 捕获 onScopeRegistered 事件（模拟 IPC register 消息），喂给 backend
    const coordinator = createProjectScopeCoordinator({
      onScopeRegistered: (entry) => {
        backend.syncProjectScope({
          stableProjectId: entry.stableProjectId,
          projectPath: entry.projectPath,
          projectRef: entry.projectRef,
        });
      },
      onScopeUnregistered: () => {},
    });

    coordinator.registerScopeEntryForTest({
      stableProjectId: STABLE_A,
      projectPath: PATH_A,
      projectRef: REF_A,
      mediaDir: MEDIA_A,
    });

    // backend 影子表应能按 projectRef 反查 stableProjectId（V2 反查索引建立）
    expect(backend.getStableProjectIdByRef(REF_A)).toBe(STABLE_A);
    // backend URL 生成应走 V2（resolveLocalMediaUrl 反查到 stableProjectId）
    const url = backend.resolveLocalMediaUrl(REF_A, FILE_KEY);
    expect(url).not.toBeNull();
    expect(url).toContain(STABLE_A);
    expect(url).toContain(FILE_KEY);

    coordinator.clearAllForTest();
    backend.clearRuntimeProjectScopesForTest();
  });

  it("unregister flow: last session detach → coordinator unregister message → backend removeProjectScope clears shadow", () => {
    const { createProjectScopeCoordinator } = loadCoordinator();
    const backend = loadBackendScope();
    backend.clearRuntimeProjectScopesForTest();

    const coordinator = createProjectScopeCoordinator({
      onScopeRegistered: (entry) => {
        backend.syncProjectScope({
          stableProjectId: entry.stableProjectId,
          projectPath: entry.projectPath,
          projectRef: entry.projectRef,
        });
      },
      onScopeUnregistered: (entry) => {
        backend.removeProjectScope(entry.stableProjectId);
      },
    });

    coordinator.registerScopeEntryForTest({
      stableProjectId: STABLE_A,
      projectPath: PATH_A,
      projectRef: REF_A,
      mediaDir: MEDIA_A,
    });
    coordinator.attachSession(STABLE_A, "session-1");

    // detach 后无活跃 session，unregisterScopeIfIdle 触发 onScopeUnregistered → backend 清除
    coordinator.detachSession(STABLE_A, "session-1");
    coordinator.unregisterScopeIfIdle(STABLE_A);

    // backend 影子表已清除：getStableProjectIdByRef 返回 null
    expect(backend.getStableProjectIdByRef(REF_A)).toBeNull();
    // resolveLocalMediaUrl fallback 到 V1（影子表无 stableProjectId）
    const url = backend.resolveLocalMediaUrl(REF_A, FILE_KEY);
    expect(url).toContain(REF_A);

    coordinator.clearAllForTest();
    backend.clearRuntimeProjectScopesForTest();
  });

  it("backend restart full recovery: coordinator sync message → backend syncAllProjectScopes rebuilds shadow", () => {
    const { createProjectScopeCoordinator } = loadCoordinator();
    const backend = loadBackendScope();
    backend.clearRuntimeProjectScopesForTest();

    // 模拟 coordinator 已有多个 scope，backend 重启后通过 getAllScopes 发送全量 sync
    const coordinator = createProjectScopeCoordinator();
    coordinator.registerScopeEntryForTest({
      stableProjectId: STABLE_A,
      projectPath: PATH_A,
      projectRef: REF_A,
      mediaDir: MEDIA_A,
    });
    coordinator.registerScopeEntryForTest({
      stableProjectId: STABLE_B,
      projectPath: PATH_B,
      projectRef: REF_B,
      mediaDir: MEDIA_B,
    });

    const allScopes = coordinator.getAllScopes();
    expect(allScopes).toHaveLength(2);

    // 模拟 ProjectScopeSyncMessage 到达 backend
    backend.syncAllProjectScopes(allScopes);

    // 两个 scope 都应能反查
    expect(backend.getStableProjectIdByRef(REF_A)).toBe(STABLE_A);
    expect(backend.getStableProjectIdByRef(REF_B)).toBe(STABLE_B);

    coordinator.clearAllForTest();
    backend.clearRuntimeProjectScopesForTest();
  });

  it("dual-format URL resolution is consistent across both ends", () => {
    const { createProjectScopeCoordinator } = loadCoordinator();
    const backend = loadBackendScope();
    backend.clearRuntimeProjectScopesForTest();

    const coordinator = createProjectScopeCoordinator();
    coordinator.registerScopeEntryForTest({
      stableProjectId: STABLE_A,
      projectPath: PATH_A,
      projectRef: REF_A,
      mediaDir: MEDIA_A,
    });
    backend.syncProjectScope({
      stableProjectId: STABLE_A,
      projectPath: PATH_A,
      projectRef: REF_A,
    });

    // Desktop Shell 端：V2 stableProjectId 和 V1 projectRef 都能解析到同一 mediaDir
    expect(coordinator.getMediaDir(STABLE_A)).toBe(MEDIA_A);
    expect(coordinator.getMediaDirByRef(REF_A)).toBe(MEDIA_A);
    expect(coordinator.resolveMediaDirByHostname(STABLE_A)).toBe(MEDIA_A);
    expect(coordinator.resolveMediaDirByHostname(REF_A)).toBe(MEDIA_A);

    // Backend 端：V2 和 V1 projectRef 生成的 URL 都走 V2 格式（影子表已同步）
    const urlFromStable = backend.resolveLocalMediaUrl(STABLE_A, FILE_KEY);
    const urlFromRef = backend.resolveLocalMediaUrl(REF_A, FILE_KEY);
    expect(urlFromStable).not.toBeNull();
    expect(urlFromRef).not.toBeNull();
    // 两者都应是 V2 格式（hostname 是 stableProjectId）
    expect(urlFromStable).toBe(urlFromRef);
    expect(urlFromStable).toContain(STABLE_A);

    coordinator.clearAllForTest();
    backend.clearRuntimeProjectScopesForTest();
  });
});
