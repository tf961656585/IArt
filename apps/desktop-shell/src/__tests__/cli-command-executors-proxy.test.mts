// @vitest-environment node
// @spec: CLI-007, CLI-012, CLI-014, CLI-015, CLI-020, CLI-021, CLI-027, CLI-028, CLI-029, CLI-030, CLI-049, CLI-050
//
// 画布命令 / 生成提交 / 任务取消执行器测试（spec §4.2 分派规则固定语义）：
// - canvas.group.create / canvas.layout / generate：无窗口 → project_not_open（CLI-007，
//   不触达代理通道、不做降级）；有窗口 → 代理通道响应直通（成功原样、错误码原样透传）；
// - task.cancel 两形态（CLI-012）：有窗走代理通道（用户取消链）；无窗走运行域取消端点
//   （响应经 TaskCancelAcceptedResponseSchema 校验后适配）；守卫后窗口竞态关闭回落端点。
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CliCommandRequestSchema, CliCommandResponseSchema } from "@iart/contracts";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const executorsEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-command-executors.cjs`;

type ExecutorResult = { response: unknown; errorCode: string | null };
type Executor = (request: unknown) => ExecutorResult | Promise<ExecutorResult>;
type Registry = Map<string, Executor>;
type DispatcherOutcome =
  | { ok: true; response: unknown }
  | { ok: false; reason: string; detail: string };

type ProxyCall = { projectPath: string; candidate: Record<string, unknown> };

type ExecutorModule = {
  createCliCommandExecutors: (deps: Record<string, unknown>) => Registry;
  buildGenerationWarnings: (
    task: { request?: Record<string, unknown> | null },
    assets: readonly GenerationWarningAsset[],
  ) => GenerationWarning[];
};

type GenerationWarning = {
  code: string;
  message: string;
  requested_size: string;
  actual_sizes: string[];
};

type GenerationWarningAsset = {
  asset: {
    mediaType: string;
    original: { width?: number | null; height?: number | null };
  };
};

const loadExecutorModule = (): ExecutorModule => requireDesktop(executorsEntry) as ExecutorModule;

const parseResponse = (result: ExecutorResult) => CliCommandResponseSchema.parse(result.response);

const runExecutor = async (registry: Registry, command: string, request: unknown): Promise<ExecutorResult> => {
  const executor = registry.get(command);
  if (executor === undefined) throw new Error(`executor missing: ${command}`);
  return await executor(CliCommandRequestSchema.parse(request));
};

const PROJECT_PATH = join(tmpdir(), `cli-proxy-exec-proj-${process.pid}`);

const buildRegistry = (overrides: {
  windowOpen?: boolean;
  dispatchOutcome?: DispatcherOutcome;
  postJsonPayload?: { ok: boolean; payload?: unknown; reason?: string; status?: number; detail?: string };
  openProjects?: Array<{ projectPath: string; focused: boolean; canvasLoading: boolean }>;
} = {}): { registry: Registry; proxyCalls: ProxyCall[]; postCalls: Array<{ pathname: string; body: unknown }> } => {
  const proxyCalls: ProxyCall[] = [];
  const postCalls: Array<{ pathname: string; body: unknown }> = [];
  const dispatchOutcome: DispatcherOutcome =
    overrides.dispatchOutcome !== undefined
      ? overrides.dispatchOutcome
      : { ok: true, response: { command: "canvas.group.create", request_id: "ignored", group_node_id: "g-new" } };
  const mod = loadExecutorModule();
  const registry = mod.createCliCommandExecutors({
    readProjects: () => [
      { nodeGraphId: "ng-1", name: "demo", path: PROJECT_PATH, createdAt: 1, savedAt: 2, lastOpenedAt: 3 },
    ],
    windows: {
      openOrFocus: async () => ({ ok: true }),
      hasOpenWindow: () => overrides.windowOpen ?? true,
      closeByProjectPath: () => true,
      listOpenEditorProjects: () => overrides.openProjects ?? [],
    },
    forwarder: {
      getJson: async () => ({ ok: true, payload: {} }),
      postJson: async (pathname: string, body: unknown) => {
        postCalls.push({ pathname, body });
        const injected = overrides.postJsonPayload;
        if (injected !== undefined) {
          return injected.ok
            ? { ok: true, payload: injected.payload }
            : {
                ok: false,
                reason: injected.reason ?? "http_error",
                ...(injected.status !== undefined ? { status: injected.status } : {}),
                detail: injected.detail ?? "x",
              };
        }
        return { ok: true, payload: {} };
      },
    },
    storage: {
      createProject: () => ({ projectPath: PROJECT_PATH }),
      deleteProject: () => undefined,
      touchProjectOpenedAt: () => undefined,
      readMediaAssets: () => [],
      readMediaAssetById: () => null,
      readAssetTaskIndex: () => new Map(),
      readTaskOutputAssets: () => [],
      readCanvasNodePayloads: () => [],
    },
    proxy: {
      dispatch: async (projectPath: string, candidate: Record<string, unknown>) => {
        proxyCalls.push({ projectPath, candidate });
        return dispatchOutcome;
      },
    },
  });
  return { registry, proxyCalls, postCalls };
};

describe("cli-command-executors 画布命令 / 生成提交（代理执行通道）", () => {
  it("canvas.group.create：项目未打开 → project_not_open（CLI-007），不触达代理通道", async () => {
    const { registry, proxyCalls } = buildRegistry({ windowOpen: false });
    const result = await runExecutor(registry, "canvas.group.create", {
      command: "canvas.group.create",
      project: "demo",
      name: "角色组",
      members: ["node-1"],
    });
    expect(parseResponse(result)).toMatchObject({ ok: false, error: { code: "project_not_open" } });
    expect(proxyCalls).toHaveLength(0);
    expect(result.errorCode).toBe("project_not_open");
  });

  it("canvas.group.create：有窗口 → 代理通道直通成功结果（group_node_id）", async () => {
    const { registry, proxyCalls } = buildRegistry({
      windowOpen: true,
      dispatchOutcome: { ok: true, response: { command: "canvas.group.create", request_id: "r1", group_node_id: "g-9" } },
    });
    const result = await runExecutor(registry, "canvas.group.create", {
      command: "canvas.group.create",
      project: "demo",
      name: "角色组",
      members: ["node-1", "node-2"],
    });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "canvas.group.create") throw new Error("unexpected");
    expect(parsed.group_node_id).toBe("g-9");
    expect(result.errorCode).toBeNull();
    expect(proxyCalls).toHaveLength(1);
    expect(proxyCalls[0]).toMatchObject({
      projectPath: PROJECT_PATH,
      candidate: { command: "canvas.group.create", name: "角色组", members: ["node-1", "node-2"] },
    });
  });

  it("canvas.group.create：Editor 回错误码原样透传（command_rejected 携带定位信息）", async () => {
    const { registry } = buildRegistry({
      windowOpen: true,
      dispatchOutcome: {
        ok: true,
        response: {
          command: "canvas.group.create",
          request_id: "r2",
          error: { code: "command_rejected", message: "这些节点本身是节点组，不能作为另一个组的成员：n1。" },
        },
      },
    });
    const result = await runExecutor(registry, "canvas.group.create", {
      command: "canvas.group.create",
      project: "demo",
      name: "g",
      members: ["n1"],
    });
    expect(parseResponse(result)).toMatchObject({
      ok: false,
      error: { code: "command_rejected", message: expect.stringContaining("节点组") },
    });
    expect(result.errorCode).toBe("command_rejected");
  });

  it("canvas.layout：有窗口 → positions 直通；scope/columns 原样进候选", async () => {
    const { registry, proxyCalls } = buildRegistry({
      windowOpen: true,
      dispatchOutcome: { ok: true, response: { command: "canvas.layout", request_id: "r3", positions: { n1: { x: 5, y: 6 } } } },
    });
    const result = await runExecutor(registry, "canvas.layout", {
      command: "canvas.layout",
      project: "demo",
      scope: { group: "g-1" },
      columns: 3,
    });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "canvas.layout") throw new Error("unexpected");
    expect(parsed.positions).toEqual({ n1: { x: 5, y: 6 } });
    expect(proxyCalls[0]?.candidate).toMatchObject({ command: "canvas.layout", scope: { group: "g-1" }, columns: 3 });
  });

  it("canvas.layout：--order 显式顺序原样进代理候选（CLI-030）", async () => {
    const { registry, proxyCalls } = buildRegistry({
      windowOpen: true,
      dispatchOutcome: { ok: true, response: { command: "canvas.layout", request_id: "r3b", positions: {} } },
    });
    const result = await runExecutor(registry, "canvas.layout", {
      command: "canvas.layout",
      project: "demo",
      scope: "all",
      order: ["n3", "n1"],
    });
    expect(parseResponse(result)).toMatchObject({ ok: true, command: "canvas.layout" });
    expect(proxyCalls[0]?.candidate).toMatchObject({ command: "canvas.layout", scope: "all", order: ["n3", "n1"] });
  });

  it("canvas.group.dissolve：项目未打开 → project_not_open（CLI-007），不触达代理通道（CLI-027）", async () => {
    const { registry, proxyCalls } = buildRegistry({ windowOpen: false });
    const result = await runExecutor(registry, "canvas.group.dissolve", {
      command: "canvas.group.dissolve",
      project: "demo",
      group: "g-1",
    });
    expect(parseResponse(result)).toMatchObject({ ok: false, error: { code: "project_not_open" } });
    expect(proxyCalls).toHaveLength(0);
    expect(result.errorCode).toBe("project_not_open");
  });

  it("canvas.group.dissolve：有窗口 → 解散结果直通（dissolved/group_node_id/member_ids）（CLI-027）", async () => {
    const { registry, proxyCalls } = buildRegistry({
      windowOpen: true,
      dispatchOutcome: {
        ok: true,
        response: { command: "canvas.group.dissolve", request_id: "r-d1", dissolved: true, group_node_id: "g-1", member_ids: ["m1", "m2"] },
      },
    });
    const result = await runExecutor(registry, "canvas.group.dissolve", {
      command: "canvas.group.dissolve",
      project: "demo",
      group: "g-1",
    });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "canvas.group.dissolve") throw new Error("unexpected");
    expect(parsed.dissolved).toBe(true);
    expect(parsed.group_node_id).toBe("g-1");
    expect(parsed.member_ids).toEqual(["m1", "m2"]);
    expect(result.errorCode).toBeNull();
    expect(proxyCalls[0]?.candidate).toMatchObject({ command: "canvas.group.dissolve", group: "g-1" });
  });

  it("canvas.node.move：项目未打开 → project_not_open；有窗口 → 参数原样进候选、结果直通（CLI-028）", async () => {
    const closed = buildRegistry({ windowOpen: false });
    const closedResult = await runExecutor(closed.registry, "canvas.node.move", {
      command: "canvas.node.move",
      project: "demo",
      node: "n-1",
      x: -5,
      y: 6,
    });
    expect(parseResponse(closedResult)).toMatchObject({ ok: false, error: { code: "project_not_open" } });
    expect(closed.proxyCalls).toHaveLength(0);

    const open = buildRegistry({
      windowOpen: true,
      dispatchOutcome: {
        ok: true,
        response: { command: "canvas.node.move", request_id: "r-m1", node_id: "n-1", position: { x: -5, y: 6 }, moved_node_ids: ["n-1"] },
      },
    });
    const openResult = await runExecutor(open.registry, "canvas.node.move", {
      command: "canvas.node.move",
      project: "demo",
      node: "n-1",
      x: -5,
      y: 6,
    });
    const parsed = parseResponse(openResult);
    if (!parsed.ok || parsed.command !== "canvas.node.move") throw new Error("unexpected");
    expect(parsed.node_id).toBe("n-1");
    expect(parsed.position).toEqual({ x: -5, y: 6 });
    expect(parsed.moved_node_ids).toEqual(["n-1"]);
    expect(open.proxyCalls[0]?.candidate).toMatchObject({ command: "canvas.node.move", node: "n-1", x: -5, y: 6 });
  });

  it("canvas.node.delete：项目未打开 → project_not_open；有窗口 → nodes/yes 原样进候选、结果直通（CLI-029）", async () => {
    const closed = buildRegistry({ windowOpen: false });
    const closedResult = await runExecutor(closed.registry, "canvas.node.delete", {
      command: "canvas.node.delete",
      project: "demo",
      nodes: ["n-1"],
    });
    expect(parseResponse(closedResult)).toMatchObject({ ok: false, error: { code: "project_not_open" } });
    expect(closed.proxyCalls).toHaveLength(0);

    const open = buildRegistry({
      windowOpen: true,
      dispatchOutcome: {
        ok: true,
        response: { command: "canvas.node.delete", request_id: "r-x1", deleted: true, deleted_node_ids: ["n-1"] },
      },
    });
    const openResult = await runExecutor(open.registry, "canvas.node.delete", {
      command: "canvas.node.delete",
      project: "demo",
      nodes: ["n-1", "n-2"],
      yes: true,
    });
    const parsed = parseResponse(openResult);
    if (!parsed.ok || parsed.command !== "canvas.node.delete") throw new Error("unexpected");
    expect(parsed.deleted).toBe(true);
    expect(parsed.deleted_node_ids).toEqual(["n-1"]);
    expect(open.proxyCalls[0]?.candidate).toMatchObject({ command: "canvas.node.delete", nodes: ["n-1", "n-2"], yes: true });
  });

  it("generate：项目未打开 → project_not_open（CLI-007，提交前拒绝）", async () => {
    const { registry, proxyCalls } = buildRegistry({ windowOpen: false });
    const result = await runExecutor(registry, "generate", {
      command: "generate",
      project: "demo",
      prompt: "一只猫",
      model: "demo-model",
    });
    expect(parseResponse(result)).toMatchObject({ ok: false, error: { code: "project_not_open" } });
    expect(proxyCalls).toHaveLength(0);
  });

  it("generate：受理结果直通（批次标识 + 任务身份列表），task_results 恒为空数组（wait 由客户端轮询）", async () => {
    const { registry, proxyCalls } = buildRegistry({
      windowOpen: true,
      dispatchOutcome: {
        ok: true,
        response: {
          command: "generate",
          request_id: "r4",
          batch_id: "batch-1",
          tasks: [{ task_id: "t-1", task_index: 0, node_id: null, group_id: null }],
        },
      },
    });
    const result = await runExecutor(registry, "generate", {
      command: "generate",
      project: "demo",
      prompt: "一只猫",
      model: "demo-model",
      count: 1,
      wait: true,
    });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "generate") throw new Error("unexpected");
    expect(parsed.batch_id).toBe("batch-1");
    expect(parsed.tasks).toEqual([{ task_id: "t-1", task_index: 0, node_id: null, group_id: null }]);
    expect(parsed.task_results).toEqual([]);
    expect(proxyCalls[0]?.candidate).toMatchObject({
      command: "generate",
      prompt: "一只猫",
      model: "demo-model",
      count: 1,
      wait: true,
    });
  });
});

// @spec: CLI-049
describe("cli-command-executors canvas.group.add / canvas.group.remove（成员归属）", () => {
  it("项目未打开 → project_not_open（CLI-007），不触达代理通道", async () => {
    const { registry, proxyCalls } = buildRegistry({ windowOpen: false });
    for (const command of ["canvas.group.add", "canvas.group.remove"] as const) {
      const result = await runExecutor(registry, command, {
        command,
        project: "demo",
        group: "g-1",
        members: ["n-1", "n-2"],
      });
      expect(parseResponse(result)).toMatchObject({ ok: false, error: { code: "project_not_open" } });
      expect(result.errorCode).toBe("project_not_open");
    }
    expect(proxyCalls).toHaveLength(0);
  });

  it("有窗口 → group/members 原样进代理候选、加入结果直通", async () => {
    const { registry, proxyCalls } = buildRegistry({
      windowOpen: true,
      dispatchOutcome: {
        ok: true,
        response: {
          command: "canvas.group.add",
          request_id: "r-ga1",
          group_node_id: "g-1",
          added_node_ids: ["n-1"],
          moved_node_ids: ["n-2"],
          unchanged_node_ids: ["n-3"],
        },
      },
    });
    const result = await runExecutor(registry, "canvas.group.add", {
      command: "canvas.group.add",
      project: "demo",
      group: "g-1",
      members: ["n-1", "n-2", "n-3"],
    });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "canvas.group.add") throw new Error("unexpected");
    expect(parsed.group_node_id).toBe("g-1");
    expect(parsed.added_node_ids).toEqual(["n-1"]);
    expect(parsed.moved_node_ids).toEqual(["n-2"]);
    expect(parsed.unchanged_node_ids).toEqual(["n-3"]);
    expect(result.errorCode).toBeNull();
    expect(proxyCalls[0]).toMatchObject({
      projectPath: PROJECT_PATH,
      candidate: { command: "canvas.group.add", group: "g-1", members: ["n-1", "n-2", "n-3"] },
    });
  });

  it("有窗口 → 移出结果直通，Editor 错误码原样透传", async () => {
    const { registry, proxyCalls } = buildRegistry({
      windowOpen: true,
      dispatchOutcome: {
        ok: true,
        response: {
          command: "canvas.group.remove",
          request_id: "r-gr1",
          group_node_id: "g-1",
          removed_node_ids: ["n-1"],
        },
      },
    });
    const result = await runExecutor(registry, "canvas.group.remove", {
      command: "canvas.group.remove",
      project: "demo",
      group: "g-1",
      members: ["n-1"],
    });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "canvas.group.remove") throw new Error("unexpected");
    expect(parsed.removed_node_ids).toEqual(["n-1"]);
    expect(proxyCalls[0]?.candidate).toMatchObject({ command: "canvas.group.remove", group: "g-1" });

    const rejected = buildRegistry({
      windowOpen: true,
      dispatchOutcome: {
        ok: true,
        response: {
          command: "canvas.group.remove",
          request_id: "r-gr2",
          error: { code: "command_rejected", message: "这些节点当前不属于这个组：n-9。" },
        },
      },
    });
    const rejectedResult = await runExecutor(rejected.registry, "canvas.group.remove", {
      command: "canvas.group.remove",
      project: "demo",
      group: "g-1",
      members: ["n-9"],
    });
    expect(parseResponse(rejectedResult)).toMatchObject({
      ok: false,
      error: { code: "command_rejected", message: expect.stringContaining("n-9") },
    });
    expect(rejectedResult.errorCode).toBe("command_rejected");
  });
});

// @spec: CLI-047
describe("cli-command-executors asset.import（素材导入，代理执行通道）", () => {
  it("项目未打开 → project_not_open（CLI-007），不触达代理通道", async () => {
    const { registry, proxyCalls } = buildRegistry({ windowOpen: false });
    const result = await runExecutor(registry, "asset.import", {
      command: "asset.import",
      project: "demo",
      file: ["/tmp/a.png"],
    });
    expect(parseResponse(result)).toMatchObject({ ok: false, error: { code: "project_not_open" } });
    expect(proxyCalls).toHaveLength(0);
    expect(result.errorCode).toBe("project_not_open");
  });

  it("有窗口 → --file 路径清单原样进代理候选，导入结果（imported）直通", async () => {
    const { registry, proxyCalls } = buildRegistry({
      windowOpen: true,
      dispatchOutcome: {
        ok: true,
        response: {
          command: "asset.import",
          request_id: "r-ai-1",
          imported: [
            { file_name: "a.png", asset_id: "asset-1", node_id: "node-1", media_type: "image" },
            { file_name: "b.mp4", asset_id: "asset-2", node_id: "node-2", media_type: "video" },
          ],
        },
      },
    });
    const result = await runExecutor(registry, "asset.import", {
      command: "asset.import",
      project: "demo",
      file: ["/tmp/a.png", "/tmp/b.mp4"],
    });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "asset.import") throw new Error("unexpected");
    expect(parsed.imported).toEqual([
      { file_name: "a.png", asset_id: "asset-1", node_id: "node-1", media_type: "image" },
      { file_name: "b.mp4", asset_id: "asset-2", node_id: "node-2", media_type: "video" },
    ]);
    expect(result.errorCode).toBeNull();
    expect(proxyCalls).toHaveLength(1);
    expect(proxyCalls[0]).toMatchObject({
      projectPath: PROJECT_PATH,
      candidate: { command: "asset.import", file: ["/tmp/a.png", "/tmp/b.mp4"] },
    });
  });

  it("画布窗口侧前置校验错误（file_not_found / unsupported_file_type）错误码与 message 原样透传", async () => {
    const cases = [
      { code: "file_not_found", message: "找不到文件：/tmp/ghost.png" },
      { code: "unsupported_file_type", message: "不支持的文件类型：/tmp/readme.txt" },
    ] as const;
    for (const entry of cases) {
      const { registry } = buildRegistry({
        windowOpen: true,
        dispatchOutcome: {
          ok: true,
          response: {
            command: "asset.import",
            request_id: `r-ai-err-${entry.code}`,
            error: { code: entry.code, message: entry.message },
          },
        },
      });
      const result = await runExecutor(registry, "asset.import", {
        command: "asset.import",
        project: "demo",
        file: ["/tmp/ghost.png"],
      });
      expect(parseResponse(result)).toMatchObject({
        ok: false,
        error: { code: entry.code, message: entry.message },
      });
      expect(result.errorCode).toBe(entry.code);
    }
  });

  it("竞态：守卫后窗口被关闭（dispatch no_window）→ project_not_open", async () => {
    const { registry } = buildRegistry({
      windowOpen: true,
      dispatchOutcome: { ok: false, reason: "no_window", detail: "画布窗口已关闭" },
    });
    const result = await runExecutor(registry, "asset.import", {
      command: "asset.import",
      project: "demo",
      file: ["/tmp/a.png"],
    });
    expect(parseResponse(result)).toMatchObject({ ok: false, error: { code: "project_not_open" } });
    expect(result.errorCode).toBe("project_not_open");
  });
});

describe("cli-command-executors task.cancel 两形态（CLI-012）", () => {
  it("项目已打开 → 代理通道（用户取消链），不触达运行域端点", async () => {
    const { registry, proxyCalls, postCalls } = buildRegistry({
      windowOpen: true,
      dispatchOutcome: {
        ok: true,
        response: { command: "task.cancel", request_id: "r5", accepted: true, task_id: "t-1", cancelled_at: "2026-10-07T00:00:00.000Z" },
      },
    });
    const result = await runExecutor(registry, "task.cancel", {
      command: "task.cancel",
      project: "demo",
      task_id: "t-1",
    });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "task.cancel") throw new Error("unexpected");
    expect(parsed.accepted).toBe(true);
    expect(parsed.task_id).toBe("t-1");
    expect(postCalls).toHaveLength(0);
    expect(proxyCalls).toHaveLength(1);
    expect(proxyCalls[0]?.candidate).toMatchObject({ command: "task.cancel", task_id: "t-1" });
  });

  it("项目未打开 → 运行域取消端点（POST /api/tasks/:id/cancel），响应经契约校验后适配", async () => {
    const { registry, proxyCalls, postCalls } = buildRegistry({
      windowOpen: false,
      postJsonPayload: {
        ok: true,
        payload: { accepted: true, task_id: "t-1", cancelled_at: "2026-10-07T00:00:00.000Z" },
      },
    });
    const result = await runExecutor(registry, "task.cancel", {
      command: "task.cancel",
      project: "demo",
      task_id: "t-1",
    });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "task.cancel") throw new Error("unexpected");
    expect(parsed.accepted).toBe(true);
    expect(parsed.task_id).toBe("t-1");
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.pathname).toBe("/api/tasks/t-1/cancel");
    expect(proxyCalls).toHaveLength(0);
  });

  it("项目未打开 + 端点 404 → command_rejected（任务不存在，与画布侧同语义）", async () => {
    const { registry } = buildRegistry({
      windowOpen: false,
      postJsonPayload: { ok: false, reason: "http_error", status: 404, detail: "backend responded 404" },
    });
    const result = await runExecutor(registry, "task.cancel", {
      command: "task.cancel",
      project: "demo",
      task_id: "ghost",
    });
    expect(parseResponse(result)).toMatchObject({
      ok: false,
      error: { code: "command_rejected", message: expect.stringContaining("找不到任务 ghost") },
    });
  });

  it("项目未打开 + 网络失败 → internal_error；响应形状非法 → internal_error（边界即失败）", async () => {
    const network = buildRegistry({
      windowOpen: false,
      postJsonPayload: { ok: false, reason: "network_error", detail: "conn refused" },
    });
    const networkResult = await runExecutor(network.registry, "task.cancel", {
      command: "task.cancel",
      project: "demo",
      task_id: "t-1",
    });
    expect(parseResponse(networkResult)).toMatchObject({ ok: false, error: { code: "internal_error" } });

    const badShape = buildRegistry({
      windowOpen: false,
      postJsonPayload: { ok: true, payload: { accepted: true, task_id: "" } },
    });
    const badShapeResult = await runExecutor(badShape.registry, "task.cancel", {
      command: "task.cancel",
      project: "demo",
      task_id: "t-1",
    });
    expect(parseResponse(badShapeResult)).toMatchObject({ ok: false, error: { code: "internal_error" } });
  });

  it("竞态：守卫后窗口被关闭（dispatch no_window）→ 回落运行域取消端点", async () => {
    const { registry, proxyCalls, postCalls } = buildRegistry({
      windowOpen: true,
      dispatchOutcome: { ok: false, reason: "no_window", detail: "画布窗口已关闭" },
      postJsonPayload: {
        ok: true,
        payload: { accepted: true, task_id: "t-1", cancelled_at: "2026-10-07T00:00:00.000Z" },
      },
    });
    const result = await runExecutor(registry, "task.cancel", {
      command: "task.cancel",
      project: "demo",
      task_id: "t-1",
    });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "task.cancel") throw new Error("unexpected");
    expect(parsed.accepted).toBe(true);
    expect(proxyCalls).toHaveLength(1);
    expect(postCalls).toHaveLength(1);
  });
});

describe("cli-command-executors app.status 应用状态感知（CLI-020/CLI-021）", () => {
  it("无项目打开 → 空集合且命令成功，不触达代理通道（CLI-020）", async () => {
    const { registry, proxyCalls } = buildRegistry({ openProjects: [] });
    const result = await runExecutor(registry, "app.status", { command: "app.status" });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "app.status") throw new Error("unexpected");
    expect(parsed.opened_projects).toEqual([]);
    expect(result.errorCode).toBeNull();
    expect(proxyCalls).toHaveLength(0);
  });

  it("多项目逐项列出：名称取注册表、焦点按查询时点；未注册项目名称回退路径末段（CLI-020）", async () => {
    const unregisteredPath = join(tmpdir(), "unregistered-proj");
    const { registry, proxyCalls } = buildRegistry({
      openProjects: [
        { projectPath: PROJECT_PATH, focused: false, canvasLoading: false },
        { projectPath: unregisteredPath, focused: true, canvasLoading: false },
      ],
      dispatchOutcome: {
        ok: true,
        response: {
          command: "canvas.selection.get",
          request_id: "r-sel",
          selection: { node_ids: [], annotation_ids: [] },
        },
      },
    });
    const result = await runExecutor(registry, "app.status", { command: "app.status" });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "app.status") throw new Error("unexpected");
    expect(parsed.opened_projects).toEqual([
      { name: "demo", path: PROJECT_PATH, focused: false, selection: { node_ids: [], annotation_ids: [] } },
      { name: "unregistered-proj", path: unregisteredPath, focused: true, selection: { node_ids: [], annotation_ids: [] } },
    ]);
    // 逐窗口只读查询：每个非加载中窗口各分发一条 canvas.selection.get
    expect(proxyCalls).toHaveLength(2);
    expect(proxyCalls[0]).toMatchObject({ projectPath: PROJECT_PATH, candidate: { command: "canvas.selection.get" } });
    expect(proxyCalls[1]).toMatchObject({ projectPath: unregisteredPath, candidate: { command: "canvas.selection.get" } });
  });

  it("选中态分类型直通（node_ids/annotation_ids 原样，spec CLI-021）", async () => {
    const { registry } = buildRegistry({
      openProjects: [{ projectPath: PROJECT_PATH, focused: true, canvasLoading: false }],
      dispatchOutcome: {
        ok: true,
        response: {
          command: "canvas.selection.get",
          request_id: "r-sel",
          selection: { node_ids: ["n-1", "n-2"], annotation_ids: ["a-1"] },
        },
      },
    });
    const result = await runExecutor(registry, "app.status", { command: "app.status" });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "app.status") throw new Error("unexpected");
    expect(parsed.opened_projects[0]).toEqual({
      name: "demo",
      path: PROJECT_PATH,
      focused: true,
      selection: { node_ids: ["n-1", "n-2"], annotation_ids: ["a-1"] },
    });
  });

  it("画布尚未就绪（页面加载中）→ 不分发查询、选中态 null、命令不失败（CLI-021）", async () => {
    const { registry, proxyCalls } = buildRegistry({
      openProjects: [{ projectPath: PROJECT_PATH, focused: false, canvasLoading: true }],
    });
    const result = await runExecutor(registry, "app.status", { command: "app.status" });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "app.status") throw new Error("unexpected");
    expect(parsed.opened_projects).toEqual([
      { name: "demo", path: PROJECT_PATH, focused: false, selection: null },
    ]);
    expect(proxyCalls).toHaveLength(0);
  });

  it("竞态：枚举后窗口被关闭（dispatch no_window）→ 条目如实跳过", async () => {
    const { registry, proxyCalls } = buildRegistry({
      openProjects: [{ projectPath: PROJECT_PATH, focused: true, canvasLoading: false }],
      dispatchOutcome: { ok: false, reason: "no_window", detail: "画布窗口已关闭" },
    });
    const result = await runExecutor(registry, "app.status", { command: "app.status" });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "app.status") throw new Error("unexpected");
    expect(parsed.opened_projects).toEqual([]);
    expect(proxyCalls).toHaveLength(1);
  });

  it("防御：只读查询返回错误响应 → 保留项目条目、选中态 null", async () => {
    const { registry } = buildRegistry({
      openProjects: [{ projectPath: PROJECT_PATH, focused: true, canvasLoading: false }],
      dispatchOutcome: {
        ok: true,
        response: {
          command: "canvas.selection.get",
          request_id: "r-sel",
          error: { code: "internal_error", message: "意外失败" },
        },
      },
    });
    const result = await runExecutor(registry, "app.status", { command: "app.status" });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "app.status") throw new Error("unexpected");
    expect(parsed.opened_projects).toEqual([
      { name: "demo", path: PROJECT_PATH, focused: true, selection: null },
    ]);
  });
});

// @spec: CLI-050
describe("cli-command-executors 生成终态尺寸对照（buildGenerationWarnings 纯函数）", () => {
  const imageAsset = (width: number | null, height: number | null): GenerationWarningAsset => ({
    asset: { mediaType: "image", original: { width, height } },
  });
  const videoAsset: GenerationWarningAsset = {
    asset: { mediaType: "video", original: { width: 640, height: 360 } },
  };
  const multipartRequest = (sizeValue: unknown): { request: Record<string, unknown> } => ({
    request: {
      body: {
        __formData: {
          kind: "form_data_summary",
          fieldCount: 1,
          fields: [{ name: "size", filename: null, contentType: null, hasDataBase64: false, value: sizeValue }],
        },
      },
    },
  });
  const jsonBodyRequest = (sizeValue: unknown): { request: Record<string, unknown> } => ({
    request: { body: { size: sizeValue } },
  });

  it("请求 2560x1440、实际 1903x2560 → 一条 warning（状态与 ok 不参与）", () => {
    const mod = loadExecutorModule();
    const warnings = mod.buildGenerationWarnings(multipartRequest("2560x1440"), [imageAsset(1903, 2560)]);
    expect(warnings).toEqual([
      {
        code: "requested_size_not_honored",
        message: "请求尺寸 2560x1440，实际产出 1903x2560。生成任务已成功，尺寸以实际产物为准。",
        requested_size: "2560x1440",
        actual_sizes: ["1903x2560"],
      },
    ]);
  });

  it("JSON 请求体形态 body.size 同口径；大小写 X 规范化为小写", () => {
    const mod = loadExecutorModule();
    const warnings = mod.buildGenerationWarnings(jsonBodyRequest("2560X1440"), [imageAsset(1903, 2560)]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.requested_size).toBe("2560x1440");
  });

  it("实际尺寸去重并按字典序排序；任一不同即只产出一条", () => {
    const mod = loadExecutorModule();
    const warnings = mod.buildGenerationWarnings(multipartRequest("2560x1440"), [
      imageAsset(1903, 2560),
      imageAsset(2560, 1440),
      imageAsset(1903, 2560),
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.actual_sizes).toEqual(["1903x2560", "2560x1440"]);
    expect(warnings[0]?.message).toContain("1903x2560、2560x1440");
  });

  it("请求尺寸与实际匹配 → 空数组", () => {
    const mod = loadExecutorModule();
    expect(mod.buildGenerationWarnings(multipartRequest("1903x2560"), [imageAsset(1903, 2560)])).toEqual([]);
  });

  it("auto / 档位值 / 非字面量 / 请求缺失 → 空数组", () => {
    const mod = loadExecutorModule();
    expect(mod.buildGenerationWarnings(multipartRequest("auto"), [imageAsset(1903, 2560)])).toEqual([]);
    expect(mod.buildGenerationWarnings(multipartRequest("2k"), [imageAsset(1903, 2560)])).toEqual([]);
    expect(mod.buildGenerationWarnings(jsonBodyRequest("1024"), [imageAsset(1903, 2560)])).toEqual([]);
    expect(mod.buildGenerationWarnings({}, [imageAsset(1903, 2560)])).toEqual([]);
    expect(mod.buildGenerationWarnings({ request: null }, [imageAsset(1903, 2560)])).toEqual([]);
    expect(mod.buildGenerationWarnings({ request: { body: null } }, [imageAsset(1903, 2560)])).toEqual([]);
  });

  it("无图片资产 / 图片缺宽高 / 非图片资产跳过 → 空数组", () => {
    const mod = loadExecutorModule();
    expect(mod.buildGenerationWarnings(multipartRequest("2560x1440"), [])).toEqual([]);
    expect(mod.buildGenerationWarnings(multipartRequest("2560x1440"), [imageAsset(null, null)])).toEqual([]);
    expect(mod.buildGenerationWarnings(multipartRequest("2560x1440"), [videoAsset])).toEqual([]);
  });

  it("请求字段不是 size 时不取该字段", () => {
    const mod = loadExecutorModule();
    const request = {
      body: { __formData: { fields: [{ name: "quality", value: "2560x1440" }] } },
    };
    expect(mod.buildGenerationWarnings(request, [imageAsset(1, 1)])).toEqual([]);
  });
});
