import { app } from "electron";
import { resolveLaunchMode } from "./cli/launch-mode.cjs";
import { prepareCliStdio, writeCliOutput } from "./cli/cli-console-attach.cjs";

/**
 * 启动分流（spec docs/integrations/CLI与本地Agent集成.md §4.1 / CLI-003）：
 * argv 含 --cli 即 CLI 客户端模式——动态加载 CLI 客户端执行单条命令，以对应退出码
 * app.exit(n) 结束；不加载 bootstrap 编排（不获取单实例锁、不建窗口、不启 backend、
 * 不建 tray、不注册 IPC）。「不获取单实例锁、无窗口、执行完退出」的完整行为留真机验收，
 * 分流判定见 cli/launch-mode 纯函数测试。
 *
 * Windows 中文乱码根治（2026-10-14 批次）：CLI 分支在动态 import 之前先完成标准流通道
 * 判定与接管（prepareCliStdio，见 cli-console-attach）——stdout/stderr 各自按句柄三元组
 * 独立判定，控制台通道换 WriteConsoleW 写入器、其余回退 process 流；非 win32 不调用。
 * app.exit 不等待 libuv 刷新——正常路径的输出由 runCliClientMain 在返回前按回调序列化
 * 落定；catch 路径的错误文本也必须经同一 flush 序列写完成后再退出。
 *
 * GUI 模式经条件 require 加载 desktop-shell-bootstrap，保持既有「加载即执行」的
 * 模块加载语义（集成测试依赖 main.cjs → bootstrap.cjs 的同步副作用链）。
 *
 * GPU 防御（spec §4.1 / CLI-025）：CLI 分支不渲染任何界面，三层禁用 GPU（disable-gpu +
 * disable-software-rasterizer + disableHardwareAcceleration），防止无 GPU 环境下 Chromium
 * GPU 进程初始化失败的 FATAL 杀死等待类命令；开关只在本分支注入，GUI 主链不沾染。
 */
if (resolveLaunchMode(process.argv) === "cli") {
  // CLI 模式禁用 GPU 与软件光栅化（spec §4.1 / CLI-025）：CLI 不渲染任何界面，但 Chromium
  // browser 进程照常初始化并拉起 GPU 进程；无 GPU/容器/远程会话环境下 GPU 进程初始化失败
  // 触发 Chromium LOG(FATAL)「GPU process isn't usable. Goodbye.」杀死整个进程——短命令
  // 幸免，等待类轮询（task wait、generate --wait）全灭。三层防御（外部用户实测前两个
  // switch 注入后一切正常，第三层兜底防回归）。开关必须在 app ready 前生效——本分支在模块
  // 顶层执行，早于 ready。严禁把这些开关加到 GUI 主链（GUI 需要渲染）。
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-software-rasterizer");
  app.disableHardwareAcceleration();
  // dev 与打包 argv 形态不同：--cli 之后的参数全归 CLI 客户端
  const cliArgv = process.argv.slice(process.argv.indexOf("--cli") + 1);
  const cliStdio =
    process.platform === "win32"
      ? prepareCliStdio()
      : { stdout: process.stdout, stderr: process.stderr };
  void (async (): Promise<void> => {
    try {
      const cliClientMain = await import("./cli/cli-client-main.cjs");
      const exitCode = await cliClientMain.runCliClientMain(cliArgv, cliStdio);
      app.exit(exitCode);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      try {
        await writeCliOutput(cliStdio.stderr, `[cli] CLI 客户端执行失败 ${detail}\n`);
      } catch {
        // stderr 也不可用：留痕后按执行失败退出
        process.emitWarning(`[cli] CLI 客户端执行失败且 stderr 不可用：${detail}`);
      }
      app.exit(2);
    }
  })();
} else {
  require("./desktop-shell-bootstrap.cjs");
}
