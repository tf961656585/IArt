// @vitest-environment node
// @spec: CLI-001, CLI-002, CLI-014, CLI-015
//
// 控制服务骨架测试：注入临时目录 + 随机端口（port 0），覆盖发现文件写出与 0600 权限、
// 令牌鉴权（缺 token / 错 token / Origin 拒绝）、契约外路由（404/405）、project.list
// 端到端（临时 recent-projects.json fixture 注入）、命令日志形状与参数摘要脱敏、
// 端口回落、IART_CLI_PORT env 覆盖、停止后端口不可达。
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CliCommandLogEntrySchema, CliCommandResponseSchema } from "@iart/contracts/cli-contract";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const serviceEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-control-service.cjs`;

type CliCommandLogEntry = {
  timestamp: string;
  command: string;
  paramsSummary: string;
  status: string;
  durationMs: number;
  errorCode?: string;
};

type ServiceHandle = {
  port: number;
  discoveryFilePath: string;
  stop: () => Promise<void>;
  getCommandLog: () => readonly CliCommandLogEntry[];
};

type ServiceModule = {
  startCliControlService: (options?: {
    port?: number;
    discoveryFilePath?: string;
    readProjects?: () => readonly unknown[];
    version?: string;
  }) => Promise<ServiceHandle>;
  buildParamsSummary: (request: unknown) => string;
};

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
  { nodeGraphId: "ng-2", name: "Second", path: "/tmp/second.iartproj", createdAt: 3, savedAt: 4, lastOpenedAt: 1700000001000 },
];

const postCommand = async (port: number, token: string | null, body: unknown, extraHeaders: Record<string, string> = {}) => {
  const headers: Record<string, string> = { "content-type": "application/json", ...extraHeaders };
  if (token !== null) headers["x-iart-cli-token"] = token;
  return fetch(`http://127.0.0.1:${port}/cli/v1/command`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
};

describe("cli-control-service", () => {
  const tempRoot = join(tmpdir(), `cli-control-service-test-${process.pid}`);
  const discoveryFilePath = join(tempRoot, "cli-runtime.json");
  const fixtureFilePath = join(tempRoot, "recent-projects.json");
  let mod: ServiceModule;
  let handle: ServiceHandle;
  let token: string;

  beforeAll(async () => {
    mkdirSync(tempRoot, { recursive: true });
    // 临时 recent-projects.json fixture：project.list 数据源经 readProjects 注入
    writeFileSync(fixtureFilePath, JSON.stringify(fixtureProjects), "utf-8");
    mod = loadServiceModule();
    handle = await mod.startCliControlService({
      port: 0,
      discoveryFilePath,
      version: "test-1.2.3",
      readProjects: () => JSON.parse(readFileSync(fixtureFilePath, "utf-8")) as FixtureEntry[],
    });
    const discovery = JSON.parse(readFileSync(discoveryFilePath, "utf-8")) as { token: string };
    token = discovery.token;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("发现文件写出且权限 0600，内容含 port/token/pid/version/startedAt（CLI-001）", () => {
    expect(existsSync(discoveryFilePath)).toBe(true);
    const mode = statSync(discoveryFilePath).mode & 0o777;
    expect(mode).toBe(0o600);
    const content = JSON.parse(readFileSync(discoveryFilePath, "utf-8")) as Record<string, unknown>;
    expect(content["port"]).toBe(handle.port);
    expect(typeof content["token"]).toBe("string");
    expect((content["token"] as string).length).toBeGreaterThan(0);
    expect(content["pid"]).toBe(process.pid);
    expect(content["version"]).toBe("test-1.2.3");
    // UTC ISO 8601（仓库时间戳纪律：内部存储一律 UTC）
    expect(content["startedAt"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  it("token 正确请求 200，project.list 返回契约形状且响应过 parse（CLI-001, CLI-014）", async () => {
    const response = await postCommand(handle.port, token, { command: "project.list" });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    // 响应必须经 CliCommandResponseSchema.parse 校验（CLI-014）
    const parsed = CliCommandResponseSchema.parse(body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    if (parsed.command !== "project.list") throw new Error("unexpected command");
    expect(parsed.projects).toHaveLength(2);
    expect(parsed.projects[0]).toEqual({
      name: "演示项目",
      path: "/tmp/demo.iartproj",
      last_opened_at: 1700000000000,
    });
  });

  it("缺失令牌与错误令牌均 401 auth_failed，且不执行命令逻辑、不记命令日志（CLI-002）", async () => {
    const logLengthBefore = handle.getCommandLog().length;
    const missing = await postCommand(handle.port, null, { command: "project.list" });
    expect(missing.status).toBe(401);
    const missingBody = (await missing.json()) as { code: string };
    expect(missingBody.code).toBe("auth_failed");

    const wrong = await postCommand(handle.port, "wrong-token", { command: "project.list" });
    expect(wrong.status).toBe(401);
    const wrongBody = (await wrong.json()) as { code: string };
    expect(wrongBody.code).toBe("auth_failed");

    // 鉴权失败不记入命令日志（只 debug 留痕）：日志长度不因这两次请求变化
    expect(handle.getCommandLog()).toHaveLength(logLengthBefore);
  });

  it("带 Origin 头的请求一律拒绝（即使令牌正确）（CLI-002）", async () => {
    const logLengthBefore = handle.getCommandLog().length;
    const response = await postCommand(handle.port, token, { command: "project.list" }, { origin: "https://evil.example" });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("auth_failed");
    expect(handle.getCommandLog()).toHaveLength(logLengthBefore);
  });

  it("其他方法 405、其他路径 404（契约外行为）", async () => {
    const get = await fetch(`http://127.0.0.1:${handle.port}/cli/v1/command`, {
      method: "GET",
      headers: { "x-iart-cli-token": token },
    });
    expect(get.status).toBe(405);

    const otherPath = await fetch(`http://127.0.0.1:${handle.port}/api/other`, {
      method: "POST",
      headers: { "x-iart-cli-token": token, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(otherPath.status).toBe(404);
  });

  it("成功命令记入命令日志：形状过 CliCommandLogEntrySchema，timestamp 为 UTC ISO（CLI-014）", async () => {
    await postCommand(handle.port, token, { command: "project.list" });
    const log = handle.getCommandLog();
    expect(log.length).toBeGreaterThan(0);
    const entry = log[log.length - 1];
    expect(entry).toBeDefined();
    if (!entry) throw new Error("unreachable");
    const parsed = CliCommandLogEntrySchema.parse(entry);
    expect(parsed.command).toBe("project.list");
    expect(parsed.status).toBe("success");
    expect(parsed.durationMs).toBeGreaterThanOrEqual(0);
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  it("请求体非法 → 400 internal_error 且带诊断线索（CLI-015）", async () => {
    const response = await postCommand(handle.port, token, { command: "no.such.command" });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("internal_error");
    expect(body.message.length).toBeGreaterThan(0);
  });

  it("参数摘要：prompt 只记占位，禁止全文（spec §6.1/§11）；其余键值截断", () => {
    const summary = mod.buildParamsSummary({
      command: "generate",
      project: "/tmp/demo.iartproj",
      prompt: "一段不应出现在日志里的提示词全文",
      model: "some-model",
    });
    expect(summary).toContain("prompt=<prompt 16 chars>");
    expect(summary).not.toContain("提示词全文");
    expect(summary).toContain("project=/tmp/demo.iartproj");
    expect(summary).toContain("model=some-model");
  });

  it("端口被占用时回落随机端口，发现文件仍写出（CLI-001）", async () => {
    const blocker = http.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
    const blockerPort = (blocker.address() as { port: number }).port;
    try {
      const fallbackHandle = await mod.startCliControlService({
        port: blockerPort,
        discoveryFilePath: join(tempRoot, "cli-runtime-fallback.json"),
        version: "test",
        readProjects: () => fixtureProjects,
      });
      try {
        expect(fallbackHandle.port).not.toBe(blockerPort);
        expect(fallbackHandle.port).toBeGreaterThan(0);
        expect(existsSync(join(tempRoot, "cli-runtime-fallback.json"))).toBe(true);
      } finally {
        await fallbackHandle.stop();
      }
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("IART_CLI_PORT env 可覆盖默认端口（开发/测试注入；options.port 优先于 env）", async () => {
    const desired = await listenOnRandomPort();
    const previous = process.env["IART_CLI_PORT"];
    try {
      await desired.close();
      process.env["IART_CLI_PORT"] = String(desired.port);
      const envHandle = await mod.startCliControlService({
        discoveryFilePath: join(tempRoot, "cli-runtime-env.json"),
        version: "test",
        readProjects: () => fixtureProjects,
      });
      try {
        expect(envHandle.port).toBe(desired.port);
      } finally {
        await envHandle.stop();
      }

      // options.port 显式指定时优先于 env
      process.env["IART_CLI_PORT"] = String(desired.port);
      const optionHandle = await mod.startCliControlService({
        port: 0,
        discoveryFilePath: join(tempRoot, "cli-runtime-option.json"),
        version: "test",
        readProjects: () => fixtureProjects,
      });
      try {
        expect(optionHandle.port).not.toBe(desired.port);
      } finally {
        await optionHandle.stop();
      }
    } finally {
      if (previous === undefined) delete process.env["IART_CLI_PORT"];
      else process.env["IART_CLI_PORT"] = previous;
    }
  });

  it("stop() 删除发现文件且端口不再可达", async () => {
    const tempHandle = await mod.startCliControlService({
      port: 0,
      discoveryFilePath: join(tempRoot, "cli-runtime-stop.json"),
      version: "test",
      readProjects: () => fixtureProjects,
    });
    const stopPort = tempHandle.port;
    expect(existsSync(join(tempRoot, "cli-runtime-stop.json"))).toBe(true);
    await tempHandle.stop();
    expect(existsSync(join(tempRoot, "cli-runtime-stop.json"))).toBe(false);
    await expect(fetch(`http://127.0.0.1:${stopPort}/cli/v1/command`, { method: "POST", body: "{}" })).rejects.toThrow();
  });
});

// ---- 辅助：临时占用随机端口（env 覆盖测试用） ---------------------------------

const listenOnRandomPort = (): Promise<{ port: number; close: () => Promise<void> }> =>
  new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
