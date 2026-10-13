import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { toast } from 'sonner';

import { useAgentSessionStore } from '@/features/agent/agentSessionStore';
import { useAgentSessionErrorToast } from '../useAgentSessionErrorToast';

/**
 * 一轮回复失败的一次性出口提示（会话视图未打开时也要提示到用户）。
 *
 * 保护：会话错误出现时按错误码给一条 toast（不印后端原文）；同一条错误不重复提示；
 * 新错误再提示；错误被清掉（下一轮受理）后不残留提示。
 */

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

const setError = (
  agentSessionId: string,
  error: { code: 'execution_failed' | 'connection_unavailable'; message: string; requestId: string } | null,
) => {
  useAgentSessionStore.getState().setSessionError(agentSessionId, error);
};

beforeEach(() => {
  cleanup();
  vi.mocked(toast.error).mockClear();
  useAgentSessionStore.setState({ errorsBySessionId: {} });
});

describe('一轮回复失败的出口提示', () => {
  it('出现会话错误时提示一次，文案按错误码映射（不印后端原文）', () => {
    renderHook(() => useAgentSessionErrorToast());

    act(() => {
      setError('sess-1', {
        code: 'execution_failed',
        message: 'stream broke: ECONNRESET',
        requestId: 'req-1',
      });
    });

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith('这一轮回复中断了，可以再发一次。', {
      id: 'req-1',
    });
  });

  it('同一条错误重复写入不重复提示；下一轮的新错误再提示', () => {
    renderHook(() => useAgentSessionErrorToast());

    act(() => {
      setError('sess-1', {
        code: 'connection_unavailable',
        message: '连接中断了，这一轮回复没有完成。',
        requestId: 'req-1',
      });
    });
    expect(toast.error).toHaveBeenCalledTimes(1);

    // 错误被下一轮受理清掉：不提示
    act(() => {
      setError('sess-1', null);
    });
    expect(toast.error).toHaveBeenCalledTimes(1);

    // 新一轮失败：再提示一条
    act(() => {
      setError('sess-1', {
        code: 'execution_failed',
        message: 'stream broke again',
        requestId: 'req-2',
      });
    });
    expect(toast.error).toHaveBeenCalledTimes(2);
    expect(toast.error).toHaveBeenLastCalledWith('这一轮回复中断了，可以再发一次。', {
      id: 'req-2',
    });
  });

  it('卸载后不再提示（订阅随容器释放）', () => {
    const { unmount } = renderHook(() => useAgentSessionErrorToast());
    unmount();

    act(() => {
      setError('sess-1', {
        code: 'execution_failed',
        message: 'stream broke',
        requestId: 'req-3',
      });
    });

    expect(toast.error).not.toHaveBeenCalled();
  });
});
