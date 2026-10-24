// @vitest-environment node
// @spec: CLI-001, CLI-004, CLI-014, CLI-015, CLI-027, CLI-028, CLI-029, CLI-030, CLI-049, CLI-050
//
// CLI 客户端 ↔ 真实控制服务：启动真实 cli-control-service 发真实请求，
// 覆盖 --json/人读输出、退出码三档、not_running（发现文件缺失 / 指向无监听端口）、
// 响应被篡改成非法形状 → 退出码 2、未知参数与未知命令 → 退出码 2 + 用法提示、
// project delete 缺 --yes 在发送前本地报错、分派未命中命令返回 internal_error、
// 以及 --help / 命令级 --help / 名词级 --help 输出。
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CliCommandResponseSchema } from "@iart/contracts/cli-contract";
import {
  type ClientModule,
  type ServiceHandle,
  fixtureProjects,
  loadClientModule,
  loadServiceModule,
  writeDiscoveryFile,
} from "./cli-client.helpers.mts";

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

  // @spec: CLI-041
  it("命令不消费的参数按用法错误拒绝：task list / app status 的 --limit 退出码 2 并附单行用法指引", async () => {
    for (const argv of [
      ["task", "list", "--project", "P", "--limit", "2"],
      ["app", "status", "--limit", "2"],
    ]) {
      const result = await client.runCliClient(argv, { discoveryFilePath });
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("不适用于命令");
      expect(result.stderr).toContain("用法见 iart --help");
      // 与既有解析失败口径一致：不全量倾倒用法提示
      expect(result.stderr).not.toContain("退出码：");
    }
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

  // @spec: CLI-041
  it("命令级 --help 输出该命令自己的参数说明（不是顶层用法表），退出码 0", async () => {
    const topLevel = await client.runCliClient(["--help"], { discoveryFilePath });
    const commandHelp = await client.runCliClient(["task", "list", "--help"], { discoveryFilePath });
    expect(commandHelp.exitCode).toBe(0);
    expect(commandHelp.stderr).toBe("");
    expect(commandHelp.stdout).toContain("iart task list —");
    expect(commandHelp.stdout).toContain("--status <状态>");
    expect(commandHelp.stdout).toContain("submitting|generating|polling|downloading|succeeded|failed|cancelled");
    expect(commandHelp.stdout).not.toBe(topLevel.stdout);
    expect(commandHelp.stdout).not.toContain("iart project list");
  });

  // @spec: CLI-041
  it("名词级 --help 输出该名词下的子命令摘要，退出码 0", async () => {
    const result = await client.runCliClient(["canvas", "--help"], { discoveryFilePath });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("iart canvas —");
    expect(result.stdout).toContain("子命令：");
    expect(result.stdout).toContain("iart canvas group create");
    expect(result.stdout).toContain("创建组并加入成员");
    // 顶层总表独有的退出码说明不出现在名词级帮助里
    expect(result.stdout).not.toContain("退出码：");
  });

  // @spec: CLI-041
  it("两级名词 --help（canvas nodes / canvas node / canvas group）均以 0 退出并列出子命令", async () => {
    const cases: Array<{ argv: string[]; expectText: string }> = [
      { argv: ["canvas", "nodes", "--help"], expectText: "iart canvas nodes list" },
      { argv: ["canvas", "node", "--help"], expectText: "iart canvas node move" },
      { argv: ["canvas", "group", "--help"], expectText: "iart canvas group rename" },
    ];
    for (const item of cases) {
      const result = await client.runCliClient(item.argv, { discoveryFilePath });
      expect(result.exitCode, item.argv.join(" ")).toBe(0);
      expect(result.stderr, item.argv.join(" ")).toBe("");
      expect(result.stdout, item.argv.join(" ")).toContain(item.expectText);
      expect(result.stdout, item.argv.join(" ")).not.toContain("无法识别的命令");
    }
  });
});
