import { useState, type KeyboardEvent } from 'react';
import { Input } from '@iart/ui';
import {
  CHAT_CONTEXT_WINDOW_MAX_TOKENS,
  CHAT_CONTEXT_WINDOW_MIN_TOKENS,
  CHAT_MAX_OUTPUT_TOKENS_MAX,
  CHAT_MAX_OUTPUT_TOKENS_MIN,
  DEFAULT_CHAT_CONTEXT_WINDOW_TOKENS,
  type CustomChatModel,
} from '@iart/contracts';
import { FieldLabelRow } from './InfoHint';

/**
 * 自建模型的「用户声明的能力」两个字段（spec 37「对话模型的唯一来源」）。
 *
 * 「添加模型」与「修改模型配置」各入口共用本文件：各处的字段、范围与说明必须逐字一致，
 * 各写一套会让同一个值在两个入口上被接受的范围不同。
 *
 * 只收能力，不收协议：用哪套接口由模型被接入的连接决定，用户在这里没有第二个地方可选。
 * 输入模态不在此列——自建模型按纯文本对话缺省（spec 37），模态不是用户可配置项。
 */

/** 上下文窗口字段的触发式说明（spec hub-information-architecture §7.8 的字段说明之一）。 */
export const CONTEXT_WINDOW_HINT = {
  text: '这个模型一次能读入多少内容（token）。照服务商文档里的数值填；填小了，早先的对话会被丢掉。',
  subject: '上下文窗口',
} as const;

/** 最大输出 token 字段的触发式说明（同 §7.8）。 */
export const MAX_OUTPUT_TOKENS_HINT = {
  text: '这个模型一次最多能生成多少内容。照服务商文档里的数值填；留空则由服务商决定；填小了，回复会被从中间截断。',
  subject: '最大输出 token',
} as const;

/**
 * 校验失败提示直接取契约常量拼出范围，不写死数字：改写范围时提示会跟着走。
 *
 * 不提「正整数」这种笼统说法——用户填了 500 却被告知「请填正整数」会以为自己没填错。
 */
export const CONTEXT_WINDOW_INVALID_TEXT =
  `填 ${CHAT_CONTEXT_WINDOW_MIN_TOKENS}–${CHAT_CONTEXT_WINDOW_MAX_TOKENS} 之间的整数`;

export const MAX_OUTPUT_TOKENS_INVALID_TEXT =
  `填 ${CHAT_MAX_OUTPUT_TOKENS_MIN}–${CHAT_MAX_OUTPUT_TOKENS_MAX} 之间的整数，或留空`;

/** 用户声明的能力，已转成可提交的形状；`maxOutputTokens` 为 null 表示不声明。 */
export type CustomModelCapabilityDraft = {
  contextWindowTokens: number;
  maxOutputTokens: number | null;
};

/** 两个字段的原始输入 + 校验结果；`draft` 为 null 表示还有字段没填对，不可提交。 */
export type CustomModelCapabilityState = {
  contextWindow: string;
  setContextWindow: (next: string) => void;
  maxOutputTokens: string;
  setMaxOutputTokens: (next: string) => void;
  contextWindowValid: boolean;
  maxOutputTokensValid: boolean;
  draft: CustomModelCapabilityDraft | null;
};

const parseInRange = (raw: string, min: number, max: number): number | null => {
  if (raw.trim() === '') return null;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
};

/**
 * 两个能力字段的输入状态与校验。
 *
 * `initial` 为 null 表示新建：上下文窗口预填缺省值（与执行链兜底共用 `DEFAULT_CHAT_CONTEXT_WINDOW_TOKENS`），
 * 最大输出 token 留空——它没有缺省值，「不声明」本身就是合法且默认的状态。
 */
export function useCustomModelCapability(
  initial: CustomChatModel | null,
): CustomModelCapabilityState {
  const [contextWindow, setContextWindow] = useState(
    String(initial?.context_window_tokens ?? DEFAULT_CHAT_CONTEXT_WINDOW_TOKENS),
  );
  const [maxOutputTokens, setMaxOutputTokens] = useState(
    initial?.max_output_tokens == null ? '' : String(initial.max_output_tokens),
  );

  const parsedContextWindow = parseInRange(
    contextWindow,
    CHAT_CONTEXT_WINDOW_MIN_TOKENS,
    CHAT_CONTEXT_WINDOW_MAX_TOKENS,
  );
  const parsedMaxOutput = parseInRange(maxOutputTokens, CHAT_MAX_OUTPUT_TOKENS_MIN, CHAT_MAX_OUTPUT_TOKENS_MAX);
  const maxOutputValid = maxOutputTokens.trim() === '' || parsedMaxOutput !== null;

  return {
    contextWindow,
    setContextWindow,
    maxOutputTokens,
    setMaxOutputTokens,
    contextWindowValid: parsedContextWindow !== null,
    maxOutputTokensValid: maxOutputValid,
    draft:
      parsedContextWindow !== null && maxOutputValid
        ? { contextWindowTokens: parsedContextWindow, maxOutputTokens: parsedMaxOutput }
        : null,
  };
}

/** 两个能力字段的输入区。`idPrefix` 给 label 与 input 配对用，两个入口各自的 id 不撞。 */
export function CustomModelCapabilityFields({
  idPrefix,
  capability,
  onEnter,
}: {
  idPrefix: string;
  capability: CustomModelCapabilityState;
  /** 在任一字段里按回车的动作，由调用方决定（两个入口都是提交）。 */
  onEnter: () => void;
}) {
  const contextWindowId = `${idPrefix}-context-window`;
  const maxOutputId = `${idPrefix}-max-output-tokens`;

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') onEnter();
  };

  return (
    <>
      <div className="flex flex-col gap-2">
        <FieldLabelRow htmlFor={contextWindowId} label="上下文窗口" hint={CONTEXT_WINDOW_HINT} />
        <Input
          id={contextWindowId}
          value={capability.contextWindow}
          inputMode="numeric"
          autoComplete="off"
          onChange={(event) => capability.setContextWindow(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        {capability.contextWindow.trim() !== '' && !capability.contextWindowValid ? (
          <p className="text-2xs text-destructive">{CONTEXT_WINDOW_INVALID_TEXT}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <FieldLabelRow htmlFor={maxOutputId} label="最大输出 token" hint={MAX_OUTPUT_TOKENS_HINT} />
        <Input
          id={maxOutputId}
          value={capability.maxOutputTokens}
          placeholder="留空由服务商决定"
          inputMode="numeric"
          autoComplete="off"
          onChange={(event) => capability.setMaxOutputTokens(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        {!capability.maxOutputTokensValid ? (
          <p className="text-2xs text-destructive">{MAX_OUTPUT_TOKENS_INVALID_TEXT}</p>
        ) : null}
      </div>
    </>
  );
}
