import { createConsoleWriter } from "./cli-console-writer.cjs";
import type { CliOutputTarget, WriteConsoleWCall } from "./cli-console-writer.cjs";
import type * as KoffiModule from "koffi";
import type { appendMainLog } from "../main-log.cjs";

/**
 * Windows CLI 标准流通道判定与控制台接管（spec docs/integrations/CLI与本地Agent集成.md
 * §4.1 / CLI-022、CLI-023）。
 *
 * 根因（2026-10-14 真机实证）：iart CLI 是 Electron GUI 子系统 exe 的 --cli 模式，控制台
 * 父进程无重定向启动时 GetStdHandle 返回有效屏缓冲句柄（GetFileType=CHAR、GetConsoleMode
 * 成功），但 GUI 进程的 process.stdout.isTTY 恒为 false——libuv 按 UTF-8 字节裸写，conhost
 * 按控制台代码页（zh-CN 为 936）解码 → 中文乱码。此时 AttachConsole 返回 ACCESS_DENIED
 * （=5，进程已连接控制台），fs 层设备名直开（旧 CONOUT$ 接管路径）被 Electron fs 补丁按
 * 相对路径解析且 EPERM——旧决策门把「AttachConsole 成功」当接管硬前提，在主导场景下
 * 永不成立。
 *
 * 决策门重构口径（本批次拍板）：stdout/stderr 各自独立判定，接管资格只看句柄三元组——
 * GetStdHandle 有效 + GetFileType 为 CHAR + GetConsoleMode 成功 → 控制台写入器
 * （WriteConsoleW 直写 UTF-16LE，见 cli-console-writer）。AttachConsole 仅在句柄无效时作
 * 兜底挂接尝试（成功后重新探测再判定），失败（含 ACCESS_DENIED=已连接）不阻断接管；
 * isTTY 不参与决策（GUI 进程恒 false，无判别力）。PIPE/DISK/UNKNOWN/探测异常 → 原流
 * （字节流语义不变）；NUL 等 CHAR 设备重定向靠 GetConsoleMode 失败排除，判据必须保留。
 *
 * 留痕：koffi 加载成败、AttachConsole 结果与 GetLastError、每路句柄三元组、决策结果、
 * 写入器创建结果、写入失败全部经 appendMainLog 落 logs/main.log（本文件与 main-log 的
 * 关联经惰性 require 建立——本模块被 GUI 主进程常驻加载，顶层 import 会把 electron 拉进
 * 纯 node 测试环境）；另设 IART_CLI_STDIO_DEBUG=1 门控的 stderr 纯 ASCII 单行诊断，便于
 * 真机当场肉眼取证。
 *
 * 硬性要求：任何一步失败都降级为 process 流（= 修复前行为），绝不能让 CLI 因修复本身
 * 报错或退出异常。模块顶层禁止 require koffi——koffi 只允许在 win32 CLI 路径内惰性加载。
 */

/** stdio 取用策略：process 流（原字节流语义）或控制台写入器（WriteConsoleW 直写）。 */
export type CliStdioSource = "process_stream" | "console_writer";

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
  /** GetFileType(std 句柄) 结果；null = 句柄无效或探测失败。 */
  fileType: number | null;
  /** GetConsoleMode 是否成功（控制台句柄判据，排除 NUL 等字符设备重定向）。 */
  consoleModeReadable: boolean;
}

/**
 * 单一流取用策略（纯函数，全表单测）：接管资格只由句柄三元组决定，AttachConsole 成败与
 * process 流 isTTY 都不进入决策。
 * - CHAR 且 GetConsoleMode 成功（真实控制台屏缓冲）→ 控制台写入器。
 * - 其余（PIPE/DISK/UNKNOWN/句柄无效/探测失败/CHAR 但无控制台模式的字符设备重定向）→
 *   原流，不劫持重定向输出。
 */
export const decideCliStdioSource = (input: CliStdioDecisionInput): CliStdioSource =>
  input.fileType === FILE_TYPE_CHAR && input.consoleModeReadable ? "console_writer" : "process_stream";

/** koffi 的 d.ts 对函数调用返回 any（no-unsafe-* 门禁），经单次 as 收窄为本模块用到的形状。 */
interface Kernel32Funcs {
  /** AttachConsole：BOOL 返回，koffi 'bool' 解码为 boolean。 */
  attachConsole: (processId: number) => boolean;
  /** GetStdHandle：HANDLE 返回，koffi 'void *' 解码为 null 或 BigInt 地址。 */
  getStdHandle: (nStdHandle: number) => unknown;
  /** GetFileType：DWORD 返回，koffi 'uint32' 解码为 number。 */
  getFileType: (handle: unknown) => number;
  /** GetConsoleMode：BOOL 返回；mode 值经出参 Buffer 读取。 */
  getConsoleMode: (handle: unknown, modeBuffer: Buffer) => boolean;
  /** GetLastError：最近一次 kernel32 调用的错误码（诊断用，跟随同线程上一次失败调用）。 */
  getLastError: () => number;
  /** WriteConsoleW：UTF-16LE 缓冲直写控制台屏缓冲；reserved 固定传 null。 */
  writeConsoleW: (
    handle: unknown,
    buffer: Buffer,
    charsToWrite: number,
    writtenBuffer: Buffer,
    reserved: null,
  ) => boolean;
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
  const getLastError = kernel32.func("GetLastError", "uint32", []) as () => number;
  const writeConsoleW = kernel32.func("WriteConsoleW", "bool", ["void *", "void *", "uint32", "void *", "void *"]) as (
    handle: unknown,
    buffer: Buffer,
    charsToWrite: number,
    writtenBuffer: Buffer,
    reserved: null,
  ) => boolean;
  return { attachConsole, getStdHandle, getFileType, getConsoleMode, getLastError, writeConsoleW };
};

/** koffi facade → 写入器注入面的适配：WriteConsoleW 失败时立即带回 GetLastError。 */
const toWriteConsoleWCall = (funcs: Kernel32Funcs): WriteConsoleWCall => {
  return (handle, buffer, charsToWrite, writtenBuffer) => {
    const ok = funcs.writeConsoleW(handle, buffer, charsToWrite, writtenBuffer, null);
    return { ok, gle: ok ? 0 : funcs.getLastError() };
  };
};

type MainLogFn = typeof appendMainLog;

/**
 * CLI 决策留痕元数据的固定字段接口（本模块全部调用点的字段并集，optional 按调用点取用）；
 * appendMainLog 的 meta 形参本就是 unknown，固定接口对象可直接赋值，不放宽其签名。
 */
interface CliStdioLogMeta {
  /** 通道名（probe / 写入器 / 写入失败类留痕）。 */
  channel?: "out" | "err";
  /** 句柄诊断串（0x… 或 null/unknown）。 */
  handle?: string;
  /** GetFileType 结果（probe 留痕）。 */
  fileType?: number | null;
  /** GetConsoleMode 模式位（probe 留痕）。 */
  consoleModeValue?: number | null;
  /** GetLastError 错误码（AttachConsole 失败留痕）。 */
  gle?: number;
  /** 异常/失败明细（探测异常、koffi 加载、写入器创建、写入失败类留痕）。 */
  detail?: string;
  /** stdout 通道决策结果。 */
  stdout?: CliStdioSource;
  /** stderr 通道决策结果。 */
  stderr?: CliStdioSource;
}

/** main-log 惰性加载缓存：undefined = 尚未尝试，null = 加载失败（不再重试）。 */
let mainLogFn: MainLogFn | null | undefined;

/** CLI 决策全路径留痕（logs/main.log）；留痕通道不可用即放弃，不影响主链。 */
const appendCliMainLog = (level: "debug" | "warn", message: string, meta: CliStdioLogMeta): void => {
  if (mainLogFn === undefined) {
    try {
      mainLogFn = (require("../main-log.cjs") as { appendMainLog: MainLogFn }).appendMainLog;
    } catch {
      mainLogFn = null;
    }
  }
  if (mainLogFn === null) return;
  try {
    mainLogFn(level, message, meta);
  } catch {
    // 单条留痕失败不放大为主链失败
  }
};

/** IART_CLI_STDIO_DEBUG=1 门控的 stderr 逐条诊断行；强制纯 ASCII，任意控制台代码页下可肉眼取证。 */
const debugTrace = (line: string): void => {
  if (process.env.IART_CLI_STDIO_DEBUG !== "1") return;
  const ascii = line.replace(/[^\x20-\x7e]/g, "?");
  try {
    process.stderr.write(`[cli-stdio] ${ascii}\n`);
  } catch {
    // 诊断通道不可用即放弃（诊断不干扰主链）
  }
};

interface StdHandleProbe {
  /** GetStdHandle 是否返回了非空句柄（null/0 = 无效）。 */
  handleValid: boolean;
  /** 探测所得句柄（WriteConsoleW 写入目标）；无效时 null。 */
  handle: bigint | null;
  /** 句柄诊断串（0x… 或 null/unknown）。 */
  handleHex: string;
  /** GetFileType 结果；探测异常时 null。 */
  fileType: number | null;
  /** GetConsoleMode 成功时的模式位；失败/未执行时 null（NUL 等字符设备重定向判据）。 */
  consoleModeValue: number | null;
}

/** GetStdHandle + GetFileType + GetConsoleMode 三元组探测，全路径留痕；异常按「无效」返回。 */
const probeStdHandle = (funcs: Kernel32Funcs, channel: "out" | "err", nStdHandle: number): StdHandleProbe => {
  try {
    const handle = funcs.getStdHandle(nStdHandle);
    if (typeof handle !== "bigint" || handle === 0n) {
      appendCliMainLog("debug", "[cli] stdio 句柄探测：句柄无效", { channel, handle: "null", fileType: null, consoleModeValue: null });
      debugTrace(`probe ${channel} handle=null`);
      return { handleValid: false, handle: null, handleHex: "null", fileType: null, consoleModeValue: null };
    }
    const handleHex = `0x${handle.toString(16)}`;
    const fileType = funcs.getFileType(handle);
    let consoleModeValue: number | null = null;
    if (fileType === FILE_TYPE_CHAR) {
      const modeBuffer = Buffer.alloc(4);
      if (funcs.getConsoleMode(handle, modeBuffer)) consoleModeValue = modeBuffer.readUInt32LE(0);
    }
    appendCliMainLog("debug", "[cli] stdio 句柄探测", { channel, handle: handleHex, fileType, consoleModeValue });
    debugTrace(
      `probe ${channel} handle=${handleHex} type=${fileType} mode=${consoleModeValue === null ? "fail" : `0x${consoleModeValue.toString(16)}`}`,
    );
    return { handleValid: true, handle, handleHex, fileType, consoleModeValue };
  } catch (cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    appendCliMainLog("warn", "[cli] stdio 句柄探测异常，该路按原流处理", { channel, detail });
    debugTrace(`probe ${channel} error ${detail}`);
    return { handleValid: false, handle: null, handleHex: "unknown", fileType: null, consoleModeValue: null };
  }
};

/** 句柄无效时的 AttachConsole 兜底尝试；成败与 GetLastError 全留痕，失败不阻断接管。 */
const tryAttachParentConsole = (funcs: Kernel32Funcs): boolean => {
  try {
    if (funcs.attachConsole(ATTACH_PARENT_PROCESS)) {
      appendCliMainLog("debug", "[cli] AttachConsole 成功", {});
      debugTrace("attach ok");
      return true;
    }
    const gle = funcs.getLastError();
    appendCliMainLog("warn", "[cli] AttachConsole 失败（不阻断接管，接管资格由句柄三元组决定）", { gle });
    debugTrace(`attach=false gle=${gle}`);
    return false;
  } catch (cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    appendCliMainLog("warn", "[cli] AttachConsole 调用异常（不阻断接管）", { detail });
    debugTrace(`attach=false error ${detail}`);
    return false;
  }
};

/** 控制台写入器构造（含创建失败回退原流的留痕）。 */
const createChannelWriter = (
  funcs: Kernel32Funcs,
  channel: "out" | "err",
  probe: StdHandleProbe,
  fallback: CliOutputTarget,
): CliOutputTarget => {
  try {
    const writer = createConsoleWriter(probe.handle, toWriteConsoleWCall(funcs), {
      channel,
      writeFailure: (detail) => {
        appendCliMainLog("warn", "[cli] 控制台写入失败（不改退出码）", { channel, detail });
        debugTrace(`write-fail ${channel} ${detail}`);
      },
    });
    appendCliMainLog("debug", "[cli] 控制台写入器就绪", { channel, handle: probe.handleHex });
    debugTrace(`writer ${channel}=ok handle=${probe.handleHex}`);
    return writer;
  } catch (cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    appendCliMainLog("warn", "[cli] 控制台写入器创建失败，回退原流", { channel, detail });
    debugTrace(`writer ${channel}=fallback ${detail}`);
    return fallback;
  }
};

export interface CliStdioPreparation {
  stdout: CliOutputTarget;
  stderr: CliOutputTarget;
}

/**
 * CLI 分支标准流准备（main.cts 在动态加载 CLI 客户端之前调用，win32 门控由调用方负责）。
 *
 * 顺序：先探测两路标准句柄三元组；任一路句柄无效（GUI 进程被脱离控制台启动等）才尝试
 * AttachConsole 兜底并重新探测；随后每路独立按三元组决策——控制台通道用 WriteConsoleW
 * 写入器接管，其余回退 process 流（原字节流语义）。全程留痕，任何失败降级为原流。
 */
export const prepareCliStdio = (): CliStdioPreparation => {
  if (process.platform !== "win32") {
    debugTrace(`platform=${process.platform} passthrough`);
    return { stdout: process.stdout, stderr: process.stderr };
  }

  let funcs: Kernel32Funcs;
  try {
    funcs = loadKernel32Funcs();
  } catch (cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    appendCliMainLog("warn", "[cli] koffi/kernel32 绑定失败，CLI 标准流回退原流", { detail });
    debugTrace(`koffi-load fail ${detail}`);
    return { stdout: process.stdout, stderr: process.stderr };
  }
  appendCliMainLog("debug", "[cli] kernel32 经 koffi 绑定完成", {});
  debugTrace("koffi-load ok");

  let stdoutProbe = probeStdHandle(funcs, "out", STD_OUTPUT_HANDLE);
  let stderrProbe = probeStdHandle(funcs, "err", STD_ERROR_HANDLE);

  if (!stdoutProbe.handleValid || !stderrProbe.handleValid) {
    if (tryAttachParentConsole(funcs)) {
      // 挂接会替换 std 句柄，必须重新探测后再按三元组判定。
      stdoutProbe = probeStdHandle(funcs, "out", STD_OUTPUT_HANDLE);
      stderrProbe = probeStdHandle(funcs, "err", STD_ERROR_HANDLE);
    }
  }

  const toDecisionInput = (probe: StdHandleProbe): CliStdioDecisionInput => ({
    fileType: probe.fileType,
    consoleModeReadable: probe.consoleModeValue !== null,
  });
  const stdoutSource = decideCliStdioSource(toDecisionInput(stdoutProbe));
  const stderrSource = decideCliStdioSource(toDecisionInput(stderrProbe));
  appendCliMainLog("debug", "[cli] stdio 通道决策", { stdout: stdoutSource, stderr: stderrSource });
  debugTrace(`decision out=${stdoutSource} err=${stderrSource}`);

  const stdout =
    stdoutSource === "console_writer" ? createChannelWriter(funcs, "out", stdoutProbe, process.stdout) : process.stdout;
  const stderr =
    stderrSource === "console_writer" ? createChannelWriter(funcs, "err", stderrProbe, process.stderr) : process.stderr;

  return { stdout, stderr };
};

/**
 * CLI 输出写盘原语：write(text, 回调) → 回调触发（数据已交给 OS 句柄/控制台）才 resolve。
 * app.exit 不等待 libuv 刷新，所有 CLI 输出必须经本原语落定后再退出。
 * 投递失败以异常上抛，由调用方决定降级方式（本模块不吞）。
 */
export const writeCliOutput = async (target: CliOutputTarget, text: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    try {
      target.write(text, (error: Error | null | undefined) => (error ? reject(error) : resolve()));
    } catch (cause: unknown) {
      reject(cause);
    }
  });
};
