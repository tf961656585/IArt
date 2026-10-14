// @vitest-environment node
// @spec: CLI-024
//
// 命令入口 shim 环境防御测试（ELECTRON_RUN_AS_NODE 清除，spec §3 / CLI-024）：
// 父进程环境含 ELECTRON_RUN_AS_NODE=1（agent harness 常见形态）时，Electron 二进制退化为
// 纯 Node 运行时，`--cli` 被 Node argv 解析拒绝（bad option，exit 9）。shim 必须在启动应用
// 前清除该变量：sh 形态 exec 前 unset、cmd 形态调用前 set 置空，双形态同步；手动注册指引
// 命令（权限失败时的可复制等价动作）与写盘 shim 保持同一内容事实。
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
    appExecArgs: readonly string[];
    form: "sh" | "cmd";
  }) => string;
  createCliEntryRegistration: (options: {
    targetDir: string;
    appExecPath: string;
    appExecArgs?: readonly string[];
    platform?: string;
  }) => {
    registerEntry: () => Promise<{ ok: boolean; entryPath: string; action?: string; message?: string }>;
  };
};

const loadRegistrationModule = (): RegistrationModule =>
  requireDesktop(registrationEntry) as RegistrationModule;

const APP_EXEC = "/Applications/IARTStudio.app/Contents/MacOS/IARTStudio";
const WIN_EXEC = "C:\\Program Files\\IARTStudio\\IARTStudio.exe";

let tempRoot = "";

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "cli-entry-shim-env-"));
});

describe("shim 启动前清除 ELECTRON_RUN_AS_NODE（CLI-024）", () => {
  it("sh 形态：unset 语句位于 exec 之前（macOS 单形态）", () => {
    const content = loadRegistrationModule().buildCliEntryShimContent({
      appExecPath: APP_EXEC,
      appExecArgs: [],
      form: "sh",
    });
    const unsetIndex = content.indexOf("unset ELECTRON_RUN_AS_NODE");
    const execIndex = content.indexOf("exec ");
    expect(unsetIndex).toBeGreaterThan(-1);
    expect(execIndex).toBeGreaterThan(unsetIndex);
    expect(content).toContain("--cli");
  });

  it("Windows 双形态同步：sh 形态 unset 在 exec 前；cmd 形态 set 置空在调用前", () => {
    const build = loadRegistrationModule().buildCliEntryShimContent;

    const shContent = build({ appExecPath: WIN_EXEC, appExecArgs: [], form: "sh" });
    const shUnsetIndex = shContent.indexOf("unset ELECTRON_RUN_AS_NODE");
    const shExecIndex = shContent.indexOf("exec ");
    expect(shUnsetIndex).toBeGreaterThan(-1);
    expect(shExecIndex).toBeGreaterThan(shUnsetIndex);

    const cmdContent = build({ appExecPath: WIN_EXEC, appExecArgs: [], form: "cmd" });
    // cmd 语法：set "VAR=" 等号后不能带空格；清除语句先于应用调用行（@ 前缀抑制回显）
    const cmdClearIndex = cmdContent.indexOf('set "ELECTRON_RUN_AS_NODE="');
    const cmdInvokeIndex = cmdContent.indexOf(`@"${WIN_EXEC}"`);
    expect(cmdClearIndex).toBeGreaterThan(-1);
    expect(cmdInvokeIndex).toBeGreaterThan(cmdClearIndex);
  });

  it("一键注册落盘 shim 与手动注册指引均含清除语句（同一内容事实）", async () => {
    const targetDir = join(tempRoot, "win-bin");
    const registration = loadRegistrationModule().createCliEntryRegistration({
      targetDir,
      appExecPath: WIN_EXEC,
      appExecArgs: [],
      platform: "win32",
    });
    const result = await registration.registerEntry();
    expect(result.ok).toBe(true);

    const shContent = readFileSync(join(targetDir, "iart"), "utf8");
    const unsetIndex = shContent.indexOf("unset ELECTRON_RUN_AS_NODE");
    expect(unsetIndex).toBeGreaterThan(-1);
    expect(shContent.indexOf("exec ")).toBeGreaterThan(unsetIndex);

    const cmdContent = readFileSync(join(targetDir, "iart.cmd"), "utf8");
    expect(cmdContent.indexOf('set "ELECTRON_RUN_AS_NODE="')).toBeGreaterThan(-1);
  });
});
