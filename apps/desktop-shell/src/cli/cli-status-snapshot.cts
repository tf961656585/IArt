import { CliStatusDtoSchema, type CliCommandLogEntry, type CliStatusDto } from "@iart/contracts";
import { readDiscoveryFile } from "./cli-discovery.cjs";

/**
 * 设置页「命令行工具」状态快照构建（spec docs/integrations/CLI与本地Agent集成.md §8 / CLI-013
 * 的 Main 侧基础）。
 *
 * 职责：把主进程侧的 CLI 通道事实（控制服务句柄、发现文件、入口注册状态、命令日志）投影为
 * CliStatusDto，出站前经契约 schema 校验（IPC 边界 Zod parse 纪律）。纯投影，不承载行为配置，
 * 不暴露令牌（spec §7/§13）。
 */

/** 最近命令记录上限（spec §8：最近 20 条）。 */
export const CLI_RECENT_COMMANDS_MAX = 20;

/** 发现文件有效性：存在且可解析（内容仅是在役线索，此处只做展示侧有效性判定）。 */
export const isDiscoveryFileValid = (discoveryFilePath: string): boolean =>
  readDiscoveryFile(discoveryFilePath) !== null;

export interface CliStatusSnapshotInput {
  /** 本地控制服务句柄是否存活（应用运行期为 true，will-quit 停止后为 false）。 */
  serviceRunning: boolean;
  /** 控制服务监听端口；服务未运行为 null。 */
  port: number | null;
  /** 发现文件路径（服务存活取句柄携带路径，未运行取默认定位）。 */
  discoveryFilePath: string;
  /** 命令入口注册状态；平台不支持一键注册为 null（语义见契约注释）。 */
  entryRegistered: boolean | null;
  /** 命令日志全量（内存环形）；此处截取最近 20 条。 */
  commandLog: readonly CliCommandLogEntry[];
}

/**
 * 构建状态 DTO：recentCommands 截最近 20 条（按命令日志时序保序），整体经
 * CliStatusDtoSchema.parse 出站校验（形状缺陷在边界即失败）。
 */
export const buildCliStatusDto = (input: CliStatusSnapshotInput): CliStatusDto =>
  CliStatusDtoSchema.parse({
    serviceRunning: input.serviceRunning,
    port: input.port,
    discoveryFileValid: isDiscoveryFileValid(input.discoveryFilePath),
    entryRegistered: input.entryRegistered,
    recentCommands: input.commandLog.slice(-CLI_RECENT_COMMANDS_MAX),
  });
