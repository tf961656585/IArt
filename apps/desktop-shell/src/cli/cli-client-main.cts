import { runCliClient } from "./cli-client.cjs";

/**
 * CLI 客户端 bootstrap 入口（由 main.cts 在 --cli 分流后动态加载）。
 *
 * 执行一次命令、把结果写入 stdout/stderr、返回退出码；进程退出（app.exit(n)）由
 * main.cts 负责——本模块不 import electron，保持客户端纯模块可测。
 */
export const runCliClientMain = async (argv: readonly string[]): Promise<number> => {
  const result = await runCliClient(argv);
  if (result.stdout.length > 0) {
    process.stdout.write(`${result.stdout}\n`);
  }
  if (result.stderr.length > 0) {
    process.stderr.write(`${result.stderr}\n`);
  }
  return result.exitCode;
};
