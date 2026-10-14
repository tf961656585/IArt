// @vitest-environment node
//
// cli-console-attach / cli-console-writer 测试（Windows 控制台中文输出批次，2026-10-14）。
// @spec: CLI-022
//
// 决策门重构口径（真机实证后的拍板）：接管资格只由每路标准句柄三元组决定
// （GetStdHandle 有效 + GetFileType CHAR + GetConsoleMode 成功）；AttachConsole 成败与
// process 流 isTTY（GUI 进程恒 false，无判别力）都不进入决策。控制台写入器经
// WriteConsoleW 直写 UTF-16LE，kernel32 面以注入替身测试；CONOUT$ 接管路径已删除
// （Electron fs 补丁把设备名当相对路径 + EPERM，实测不可达）。koffi 惰性加载约束保留
// （GUI 主进程常驻加载本模块，不得在顶层 require koffi）。
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const attachEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-console-attach.cjs`;
const writerEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-console-writer.cjs`;
const attachSource = `${workspaceRoot}/apps/desktop-shell/src/cli/cli-console-attach.cts`;
const writerSource = `${workspaceRoot}/apps/desktop-shell/src/cli/cli-console-writer.cts`;

type CliStdioSource = "process_stream" | "console_writer";
type CliStdioDecisionInput = { fileType: number | null; consoleModeReadable: boolean };
type AttachModule = {
  decideCliStdioSource: (input: CliStdioDecisionInput) => CliStdioSource;
  prepareCliStdio: () => { stdout: unknown; stderr: unknown };
  FILE_TYPE_UNKNOWN: number;
  FILE_TYPE_DISK: number;
  FILE_TYPE_CHAR: number;
  FILE_TYPE_PIPE: number;
};
type WriteConsoleWCall = (
  handle: unknown,
  utf16Buffer: Buffer,
  charsToWrite: number,
  writtenBuffer: Buffer,
) => { ok: boolean; gle: number };
type ConsoleWriterHooks = { channel: "out" | "err"; writeFailure: (detail: string) => void };
type ConsoleWriter = { write: (text: string, callback: (error: Error | null) => void) => boolean };
type WriterModule = {
  createConsoleWriter: (handle: unknown, writeConsoleW: WriteConsoleWCall, hooks: ConsoleWriterHooks) => ConsoleWriter;
  normalizeConsoleNewlines: (text: string) => string;
  sliceUtf16Chunks: (text: string) => string[];
  CONSOLE_WRITE_CHUNK_CHARS: number;
};

const loadModule = (): AttachModule => requireDesktop(attachEntry) as AttachModule;
// 注意：加载延迟到用例体内执行——模块缺失/形状不符要以断言形式红，而非文件级收集失败。
const loadWriterModule = (): WriterModule => requireDesktop(writerEntry) as WriterModule;

describe("decideCliStdioSource 决策表（句柄三元组纯函数全分支）", () => {
  it("控制台三元组合格（CHAR + GetConsoleMode 成功）→ console_writer；不问 AttachConsole——失败（含 ACCESS_DENIED=已连接）不阻断接管", () => {
    const mod = loadModule();
    expect(
      mod.decideCliStdioSource({ fileType: mod.FILE_TYPE_CHAR, consoleModeReadable: true }),
    ).toBe("console_writer");
  });

  it("非控制台句柄（PIPE/DISK/UNKNOWN/句柄无效、探测失败）→ process_stream，不劫持重定向输出", () => {
    const mod = loadModule();
    for (const fileType of [null, mod.FILE_TYPE_UNKNOWN, mod.FILE_TYPE_DISK, mod.FILE_TYPE_PIPE]) {
      expect(mod.decideCliStdioSource({ fileType, consoleModeReadable: false })).toBe("process_stream");
      expect(mod.decideCliStdioSource({ fileType, consoleModeReadable: true })).toBe("process_stream");
    }
  });

  it("FILE_TYPE_CHAR 但 GetConsoleMode 失败（NUL/COM 等字符设备重定向）→ process_stream（判据必须保留）", () => {
    const mod = loadModule();
    expect(
      mod.decideCliStdioSource({ fileType: mod.FILE_TYPE_CHAR, consoleModeReadable: false }),
    ).toBe("process_stream");
  });
});

describe("createConsoleWriter（WriteConsoleW 注入替身，全分支）", () => {
  interface FakeOptions {
    ok?: boolean;
    gle?: number;
    writtenRatio?: number;
    throwMessage?: string;
  }

  const makeFakeWriteConsoleW = (options: FakeOptions = {}) => {
    const calls: { handle: unknown; text: string; chars: number }[] = [];
    const call: WriteConsoleWCall = (handle, utf16Buffer, charsToWrite, writtenBuffer) => {
      calls.push({ handle, text: utf16Buffer.toString("utf16le"), chars: charsToWrite });
      if (options.throwMessage !== undefined) throw new Error(options.throwMessage);
      if (options.ok === false) return { ok: false, gle: options.gle ?? 5 };
      const written =
        options.writtenRatio === undefined ? charsToWrite : Math.floor(charsToWrite * options.writtenRatio);
      writtenBuffer.writeUInt32LE(written, 0);
      return { ok: true, gle: 0 };
    };
    return { call, calls };
  };

  const makeHooks = () => {
    const failures: string[] = [];
    const hooks: ConsoleWriterHooks = {
      channel: "out",
      writeFailure: (detail) => failures.push(detail),
    };
    return { hooks, failures };
  };

  /** 同步收集回调结果：write 返回时必须已经回调（同步 WriteConsoleW + 立即回调语义）。 */
  const writeSync = (writer: ConsoleWriter, text: string): Error | null => {
    let captured: Error | null = null;
    writer.write(text, (error) => {
      captured = error;
    });
    return captured;
  };

  it("CONSOLE_WRITE_CHUNK_CHARS 钉在 8192", () => {
    expect(loadWriterModule().CONSOLE_WRITE_CHUNK_CHARS).toBe(8192);
  });

  it("写入同步完成：回调在 write 返回前已收到 null，文本经 UTF-16LE 与句柄一起交给 WriteConsoleW", () => {
    const mod = loadWriterModule();
    const fake = makeFakeWriteConsoleW();
    const { hooks } = makeHooks();
    const writer = mod.createConsoleWriter(0x1234n, fake.call, hooks);

    const error = writeSync(writer, "你好 iart");

    expect(error).toBe(null);
    expect(fake.calls).toEqual([{ handle: 0x1234n, text: "你好 iart", chars: 7 }]);
  });

  it("换行归一：\\n → \\r\\n，既有 \\r\\n 不重复，孤立 \\r 不动", () => {
    expect(loadWriterModule().normalizeConsoleNewlines("a\nb\r\nc\rd")).toBe("a\r\nb\r\nc\rd");
  });

  it("分块：超长文本按 ≤8192 UTF-16 码元分块且逐块拼接与原文一致", () => {
    const mod = loadWriterModule();
    const fake = makeFakeWriteConsoleW();
    const { hooks } = makeHooks();
    const writer = mod.createConsoleWriter(1n, fake.call, hooks);
    const text = "中".repeat(9000); // 9000 UTF-16 码元（BMP 字符每字符 1 码元）

    const error = writeSync(writer, text);

    expect(error).toBe(null);
    expect(fake.calls.length).toBe(2);
    for (const call of fake.calls) expect(call.chars).toBeLessThanOrEqual(mod.CONSOLE_WRITE_CHUNK_CHARS);
    expect(fake.calls.map((call) => call.text).join("")).toBe(text);
  });

  it("块边界落在高代理上时整对挪到下一块，不拆散代理对", () => {
    const mod = loadWriterModule();
    const fake = makeFakeWriteConsoleW();
    const { hooks } = makeHooks();
    const writer = mod.createConsoleWriter(1n, fake.call, hooks);
    const text = `${"x".repeat(8191)}😀${"y".repeat(50)}`; // 高代理恰在 8192 边界前一位

    const error = writeSync(writer, text);

    expect(error).toBe(null);
    expect(fake.calls.length).toBe(2);
    expect(fake.calls[0]?.text.length).toBe(8191);
    expect(fake.calls[1]?.text.startsWith("😀")).toBe(true);
    expect(fake.calls.map((call) => call.text).join("")).toBe(text);
  });

  it("WriteConsoleW 失败：回调收到 Error、留痕钩子收到含 gle 的明细，write 返回 false 不抛异常", () => {
    const mod = loadWriterModule();
    const fake = makeFakeWriteConsoleW({ ok: false, gle: 5 });
    const { hooks, failures } = makeHooks();
    const writer = mod.createConsoleWriter(1n, fake.call, hooks);

    let captured: Error | null | undefined;
    let returned = false;
    const returnedValue = writer.write("你好", (error) => {
      captured = error;
    });
    returned = true;

    expect(returnedValue).toBe(false);
    expect(returned).toBe(true); // 回调发生在 write 返回之前（同步），未抛异常
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain("gle=5");
    expect((captured as Error).message).toContain("out");
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain("gle=5");
  });

  it("部分写入（written < 期望字符数）按失败处理", () => {
    const mod = loadWriterModule();
    const fake = makeFakeWriteConsoleW({ writtenRatio: 0.5 });
    const { hooks, failures } = makeHooks();
    const writer = mod.createConsoleWriter(1n, fake.call, hooks);

    let captured: Error | null = null;
    writer.write("你好 iart", (error) => {
      captured = error;
    });

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain("written=3");
    expect(failures.length).toBe(1);
  });

  it("注入函数抛异常：回调收到 Error、留痕钩子调用，异常不上抛炸进程", () => {
    const mod = loadWriterModule();
    const fake = makeFakeWriteConsoleW({ throwMessage: "boom" });
    const { hooks, failures } = makeHooks();
    const writer = mod.createConsoleWriter(1n, fake.call, hooks);

    let captured: Error | null = null;
    const returnedValue = writer.write("x", (error) => {
      captured = error;
    });

    expect(returnedValue).toBe(false);
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain("boom");
    expect(failures.length).toBe(1);
  });
});

describe("sliceUtf16Chunks 纯函数", () => {
  it("短文本单块且等于原文；长文本全块 ≤ 上限且可复原", () => {
    const mod = loadWriterModule();
    expect(mod.sliceUtf16Chunks("abc")).toEqual(["abc"]);
    const text = "中".repeat(6000);
    const chunks = mod.sliceUtf16Chunks(text);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(mod.CONSOLE_WRITE_CHUNK_CHARS);
    expect(chunks.join("")).toBe(text);
  });
});

describe("prepareCliStdio（darwin 上仅可观测非 win32 透传路径）", () => {
  it("非 win32：返回 process 流本体，不做任何接管", () => {
    if (process.platform === "win32") return; // 本用例仅覆盖非 win32 透传
    const preparation = loadModule().prepareCliStdio();
    expect(preparation.stdout).toBe(process.stdout);
    expect(preparation.stderr).toBe(process.stderr);
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

describe("源码级约束（惰性加载与已删路径）", () => {
  it("源码无顶层 koffi 值 import（type-only import 编译期擦除、不加载模块，不受限）", () => {
    const source = readFileSync(attachSource, "utf8");
    expect(source).not.toMatch(/^import (?!type )[^;]*["']koffi["']/m);
    expect(source).toContain('require("koffi")');
  });

  it("CONOUT$ 接管路径已彻底删除（fs 层设备名直开被相对路径解析 + EPERM，实测不可达）", () => {
    // attach 侧钉「fs 层直开调用」不复存在；writer 侧钉「设备名连字面量引用都不再有」。
    expect(readFileSync(attachSource, "utf8")).not.toContain("openSync");
    expect(readFileSync(writerSource, "utf8")).not.toContain("CONOUT$");
  });

  it("模块加载不得触碰 koffi / main-log / electron（GUI 主进程常驻加载；main-log 仅 win32 路径惰性 require）", () => {
    for (const key of Object.keys(requireDesktop.cache)) {
      if (key.includes("apps/desktop-shell/dist/cli/")) delete requireDesktop.cache[key];
    }
    const before = new Set(Object.keys(requireDesktop.cache));
    requireDesktop(attachEntry);
    const added = Object.keys(requireDesktop.cache).filter((path) => !before.has(path));
    const forbidden = added.filter(
      (path) =>
        path.includes("node_modules/koffi") || path.includes("main-log") || path.includes("node_modules/electron"),
    );
    expect(forbidden).toEqual([]);
  });
});
