// @vitest-environment node
//
// main.cts CLI 分支 GPU 防御 pin（无 GPU 环境防 FATAL，2026-10-14 批次）。
// @spec: CLI-025
//
// CLI 分支不建窗口、纯 HTTP 通信，但 main.cts 顶层 import electron 的 app，Chromium browser
// 进程照常初始化并拉起 GPU 进程；无 GPU/容器/远程会话环境下 GPU 进程初始化失败触发
// Chromium LOG(FATAL)「GPU process isn't usable. Goodbye.」杀死整个进程——短命令幸免，
// 等待类轮询（task wait、generate --wait）全灭。修法是 CLI 分支内（app ready 前）三层防御：
// disable-gpu + disable-software-rasterizer 两个 switch + app.disableHardwareAcceleration()。
// 该接线是顺序与位置敏感的源码级事实（开关放错分支会破坏 GUI 渲染），编译器与运行时测试
// 都观测不到，只能源码级断言（风格照抄 cli-main-stdio-wiring.test.mts）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const mainSourcePath = `${workspaceRoot}/apps/desktop-shell/src/main.cts`;
const bootstrapSourcePath = `${workspaceRoot}/apps/desktop-shell/src/desktop-shell-bootstrap.cts`;

const GPU_DEFENSE_STATEMENTS = [
  'app.commandLine.appendSwitch("disable-gpu")',
  'app.commandLine.appendSwitch("disable-software-rasterizer")',
  "app.disableHardwareAcceleration()",
] as const;

describe("main.cts CLI 分支 GPU 防御（CLI-025）", () => {
  const source = readFileSync(mainSourcePath, "utf8");
  const cliBranchIndex = source.indexOf('resolveLaunchMode(process.argv) === "cli"');
  const dynamicImportIndex = source.indexOf('import("./cli/cli-client-main.cjs")');
  const guiBranchIndex = source.indexOf('require("./desktop-shell-bootstrap.cjs")');

  it("三层 GPU 防御各自恰好出现一次，且全部位于 CLI 分支内（动态 import 之前、ready 前生效）", () => {
    expect(cliBranchIndex).toBeGreaterThan(-1);
    expect(dynamicImportIndex).toBeGreaterThan(cliBranchIndex);
    for (const statement of GPU_DEFENSE_STATEMENTS) {
      const first = source.indexOf(statement);
      expect(first, statement).toBeGreaterThan(-1);
      expect(source.indexOf(statement, first + 1), `${statement} 只允许出现一次`).toBe(-1);
      expect(first, statement).toBeGreaterThan(cliBranchIndex);
      expect(first, statement).toBeLessThan(dynamicImportIndex);
    }
  });

  it("GUI 主链不沾染 GPU 开关：GUI 分支（bootstrap require 之后）与 bootstrap 源均无防御语句", () => {
    expect(guiBranchIndex).toBeGreaterThan(dynamicImportIndex);
    for (const statement of GPU_DEFENSE_STATEMENTS) {
      expect(source.indexOf(statement, guiBranchIndex), `${statement} 不得出现在 GUI 分支`).toBe(-1);
      expect(readFileSync(bootstrapSourcePath, "utf8").includes(statement), `${statement} 不得进入 bootstrap（GUI 主链）`).toBe(false);
    }
  });
});
