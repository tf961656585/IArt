import { runCliClient } from "./cli-client.cjs";
import { writeCliOutput } from "./cli-console-attach.cjs";
import type { CliOutputTarget } from "./cli-console-writer.cjs";

/**
 * CLI 客户端 bootstrap 入口（spec docs/integrations/CLI与本地Agent集成.md §4.1 / CLI-025）。
 *
 * 轻量形态（2026-10-14 批次）：由 cli/cli-node-entry.cjs（ELECTRON_RUN_AS_NODE=1 纯 Node
 * 进程）直接调用；main.cts 的 `--cli` 兼容分支（存量旧 shim 自愈窗口）同样调用本模块。
 * 执行一次命令、把结果写入 stdout/stderr、返回退出码；进程退出由调用方负责（纯 Node 入口
 * 在 flush 落定后 process.exit；兼容分支 app.exit(n)）——本模块不 import electron，保持
 * 客户端纯模块可测。
 *
 * 输出目标可注入（兼容分支 Windows 下为标准句柄三元组合格时的控制台写入器，否则 process 流，
 * 见 cli-console-attach / cli-console-writer；轻量形态为 process 流）；人读与 --json 两条
 * 消息组装逻辑保持不变。
 *
 * flush 序列（Windows 中文乱码批次，2026-10-14）：app.exit 不等待 libuv 刷新，退出信号
 * 发出时未落盘的输出会被丢弃——故 stdout 写完成 →（若有）stderr 写完成 → 再返回退出码。
 * 轻量形态的 process.exit 同理只在 flush 落定后调用（入口文件负责）。
 *
 * 输出投递失败契约（静默失败根治，2026-10-14 / CLI-025）：任一最终输出通道写入失败时，
 * 尽力经另一通道（stderr）写一条可见错误，并把退出码置 2（守住 0/1/2 契约）。旧行为只
 * process.emitWarning（GUI 子系统下不可见）且退出码不变，产生「exit 0 + 双零字节」的
 * 假成功——消费方把静默当作空结果。两通道都失败时无处可写，退出码 2 是最后防线。
 * 受理回执（emitWaitProgress，进度信息）写失败不翻转退出码：回执缺席不改变命令结果本身，
 * stdout 数据契约通道仍承载最终结果。
 */
export interface CliClientMainStreams {
  stdout: CliOutputTarget;
  stderr: CliOutputTarget;
}

/** 输出投递失败时的退出码（执行失败档，0/1/2 契约内；CLI-025）。 */
export const CLI_OUTPUT_DELIVERY_FAILURE_EXIT_CODE = 2;

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
  let deliveryFailed = false;
  if (result.stdout.length > 0) {
    const delivered = await writeCliOutputCatching(streams.stdout, `${result.stdout}\n`);
    if (!delivered) deliveryFailed = true;
  }
  if (result.stderr.length > 0) {
    const delivered = await writeCliOutputCatching(streams.stderr, `${result.stderr}\n`);
    if (!delivered) deliveryFailed = true;
  }
  if (deliveryFailed) {
    // 尽力经另一通道（stderr）写一条可见错误：失败细节已由 writeCliOutputCatching 留痕，
    // 本行让消费方知道结果不完整、不得当空结果消费。该写也失败时只剩退出码兜底。
    await writeCliOutputCatching(streams.stderr, "[cli] 输出流写入失败：结果未能完整送达，不得当作空结果消费。\n");
    return CLI_OUTPUT_DELIVERY_FAILURE_EXIT_CODE;
  }
  return result.exitCode;
};

/** 写一条输出并返回是否落定；失败留痕（stderr 可见行 / emitWarning 兜底）后不上抛。 */
const writeCliOutputCatching = async (target: CliOutputTarget, text: string): Promise<boolean> => {
  try {
    await writeCliOutput(target, text);
    return true;
  } catch (cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    process.emitWarning(`[cli] 输出流写入失败：${detail}`);
    return false;
  }
};
