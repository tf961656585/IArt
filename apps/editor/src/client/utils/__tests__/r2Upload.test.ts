import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/api/upload', () => ({
  uploadToR2: vi.fn(),
}));

import { uploadToR2 as uploadToPublicR2 } from '@/client/api/upload';
import { uploadToR2 } from '@/client/utils/r2Upload';

const createFile = (name: string, content = 'hello', type = 'text/plain'): File => {
  return new File([content], name, { type });
};

describe('client/utils/uploadToR2', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('成功上传并返回 url', async () => {
    const file = createFile('test.txt');
    const mocked = vi.mocked(uploadToPublicR2);
    mocked.mockResolvedValueOnce('https://example.com/file.txt');

    const result = await uploadToR2(file);

    expect(result.success).toBe(true);
    expect(result.url).toBe('https://example.com/file.txt');
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked).toHaveBeenCalledWith(file, 'test.txt');
  });

  it('上传函数抛出 Error 时透传 message', async () => {
    const mocked = vi.mocked(uploadToPublicR2);
    mocked.mockRejectedValueOnce(new Error('network error'));

    const file = createFile('test.txt');
    const result = await uploadToR2(file);

    expect(result.success).toBe(false);
    expect(result.error).toBe('network error');
  });

  it('上传函数抛出非 Error 时返回通用网络错误提示', async () => {
    const mocked = vi.mocked(uploadToPublicR2);
    mocked.mockRejectedValueOnce('network failure');

    const file = createFile('test.txt');
    const result = await uploadToR2(file);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/网络错误，连接不上上传服务，请重试。/);
  });

  it('上传函数返回空 url 时返回缺少链接错误', async () => {
    const mocked = vi.mocked(uploadToPublicR2);
    mocked.mockResolvedValueOnce('');

    const file = createFile('test.txt');
    const result = await uploadToR2(file);

    expect(result.success).toBe(false);
    expect(result.error).toBe('文件没能上传成功，请重试。');
  });

  it('上传函数抛出后端错误信息时透传', async () => {
    const mocked = vi.mocked(uploadToPublicR2);
    mocked.mockRejectedValueOnce(new Error('后端上传失败'));

    const file = createFile('test.txt');
    const result = await uploadToR2(file);

    expect(result.success).toBe(false);
    expect(result.error).toBe('后端上传失败');
  });
});
