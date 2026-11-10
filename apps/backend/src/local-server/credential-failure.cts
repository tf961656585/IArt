import type { TaskFailureStage } from '@iart/contracts';

/**
 * 凭证类任务失败的统一构造入口（2026-10-29 凭证不可读事故修复）。
 *
 * 口径：
 * - 错误码沿用 `credential_missing`（不新增错误码），`details.reason` 区分三种成因：
 *   `absent`（从未设置）/ `unreadable`（有条目但按 scheme 解不出来）/ `version_mismatch`
 *   （快照冻结的凭证版本与存储中的不一致，即密钥已被更换或删除）。
 * - `userMessage` 是用户可见的人话指引；`message` 是技术字段，只写短英文。
 * - **禁止**把底层异常原文（ByteString / safeStorage 报错 / IPC 错误）放进 `message`：
 *   这类原文对用户无用，且会把密钥材料形态带到任务记录与界面。
 *
 * 失败对象形状与 `RuntimeTaskFailureSchema` 对齐（code/message/userMessage/details/stage）。
 */

type CredentialFailureReason = 'absent' | 'unreadable' | 'version_mismatch';

type CredentialTaskFailure = {
  code: 'credential_missing';
  message: string;
  userMessage: string;
  details: { reason: CredentialFailureReason };
};

const CREDENTIAL_FAILURE_USER_MESSAGES: Record<CredentialFailureReason, string> = {
  absent: '这个服务商还没设置密钥，请到「设置 → 服务商与模型」填写。',
  unreadable: '没能读取这个服务商的密钥，请到「设置 → 服务商与模型」重新填写。',
  version_mismatch: '这个任务用过的密钥已被更换或删除，请到「设置 → 服务商与模型」重新填写后再试。',
};

const buildCredentialFailure = (reason: CredentialFailureReason): CredentialTaskFailure => ({
  code: 'credential_missing',
  message: `credential unavailable: ${reason}`,
  userMessage: CREDENTIAL_FAILURE_USER_MESSAGES[reason],
  details: { reason },
});

/** 带失败阶段的任务失败对象（阶段随任务记录进入 failure，供重新查询资格判定）。 */
const buildCredentialTaskFailure = (
  reason: CredentialFailureReason,
  stage: TaskFailureStage,
): CredentialTaskFailure & { stage: TaskFailureStage } => ({
  ...buildCredentialFailure(reason),
  stage,
});

export {
  buildCredentialFailure,
  buildCredentialTaskFailure,
  CREDENTIAL_FAILURE_USER_MESSAGES,
  type CredentialFailureReason,
  type CredentialTaskFailure,
};
