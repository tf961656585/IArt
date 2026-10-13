/**
 * CLI 与 GUI 启动分流判定（spec docs/integrations/CLI与本地Agent集成.md §4.1 / CLI-003）。
 *
 * 纯函数、不 import electron。dev 与打包的 argv 形态不同，判「存在 --cli」即可，
 * 其后参数全归 CLI 客户端。分流调用点在 main.cts（早于任何 GUI 编排——单实例锁、
 * 窗口、backend、tray、IPC 注册均不得在 CLI 模式执行）。
 */
export type LaunchMode = "gui" | "cli";

export const CLI_LAUNCH_FLAG = "--cli";

export const resolveLaunchMode = (argv: readonly string[]): LaunchMode =>
  argv.includes(CLI_LAUNCH_FLAG) ? "cli" : "gui";
