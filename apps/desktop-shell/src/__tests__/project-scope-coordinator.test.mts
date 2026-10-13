// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const coordinatorEntry = `${workspaceRoot}/apps/desktop-shell/dist/project-scope-coordinator.cjs`;
const bootstrapSource = `${workspaceRoot}/apps/desktop-shell/src/desktop-shell-bootstrap.cts`;

const ensureDesktopShellBuild = () => {
  if (existsSync(coordinatorEntry)) return;
  execFileSync("pnpm", ["--filter", "@iart/desktop-shell", "build"], {
    cwd: workspaceRoot,
    stdio: "pipe",
  });
};

type ScopeEntry = {
  stableProjectId: string;
  projectPath: string;
  projectRef: string;
  mediaDir: string;
};

type CoordinatorModule = {
  createProjectScopeCoordinator: (
    events?: {
      onScopeRegistered: (entry: ScopeEntry) => void;
      onScopeUnregistered: (entry: ScopeEntry) => void;
    },
  ) => {
    registerScopeEntryForTest: (entry: ScopeEntry) => ScopeEntry;
    getMediaDir: (stableProjectId: unknown) => string | null;
    getMediaDirByRef: (projectRef: unknown) => string | null;
    resolveMediaDirByHostname: (hostname: string) => string | null;
    getAllScopes: () => Array<{
      stableProjectId: string;
      projectPath: string;
      projectRef: string;
    }>;
    attachSession: (stableProjectId: unknown, sessionId: string) => boolean;
    detachSession: (
      stableProjectId: unknown,
      sessionId: string,
    ) => { entry: ScopeEntry | null; hasActiveSessions: boolean };
    hasActiveSessions: (stableProjectId: unknown) => boolean;
    unregisterScopeIfIdle: (stableProjectId: unknown) => ScopeEntry | null;
    clearAllForTest: () => void;
  };
};

const loadModule = () => requireDesktop(coordinatorEntry) as CoordinatorModule;

const buildEntry = (overrides: Partial<ScopeEntry> = {}): ScopeEntry => ({
  stableProjectId: "spid_aabbccddeeff001122334455",
  projectPath: "/tmp/project-a",
  projectRef: "prj_abcdef1234567890abcdef1234567890",
  mediaDir: "/tmp/project-a/media",
  ...overrides,
});

describe("project scope coordinator", () => {
  beforeAll(() => {
    ensureDesktopShellBuild();
  });

  describe("dual-format hostname resolution", () => {
    it("resolves mediaDir via V2 stableProjectId (spid_ prefix)", () => {
      const { createProjectScopeCoordinator } = loadModule();
      const coordinator = createProjectScopeCoordinator();
      const entry = buildEntry();
      coordinator.registerScopeEntryForTest(entry);

      expect(coordinator.getMediaDir(entry.stableProjectId)).toBe(entry.mediaDir);
      expect(
        coordinator.resolveMediaDirByHostname(entry.stableProjectId),
      ).toBe(entry.mediaDir);
    });

    it("resolves mediaDir via V1 projectRef (prj_ prefix) for backward compat", () => {
      const { createProjectScopeCoordinator } = loadModule();
      const coordinator = createProjectScopeCoordinator();
      const entry = buildEntry();
      coordinator.registerScopeEntryForTest(entry);

      expect(coordinator.getMediaDirByRef(entry.projectRef)).toBe(entry.mediaDir);
      expect(
        coordinator.resolveMediaDirByHostname(entry.projectRef),
      ).toBe(entry.mediaDir);
    });

    it("returns null for unknown hostname in both formats", () => {
      const { createProjectScopeCoordinator } = loadModule();
      const coordinator = createProjectScopeCoordinator();

      expect(coordinator.getMediaDir("spid_unknown000000000000000000")).toBeNull();
      expect(
        coordinator.getMediaDirByRef("prj_unknown00000000000000000000000"),
      ).toBeNull();
      expect(
        coordinator.resolveMediaDirByHostname("spid_unknown000000000000000000"),
      ).toBeNull();
    });

    it("rejects malformed identifiers that are neither stableProjectId nor projectRef", () => {
      const { createProjectScopeCoordinator } = loadModule();
      const coordinator = createProjectScopeCoordinator();

      expect(coordinator.getMediaDir("not-a-valid-id")).toBeNull();
      expect(coordinator.getMediaDir("")).toBeNull();
      expect(coordinator.getMediaDir(null)).toBeNull();
      expect(coordinator.getMediaDirByRef("garbage")).toBeNull();
    });
  });

  describe("session reference counting", () => {
    it("does not unregister scope while sessions are attached", () => {
      const { createProjectScopeCoordinator } = loadModule();
      const unregistered: ScopeEntry[] = [];
      const coordinator = createProjectScopeCoordinator({
        onScopeRegistered: () => {},
        onScopeUnregistered: (entry) => unregistered.push(entry),
      });
      const entry = buildEntry();
      coordinator.registerScopeEntryForTest(entry);

      // 两窗口打开同一项目
      expect(coordinator.attachSession(entry.stableProjectId, "session-1")).toBe(true);
      expect(coordinator.attachSession(entry.stableProjectId, "session-2")).toBe(true);
      expect(coordinator.hasActiveSessions(entry.stableProjectId)).toBe(true);

      // 关闭第一个窗口：仍有活跃 session，不应注销
      coordinator.detachSession(entry.stableProjectId, "session-1");
      expect(coordinator.hasActiveSessions(entry.stableProjectId)).toBe(true);
      expect(coordinator.unregisterScopeIfIdle(entry.stableProjectId)).toBeNull();
      expect(unregistered).toHaveLength(0);

      // 关闭最后一个窗口：无活跃 session，注销生效
      coordinator.detachSession(entry.stableProjectId, "session-2");
      expect(coordinator.hasActiveSessions(entry.stableProjectId)).toBe(false);
      const removed = coordinator.unregisterScopeIfIdle(entry.stableProjectId);
      expect(removed).not.toBeNull();
      expect(removed?.stableProjectId).toBe(entry.stableProjectId);
      expect(unregistered).toHaveLength(1);
    });

    it("attachSession rejects unknown stableProjectId", () => {
      const { createProjectScopeCoordinator } = loadModule();
      const coordinator = createProjectScopeCoordinator();

      expect(coordinator.attachSession("spid_unknown000000000000000000", "s1")).toBe(false);
    });

    it("detachSession is idempotent for unknown session", () => {
      const { createProjectScopeCoordinator } = loadModule();
      const coordinator = createProjectScopeCoordinator();
      const entry = buildEntry();
      coordinator.registerScopeEntryForTest(entry);

      const result = coordinator.detachSession(entry.stableProjectId, "never-attached");
      expect(result.entry).not.toBeNull();
      expect(result.hasActiveSessions).toBe(false);
    });

    it("unregister clears all three indices and reverse lookup", () => {
      const { createProjectScopeCoordinator } = loadModule();
      const coordinator = createProjectScopeCoordinator();
      const entry = buildEntry();
      coordinator.registerScopeEntryForTest(entry);

      coordinator.unregisterScopeIfIdle(entry.stableProjectId);

      expect(coordinator.getMediaDir(entry.stableProjectId)).toBeNull();
      expect(coordinator.getMediaDirByRef(entry.projectRef)).toBeNull();
      expect(coordinator.getAllScopes()).toHaveLength(0);
    });
  });

  describe("scope registration events", () => {
    it("fires onScopeRegistered when entry is added", () => {
      const { createProjectScopeCoordinator } = loadModule();
      const registered: ScopeEntry[] = [];
      const coordinator = createProjectScopeCoordinator({
        onScopeRegistered: (entry) => registered.push(entry),
        onScopeUnregistered: () => {},
      });
      const entry = buildEntry();

      coordinator.registerScopeEntryForTest(entry);

      expect(registered).toHaveLength(1);
      expect(registered[0].stableProjectId).toBe(entry.stableProjectId);
    });
  });

  describe("getAllScopes snapshot", () => {
    it("returns shallow projection without mediaDir", () => {
      const { createProjectScopeCoordinator } = loadModule();
      const coordinator = createProjectScopeCoordinator();
      coordinator.registerScopeEntryForTest(buildEntry({ projectPath: "/tmp/p1", stableProjectId: "spid_111111111111111111111111", projectRef: "prj_11111111111111111111111111111111" }));
      coordinator.registerScopeEntryForTest(buildEntry({ projectPath: "/tmp/p2", stableProjectId: "spid_222222222222222222222222", projectRef: "prj_22222222222222222222222222222222" }));

      const scopes = coordinator.getAllScopes();
      expect(scopes).toHaveLength(2);
      for (const scope of scopes) {
        expect(scope).not.toHaveProperty("mediaDir");
        expect(typeof scope.stableProjectId).toBe("string");
        expect(typeof scope.projectPath).toBe("string");
        expect(typeof scope.projectRef).toBe("string");
      }
    });
  });
});

describe("local-media protocol handler dual-format wiring", () => {
  beforeAll(() => {
    ensureDesktopShellBuild();
  });

  it("protocol handler delegates hostname resolution to coordinator and supports both formats", () => {
    const source = readFileSync(bootstrapSource, "utf8");

    // 委托 coordinator 统一解析 V2/V1
    expect(source).toContain("coordinator.resolveMediaDirByHostname(hostname)");
    // __global__ scope 仍走 global mediaDirRegistry
    expect(source).toContain("hostname === LOCAL_MEDIA_GLOBAL_REF");
    expect(source).toContain("getMediaDirByRef(hostname)");
    // 双格式判定
    expect(source).toContain("stableProjectIdUtils.isStableProjectId(hostname)");
    expect(source).toContain("projectRefUtils.isProjectRef(hostname)");
  });

  it("protocol handler emits granular X-Scope-Error codes", () => {
    const source = readFileSync(bootstrapSource, "utf8");

    expect(source).toContain('"bad_request"');
    expect(source).toContain('"scope_unregistered"');
    expect(source).toContain('"file_missing"');
    expect(source).toContain("X-Scope-Error");
  });
});
