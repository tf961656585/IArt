import { describe, expect, it } from 'vitest';

import { AGENT_WS_ERROR_CODES } from '@iart/contracts';
import {
  AgentSubmitFailure,
  resolveAgentFailureText,
  resolveAgentSubmitFailureText,
} from '../agentErrorText';

/**
 * 失败文案映射（docs/ui-copy-standard.md「落地口径」第 4 条；docs/agent/06「文案原则」）。
 *
 * 保护：每个错误码都有用户文案，且不出现实现术语与后端原文；未收口的异常回落通用出口文案。
 */

/** 用户可见文案禁用词（docs/ui-copy-standard.md 禁用词表）。 */
const FORBIDDEN_WORDS = [
  '底座',
  '锚点',
  '投影',
  '准入',
  'provider',
  'llm',
  'thinking',
  'session',
  'deployment',
  'Hub',
];

describe('Agent 失败文案映射', () => {
  it('契约的每个执行失败码都有用户文案', () => {
    for (const code of AGENT_WS_ERROR_CODES) {
      const text = resolveAgentFailureText(code);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toBe('undefined');
    }
  });

  it('受理前失败码（项目不可用 / 重复提交 / 连接不可用）有独立文案', () => {
    expect(resolveAgentFailureText('project_unavailable')).toBe('项目还没打开，重新打开项目后再发送。');
    expect(resolveAgentFailureText('duplicate_submit')).toBe('上一条还在回复，等它结束再发送。');
    expect(resolveAgentFailureText('connection_unavailable')).toBe(
      '连不上，这一次回复没有完成，请重试。',
    );
  });

  it('用户文案里不出现禁用词', () => {
    for (const code of [
      ...AGENT_WS_ERROR_CODES,
      'project_unavailable',
      'duplicate_submit',
      'connection_unavailable',
    ] as const) {
      const text = resolveAgentFailureText(code);
      for (const word of FORBIDDEN_WORDS) {
        expect(text.toLowerCase()).not.toContain(word.toLowerCase());
      }
    }
  });

  it('无错误码（未收口的异常）回落通用出口文案', () => {
    expect(resolveAgentFailureText(null)).toBe('这条消息没能发出，请重试。');
    expect(resolveAgentFailureText(undefined)).toBe('这条消息没能发出，请重试。');
  });

  it('提交失败按码取文案；异常原文（message）不参与取文案', () => {
    const failure = new AgentSubmitFailure(
      'model_unavailable',
      'req-1',
      'chat model has no usable active deployment: llm-fast-1',
    );

    expect(resolveAgentSubmitFailureText(failure)).toBe(
      '这个模型现在用不了，请到主窗口检查它的配置。',
    );
    expect(resolveAgentSubmitFailureText(failure)).not.toContain('llm-fast-1');
    // 原文保留在 message 上，只作日志材料
    expect(failure.message).toContain('llm-fast-1');
    // 非本层收口的异常（例如未知异常）只给通用出口文案，不泄漏 message
    expect(resolveAgentSubmitFailureText(new Error('backend raw text'))).toBe(
      '这条消息没能发出，请重试。',
    );
    expect(resolveAgentSubmitFailureText('A request is already in flight')).toBe(
      '这条消息没能发出，请重试。',
    );
  });
});
