/**
 * CLI 设置页「命令行工具」子单元的跨进程通道名常量（spec §8）。
 *
 * 通道语义（唯一口径 docs/integrations/CLI与本地Agent集成.md §8）：
 * - `cli:get-status`：只读状态查询（在役状态、发现文件有效性、入口注册状态、最近命令记录），
 *   响应形状由 `./cli-contract` 的 CliStatusDtoSchema 承载，消费端必须经 schema `.parse()` 校验。
 * - `cli:register-entry` / `cli:unregister-entry`：命令入口一键注册/卸除（幂等，CLI-016），
 *   响应形状由 `./cli-contract` 的 CliEntryOperationResultSchema 承载。
 * - 子单元只读展示 + 入口注册，不承载 CLI 行为配置，不提供令牌查看或重置（spec §7/§13）。
 * - 通道登记遵循跨进程通道新增的既有同步纪律（preload 暴露面 + guard:ipc-contract-parse）。
 */

export const CLI_GET_STATUS_CHANNEL = 'cli:get-status';

export const CLI_REGISTER_ENTRY_CHANNEL = 'cli:register-entry';

export const CLI_UNREGISTER_ENTRY_CHANNEL = 'cli:unregister-entry';
