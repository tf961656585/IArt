import type { DynamicPayload } from '../clientTypes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const transportMock = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock('../transport', () => ({
  request: transportMock.request,
}));

vi.mock('@/client/api/transport', () => ({
  request: transportMock.request,
}));

interface MediaInput {
  media_kind: string;
  source_kind: string;
  value: string;
  mime_type: string | undefined;
  filename: string | undefined;
}

type NormalizeFn = (payload: unknown) => Promise<{ arguments: DynamicPayload; media_inputs: MediaInput[] | undefined }>;

describe('normalizeTaskSubmitArgsFromFormData (via normalizeTaskSubmitRequestBody)', () => {
  let normalizeTaskSubmitRequestBody: NormalizeFn;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../taskFacade');
    normalizeTaskSubmitRequestBody = mod.normalizeTaskSubmitRequestBody as NormalizeFn;
  });

  it('纯字符串 FormData → 全部进入 args', async () => {
    const formData = new FormData();
    formData.append('prompt', 'a beautiful landscape');
    formData.append('seed', '42');

    const result = await normalizeTaskSubmitRequestBody(formData);

    expect(result.arguments['prompt']).toBe('a beautiful landscape');
    expect(result.arguments['seed']).toBe('42');
    expect(result.media_inputs).toBeUndefined();
  });

  it('JSON 字符串化的 UploadFileItem (data URL) → 正确提取为 media_input', async () => {
    const formData = new FormData();
    formData.append('image', JSON.stringify({ file: null, src: 'data:image/png;base64,QUJDREVGR0g=' }));

    const result = await normalizeTaskSubmitRequestBody(formData);

    expect(result.media_inputs).toBeDefined();
    if (result.media_inputs !== undefined) {
      expect(result.media_inputs.length).toBe(1);
      const first = result.media_inputs[0];
      if (first !== undefined) {
        expect(first.source_kind).toBe('base64');
        expect(first.value).toBe('QUJDREVGR0g=');
        expect(first.mime_type).toBe('image/png');
      }
    }
    // image 不应出现在 args 中
    expect('image' in result.arguments).toBe(false);
  });

  it('JSON 字符串化的 UploadFileItem (url) → 正确提取为 media_input source_kind: url', async () => {
    const formData = new FormData();
    formData.append('image', JSON.stringify({ file: null, src: 'https://cdn.example.com/photo.jpg' }));

    const result = await normalizeTaskSubmitRequestBody(formData);

    expect(result.media_inputs).toBeDefined();
    if (result.media_inputs !== undefined) {
      expect(result.media_inputs.length).toBe(1);
      const first = result.media_inputs[0];
      if (first !== undefined) {
        expect(first.source_kind).toBe('url');
        expect(first.value).toBe('https://cdn.example.com/photo.jpg');
      }
    }
    expect('image' in result.arguments).toBe(false);
  });

  it('混合字符串和 JSON UploadFileItem → 正确分离到 args 和 media_inputs', async () => {
    const formData = new FormData();
    formData.append('prompt', 'mixed test');
    formData.append('image1', JSON.stringify({ file: null, src: 'data:image/jpeg;base64,/9j/4AAQ' }));
    formData.append('image2', JSON.stringify({ file: null, src: '/files/local-image.png' }));
    formData.append('count', '2');

    const result = await normalizeTaskSubmitRequestBody(formData);

    expect(result.arguments['prompt']).toBe('mixed test');
    expect(result.arguments['count']).toBe('2');
    expect(result.media_inputs).toBeDefined();
    if (result.media_inputs !== undefined) {
      expect(result.media_inputs.length).toBe(2);
      const first = result.media_inputs[0];
      if (first !== undefined) {
        expect(first.source_kind).toBe('base64');
        expect(first.mime_type).toBe('image/jpeg');
      }
      const second = result.media_inputs[1];
      if (second !== undefined) {
        expect(second.source_kind).toBe('url');
        expect(second.value).toBe('/files/local-image.png');
      }
    }
  });

  it('非 JSON 字符串 → 保留在 args 中', async () => {
    const formData = new FormData();
    formData.append('prompt', 'hello world');
    formData.append('url', 'https://example.com/image.png');

    const result = await normalizeTaskSubmitRequestBody(formData);

    expect(result.arguments['prompt']).toBe('hello world');
    expect(result.arguments['url']).toBe('https://example.com/image.png');
    expect(result.media_inputs).toBeUndefined();
  });
});
