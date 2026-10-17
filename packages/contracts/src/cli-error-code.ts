import * as z from 'zod';

/**
 * CLI 错误码（spec docs/integrations/CLI与本地Agent集成.md §9，跨 spec 与测试的稳定枚举）。
 *
 * 独立成文件判定：错误码被命令面（cli-contract）、代理执行通道与设置页命令日志
 * （cli-settings-contract）共同消费，居于下游契约之下、无向上依赖（cli-contract 行数预算
 * 拆分，与 cli-canvas-contract / cli-generation-archive-contract 同先例）；由 cli-contract
 * re-export，保持 '@iart/contracts' 单一取用面。
 *
 * 错误响应统一为 `{ code, message }`；message 面向使用 CLI 的开发者，使用用户视角业务语言，
 * 不暴露内部实现术语。
 */

export const CLI_ERROR_CODES = [
  'not_running',
  'auth_failed',
  'project_not_found',
  'project_name_ambiguous',
  'project_name_conflict',
  'project_not_open',
  'asset_not_found',
  'batch_not_found',
  'node_not_found',
  'group_not_found',
  'group_name_ambiguous',
  'invalid_reference',
  'model_not_available',
  'task_not_found',
  'wait_timeout',
  'command_rejected',
  'internal_error',
] as const;

export const CliErrorCodeSchema = z.enum(CLI_ERROR_CODES);
export type CliErrorCode = z.infer<typeof CliErrorCodeSchema>;

export const CliErrorSchema = z
  .object({
    code: CliErrorCodeSchema,
    message: z.string().min(1),
  })
  .strict();
export type CliError = z.infer<typeof CliErrorSchema>;
