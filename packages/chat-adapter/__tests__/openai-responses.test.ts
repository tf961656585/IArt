/* @vitest-environment node */

import { describe, expect, it } from 'vitest';
import { consumeOpenAIResponsesStream } from '../src/openai-responses';

type Usage = {
  inputTokens: number;
  outputTokens: number;
};

async function* streamEvents(events: unknown[]): AsyncIterable<unknown> {
  for (const event of events) {
    yield event;
  }
}

describe('consumeOpenAIResponsesStream', () => {
  it('does not require response.completed output_text after text events', async () => {
    const tokens: string[] = [];
    let usage: Usage | null = null;

    await consumeOpenAIResponsesStream(
      streamEvents([
        { type: 'response.output_text.delta', delta: '你' },
        { type: 'response.output_text.done', text: '你好' },
        {
          type: 'response.completed',
          response: {
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: '你好' }],
              },
            ],
            usage: { input_tokens: 3, output_tokens: 2 },
          },
        },
      ]),
      {
        onToken: (text) => {
          tokens.push(text);
        },
        onUsage: (nextUsage) => {
          usage = nextUsage;
        },
      },
    );

    expect(tokens).toEqual(['你', '好']);
    expect(usage).toEqual({ inputTokens: 3, outputTokens: 2 });
  });

  it('emits completed output text from output content when no deltas were emitted', async () => {
    const tokens: string[] = [];

    await consumeOpenAIResponsesStream(
      streamEvents([
        {
          type: 'response.completed',
          response: {
            output: [
              {
                type: 'message',
                content: [
                  { type: 'output_text', text: 'hello' },
                  { type: 'output_text', text: ' world' },
                ],
              },
            ],
            usage: null,
          },
        },
      ]),
      {
        onToken: (text) => {
          tokens.push(text);
        },
        onUsage: undefined,
      },
    );

    expect(tokens).toEqual(['hello world']);
  });

  it('ignores malformed text fields without throwing', async () => {
    const tokens: string[] = [];

    await consumeOpenAIResponsesStream(
      streamEvents([
        { type: 'response.output_text.delta' },
        { type: 'response.output_text.done', text: 7 },
        {
          type: 'response.completed',
          response: {
            usage: { input_tokens: '3', output_tokens: null },
          },
        },
      ]),
      {
        onToken: (text) => {
          tokens.push(text);
        },
        onUsage: undefined,
      },
    );

    expect(tokens).toEqual([]);
  });
});
