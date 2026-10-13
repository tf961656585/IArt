import { expandPromptPresetTokens } from '@/features/canvas/nodes/textInput/enhancedTextNode';
import type { PromptDockDraft } from './PromptDock.types';

/**
 * PromptDock 提交体的 prompt 文本（spec docs/editor/prompt内联交互.md「提交契约边界」）。
 *
 * 预设 token 在 Editor 提交前展开为预设正文，后端不认识 token 形态。快照缺失的 token
 * 属于失效引用，已由前置校验（promptDockPreflight「失效预设 token」）阻断提交；这里
 * throw 只作程序性兜底——不静默把 token 字面量发给后端。
 */
export const resolvePromptDockSubmitPrompt = (draft: PromptDockDraft): string =>
  expandPromptPresetTokens({
    text: draft.prompt,
    promptPresetSnapshots: draft.promptPresetSnapshots ?? null,
    missing: 'throw',
  });
