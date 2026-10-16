// @vitest-environment node
// @spec: CLI-007, CLI-012, CLI-014, CLI-015, CLI-020, CLI-021, CLI-027, CLI-028, CLI-029, CLI-030
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
