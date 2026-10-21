import * as z from 'zod';

/**
 * CLI 生成域参数 DTO（spec docs/integrations/CLI与本地Agent集成.md §5.4）。
 *
 * 从 cli-contract.ts 拆出的职责边界：`generate` 命令的参数形状（prompt/model/count/ref/arg/
 * wait/client_request_id/group）。命令面请求-响应判别联合与代理执行通道仍归 cli-contract.ts；
 * 本文件只承载 B 命令面与 C 代理通道共享的同一份 generate 参数 schema（不复制字段）。
 *
 * 新建判定：「参考用途」把单条引用从字符串升级为结构化条目，参数区已到行数预算边界；
 * 拆分方式沿用 cli-canvas-contract.ts / cli-generation-archive-contract.ts 的先例。
 */

/** `generate --arg k=v` 的键值对条目：参数名与取值受该模型参数 schema 约束（执行侧前置校验）。 */
export const CliGenerateArgEntrySchema = z
  .object({
    key: z.string().min(1),
    value: z.string(),
  })
  .strict();
export type CliGenerateArgEntry = z.infer<typeof CliGenerateArgEntrySchema>;

/**
 * `generate --ref <素材标识>[:<用途>]` 的单条引用（spec §5.4 引用用途）。
 *
 * 用途（`slot_id`）是该素材位标识，取值来自模型目录下发的 `media_slots[].slotId`，CLI 侧
 * 只做形状校验、不判断合法性（合法性依赖模型目录，在画布侧前置校验判定）。
 *
 * `slot_id` 缺省（`null`）表示调用方没表达用途：提交侧按设计文档 §8 存量兼容兜底——
 * 模型声明了多张位则视为「普通参考」，全单张位则进入阻断。
 */
export const CliGenerateRefSchema = z
  .object({
    asset_id: z.string().min(1),
    slot_id: z.string().min(1).nullable().default(null),
  })
  .strict();
export type CliGenerateRef = z.infer<typeof CliGenerateRefSchema>;

/**
 * generate 参数（spec §5.4）：B 命令面请求与 C 代理执行通道命令共享同一参数 schema（不复制）。
 * `wait`（受理后轮询至终态）的轮询执行归 CLI 客户端侧（受理后逐任务轮询至终态）；代理执行通道只承载程序化提交，
 * 画布窗口执行侧对 `wait` 不消费（契约允许携带、执行侧忽略，同 canvas.layout 的 columns 先例）。
 *
 * `client_request_id`（CLI flag `--request-id`，spec §5.4 受理幂等键）：客户端幂等键，batch 级。
 * 未传时 CLI 客户端自动生成 uuid 并随请求携带；同一 request_id 重复提交命中已受理批次时
 * 幂等重放（返回既有批次与任务身份、`replayed: true`），不重新受理。
 * 命名口径：不得叫 `request_id`——该名已被代理执行通道的请求关联标识占用
 * （`CliProxyCommandSchema` generate 变体的 `request_id` 与本参数形状经 `.shape` 组合到同一
 * strict 对象，同名字段会互相覆盖），幂等键统一用 `client_request_id`。
 */
export const CliGenerateParamsSchema = z
  .object({
    /** `--prompt` / `--model` 必填（spec §5.4）。 */
    prompt: z.string(),
    model: z.string().min(1),
    /** `--count` 正整数可选：固定任务数。 */
    count: z.number().int().min(1).optional(),
    /**
     * `--ref <素材标识>[:<用途>]` 引用列表可选（spec §5.4 引用用途）：素材必须是已存在的资产。
     * 条目形状见 `CliGenerateRefSchema`；`slot_id` 缺省时按设计文档 §8 存量兼容兜底。
     */
    ref: z.array(CliGenerateRefSchema).optional(),
    /** `--arg k=v` 键值对列表可选。 */
    arg: z.array(CliGenerateArgEntrySchema).optional(),
    /** `--wait` 可选：受理后继续轮询至全部任务终态。 */
    wait: z.boolean().optional(),
    /** `--request-id` 可选：客户端幂等键（未传时 CLI 自动生成 uuid 并在受理回执回显）。 */
    client_request_id: z.string().min(1).optional(),
    /**
     * `--group` 可选（spec §5.4 / CLI-043）：出生组组名。提交前置校验阶段按名称解析目标组——
     * 唯一同名节点组入它、零个自动建组、≥2 个同名以 group_name_ambiguous 拒绝（不发起提交）。
     * 组名匹配只作用于节点组（type=group），不含 Agent 容器。
     */
    group: z.string().min(1).optional(),
  })
  .strict();
export type CliGenerateParams = z.infer<typeof CliGenerateParamsSchema>;
