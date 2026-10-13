/* @vitest-environment node */

import { describe, expect, it } from 'vitest';
import { createOpenAIClient, resolveOpenAICompatibleBaseURL } from '../src/sdk-clients';

type CapturedRequest = {
  url: string;
  method: string;
};

const normalizeCapturedUrl = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
};

const createCapturingFetch = (
  requests: CapturedRequest[],
): ((input: RequestInfo | URL, init: RequestInit | undefined) => Promise<Response>) => {
  return async (input: RequestInfo | URL, init: RequestInit | undefined): Promise<Response> => {
    requests.push({
      url: normalizeCapturedUrl(input),
      method: init !== undefined && typeof init.method === 'string' ? init.method : 'GET',
    });
    throw new Error('stop-after-capture');
  };
};

describe('resolveOpenAICompatibleBaseURL', () => {
  it('returns undefined for undefined and blank input', () => {
    expect(resolveOpenAICompatibleBaseURL(undefined)).toBeUndefined();
    expect(resolveOpenAICompatibleBaseURL('')).toBeUndefined();
    expect(resolveOpenAICompatibleBaseURL('   ')).toBeUndefined();
  });

  it('appends /v1 for bare origin input', () => {
    expect(resolveOpenAICompatibleBaseURL('https://gateway.example.com')).toBe('https://gateway.example.com/v1');
    expect(resolveOpenAICompatibleBaseURL('https://gateway.example.com/')).toBe('https://gateway.example.com/v1');
  });

  it('keeps existing pathful api roots unchanged', () => {
    expect(resolveOpenAICompatibleBaseURL('https://gateway.example.com/v1')).toBe('https://gateway.example.com/v1');
    expect(resolveOpenAICompatibleBaseURL('https://proxy.example.com/openai/v1')).toBe(
      'https://proxy.example.com/openai/v1',
    );
  });

  it('preserves trimmed custom strings that are not valid URLs', () => {
    expect(resolveOpenAICompatibleBaseURL('  not-a-valid-url  ')).toBe('not-a-valid-url');
  });
});

describe('createOpenAIClient', () => {
  it('uses /v1/responses for bare origin baseUrl', async () => {
    const requests: CapturedRequest[] = [];
    const client = createOpenAIClient(
      { apiKey: 'test-key', baseUrl: 'https://gateway.example.com' },
      { fetch: createCapturingFetch(requests) },
    );

    await expect(
      client.responses.create({
        model: 'gpt-4.1-mini',
        input: 'hello',
      }),
    ).rejects.toThrow();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      url: 'https://gateway.example.com/v1/responses',
      method: 'POST',
    });
  });

  it('uses /v1/chat/completions for bare origin baseUrl', async () => {
    const requests: CapturedRequest[] = [];
    const client = createOpenAIClient(
      { apiKey: 'test-key', baseUrl: 'https://gateway.example.com' },
      { fetch: createCapturingFetch(requests) },
    );

    await expect(
      client.chat.completions.create({
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).rejects.toThrow();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      url: 'https://gateway.example.com/v1/chat/completions',
      method: 'POST',
    });
  });
});
