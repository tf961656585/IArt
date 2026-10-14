// @vitest-environment node
//
// main.cts CLI 兼容分支 GPU 防御 pin（spec §4.1 / CLI-025，2026-10-14 修订）。
// @spec: CLI-025
//
// 进程形态翻转后（shim 以 ELECTRON_RUN_AS_NODE=1 启动轻量纯 Node 入口 cli-node-entry.cjs），
// 主形态的 CLI 进程根本不存在 Chromium browser 进程，GPU FATAL 结构性消失。main.cts 的
// `--cli` 分支保留为存量旧 shim（0.6.5/0.6.6）的兼容窗口：该分支仍以完整 Electron 启动，
// 需要 GPU 防御——`disable-gpu` + `app.disableHardwareAcceleration()` 两层；**不得**再注入
// `disable-software-rasterizer`：v0.6.5 真机实证该组合是自伤配置（disable-gpu 压掉全部硬件
// fallback、disable-software-rasterizer 压掉 SOFTWARE_GL fallback → fallback 链空 → Chromium
// `IntentionallyCrashBrowserForUnusableGpuProcess()` 故意 FATAL）。保留 software GL fallback
// 后 GPU 进程总能初始化。该接线是顺序与位置敏感的源码级事实（开关放错分支会破坏 GUI 渲染、
// 自伤开关回归会让兼容分支重新 FATAL），编译器与运行时测试都观测不到，只能源码级断言
//（风格照抄 cli-main-stdio-wiring.test.mts）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const mainSourcePath = `${workspaceRoot}/apps/desktop-shell/src/main.cts`;
const bootstrapSourcePath = `${workspaceRoot}/apps/desktop-shell/src/desktop-shell-bootstrap.cts`;

const GPU_DEFENSE_STATEMENTS = [
  'app.commandLine.appendSwitch("disable-gpu")',
  "app.disableHardwareAcceleration()",
] as const;

/** 自伤开关：与 disable-gpu 组合会清空 GPU fallback 链，触发 Chromium 故意 FATAL（v0.6.5 实证）。 */
const SELF_WOUNDING_SWITCH = 'app.commandLine.appendSwitch("disable-software-rasterizer")';

describe("main.cts CLI 兼容分支 GPU 防御（CLI-025）", () => {
  const source = readFileSync(mainSourcePath, "utf8");
  const cliBranchIndex = source.indexOf('resolveLaunchMode(process.argv) === "cli"');
  const dynamicImportIndex = source.indexOf('import("./cli/cli-client-main.cjs")');
  const guiBranchIndex = source.indexOf('require("./desktop-shell-bootstrap.cjs")');

  it("两层 GPU 防御各自恰好出现一次，且全部位于 CLI 兼容分支内（动态 import 之前、ready 前生效）", () => {
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

  it("自伤开关 disable-software-rasterizer 已摘除：全文件不得再出现（fallback 链空 → 故意 FATAL）", () => {
    expect(source.includes(SELF_WOUNDING_SWITCH), "disable-software-rasterizer 不得回归（自伤配置）").toBe(false);
  });

  it("GUI 主链不沾染 GPU 开关：GUI 分支（bootstrap require 之后）与 bootstrap 源均无防御语句", () => {
    expect(guiBranchIndex).toBeGreaterThan(dynamicImportIndex);
    for (const statement of GPU_DEFENSE_STATEMENTS) {
      expect(source.indexOf(statement, guiBranchIndex), `${statement} 不得出现在 GUI 分支`).toBe(-1);
      expect(readFileSync(bootstrapSourcePath, "utf8").includes(statement), `${statement} 不得进入 bootstrap（GUI 主链）`).toBe(false);
    }
    expect(readFileSync(bootstrapSourcePath, "utf8").includes(SELF_WOUNDING_SWITCH)).toBe(false);
  });
});
