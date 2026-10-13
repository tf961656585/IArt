// @vitest-environment node
// @spec: CLI-016
//
// 命令入口注册模块测试（spec docs/integrations/CLI与本地Agent集成.md §3/§8）：
// shim 注入 --cli（sh 与 cmd 两形态）、写入目标目录可注入（临时目录）、
// 幂等三态（created/overwritten/noop）、卸除仅删本应用 shim（不删同名他物）、状态三态查询。
import { createRequire } from "node:module";
import { mkdtempSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const registrationEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-entry-registration.cjs`;

type RegisterResult =
  | { ok: true; entryPath: string; action: "created" | "overwritten" | "noop" }
  | { ok: false; entryPath: string; message: string };
type UnregisterResult =
  | { ok: true; entryPath: string; removed: boolean; reason: "removed" | "absent" | "foreign_content" }
  | { ok: false; entryPath: string; message: string };
type StatusResult =
  | { supported: true; entryPath: string; registered: boolean; state: "registered" | "missing" | "modified" }
  | { supported: false };

type RegistrationModule = {
  createCliEntryRegistration: (options: {
    targetDir: string;
    appExecPath: string;
    appExecArgs: readonly string[];
    platform?: string;
  }) => {
    registerEntry: () => Promise<RegisterResult>;
    unregisterEntry: () => Promise<UnregisterResult>;
    getEntryStatus: () => Promise<StatusResult>;
  };
};

const loadRegistrationModule = (): RegistrationModule =>
  requireDesktop(registrationEntry) as RegistrationModule;

const APP_EXEC = "/Applications/IARTStudio.app/Contents/MacOS/IARTStudio";

const makeRegistration = (options: {
  targetDir: string;
  platform: string;
  appExecArgs?: readonly string[];
  appExecPath?: string;
}) =>
  loadRegistrationModule().createCliEntryRegistration({
    targetDir: options.targetDir,
    appExecPath: options.appExecPath ?? APP_EXEC,
    appExecArgs: options.appExecArgs ?? [],
    platform: options.platform,
  });

let tempRoot = "";

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "cli-entry-registration-"));
});

describe("cli-entry-registration 命令入口注册（CLI-016）", () => {
  it("macOS：sh shim 注入 --cli，写入目标目录并 chmod 0755", async () => {
    const targetDir = join(tempRoot, "mac-bin");
    const registration = makeRegistration({ targetDir, platform: "darwin" });
    const result = await registration.registerEntry();
    expect(result).toMatchObject({ ok: true, action: "created" });
    if (!result.ok) throw new Error("unexpected");
    const entryPath = join(targetDir, "iart");
    expect(result.entryPath).toBe(entryPath);
    expect(existsSync(entryPath)).toBe(true);
    const content = readFileSync(entryPath, "utf8");
    expect(content).toBe(`#!/bin/sh\nexec "${APP_EXEC}" --cli "$@"\n`);
    expect(content).toContain("--cli");
    expect((statSync(entryPath).mode & 0o777)).toBe(0o755);
  });

  it("dev 形态：shim 指向 Electron 可执行文件 + 应用入口参数 + --cli", async () => {
    const targetDir = join(tempRoot, "dev-bin");
    const electronBin = "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
    const appPath = "/repo/apps/desktop-shell/dist/main.cjs";
    const registration = makeRegistration({
      targetDir,
      platform: "darwin",
      appExecPath: electronBin,
      appExecArgs: [appPath],
    });
    const result = await registration.registerEntry();
    expect(result.ok).toBe(true);
    const content = readFileSync(join(targetDir, "iart"), "utf8");
    expect(content).toBe(`#!/bin/sh\nexec "${electronBin}" "${appPath}" --cli "$@"\n`);
  });

  it("幂等：重复注册 no-op；内容被改动后重注册覆盖（接管 iart 名字）", async () => {
    const targetDir = join(tempRoot, "idempotent-bin");
    const registration = makeRegistration({ targetDir, platform: "darwin" });
    const first = await registration.registerEntry();
    expect(first).toMatchObject({ ok: true, action: "created" });

    const second = await registration.registerEntry();
    expect(second).toMatchObject({ ok: true, action: "noop" });

    const entryPath = join(targetDir, "iart");
    writeFileSync(entryPath, "#!/bin/sh\necho hijacked\n", { encoding: "utf8" });
    const third = await registration.registerEntry();
    expect(third).toMatchObject({ ok: true, action: "overwritten" });
    expect(readFileSync(entryPath, "utf8")).toContain("--cli");
  });

  it("状态查询三态：registered / missing / modified", async () => {
    const targetDir = join(tempRoot, "status-bin");
    const registration = makeRegistration({ targetDir, platform: "darwin" });

    const missing = await registration.getEntryStatus();
    expect(missing).toMatchObject({ supported: true, registered: false, state: "missing" });

    await registration.registerEntry();
    const registered = await registration.getEntryStatus();
    expect(registered).toMatchObject({ supported: true, registered: true, state: "registered" });

    writeFileSync(join(targetDir, "iart"), "echo something-else\n", { encoding: "utf8" });
    const modified = await registration.getEntryStatus();
    expect(modified).toMatchObject({ supported: true, registered: false, state: "modified" });
  });

  it("卸除：仅删内容匹配本应用 shim 的入口；同名他物保留；未注册时幂等成功", async () => {
    const targetDir = join(tempRoot, "unregister-bin");
    const registration = makeRegistration({ targetDir, platform: "darwin" });

    const absent = await registration.unregisterEntry();
    expect(absent).toMatchObject({ ok: true, removed: false, reason: "absent" });

    await registration.registerEntry();
    const removed = await registration.unregisterEntry();
    expect(removed).toMatchObject({ ok: true, removed: true, reason: "removed" });
    expect(existsSync(join(targetDir, "iart"))).toBe(false);

    // 同名他物：内容不匹配本 shim → 保留不动
    writeFileSync(join(targetDir, "iart"), "#!/bin/sh\necho user-own-tool\n", { encoding: "utf8" });
    const foreign = await registration.unregisterEntry();
    expect(foreign).toMatchObject({ ok: true, removed: false, reason: "foreign_content" });
    expect(existsSync(join(targetDir, "iart"))).toBe(true);
    expect(readFileSync(join(targetDir, "iart"), "utf8")).toContain("user-own-tool");
  });

  it("Windows：iart.cmd 注入 --cli（cmd 形态）", async () => {
    const targetDir = join(tempRoot, "win-bin");
    const appExec = "C:\\Program Files\\IARTStudio\\IARTStudio.exe";
    const registration = makeRegistration({ targetDir, platform: "win32", appExecPath: appExec });
    const result = await registration.registerEntry();
    expect(result).toMatchObject({ ok: true, action: "created" });
    const entryPath = join(targetDir, "iart.cmd");
    expect(existsSync(entryPath)).toBe(true);
    expect(readFileSync(entryPath, "utf8")).toBe(`@"${appExec}" --cli %*\r\n`);

    const status = await registration.getEntryStatus();
    expect(status).toMatchObject({ supported: true, registered: true, state: "registered" });
    const unregistered = await registration.unregisterEntry();
    expect(unregistered).toMatchObject({ ok: true, removed: true, reason: "removed" });
  });

  it("不支持的平台：注册失败并引导手动注册，状态未知（supported:false）", async () => {
    const targetDir = join(tempRoot, "linux-bin");
    const registration = makeRegistration({ targetDir, platform: "linux" });
    const result = await registration.registerEntry();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("手动创建");
      expect(result.message).toContain("--cli");
    }
    const status = await registration.getEntryStatus();
    expect(status).toMatchObject({ supported: false });
    const unregistered = await registration.unregisterEntry();
    expect(unregistered.ok).toBe(false);
  });
});
