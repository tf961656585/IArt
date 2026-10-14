/**
 * Windows 控制台写入器：WriteConsoleW 直写屏缓冲（spec docs/integrations/CLI与本地Agent集成.md
 * §4.1 / CLI-022）。
 *
 * 背景（2026-10-14 决策门重构批次）：iart 是 GUI 子系统 exe 的 --cli 模式，控制台父进程场景
 * 下 GetStdHandle 返回有效屏缓冲句柄，但 Electron GUI 进程的 process.stdout 恒非 TTY，
 * libuv 按 UTF-8 字节裸写、conhost 按控制台代码页（zh-CN 为 936）解码 → 中文乱码。治本：
 * 对判定为控制台句柄的通道，以 UTF-16LE 经 WriteConsoleW 直写，编码转换在本侧完成，
 * 不依赖控制台代码页（chcp 读数不受影响）。
 *
 * 为什么不是 tty.WriteStream / 控制台设备名直开：实测 fs 层设备名直开在该运行时被
 * Electron fs 补丁按相对路径解析（拼到 cwd 下）且报 EPERM——设备名接管路径不可达，已删除；
 * 写入句柄直接使用探测所得的 GetStdHandle 屏缓冲句柄。
 *
 * 本模块保持纯注入形态：WriteConsoleW 以函数注入（koffi facade 在 cli-console-attach 侧
 * 负责绑定并把 GetLastError 一并带回），不 import koffi/electron/main-log，macOS 测试以
 * 替身驱动全部分支。写入失败语义：以回调上抛、由调用方决定降级，不改退出码（现状语义），
 * 留痕经注入的 writeFailure 钩子完成。
 */

/** CLI 输出目标的最小结构面：真实流（process.stdout 等）与控制台写入器共同满足。 */
export interface CliOutputTarget {
  write(text: string, callback: (error?: Error | null) => void): unknown;
}

/** WriteConsoleW 注入面：ok=false 时 gle 为该次调用的 GetLastError 值。 */
export type WriteConsoleWCall = (
  handle: unknown,
  utf16Buffer: Buffer,
  charsToWrite: number,
  writtenBuffer: Buffer,
) => { ok: boolean; gle: number };

/** 单次 WriteConsoleW 的 UTF-16 码元上限：避免超长缓冲在 conhost 上整段失败。 */
export const CONSOLE_WRITE_CHUNK_CHARS = 8192;

export interface ConsoleWriterHooks {
  /** 通道名（out/err），进留痕与错误明细。 */
  channel: "out" | "err";
  /** 单次写入失败留痕（main.log warn + IART_CLI_STDIO_DEBUG 诊断行，由 attach 模块注入）。 */
  writeFailure: (detail: string) => void;
}

/** \n 归一为 \r\n（既有 \r\n 不重复、孤立 \r 不动）；控制台屏缓冲需要 CRLF 才换行回列首。 */
export const normalizeConsoleNewlines = (text: string): string => text.replace(/\r?\n/g, "\r\n");

/** 按 UTF-16 码元分块（≤ 上限）；块边界落在高代理上时整对挪到下一块，不拆散代理对。 */
export const sliceUtf16Chunks = (text: string): string[] => {
  if (text.length <= CONSOLE_WRITE_CHUNK_CHARS) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CONSOLE_WRITE_CHUNK_CHARS, text.length);
    if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    if (end <= start) end = start + 1; // 防御：上限被调成 1 时也不允许空块死循环
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
};

/**
 * 构造控制台写入器：write(text, 回调) 同步完成 WriteConsoleW 后立即回调（null = 全部落定），
 * 与真实流写出时序、flush-after 语义一致；单次写入失败以回调上抛（不改退出码，留痕走钩子）。
 */
export const createConsoleWriter = (
  handle: unknown,
  writeConsoleW: WriteConsoleWCall,
  hooks: ConsoleWriterHooks,
): CliOutputTarget => {
  const fail = (detail: string, callback: (error?: Error | null) => void): void => {
    hooks.writeFailure(detail);
    callback(new Error(`[cli] 控制台写入失败 channel=${hooks.channel}：${detail}`));
  };

  const write = (text: string, callback: (error?: Error | null) => void): boolean => {
    try {
      const normalized = normalizeConsoleNewlines(text);
      for (const chunk of sliceUtf16Chunks(normalized)) {
        const buffer = Buffer.from(chunk, "utf16le");
        const charsToWrite = buffer.length / 2;
        if (charsToWrite === 0) continue;
        const written = Buffer.alloc(4);
        const call = writeConsoleW(handle, buffer, charsToWrite, written);
        const writtenChars = call.ok ? written.readUInt32LE(0) : 0;
        if (!call.ok || writtenChars !== charsToWrite) {
          fail(`ok=${call.ok ? 1 : 0} gle=${call.gle} written=${writtenChars} expect=${charsToWrite}`, callback);
          return false;
        }
      }
      callback(null);
      return true;
    } catch (cause: unknown) {
      fail(cause instanceof Error ? cause.message : String(cause), callback);
      return false;
    }
  };

  return { write };
};
