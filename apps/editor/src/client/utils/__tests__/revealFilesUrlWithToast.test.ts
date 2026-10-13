// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  return {
    toast: {
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    },
    revealFilesUrl: vi.fn(),
  };
});

vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('../electronBridge', () => ({ revealFilesUrl: mocks.revealFilesUrl }));

import { revealFilesUrlWithToast } from '../revealFilesUrlWithToast';

describe('revealFilesUrlWithToast', () => {
  beforeEach(() => {
    mocks.toast.success.mockReset();
    mocks.toast.warning.mockReset();
    mocks.toast.error.mockReset();
    mocks.revealFilesUrl.mockReset();
  });

  it('shows success toast when ok', async () => {
    mocks.revealFilesUrl.mockResolvedValue({ ok: true });
    const result = await revealFilesUrlWithToast('/files/a.png');
    expect(result.ok).toBe(true);
    expect(mocks.toast.success).toHaveBeenCalledWith('已打开文件所在位置');
  });

  it('shows warning toast for not-files-url', async () => {
    mocks.revealFilesUrl.mockResolvedValue({ ok: false, reason: 'not-files-url' });
    const result = await revealFilesUrlWithToast('https://example.com/a.png');
    expect(result).toEqual({ ok: false, reason: 'not-files-url' });
    expect(mocks.toast.warning).toHaveBeenCalledWith('这个地址无法识别。');
  });

  it('shows error toast for not-found', async () => {
    mocks.revealFilesUrl.mockResolvedValue({ ok: false, reason: 'not-found' });
    const result = await revealFilesUrlWithToast('/files/missing.png');
    expect(result).toEqual({ ok: false, reason: 'not-found' });
    expect(mocks.toast.error).toHaveBeenCalledWith('没有找到这个文件（已打开媒体目录）');
  });
});
