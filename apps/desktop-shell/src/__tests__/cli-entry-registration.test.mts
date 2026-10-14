// @vitest-environment node
// @spec: CLI-016
//
// 命令入口注册模块测试（spec docs/integrations/CLI与本地Agent集成.md §3/§8）：
// shim 注入 --cli（macOS 单 sh 形态；Windows 双形态——无扩展名 iart 服务 POSIX 风格 shell、
// iart.cmd 服务 cmd/PowerShell）、写入目标目录可注入（临时目录）、
// 幂等三态（created/overwritten/noop）、多形态聚合（注册/状态/卸除）、
// 卸除仅删本应用 shim（不删同名他物）、状态三态查询。
import { createRequire } from "node:module";
import { mkdtempSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

  it("Windows：双形态注入 --cli（iart 服务 POSIX 风格 shell，iart.cmd 服务 cmd/PowerShell）", async () => {
    const targetDir = join(tempRoot, "win-bin");
    const appExec = "C:\\Program Files\\IARTStudio\\IARTStudio.exe";
    const registration = makeRegistration({ targetDir, platform: "win32", appExecPath: appExec });
    const result = await registration.registerEntry();
    expect(result).toMatchObject({ ok: true, action: "created" });

    const cmdPath = join(targetDir, "iart.cmd");
    expect(existsSync(cmdPath)).toBe(true);
    expect(readFileSync(cmdPath, "utf8")).toBe(`@"${appExec}" --cli %*\r\n`);

    const shPath = join(targetDir, "iart");
    expect(existsSync(shPath)).toBe(true);
    const shContent = readFileSync(shPath, "utf8");
    expect(shContent.startsWith("#!/bin/sh\n")).toBe(true);
    expect(shContent).toContain('exec "');
    expect(shContent).not.toContain("\\");
    expect(shContent).not.toContain("\r");
    expect(shContent.endsWith("\n")).toBe(true);
    expect(shContent).toBe(`#!/bin/sh\nexec "C:/Program Files/IARTStudio/IARTStudio.exe" --cli "$@"\n`);

    const status = await registration.getEntryStatus();
    expect(status).toMatchObject({ supported: true, registered: true, state: "registered" });
    const unregistered = await registration.unregisterEntry();
    expect(unregistered).toMatchObject({ ok: true, removed: true, reason: "removed" });
    expect(existsSync(shPath)).toBe(false);
    expect(existsSync(cmdPath)).toBe(false);
  });

  it("Windows sh 形态路径转义：空格保留在双引号内、$ 转义；cmd 形态保留原始反斜杠路径", async () => {
    const spaceDir = join(tempRoot, "win-escape-space");
    const spaceExec = "C:\\Program Files\\IART Studio\\IARTStudio.exe";
    await makeRegistration({ targetDir: spaceDir, platform: "win32", appExecPath: spaceExec }).registerEntry();
    expect(readFileSync(join(spaceDir, "iart"), "utf8")).toBe(
      `#!/bin/sh\nexec "C:/Program Files/IART Studio/IARTStudio.exe" --cli "$@"\n`,
    );

    const dollarDir = join(tempRoot, "win-escape-dollar");
    const dollarExec = "C:\\Users\\dev$1\\IARTStudio\\IARTStudio.exe";
    await makeRegistration({ targetDir: dollarDir, platform: "win32", appExecPath: dollarExec }).registerEntry();
    expect(readFileSync(join(dollarDir, "iart"), "utf8")).toBe(
      `#!/bin/sh\nexec "C:/Users/dev\\$1/IARTStudio/IARTStudio.exe" --cli "$@"\n`,
    );
    expect(readFileSync(join(dollarDir, "iart.cmd"), "utf8")).toBe(`@"${dollarExec}" --cli %*\r\n`);
  });

  it("Windows 迁移：存量仅内容匹配的 iart.cmd → 状态 modified；注册补建 sh 形态、cmd 内容跳过", async () => {
    const targetDir = join(tempRoot, "win-migrate");
    mkdirSync(targetDir, { recursive: true });
    const appExec = "C:\\Apps\\IARTStudio\\IARTStudio.exe";
    const legacyCmdContent = `@"${appExec}" --cli %*\r\n`;
    writeFileSync(join(targetDir, "iart.cmd"), legacyCmdContent, { encoding: "utf8" });

    const registration = makeRegistration({ targetDir, platform: "win32", appExecPath: appExec });
    expect(await registration.getEntryStatus()).toMatchObject({
      supported: true,
      registered: false,
      state: "modified",
    });

    const result = await registration.registerEntry();
    expect(result).toMatchObject({ ok: true, action: "created" });
    expect(readFileSync(join(targetDir, "iart.cmd"), "utf8")).toBe(legacyCmdContent);
    expect(readFileSync(join(targetDir, "iart"), "utf8")).toBe(
      `#!/bin/sh\nexec "C:/Apps/IARTStudio/IARTStudio.exe" --cli "$@"\n`,
    );
    expect(await registration.getEntryStatus()).toMatchObject({
      supported: true,
      registered: true,
      state: "registered",
    });
  });

  it("Windows 状态聚合：双全等 registered、双缺失 missing、缺件或单侧内容不符 modified", async () => {
    const appExec = "C:\\Apps\\IARTStudio\\IARTStudio.exe";
    const cmdContent = `@"${appExec}" --cli %*\r\n`;
    const shContent = `#!/bin/sh\nexec "C:/Apps/IARTStudio/IARTStudio.exe" --cli "$@"\n`;

    const bothMissing = makeRegistration({
      targetDir: join(tempRoot, "win-status-missing"),
      platform: "win32",
      appExecPath: appExec,
    });
    expect(await bothMissing.getEntryStatus()).toMatchObject({ supported: true, registered: false, state: "missing" });

    const bothOurs = makeRegistration({
      targetDir: join(tempRoot, "win-status-ours"),
      platform: "win32",
      appExecPath: appExec,
    });
    await bothOurs.registerEntry();
    expect(await bothOurs.getEntryStatus()).toMatchObject({ supported: true, registered: true, state: "registered" });

    const mixedDir = join(tempRoot, "win-status-mixed");
    mkdirSync(mixedDir, { recursive: true });
    writeFileSync(join(mixedDir, "iart.cmd"), cmdContent, { encoding: "utf8" });
    writeFileSync(join(mixedDir, "iart"), "echo foreign-sh\n", { encoding: "utf8" });
    const mixed = makeRegistration({ targetDir: mixedDir, platform: "win32", appExecPath: appExec });
    expect(await mixed.getEntryStatus()).toMatchObject({ supported: true, registered: false, state: "modified" });

    const shOnlyDir = join(tempRoot, "win-status-sh-only");
    mkdirSync(shOnlyDir, { recursive: true });
    writeFileSync(join(shOnlyDir, "iart"), shContent, { encoding: "utf8" });
    const shOnly = makeRegistration({ targetDir: shOnlyDir, platform: "win32", appExecPath: appExec });
    expect(await shOnly.getEntryStatus()).toMatchObject({ supported: true, registered: false, state: "modified" });
  });

  it("Windows 卸除聚合：双 ours 全删 removed；cmd 为他物保留报 foreign_content；双缺失幂等 absent", async () => {
    const appExec = "C:\\Apps\\IARTStudio\\IARTStudio.exe";

    const absentDir = join(tempRoot, "win-unregister-absent");
    const absent = await makeRegistration({
      targetDir: absentDir,
      platform: "win32",
      appExecPath: appExec,
    }).unregisterEntry();
    expect(absent).toMatchObject({ ok: true, removed: false, reason: "absent" });

    const oursDir = join(tempRoot, "win-unregister-ours");
    const ours = makeRegistration({ targetDir: oursDir, platform: "win32", appExecPath: appExec });
    await ours.registerEntry();
    expect(await ours.unregisterEntry()).toMatchObject({ ok: true, removed: true, reason: "removed" });
    expect(existsSync(join(oursDir, "iart"))).toBe(false);
    expect(existsSync(join(oursDir, "iart.cmd"))).toBe(false);

    const foreignDir = join(tempRoot, "win-unregister-foreign");
    const foreign = makeRegistration({ targetDir: foreignDir, platform: "win32", appExecPath: appExec });
    await foreign.registerEntry();
    writeFileSync(join(foreignDir, "iart.cmd"), "# user own tool\r\n", { encoding: "utf8" });
    expect(await foreign.unregisterEntry()).toMatchObject({ ok: true, removed: false, reason: "foreign_content" });
    expect(readFileSync(join(foreignDir, "iart.cmd"), "utf8")).toBe("# user own tool\r\n");
    expect(existsSync(join(foreignDir, "iart"))).toBe(false);
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
