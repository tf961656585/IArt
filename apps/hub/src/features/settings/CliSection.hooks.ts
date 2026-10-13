import { useCallback, useEffect, useRef, useState } from 'react';
import type { CliCommandLogEntry, CliStatusDto } from '@iart/contracts';
import { useHubRuntime } from '../../components/providers/HubAppProvider';

/**
 * 设置页「命令行工具」子单元操作 hook（spec docs/integrations/CLI与本地Agent集成.md §8）：
 * 挂载时经 `cli:get-status` 只读读取一次状态；注册/卸除动作幂等（CLI-016），
 * 成功后重读状态让注册状态行即时更新；失败在子单元内显示（Hub 无 toast）。
 * 后端返回的 message 面向用户（CliEntryOperationResult 契约口径），失败时直接展示；
 * IPC 异常原文只进日志，界面给兜底文案。
 */

/** 命令入口动作进行中标记（同一时刻至多一个动作在途） */
export type CliEntryAction = 'register' | 'unregister';

const REGISTER_FALLBACK_MESSAGE = '没能注册 iart 命令，请重试';
const UNREGISTER_FALLBACK_MESSAGE = '没能卸除注册，请重试';

export function useCliSection() {
  const { platform } = useHubRuntime();

  const [status, setStatus] = useState<CliStatusDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState<CliEntryAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const mountedRef = useRef(true);

  /** 重读状态（挂载时 + 注册/卸除成功后） */
  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const dto = await platform.getCliStatus();
      if (!mountedRef.current) return;
      if (dto === null) {
        setLoadFailed(true);
      } else {
        setStatus(dto);
        setLoadFailed(false);
      }
    } catch (error: unknown) {
      console.debug('[cli] getCliStatus 失败:', error);
      if (mountedRef.current) setLoadFailed(true);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [platform]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  /** 命令入口注册/卸除（幂等）：成功后重读状态，失败展示 message 或兜底文案 */
  const runEntryAction = useCallback(
    async (action: CliEntryAction): Promise<void> => {
      if (pending !== null) return;
      setPending(action);
      setNotice(null);
      try {
        const result =
          action === 'register' ? await platform.registerCliEntry() : await platform.unregisterCliEntry();
        if (!mountedRef.current) return;
        if (result.ok) {
          await refresh();
        } else {
          setNotice(result.message ?? (action === 'register' ? REGISTER_FALLBACK_MESSAGE : UNREGISTER_FALLBACK_MESSAGE));
        }
      } catch (error: unknown) {
        console.debug('[cli] 入口操作失败:', error);
        if (mountedRef.current) {
          setNotice(action === 'register' ? REGISTER_FALLBACK_MESSAGE : UNREGISTER_FALLBACK_MESSAGE);
        }
      } finally {
        if (mountedRef.current) setPending(null);
      }
    },
    [pending, platform, refresh],
  );

  return {
    status,
    loading,
    loadFailed,
    pending,
    notice,
    refresh,
    register: useCallback(() => runEntryAction('register'), [runEntryAction]),
    unregister: useCallback(() => runEntryAction('unregister'), [runEntryAction]),
  };
}

/** 耗时展示：满 1 秒以秒计（一位小数），不足 1 秒以毫秒计 */
export const formatCommandDuration = (durationMs: number): string =>
  durationMs >= 1000 ? (durationMs / 1000).toFixed(1) + ' 秒' : Math.round(durationMs) + ' ms';

/** 日志条目状态的用户可见词 */
export const commandStatusText = (entry: Pick<CliCommandLogEntry, 'status'>): string =>
  entry.status === 'success' ? '成功' : '失败';
