import * as z from 'zod';

import { CliErrorCodeSchema } from './cli-error-code';

/**
 * 设置页「命令行工具」子单元 DTO（spec docs/integrations/CLI与本地Agent集成.md §6.2 命令日志 /
 * §8 状态展示）的可执行事实源。
 *
 * 独立成文件判定：设置页 DTO 由 Hub 消费、字段用 camelCase（与命令面 snake_case 边界分明），
 * 且 cli-contract 行数预算拆分（与 cli-canvas-contract / cli-generation-archive-contract 同
 * 先例）；由 cli-contract re-export，保持 '@iart/contracts' 单一取用面。
 * 归属与口径对齐：spec 主口径 §8；只读展示，不承载 CLI 行为配置，不提供令牌查看或重置（§7/§13）。
 */

/**
 * 命令日志条目（spec §6.2：每条命令记录一条——时间、命令、参数摘要、结果状态、耗时）。
 * timestamp 为 UTC ISO 8601（内部存储口径，AGENTS.md 时间戳规范）；展示层由消费端转北京时间。
 * paramsSummary 语义是摘要：仅供诊断与设置页展示，禁止包含提示词全文与凭证/密钥（spec §6.1/§11）。
 */
export const CliCommandLogEntrySchema = z
  .object({
    timestamp: z.string().datetime(),
    command: z.string().min(1),
    paramsSummary: z.string(),
    status: z.enum(['success', 'error']),
    durationMs: z.number().nonnegative(),
    errorCode: CliErrorCodeSchema.optional(),
  })
  .strict();
export type CliCommandLogEntry = z.infer<typeof CliCommandLogEntrySchema>;

/**
 * 命令入口注册状态详情（spec §8 五态 + 落点/旧入口/PATH 提示，2026-10-16 由布尔态扩展）。
 * - state（spec §8 五态）：registered=已注册且内容与当前模板一致；missing=未注册；stale=入口
 *   已失效（内容具本应用模板特征但与当前模板不一致——指向已失效位置或过期形态；形态缺件与
 *   读取异常也归此态）；foreign=同名他物（注册动作会替换它）；unsupported=平台不支持一键注册。
 * - entryPath：落点入口路径（平台不支持为 null）。
 * - legacyEntryPath：落点之外候选目录中的同名旧入口（终端可能优先命中，需提示遮蔽风险与
 *   手动清理指引；无则 null）。
 * - pathSetupRequired：落点不在终端默认命令搜索路径（界面提示加入 PATH）。
 */
export const CliEntryStatusDetailSchema = z
  .object({
    state: z.enum(['unsupported', 'missing', 'registered', 'stale', 'foreign']),
    entryPath: z.string().min(1).nullable(),
    legacyEntryPath: z.string().min(1).nullable(),
    pathSetupRequired: z.boolean(),
  })
  .strict();
export type CliEntryStatusDetail = z.infer<typeof CliEntryStatusDetailSchema>;

/**
 * CLI 状态 DTO（spec §8：只读状态展示——在役状态、发现文件有效性、命令入口注册状态、最近命令记录）。
 * 只读展示，不承载 CLI 行为配置，不提供令牌查看或重置（spec §7/§13）。
 */
export const CliStatusDtoSchema = z
  .object({
    serviceRunning: z.boolean(),
    port: z.number().int().min(1).nullable(),
    discoveryFileValid: z.boolean(),
    /** 命令入口注册状态详情（spec §3 命令入口注册 / §8 注册状态展示，五态判别）。 */
    entry: CliEntryStatusDetailSchema,
    /** 最近命令记录，最多 20 条（spec §8）。 */
    recentCommands: z.array(CliCommandLogEntrySchema).max(20),
  })
  .strict();
export type CliStatusDto = z.infer<typeof CliStatusDtoSchema>;

/**
 * 命令入口注册/卸除操作结果（spec §8 一键注册与卸除注册动作的 IPC 响应形状）。
 * ok:false 时 message 引导手动注册（spec §3：手动注册指引是另一途径）；
 * message 面向用户，使用用户视角业务语言（docs/ui-copy-standard.md 的 CLI 终端外延口径）。
 */
export const CliEntryOperationResultSchema = z
  .object({
    ok: z.boolean(),
    message: z.string().min(1).optional(),
  })
  .strict();
export type CliEntryOperationResult = z.infer<typeof CliEntryOperationResultSchema>;
