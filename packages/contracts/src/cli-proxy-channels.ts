/**
 * CLI 代理执行通道的跨进程通道名常量。
 *
 * 通道语义（唯一口径 docs/integrations/CLI与本地Agent集成.md §6.3）：
 * - 主进程把一条画布命令发给目标项目的画布窗口（请求），画布窗口执行完毕原路返回结果或错误（响应）。
 * - 请求/响应载荷形状由 `./cli-contract` 的 CliProxyCommandSchema / CliProxyCommandResponseSchema 承载，
 *   两端消费前必须经 schema `.parse()` 校验。
 * - 通道登记遵循跨进程通道新增的既有同步纪律（preload 暴露面 + guard:ipc-contract-parse）。
 */

export const CLI_PROXY_REQUEST_CHANNEL = 'cli-proxy-request';

export const CLI_PROXY_RESPONSE_CHANNEL = 'cli-proxy-response';
