import { describe, expect, it } from 'vitest';
import {
  buildTextInputAiEditSystemPrompt,
  TEXT_INPUT_AI_EDIT_SYSTEM_PROMPT,
  TEXT_INPUT_AI_EDIT_TEMPLATE_NONE_ID,
} from '../textInputAiEditTemplates';

describe('textInputAiEditTemplates', () => {
  it('returns base prompt when no template selected', () => {
    expect(buildTextInputAiEditSystemPrompt()).toBe(TEXT_INPUT_AI_EDIT_SYSTEM_PROMPT);
    expect(
      buildTextInputAiEditSystemPrompt({ templateId: TEXT_INPUT_AI_EDIT_TEMPLATE_NONE_ID }),
    ).toBe(TEXT_INPUT_AI_EDIT_SYSTEM_PROMPT);
  });

  it('builds prompt with JSON template rules and content', () => {
    const prompt = buildTextInputAiEditSystemPrompt({ templateId: 'json' });
    expect(prompt).toContain(TEXT_INPUT_AI_EDIT_SYSTEM_PROMPT);
    expect(prompt).toContain('模板只提供表现形式和思路，不是填空题。');
    expect(prompt).toContain('"task": "generate_image"');
  });

  it('builds prompt with timeline template rules and content', () => {
    const prompt = buildTextInputAiEditSystemPrompt({ templateId: 'timeline' });
    expect(prompt).toContain(TEXT_INPUT_AI_EDIT_SYSTEM_PROMPT);
    expect(prompt).toContain('[TIMELINE / SHOTS]');
    expect(prompt).toContain('Style: 35mm cinematic, warm teal-orange grade, realistic.');
  });
});
