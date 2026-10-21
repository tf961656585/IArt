// @vitest-environment node
// @spec: CLI-043, CLI-044, CLI-045, CLI-046, CLI-049
//
// CLI 出生组与组织面补齐 · 主进程侧执行器测试（spec docs/integrations/CLI与本地Agent集成.md
// §5.2 group list / §5.4 --group 与画布投影身份 / §5.3 空组建组）：
// - canvas.group.list：存储只读投影（项目未打开也可用），组/容器清单 + 成员计数；
// - generate：--group 原样透传代理通道（Editor 侧解析与出生入组）；
// - task get / task wait：终态输出按 task_id join 画布投影身份（node_id/group_id，null 不伪造）。
// 契约纪律：请求经 CliCommandRequestSchema.parse、响应经 CliCommandResponseSchema.parse。
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CliCommandRequestSchema, CliCommandResponseSchema } from "@iart/contracts";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const executorsEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-command-executors.cjs`;
const argParserEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-arg-parser.cjs`;

type ExecutorResult = { response: unknown; errorCode: string | null };
type Executor = (request: unknown) => ExecutorResult | Promise<ExecutorResult>;
type Registry = Map<string, Executor>;

type ExecutorModule = { createCliCommandExecutors: (deps: Record<string, unknown>) => Registry };

const loadExecutorModule = (): ExecutorModule => requireDesktop(executorsEntry) as ExecutorModule;

const parseResponse = (result: ExecutorResult) => CliCommandResponseSchema.parse(result.response);

const PROJECT_PATH = join(tmpdir(), `cli-group-ops-${process.pid}`);

const taskView = (taskId: string, status: string) => ({
  taskId,
  status,
  projectPath: PROJECT_PATH,
  batchId: "batch_g",
  createdAt: 1,
  updatedAt: 2,
});

const nodePayload = (over: Record<string, unknown>): unknown => ({
  id: over.id as string,
  type: over.type,
  position: { x: 0, y: 0 },
  ...over,
});

const buildRegistry = (overrides: {
  windowOpen?: boolean;
  canvasPayloads?: unknown[];
  forwarderPayload?: unknown;
  forwarderSequence?: Array<{ ok: boolean; payload?: unknown; status?: number } | null>;
  dispatchResponse?: Record<string, unknown> | null;
} = {}): { registry: Registry; proxyCalls: Array<{ projectPath: string; candidate: Record<string, unknown> }> } => {
  const proxyCalls: Array<{ projectPath: string; candidate: Record<string, unknown> }> = [];
  let callIndex = 0;
  const mod = loadExecutorModule();
  const registry = mod.createCliCommandExecutors({
    readProjects: () => [
      { nodeGraphId: "ng-1", name: "demo", path: PROJECT_PATH, createdAt: 1, savedAt: 2, lastOpenedAt: 3 },
    ],
    windows: {
      openOrFocus: async () => ({ ok: true }),
      hasOpenWindow: () => overrides.windowOpen ?? true,
      closeByProjectPath: () => true,
      listOpenEditorProjects: () => [],
    },
    forwarder: {
      getJson: async () => {
        const injected =
          overrides.forwarderSequence !== undefined
            ? (overrides.forwarderSequence[callIndex++] ?? null)
            : { ok: true, payload: overrides.forwarderPayload ?? { task: taskView("task_1", "succeeded") } };
        if (injected === null) return { ok: true, payload: {} };
        if (injected.ok) return { ok: true, payload: injected.payload ?? {} };
        return {
          ok: false,
          reason: "http_error",
          ...(injected.status !== undefined ? { status: injected.status } : {}),
          detail: "x",
        };
      },
      postJson: async () => ({ ok: true, payload: {} }),
    },
    storage: {
      createProject: () => ({ projectPath: PROJECT_PATH }),
      deleteProject: () => undefined,
      touchProjectOpenedAt: () => undefined,
      readMediaAssets: () => [],
      readMediaAssetById: () => null,
      readAssetTaskIndex: () => new Map(),
      readAssetGenerationIndex: () => new Map(),
      readTaskOutputAssets: () => [],
      readCanvasNodePayloads: () => overrides.canvasPayloads ?? [],
      readTaskById: () => null,
      readTaskViewsByBatchId: () => [],
      readBatchByClientRequestId: () => null,
      readBatchById: () => null,
    },
    proxy: {
      dispatch: async (projectPath: string, candidate: Record<string, unknown>) => {
        proxyCalls.push({ projectPath, candidate });
        const response = overrides.dispatchResponse;
        if (response === null) return { ok: false, reason: "no_window", detail: "no canvas window for project" };
        return { ok: true, response: response ?? { command: "generate", request_id: "ignored", batch_id: "batch_g", tasks: [] } };
      },
    },
    pollIntervalMs: 1,
  });
  return { registry, proxyCalls };
};

const runExecutor = async (registry: Registry, command: string, request: unknown): Promise<ExecutorResult> => {
  const executor = registry.get(command);
  if (executor === undefined) throw new Error(`executor missing: ${command}`);
  return await executor(CliCommandRequestSchema.parse(request));
};

describe("canvas group list（CLI-045 存储只读投影）", () => {
  it("组/容器清单与成员计数：组名、Agent 容器 label、空容器计数 0；项目未打开也可用", async () => {
    const { registry } = buildRegistry({
      windowOpen: false,
      canvasPayloads: [
        nodePayload({ id: "grp_1", type: "group", data: { name: "分镜" } }),
        nodePayload({ id: "grp_2", type: "group", data: { name: "" } }),
        nodePayload({ id: "agent_1", type: "agent", data: { label: "助理" } }),
        nodePayload({ id: "n1", type: "asset", groupId: "grp_1", data: { assetId: "a1" } }),
        nodePayload({ id: "n2", type: "task", groupId: "grp_1", data: { taskId: "task_9" } }),
        nodePayload({ id: "n3", type: "imageInput", groupId: "agent_1", data: { assetId: "a2" } }),
      ],
    });
    const result = await runExecutor(registry, "canvas.group.list", {
      command: "canvas.group.list",
      project: "demo",
    });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "canvas.group.list") throw new Error("unexpected");
    expect(parsed.groups).toEqual([
      { group_node_id: "grp_1", name: "分镜", type: "group", member_count: 2 },
      { group_node_id: "grp_2", name: "", type: "group", member_count: 0 },
      { group_node_id: "agent_1", name: "助理", type: "agent_container", member_count: 1 },
    ]);
    expect(result.errorCode).toBeNull();
  });

  it("项目库不可用（未知项目）→ project_not_found，不输出伪造空清单", async () => {
    const { registry } = buildRegistry({ canvasPayloads: [] });
    const result = await runExecutor(registry, "canvas.group.list", {
      command: "canvas.group.list",
      project: "ghost",
    });
    const parsed = parseResponse(result);
    if (parsed.ok) throw new Error("expected error response");
    expect(parsed.error.code).toBe("project_not_found");
  });
});

describe("generate --group 透传（CLI-043）", () => {
  it("--group 组名原样透传代理通道；受理回执 node_id/group_id 原样回传", async () => {
    const { registry, proxyCalls } = buildRegistry({
      windowOpen: true,
      dispatchResponse: {
        command: "generate",
        request_id: "ignored",
        batch_id: "batch_g",
        tasks: [{ task_id: "task_1", task_index: 0, node_id: "node_t1", group_id: "grp_1" }],
        replayed: false,
      },
    });
    const result = await runExecutor(registry, "generate", {
      command: "generate",
      project: "demo",
      prompt: "一只猫",
      model: "model-a",
      group: "分镜",
    });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "generate") throw new Error("unexpected");
    expect(parsed.tasks[0]).toMatchObject({ task_id: "task_1", node_id: "node_t1", group_id: "grp_1" });
    expect(proxyCalls[0]?.candidate).toMatchObject({ command: "generate", group: "分镜" });
  });

  it("未指定 --group：候选不带 group 字段；出生组缺省 group_id 为 null 的回执原样透传", async () => {
    const { registry, proxyCalls } = buildRegistry({
      windowOpen: true,
      dispatchResponse: {
        command: "generate",
        request_id: "ignored",
        batch_id: "batch_g",
        tasks: [{ task_id: "task_1", task_index: 0, node_id: "node_t1", group_id: null }],
      },
    });
    const result = await runExecutor(registry, "generate", {
      command: "generate",
      project: "demo",
      prompt: "一只猫",
      model: "model-a",
    });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "generate") throw new Error("unexpected");
    expect(parsed.tasks[0]).toMatchObject({ node_id: "node_t1", group_id: null });
    expect(proxyCalls[0]?.candidate).not.toHaveProperty("group");
  });
});

describe("任务画布投影身份 join（CLI-046）", () => {
  it("task get：按 task_id 关联 node_id/group_id；无投影输出 null（缺省不伪造）", async () => {
    const { registry } = buildRegistry({
      canvasPayloads: [nodePayload({ id: "node_t1", type: "task", groupId: "grp_1", data: { taskId: "task_1" } })],
      forwarderPayload: { task: taskView("task_1", "succeeded") },
    });
    const joined = await runExecutor(registry, "task.get", {
      command: "task.get",
      project: "demo",
      task_id: "task_1",
    });
    const parsedJoined = parseResponse(joined);
    if (!parsedJoined.ok || parsedJoined.command !== "task.get") throw new Error("unexpected");
    expect(parsedJoined.node_id).toBe("node_t1");
    expect(parsedJoined.group_id).toBe("grp_1");

    const unmatched = await runExecutor(registry, "task.get", {
      command: "task.get",
      project: "demo",
      task_id: "task_ghost",
    });
    const parsedUnmatched = parseResponse(unmatched);
    if (!parsedUnmatched.ok || parsedUnmatched.command !== "task.get") throw new Error("unexpected");
    expect(parsedUnmatched.node_id).toBeNull();
    expect(parsedUnmatched.group_id).toBeNull();
  });

  it("task wait：终态 task_result 携带 node_id/group_id", async () => {
    const { registry } = buildRegistry({
      canvasPayloads: [nodePayload({ id: "node_t1", type: "task", groupId: "grp_1", data: { taskId: "task_1" } })],
      forwarderPayload: { task: taskView("task_1", "succeeded") },
    });
    const result = await runExecutor(registry, "task.wait", {
      command: "task.wait",
      project: "demo",
      task_id: "task_1",
    });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "task.wait") throw new Error("unexpected");
    expect(parsed.task_result.node_id).toBe("node_t1");
    expect(parsed.task_result.group_id).toBe("grp_1");
  });
});

describe("arg parser（CLI-043/CLI-044/CLI-045）", () => {
  const parser = requireDesktop(argParserEntry) as { parseCliArgs: (argv: string[]) => unknown };

  it("canvas group list 命令短语与 --project 解析", () => {
    const parsed = parser.parseCliArgs(["canvas", "group", "list", "--project", "demo"]) as {
      ok: boolean;
      request?: { command: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.request).toMatchObject({ command: "canvas.group.list", project: "demo" });
  });

  it("generate --group 映射契约 group 字段；缺省不携带", () => {
    const withGroup = parser.parseCliArgs(["generate", "--prompt", "猫", "--model", "m", "--group", "分镜", "--project", "demo"]) as {
      ok: boolean;
      request?: { command: string; group?: string };
    };
    expect(withGroup.request).toMatchObject({ command: "generate", group: "分镜" });
    const withoutGroup = parser.parseCliArgs(["generate", "--prompt", "猫", "--model", "m", "--project", "demo"]) as {
      ok: boolean;
      request?: { command: string; group?: string };
    };
    expect(withoutGroup.request).toMatchObject({ command: "generate" });
    expect(withoutGroup.request).not.toHaveProperty("group");
  });

  it("canvas group add/remove 命令短语、--group 与 --members 解析（CLI-049）", () => {
    for (const action of ["add", "remove"] as const) {
      const parsed = parser.parseCliArgs([
        "canvas", "group", action, "--group", "g1", "--members", "n1,n2", "--project", "demo",
      ]) as { ok: boolean; request?: { command: string; group?: string; members?: string[] } };
      expect(parsed.ok).toBe(true);
      expect(parsed.request).toMatchObject({
        command: `canvas.group.${action}`,
        project: "demo",
        group: "g1",
        members: ["n1", "n2"],
      });
    }
  });

  it("canvas group create 零成员（省略 --members）可通过解析（CLI-044）", () => {
    const parsed = parser.parseCliArgs(["canvas", "group", "create", "--name", "空组", "--project", "demo"]) as {
      ok: boolean;
      request?: { command: string; members?: string[] };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.request).toMatchObject({ command: "canvas.group.create", name: "空组", members: [] });
  });
});
