// @vitest-environment node
// @spec: CLI-001, CLI-004, CLI-014, CLI-015, CLI-027, CLI-028, CLI-029, CLI-030
//
// CLI 客户端测试：对真实控制服务发真实请求（--json/人读输出、退出码三档）、
// not_running（发现文件缺失 / 指向无监听端口）、响应被篡改成非法形状 → 退出码 2、
// 未知参数与未知命令 → 退出码 2 + 用法提示、project delete 缺 --yes 在发送前本地报错、
// 分派未命中命令返回 internal_error、参数解析映射表（--ref/--arg/--scope/位置参数）。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CliCommandResponseSchema } from "@iart/contracts/cli-contract";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const clientEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-client.cjs`;
const parserEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-arg-parser.cjs`;
const serviceEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-control-service.cjs`;

type CliClientRunResult = { exitCode: number; stdout: string; stderr: string };

type ClientModule = {
  runCliClient: (
    argv: readonly string[],
    deps?: { discoveryFilePath?: string; fetchImpl?: typeof fetch },
  ) => Promise<CliClientRunResult>;
};

type ParserModule = {
  parseCliArgs: (argv: readonly string[]) =>
    | { ok: true; request: unknown; json: boolean }
    | { ok: false; help: boolean; message?: string };
  CLI_USAGE_TEXT: string;
};

type ServiceHandle = {
  port: number;
  discoveryFilePath: string;
  stop: () => Promise<void>;
  getCommandLog: () => readonly unknown[];
};

type ServiceModule = {
  startCliControlService: (options?: {
    port?: number;
    discoveryFilePath?: string;
    readProjects?: () => readonly unknown[];
    version?: string;
  }) => Promise<ServiceHandle>;
};

const loadClientModule = (): ClientModule => requireDesktop(clientEntry) as ClientModule;
const loadParserModule = (): ParserModule => requireDesktop(parserEntry) as ParserModule;
const loadServiceModule = (): ServiceModule => requireDesktop(serviceEntry) as ServiceModule;

type FixtureEntry = {
  nodeGraphId: string;
  name: string;
  path: string;
  createdAt: number;
  savedAt: number;
  lastOpenedAt: number;
};

const fixtureProjects: FixtureEntry[] = [
  { nodeGraphId: "ng-1", name: "演示项目", path: "/tmp/demo.iartproj", createdAt: 1, savedAt: 2, lastOpenedAt: 1700000000000 },
];

const writeDiscoveryFile = (filePath: string, content: Record<string, unknown>): void => {
  writeFileSync(filePath, JSON.stringify(content, null, 2), { encoding: "utf-8", mode: 0o600 });
};

describe("cli-client（对真实控制服务）", () => {
  const tempRoot = join(tmpdir(), `cli-client-test-${process.pid}`);
  const discoveryFilePath = join(tempRoot, "cli-runtime.json");
  let client: ClientModule;
  let handle: ServiceHandle;
  let token: string;

  beforeAll(async () => {
    mkdirSync(tempRoot, { recursive: true });
    client = loadClientModule();
    const service = loadServiceModule();
    handle = await service.startCliControlService({
      port: 0,
      discoveryFilePath,
      version: "test-1.2.3",
      readProjects: () => fixtureProjects,
    });
    const discovery = JSON.parse(readFileSync(discoveryFilePath, "utf-8")) as { token: string };
    token = discovery.token;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("--json 模式：stdout 输出契约 JSON 且过 parse，退出码 0（CLI-001, CLI-014）", async () => {
    const result = await client.runCliClient(["project", "list", "--json"], { discoveryFilePath });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = CliCommandResponseSchema.parse(JSON.parse(result.stdout));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.command !== "project.list") throw new Error("unreachable");
    expect(parsed.projects).toHaveLength(1);
    expect(parsed.projects[0]?.name).toBe("演示项目");
  });

  it("人读模式：输出简要中文结果，退出码 0", async () => {
    const result = await client.runCliClient(["project", "list"], { discoveryFilePath });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("项目清单共 1 个");
    expect(result.stdout).toContain("演示项目");
  });

  it("发现文件缺失 → not_running：人读启动提示 + 退出码 1，不自动启动应用（CLI-004）", async () => {
    const missingPath = join(tempRoot, "missing.json");
    const human = await client.runCliClient(["project", "list"], { discoveryFilePath: missingPath });
    expect(human.exitCode).toBe(1);
    expect(human.stderr).toContain("未在运行");

    const asJson = await client.runCliClient(["project", "list", "--json"], { discoveryFilePath: missingPath });
    expect(asJson.exitCode).toBe(1);
    const body = JSON.parse(asJson.stdout) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("not_running");
  });

  it("发现文件指向无监听端口（陈旧文件）→ not_running + 退出码 1（CLI-004）", async () => {
    // 取一个确定空闲的端口：先监听拿端口再关闭
    const stale = await new Promise<{ port: number; close: () => void }>((resolve) => {
      const server = http.createServer();
      server.listen(0, "127.0.0.1", () => {
        resolve({
          port: (server.address() as { port: number }).port,
          close: () => server.close(),
        });
      });
    });
    stale.close();
    const stalePath = join(tempRoot, "cli-runtime-stale.json");
    writeDiscoveryFile(stalePath, {
      port: stale.port,
      token: "stale-token",
      pid: process.pid,
      version: "test",
      startedAt: new Date().toISOString(),
    });
    const result = await client.runCliClient(["project", "list"], { discoveryFilePath: stalePath });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("未在运行");
  });

  it("响应被篡改成非法形状 → 契约校验失败，退出码 2（CLI-014）", async () => {
    const tampered = await new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
      const server = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ command: "project.list", ok: true, projects: "not-an-array" }));
      });
      server.listen(0, "127.0.0.1", () => {
        resolve({
          port: (server.address() as { port: number }).port,
          close: () =>
            new Promise<void>((resolveClose) => {
              server.close(() => resolveClose());
            }),
        });
      });
    });
    const tamperedPath = join(tempRoot, "cli-runtime-tampered.json");
    writeDiscoveryFile(tamperedPath, {
      port: tampered.port,
      token,
      pid: process.pid,
      version: "test",
      startedAt: new Date().toISOString(),
    });
    try {
      const result = await client.runCliClient(["project", "list", "--json"], { discoveryFilePath: tamperedPath });
      expect(result.exitCode).toBe(2);
      const body = JSON.parse(result.stdout) as { ok: boolean; error: { code: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("internal_error");
    } finally {
      await tampered.close();
    }
  });

  it("未知参数 → 退出码 2 + 单行用法指引（CLI-041 收敛）；未知命令 → 退出码 2", async () => {
    const unknownFlag = await client.runCliClient(["project", "list", "--bogus"], { discoveryFilePath });
    expect(unknownFlag.exitCode).toBe(2);
    expect(unknownFlag.stderr).toContain("未知参数");
    expect(unknownFlag.stderr).toContain("用法见 iart --help");
    // CLI-041：解析失败不再全量倾倒用法提示（用法提示只在 --help 输出）
    expect(unknownFlag.stderr).not.toContain("退出码：");

    const unknownCommand = await client.runCliClient(["bogus", "command"], { discoveryFilePath });
    expect(unknownCommand.exitCode).toBe(2);
    expect(unknownCommand.stderr).toContain("无法识别的命令");
    expect(unknownCommand.stderr).toContain("用法见 iart --help");
  });

  it("project delete 缺 --yes → 发送前 schema 校验本地报错，退出码 2（CLI-014）", async () => {
    const result = await client.runCliClient(["project", "delete", "--project", "X"], { discoveryFilePath });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--yes");
    // 构造错误不发起请求：服务端命令日志不应新增 project.delete 记录
    const logCommands = handle
      .getCommandLog()
      .map((entry) => (entry as { command: string }).command);
    expect(logCommands).not.toContain("project.delete");
  });

  it("分派未命中的命令返回 internal_error（退出码 1，批次一仅接入 project.list）（CLI-015）", async () => {
    const result = await client.runCliClient(["model", "get", "some-model", "--json"], { discoveryFilePath });
    expect(result.exitCode).toBe(1);
    const body = JSON.parse(result.stdout) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("internal_error");
  });

  it("--help 输出用法提示，退出码 0", async () => {
    const result = await client.runCliClient(["--help"], { discoveryFilePath });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("iart project list");
  });
});

describe("parseCliArgs（参数名 → 契约字段映射表）", () => {
  const parser = loadParserModule();

  it("generate：--count/--wait/--ref 逗号拆分/--arg k=v 拆分", () => {
    const parsed = parser.parseCliArgs([
      "generate",
      "--project",
      "P",
      "--prompt",
      "T",
      "--model",
      "M",
      "--count",
      "2",
      "--ref",
      "a,b",
      "--arg",
      "k=v,k2=v2",
      "--wait",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.request).toEqual({
      command: "generate",
      project: "P",
      prompt: "T",
      model: "M",
      count: 2,
      ref: ["a", "b"],
      arg: [
        { key: "k", value: "v" },
        { key: "k2", value: "v2" },
      ],
      wait: true,
    });
  });

  // @spec: CLI-033
  it("generate：--request-id 映射为契约 client_request_id（受理幂等键）", () => {
    const parsed = parser.parseCliArgs([
      "generate",
      "--project",
      "P",
      "--prompt",
      "T",
      "--model",
      "M",
      "--request-id",
      "req-abc",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.request).toMatchObject({ command: "generate", client_request_id: "req-abc" });
  });

  // @spec: CLI-034
  it("task list：--status/--since/--request-id 解析为契约过滤字段；缺省时字段缺省", () => {
    const filtered = parser.parseCliArgs([
      "task",
      "list",
      "--project",
      "P",
      "--status",
      "failed",
      "--since",
      "2026-10-14T00:00:00Z",
      "--request-id",
      "req-1",
    ]);
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) throw new Error("unreachable");
    expect(filtered.request).toEqual({
      command: "task.list",
      project: "P",
      status: "failed",
      since: "2026-10-14T00:00:00Z",
      client_request_id: "req-1",
    });

    // 缺省：契约 default 物化为不过滤语义（旧客户端兼容）
    const bare = parser.parseCliArgs(["task", "list", "--project", "P"]);
    expect(bare.ok).toBe(true);
    if (!bare.ok) throw new Error("unreachable");
    expect(bare.request).toEqual({
      command: "task.list",
      project: "P",
      status: null,
      since: null,
      client_request_id: null,
    });

    // 非法 status：契约枚举在发送前校验失败（本地报参数错误）
    const badStatus = parser.parseCliArgs(["task", "list", "--project", "P", "--status", "bogus"]);
    expect(badStatus.ok).toBe(false);
  });

  it("canvas layout：--scope group:<id> 映射为 { group } 对象形态，--columns 解析为数字", () => {
    const parsed = parser.parseCliArgs(["canvas", "layout", "--project", "P", "--scope", "group:g1", "--columns", "3"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.request).toEqual({
      command: "canvas.layout",
      project: "P",
      scope: { group: "g1" },
      columns: 3,
    });
  });

  it("canvas layout：--scope all 映射为字面量", () => {
    const parsed = parser.parseCliArgs(["canvas", "layout", "--project", "P", "--scope", "all"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect((parsed.request as { scope: unknown }).scope).toBe("all");
  });

  it("位置参数：model get <model_id>、task wait <taskId>", () => {
    const modelGet = parser.parseCliArgs(["model", "get", "gpt-image-2"]);
    expect(modelGet.ok).toBe(true);
    if (!modelGet.ok) throw new Error("unreachable");
    expect(modelGet.request).toEqual({ command: "model.get", model_id: "gpt-image-2" });

    const taskWait = parser.parseCliArgs(["task", "wait", "task-1", "--project", "P", "--timeout", "30"]);
    expect(taskWait.ok).toBe(true);
    if (!taskWait.ok) throw new Error("unreachable");
    expect(taskWait.request).toEqual({
      command: "task.wait",
      project: "P",
      task_id: "task-1",
      timeout: 30,
    });
  });

  it("canvas group create：--members 逗号拆分为数组", () => {
    const parsed = parser.parseCliArgs(["canvas", "group", "create", "--project", "P", "--name", "G", "--members", "n1,n2"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.request).toEqual({
      command: "canvas.group.create",
      project: "P",
      name: "G",
      members: ["n1", "n2"],
    });
  });

  it("canvas group dissolve：--group 解析为契约 group 字段（CLI-027）", () => {
    const parsed = parser.parseCliArgs(["canvas", "group", "dissolve", "--project", "P", "--group", "g1"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.request).toEqual({
      command: "canvas.group.dissolve",
      project: "P",
      group: "g1",
    });

    const missing = parser.parseCliArgs(["canvas", "group", "dissolve", "--project", "P"]);
    expect(missing.ok).toBe(false);
  });

  it("canvas node move：--node/--x/--y 解析，坐标允许负数与小数（CLI-028）", () => {
    const parsed = parser.parseCliArgs(["canvas", "node", "move", "--project", "P", "--node", "n1", "--x", "-120", "--y", "240.5"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.request).toEqual({
      command: "canvas.node.move",
      project: "P",
      node: "n1",
      x: -120,
      y: 240.5,
    });

    const inline = parser.parseCliArgs(["canvas", "node", "move", "--project=P", "--node=n1", "--x=3", "--y=-4"]);
    expect(inline.ok).toBe(true);
    if (!inline.ok) throw new Error("unreachable");
    expect(inline.request).toEqual({ command: "canvas.node.move", project: "P", node: "n1", x: 3, y: -4 });

    const notNumber = parser.parseCliArgs(["canvas", "node", "move", "--project", "P", "--node", "n1", "--x", "abc", "--y", "1"]);
    expect(notNumber.ok).toBe(false);

    const missingY = parser.parseCliArgs(["canvas", "node", "move", "--project", "P", "--node", "n1", "--x", "1"]);
    expect(missingY.ok).toBe(false);
  });

  it("canvas node delete：--nodes 逗号拆分为数组，缺参报错（CLI-029）", () => {
    const parsed = parser.parseCliArgs(["canvas", "node", "delete", "--project", "P", "--nodes", "n1,n2"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.request).toEqual({
      command: "canvas.node.delete",
      project: "P",
      nodes: ["n1", "n2"],
    });

    const repeated = parser.parseCliArgs(["canvas", "node", "delete", "--project", "P", "--nodes", "n1", "--nodes", "n2"]);
    expect(repeated.ok).toBe(true);
    if (!repeated.ok) throw new Error("unreachable");
    expect(repeated.request).toEqual({ command: "canvas.node.delete", project: "P", nodes: ["n1", "n2"] });

    const missing = parser.parseCliArgs(["canvas", "node", "delete", "--project", "P"]);
    expect(missing.ok).toBe(false);
  });

  it("canvas layout：--order 逗号拆分为显式顺序数组（CLI-030）", () => {
    const parsed = parser.parseCliArgs(["canvas", "layout", "--project", "P", "--scope", "group:g1", "--order", "m3,m1,m2"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.request).toEqual({
      command: "canvas.layout",
      project: "P",
      scope: { group: "g1" },
      order: ["m3", "m1", "m2"],
    });

    // 缺省不带 --order：请求形状与既有行为完全一致（默认排序行为不变）
    const bare = parser.parseCliArgs(["canvas", "layout", "--project", "P", "--scope", "all"]);
    expect(bare.ok).toBe(true);
    if (!bare.ok) throw new Error("unreachable");
    expect(bare.request).toEqual({ command: "canvas.layout", project: "P", scope: "all" });
  });

  it("asset import：--file 重复累积为数组且含逗号路径不拆分；缺 --file/--project 报错", () => {
    const parsed = parser.parseCliArgs([
      "asset",
      "import",
      "--project",
      "P",
      "--file",
      "/tmp/a.png",
      "--file",
      "/tmp/b,c.mp4",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.request).toEqual({
      command: "asset.import",
      project: "P",
      // 路径可合法含逗号：--file 是 pathList 语义（整项累积），不做逗号拆分
      file: ["/tmp/a.png", "/tmp/b,c.mp4"],
    });

    // 内联 = 形态（--file=<路径>、--project=P）
    const inline = parser.parseCliArgs(["asset", "import", "--project=P", "--file=/tmp/x=y.png"]);
    expect(inline.ok).toBe(true);
    if (!inline.ok) throw new Error("unreachable");
    expect(inline.request).toEqual({ command: "asset.import", project: "P", file: ["/tmp/x=y.png"] });

    const missingFile = parser.parseCliArgs(["asset", "import", "--project", "P"]);
    expect(missingFile.ok).toBe(false);
    if (missingFile.ok) throw new Error("unreachable");
    expect(missingFile.message).toContain("--file");
    const missingProject = parser.parseCliArgs(["asset", "import", "--file", "/tmp/a.png"]);
    expect(missingProject.ok).toBe(false);
    expect(parser.CLI_USAGE_TEXT).toContain("iart asset import");
  });

  it("布尔 flag 与带值参数区分：--wait=x 报错、缺值报错、未知参数报错", () => {
    const boolWithValue = parser.parseCliArgs(["generate", "--wait=x"]);
    expect(boolWithValue.ok).toBe(false);

    const missingValue = parser.parseCliArgs(["generate", "--model"]);
    expect(missingValue.ok).toBe(false);

    const unknown = parser.parseCliArgs(["generate", "--nope", "x"]);
    expect(unknown.ok).toBe(false);
  });

  it("app status：无参数解析为 app.status 请求；多余位置参数被拒（spec §5.5）", () => {
    const parsed = parser.parseCliArgs(["app", "status"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.request).toEqual({ command: "app.status" });

    const extra = parser.parseCliArgs(["app", "status", "extra"]);
    expect(extra.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 人读失败原因透传与 generate 受理幂等键回执（fetchImpl 注入固定响应，CLI-033/CLI-035）
// ---------------------------------------------------------------------------

describe("cli-client 人读失败原因与幂等键回执（fetchImpl 注入）", () => {
  const client = loadClientModule();
  const discoveryFilePath = join(tmpdir(), `cli-client-idem-${process.pid}`, "cli-runtime.json");

  beforeAll(() => {
    mkdirSync(join(tmpdir(), `cli-client-idem-${process.pid}`), { recursive: true });
    writeDiscoveryFile(discoveryFilePath, {
      port: 59999,
      token: "unused-injected-fetch",
      pid: process.pid,
      version: "test-1.0.0",
      startedAt: new Date().toISOString(),
    });
  });

  const jsonResponse = (payload: unknown): Response =>
    new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });

  // @spec: CLI-035
  it("task get 人读：终态失败任务输出失败原因，超 200 字符截断", async () => {
    const longMessage = "很长的失败说明。".repeat(40); // 320 字符
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        command: "task.get",
        ok: true,
        task: {
          taskId: "task-f-1",
          status: "failed",
          projectPath: "/tmp/p",
          createdAt: 1,
          updatedAt: 2,
          errorCode: "PUBLIC_ERROR_DEMO",
          errorMessage: longMessage,
        },
        node_id: null,
        group_id: null,
      });
    const result = await client.runCliClient(["task", "get", "task-f-1", "--project", "P"], {
      discoveryFilePath,
      fetchImpl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("task-f-1");
    expect(result.stdout).toContain("failed");
    expect(result.stdout).toContain("失败原因：[PUBLIC_ERROR_DEMO]");
    // 截断：人读行只保留首 200 字符 + 省略号，不整段倾倒
    expect(result.stdout).toContain(longMessage.slice(0, 200));
    expect(result.stdout).not.toContain(longMessage.slice(0, 201));
  });

  // @spec: CLI-035
  it("task get 人读：errorMessage 缺省回落 failure.userMessage；非失败任务不输出原因行", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        command: "task.get",
        ok: true,
        task: {
          taskId: "task-f-2",
          status: "failed",
          projectPath: "/tmp/p",
          createdAt: 1,
          updatedAt: 2,
          failure: { code: "UPSTREAM_5XX", userMessage: "服务商暂时不可用，请稍后重试。" },
        },
        node_id: null,
        group_id: null,
      });
    const result = await client.runCliClient(["task", "get", "task-f-2", "--project", "P"], {
      discoveryFilePath,
      fetchImpl,
    });
    expect(result.stdout).toContain("失败原因：[UPSTREAM_5XX] 服务商暂时不可用，请稍后重试。");

    const okFetch: typeof fetch = async () =>
      jsonResponse({
        command: "task.get",
        ok: true,
        task: { taskId: "task-ok", status: "succeeded", projectPath: "/tmp/p", createdAt: 1, updatedAt: 2 },
        node_id: null,
        group_id: null,
      });
    const okResult = await client.runCliClient(["task", "get", "task-ok", "--project", "P"], {
      discoveryFilePath,
      fetchImpl: okFetch,
    });
    expect(okResult.stdout).not.toContain("失败原因");
  });

  // @spec: CLI-035
  it("task list 人读：失败任务行内联失败原因，成功任务行不带", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        command: "task.list",
        ok: true,
        tasks: [
          { taskId: "t-ok", status: "succeeded", projectPath: "/tmp/p", createdAt: 1, updatedAt: 2 },
          {
            taskId: "t-bad",
            status: "failed",
            projectPath: "/tmp/p",
            createdAt: 1,
            updatedAt: 2,
            errorMessage: "参数越界",
          },
        ],
      });
    const result = await client.runCliClient(["task", "list", "--project", "P"], {
      discoveryFilePath,
      fetchImpl,
    });
    expect(result.stdout).toContain("t-ok：succeeded");
    expect(result.stdout).toContain("t-bad：failed，失败原因：参数越界");
  });

  // @spec: CLI-033
  it("generate 非 --wait：未显式传 --request-id 时客户端自动生成 uuid 并在回执回显", async () => {
    const requestBodies: unknown[] = [];
    // 假服务端按真实链路语义把请求携带的幂等键回显进受理响应（真实链路中该回显经
    // 画布窗口纯入口从 intent 原样返回）。
    const fetchImpl: typeof fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { client_request_id?: string };
      requestBodies.push(body);
      return jsonResponse({
        command: "generate",
        ok: true,
        batch_id: "batch-auto-1",
        tasks: [{ task_id: "task-auto-1", task_index: 0, node_id: null, group_id: null }],
        replayed: false,
        ...(body.client_request_id !== undefined ? { client_request_id: body.client_request_id } : {}),
        task_results: [],
      });
    }) as typeof fetch;
    const result = await client.runCliClient(["generate", "--project", "P", "--prompt", "T", "--model", "M"], {
      discoveryFilePath,
      fetchImpl,
    });
    expect(result.exitCode).toBe(0);
    const requestBody = requestBodies[0] as { client_request_id?: string };
    expect(typeof requestBody.client_request_id).toBe("string");
    expect(requestBody.client_request_id?.length).toBeGreaterThan(10);
    // 回执回显幂等键
    expect(result.stdout).toContain("幂等键");
    expect(result.stdout).toContain(requestBody.client_request_id ?? "");
  });

  // @spec: CLI-033
  it("generate 非 --wait：显式 --request-id 原样透传；命中重放时人读回执说明未重复创建", async () => {
    const requestBodies: unknown[] = [];
    const fetchImpl: typeof fetch = (async (_url, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as unknown);
      return jsonResponse({
        command: "generate",
        ok: true,
        batch_id: "batch-replay-1",
        tasks: [{ task_id: "task-replay-1", task_index: 0, node_id: null, group_id: null }],
        client_request_id: "req-explicit-1",
        replayed: true,
        task_results: [],
      });
    }) as typeof fetch;
    const result = await client.runCliClient(
      ["generate", "--project", "P", "--prompt", "T", "--model", "M", "--request-id", "req-explicit-1"],
      { discoveryFilePath, fetchImpl },
    );
    expect(result.exitCode).toBe(0);
    expect(requestBodies[0]).toMatchObject({ client_request_id: "req-explicit-1" });
    expect(result.stdout).toContain("req-explicit-1");
    expect(result.stdout).toContain("未重复创建");
  });
});

// ---------------------------------------------------------------------------
// asset import 人读渲染（fetchImpl 注入固定响应）
// ---------------------------------------------------------------------------

// @spec: CLI-047
describe("cli-client 人读渲染 asset import（fetchImpl 注入）", () => {
  const client = loadClientModule();
  const tempRoot = join(tmpdir(), `cli-client-import-${process.pid}`);
  const discoveryFilePath = join(tempRoot, "cli-runtime.json");

  beforeAll(() => {
    mkdirSync(tempRoot, { recursive: true });
    writeDiscoveryFile(discoveryFilePath, {
      port: 59999,
      token: "unused-injected-fetch",
      pid: process.pid,
      version: "test-1.0.0",
      startedAt: new Date().toISOString(),
    });
  });

  const jsonResponse = (payload: unknown): Response =>
    new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });

  it("人读：逐文件输出文件名/媒体类型/资产标识/节点标识，不倾倒原始 JSON", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        command: "asset.import",
        ok: true,
        imported: [
          { file_name: "a.png", asset_id: "asset-1", node_id: "node-1", media_type: "image" },
          { file_name: "b.mp4", asset_id: "asset-2", node_id: "node-2", media_type: "video" },
        ],
      });
    const result = await client.runCliClient(
      ["asset", "import", "--project", "P", "--file", "/tmp/a.png", "--file", "/tmp/b.mp4"],
      { discoveryFilePath, fetchImpl },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("已导入 2 个文件");
    expect(result.stdout).toContain("a.png（image）：资产 asset-1，画布节点 node-1");
    expect(result.stdout).toContain("b.mp4（video）：资产 asset-2，画布节点 node-2");
    // 人读输出不是 JSON dump
    expect(result.stdout).not.toContain('"file_name"');
    expect(result.stdout).not.toContain("[{");
  });

  it("人读：画布窗口侧前置校验错误（file_not_found）原样透传，退出码 1", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        command: "asset.import",
        ok: false,
        error: { code: "file_not_found", message: "找不到文件：/tmp/ghost.png" },
      });
    const result = await client.runCliClient(
      ["asset", "import", "--project", "P", "--file", "/tmp/ghost.png"],
      { discoveryFilePath, fetchImpl },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("找不到文件：/tmp/ghost.png");
  });
});
