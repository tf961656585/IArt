import * as fs from "node:fs";
import * as path from "node:path";

/**
 * CLI 轻量纯 Node 入口（spec docs/integrations/CLI与本地Agent集成.md §4.1 / CLI-025，
 * 2026-10-14 批次拍板：CLI 进程形态从「每命令启动完整 Electron」翻转为「轻量纯 Node 入口」）。
 *
 * 进程形态：命令入口 shim 以 `ELECTRON_RUN_AS_NODE=1` 把应用可执行文件作为纯 Node 运行时
 * 启动本文件（Electron 文档化行为：run-as-node 下 node_main.cc 直接加载首个非选项参数脚本，
 * Chromium browser 进程整个不存在）。v0.6.5 Windows 真机实测的三类问题随之结构性消失：
 * - 无 GPU 环境 GPU 进程初始化失败的 Chromium FATAL（`GPU process isn't usable. Goodbye.`，
 *   rc=0x80000003）杀死等待类命令——GPU 进程不再存在；
 * - 退出码/输出被 browser 进程崩溃双向污染（回执完整但 rc 脏 / rc=0 但 stdout 空）；
 * - GUI 子系统控制台中文乱码——纯 Node 下 libuv 的 Windows tty 写路径本就经 WriteConsoleW
 *   直写 UTF-16（管道写 UTF-8 字节），koffi/WriteConsoleW 接管链（cli-console-attach）在
 *   轻量形态不需要。
 *
 * 硬性边界：本文件不 import electron、不接管标准流通道（stdio 接管链 cli-console-attach
 * 仅服务 main.cts 的 `--cli` 兼容分支）；客户端依赖闭包零 electron（cli-client-main →
 * cli-client / cli-console-attach（koffi 惰性、main-log 惰性降级）→ contracts/utils）。
 * main.cts 的 `--cli` 分支保留为存量旧 shim 的兼容窗口（0.6.5/0.6.6
 * shim 仍以 exe --cli 启动，自愈重写后自然走本入口）。
 *
 * 定位：打包态本文件经 electron-builder extraResources 落在 app.asar 外
 *（`<resources>/cli/cli-node-entry.cjs`，纯 Node 直接启动 asar 内文件未经实测、asar 外保真），
 * 客户端模块在 app.asar 内按绝对路径 require；dev 态本文件与 cli-client-main.cjs 同级
 * （dist/cli/），按同级路径 require。
 *
 * 退出：runCliClientMain 返回前已完成 stdout → stderr 的 write 回调序列（flush 已落定，
 * 见其模块注释）；此后显式 process.exit 收口——客户端经 undici 全局 dispatcher 复用
 * keep-alive 连接，可能滞留事件循环使自然退出挂住数秒（旧形态 app.exit 即时退出，不得回退）。
 * 落定后再退出，缓冲输出不会丢失。
 */

interface CliClientMainModule {
  runCliClientMain: (argv: readonly string[]) => Promise<number>;
}

/** 入口定位：dev 同级优先（dist/cli/ 相邻），打包态回落 app.asar 内编译产物（两者互斥存在）。 */
const resolveCliClientMainPath = (): string => {
  const devSibling = path.join(__dirname, "cli-client-main.cjs");
  if (fs.existsSync(devSibling)) return devSibling;
  const packagedAsar = path.join(
    __dirname,
    "..",
    "app.asar",
    "apps",
    "desktop-shell",
    "dist",
    "cli",
    "cli-client-main.cjs",
  );
  if (fs.existsSync(packagedAsar)) return packagedAsar;
  throw new Error(`[cli] 未找到 CLI 客户端模块（dev 同级与 app.asar 内均不存在）：${devSibling}`);
};

const main = async (): Promise<void> => {
  // shim argv 形态：[exe, 本入口, ...用户参数]；用户参数自 index 2 起（Node argv 语义）
  const cliArgv = process.argv.slice(2);
  // .cts 编译为 CJS：运行态 require 可用；变量路径 require 经单次断言收窄（同 cli-console-attach 范式）
  const clientMain = require(resolveCliClientMainPath()) as CliClientMainModule;
  const exitCode = await clientMain.runCliClientMain(cliArgv);
  process.exit(exitCode);
};

void main().catch((error: unknown) => {
  // 入口自身失败（客户端模块缺失等）不属于命令级失败：stderr 尽力留痕后按执行失败退出
  const detail = error instanceof Error ? error.message : String(error);
  try {
    process.stderr.write(`[cli] CLI 入口启动失败：${detail}\n`, () => process.exit(2));
  } catch {
    process.exit(2);
  }
});
