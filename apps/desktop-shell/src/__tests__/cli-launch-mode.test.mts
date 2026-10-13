// @vitest-environment node
// @spec: CLI-003
// 覆盖范围说明：本文件只测 --cli 分流判定（可测部分）；「CLI 进程不获取单实例锁、
// 不创建任何窗口、执行完命令后退出」的完整行为留真机验收，测试不覆盖。
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);

type LaunchMode = "gui" | "cli";
type LaunchModeModule = {
  resolveLaunchMode: (argv: readonly string[]) => LaunchMode;
};

const loadModule = (): LaunchModeModule =>
  requireDesktop(`${workspaceRoot}/apps/desktop-shell/dist/cli/launch-mode.cjs`) as LaunchModeModule;

describe("resolveLaunchMode（--cli 启动分流）", () => {
  const mod = loadModule();

  it("argv 含 --cli → cli（--cli 之后参数全归 CLI 客户端）", () => {
    expect(mod.resolveLaunchMode(["--cli", "project", "list"])).toBe("cli");
  });

  it("打包形态 argv：二进制与 app 路径在前、--cli 在中段 → cli", () => {
    expect(mod.resolveLaunchMode(["/Applications/IARTStudio.app/Contents/MacOS/IARTStudio", "/Applications/IARTStudio.app/Contents/Resources/app.asar", "--cli", "project", "list"])).toBe("cli");
  });

  it("dev 形态 argv：electron 入口 + app 目录 + --cli → cli", () => {
    expect(mod.resolveLaunchMode(["/usr/local/bin/electron", ".", "--cli", "model", "list"])).toBe("cli");
  });

  it("argv 不含 --cli → gui", () => {
    expect(mod.resolveLaunchMode(["/usr/local/bin/electron", "."])).toBe("gui");
    expect(mod.resolveLaunchMode([])).toBe("gui");
  });

  it("--clip 等近似前缀不命中（按数组元素精确匹配）", () => {
    expect(mod.resolveLaunchMode(["--clip", "project", "list"])).toBe("gui");
  });

  it("--cli 出现在任意位置都命中", () => {
    expect(mod.resolveLaunchMode(["project", "list", "--json", "--cli"])).toBe("cli");
  });
});
