import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/utils/hubFetch', () => ({
  fetchBlobWithHub: vi.fn(async () => {
    const blob = new Blob(['image-data'], { type: 'image/png' });
    return { blob, mimeType: 'image/png' };
  }),
}));

import { extractUrlsFromUpload } from '@/features/models/shared/formTransforms';

describe('formTransforms (public_relay 直接传递 data URL)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('public_relay 模式下 extractUrls 直接传递 data URL，不再生成 token', async () => {
    const urls = await extractUrlsFromUpload([{ id: 'd1', src: 'data:image/png;base64,aGVsbG8=' }], {
      uploadMode: 'public_relay',
      fieldPath: 'body.images',
    });

    expect(urls).toHaveLength(1);
    const firstUrl = urls[0];
    expect(firstUrl).toBeDefined();
    if (!firstUrl) return;
    // 直接返回 data URL，不再生成 __iart_input_upload__ token
    expect(firstUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('公网 URL 输入在没有 relay 配置时直接透传且不触发上传副作用', async () => {
    const urls = await extractUrlsFromUpload(
      [{ id: 'd1', src: 'https://assets.example/ref.png' }],
      undefined,
    );

    expect(urls).toEqual(['https://assets.example/ref.png']);
  });

  it('本地或 data URL 作为公网 URL 目标时 fail fast', async () => {
    await expect(
      extractUrlsFromUpload([{ id: 'd1', src: 'data:image/png;base64,aGVsbG8=' }], undefined),
    ).rejects.toThrow('这个模型只能读网络上的素材');
  });

  it('public_relay 下 local-media 会读取为文件并转为 data URL', async () => {
    const urls = await extractUrlsFromUpload([{ id: 'lm1', src: 'local-media://demo.png' }], {
      uploadMode: 'public_relay',
      fieldPath: 'body.image',
    });

    expect(urls).toHaveLength(1);
    const url = urls[0];
    expect(url).toMatch(/^data:image\/png;base64,/);
  });
});
