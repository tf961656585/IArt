// @vitest-environment node
//
// CLI 轻量纯 Node 入口行为测试（spec §4.1 / CLI-025，2026-10-14 进程形态翻转批次）。
// @spec: CLI-025
//
// 真实形态验证：以 ELECTRON_RUN_AS_NODE=1 把 Electron 可执行文件作为纯 Node 运行时启动
// 编译产物 dist/cli/cli-node-entry.cjs（与生产 shim 同一启动形态）——browser 进程不存在，
// 退出码由入口直接承载。另以源码级断言 pin 入口的形态边界（不 import electron、不调用
// prepareCliStdio、flush 落定后才显式退出）。
//
// 只用不依赖应用在役的命令（--help / 未知命令）：应用在役与否会随真机环境漂移，不进测试。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const requireFromTest = createRequire(import.meta.url);
const entryPath = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-node-entry.cjs`;
const entrySourcePath = `${workspaceRoot}/apps/desktop-shell/src/cli/cli-node-entry.cts`;
const clientMainPath = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-client-main.cjs`;

/** require("electron") 在纯 Node 进程里返回应用可执行文件路径（electron 包的 bin 解析结果）。 */
const resolveElectronBinary = (): string => {
  const resolved: unknown = requireFromTest("electron");
  if (typeof resolved !== "string" || resolved.length === 0) {
    throw new Error("无法解析 Electron 可执行文件路径：require('electron') 未返回字符串");
  }
  return resolved;
};
const electronBinary = resolveElectronBinary();

const runEntryAsNode = (args: readonly string[]): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(electronBinary, [entryPath, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

describe("CLI 轻量纯 Node 入口（CLI-025）", () => {
  it("编译产物存在（desktop-shell build 覆盖 dist/cli/cli-node-entry.cjs）", () => {
    expect(existsSync(entryPath)).toBe(true);
    expect(existsSync(clientMainPath)).toBe(true);
  });

  it("真实形态（ELECTRON_RUN_AS_NODE=1 + Electron exe）：--help 退出码 0 且用法提示完整落 stdout、stderr 无 Chromium 噪声", () => {
    const result = runEntryAsNode(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("iart — 驱动 IARTStudio 的命令行入口");
    expect(result.stderr).toBe("");
  });

  it("真实形态：未知命令退出码 2（0/1/2 契约由入口直接承载，不依赖 browser 进程）", () => {
    const result = runEntryAsNode(["no-such-command"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("无法识别的命令");
  });

  it("形态边界 pin：入口不 import electron、不调用 prepareCliStdio、argv 从 2 起切、flush 落定后显式退出", () => {
    const source = readFileSync(entrySourcePath, "utf8");
    expect(source.includes('from "electron"')).toBe(false);
    expect(source.includes('require("electron")')).toBe(false);
    expect(source.includes("prepareCliStdio")).toBe(false);
    // shim argv 形态 [exe, 入口, ...用户参数]：用户参数自 index 2 起
    expect(source).toContain("process.argv.slice(2)");
    // 客户端模块经 runCliClientMain（flush 序列在其中完成）返回后才显式退出
    const awaitRunIndex = source.indexOf("await clientMain.runCliClientMain");
    const exitIndex = source.indexOf("process.exit(exitCode)");
    expect(awaitRunIndex).toBeGreaterThan(-1);
    expect(exitIndex).toBeGreaterThan(awaitRunIndex);
  });

  it("形态边界 pin：打包态定位走 app.asar 内编译产物、dev 态走同级产物", () => {
    const source = readFileSync(entrySourcePath, "utf8");
    expect(source).toContain('"app.asar"');
    expect(source).toContain("cli-client-main.cjs");
  });
});
