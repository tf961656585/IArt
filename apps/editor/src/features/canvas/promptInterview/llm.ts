import type { ChatCompletionMessage } from '@/client/api/chatCompletions';
import { createChatCompletionWithModel } from '@/client/api/chatCompletions';
import type { PromptInterviewMediaType, PromptInterviewSpecV1 } from '@/features/canvas/types/node';
import type { PromptInterviewQuestion } from './types';
import { compilePrompt } from './compiler';

export const PROMPT_INTERVIEW_SYSTEM_PROMPT = `
You are a prompt crafting assistant for image/video generation.

Rules:
- Output must be a single English paragraph.
- Be concrete and visually verifiable.
- Avoid generic quality-word stacking (e.g. "best quality", "masterpiece", "8k") unless explicitly requested.
- No explanations, no markdown, no headings.
`.trim();

export const PROMPT_INTERVIEW_OPTION_SYSTEM_PROMPT = `
You generate short option suggestions for answering a prompt interview question.

Rules:
- Output exactly 3 options.
- Each option must be a short English phrase (<= 12 words).
- Output as 3 lines, no numbering, no extra text.
`.trim();

function normalizeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*\d.\s]+/, '').trim())
    .filter(Boolean);
}

export async function generateOptionSuggestions(params: {
  model: string;
  mediaType: PromptInterviewMediaType;
  question: PromptInterviewQuestion;
  spec: PromptInterviewSpecV1;
}): Promise<string[]> {
  const contextPrompt = compilePrompt({ mediaType: params.mediaType, spec: params.spec });

  const messages: ChatCompletionMessage[] = [
    { role: 'system', content: PROMPT_INTERVIEW_OPTION_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: `Question: ${params.question.title}\n` },
        { type: 'text', text: `Current draft prompt context:\n${contextPrompt}\n` },
      ],
    },
  ];

  const result = await createChatCompletionWithModel({
    model: params.model,
    messages,
    temperature: 0.7,
  });

  const lines = normalizeLines(result.content);
  return lines.slice(0, 3);
}

export async function refinePromptFromSpec(params: {
  model: string;
  mediaType: PromptInterviewMediaType;
  spec: PromptInterviewSpecV1;
}): Promise<string> {
  const draft = compilePrompt({ mediaType: params.mediaType, spec: params.spec });
  const messages: ChatCompletionMessage[] = [
    { role: 'system', content: PROMPT_INTERVIEW_SYSTEM_PROMPT },
    { role: 'user', content: `Rewrite and improve this prompt while keeping intent: ${draft}` },
  ];

  const result = await createChatCompletionWithModel({
    model: params.model,
    messages,
    temperature: 0.4,
  });

  return result.content.trim();
}

export async function iteratePrompt(params: {
  model: string;
  prompt: string;
  instruction: string;
}): Promise<string> {
  const messages: ChatCompletionMessage[] = [
    { role: 'system', content: PROMPT_INTERVIEW_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Current prompt:\n${params.prompt}\n\nUser instruction (apply changes):\n${params.instruction}\n\nOutput only the updated prompt.`,
    },
  ];

  const result = await createChatCompletionWithModel({
    model: params.model,
    messages,
    temperature: 0.5,
  });

  return result.content.trim();
}
