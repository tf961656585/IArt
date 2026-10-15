import * as z from 'zod';
import { TaskSubmitMediaInputSchema } from './task-submit-media-input';
import { MentionMapEntrySchema } from './task-submit-request';
import { BatchIntentSnapshotSchema } from './provider-connection-contract';

/**
 * GenerationBatch 受理契约（contracts 层）—— PromptDock 一次提交的原子受理 DTO。
 *
 * 归属与口径对齐：
 * - spec 主口径：`docs/architecture/PromptDock生成主链.md`（GenerationBatch / BatchIntentSnapshot）
 * - spec 主口径：`docs/runtime/固定任务数批次提交与投影语义.md`（原子受理：一个 Batch + 一个不可变
 *   BatchIntentSnapshot + 恰好 N 个 RuntimeTask 身份，受理失败不得返回部分任务集合）
 * - spec 主口径：`docs/model-assets/45-PromptDock模型能力目录、Deployment与执行快照契约.md` §5.1
 * - 可执行契约 owner：packages/contracts（跨 Electron 进程边界传输的 DTO 必须由 contracts 承载
 *   Zod schema 与 .parse() 边界校验，AGENTS.md「共享契约与事实源」）
 *
 * 本文件只承载提交（HTTP 受理请求/响应）的跨边界 DTO。不可变快照字段事实源
 * （BatchIntentSnapshotSchema / ExecutionSnapshotSchema）位于 provider-connection-contract.ts；
 * 本文件从该处复用，禁止维护并列字段清单。
 *
 * 禁止项（spec 主链与 runtime spec）：
 * - 请求体与快照不得携带 Provider、连接、Base URL、Key、remote_model_id、协议 Override 或 ExecutionSnapshot；
 * - 禁止成功目标、补位/追加请求、批次级协调器取消或自动重试作为活跃语义；
 * - 任务成员一旦受理不可补位、追加或替换。
 */

// ---------------------------------------------------------------------------
// GenerationBatch 提交受理请求（HTTP POST）
// ---------------------------------------------------------------------------

/**
 * GenerationBatch 提交受理请求体。
 *
 * - task_count：用户确认的固定任务数 N（1..10），随 BatchIntentSnapshot 一同定稿。
 * - prompt：PromptDock 草稿的 prompt 文本（独立于模型参数 arguments）。
 * - model_id：PromptDock 只选择 model_id（spec 45 §1/§3）；Provider/连接/Deployment 选择不属于提交面。
 * - arguments：当前有效模型参数（PromptDock 参数表单，spec 45 §4）。
 * - media_inputs / reference_asset_ids：已解析且兼容的媒体引用（spec 45 §5.1）。
 * - mention_map："@锚点 → 素材" 绑定（spec task-submit-request.ts 头注 §5.4/§7）；mention 注入归后端物化层。
 * - project_path：受理所在项目路径。
 * - client_request_id（可选，spec docs/integrations/CLI与本地Agent集成.md §5.4 受理幂等键）：
 *   客户端幂等键（batch 级）。CLI 程序化提交携带（未传时 CLI 自动生成）；界面提交不携带。
 *   同一幂等键重复提交命中既有批次时幂等重放（响应 replayed: true），不重新受理。
 *   存储承载为 batches.clientRequestId（唯一索引）。与 remote_request_id（远端轮询用请求 id）
 *   是两个概念，不得混淆。
 */
export const PromptDockBatchSubmitRequestSchema = z
  .object({
    model_id: z.string().min(1),
    prompt: z.string(),
    arguments: z.record(z.unknown()),
    media_inputs: z.array(TaskSubmitMediaInputSchema).optional(),
    reference_asset_ids: z.array(z.string().min(1)).optional(),
    task_count: z.number().int().min(1).max(10),
    model_version: z.string().min(1),
    project_path: z.string().min(1),
    mention_map: z.record(MentionMapEntrySchema).optional(),
    client_request_id: z.string().min(1).optional(),
  })
  .strict();

export type PromptDockBatchSubmitRequest = z.infer<typeof PromptDockBatchSubmitRequestSchema>;

// ---------------------------------------------------------------------------
// GenerationBatch 提交受理响应（HTTP POST 响应）
// ---------------------------------------------------------------------------

/**
 * 单个任务身份受理条目：task_id + task_index（0-based，随固定任务成员关系排序）。
 */
export const PromptDockBatchTaskAcceptanceSchema = z
  .object({
    task_id: z.string().min(1),
    task_index: z.number().int().nonnegative(),
  })
  .strict();

export type PromptDockBatchTaskAcceptance = z.infer<typeof PromptDockBatchTaskAcceptanceSchema>;

/**
 * GenerationBatch 提交受理响应体。
 *
 * - intent_snapshot：受理后返回的不可变 BatchIntentSnapshot（PromptDock 以此确认草稿定稿）。
 * - tasks：恰好 N 个任务身份；受理失败不得返回部分任务集合（runtime spec「原子受理」）。
 * - replayed（可选）：幂等重放标志（spec §5.4 受理幂等键）。true = 本次请求命中既有批次，
 *   batch_id/tasks 为既有受理结果，未重新受理；false = 全新受理。旧版后端不输出该字段。
 */
export const PromptDockBatchSubmitResponseSchema = z
  .object({
    batch_id: z.string().min(1),
    intent_snapshot: BatchIntentSnapshotSchema,
    tasks: z.array(PromptDockBatchTaskAcceptanceSchema).min(1).max(10),
    replayed: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => value.tasks.length === value.intent_snapshot.task_count,
    { message: 'accepted tasks length must equal intent snapshot task_count (atomic acceptance)' },
  )
  .refine(
    (value) => value.batch_id === value.intent_snapshot.batch_id,
    { message: 'response batch_id must match intent snapshot batch_id' },
  );

export type PromptDockBatchSubmitResponse = z.infer<typeof PromptDockBatchSubmitResponseSchema>;
