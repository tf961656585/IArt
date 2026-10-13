import type { DynamicPayload } from '../clientTypes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// normalizeTaskSubmitRequestBody 是唯一导出的入口，通过它验证内部逻辑
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

describe('normalizeTaskSubmitArgsFromRecord (via normalizeTaskSubmitRequestBody)', () => {
  let normalizeTaskSubmitRequestBody: NormalizeFn;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../taskFacade');
    normalizeTaskSubmitRequestBody = mod.normalizeTaskSubmitRequestBody as NormalizeFn;
  });

  it('连线 /files/ 路径 src → 提取为 media_input source_kind: url', async () => {
    const result = await normalizeTaskSubmitRequestBody({
      image: { file: undefined, src: '/files/test.png' },
    });

    // 非 data URL 的非空 src 统一提取为 media_input (source_kind: url)
    expect(result.media_inputs).toBeDefined();
    if (result.media_inputs !== undefined) {
      expect(result.media_inputs.length).toBe(1);
      const first = result.media_inputs[0];
      if (first !== undefined) {
        expect(first.source_kind).toBe('url');
        expect(first.value).toBe('/files/test.png');
      }
    }
    expect('image' in result.arguments).toBe(false);
  });

  it('连线 /files/ 路径数组 → 全部提取为 media_inputs', async () => {
    const result = await normalizeTaskSubmitRequestBody({
      images: [
        { file: undefined, src: '/files/a.png' },
        { file: undefined, src: '/files/b.png' },
      ],
    });

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
  });

  it('普通字符串值不受影响', async () => {
    const result = await normalizeTaskSubmitRequestBody({
      prompt: 'a beautiful landscape',
      seed: 42,
    });

    expect(result.arguments['prompt']).toBe('a beautiful landscape');
    expect(result.arguments['seed']).toBe(42);
    expect(result.media_inputs).toBeUndefined();
  });

  it('data URL 传入：解码为 media_inputs', async () => {
    const result = await normalizeTaskSubmitRequestBody({
      image: { file: undefined, src: 'data:image/png;base64,abc123' },
    });

    // image 应从 args 中删除（成功提取为媒体）
    expect('image' in result.arguments).toBe(false);
    // media_inputs 应有 1 项 base64 媒体
    expect(result.media_inputs).toBeDefined();
    if (result.media_inputs !== undefined) {
      expect(result.media_inputs.length).toBe(1);
      const first = result.media_inputs[0];
      if (first !== undefined) {
        expect(first.value).toBe('abc123');
        expect(first.mime_type).toBe('image/png');
      }
    }
  });

  it('混合数组：data URL 和 /files/ 路径均提取为 media_inputs', async () => {
    const result = await normalizeTaskSubmitRequestBody({
      items: [
        { file: undefined, src: 'data:image/png;base64,ZGF0YQ==' },
        { file: undefined, src: '/files/b.png' },
      ],
    });

    // 两项都应提取为 media_inputs（data URL → base64, /files/ → url）
    expect(result.media_inputs).toBeDefined();
    if (result.media_inputs !== undefined) {
      expect(result.media_inputs.length).toBe(2);
      const first = result.media_inputs[0];
      if (first !== undefined) {
        expect(first.source_kind).toBe('base64');
        expect(first.value).toBe('ZGF0YQ==');
      }
      const second = result.media_inputs[1];
      if (second !== undefined) {
        expect(second.source_kind).toBe('url');
        expect(second.value).toBe('/files/b.png');
      }
    }
    // 两项都提取后，args 中不应有 items
    expect('items' in result.arguments).toBe(false);
  });

  it('空对象：args 为空，media_inputs 为 undefined', async () => {
    const result = await normalizeTaskSubmitRequestBody({});

    expect(result.arguments).toEqual({});
    expect(result.media_inputs).toBeUndefined();
  });

  it('src 为空的残缺对象：从 args 中删除', async () => {
    const result = await normalizeTaskSubmitRequestBody({
      image: { file: undefined, src: '' },
    });

    // image key 应被删除
    expect('image' in result.arguments).toBe(false);
    expect(result.media_inputs).toBeUndefined();
  });

  describe('buildTaskSubmitMediaInputFromUploadItem - local path and URL src', () => {
    it('本地 /files/ 路径 src → media_inputs 包含 source_kind: url', async () => {
      const result = await normalizeTaskSubmitRequestBody({
        image: { file: undefined, src: '/files/test-image.png' },
      });

      expect(result.media_inputs).toBeDefined();
      if (result.media_inputs !== undefined) {
        expect(result.media_inputs.length).toBe(1);
        const first = result.media_inputs[0];
        if (first !== undefined) {
          expect(first.source_kind).toBe('url');
          expect(first.value).toBe('/files/test-image.png');
          expect(first.media_kind).toBe('image');
        }
      }
      expect('image' in result.arguments).toBe(false);
    });

    it('local-media:// 路径 → media_inputs 包含 source_kind: url', async () => {
      const result = await normalizeTaskSubmitRequestBody({
        image: { file: undefined, src: 'local-media://project/audio/sample.mp3' },
      });

      expect(result.media_inputs).toBeDefined();
      if (result.media_inputs !== undefined) {
        expect(result.media_inputs.length).toBe(1);
        const first = result.media_inputs[0];
        if (first !== undefined) {
          expect(first.source_kind).toBe('url');
          expect(first.value).toBe('local-media://project/audio/sample.mp3');
          expect(first.media_kind).toBe('audio');
        }
      }
    });

    it('https:// 远端 URL → media_inputs 包含 source_kind: url', async () => {
      const result = await normalizeTaskSubmitRequestBody({
        image: { file: undefined, src: 'https://cdn.example.com/photo.jpg' },
      });

      expect(result.media_inputs).toBeDefined();
      if (result.media_inputs !== undefined) {
        expect(result.media_inputs.length).toBe(1);
        const first = result.media_inputs[0];
        if (first !== undefined) {
          expect(first.source_kind).toBe('url');
          expect(first.value).toBe('https://cdn.example.com/photo.jpg');
        }
      }
    });

    it('http:// 远端 URL → media_inputs 包含 source_kind: url', async () => {
      const result = await normalizeTaskSubmitRequestBody({
        image: { file: undefined, src: 'http://example.com/image.png' },
      });

      expect(result.media_inputs).toBeDefined();
      if (result.media_inputs !== undefined) {
        expect(result.media_inputs.length).toBe(1);
        const first = result.media_inputs[0];
        if (first !== undefined) {
          expect(first.source_kind).toBe('url');
          expect(first.value).toBe('http://example.com/image.png');
        }
      }
    });

    it('URL 带 query 参数 → 正确保留完整 URL', async () => {
      const url = 'https://cdn.example.com/photo.jpg?width=800&quality=90&token=abc123';
      const result = await normalizeTaskSubmitRequestBody({
        image: { file: undefined, src: url },
      });

      expect(result.media_inputs).toBeDefined();
      if (result.media_inputs !== undefined) {
        expect(result.media_inputs.length).toBe(1);
        const first = result.media_inputs[0];
        if (first !== undefined) {
          expect(first.source_kind).toBe('url');
          expect(first.value).toBe(url);
        }
      }
    });
  });

  describe('normalizeTaskSubmitArgsFromRecord - downgrade prevention', () => {
    it('UploadFileItem(file=null, src="/files/x.png") → 不降级到 arguments', async () => {
      const result = await normalizeTaskSubmitRequestBody({
        image: { file: null, src: '/files/x.png' },
      });

      // 有有效 src 时应提取为 media_input 而非降级到 arguments
      expect(result.media_inputs).toBeDefined();
      if (result.media_inputs !== undefined) {
        expect(result.media_inputs.length).toBe(1);
        const first = result.media_inputs[0];
        if (first !== undefined) {
          expect(first.source_kind).toBe('url');
          expect(first.value).toBe('/files/x.png');
        }
      }
      expect('image' in result.arguments).toBe(false);
    });

    it('UploadFileItem(file=null, src="https://...") → 不降级到 arguments', async () => {
      const result = await normalizeTaskSubmitRequestBody({
        image: { file: null, src: 'https://example.com/img.png' },
      });

      expect(result.media_inputs).toBeDefined();
      if (result.media_inputs !== undefined) {
        expect(result.media_inputs.length).toBe(1);
        const first = result.media_inputs[0];
        if (first !== undefined) {
          expect(first.source_kind).toBe('url');
          expect(first.value).toBe('https://example.com/img.png');
        }
      }
      expect('image' in result.arguments).toBe(false);
    });

    it('UploadFileItem(file=null, src="") → 不出现在 arguments 或 media_inputs', async () => {
      const result = await normalizeTaskSubmitRequestBody({
        image: { file: null, src: '' },
      });

      expect(result.media_inputs).toBeUndefined();
      expect('image' in result.arguments).toBe(false);
    });

    it('UploadFileItem(file=null, src=null) → 不出现在 arguments 或 media_inputs', async () => {
      const result = await normalizeTaskSubmitRequestBody({
        image: { file: null, src: null },
      });

      expect(result.media_inputs).toBeUndefined();
      expect('image' in result.arguments).toBe(false);
    });
  });

  describe('normalizeTaskSubmitArgsFromRecord - mixed array', () => {
    it('[UploadFileItem(url), UploadFileItem(data_url)] → media_inputs 含两项', async () => {
      const result = await normalizeTaskSubmitRequestBody({
        items: [
          { file: undefined, src: 'https://example.com/a.png' },
          { file: undefined, src: 'data:image/png;base64,QUJDREVGR0g=' },
        ],
      });

      expect(result.media_inputs).toBeDefined();
      if (result.media_inputs !== undefined) {
        expect(result.media_inputs.length).toBe(2);
        const first = result.media_inputs[0];
        if (first !== undefined) {
          expect(first.source_kind).toBe('url');
          expect(first.value).toBe('https://example.com/a.png');
        }
        const second = result.media_inputs[1];
        if (second !== undefined) {
          expect(second.source_kind).toBe('base64');
        }
      }
    });

    it('[UploadFileItem(local_path), "plain string"] → media_inputs 1 项 + args 1 项', async () => {
      const result = await normalizeTaskSubmitRequestBody({
        items: [
          { file: undefined, src: '/files/local-image.png' },
          'plain string value',
        ],
      });

      expect(result.media_inputs).toBeDefined();
      if (result.media_inputs !== undefined) {
        expect(result.media_inputs.length).toBe(1);
        const first = result.media_inputs[0];
        if (first !== undefined) {
          expect(first.source_kind).toBe('url');
          expect(first.value).toBe('/files/local-image.png');
        }
      }
      // plain string 应保留在 args
      const items = result.arguments['items'];
      expect(items).toBe('plain string value');
    });
  });

  describe('normalizeTaskSubmitRequestBody - nested FormData body (SchemaGenerationPayload)', () => {
    it('payload.body 为 FormData 含 JSON UploadFileItem → media_inputs 包含图像', async () => {
      const formData = new FormData();
      formData.append('image', JSON.stringify({ file: null, src: 'data:image/png;base64,abc123' }));
      formData.append('prompt', '换成火山');

      const payload = {
        input: '换成火山',
        prompt: '换成火山',
        body: formData,
        api: { endpoint: '/v1/images/edits', method: 'POST' },
        meta: { size: 'auto' },
      };

      const result = await normalizeTaskSubmitRequestBody(payload);

      expect(result.media_inputs).toBeDefined();
      if (result.media_inputs !== undefined) {
        expect(result.media_inputs.length).toBe(1);
        const first = result.media_inputs[0];
        if (first !== undefined) {
          expect(first.source_kind).toBe('base64');
          expect(first.media_kind).toBe('image');
        }
      }
    });

    it('payload.body 为 FormData → arguments 不含 body/api/meta', async () => {
      const formData = new FormData();
      formData.append('image', JSON.stringify({ file: null, src: 'data:image/png;base64,abc123' }));
      formData.append('prompt', '换成火山');

      const payload = {
        input: '换成火山',
        prompt: '换成火山',
        body: formData,
        api: { endpoint: '/v1/images/edits', method: 'POST' },
        meta: { size: 'auto' },
      };

      const result = await normalizeTaskSubmitRequestBody(payload);

      expect('body' in result.arguments).toBe(false);
      expect('api' in result.arguments).toBe(false);
      expect('meta' in result.arguments).toBe(false);
    });

    it('payload.body 为 FormData → arguments 包含 prompt（从 payload 顶层收集）', async () => {
      const formData = new FormData();
      formData.append('image', JSON.stringify({ file: null, src: 'data:image/png;base64,abc123' }));

      const payload = {
        input: '换成火山',
        prompt: '换成火山',
        body: formData,
        api: { endpoint: '/v1/images/edits' },
        meta: { size: 'auto' },
      };

      const result = await normalizeTaskSubmitRequestBody(payload);

      expect(result.arguments['prompt']).toBe('换成火山');
    });

    it('payload.body 为 FormData → arguments 包含 input（保留，可能是有效 field_key）', async () => {
      const formData = new FormData();
      formData.append('image', JSON.stringify({ file: null, src: 'data:image/png;base64,abc123' }));

      const payload = {
        input: '换成火山',
        prompt: '换成火山',
        body: formData,
        api: { endpoint: '/v1/images/edits' },
        meta: { size: 'auto' },
      };

      const result = await normalizeTaskSubmitRequestBody(payload);

      expect(result.arguments['input']).toBe('换成火山');
    });

    it('payload.body 为 FormData 含多个 JSON UploadFileItem → media_inputs 包含多项', async () => {
      const formData = new FormData();
      formData.append('image1', JSON.stringify({ file: null, src: 'data:image/png;base64,AAAA' }));
      formData.append('image2', JSON.stringify({ file: null, src: 'data:image/jpeg;base64,BBBB' }));
      formData.append('prompt', '两张图');

      const payload = {
        prompt: '两张图',
        body: formData,
        api: { endpoint: '/v1/images/edits' },
        meta: {},
      };

      const result = await normalizeTaskSubmitRequestBody(payload);

      expect(result.media_inputs).toBeDefined();
      if (result.media_inputs !== undefined) {
        expect(result.media_inputs.length).toBe(2);
      }
    });

    it('payload.body 为空 FormData → media_inputs 为 undefined', async () => {
      const formData = new FormData();
      formData.append('prompt', '没有图');

      const payload = {
        prompt: '没有图',
        body: formData,
        api: { endpoint: '/v1/images/edits' },
        meta: {},
      };

      const result = await normalizeTaskSubmitRequestBody(payload);

      expect(result.media_inputs).toBeUndefined();
      expect(result.arguments['prompt']).toBe('没有图');
    });

    it('payload 无 body 字段 → 走路径 3（normalizeTaskSubmitArgsFromRecord）', async () => {
      const result = await normalizeTaskSubmitRequestBody({
        prompt: '普通文本',
        seed: 42,
      });

      expect(result.arguments['prompt']).toBe('普通文本');
      expect(result.arguments['seed']).toBe(42);
      expect(result.media_inputs).toBeUndefined();
    });

    it('payload.body 为普通对象 → 走路径 3（normalizeTaskSubmitArgsFromRecord）', async () => {
      const result = await normalizeTaskSubmitRequestBody({
        prompt: '普通文本',
        body: { key: 'value' },
        api: { endpoint: '/v1/chat/completions' },
        meta: {},
      });

      expect('body' in result.arguments).toBe(false);
      expect('api' in result.arguments).toBe(false);
      expect('meta' in result.arguments).toBe(false);
      expect(result.arguments['prompt']).toBe('普通文本');
    });
  });

  describe('normalizeTaskSubmitRequestBody - path 3 structural field stripping (JSON payload)', () => {
    it('{ prompt, body: {}, api: {}, meta: {} } → arguments 不含 body/api/meta', async () => {
      const result = await normalizeTaskSubmitRequestBody({
        prompt: 'text',
        body: { nested: true },
        api: { endpoint: '/v1/chat/completions' },
        meta: { size: 'auto' },
      });

      expect('body' in result.arguments).toBe(false);
      expect('api' in result.arguments).toBe(false);
      expect('meta' in result.arguments).toBe(false);
    });

    it('{ prompt, body: {}, api: {}, meta: {} } → arguments 含 prompt', async () => {
      const result = await normalizeTaskSubmitRequestBody({
        prompt: 'text',
        body: { nested: true },
        api: { endpoint: '/v1/chat/completions' },
        meta: { size: 'auto' },
      });

      expect(result.arguments['prompt']).toBe('text');
    });

    it('{ prompt, size, quality } → arguments 含模型参数字段', async () => {
      const result = await normalizeTaskSubmitRequestBody({
        prompt: 'text',
        size: '1024x1024',
        quality: 'high',
        moderation: 'low',
      });

      expect(result.arguments['prompt']).toBe('text');
      expect(result.arguments['size']).toBe('1024x1024');
      expect(result.arguments['quality']).toBe('high');
      expect(result.arguments['moderation']).toBe('low');
    });
  });
});
