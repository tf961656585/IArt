// @vitest-environment node
// @spec: CLI-016, CLI-024, CLI-031, CLI-037
//
// 命令入口注册模块测试（spec docs/integrations/CLI与本地Agent集成.md §3/§8）：
// shim 以 ELECTRON_RUN_AS_NODE=1 启动轻量入口脚本（不注入 --cli；macOS 单 sh 形态；Windows
// 双形态——无扩展名 iart 服务 POSIX 风格 shell、iart.cmd 服务 cmd/PowerShell）、写入目标
// 目录可注入（临时目录）、幂等三态（created/overwritten/noop）、多形态聚合（注册/状态/卸除）、
// 卸除与自愈仅动本应用 shim（不碰同名他物）、状态三态查询、启动自愈分桶语义（CLI-031）、
// 注册前入口资源探测（CLI-037——shim 指向的入口脚本必须真实存在且是常规文件，缺位拦截
// 注册并指引重启自愈/重装）。入口脚本路径以真实临时文件承载（探测按真实 fs stat）。
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
type HealResult =
  | {
      ok: true;
      rewrittenForms: string[];
      foreignForms: string[];
      missingForms: string[];
      currentForms: string[];
    }
  | { ok: false; message: string };

type RegistrationModule = {
  createCliEntryRegistration: (options: {
    targetDir: string;
    appExecPath: string;
    cliEntryScriptPath?: string;
    platform?: string;
    probeEntryResource?: () => Promise<boolean>;
  }) => {
    registerEntry: () => Promise<RegisterResult>;
    unregisterEntry: () => Promise<UnregisterResult>;
    getEntryStatus: () => Promise<StatusResult>;
    healEntryShims: () => Promise<HealResult>;
  };
};

const loadRegistrationModule = (): RegistrationModule =>
  requireDesktop(registrationEntry) as RegistrationModule;

const APP_EXEC = "/Applications/IARTStudio.app/Contents/MacOS/IARTStudio";

/**
 * 探测替身（仅内容形态类用例使用——Windows 风格路径在本机不可能真实存在，转义断言依赖
 * 该路径原文；探测语义本体由「注册前入口资源探测（CLI-037）」组用缺省真实 stat 覆盖）。
 */
const probeAlwaysOk = async (): Promise<boolean> => true;

const makeRegistration = (options: {
  targetDir: string;
  platform: string;
  cliEntryScriptPath?: string;
  appExecPath?: string;
  probeEntryResource?: () => Promise<boolean>;
}) =>
  loadRegistrationModule().createCliEntryRegistration({
    targetDir: options.targetDir,
    appExecPath: options.appExecPath ?? APP_EXEC,
    cliEntryScriptPath: options.cliEntryScriptPath ?? cliEntryScriptFile,
    platform: options.platform,
    probeEntryResource: options.probeEntryResource,
  });

let tempRoot = "";
/** 默认入口脚本替身：真实存在的临时文件（CLI-037 探测按真实 fs stat，路径必须可达）。 */
let cliEntryScriptFile = "";

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "cli-entry-registration-"));
  const entryResourceDir = join(tempRoot, "entry-resource");
  mkdirSync(entryResourceDir, { recursive: true });
  cliEntryScriptFile = join(entryResourceDir, "cli-node-entry.cjs");
  writeFileSync(cliEntryScriptFile, "/* cli entry stub */", "utf8");
});

describe("cli-entry-registration 命令入口注册（CLI-016）", () => {
  it("macOS：sh shim 置位启动入口脚本，写入目标目录并 chmod 0755", async () => {
    const targetDir = join(tempRoot, "mac-bin");
    const registration = makeRegistration({ targetDir, platform: "darwin" });
    const result = await registration.registerEntry();
    expect(result).toMatchObject({ ok: true, action: "created" });
    if (!result.ok) throw new Error("unexpected");
    const entryPath = join(targetDir, "iart");
    expect(result.entryPath).toBe(entryPath);
    expect(existsSync(entryPath)).toBe(true);
    const content = readFileSync(entryPath, "utf8");
    expect(content).toBe(`#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${APP_EXEC}" "${cliEntryScriptFile}" "$@"\n`);
    expect(content).not.toContain("--cli");
    expect((statSync(entryPath).mode & 0o777)).toBe(0o755);
  });

  it("dev 形态：shim 指向 Electron 可执行文件 + 轻量入口脚本（run-as-node 纯 Node 形态）", async () => {
    const targetDir = join(tempRoot, "dev-bin");
    const electronBin = "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
    const entryScript = cliEntryScriptFile;
    const registration = makeRegistration({
      targetDir,
      platform: "darwin",
      appExecPath: electronBin,
      cliEntryScriptPath: entryScript,
    });
    const result = await registration.registerEntry();
    expect(result.ok).toBe(true);
    const content = readFileSync(join(targetDir, "iart"), "utf8");
    expect(content).toBe(`#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${electronBin}" "${entryScript}" "$@"\n`);
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
    expect(readFileSync(entryPath, "utf8")).toContain("ELECTRON_RUN_AS_NODE=1 exec ");
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

  it("Windows：双形态置位启动入口脚本（iart 服务 POSIX 风格 shell，iart.cmd 服务 cmd/PowerShell）", async () => {
    const targetDir = join(tempRoot, "win-bin");
    const appExec = "C:\\Program Files\\IARTStudio\\IARTStudio.exe";
    const entryScript = "C:\\Program Files\\IARTStudio\\resources\\cli\\cli-node-entry.cjs";
    const registration = makeRegistration({
      targetDir,
      platform: "win32",
      appExecPath: appExec,
      cliEntryScriptPath: entryScript,
      probeEntryResource: probeAlwaysOk,
    });
    const result = await registration.registerEntry();
    expect(result).toMatchObject({ ok: true, action: "created" });

    const cmdPath = join(targetDir, "iart.cmd");
    expect(existsSync(cmdPath)).toBe(true);
    expect(readFileSync(cmdPath, "utf8")).toBe(`@set "ELECTRON_RUN_AS_NODE=1"\r\n@"${appExec}" "${entryScript}" %*\r\n`);

    const shPath = join(targetDir, "iart");
    expect(existsSync(shPath)).toBe(true);
    const shContent = readFileSync(shPath, "utf8");
    expect(shContent.startsWith("#!/bin/sh\n")).toBe(true);
    expect(shContent).toContain('ELECTRON_RUN_AS_NODE=1 exec "');
    expect(shContent).not.toContain("\\");
    expect(shContent).not.toContain("\r");
    expect(shContent).not.toContain("--cli");
    expect(shContent.endsWith("\n")).toBe(true);
    expect(shContent).toBe(
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "C:/Program Files/IARTStudio/IARTStudio.exe" "C:/Program Files/IARTStudio/resources/cli/cli-node-entry.cjs" "$@"\n`,
    );

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
    const spaceEntry = "C:\\Program Files\\IART Studio\\resources\\cli\\cli-node-entry.cjs";
    await makeRegistration({
      targetDir: spaceDir,
      platform: "win32",
      appExecPath: spaceExec,
      cliEntryScriptPath: spaceEntry,
      probeEntryResource: probeAlwaysOk,
    }).registerEntry();
    expect(readFileSync(join(spaceDir, "iart"), "utf8")).toBe(
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "C:/Program Files/IART Studio/IARTStudio.exe" "C:/Program Files/IART Studio/resources/cli/cli-node-entry.cjs" "$@"\n`,
    );

    const dollarDir = join(tempRoot, "win-escape-dollar");
    const dollarExec = "C:\\Users\\dev$1\\IARTStudio\\IARTStudio.exe";
    const dollarEntry = "C:\\Users\\dev$1\\IARTStudio\\resources\\cli\\cli-node-entry.cjs";
    await makeRegistration({
      targetDir: dollarDir,
      platform: "win32",
      appExecPath: dollarExec,
      cliEntryScriptPath: dollarEntry,
      probeEntryResource: probeAlwaysOk,
    }).registerEntry();
    expect(readFileSync(join(dollarDir, "iart"), "utf8")).toBe(
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "C:/Users/dev\\$1/IARTStudio/IARTStudio.exe" "C:/Users/dev\\$1/IARTStudio/resources/cli/cli-node-entry.cjs" "$@"\n`,
    );
    expect(readFileSync(join(dollarDir, "iart.cmd"), "utf8")).toBe(
      `@set "ELECTRON_RUN_AS_NODE=1"\r\n@"${dollarExec}" "${dollarEntry}" %*\r\n`,
    );
  });

  it("Windows 迁移：存量 0.6.5 旧内容 iart.cmd → 状态 modified；注册补建 sh 形态、cmd 内容被覆盖升级", async () => {
    const targetDir = join(tempRoot, "win-migrate");
    mkdirSync(targetDir, { recursive: true });
    const appExec = "C:\\Apps\\IARTStudio\\IARTStudio.exe";
    const entryScript = "C:\\Apps\\IARTStudio\\resources\\cli\\cli-node-entry.cjs";
    // 存量 shim 为 0.6.5 旧版内容（--cli 注入 + 变量置空）：重注册按内容不一致覆盖自愈（CLI-024）
    const legacyCmdContent = `@set "ELECTRON_RUN_AS_NODE="\r\n@"${appExec}" --cli %*\r\n`;
    writeFileSync(join(targetDir, "iart.cmd"), legacyCmdContent, { encoding: "utf8" });

    const registration = makeRegistration({
      targetDir,
      platform: "win32",
      appExecPath: appExec,
      cliEntryScriptPath: entryScript,
      probeEntryResource: probeAlwaysOk,
    });
    expect(await registration.getEntryStatus()).toMatchObject({
      supported: true,
      registered: false,
      state: "modified",
    });

    const result = await registration.registerEntry();
    expect(result).toMatchObject({ ok: true, action: "created" });
    expect(readFileSync(join(targetDir, "iart.cmd"), "utf8")).toBe(
      `@set "ELECTRON_RUN_AS_NODE=1"\r\n@"${appExec}" "${entryScript}" %*\r\n`,
    );
    expect(readFileSync(join(targetDir, "iart"), "utf8")).toBe(
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "C:/Apps/IARTStudio/IARTStudio.exe" "C:/Apps/IARTStudio/resources/cli/cli-node-entry.cjs" "$@"\n`,
    );
    expect(await registration.getEntryStatus()).toMatchObject({
      supported: true,
      registered: true,
      state: "registered",
    });
  });

  it("Windows 状态聚合：双全等 registered、双缺失 missing、缺件或单侧内容不符 modified", async () => {
    const appExec = "C:\\Apps\\IARTStudio\\IARTStudio.exe";
    const entryScript = "C:\\Apps\\IARTStudio\\resources\\cli\\cli-node-entry.cjs";
    const cmdContent = `@set "ELECTRON_RUN_AS_NODE=1"\r\n@"${appExec}" "${entryScript}" %*\r\n`;
    const shContent = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "C:/Apps/IARTStudio/IARTStudio.exe" "C:/Apps/IARTStudio/resources/cli/cli-node-entry.cjs" "$@"\n`;

    const bothMissing = makeRegistration({
      targetDir: join(tempRoot, "win-status-missing"),
      platform: "win32",
      appExecPath: appExec,
      cliEntryScriptPath: entryScript,
    });
    expect(await bothMissing.getEntryStatus()).toMatchObject({ supported: true, registered: false, state: "missing" });

    const bothOurs = makeRegistration({
      targetDir: join(tempRoot, "win-status-ours"),
      platform: "win32",
      appExecPath: appExec,
      cliEntryScriptPath: entryScript,
      probeEntryResource: probeAlwaysOk,
    });
    await bothOurs.registerEntry();
    expect(await bothOurs.getEntryStatus()).toMatchObject({ supported: true, registered: true, state: "registered" });

    const mixedDir = join(tempRoot, "win-status-mixed");
    mkdirSync(mixedDir, { recursive: true });
    writeFileSync(join(mixedDir, "iart.cmd"), cmdContent, { encoding: "utf8" });
    writeFileSync(join(mixedDir, "iart"), "echo foreign-sh\n", { encoding: "utf8" });
    const mixed = makeRegistration({
      targetDir: mixedDir,
      platform: "win32",
      appExecPath: appExec,
      cliEntryScriptPath: entryScript,
    });
    expect(await mixed.getEntryStatus()).toMatchObject({ supported: true, registered: false, state: "modified" });

    const shOnlyDir = join(tempRoot, "win-status-sh-only");
    mkdirSync(shOnlyDir, { recursive: true });
    writeFileSync(join(shOnlyDir, "iart"), shContent, { encoding: "utf8" });
    const shOnly = makeRegistration({
      targetDir: shOnlyDir,
      platform: "win32",
      appExecPath: appExec,
      cliEntryScriptPath: entryScript,
    });
    expect(await shOnly.getEntryStatus()).toMatchObject({ supported: true, registered: false, state: "modified" });
  });

  it("Windows 卸除聚合：双 ours 全删 removed；cmd 为他物保留报 foreign_content；双缺失幂等 absent", async () => {
    const appExec = "C:\\Apps\\IARTStudio\\IARTStudio.exe";
    const entryScript = "C:\\Apps\\IARTStudio\\resources\\cli\\cli-node-entry.cjs";

    const absentDir = join(tempRoot, "win-unregister-absent");
    const absent = await makeRegistration({
      targetDir: absentDir,
      platform: "win32",
      appExecPath: appExec,
      cliEntryScriptPath: entryScript,
    }).unregisterEntry();
    expect(absent).toMatchObject({ ok: true, removed: false, reason: "absent" });

    const oursDir = join(tempRoot, "win-unregister-ours");
    const ours = makeRegistration({
      targetDir: oursDir,
      platform: "win32",
      appExecPath: appExec,
      cliEntryScriptPath: entryScript,
      probeEntryResource: probeAlwaysOk,
    });
    await ours.registerEntry();
    expect(await ours.unregisterEntry()).toMatchObject({ ok: true, removed: true, reason: "removed" });
    expect(existsSync(join(oursDir, "iart"))).toBe(false);
    expect(existsSync(join(oursDir, "iart.cmd"))).toBe(false);

    const foreignDir = join(tempRoot, "win-unregister-foreign");
    const foreign = makeRegistration({
      targetDir: foreignDir,
      platform: "win32",
      appExecPath: appExec,
      cliEntryScriptPath: entryScript,
      probeEntryResource: probeAlwaysOk,
    });
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
      // 引导文案随 shim 形态翻转更新：不再指向已退役的 --cli 注入语义
      expect(result.message).not.toContain("--cli");
    }
    const status = await registration.getEntryStatus();
    expect(status).toMatchObject({ supported: false });
    const unregistered = await registration.unregisterEntry();
    expect(unregistered.ok).toBe(false);
  });

  it("不支持的平台注册失败消息含置位形态引导（CLI-024 语义）", async () => {
    const targetDir = join(tempRoot, "linux-manual");
    const registration = makeRegistration({ targetDir, platform: "linux" });
    const result = await registration.registerEntry();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("ELECTRON_RUN_AS_NODE=1");
    }
  });
});

// ---------------------------------------------------------------------------
// shim 自动自愈（CLI-031，spec §3：应用启动检测 Windows 双形态注册目录，过期模板重写）
// ---------------------------------------------------------------------------

describe("shim 自动自愈（CLI-031）", () => {
  const LEGACY_CMD = (appExec: string): string => `@set "ELECTRON_RUN_AS_NODE="\r\n@"${appExec}" --cli %*\r\n`;
  const LEGACY_SH = (appExec: string): string =>
    `#!/bin/sh\nunset ELECTRON_RUN_AS_NODE\nexec "${appExec.replace(/\\/g, "/")}" --cli "$@"\n`;

  it("Windows：双形态存量旧 shim（引用本应用 exe）→ 按当前模板重写；再次自愈幂等入 current 桶", async () => {
    const targetDir = join(tempRoot, "win-heal-stale");
    mkdirSync(targetDir, { recursive: true });
    const appExec = "C:\\Apps\\IARTStudio\\IARTStudio.exe";
    const entryScript = "C:\\Apps\\IARTStudio\\resources\\cli\\cli-node-entry.cjs";
    writeFileSync(join(targetDir, "iart.cmd"), LEGACY_CMD(appExec), { encoding: "utf8" });
    writeFileSync(join(targetDir, "iart"), LEGACY_SH(appExec), { encoding: "utf8" });

    const registration = makeRegistration({
      targetDir,
      platform: "win32",
      appExecPath: appExec,
      cliEntryScriptPath: entryScript,
    });
    const first = await registration.healEntryShims();
    expect(first).toMatchObject({ ok: true, rewrittenForms: ["sh", "cmd"], foreignForms: [], missingForms: [] });
    expect(readFileSync(join(targetDir, "iart.cmd"), "utf8")).toBe(
      `@set "ELECTRON_RUN_AS_NODE=1"\r\n@"${appExec}" "${entryScript}" %*\r\n`,
    );
    expect(readFileSync(join(targetDir, "iart"), "utf8")).toBe(
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "C:/Apps/IARTStudio/IARTStudio.exe" "C:/Apps/IARTStudio/resources/cli/cli-node-entry.cjs" "$@"\n`,
    );

    const second = await registration.healEntryShims();
    expect(second).toMatchObject({ ok: true, rewrittenForms: [], currentForms: ["sh", "cmd"] });
  });

  it("Windows：内容不指向本应用可执行文件的同名他物保留不动；缺失形态跳过不擅自创建", async () => {
    const foreignDir = join(tempRoot, "win-heal-foreign");
    mkdirSync(foreignDir, { recursive: true });
    const appExec = "C:\\Apps\\IARTStudio\\IARTStudio.exe";
    writeFileSync(join(foreignDir, "iart.cmd"), "# user own tool\r\n", { encoding: "utf8" });

    const registration = makeRegistration({ targetDir: foreignDir, platform: "win32", appExecPath: appExec });
    const result = await registration.healEntryShims();
    expect(result).toMatchObject({ ok: true, rewrittenForms: [], foreignForms: ["cmd"], missingForms: ["sh"] });
    expect(readFileSync(join(foreignDir, "iart.cmd"), "utf8")).toBe("# user own tool\r\n");
    expect(existsSync(join(foreignDir, "iart"))).toBe(false);
  });

  it("Windows：混合场景（cmd 为本应用过期模板、sh 为他物）只重写本应用形态", async () => {
    const mixedDir = join(tempRoot, "win-heal-mixed");
    mkdirSync(mixedDir, { recursive: true });
    const appExec = "C:\\Apps\\IARTStudio\\IARTStudio.exe";
    const entryScript = "C:\\Apps\\IARTStudio\\resources\\cli\\cli-node-entry.cjs";
    writeFileSync(join(mixedDir, "iart.cmd"), LEGACY_CMD(appExec), { encoding: "utf8" });
    writeFileSync(join(mixedDir, "iart"), "#!/bin/sh\necho user-own-tool\n", { encoding: "utf8" });

    const registration = makeRegistration({
      targetDir: mixedDir,
      platform: "win32",
      appExecPath: appExec,
      cliEntryScriptPath: entryScript,
    });
    const result = await registration.healEntryShims();
    expect(result).toMatchObject({ ok: true, rewrittenForms: ["cmd"], foreignForms: ["sh"] });
    expect(readFileSync(join(mixedDir, "iart.cmd"), "utf8")).toContain("ELECTRON_RUN_AS_NODE=1");
    expect(readFileSync(join(mixedDir, "iart"), "utf8")).toContain("user-own-tool");
  });

  it("双缺失：全部入 missing 桶，不创建任何文件（尊重用户未注册/已删除）", async () => {
    const targetDir = join(tempRoot, "win-heal-absent");
    const registration = makeRegistration({ targetDir, platform: "win32" });
    const result = await registration.healEntryShims();
    expect(result).toMatchObject({ ok: true, rewrittenForms: [], missingForms: ["sh", "cmd"] });
    expect(existsSync(join(targetDir, "iart"))).toBe(false);
    expect(existsSync(join(targetDir, "iart.cmd"))).toBe(false);
  });

  it("非 Windows 平台：自愈范围外，空桶 noop（macOS 自愈走设置页重注册）", async () => {
    const targetDir = join(tempRoot, "mac-heal-noop");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "iart"), "#!/bin/sh\necho legacy\n", { encoding: "utf8" });
    const registration = makeRegistration({ targetDir, platform: "darwin" });
    const result = await registration.healEntryShims();
    expect(result).toMatchObject({
      ok: true,
      rewrittenForms: [],
      foreignForms: [],
      missingForms: [],
      currentForms: [],
    });
    expect(readFileSync(join(targetDir, "iart"), "utf8")).toContain("legacy");
  });

  it("IO 失败：目标目录不可读时结构化失败（不抛进 UI 层）", async () => {
    // 目标「目录」实际是文件：readEntryFileContent 抛 ENOTDIR → 自愈结构化失败
    const notADir = join(tempRoot, "win-heal-notdir");
    writeFileSync(notADir, "plain file", { encoding: "utf8" });
    const registration = makeRegistration({ targetDir: notADir, platform: "win32" });
    const result = await registration.healEntryShims();
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 注册前入口资源探测（CLI-037，spec §8：shim 指向的入口脚本缺位时拦截注册并指引重启自愈/
// 重装；不静默注册注定失败的 shim）。本组用缺省真实 stat（路径注入即测试缝）。
// ---------------------------------------------------------------------------

describe("注册前入口资源探测（CLI-037）", () => {
  it("入口脚本缺失：注册结构化失败，消息指引重启自愈/重装，不落任何 shim", async () => {
    const targetDir = join(tempRoot, "probe-missing");
    const missingEntry = join(tempRoot, "no-such-resource", "cli-node-entry.cjs");
    const registration = makeRegistration({ targetDir, platform: "darwin", cliEntryScriptPath: missingEntry });
    const result = await registration.registerEntry();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");
    expect(result.message).toContain("程序文件缺失或损坏");
    expect(result.message).toContain("重启应用");
    expect(result.message).toContain("重新安装");
    expect(existsSync(join(targetDir, "iart"))).toBe(false);
  });

  it("错位形态（父级名位被文件占用 → stat ENOTDIR）：同样拦截注册", async () => {
    const targetDir = join(tempRoot, "probe-misplaced");
    // 0.6.8 错位形态：resources/cli 是文件（非目录），其子路径 stat 报 ENOTDIR
    const misplacedRoot = join(tempRoot, "probe-misplaced-resources");
    mkdirSync(misplacedRoot, { recursive: true });
    writeFileSync(join(misplacedRoot, "cli"), "misplaced entry body", "utf8");
    const registration = makeRegistration({
      targetDir,
      platform: "darwin",
      cliEntryScriptPath: join(misplacedRoot, "cli", "cli-node-entry.cjs"),
    });
    const result = await registration.registerEntry();
    expect(result.ok).toBe(false);
    expect(existsSync(join(targetDir, "iart"))).toBe(false);
  });

  it("入口名位是目录（非常规文件）：拦截注册", async () => {
    const targetDir = join(tempRoot, "probe-not-file");
    const entryAsDir = join(tempRoot, "probe-entry-as-dir", "cli-node-entry.cjs");
    mkdirSync(entryAsDir, { recursive: true });
    const registration = makeRegistration({ targetDir, platform: "darwin", cliEntryScriptPath: entryAsDir });
    const result = await registration.registerEntry();
    expect(result.ok).toBe(false);
    expect(existsSync(join(targetDir, "iart"))).toBe(false);
  });

  it("入口脚本真实存在（常规文件）：注册正常放行（探测不改变健康路径行为）", async () => {
    const targetDir = join(tempRoot, "probe-healthy");
    const registration = makeRegistration({ targetDir, platform: "darwin" });
    const result = await registration.registerEntry();
    expect(result).toMatchObject({ ok: true, action: "created" });
    expect(existsSync(join(targetDir, "iart"))).toBe(true);
  });
});
