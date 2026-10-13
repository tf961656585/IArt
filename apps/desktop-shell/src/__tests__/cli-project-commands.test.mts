// @vitest-environment node
// @spec: CLI-005, CLI-006, CLI-015
//
// 项目生命周期命令执行器测试：以假依赖构造 cli-command-executors（不经 Electron 与
// better-sqlite3），覆盖 project.list 的 last_opened_at、project.status 的解析/在册/窗口/
// 在途任务分支（ambiguous / not_found）、project.create 重名拒绝与成功入注册表（CLI-005）、
// project.open 打开主链映射与失败码映射（CLI-006）、project.close 幂等、project.delete 注册表语义。
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { CliCommandRequestSchema, CliCommandResponseSchema } from "@iart/contracts/cli-contract";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const executorsEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-command-executors.cjs`;

type ExecutorResult = { response: unknown; errorCode: string | null };

type Executor = (request: unknown) => ExecutorResult | Promise<ExecutorResult>;

type Registry = Map<string, Executor>;

type ExecutorModule = {
  createCliCommandExecutors: (deps: Record<string, unknown>) => Registry;
};

type RegistryEntry = {
  nodeGraphId: string;
  name: string;
  path: string;
  createdAt: number;
  savedAt: number;
  lastOpenedAt?: number | null;
};

const loadExecutorModule = (): ExecutorModule => requireDesktop(executorsEntry) as ExecutorModule;

const parseResponse = (result: ExecutorResult): ReturnType<typeof CliCommandResponseSchema.parse> =>
  CliCommandResponseSchema.parse(result.response);

const runExecutor = async (registry: Registry, command: string, request: unknown): Promise<ExecutorResult> => {
  const executor = registry.get(command);
  if (executor === undefined) throw new Error(`executor missing: ${command}`);
  return await executor(CliCommandRequestSchema.parse(request));
};

describe("cli-command-executors 项目生命周期（假依赖注入）", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "cli-project-executors-"));
  const projectAPath = join(tempRoot, "alpha");
  const projectBPath = join(tempRoot, "beta");
  mkdirSync(projectAPath, { recursive: true });
  mkdirSync(projectBPath, { recursive: true });

  let registryEntries: RegistryEntry[];
  let registry: Registry;
  const calls: { create: unknown[]; delete: unknown[]; touch: unknown[]; open: unknown[]; close: unknown[] } = {
    create: [],
    delete: [],
    touch: [],
    open: [],
    close: [],
  };
  const forwardCalls: string[] = [];
  const fakeTasksPayload: Record<string, unknown> = { tasks: [] as unknown[] };
  let windowOpenPaths: string[] = [];

  beforeAll(() => {
    registryEntries = [
      { nodeGraphId: "ng-1", name: "alpha", path: projectAPath, createdAt: 1, savedAt: 2, lastOpenedAt: 1700000000000 },
      { nodeGraphId: "ng-2", name: "twin", path: projectBPath, createdAt: 3, savedAt: 4 },
      { nodeGraphId: "ng-3", name: "twin", path: join(tempRoot, "twin-2"), createdAt: 5, savedAt: 6, lastOpenedAt: 1 },
    ];
    const mod = loadExecutorModule();
    registry = mod.createCliCommandExecutors({
      readProjects: () => registryEntries,
      windows: {
        openOrFocus: async (projectPath: string) => {
          calls.open.push(projectPath);
          return openResultOverride ?? { ok: true };
        },
        hasOpenWindow: (projectPath: string) => windowOpenPaths.includes(projectPath),
        closeByProjectPath: (projectPath: string) => {
          calls.close.push(projectPath);
          const found = windowOpenPaths.includes(projectPath);
          windowOpenPaths = windowOpenPaths.filter((path) => path !== projectPath);
          return found;
        },
      },
      forwarder: {
        getJson: async (pathname: string) => {
          forwardCalls.push(pathname);
          return { ok: true, payload: fakeTasksPayload };
        },
        postJson: async () => ({ ok: true, payload: {} }),
      },
      storage: {
        createProject: (params: { parentDir: string; name: string }) => {
          if (createErrorOverride !== null) throw createErrorOverride;
          calls.create.push(params);
          const projectPath = join(params.parentDir, params.name);
          registryEntries = [{ nodeGraphId: "ng-new", name: params.name, path: projectPath, createdAt: 9, savedAt: 9, lastOpenedAt: 9 }, ...registryEntries];
          return { projectPath };
        },
        deleteProject: (params: { projectPath: string }) => {
          calls.delete.push(params);
          registryEntries = registryEntries.filter((entry) => entry.path !== params.projectPath);
        },
        touchProjectOpenedAt: (projectPath: string, openedAt: number) => {
          calls.touch.push({ projectPath, openedAt });
        },
        readMediaAssets: () => [],
        readMediaAssetById: () => null,
        readAssetTaskIndex: () => new Map(),
        readTaskOutputAssets: () => [],
        readCanvasNodePayloads: () => [],
      },
    });
  });

  let openResultOverride: unknown = null;
  let createErrorOverride: Error | null = null;

  it("project.list：last_opened_at 承载数值，缺失按 null（不得丢条目）", async () => {
    const result = await runExecutor(registry, "project.list", { command: "project.list" });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "project.list") throw new Error("unexpected");
    expect(parsed.projects).toHaveLength(3);
    expect(parsed.projects[0]).toEqual({ name: "alpha", path: projectAPath, last_opened_at: 1700000000000 });
    // 旧文件缺 lastOpenedAt 的条目按 null 承载，条目本身不得被丢弃（持久化 JSON 演进纪律）
    const twinEntry = parsed.projects.find((project) => project.path === projectBPath);
    expect(twinEntry).toBeDefined();
    expect(twinEntry?.last_opened_at).toBeNull();
  });

  it("project.status：按名解析唯一命中 → 解析结果 + 在册 + 窗口状态 + 在途任务数", async () => {
    windowOpenPaths = [projectAPath];
    fakeTasksPayload.total = 3;
    fakeTasksPayload.limit = 3;
    fakeTasksPayload.offset = 0;
    fakeTasksPayload.tasks = [      { taskId: "t1", id: "t1", projectPath: projectAPath, nodeGraphId: null, sourceNodeId: null, targetNodeId: null, executionId: null, modelId: null, remoteRequestId: null, status: "generating", createdAt: 1, updatedAt: 2, errorMessage: null, progress: 40 },
      { taskId: "t2", id: "t2", projectPath: projectAPath, nodeGraphId: null, sourceNodeId: null, targetNodeId: null, executionId: null, modelId: null, remoteRequestId: null, status: "succeeded", createdAt: 1, updatedAt: 2, errorMessage: null, progress: null },
      { taskId: "t3", id: "t3", projectPath: projectAPath, nodeGraphId: null, sourceNodeId: null, targetNodeId: null, executionId: null, modelId: null, remoteRequestId: null, status: "polling", createdAt: 1, updatedAt: 2, errorMessage: null, progress: null },
    ];
    const result = await runExecutor(registry, "project.status", { command: "project.status", project: "alpha" });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "project.status") throw new Error("unexpected");
    expect(parsed.project).toEqual({ name: "alpha", path: projectAPath });
    expect(parsed.registered).toBe(true);
    expect(parsed.window_open).toBe(true);
    expect(parsed.active_task_count).toBe(2);
    expect(forwardCalls[0]).toBe(`/api/tasks?projectPath=${encodeURIComponent(projectAPath)}`);
  });

  it("project.status：按名命中多个同名 → project_name_ambiguous（不得静默选取）", async () => {
    const result = await runExecutor(registry, "project.status", { command: "project.status", project: "twin" });
    const parsed = parseResponse(result);
    if (parsed.ok) throw new Error("unexpected ok");
    expect(parsed.error.code).toBe("project_name_ambiguous");
    expect(parsed.error.message.length).toBeGreaterThan(0);
  });

  it("project.status：解析不到 → project_not_found；不存在的路径同样 not_found", async () => {
    const byName = await runExecutor(registry, "project.status", { command: "project.status", project: "ghost" });
    expect(parseResponse(byName)).toMatchObject({ ok: false, error: { code: "project_not_found" } });
    const byPath = await runExecutor(registry, "project.status", {
      command: "project.status",
      project: join(tempRoot, "missing"),
    });
    expect(parseResponse(byPath)).toMatchObject({ ok: false, error: { code: "project_not_found" } });
  });

  it("project.create：目标位置已有同名目录 → project_name_conflict，不写注册表（CLI-005）", async () => {
    createErrorOverride = new Error("PROJECT_NAME_CONFLICT");
    const before = JSON.stringify(registryEntries);
    const result = await runExecutor(registry, "project.create", {
      command: "project.create",
      name: "alpha",
      path: tempRoot,
    });
    const parsed = parseResponse(result);
    if (parsed.ok) throw new Error("unexpected ok");
    expect(parsed.error.code).toBe("project_name_conflict");
    expect(JSON.stringify(registryEntries)).toBe(before);
    createErrorOverride = null;
  });

  it("project.create：无冲突 → 创建成功并入注册表（CLI-005）", async () => {
    const result = await runExecutor(registry, "project.create", {
      command: "project.create",
      name: "fresh-one",
      path: tempRoot,
    });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "project.create") throw new Error("unexpected");
    expect(parsed.project).toEqual({ name: "fresh-one", path: join(tempRoot, "fresh-one") });
    expect(registryEntries[0]?.name).toBe("fresh-one");
    expect(calls.create).toHaveLength(1);
  });

  it("project.open：复用打开主链成功 → 触碰最近打开时间并返回项目引用（CLI-006）", async () => {
    openResultOverride = null;
    const result = await runExecutor(registry, "project.open", { command: "project.open", project: projectAPath });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "project.open") throw new Error("unexpected");
    expect(parsed.project).toEqual({ name: "alpha", path: projectAPath });
    expect(calls.open).toEqual([projectAPath]);
    expect(calls.touch).toEqual([{ projectPath: projectAPath, openedAt: expect.any(Number) }]);
  });

  it("project.open：无效项目文件夹 → project_not_found；其他失败 → internal_error", async () => {
    openResultOverride = { ok: false, code: "invalid-project-folder", message: "项目文件夹无效", projectPath: projectAPath };
    const invalid = await runExecutor(registry, "project.open", { command: "project.open", project: projectAPath });
    expect(parseResponse(invalid)).toMatchObject({ ok: false, error: { code: "project_not_found" } });

    openResultOverride = { ok: false, code: "open-editor-window-failed", message: "boom", projectPath: projectAPath };
    const failed = await runExecutor(registry, "project.open", { command: "project.open", project: projectAPath });
    expect(parseResponse(failed)).toMatchObject({ ok: false, error: { code: "internal_error" } });
    openResultOverride = null;
  });

  it("project.close：有窗口 → 走关闭链；无窗口 → 幂等成功", async () => {
    windowOpenPaths = [projectAPath];
    const closed = await runExecutor(registry, "project.close", { command: "project.close", project: projectAPath });
    expect(parseResponse(closed)).toMatchObject({ ok: true, closed: true });
    expect(calls.close).toEqual([projectAPath]);

    const idempotent = await runExecutor(registry, "project.close", { command: "project.close", project: projectAPath });
    expect(parseResponse(idempotent)).toMatchObject({ ok: true, closed: true });
    // 关闭链对不存在的窗口幂等（closeByProjectPath 找不到存活窗口即无操作）
    expect(calls.close).toEqual([projectAPath, projectAPath]);
    expect(windowOpenPaths).toEqual([]);
  });

  it("project.delete：复用既有删除语义（仅注册表移除，不碰磁盘），解析失败拒删", async () => {
    const beforeDirs = [projectAPath, projectBPath];
    const result = await runExecutor(registry, "project.delete", {
      command: "project.delete",
      project: projectAPath,
      yes: true,
    });
    expect(parseResponse(result)).toMatchObject({ ok: true, deleted: true });
    expect(calls.delete).toEqual([{ projectPath: projectAPath }]);
    expect(registryEntries.some((entry) => entry.path === projectAPath)).toBe(false);
    // 磁盘目录原样保留（spec §13：CLI 不提供删除磁盘项目文件的能力）
    for (const dir of beforeDirs) expect(requireDesktop("node:fs").existsSync(dir)).toBe(true);

    const ghost = await runExecutor(registry, "project.delete", { command: "project.delete", project: "ghost", yes: true });
    expect(parseResponse(ghost)).toMatchObject({ ok: false, error: { code: "project_not_found" } });
    expect(calls.delete).toHaveLength(1);
  });
});
