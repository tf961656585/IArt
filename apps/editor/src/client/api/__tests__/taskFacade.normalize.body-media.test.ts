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

describe('normalizeTaskSubmitRequestBody - path 3 body contains media data', () => {
  let normalizeTaskSubmitRequestBody: NormalizeFn;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../taskFacade');
    normalizeTaskSubmitRequestBody = mod.normalizeTaskSubmitRequestBody as NormalizeFn;
  });

  it('payload.body 含 UploadFileItem 数组 → media_inputs 提取图像', async () => {
    const result = await normalizeTaskSubmitRequestBody({
      body: {
        prompt: '换成火山',
        images: [{ file: undefined, src: '/files/test.png' }],
      },
      prompt: '换成火山',
      input: '换成火山',
    });

    expect(result.media_inputs).toBeDefined();
    if (result.media_inputs !== undefined) {
      expect(result.media_inputs.length).toBe(1);
      const first = result.media_inputs[0];
      if (first !== undefined) {
        expect(first.source_kind).toBe('url');
        expect(first.value).toBe('/files/test.png');
      }
    }
    expect(result.arguments['prompt']).toBe('换成火山');
    expect(result.arguments['input']).toBe('换成火山');
    expect('images' in result.arguments).toBe(false);
  });

  it('payload.body 含 data URL 字符串 → media_inputs 提取 base64', async () => {
    const result = await normalizeTaskSubmitRequestBody({
      body: {
        model: 'gpt-image-2',
        prompt: 'test',
        image: [{ file: undefined, src: 'data:image/png;base64,abc123==' }],
      },
    });

    expect(result.media_inputs).toBeDefined();
    if (result.media_inputs !== undefined) {
      expect(result.media_inputs.length).toBe(1);
      const first = result.media_inputs[0];
      if (first !== undefined) {
        expect(first.source_kind).toBe('base64');
      }
    }
    expect(result.arguments['model']).toBe('gpt-image-2');
    expect(result.arguments['prompt']).toBe('test');
  });

  it('payload.body 混合普通字段和媒体字段 → arguments 含非媒体字段，media_inputs 含图像', async () => {
    const result = await normalizeTaskSubmitRequestBody({
      body: {
        model: 'gpt-image-2',
        prompt: 'test',
        size: '1024x1024',
        images: [{ file: undefined, src: 'local-media://project/image/test.png' }],
      },
      api: { method: 'POST' },
      meta: null,
      prompt: 'test',
      input: 'test',
    });

    expect('body' in result.arguments).toBe(false);
    expect('api' in result.arguments).toBe(false);
    expect('meta' in result.arguments).toBe(false);
    expect(result.arguments['model']).toBe('gpt-image-2');
    expect(result.arguments['prompt']).toBe('test');
    expect(result.arguments['size']).toBe('1024x1024');
    expect(result.arguments['input']).toBe('test');
    expect(result.media_inputs).toBeDefined();
    if (result.media_inputs !== undefined) {
      expect(result.media_inputs.length).toBe(1);
      const first = result.media_inputs[0];
      if (first !== undefined) {
        expect(first.source_kind).toBe('url');
        expect(first.value).toBe('local-media://project/image/test.png');
      }
    }
  });

  it('顶层字段覆盖 body 同名字段', async () => {
    const result = await normalizeTaskSubmitRequestBody({
      body: { prompt: 'body prompt' },
      prompt: 'top prompt',
      input: 'top input',
    });

    expect(result.arguments['prompt']).toBe('top prompt');
    expect(result.arguments['input']).toBe('top input');
  });

  it('payload.body 为空对象 → 只有顶层标量字段', async () => {
    const result = await normalizeTaskSubmitRequestBody({
      body: {},
      prompt: 'test',
      input: 'test',
    });

    expect(result.arguments['prompt']).toBe('test');
    expect(result.arguments['input']).toBe('test');
    expect(result.media_inputs).toBeUndefined();
  });

  it('payload 无 body 字段 → 行为与修改前一致', async () => {
    const result = await normalizeTaskSubmitRequestBody({
      prompt: 'test',
      input: 'test',
    });

    expect(result.arguments['prompt']).toBe('test');
    expect(result.arguments['input']).toBe('test');
    expect(result.media_inputs).toBeUndefined();
  });

  it('payload.body 含 Blob → media_inputs 提取 blob media input', async () => {
    const blobLike = {
      type: 'image/png',
      arrayBuffer: async () => new TextEncoder().encode('fake image data').buffer,
    };
    const result = await normalizeTaskSubmitRequestBody({
      body: { image: blobLike },
    });

    expect(result.media_inputs).toBeDefined();
    if (result.media_inputs !== undefined) {
      expect(result.media_inputs.length).toBe(1);
      const first = result.media_inputs[0];
      if (first !== undefined) {
        expect(first.media_kind).toBe('image');
      }
    }
    expect('image' in result.arguments).toBe(false);
  });

  it('payload.body 含非标量嵌套对象 → 保留在 arguments', async () => {
    const result = await normalizeTaskSubmitRequestBody({
      body: {
        prompt: 'test',
        config: { nested: true },
      },
    });

    expect(result.arguments['prompt']).toBe('test');
    expect(result.arguments['config']).toEqual({ nested: true });
    expect(result.media_inputs).toBeUndefined();
  });
});
