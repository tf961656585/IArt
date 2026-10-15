// @vitest-environment node
// @spec: CLI-036, CLI-037
//
// CLI 入口资源自愈（healCliEntryResource）测试（spec docs/integrations/CLI与本地Agent集成.md
// §3/§8）。背景（0.6.8 Windows 真机实锤）：extraResources 的 from 为单文件、to 为不带尾斜杠
// 的名字时，electron-builder 把 to 当目标文件名——入口脚本被拷成名为 cli 的无扩展名文件
// （Windows 同名文件与目录不能共存，目录层级与扩展名丢失），CLI 全功能 MODULE_NOT_FOUND。
//
// 覆盖：①自愈本体四态（健康不动 / 错位态改名腾位后从源恢复 / 缺失态从源恢复 / 入口位被
// 目录占用时腾位恢复）+ 源不可得时结构化失败且不动现场；②bootstrap 接线 pin（whenReady 内
// fire-and-forget、打包态门控、失败落 main.log 不阻断启动）——编译器观测不到接线，只能源码
// 级断言（风格照抄 cli-entry-shim-self-heal.test.mts）。
import { createRequire } from "node:module";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const healModulePath = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-entry-resource-heal.cjs`;
const bootstrapSourcePath = `${workspaceRoot}/apps/desktop-shell/src/desktop-shell-bootstrap.cts`;

type HealOutcome = "healthy" | "healed_misplaced" | "healed_damaged_entry" | "healed_missing";
type HealResult =
  | { ok: true; outcome: HealOutcome; corruptBackupPath: string | null }
  | { ok: false; message: string };

type HealModule = {
  healCliEntryResource: (deps: {
    resourcesDir: string;
    asarEntrySourcePath: string;
  }) => Promise<HealResult>;
};

const loadHealModule = (): HealModule => requireDesktop(healModulePath) as HealModule;

const ENTRY_SOURCE_CONTENT = "/* cli-node-entry asar 本体（测试替身内容） */\n";

/** 构造一个「asar 内入口源」（测试以真实普通文件替身；生产为 Electron patched fs 读 asar）。 */
const makeAsarSource = (root: string): string => {
  const sourcePath = join(root, "app.asar", "apps", "desktop-shell", "dist", "cli", "cli-node-entry.cjs");
  mkdirSync(join(sourcePath, ".."), { recursive: true });
  writeFileSync(sourcePath, ENTRY_SOURCE_CONTENT, "utf8");
  return sourcePath;
};

let tempRoot = "";
let asarSourcePath = "";

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "cli-entry-resource-heal-"));
  asarSourcePath = makeAsarSource(tempRoot);
});

describe("healCliEntryResource 资源自愈四态（CLI-036）", () => {
  it("健康态：入口已是常规文件 → healthy，不改动现场", async () => {
    const resourcesDir = join(tempRoot, "healthy-resources");
    const cliDir = join(resourcesDir, "cli");
    mkdirSync(cliDir, { recursive: true });
    const entryPath = join(cliDir, "cli-node-entry.cjs");
    writeFileSync(entryPath, ENTRY_SOURCE_CONTENT, "utf8");

    const result = await loadHealModule().healCliEntryResource({
      resourcesDir,
      asarEntrySourcePath: asarSourcePath,
    });

    expect(result).toMatchObject({ ok: true, outcome: "healthy", corruptBackupPath: null });
    expect(readFileSync(entryPath, "utf8")).toBe(ENTRY_SOURCE_CONTENT);
  });

  it("错位态：名为 cli 的无扩展名文件 → 改名腾位（cli.corrupt-*）→ 建目录 → 从源恢复；cli 名位最终是目录（Windows 同名文件与目录不能共存的语义落点）", async () => {
    const resourcesDir = join(tempRoot, "misplaced-resources");
    mkdirSync(resourcesDir, { recursive: true });
    const misplacedContent = ENTRY_SOURCE_CONTENT; // 0.6.8 实锤：错位文件内容恰是入口本体
    writeFileSync(join(resourcesDir, "cli"), misplacedContent, "utf8");

    const result = await loadHealModule().healCliEntryResource({
      resourcesDir,
      asarEntrySourcePath: asarSourcePath,
    });

    expect(result).toMatchObject({ ok: true, outcome: "healed_misplaced" });
    if (!result.ok) throw new Error("unexpected");
    expect(result.corruptBackupPath).toContain("cli.corrupt-");
    expect(readFileSync(result.corruptBackupPath ?? "", "utf8")).toBe(misplacedContent);
    // 错位文件已腾位：cli 名位现在是目录（测试环境同盘，文件与目录同名不能共存——
    // 目录成立即证明改名先行）
    expect(statSync(join(resourcesDir, "cli")).isDirectory()).toBe(true);
    const restored = join(resourcesDir, "cli", "cli-node-entry.cjs");
    expect(statSync(restored).isFile()).toBe(true);
    expect(readFileSync(restored, "utf8")).toBe(ENTRY_SOURCE_CONTENT);
  });

  it("缺失态：cli 目录与入口均不存在 → 建目录并从源恢复", async () => {
    const resourcesDir = join(tempRoot, "missing-resources");
    mkdirSync(resourcesDir, { recursive: true });

    const result = await loadHealModule().healCliEntryResource({
      resourcesDir,
      asarEntrySourcePath: asarSourcePath,
    });

    expect(result).toMatchObject({ ok: true, outcome: "healed_missing", corruptBackupPath: null });
    const restored = join(resourcesDir, "cli", "cli-node-entry.cjs");
    expect(statSync(restored).isFile()).toBe(true);
    expect(readFileSync(restored, "utf8")).toBe(ENTRY_SOURCE_CONTENT);
  });

  it("入口位被目录占用（cli 目录在、入口名位是目录）→ 腾位后从源恢复", async () => {
    const resourcesDir = join(tempRoot, "damaged-entry-resources");
    const damagedEntry = join(resourcesDir, "cli", "cli-node-entry.cjs");
    mkdirSync(damagedEntry, { recursive: true });
    writeFileSync(join(damagedEntry, "junk.txt"), "junk", "utf8");

    const result = await loadHealModule().healCliEntryResource({
      resourcesDir,
      asarEntrySourcePath: asarSourcePath,
    });

    expect(result).toMatchObject({ ok: true, outcome: "healed_damaged_entry" });
    if (!result.ok) throw new Error("unexpected");
    expect(result.corruptBackupPath).toContain("cli-node-entry.cjs.corrupt-");
    expect(existsSync(result.corruptBackupPath ?? "")).toBe(true);
    const restored = join(resourcesDir, "cli", "cli-node-entry.cjs");
    expect(statSync(restored).isFile()).toBe(true);
    expect(readFileSync(restored, "utf8")).toBe(ENTRY_SOURCE_CONTENT);
  });

  it("源不可得：结构化失败，且不动现场（错位文件保留、目标不落半成品）", async () => {
    const resourcesDir = join(tempRoot, "source-missing-resources");
    mkdirSync(resourcesDir, { recursive: true });
    writeFileSync(join(resourcesDir, "cli"), ENTRY_SOURCE_CONTENT, "utf8");
    const missingSource = join(tempRoot, "app.asar", "apps", "desktop-shell", "dist", "cli", "no-such-entry.cjs");

    const result = await loadHealModule().healCliEntryResource({
      resourcesDir,
      asarEntrySourcePath: missingSource,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");
    expect(result.message).toContain("cli-node-entry.cjs");
    // 现场保留：错位文件未被动过（先读源后动现场的次序保证）
    expect(readFileSync(join(resourcesDir, "cli"), "utf8")).toBe(ENTRY_SOURCE_CONTENT);
    expect(existsSync(join(resourcesDir, "cli", "cli-node-entry.cjs"))).toBe(false);
  });

  it("源为空文件：结构化失败（写一个空入口等于换一种损坏）", async () => {
    const resourcesDir = join(tempRoot, "source-empty-resources");
    mkdirSync(resourcesDir, { recursive: true });
    const emptySourceDir = join(tempRoot, "empty-source");
    mkdirSync(emptySourceDir, { recursive: true });
    const emptySource = join(emptySourceDir, "cli-node-entry.cjs");
    writeFileSync(emptySource, "", "utf8");

    const result = await loadHealModule().healCliEntryResource({
      resourcesDir,
      asarEntrySourcePath: emptySource,
    });

    expect(result.ok).toBe(false);
  });
});

describe("bootstrap 的入口资源自愈接线（CLI-036）", () => {
  const source = readFileSync(bootstrapSourcePath, "utf8");
  const whenReadyIndex = source.indexOf("app.whenReady()");

  it("healPackagedCliEntryResource 在 bootstrap 中被调用，且位于 whenReady 之后", () => {
    const healCallIndex = source.indexOf("healPackagedCliEntryResource();");
    expect(healCallIndex).toBeGreaterThan(-1);
    expect(whenReadyIndex).toBeGreaterThan(-1);
    expect(healCallIndex).toBeGreaterThan(whenReadyIndex);
  });

  it("自愈调用为 fire-and-forget（void 前缀 + .then，不 await、不阻断启动主链）", () => {
    const healFnIndex = source.indexOf("const healPackagedCliEntryResource = ");
    expect(healFnIndex).toBeGreaterThan(-1);
    const healFnBody = source.slice(healFnIndex, healFnIndex + 900);
    expect(healFnBody).toContain("void healCliEntryResource(");
    expect(healFnBody).not.toContain("await ");
  });

  it("dev 形态不适用自愈（打包态门控：isPackaged 与 resourcesPath 可用性同口径判定）", () => {
    const healFnIndex = source.indexOf("const healPackagedCliEntryResource = ");
    const healFnBody = source.slice(healFnIndex, source.indexOf("};", healFnIndex));
    expect(healFnBody).toContain("isPackagedResourcesAvailable()");
    expect(source).toContain("const isPackagedResourcesAvailable = ");
    expect(source).toContain("app.isPackaged === true");
  });

  it("自愈源取自 app.asar 内编译产物（app.getAppPath() + apps/desktop-shell/dist/cli）", () => {
    expect(source).toContain('path.join(\n      app.getAppPath(),');
    expect(source).toContain('"apps",\n      "desktop-shell",\n      "dist",\n      "cli",');
  });

  it("自愈结果与失败均落 main.log（appendMainLog；主进程留痕必须落文件的仓库纪律）", () => {
    const healFnIndex = source.indexOf("const healPackagedCliEntryResource = ");
    const healFnBody = source.slice(healFnIndex, source.indexOf("};", healFnIndex));
    expect(healFnBody).toContain('appendMainLog("warn"');
    expect(healFnBody).toContain('appendMainLog("info"');
  });
});
