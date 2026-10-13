import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const postFormMock = vi.fn();

vi.mock('@/client/utils/hubFetch', () => ({
  isHubRuntime: vi.fn(() => false),
}));

vi.mock('@/client/api/uploadHttpExecutor', () => ({
  getUploadHttpExecutor: () => ({
    postForm: postFormMock,
  }),
}));

describe('upload api (非 Hub 模式)', () => {
  beforeEach(() => {
    vi.resetModules();
    postFormMock.mockReset();
    postFormMock.mockResolvedValue({
      success: true,
      url: 'http://127.0.0.1:4100/files/uploaded.png',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('项目上传与公开上传会显式透传 mode + targetType 到 backend /api/upload', async () => {
    const { uploadImageFile, uploadImageToPublic } = await import('@/client/api/upload');

    await uploadImageFile(new File(['a'], 'input.png', { type: 'image/png' }));
    await uploadImageToPublic(new Blob(['b'], { type: 'image/png' }), 'public.png');

    expect(postFormMock).toHaveBeenCalledTimes(2);
    expect(postFormMock).toHaveBeenNthCalledWith(
      1,
      '/api/upload',
      expect.any(FormData),
      expect.objectContaining({
        includeAuth: false,
        resolveEndpoint: true,
      }),
    );
    expect(postFormMock).toHaveBeenNthCalledWith(
      2,
      '/api/upload',
      expect.any(FormData),
      expect.objectContaining({
        includeAuth: false,
        resolveEndpoint: true,
      }),
    );

    const publicRelayForm = postFormMock.mock.calls[1]?.[1] as FormData;
    expect(publicRelayForm.get('mode')).toBe('public_relay');
    expect(publicRelayForm.get('targetType')).toBe('self_hosted_image_public_url');
  });
});
