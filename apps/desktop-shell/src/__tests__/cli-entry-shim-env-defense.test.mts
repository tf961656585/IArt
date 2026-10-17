// @vitest-environment node
// @spec: CLI-024
//
// 命令入口 shim 变量置位测试（ELECTRON_RUN_AS_NODE=1 显式置位，spec §3 / CLI-024；
// 2026-10-14 批次由 0.6.5 的「启动前清除」翻转为「显式置位」）：
// shim 以 ELECTRON_RUN_AS_NODE=1 把应用可执行文件作为纯 Node 运行时启动轻量 CLI 入口脚本
// （spec §4.1 / CLI-025），不注入 --cli、不进入 browser 进程。置位必须覆盖一切外来值
// （agent harness 父环境含该变量从 0.6.5 的「事故」翻转为「正解」）：sh 形态前置赋值
// （赋值只作用于 exec 的子进程环境，exec 替换进程镜像后父 shell 不复存在）、cmd 形态
// set 置 1（等号后无空格），双形态同步；手动注册指引命令（权限失败时的可复制等价动作）
// 与写盘 shim 保持同一内容事实。
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const registrationEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-entry-registration.cjs`;

type RegistrationModule = {
  buildCliEntryShimContent: (deps: {
    appExecPath: string;
    cliEntryScriptPath: string;
    form: "sh" | "cmd";
  }) => string;
  createCliEntryRegistration: (options: {
    targetDirs: readonly string[];
    appExecPath: string;
    cliEntryScriptPath?: string;
    platform?: string;
  }) => {
    registerEntry: () => Promise<{ ok: boolean; entryPath: string; action?: string; message?: string }>;
  };
};

const loadRegistrationModule = (): RegistrationModule =>
  requireDesktop(registrationEntry) as RegistrationModule;

const APP_EXEC = "/Applications/IARTStudio.app/Contents/MacOS/IARTStudio";
const CLI_ENTRY = "/Applications/IARTStudio.app/Contents/Resources/cli/cli-node-entry.cjs";
const WIN_EXEC = "C:\\Program Files\\IARTStudio\\IARTStudio.exe";
const WIN_ENTRY = "C:\\Program Files\\IARTStudio\\resources\\cli\\cli-node-entry.cjs";

let tempRoot = "";

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "cli-entry-shim-env-"));
});

describe("shim 启动形态显式置位 ELECTRON_RUN_AS_NODE=1（CLI-024）", () => {
  it("sh 形态：ELECTRON_RUN_AS_NODE=1 前置赋值先于 exec；不再注入 --cli、不再清除变量", () => {
    const content = loadRegistrationModule().buildCliEntryShimContent({
      appExecPath: APP_EXEC,
      cliEntryScriptPath: CLI_ENTRY,
      form: "sh",
    });
    const assignmentIndex = content.indexOf("ELECTRON_RUN_AS_NODE=1 exec ");
    const execIndex = content.indexOf("exec ");
    expect(content.startsWith("#!/bin/sh\n")).toBe(true);
    expect(assignmentIndex).toBeGreaterThan(-1);
    expect(execIndex).toBeGreaterThan(assignmentIndex);
    // 置位而非清除：0.6.5 的 unset 形态不得回归
    expect(content).not.toContain("unset ELECTRON_RUN_AS_NODE");
    // 轻量入口形态不注入 --cli（入口脚本自身即 CLI 客户端，spec §4.1 / CLI-025）
    expect(content).not.toContain("--cli");
    expect(content).toContain(`"${APP_EXEC}"`);
    expect(content).toContain(`"${CLI_ENTRY}"`);
    expect(content.endsWith(`"$@"\n`)).toBe(true);
  });

  it("Windows 双形态同步：sh 前置赋值先于 exec；cmd set 置 1 先于调用行", () => {
    const build = loadRegistrationModule().buildCliEntryShimContent;

    const shContent = build({ appExecPath: WIN_EXEC, cliEntryScriptPath: WIN_ENTRY, form: "sh" });
    const shAssignmentIndex = shContent.indexOf("ELECTRON_RUN_AS_NODE=1 exec ");
    const shExecIndex = shContent.indexOf("exec ");
    expect(shAssignmentIndex).toBeGreaterThan(-1);
    expect(shExecIndex).toBeGreaterThan(shAssignmentIndex);
    expect(shContent).not.toContain("unset ELECTRON_RUN_AS_NODE");
    expect(shContent).not.toContain("--cli");

    const cmdContent = build({ appExecPath: WIN_EXEC, cliEntryScriptPath: WIN_ENTRY, form: "cmd" });
    // cmd 语法：set "VAR=1" 等号后不能带空格；置位语句先于应用调用行（@ 前缀抑制回显）
    const cmdSetIndex = cmdContent.indexOf('set "ELECTRON_RUN_AS_NODE=1"');
    const cmdInvokeIndex = cmdContent.indexOf(`@"${WIN_EXEC}" "${WIN_ENTRY}"`);
    expect(cmdSetIndex).toBeGreaterThan(-1);
    expect(cmdInvokeIndex).toBeGreaterThan(cmdSetIndex);
    // 置位而非清除：0.6.5 的置空形态（set "ELECTRON_RUN_AS_NODE="）不得回归
    expect(cmdContent).not.toContain('ELECTRON_RUN_AS_NODE="');
    expect(cmdContent).not.toContain("--cli");
    expect(cmdContent.endsWith("%*\r\n")).toBe(true);
  });

  it("一键注册落盘 shim 与手动注册指引均含置位语句（同一内容事实）", async () => {
    const targetDir = join(tempRoot, "win-bin");
    // 路径替身不可能在本机真实存在；本用例目的在 shim 落盘内容（CLI-024），探测替身放行
    // （探测语义本体由 cli-entry-registration.test 的 CLI-037 组用真实 stat 覆盖）。
    const registration = loadRegistrationModule().createCliEntryRegistration({
      targetDirs: [targetDir],
      appExecPath: WIN_EXEC,
      cliEntryScriptPath: WIN_ENTRY,
      platform: "win32",
      probeEntryResource: async () => true,
    });
    const result = await registration.registerEntry();
    expect(result.ok).toBe(true);

    const shContent = readFileSync(join(targetDir, "iart"), "utf8");
    const assignmentIndex = shContent.indexOf("ELECTRON_RUN_AS_NODE=1 exec ");
    expect(assignmentIndex).toBeGreaterThan(-1);
    expect(shContent.indexOf("exec ")).toBeGreaterThan(assignmentIndex);

    const cmdContent = readFileSync(join(targetDir, "iart.cmd"), "utf8");
    expect(cmdContent.indexOf('set "ELECTRON_RUN_AS_NODE=1"')).toBeGreaterThan(-1);
  });
});
