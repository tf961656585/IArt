import { runCliClient } from "./cli-client.cjs";
import { writeCliOutput } from "./cli-console-attach.cjs";
import type { CliOutputTarget } from "./cli-console-writer.cjs";

/**
 * CLI 客户端 bootstrap 入口（由 main.cts 在 --cli 分流后动态加载）。
 *
 * 执行一次命令、把结果写入 stdout/stderr、返回退出码；进程退出（app.exit(n)）由
 * main.cts 负责——本模块不 import electron，保持客户端纯模块可测。
 *
 * 输出目标可注入（Windows 下为标准句柄三元组合格时的控制台写入器，否则 process 流，
 * 见 cli-console-attach / cli-console-writer）；人读与 --json 两条消息组装逻辑保持不变。
 *
 * flush 序列（Windows 中文乱码批次，2026-10-14）：app.exit 不等待 libuv 刷新，退出信号
 * 发出时未落盘的输出会被丢弃——故 stdout 写完成 →（若有）stderr 写完成 → 再返回退出码。
 */
export interface CliClientMainStreams {
  stdout: CliOutputTarget;
  stderr: CliOutputTarget;
}

export const runCliClientMain = async (
  argv: readonly string[],
  streams: CliClientMainStreams = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> => {
  // 受理回执即时写出接线（spec §5.4 / CLI-026）：runGenerateWait 在受理响应返回后、轮询
  // 开始前调用 emitWaitProgress 并 await——经 writeCliOutputCatching 落到 stderr（回执属
  // 进度信息，stdout 是 --json 数据契约通道只承载最终结果），flush 完成才继续轮询。
  const result = await runCliClient(argv, {
    emitWaitProgress: async (text: string) => {
      await writeCliOutputCatching(streams.stderr, text);
    },
  });
  // 输出投递失败不改变退出码（命令已执行；管道关闭等传输层失败留痕后降级继续）。
  if (result.stdout.length > 0) {
    await writeCliOutputCatching(streams.stdout, `${result.stdout}\n`);
  }
  if (result.stderr.length > 0) {
    await writeCliOutputCatching(streams.stderr, `${result.stderr}\n`);
  }
  return result.exitCode;
};

const writeCliOutputCatching = async (target: CliOutputTarget, text: string): Promise<void> => {
  try {
    await writeCliOutput(target, text);
  } catch (cause: unknown) {
    process.emitWarning(`[cli] 输出流写入失败：${cause instanceof Error ? cause.message : String(cause)}`);
  }
};
