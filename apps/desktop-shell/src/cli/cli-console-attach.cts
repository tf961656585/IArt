import { closeSync, openSync } from "node:fs";
import { WriteStream as TtyWriteStream } from "node:tty";
import type { Writable } from "node:stream";
import type * as KoffiModule from "koffi";

/**
 * Windows CLI 控制台挂接与标准流接管（spec docs/integrations/CLI与本地Agent集成.md §4.1）。
 *
 * 根因（2026-10-14 批次）：iart CLI 是 Electron GUI 子系统 exe 的 --cli 模式，进程未接入
 * 父控制台时 libuv 对 stdout 句柄 GetConsoleMode 失败 → 判为非 TTY → 按 UTF-8 字节裸写，
 * conhost 按控制台代码页（zh-CN 为 936）解码 → 中文乱码。治本手段：CLI 分支在任何
 * stdout/stderr 接触之前先 AttachConsole(ATTACH_PARENT_PROCESS)（koffi N-API FFI 调
 * kernel32），挂接后 Node/libuv 的流判定会得到 TTY，走 WriteConsoleW 正确输出。
 *
 * 判定依据（实证修正）：Node 22.21.1（Electron 39 内置）与 Node 25.6.0 中 process.stdout
 * 的惰性 getter 在首次访问后仍然存在——getter 描述符区分不了「未被触碰」与「已缓存为
 * 陈旧非 TTY 流」。故改用可观察事实判定：挂接成功后读取 process 流，若已是
 * tty.WriteStream 说明本次具名化已得到正确 TTY 分类，直接用之；否则经 CONOUT$ 新开
 * 控制台句柄构造 tty.WriteStream 接管。句柄探测用 GetFileType(FILE_TYPE_CHAR) 加
 * GetConsoleMode 双重判定——NUL/COM 等字符设备重定向同为 FILE_TYPE_CHAR 但无控制台
 * 模式，必须排除，否则会劫持 `iart ... > NUL` 这类重定向输出。
 *
 * 硬性要求：本模块任何一步失败都降级为返回 process 流（= 修复前行为），绝不能让 CLI
 * 因修复本身报错或退出异常。模块顶层禁止 require koffi——GUI 主进程也加载本模块，
 * koffi 只允许在 win32 CLI 路径内惰性加载。
 */

/** stdio 取用策略：process 流或 CONOUT$ 控制台 TTY 流。 */
export type CliStdioSource = "process_stream" | "console_tty_stream";

/** Win32 GetFileType 文件类型常量（winnt.h）。 */
export const FILE_TYPE_UNKNOWN = 0;
export const FILE_TYPE_DISK = 1;
export const FILE_TYPE_CHAR = 2;
export const FILE_TYPE_PIPE = 3;

/** ATTACH_PARENT_PROCESS = (uintptr_t)-1：无符号最大值的位模式，经 intptr_t 参数承载（同一位模式）。 */
const ATTACH_PARENT_PROCESS = -1;
/** Win32 标准句柄编号（winbase.h；DWORD 形参按 (DWORD)-n 的二补数位模式传参）。 */
const STD_OUTPUT_HANDLE = -11;
const STD_ERROR_HANDLE = -12;

export interface CliStdioDecisionInput {
  /** AttachConsole(ATTACH_PARENT_PROCESS) 是否成功。 */
  attached: boolean;
  /** 挂接后读取的 process 流是否已是 tty.WriteStream（缓存冷 → 挂接后首次具名化即正确 TTY）。 */
  processStreamIsTty: boolean;
  /** GetFileType(std 句柄) 结果；null = 句柄探测失败或句柄无效。 */
  fileType: number | null;
  /** GetConsoleMode(std 句柄) 是否成功（控制台句柄判据，排除 NUL 等字符设备）。 */
  consoleModeReadable: boolean;
}

/**
 * 单一流取用策略（纯函数，全表单测）：
 * - 未挂接成功：保持原流（无控制台可接管，= 修复前行为）。
 * - 句柄为控制台（FILE_TYPE_CHAR 且 GetConsoleMode 成功）：process 流已是 TTY → 用之；
 *   否则 CONOUT$ 接管（覆盖「Electron 内部已提前具名化 stdout」的陈旧缓存情形）。
 * - 其余（PIPE/DISK/字符设备重定向/UNKNOWN/探测失败）：保持原流，不劫持重定向输出。
 */
export const decideCliStdioSource = (input: CliStdioDecisionInput): CliStdioSource => {
  if (!input.attached) return "process_stream";
  if (input.fileType === FILE_TYPE_CHAR && input.consoleModeReadable && !input.processStreamIsTty) {
    return "console_tty_stream";
  }
  return "process_stream";
};

/** koffi 的 d.ts 对函数调用返回 any（no-unsafe-* 门禁），经单次 as 收窄为本模块用到的形状。 */
interface Kernel32Funcs {
  /** AttachConsole：BOOL 返回，koffi 'bool' 解码为 boolean。 */
  attachConsole: (processId: number) => boolean;
  /** GetStdHandle：HANDLE 返回，koffi 'void *' 解码为 null 或 BigInt 地址。 */
  getStdHandle: (nStdHandle: number) => unknown;
  /** GetFileType：DWORD 返回，koffi 'uint32' 解码为 number。 */
  getFileType: (handle: unknown) => number;
  /** GetConsoleMode：BOOL 返回；mode 值本身不消费，只看调用成败。 */
  getConsoleMode: (handle: unknown, modeBuffer: Buffer) => boolean;
}

const loadKernel32Funcs = (): Kernel32Funcs => {
  const koffi = require("koffi") as typeof KoffiModule;
  const kernel32 = koffi.load("kernel32.dll");
  const attachConsole = kernel32.func("AttachConsole", "bool", ["intptr_t"]) as (processId: number) => boolean;
  const getStdHandle = kernel32.func("GetStdHandle", "void *", ["int32"]) as (nStdHandle: number) => unknown;
  const getFileType = kernel32.func("GetFileType", "uint32", ["void *"]) as (handle: unknown) => number;
  // Buffer 作为 void * 指针承载 LPDWORD 出参内存。
  const getConsoleMode = kernel32.func("GetConsoleMode", "bool", ["void *", "void *"]) as (
    handle: unknown,
    modeBuffer: Buffer,
  ) => boolean;
  return { attachConsole, getStdHandle, getFileType, getConsoleMode };
};

/**
 * 尝试挂接父控制台；返回 kernel32 绑定（非 null = 挂接成功）。
 * koffi 加载失败、无父控制台（ERROR_ACCESS_DENIED）等失败形态一律静默降级为 null。
 */
const attachParentConsole = (): Kernel32Funcs | null => {
  try {
    const funcs = loadKernel32Funcs();
    if (funcs.attachConsole(ATTACH_PARENT_PROCESS)) return funcs;
    return null;
  } catch {
    return null;
  }
};

interface StdHandleProbe {
  fileType: number | null;
  consoleModeReadable: boolean;
}

/** GetStdHandle + GetFileType + GetConsoleMode 探测；失败/无效句柄按「探测失败」返回。 */
const probeStdHandle = (funcs: Kernel32Funcs, nStdHandle: number): StdHandleProbe => {
  try {
    const handle = funcs.getStdHandle(nStdHandle);
    // koffi 对 void * 返回值解码为 BigInt 地址，NULL 解码为 null。
    if (handle === null || (typeof handle === "bigint" && handle === 0n)) {
      return { fileType: null, consoleModeReadable: false };
    }
    const fileType = funcs.getFileType(handle);
    if (fileType !== FILE_TYPE_CHAR) {
      return { fileType, consoleModeReadable: false };
    }
    return { fileType, consoleModeReadable: funcs.getConsoleMode(handle, Buffer.alloc(4)) };
  } catch {
    return { fileType: null, consoleModeReadable: false };
  }
};

/** 经 CONOUT$ 新开控制台输出句柄构造 TTY 写流；构造失败关闭句柄并返回 null（调用方回退原流）。 */
const openConsoleTtyStream = (): TtyWriteStream | null => {
  let fd: number | null = null;
  try {
    fd = openSync("CONOUT$", "w");
    return new TtyWriteStream(fd);
  } catch {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 句柄已不可用，关闭失败无需处理
      }
    }
    return null;
  }
};

export interface CliStdioPreparation {
  stdout: Writable;
  stderr: Writable;
  /** AttachConsole 是否成功（win32 且挂接成功为 true；其余 false）。 */
  attached: boolean;
}

/**
 * CLI 分支标准流准备（main.cts 在动态加载 CLI 客户端之前调用，win32 门控由调用方负责）。
 *
 * 顺序硬约束：必须先完成 AttachConsole，再首次接触 process.stdout/stderr——预挂接的
 * 具名化会把非 TTY 分类固化进 Node 的惰性缓存。挂接成功后本函数对 process 流的读取
 * 是安全的：缓存冷 → 立即得到正确 TTY 分类；缓存热 → 按探测结果走 CONOUT$ 兜底。
 */
export const prepareCliStdio = (): CliStdioPreparation => {
  if (process.platform !== "win32") {
    return { stdout: process.stdout, stderr: process.stderr, attached: false };
  }

  const funcs = attachParentConsole();
  if (funcs === null) {
    return { stdout: process.stdout, stderr: process.stderr, attached: false };
  }

  const processStdout = process.stdout;
  const processStderr = process.stderr;
  const stdoutProbe = probeStdHandle(funcs, STD_OUTPUT_HANDLE);
  const stderrProbe = probeStdHandle(funcs, STD_ERROR_HANDLE);

  const stdoutSource = decideCliStdioSource({
    attached: true,
    processStreamIsTty: processStdout instanceof TtyWriteStream,
    fileType: stdoutProbe.fileType,
    consoleModeReadable: stdoutProbe.consoleModeReadable,
  });
  const stderrSource = decideCliStdioSource({
    attached: true,
    processStreamIsTty: processStderr instanceof TtyWriteStream,
    fileType: stderrProbe.fileType,
    consoleModeReadable: stderrProbe.consoleModeReadable,
  });

  const stdout = stdoutSource === "console_tty_stream" ? (openConsoleTtyStream() ?? processStdout) : processStdout;
  const stderr = stderrSource === "console_tty_stream" ? (openConsoleTtyStream() ?? processStderr) : processStderr;

  return { stdout, stderr, attached: true };
};

/**
 * CLI 输出写盘原语：write(text, 回调) → 回调触发（数据已交给 OS 句柄）才 resolve。
 * app.exit 不等待 libuv 刷新，所有 CLI 输出必须经本原语落定后再退出。
 * 投递失败以异常上抛，由调用方决定降级方式（本模块不吞）。
 */
export const writeCliOutput = async (stream: Writable, text: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    try {
      stream.write(text, (error: Error | null | undefined) => (error ? reject(error) : resolve()));
    } catch (cause: unknown) {
      reject(cause);
    }
  });
};
