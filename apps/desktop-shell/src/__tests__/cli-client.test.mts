// @vitest-environment node
// @spec: CLI-001, CLI-004, CLI-014, CLI-015
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

  it("未知参数 → 退出码 2 + 用法提示；未知命令 → 退出码 2", async () => {
    const unknownFlag = await client.runCliClient(["project", "list", "--bogus"], { discoveryFilePath });
    expect(unknownFlag.exitCode).toBe(2);
    expect(unknownFlag.stderr).toContain("未知参数");
    expect(unknownFlag.stderr).toContain("iart project list");

    const unknownCommand = await client.runCliClient(["bogus", "command"], { discoveryFilePath });
    expect(unknownCommand.exitCode).toBe(2);
    expect(unknownCommand.stderr).toContain("无法识别的命令");
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
