import { app } from "electron";
import { resolveLaunchMode } from "./cli/launch-mode.cjs";

/**
 * 启动分流（spec docs/integrations/CLI与本地Agent集成.md §4.1 / CLI-003）：
 * argv 含 --cli 即 CLI 客户端模式——动态加载 CLI 客户端执行单条命令，以对应退出码
 * app.exit(n) 结束；不加载 bootstrap 编排（不获取单实例锁、不建窗口、不启 backend、
 * 不建 tray、不注册 IPC）。「不获取单实例锁、无窗口、执行完退出」的完整行为留真机验收，
 * 分流判定见 cli/launch-mode 纯函数测试。
 *
 * GUI 模式经条件 require 加载 desktop-shell-bootstrap，保持既有「加载即执行」的
 * 模块加载语义（集成测试依赖 main.cjs → bootstrap.cjs 的同步副作用链）。
 */
if (resolveLaunchMode(process.argv) === "cli") {
  // dev 与打包 argv 形态不同：--cli 之后的参数全归 CLI 客户端
  const cliArgv = process.argv.slice(process.argv.indexOf("--cli") + 1);
  void import("./cli/cli-client-main.cjs")
    .then((cliClientMain) => cliClientMain.runCliClientMain(cliArgv))
    .then((exitCode) => {
      app.exit(exitCode);
    })
    .catch((error: unknown) => {
      console.error("[cli] CLI 客户端执行失败", error instanceof Error ? error.message : error);
      app.exit(2);
    });
} else {
  require("./desktop-shell-bootstrap.cjs");
}
