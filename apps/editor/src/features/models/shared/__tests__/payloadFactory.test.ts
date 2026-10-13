import { describe, it, expect } from 'vitest';
import { createJsonGenerationPayload } from '@/features/models/shared/payloadFactory';

describe('createJsonGenerationPayload', () => {
  it('保留显式为 null 的 contentType 并覆盖模型默认值', () => {
    const payload = createJsonGenerationPayload({
      endpoint: '/stub',
      body: undefined,
      prompt: undefined,
      input: undefined,
      meta: undefined,
      method: undefined,
      contentType: null,
      includePromptAsInput: undefined,
      apiOverrides: undefined,
    });

    expect(payload.api?.contentType).toBeNull();
    expect(payload.api).not.toHaveProperty('timeoutMs');
    expect(payload.api).not.toHaveProperty('retries');
    expect(payload.api).not.toHaveProperty('retryDelayMs');
  });
});
