// @vitest-environment node
//
// cli-console-attach 测试（Windows 中文乱码批次，2026-10-14）：
// 决策纯函数全表、非 win32 透传、koffi 可加载性与平台预编译存在性、
// koffi 惰性加载的源码级约束（GUI 主进程常驻加载本模块，不得在顶层 require koffi）。
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const attachEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-console-attach.cjs`;
const attachSource = `${workspaceRoot}/apps/desktop-shell/src/cli/cli-console-attach.cts`;

type CliStdioSource = "process_stream" | "console_tty_stream";
type CliStdioDecisionInput = {
  attached: boolean;
  processStreamIsTty: boolean;
  fileType: number | null;
  consoleModeReadable: boolean;
};
type CliStdioPreparation = { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream; attached: boolean };
type AttachModule = {
  decideCliStdioSource: (input: CliStdioDecisionInput) => CliStdioSource;
  prepareCliStdio: () => CliStdioPreparation;
  FILE_TYPE_UNKNOWN: number;
  FILE_TYPE_DISK: number;
  FILE_TYPE_CHAR: number;
  FILE_TYPE_PIPE: number;
};

const loadModule = (): AttachModule => requireDesktop(attachEntry) as AttachModule;

describe("decideCliStdioSource 决策表（纯函数全分支）", () => {
  const mod = loadModule();

  it("未挂接成功：一律保持原流（= 修复前行为），不受其他输入影响", () => {
    for (const fileType of [null, mod.FILE_TYPE_UNKNOWN, mod.FILE_TYPE_DISK, mod.FILE_TYPE_CHAR, mod.FILE_TYPE_PIPE]) {
      for (const processStreamIsTty of [false, true]) {
        expect(
          mod.decideCliStdioSource({ attached: false, processStreamIsTty, fileType, consoleModeReadable: true }),
        ).toBe("process_stream");
      }
    }
  });

  it("挂接成功 + 控制台句柄（CHAR 且 GetConsoleMode 成功）+ process 流尚非 TTY → CONOUT$ 接管", () => {
    expect(
      mod.decideCliStdioSource({ attached: true, processStreamIsTty: false, fileType: mod.FILE_TYPE_CHAR, consoleModeReadable: true }),
    ).toBe("console_tty_stream");
  });

  it("挂接成功 + 控制台句柄 + process 流已是 TTY → 直接用 process 流", () => {
    expect(
      mod.decideCliStdioSource({ attached: true, processStreamIsTty: true, fileType: mod.FILE_TYPE_CHAR, consoleModeReadable: true }),
    ).toBe("process_stream");
  });

  it("挂接成功 + 非控制台句柄（PIPE/DISK/UNKNOWN/探测失败）→ 保持原流，不劫持重定向输出", () => {
    for (const fileType of [null, mod.FILE_TYPE_UNKNOWN, mod.FILE_TYPE_DISK, mod.FILE_TYPE_PIPE]) {
      expect(
        mod.decideCliStdioSource({ attached: true, processStreamIsTty: false, fileType, consoleModeReadable: false }),
      ).toBe("process_stream");
    }
  });

  it("FILE_TYPE_CHAR 但 GetConsoleMode 失败（NUL/COM 等字符设备重定向）→ 保持原流", () => {
    expect(
      mod.decideCliStdioSource({ attached: true, processStreamIsTty: false, fileType: mod.FILE_TYPE_CHAR, consoleModeReadable: false }),
    ).toBe("process_stream");
  });
});

describe("prepareCliStdio（darwin 上仅可观测非 win32 透传路径）", () => {
  it("非 win32：返回 process 流本体且 attached=false，不做任何接管", () => {
    if (process.platform === "win32") return; // 本用例仅覆盖非 win32 透传
    const mod = loadModule();
    const preparation = mod.prepareCliStdio();
    expect(preparation.stdout).toBe(process.stdout);
    expect(preparation.stderr).toBe(process.stderr);
    expect(preparation.attached).toBe(false);
  });
});

describe("koffi 完整性（node 环境真实加载）", () => {
  it("require('koffi') 可加载且暴露 load/func 使用面", () => {
    const koffi = requireDesktop("koffi") as { version: string; load: (path: string) => unknown };
    expect(typeof koffi.load).toBe("function");
    expect(typeof koffi.version).toBe("string");
  });

  it("当前平台的 @koromix 预编译 .node 存在（win32_x64 由 verify:packaged-native-runtimes 在 Windows 打包机断言）", () => {
    const binaryPath = join(
      workspaceRoot,
      "node_modules",
      "@koromix",
      `koffi-${process.platform}-${process.arch}`,
      `${process.platform}_${process.arch}`,
      "koffi.node",
    );
    expect(existsSync(binaryPath)).toBe(true);
  });
});

describe("koffi 惰性加载约束", () => {
  it("源码无顶层 koffi 值 import（type-only import 编译期擦除、不加载模块，不受限）", () => {
    const source = readFileSync(attachSource, "utf8");
    expect(source).not.toMatch(/^import (?!type )[^;]*["']koffi["']/m);
    expect(source).toContain('require("koffi")');
  });

  it("模块加载不得触碰 koffi（GUI 主进程常驻加载本模块，顶层 require 会污染非 win32 启动）", () => {
    const before = new Set(Object.keys(requireDesktop.cache));
    requireDesktop(attachEntry);
    const added = Object.keys(requireDesktop.cache).filter((path) => !before.has(path));
    expect(added.some((path) => path.includes("node_modules/koffi"))).toBe(false);
  });
});
