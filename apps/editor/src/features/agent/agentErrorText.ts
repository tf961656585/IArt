/**
 * Agent 失败的用户可见文案（错误码 → 一句话）。
 *
 * 边界（`docs/ui-copy-standard.md`「落地口径」第 4 条）：出口文案只写「现在发生了什么 + 你能做什么」，
 * 后端 `message` 原文（`A request is already in flight for this agent session` 一类）只进日志、不上面。
 *
 * 错误码 owner 在这一层：会话核与提交路径按码收口，界面（PromptDock 的出口提示、右侧会话视图的
 * 错误条、终态失败提示）只消费本文件的映射结果，不各自维护并列文案。
 * 用户概念统一为「这一轮回复」「这条消息」，不出现 session / deployment 类实现术语。
 */

import type { AgentError } from '@iart/contracts';

/** 界面要区分的失败码：契约的执行失败码 + 本端受理前失败（项目不可用 / 重复提交 / 连接不可用）。 */
export type AgentFailureCode =
  | AgentError['code']
  | 'project_unavailable'
  | 'duplicate_submit'
  | 'connection_unavailable';

/** 无码可依（未收口的异常）与后端未细分的请求失败共用这一条出口文案。 */
const FALLBACK_AGENT_FAILURE_TEXT = '这条消息没能发出，请重试。';

const AGENT_FAILURE_TEXT: Record<AgentFailureCode, string> = {
  // 模型在服务商侧不可用：给出可行动的出口（去主窗口检查配置）
  model_unavailable: '这个模型现在用不了，请到主窗口检查它的配置。',
  // 后端未细分的请求失败（校验 / 作用域 / 该会话已有一轮在途）：不把原文拼给用户
  invalid_request: FALLBACK_AGENT_FAILURE_TEXT,
  // 项目没打开：重试无用，出口是重新打开项目（本端可判定，见 submitAgentPrompt）
  project_unavailable: '项目还没打开，重新打开项目后再发送。',
  // 已受理的一轮中断（流式断开、无内容可落）
  execution_failed: '这一轮回复中断了，可以再发一次。',
  cancelled: '已停止这一轮回复。',
  // 上一条还在回复时再次发送（本端在途守卫，见 submitAgentPrompt）
  duplicate_submit: '上一条还在回复，等它结束再发送。',
  // 连不上 / 断线 / 发不出去：本端合成的失败（无会话归属，见 agentSocket）
  connection_unavailable: '连不上，这一次回复没有完成，请重试。',
};

/** 错误码 → 用户文案；无码（未收口的异常）回落通用出口文案。 */
export const resolveAgentFailureText = (code: AgentFailureCode | null | undefined): string =>
  code === null || code === undefined ? FALLBACK_AGENT_FAILURE_TEXT : AGENT_FAILURE_TEXT[code];

/**
 * 受理前失败的提交错误：携带错误码，提交调用方据此给出口文案。
 *
 * `message` 只作日志与技术排查材料（保留后端原文 / 本端细节），界面不读它——
 * 这条约束是「不再泄漏后端英文串」的落点，改动前请先读 `docs/ui-copy-standard.md`。
 */
export class AgentSubmitFailure extends Error {
  readonly code: AgentFailureCode;
  readonly requestId: string;

  constructor(code: AgentFailureCode, requestId: string, detail: string) {
    super(detail);
    this.name = 'AgentSubmitFailure';
    this.code = code;
    this.requestId = requestId;
  }
}

/** reject 值 → 用户文案（只按错误码取，不读 `message`）。 */
export const resolveAgentSubmitFailureText = (failure: unknown): string =>
  failure instanceof AgentSubmitFailure
    ? resolveAgentFailureText(failure.code)
    : FALLBACK_AGENT_FAILURE_TEXT;
