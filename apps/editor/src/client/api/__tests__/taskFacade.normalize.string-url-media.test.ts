import type { DynamicPayload } from '../clientTypes';
import { describe, expect, it } from 'vitest';

interface NormalizeResult {
  arguments: DynamicPayload;
  media_inputs: Array<{
    media_kind: string;
    source_kind: string;
    value: string;
    mime_type: string | null;
    filename: string | null;
  }> | undefined;
}

type NormalizeWithSchemaFn = (
  payload: unknown,
  parameterSchema: unknown | undefined,
) => Promise<NormalizeResult>;

const loadNormalizeFn = async (): Promise<NormalizeWithSchemaFn> => {
  const mod = await import('../taskFacade');
  // normalizeTaskSubmitRequestBody 已导出，直接调用
  const fn = mod.normalizeTaskSubmitRequestBody;
  return (payload, parameterSchema) => fn(payload, parameterSchema);
};

const IMAGE_UPLOAD_PARAMETER_SCHEMA = {
  fields: [
    { field_key: 'images', component: 'imageUpload' },
    { field_key: 'image', component: 'imageUpload' },
    { field_key: 'reference_image', component: 'imageUpload' },
  ],
};

describe('normalizeTaskSubmitRequestBody - string URL media via parameterSchema', () => {
  it('媒体字段值为纯字符串 URL → 被提取到 media_inputs', async () => {
    const normalize = await loadNormalizeFn();
    const result = await normalize(
      { images: '/files/test.png' },
      IMAGE_UPLOAD_PARAMETER_SCHEMA,
    );

    expect(result.media_inputs).toBeDefined();
    if (result.media_inputs !== undefined) {
      expect(result.media_inputs.length).toBe(1);
      const first = result.media_inputs[0];
      if (first !== undefined) {
        expect(first.source_kind).toBe('url');
        expect(first.value).toBe('/files/test.png');
        expect(first.media_kind).toBe('image');
      }
    }
    expect('images' in result.arguments).toBe(false);
  });

  it('媒体字段值为字符串数组 → 全部被提取到 media_inputs', async () => {
    const normalize = await loadNormalizeFn();
    const result = await normalize(
      { images: ['/files/a.png', '/files/b.png'] },
      IMAGE_UPLOAD_PARAMETER_SCHEMA,
    );

    expect(result.media_inputs).toBeDefined();
    if (result.media_inputs !== undefined) {
      expect(result.media_inputs.length).toBe(2);
      const first = result.media_inputs[0];
      if (first !== undefined) {
        expect(first.source_kind).toBe('url');
        expect(first.value).toBe('/files/a.png');
      }
      const second = result.media_inputs[1];
      if (second !== undefined) {
        expect(second.source_kind).toBe('url');
        expect(second.value).toBe('/files/b.png');
      }
    }
    expect('images' in result.arguments).toBe(false);
  });

  it('非媒体字段的字符串 URL → 不被误提取', async () => {
    const normalize = await loadNormalizeFn();
    const result = await normalize(
      { prompt: 'https://example.com/some-image.png' },
      IMAGE_UPLOAD_PARAMETER_SCHEMA,
    );

    expect(result.media_inputs).toBeUndefined();
    expect(result.arguments['prompt']).toBe('https://example.com/some-image.png');
  });

  it('不传 parameterSchema 时纯字符串 URL 不被提取（向后兼容）', async () => {
    const normalize = await loadNormalizeFn();
    const result = await normalize(
      { images: '/files/test.png' },
      undefined,
    );

    expect(result.media_inputs).toBeUndefined();
    expect(result.arguments['images']).toBe('/files/test.png');
  });

  it('payload.body 中媒体字段值为纯字符串 URL → 被提取到 media_inputs', async () => {
    const normalize = await loadNormalizeFn();
    const result = await normalize(
      { body: { image: '/files/body-test.png', prompt: 'test' } },
      IMAGE_UPLOAD_PARAMETER_SCHEMA,
    );

    expect(result.media_inputs).toBeDefined();
    if (result.media_inputs !== undefined) {
      expect(result.media_inputs.length).toBe(1);
      const first = result.media_inputs[0];
      if (first !== undefined) {
        expect(first.source_kind).toBe('url');
        expect(first.value).toBe('/files/body-test.png');
      }
    }
    expect(result.arguments['prompt']).toBe('test');
    expect('image' in result.arguments).toBe(false);
  });
});
