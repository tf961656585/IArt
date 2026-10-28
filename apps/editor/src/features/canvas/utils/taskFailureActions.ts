import type { RuntimeTaskFailure } from '@iart/contracts';
import { isRequeryEligibleFailure } from '@iart/contracts';

import { isApiError } from '@/client/api/clientTypes';

import type { TaskNodeStatus } from '../types/taskNode';

/**
 * 失败任务卡片动作组（spec：docs/editor/失败任务重新查询-design.md §3.2）。
 *
 * 判定只消费共享契约谓词 `isRequeryEligibleFailure`（`packages/contracts`
 * task-requery-contract.ts）——阶段集合、可重查集合与「远端任务号必须存在」的唯一实现都在
 * contracts，Editor 不复制 stage 枚举判定（AGENTS.md 单一事实源）。
 *
 * 动作语义：
 * - `requery`：同一任务 failed → polling，不新建批次/任务；成功后原任务节点原位 morph 成资产。
 * - `retry` / `regenerate`：同一底层动作（回填 PromptDock 草稿，用户提交后新建 1 任务批次）；
 *   查询类失败用 `regenerate` 明确「会再生成一次」，其余失败用最短动作词 `retry`。
 * - `delete`：只移除画布任务投影，属失败终态的固定危险动作。
 *
 * 非 `failed` 状态不提供失败动作（`primary`/`secondary` 为 null），调用方只应在失败 overlay
 * 内取值。
 */

export type TaskFailurePrimaryAction = 'requery' | 'retry';

export type TaskFailureSecondaryAction = 'regenerate';

export type TaskFailureActionSet = {
  primary: TaskFailurePrimaryAction | null;
  secondary: TaskFailureSecondaryAction | null;
  delete: true;
};

type ResolveTaskFailureActionsInput = {
  status: TaskNodeStatus | null | undefined;
  failure: RuntimeTaskFailure | null | undefined;
  /** 运行域远端任务号；缺失时不可重查（委托共享谓词判定）。 */
  remoteRequestId: string | null | undefined;
};

const NO_FAILURE_ACTIONS: TaskFailureActionSet = {
  primary: null,
  secondary: null,
  delete: true,
};

export const resolveTaskFailureActions = (
  params: ResolveTaskFailureActionsInput,
): TaskFailureActionSet => {
  if (params.status !== 'failed') return NO_FAILURE_ACTIONS;
  if (isRequeryEligibleFailure(params.failure, params.remoteRequestId)) {
    return { primary: 'requery', secondary: 'regenerate', delete: true };
  }
  return { primary: 'retry', secondary: null, delete: true };
};

/**
 * 重新查询被拒时的用户文案（设计文档 §7.3）。
 *
 * 后端 409 的 `body.code` 是具体拒绝原因；`body.message` 是内部可读措辞（可能带模型/连接
 * 细节），不能直接上屏。这里按 code 映射到用户可理解的「发生了什么 + 下一步」文案，
 * 未知 code 回落最短的通用句，避免把内部错误原文暴露给用户。
 */
const DEFAULT_REQUERY_REJECTION_MESSAGE = '没能重新查询。';

const REQUERY_REJECTION_MESSAGES: Record<string, string> = {
  connection_unavailable:
    '没能重新查询：这个任务原来的服务商连接已经不可用。检查服务商设置，或用「重新生成」新建一次任务。',
  credential_unavailable:
    '没能重新查询：这个任务原来的密钥已经不可用。检查服务商与密钥，或用「重新生成」新建一次任务。',
  snapshot_unavailable:
    '没能重新查询：这个任务的执行配置不完整。用「重新生成」新建一次任务。',
  model_unavailable:
    '没能重新查询：这个任务的执行配置不完整。用「重新生成」新建一次任务。',
  interface_format_unavailable:
    '没能重新查询：这个任务的接口配置不可用。用「重新生成」新建一次任务。',
  task_not_failed: '这个任务不能重新查询。',
  stage_not_requeryable: '这个任务不能重新查询。',
  missing_remote_request_id: '这个任务不能重新查询。',
  cancel_pending: '这个任务不能重新查询。',
  agent_derived: '这个任务不能重新查询。',
  invalid_task: '这个任务不能重新查询。',
  in_flight: '正在重新查询，请稍候。',
};

const readRejectionCode = (body: unknown): string | null => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (!('code' in body)) return null;
  const code: unknown = (body as { code?: unknown }).code;
  return typeof code === 'string' && code.trim() ? code.trim() : null;
};

export const resolveRequeryRejectionMessage = (error: unknown): string => {
  if (!isApiError(error)) return DEFAULT_REQUERY_REJECTION_MESSAGE;
  const code = readRejectionCode(error.body);
  if (!code) return DEFAULT_REQUERY_REJECTION_MESSAGE;
  return REQUERY_REJECTION_MESSAGES[code] ?? DEFAULT_REQUERY_REJECTION_MESSAGE;
};
